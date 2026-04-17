# タスク割り当て

## タスク内容

---
id: 211
title: statusline を proxy HTTP API 化（POST /statusline）
priority: medium
created_at: 2026-04-15T16:12:36.637Z
depends_on: [210]
---

## 背景

現状の `skills/cmux-team/manager/statusline.sh` は ~140 行の bash スクリプトで、以下の問題を抱えている:

1. **`CMUX_ROLE` 環境変数を必要とする** — cmdConductor / cmdResume / cmdLaunchMaster / cmdSpawnAgent の 4 箇所で `process.env.CMUX_ROLE = ...` を設定（main.ts:1371, 1456, 1501, 1659）
2. **`CONDUCTOR_ID` 環境変数を参照する** — team.json からタスク情報を逆引きするキーとして使用（statusline.sh:92）
3. **jq 依存の生 shell で保守性が低い** — i18n 対応が困難、ANSI クォート処理が煩雑、ユニットテスト不可
4. **`~/.claude/statusline.sh` に postinstall でコピーしている**ためフォーマット変更が npm update でも即時反映されない可能性

一方、proxy は既に daemon state 全体にアクセスできる GET/POST エンドポイント群（`/state`, `/tasks`, `/conductors`, `/rate-limit`, `/master-state`, `/api/messages`）を提供しており、ここに `/statusline` を追加すれば:

- daemon state 内の `masterSurface` / `conductors[]` / `agents[]` を surface で逆引きし、master / conductor / agent を識別できる
- タスク情報（`taskId`, `taskTitle`, `role` 等）も state から直接取得できる
- team.json / task-state.json を jq で読み直す必要が無い
- 環境変数 `CMUX_SURFACE` だけあれば十分で、`CMUX_ROLE` / `CONDUCTOR_ID` は不要

## T210 との関係

本タスクは `depends_on: [210]` で T210 完了後に走る。

T210（CONDUCTOR_ID 廃止）が `.team/prompts/conductor-settings.json` の hook 引数・schema・`process.env.CONDUCTOR_ID` セットを全て片付けた状態からスタートする。T210 の作業範囲で statusline.sh:92 の `CONDUCTOR_ID` → `CMUX_SURFACE` 置換が発生しているはずだが、本タスクで statusline.sh を丸ごと curl wrapper に差し替えるので、その変更は上書きされる（小さな重複作業だが実害なし）。

**CMUX_ROLE env の削除は本タスク内で完結させる**（T210 は CONDUCTOR_ID のみを扱うスコープ）。statusline.sh を curl wrapper 化した時点で CMUX_ROLE の唯一の consumer が消えるため、同じ PR 内で env 設定を削除するのが一貫性がある。

## 合わせて解消する副次バグ

`.claude/settings.json:3-26` に UserPromptSubmit / Stop の 2 つの hook が登録されている:

```python
# 現状
if os.environ.get('CONDUCTOR_ID'):
    sys.exit(0)
# POST /master-state with status=busy (or idle)
```

**問題**:

1. `.claude/settings.json` は tracked file なので、**cwd に関係なく全 claude セッションが自動ロードする**（Claude Code の仕様 — User / Project / Local / `--settings` が全てマージされる）
2. worktree にも tracked file として `.claude/settings.json` がコピーされるため、Agent の claude プロセスでも自動ロードされる
3. Agent は `CONDUCTOR_ID` env を設定していない → Python の `os.environ.get('CONDUCTOR_ID')` が `None` → falsy → guard 通過
4. 結果として **Agent の UserPromptSubmit / Stop が Master state を汚染する**（`state.masterStatus` が busy/idle で振動し、`state.masterPrompt` に Agent の入力先頭 80 文字が漏れる）

**実害**:

- ダッシュボードの Master status 表示が Agent 活動で瞬く
- `state.masterPrompt` に Agent のプロンプトが混ざる（TUI で "Master がいま作業している内容" として表示される値が Agent 起源になる）
- データ破壊はないが、可観測性が壊れている

**なぜ顕在化しなかったか**:

- Master は多くの時間 idle なので Agent の idle push が "正しい値" に戻してしまい、ズレが自己修正される
- 状態表示の一瞬の振動は注視しないと気づかない

## 設計原則: hook の責務分離

