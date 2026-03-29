# 固定レイアウト + Conductor 再利用 仕様

## 概要

ペインの動的生成をやめ、起動時に固定レイアウトを構築する。Conductor はタスクごとに新規起動せず `/clear` で再利用する。Agent は Conductor ペイン内にタブとして追加する。

## ステータス

**実装完了。** 以下の仕様はすべて実装済み。

## レイアウト

```
┌──────────┬──────────┬─────────────────────┐
│ daemon   │ Master   │                     │
│  (TUI)   │ (Claude) │   Conductor-2       │
├──────────┴──────────┤   + Agent タブ       │
│                     │                     │
│   Conductor-1       ├─────────────────────┤
│   + Agent タブ      │                     │
│                     │   Conductor-3       │
│                     │   + Agent タブ       │
└─────────────────────┴─────────────────────┘
```

- 左上: daemon（TUI ダッシュボード）+ Master（Claude Code）— daemon surface を右に split して Master 作成
- 左下: Conductor-1 — daemon surface を下に split
- 右上: Conductor-2 — Conductor-1 を右に split（起動シーケンス §3 の結果）
- 右下: Conductor-3 — Conductor-2 を下に split
- ペイン数は固定4枚（5 surface: daemon, Master, C1, C2, C3）

### レイアウト構築の実装（`initializeConductorSlots`）

```typescript
// 1. daemon を右に split → Conductor-1
const surface1 = await cmux.newSplit("right", { surface: daemonSurface });

// 2. daemon を下に split → Conductor-2（daemon の下に配置）
const surface2 = await cmux.newSplit("down", { surface: daemonSurface });

// 3. Conductor-1 を下に split → Conductor-3
const surface3 = await cmux.newSplit("down", { surface: surface1 });
```

## 起動シーケンス (`/start` → `main.ts start`)

1. daemon プロセスが起動（bun で実行）
2. インフラ初期化（`.team/` ディレクトリ構造作成）
3. ロギングプロキシ起動（`proxy.ts`）
4. daemon surface を特定（`cmux identify`）
5. Conductor 3スロットを構築（`initializeConductorSlots`）:
   a. 上記のレイアウト構築で3つのペインを作成
   b. 各ペインで Claude Code を `--dangerously-skip-permissions --append-system-prompt-file conductor-role.md` で起動
   c. Trust 承認（`cmux.waitForTrust`）
   d. タブ名設定（`[num] ♦ idle`）
   e. paneId 取得（`cmux tree` からパース）
   f. ConductorState を `idle` で初期化
6. Master spawn（`startMaster`）:
   a. daemon surface を右に split → Master ペイン
   b. Claude Code を `--dangerously-skip-permissions --append-system-prompt-file master.md` で起動
   c. Trust 承認
   d. タブ名設定（`[num] Master`）
7. `team.json` に全 surface/paneId/status を記録（`updateTeamJson`）
8. TUI ダッシュボード表示（`startDashboard`）
9. メインループ開始（`tick` → `processQueue` + `scanTasks` + `monitorConductors`）

### daemon リロード時

`team.json` に既存 Conductor があり surface が生きている場合は、スロット構築をスキップし Conductor 状態を復元する（`cmdStart` の冒頭処理）。

## Conductor の状態遷移

```
idle → running → done → idle
```

| 状態 | 説明 |
|------|------|
| idle | `❯` プロンプト表示。タスク待ち。タブ名: `[num] ♦ idle` |
| running | タスク実行中。タブ名: `[num] ♦ #taskId title` |
| done | タスク完了。daemon の `handleConductorDone` が呼ばれるまで保持 |

**注意**: 仕様初版にあった `assigned` 状態は実装されていない。`assignTask()` は即座に `running` に遷移する。

### idle → running（タスク到着時 — `assignTask()`）

