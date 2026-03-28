# 固定レイアウト + Conductor 再利用 仕様

## 概要

ペインの動的生成をやめ、起動時に固定レイアウトを構築する。Conductor はタスクごとに新規起動せず `/clear` で再利用する。Agent は Conductor ペイン内にタブとして追加する。

## レイアウト

```
┌──────────┬──────────┬─────────────────────┐
│ Manager  │ Master   │                     │
│  (TUI)   │ (Claude) │   Conductor-2       │
├──────────┴──────────┤   + Agent タブ       │
│                     │                     │
│   Conductor-1       ├─────────────────────┤
│   + Agent タブ      │                     │
│                     │   Conductor-3       │
│                     │   + Agent タブ       │
└─────────────────────┴─────────────────────┘
```

- 左上: Manager + Master（水平分割、各半分）
- 左下: Conductor-1
- 右上: Conductor-2
- 右下: Conductor-3
- ペイン数は固定5枚（Manager, Master, C1, C2, C3）

## 起動シーケンス (`/start`)

1. workspace を作成
2. 2x2 グリッドを構築（左上を水平分割で Manager + Master）
3. 3つの Conductor ペインで Claude Code を `--dangerously-skip-permissions` で起動
4. Trust 承認（初回のみ）
5. 全 Conductor が `❯` に到達したら idle 状態として登録
6. team.json に全 surface/pane ID を記録

## Conductor の状態遷移

```
idle → assigned → running → done → idle
```

| 状態 | 説明 |
|------|------|
| idle | `❯` プロンプト表示。タスク待ち |
| assigned | タスクが割り当てられた。Agent タブ掃除 + `/clear` 実行中 |
| running | タスク実行中 |
| done | タスク完了。結果確認のためそのまま保持 |

### idle → assigned（タスク到着時）

1. done 状態の Conductor を優先して選択（ユーザーが結果を見終わった後の再利用）
2. done がなければ idle を選択
3. 全 Conductor が running なら throttle（現行と同じ）

### assigned → running（タスク投入）

1. Conductor ペイン内の Agent タブを全て `cmux close-surface` で閉じる
2. Conductor に `/clear` を `cmux send` で送信
3. `❯` プロンプトを検出（`cmux read-screen`）
4. worktree を作成（daemon が実行）
5. タスクプロンプトを `cmux send` で送信

### running → done（タスク完了）

1. `cmux read-screen` で `❯` + 非実行中を検出（現行の pull 型と同じ）
2. 結果収集（session ID, merge commit, journal summary）
3. タスクファイルを closed に移動
4. Conductor 状態を done に変更

## worktree のライフサイクル管理

| 操作 | 責務 | 理由 |
|------|------|------|
| **作成 (add)** | daemon | Conductor がプロンプトを受け取った時点で worktree が確実に存在する必要がある。パスの採番（conductor-id ベース）も daemon が一元管理する |
| **削除 (remove)** | Conductor | daemon は Conductor の作業完了タイミングを正確に知れない。誤った done 判定で作業中の worktree を消すリスクがある。Conductor はマージ完了後に自分で削除する |

この非対称性は意図的な設計判断である。作成側は事前準備として確実に制御できるが、削除側は Conductor の作業完了を待つ必要があるため、作業者自身が責任を持つ。
5. **Agent タブは閉じない**（ユーザーが結果を確認できるよう残す）

### done → idle（自動遷移はしない）

次のタスクが来るまで done のまま保持。新タスク到着時に assigned に遷移する際に Agent タブ掃除 + `/clear` が実行される。

## Agent の起動（タブとして追加）

現行の `cmux new-split` を `cmux new-surface --pane <conductor-pane>` に変更。

```bash
# 現行
cmux new-split down

# 新方式
cmux new-surface --pane <conductor-pane-id>
```

- Agent は Conductor と同じペイン内のタブとして作成される
- タブ名は現行どおり `[num] ⚙ タスク名` 等
- Agent の完了検出・kill も現行と同じ（surface ベース）

## spawn-agent CLI の変更

```bash
# 現行
bun run main.ts spawn-agent --conductor-id <id> --role impl --prompt "..."

# 新方式（--pane を追加）
bun run main.ts spawn-agent --conductor-id <id> --role impl --pane <pane-id> --prompt "..."
```

`--pane` が指定されていれば `new-surface --pane` を使い、未指定なら従来の `new-split`（後方互換）。

## team.json の変更

```json
{
  "slots": [
    {
      "id": "slot-1",
      "surface": "surface:250",
      "pane": "pane:200",
      "state": "running",
      "conductorId": "conductor-1774673536",
      "taskId": "033",
      "agents": [
        { "surface": "surface:251", "role": "impl" },
        { "surface": "surface:252", "role": "reviewer" }
      ]
    },
    {
      "id": "slot-2",
      "surface": "surface:260",
      "pane": "pane:201",
      "state": "idle",
      "conductorId": null,
      "taskId": null,
      "agents": []
    },
    {
      "id": "slot-3",
      "surface": "surface:270",
      "pane": "pane:202",
      "state": "done",
      "conductorId": "conductor-1774673400",
      "taskId": "032",
      "agents": [
        { "surface": "surface:271", "role": "impl" }
      ]
    }
  ]
}
```

## TUI ダッシュボードへの影響

- Conductors セクション: `state` フィールドで idle/running/done を色分け表示
- Agent 表示: 現行と同じ（Conductor 配下にツリー表示）

## /clear の送信方法

```bash
cmux send --surface <conductor-surface> "/clear\n"
# 0.5秒待機
cmux send-key --surface <conductor-surface> return
```

`/clear` はスラッシュコマンドなので改行で送信される想定だが、複数行プロンプトと同じ問題が起きる可能性があるため `send-key return` をフォールバックとして用意。

## 影響範囲

| ファイル | 変更内容 |
|---------|---------|
| `manager/main.ts` | `cmdStart` でグリッド構築 + Conductor 3つ起動 |
| `manager/daemon.ts` | slot ベースの状態管理、`scanTasks` で slot 割り当て |
| `manager/conductor.ts` | `spawnConductor` → `assignTask`（/clear + プロンプト送信） |
| `manager/main.ts` (spawn-agent) | `--pane` オプション追加、`new-surface --pane` 対応 |
| `manager/cmux.ts` | `newSurfaceInPane(paneId)` 関数追加 |
| `templates/conductor.md` | Agent 起動手順を `--pane` 付きに更新 |
| `templates/master.md` | 特に変更なし |

## 移行方針

- 大きな変更のため段階的に実装
- Phase 1: 固定レイアウト構築 + Conductor pre-spawn
- Phase 2: `/clear` 再利用 + slot 状態管理
- Phase 3: Agent タブ化（`new-surface --pane`）