`.claude/settings.json`（tracked, 全セッション自動ロード）と `--settings` 経由で渡すファイルの役割を明確にする:

| 置き場所 | 適切な内容 | 例 |
|---|---|---|
| `.claude/settings.json`（tracked） | **全ロール共通で守るべき contract** | `.team/tasks/` 直接書き込みブロック（Master/Conductor/Agent/cfork/素の claude すべてで有効にすべき） |
| `.team/prompts/<role>-settings.json`（`--settings` で渡す） | **特定ロール専用の振る舞い** | Master の busy/idle push、Conductor の SessionStart/Stop/SessionEnd push、Agent の SessionStart push |

原則:

- **全セッションに効かせたい hook** → `.claude/settings.json`
- **特定ロール専用の hook** → `--settings` で渡す生成ファイル

この分離により:

1. Python hook の env guard（`if os.environ.get('CONDUCTOR_ID'): sys.exit(0)`）が丸ごと削除できる
2. proxy 側の surface validation も不要（Master 以外から `/master-state` が叩かれることがそもそも無い）
3. cfork / 素の claude セッションで誤発火しない（`--settings master-settings.json` を渡していない限り Master push hook は存在しない）
4. コードの読み手にも責務が明確

## ゴール

- proxy に `POST /statusline` エンドポイントを追加
- statusline の描画ロジック（現在 shell の case 分岐 + jq）を TypeScript の純関数として実装
- `~/.claude/statusline.sh` を daemon へ POST する薄い curl wrapper（5 行程度）に差し替え
- `CMUX_ROLE` 環境変数を statusline 経路と main.ts から完全に削除
- `.claude/settings.json` から Master 専用 hook を master-settings.json に移設（責務分離）
- daemon 停止時は空出力にフォールバック（cmux-team 外のセッションでの動作を壊さない）

## 作業内容

### 1. proxy エンドポイント追加

`skills/cmux-team/manager/proxy.ts` に `POST /statusline` を追加:

- **Request**:
  - Header: `X-Cmux-Surface: <surface>` (必須、未設定なら 400)
  - Body: Claude Code が stdin に渡す JSON をそのままパススルー
    - `model.id`, `model.display_name`
    - `workspace.current_dir`
    - `exceeds_200k_tokens`
    - `cost.total_cost_usd`
    - `transcript_path`（将来の ctx % 計算用）
- **Response**: 200, `text/plain` — 1 行の statusline 文字列（ANSI カラー含む）。**末尾改行は含めない**
- **Error**:
  - surface が state のどれにもマッチしない → 200 で空文字を返す（cmux-team 外セッション相当）
  - body パース失敗 → 400
  - getState 未設定 → 503

### 2. TypeScript で statusline フォーマッタ実装

`skills/cmux-team/manager/statusline.ts`（新規）を作成し、以下の純関数を定義:

```ts
export interface StatuslineInput {
  surface: string;
  stdinPayload: ClaudeCodeStatuslinePayload;  // stdin JSON の型
}

export interface StatuslineContext {
  state: DaemonState;           // getState() の返り値
  i18n?: typeof i18n;           // i18n.ts の label を使う場合
}

export function formatStatusline(input: StatuslineInput, ctx: StatuslineContext): string;
```

- surface から role を判定するロジック:
  1. `state.masterSurface === surface` → `master`
  2. `state.conductors.get(surface)` が存在 → `conductor`（taskId / taskTitle を取得）
  3. `state.agents?.find(a => a.surface === surface)` が存在 → `agent`（role / taskId を取得）
  4. どれでもない → 空文字（cmux-team 外セッション扱い）

- master / conductor / agent 各ロールのフォーマット仕様は現行 `statusline.sh:71-131` の出力と**完全に一致**させる:
  - **master**: `♦ Master | M 4.6 | ctx N% | T:N |  <branch>`
  - **conductor (busy)**: `♦ TNNN <title> | <branch> | ctx N% |  M 4.5`
  - **conductor (idle)**: `♦ idle | ctx 0% |  M 4.5`（dim）
  - **agent**: `▸ <role_name> | T<taskId> | ctx N%`