1. `task-state.json` で `ready` のタスクを検出（`scanTasks`）
2. idle Conductor を選択（`state.conductors.values()` から `status === "idle"` を検索）
3. タスクファイルを読み取りタイトルを抽出
4. git worktree 作成（`.worktrees/<taskRunId>/`）+ ブートストラップ（`npm install`）
5. Conductor プロンプト生成（`generateConductorTaskPrompt` で `conductor-task.md` テンプレートを展開）
6. Conductor surface に `/clear` → `send-key return` → 2秒待機 → タスクプロンプト送信 → `send-key return`
7. タブ名更新（`[num] ♦ #taskId shortTitle`）
8. ConductorState を `running` に更新

### running → done（タスク完了 — `monitorConductors` + `handleConductorDone`）

完了検出は2つの経路がある:

**経路 A: push 型（CONDUCTOR_DONE キューメッセージ）**
- Claude Code の Stop hook が CONDUCTOR_DONE メッセージをキューに送信
- `processQueue` が検出し即座に `handleConductorDone` を呼ぶ

**経路 B: pull 型（done マーカーファイル）**
- `checkConductorStatus` が `<outputDir>/done` ファイルの存在を確認
- `doneCandidate` フラグで2 tick 連続 done の場合のみ `handleConductorDone` を呼ぶ（誤判定防止）

### done → idle（リセット — `resetConductor`）

`handleConductorDone` が `collectResults` → `resetConductor` を順に実行:

1. journal サマリーを `task-state.json` から読み取り、ログに記録
2. Agent タブをすべて close（`paneId` があれば `listPaneSurfaces` で取得、なければ `agents` 配列から個別に close）
3. worktree を `git worktree remove --force` で削除 + ブランチ削除
4. タブ名を `[num] ♦ idle` にリセット
5. ConductorState を idle に戻す（taskId, worktreePath 等をクリア）

## worktree のライフサイクル管理

| 操作 | 責務 | 理由 |
|------|------|------|
| **作成 (add)** | daemon（`assignTask`） | Conductor がプロンプトを受け取った時点で worktree が確実に存在する必要がある。taskRunId ベースのパス採番も daemon が一元管理する |
| **削除 (remove)** | daemon（`resetConductor`） | Conductor 完了後に daemon がリセット処理の一環として削除する |

**注意**: Conductor テンプレート（`conductor-role.md`, `conductor.md`）にも worktree 削除の手順が記載されているが、実際には daemon の `resetConductor` が先に実行する。Conductor が自ら削除した場合も、daemon 側は `existsSync` で確認してから処理するため二重削除は安全。

## Agent の起動（タブとして追加）

`main.ts spawn-agent` CLI が Conductor ペイン内にタブを作成する:

```bash
bun run "$MAIN_TS" spawn-agent \
  --conductor-id $CONDUCTOR_ID \
  --role impl \
  --task-title "<サブタスクの簡潔な説明>" \
  --prompt-file "$PROMPT_FILE"
```

### spawn-agent CLI の処理フロー

1. プロキシポート読み取り（`.team/proxy-port`）+ 接続テスト
2. `team.json` から Conductor の `paneId` と `worktreePath` を取得
3. タブ作成:
   - `paneId` があれば `cmux new-surface --pane <paneId>`（ペイン内タブ）
   - なければ `cmux new-split down`（フォールバック）
4. 環境変数 export（`CONDUCTOR_ID`, `ROLE`, `PROJECT_ROOT`, `ANTHROPIC_BASE_URL`）+ Claude Code 起動
5. Trust 承認（`cmux.waitForTrust`）
6. タブ名設定（`[num] roleIcon title`）
7. AGENT_SPAWNED キューメッセージ送信
8. stdout に `SURFACE=surface:N` を出力

### Agent の完了検出・kill

- Conductor が `cmux list-status` で Idle を検出（pull 型、hooks ベース）
- `main.ts kill-agent --surface <s>` で surface クローズ + AGENT_DONE 送信