- 既存の色関数（`ctx_color`, Nerd Font フォールバック等）も TS に移植する。`CMUX_NERD_FONT` / `CMUX_STATUSLINE_COLOR` 等の現行の挙動制御 env は body の query param もしくは request header で渡す（後方互換のため X-Cmux-Nerd-Font / X-Cmux-Statusline-Color ヘッダーに切り替え）

- 現行 statusline.sh には無いが、daemon state からしか取れない情報を活用する拡張（オプション）:
  - Conductor の `disconnected` / `crashed` 状態をアイコンで表示
  - Master の rate-limit 状態（throttled）を色で警告

### 3. wrapper スクリプトへの差し替え

`skills/cmux-team/manager/statusline.sh`（既存）を以下で上書き:

```sh
#!/bin/sh
# cmux-team statusline wrapper — proxy の /statusline エンドポイントに中継
# Claude Code から stdin に渡される JSON をそのまま daemon に POST し、
# 描画された 1 行を stdout に出す。
set -eu

PORT_FILE="${PROJECT_ROOT:-.}/.team/proxy-port"
[ -f "$PORT_FILE" ] || exit 0

PORT=$(cat "$PORT_FILE") || exit 0
[ -n "$PORT" ] || exit 0
[ -n "${CMUX_SURFACE:-}" ] || exit 0

exec curl -sf --max-time 2 -X POST \
  -H "Content-Type: application/json" \
  -H "X-Cmux-Surface: ${CMUX_SURFACE}" \
  --data-binary @- \
  "http://127.0.0.1:${PORT}/statusline" 2>/dev/null || true
```

- daemon 停止時 / proxy-port ファイル不在 → 空出力で exit 0（cmux-team 外セッションでの動作を壊さない）
- curl timeout 2 秒 — Claude Code の statusline timeout（300ms 推奨、3 秒上限）に収まる
- `set -eu` でエラー検出するが、最後の exec/curl は `|| true` でフォールバック

### 4. postinstall の更新

`bin/postinstall.js` を調査して `~/.claude/statusline.sh` コピー処理の整合性を確認。wrapper が薄くなるので、内容が変わったらユーザーの既存ファイルを上書きする必要がある（hash チェック or 強制上書き）。

### 5. Master 用 hook の `.claude/settings.json` → `master-settings.json` 移設

**責務分離の原則**に従って `.claude/settings.json` を整理する。

**削除する hook**（.claude/settings.json:3-26）:

- `UserPromptSubmit` — Master の busy 状態を daemon に push する Python hook
- `Stop` — Master の idle 状態を daemon に push する Python hook

**残す hook**（.claude/settings.json:27-38）:

- `PreToolUse` (matcher: `^(Write|Edit)# タスク割り当て

## タスク内容

) — `.team/tasks/` 直接書き込みブロック。**これは全ロール（Master/Conductor/Agent/cfork/素の claude）で守るべき contract** なので `.claude/settings.json` に置き続ける

**追加する hook**（`cmdLaunchMaster` が生成する `master-settings.json`）:

`main.ts:1493-1542` の `cmdLaunchMaster` は既に `master-settings.json` を生成して `--settings` で渡している（現状は statusline 設定だけ）。ここに上記の UserPromptSubmit / Stop hook を追加する:

```ts
const masterSettings: Record<string, any> = {
  hooks: {
    UserPromptSubmit: [{
      matcher: "",
      hooks: [{
        type: "command",
        command: "python3 -c '...busy push (guard なし)...'",
        timeout: 5000,
      }],
    }],
    Stop: [{
      matcher: "",
      hooks: [{
        type: "command",
        command: "python3 -c '...idle push (guard なし)...'",
        timeout: 5000,
      }],
    }],
  },
};
if (existsSync(statuslineScript)) {
  masterSettings.statusLine = { type: "command", command: statuslineScript };
}
```

**Python hook の簡素化**:

移設と同時に `if os.environ.get('CONDUCTOR_ID'): sys.exit(0)` の guard を削除する。Master 専用の settings にしか存在しないので、Master 以外で走る可能性がゼロになり guard が不要になる。

Python コードも見直し:

- 現状の長大な `exec("\\\"\\\"...")` 形式は読み書きが苦しいので、可能なら `python3 -c` の後ろを heredoc 生成もしくは別ファイルに切り出す
- proxy-port の読み取り失敗時は exit 0（cmux-team 外での動作を壊さない現行挙動を維持）

**proxy 側**:

- `POST /master-state` に surface ベースの validation を追加することも検討したが、Master push hook が `.claude/settings.json` に存在しなくなるので**不要**。belt-and-suspenders として軽い assert を入れるかは実装時判断
- 既存の `proxy.ts:201-219` は基本そのままで OK

### 6. CMUX_ROLE env の削除（T211 内で完結）

statusline.sh が curl wrapper に差し替わり、role 判定が daemon state 側で行われるようになった時点で、`CMUX_ROLE` 環境変数の consumer はゼロになる。同じ PR 内で `main.ts` から env 設定を削除する:

- `main.ts:1371` — `cmdConductor` 内の `process.env.CMUX_ROLE = "conductor"` を削除
- `main.ts:1456` — `cmdResume` 内の `process.env.CMUX_ROLE = "conductor"` を削除
- `main.ts:1501` — `cmdLaunchMaster` 内の `process.env.CMUX_ROLE = "master"` を削除
- `main.ts:1659` — `cmdSpawnAgent` 内の `` `CMUX_ROLE=agent` `` を削除

削除後、grep で `CMUX_ROLE` が完全に消えていることを確認する:

```bash
rg CMUX_ROLE skills/ bin/ .claude/ commands/ docs/
# → 0 件であること（test fixture / CHANGELOG 等の履歴記述は除く）
```

**`.claude/settings.json` / `.team/prompts/` 配下のランタイム生成物にも `CMUX_ROLE` が残っていないことを確認**。特に `conductor-settings.json` は T210 で一度更新されているはずなので、再生成の前後で残骸が無いかチェック。

### 7. テスト

- `statusline.test.ts`（新規）で純関数 `formatStatusline` をカバー:
  - master / conductor (busy/idle) / agent / unknown の全ケース
  - Nerd Font オン・オフ
  - Color オン・オフ
  - 長いタスク名の切り詰め（現行 20 文字）
  - conductor の idle / disconnected / crashed 表示（拡張する場合）
- `proxy.test.ts` に `/statusline` エンドポイントの e2e を追加:
  - 正常系（各ロール）
  - surface なし → 400
  - state 未設定 → 503
  - 不明 surface → 200 empty
- `main.test.ts` に `master-settings.json` 生成の regression を追加:
  - UserPromptSubmit / Stop hook が含まれることを assert
  - CONDUCTOR_ID guard が Python コードに含まれないことを assert
- `main.test.ts` の `cmdConductor` / `cmdResume` / `cmdLaunchMaster` / `cmdSpawnAgent` の既存テストから `CMUX_ROLE` env のセット検証があれば削除 or 「セットされないこと」に反転
- **Agent 汚染 regression テスト**:
  - Agent セッションをシミュレートし、`.claude/settings.json` だけをロードして UserPromptSubmit に類する動作を実行
  - `POST /master-state` が呼ばれないこと（hook が存在しない）を確認
  - `state.masterStatus` / `state.masterPrompt` が変化しないことを assert
- 手動テスト:
  ```bash
  # wrapper の動作確認
  echo '{"model":{"id":"claude-sonnet-4-6"},"workspace":{"current_dir":"'$(pwd)'"},"exceeds_200k_tokens":false}' \
    | CMUX_SURFACE=surface:123 PROJECT_ROOT=$(pwd) \
    bash skills/cmux-team/manager/statusline.sh

  # /hooks コマンドで各ロールの hook ロード状況を確認
  # - Master: UserPromptSubmit (busy) + Stop (idle) + PreToolUse (.team/tasks/ guard) + statusline
  # - Conductor: PreToolUse (Bash) + SessionStart + Stop + SessionEnd + PreToolUse (.team/tasks/ guard)
  # - Agent: SessionStart + Stop + SessionEnd + PreToolUse (.team/tasks/ guard)
  ```

## 段階的な移行

1. **Phase 1**: proxy に `/statusline` 実装 + `formatStatusline` 関数 + テスト（statusline.sh は旧実装のまま、新エンドポイントは shadow で動作確認のみ）
2. **Phase 2**: `statusline.sh` を curl wrapper に差し替え、手動で 3 ロールとも表示確認
3. **Phase 3**: `.claude/settings.json` から UserPromptSubmit / Stop を削除し、`master-settings.json` の生成コードに移設。CONDUCTOR_ID guard も同時削除
4. **Phase 4**: `main.ts` から `CMUX_ROLE` env セットを 4 箇所削除（T211 内で完結）

全 Phase を本タスクで完結させる。外部タスクへの委譲は無い。

## リスクと対策

| リスク | 対策 |
|---|---|
| daemon が落ちている / 起動前の Claude セッションで statusline が壊れる | wrapper で `\|\| true`、失敗時は空出力（現行の未設定 case と同等） |
| curl のレイテンシが 300ms を超える場合 | max-time 2 で切り、タイムアウト時は空出力。ローカル HTTP は実測 5-20ms で問題ない想定 |
| Claude Code が statusline を頻繁に呼ぶ（数秒に 1 回）ことによる daemon 負荷 | /statusline はメモリ上の state 参照のみで I/O 無し。負荷はほぼゼロ |
| 既存 `~/.claude/statusline.sh` を上書きすることによるユーザーカスタマイズの喪失 | postinstall で hash が変わっていれば backup 作成後に上書き、その旨ログ出力 |
| 他プロジェクト（Dear, mado 等）の `~/.claude/statusline.sh` が古いバージョンのままになる | リリース後 CHANGELOG で周知、または最新 cmux-team のインストールで自動更新される |
| Phase 3 で `.claude/settings.json` から hook を削除するタイミングで、既存 Master セッション（旧 `.claude/settings.json` をロード済み）がまだ生きている可能性 | Master は `cmdLaunchMaster` 起動時に `--settings` 経由で新しい hook を持つため、新 Master を起動すれば即反映。リリース後の初回 `cmux-team start` で切り替わる。旧 Master が残っていても `.claude/settings.json` の削除で Master push が止まる（degraded だが壊れない） |
| T210 の statusline.sh:92 変更（CONDUCTOR_ID → CMUX_SURFACE）が本タスクで上書きされる | 意図した上書き。実害なし。T210 の diff の一部が本タスクの diff で消えるだけ |

## 検証ポイント

1. `bun test` グリーン（新規テスト含む）
2. 本リポジトリで `cmux-team start` → Master / Conductor / Agent すべての statusline が従来通り表示されること
3. Conductor に idle / busy / disconnected のいずれの状態でも正しく描画されること
4. daemon 停止時に statusline が空出力になり、Claude セッションがクラッシュしないこと
5. **Agent の UserPromptSubmit / Stop で Master state が汚染されないこと** — Agent で何かタスクを走らせ、`state.masterPrompt` / `state.masterStatus` が変化しないことを dashboard で確認
6. cfork した claude で Master push hook が走らないこと（`.claude/settings.json` から消えたので自動的に走らない）
7. cfork した claude で `.team/tasks/` 保護 hook は引き続き働くこと
8. `rg CMUX_ROLE skills/ bin/ .claude/ commands/ docs/` で 0 件（履歴記述を除く）
9. CHANGELOG / docs/spec/ の更新

## 参照

- `skills/cmux-team/manager/proxy.ts:132-229` — 既存エンドポイント実装
- `skills/cmux-team/manager/statusline.sh` — 現行の shell 実装
- `skills/cmux-team/manager/main.ts:1371, 1456, 1501, 1659` — CMUX_ROLE 設定箇所（削除対象）
- `skills/cmux-team/manager/main.ts:1493-1542` — cmdLaunchMaster の master-settings.json 生成
- `.claude/settings.json:3-26` — Master state push hook（削除対象）
- `.claude/settings.json:27-38` — PreToolUse `.team/tasks/` 保護 hook（残す）
- T148（statusline.sh の初期導入）
- T210（CONDUCTOR_ID 廃止、本タスクの前提）


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-211-1776271184` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-211-1776271184
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-211-1776271184/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/211-statusline-proxy-http-api-post-statusline/runs/task-211-1776271184
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/211-statusline-proxy-http-api-post-statusline/runs/task-211-1776271184/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら:

1. セッション上に完了レポートを表示する（conductor-role.md「完了時の処理」ステップ 8 参照。設計判断・試行錯誤・自己判断・懸念・成果の勘所を簡潔に出力）
2. 完了通知を送信する:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
   ```