## team.json の Conductors 構造

```json
{
  "conductors": [
    {
      "id": "conductor-slot-1",
      "taskRunId": "run-1774673536",
      "taskId": "033",
      "taskTitle": "ログイン機能の実装",
      "surface": "surface:250",
      "status": "running",
      "worktreePath": "/path/.worktrees/run-1774673536",
      "outputDir": ".team/output/run-1774673536",
      "startedAt": "2026-03-29T00:00:00Z",
      "paneId": "pane:200",
      "agents": [
        { "surface": "surface:251", "role": "impl" },
        { "surface": "surface:252", "role": "reviewer" }
      ]
    },
    {
      "id": "conductor-slot-2",
      "surface": "surface:260",
      "status": "idle",
      "startedAt": "2026-03-29T00:00:00Z",
      "paneId": "pane:201",
      "agents": []
    },
    {
      "id": "conductor-slot-3",
      "taskRunId": "run-1774673400",
      "taskId": "032",
      "taskTitle": "テスト追加",
      "surface": "surface:270",
      "status": "running",
      "worktreePath": "/path/.worktrees/run-1774673400",
      "outputDir": ".team/output/run-1774673400",
      "startedAt": "2026-03-29T00:00:00Z",
      "paneId": "pane:202",
      "agents": [
        { "surface": "surface:271", "role": "impl" }
      ]
    }
  ]
}
```

## TUI ダッシュボードへの影響

- Header: `conductors N/M`（running/max）を表示
- Conductors セクション: `status` フィールドで idle(○)/running(●)/done(✓) をアイコン + 色分け表示。Agent はツリー形式で表示
- Tasks セクション: open タスクを優先表示、closed は直近のものを残りの枠で表示

## /clear の送信方法

```typescript
// assignTask() 内の実装
await cmux.send(conductor.surface, "/clear");
await sleep(500);
await cmux.sendKey(conductor.surface, "return");
await sleep(2000);
// 新プロンプト送信
await cmux.send(conductor.surface, `${promptFile} を読んで指示に従って作業してください。`);
await sleep(500);
await cmux.sendKey(conductor.surface, "return");
```

## 関連ファイル

| ファイル | 役割 |
|---------|------|
| `manager/main.ts` | CLI エントリポイント。`cmdStart` でレイアウト構築 + メインループ |
| `manager/daemon.ts` | daemon 状態管理。`initializeLayout`, `scanTasks`, `monitorConductors`, `updateTeamJson` |
| `manager/conductor.ts` | Conductor スロット初期化（`initializeConductorSlots`）、タスク割り当て（`assignTask`）、監視（`checkConductorStatus`）、結果回収（`collectResults`）、リセット（`resetConductor`） |
| `manager/master.ts` | Master spawn（`spawnMaster`）、生存確認（`isMasterAlive`） |
| `manager/cmux.ts` | cmux コマンドラッパー。`newSplit`, `newSurface`, `listPaneSurfaces`, `send`, `sendKey`, `readScreen`, `validateSurface`, `waitForTrust` |
| `manager/template.ts` | テンプレート検索（`findTemplateDir`）、Master/Conductor プロンプト生成 |
| `manager/dashboard.tsx` | ink/React TUI ダッシュボード |
| `manager/proxy.ts` | ロギングプロキシ + デバッグエンドポイント |
| `manager/schema.ts` | zod スキーマ（QueueMessage, ConductorState） |
| `manager/task.ts` | タスクパース・依存解決・task-state.json 管理 |
| `manager/queue.ts` | ファイルキュー（read/write/markProcessed） |
| `templates/conductor-role.md` | Conductor 永続ロール知識（`--append-system-prompt-file` で使用） |
| `templates/conductor-task.md` | タスク割り当て時のプロンプトテンプレート |
| `templates/conductor.md` | 旧 Conductor テンプレート（`conductor-role.md` の展開版、後方互換で残存） |
