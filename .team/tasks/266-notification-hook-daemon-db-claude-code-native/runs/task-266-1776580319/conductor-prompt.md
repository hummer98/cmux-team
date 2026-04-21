# タスク割り当て

## タスク内容

---
id: 266
title: Notification hook を daemon に集約・DB 記録し Claude Code native 通知を吸収する
priority: high
created_at: 2026-04-19T04:03:33.757Z
---

## タスク
## 背景

Master surface に「Claude is waiting for your input」「どうしますか？」などの意味不明な OS 通知が届く。
調査の結果:

- cmux wrapper (`/Applications/cmux.app/Contents/Resources/bin/claude`) は `.local/bin/claude` 直起動で経由していない
- `claudeCodeHooksEnabled=0` なので仮に wrapper 経由でも発火しない
- cmux-team daemon 自身は `"Agent asking"` を Agent surface にしか送らない
- user / project スコープどちらにも `Notification` hook は未定義
- → **Claude Code 本体のネイティブ OS 通知がそのまま露出**している状態（#2543 / #2910 相当の挙動）

本家参考 issue:
- https://github.com/manaflow-ai/cmux/issues/2543
- https://github.com/manaflow-ai/cmux/issues/2910
- https://github.com/manaflow-ai/cmux/issues/2077

## 目的

1. 全 `Notification` hook を cmux-team daemon に集約
2. 発火タイミング・文言・ context を DB + log に記録
3. 結果として Claude Code 本体の native OS 通知を吸収（hook 登録済みと判定させる）

「どの surface / role / task_id で、いつ、どんな notification_type / message が飛んだか」を事後追跡可能にし、今後のノイズ源を特定する基盤を作る。

## 実装スコープ

### 1. schema.ts に `NotificationMessage` 追加
\`\`\`ts
export const NotificationMessage = z.object({
  type: z.literal("NOTIFICATION"),
  surface: z.string(),
  surfaceUuid: z.string().uuid().optional(),
  workspaceUuid: z.string().uuid().optional(),
  pid: z.number().optional(),
  role: z.enum(["master", "conductor", "agent"]).optional(),
  payload: z.record(z.any()).optional(),
  timestamp: z.string().datetime(),
});
\`\`\`
`QueueMessage` discriminated union に追加。

### 2. main.ts `cmdSend` に NOTIFICATION case
既存 `SESSION_STARTED` と同じ `--from-stdin` 経路。追加フラグ `--surface-uuid` / `--workspace-uuid` / `--role` を受ける（他の既存 send 種にも将来足すが今回は Notification のみ）。

### 3. generator 3 種に Notification hook 追加

`generateMasterSettings` / `generateConductorSettings` / `generateAgentSettings` に以下を挿入（role 値のみ差替え）:
\`\`\`json
\"Notification\": [{
  \"matcher\": \"\",
  \"hooks\": [{
    \"type\": \"command\",
    \"command\": \"bash -c 'cmux-team send NOTIFICATION --from-stdin --surface \\\"\${CMUX_SURFACE}\\\" --surface-uuid \\\"\${CMUX_SURFACE_ID:-}\\\" --workspace-uuid \\\"\${CMUX_WORKSPACE_ID:-}\\\" --pid \\\"\$PPID\\\" --role master 2>/dev/null || true'\",
    \"timeout\": 5000
  }]
}]
\`\`\`

### 4. daemon.ts `handleMessage` に `case \"NOTIFICATION\"` 追加

- 状態遷移なし（pure logging）
- daemon 側で以下を逆引きして authoritative に補完:
  - `role`（state.masters / state.conductors / agents 走査）
  - `task_id` / `task_run_id` / `task_title`
  - `conductor_surface`（agent 行の親）
  - `agent_role`
- `insertHookSignal` で hook_signals に書き込み
- `manager.log` に 1 行サマリ

### 5. hook_signals テーブル列拡張

\`\`\`sql
ALTER TABLE hook_signals ADD COLUMN surface_uuid TEXT;
ALTER TABLE hook_signals ADD COLUMN workspace_uuid TEXT;
ALTER TABLE hook_signals ADD COLUMN role TEXT;
ALTER TABLE hook_signals ADD COLUMN task_id TEXT;
ALTER TABLE hook_signals ADD COLUMN conductor_surface TEXT;
ALTER TABLE hook_signals ADD COLUMN agent_role TEXT;
ALTER TABLE hook_signals ADD COLUMN message TEXT;
ALTER TABLE hook_signals ADD COLUMN notification_type TEXT;
CREATE INDEX IF NOT EXISTS idx_hook_signals_surface_uuid ON hook_signals(surface_uuid);
CREATE INDEX IF NOT EXISTS idx_hook_signals_role ON hook_signals(role);
CREATE INDEX IF NOT EXISTS idx_hook_signals_task_id ON hook_signals(task_id);
\`\`\`

`trace-store.ts` 側に migration（列存在チェック → ADD）を入れて既存 DB を壊さない。

NOTIFICATION 行では既存列 `reason` / `source` / `question` は NULL（流用しない。他メッセージ種の意味を守るため）。

### 6. manager.log フォーマット

\`\`\`
[ts] notification_received C[192/22D8F9] role=conductor task_id=265 task_run_id=task-265-1776569268 ntype=idle_prompt message=\"Claude is waiting for your input\" pid=80850
\`\`\`

`formatSurface` に optional な UUID 末尾 6〜8 文字付与機能を追加。Agent は `formatPair` で `C[192]>A[234/81AC03]` 形式。

### 7. trace-hooks CLI

既存 `cmux-team trace-hooks` がそのまま `--type NOTIFICATION` で読める。追加で `--role master/conductor/agent` / `--task-id <id>` の絞り込みフィルタを追加（任意、Nice to have）。

## 受け入れ条件

- [ ] Master / Conductor / Agent の 3 surface 全てで Notification hook 発火時に hook_signals に NOTIFICATION 行が記録される
- [ ] `cmux-team trace-hooks --type NOTIFICATION --json` で role / task_id / message / notification_type / surface_uuid が取得できる
- [ ] manager.log に `notification_received ...` の 1 行サマリが出る
- [ ] Claude Code 本体の native OS 通知（\"Claude is waiting for your input\" / \"どうしますか？\" 等）が **出なくなる** か、出ても頻度が減る
- [ ] 既存 hook（SESSION_STARTED / SESSION_STOP 等）の挙動に回帰なし
- [ ] 既存 hook_signals テーブルを持つプロジェクトで migration が壊れず動く
- [ ] daemon.test.ts / main.test.ts に Notification ルーティングの smoke test 追加

## 非ゴール

- cmux terminal の OSC escape 経路の通知抑止（本家 cmux 側の責務）
- TUI ダッシュボードでの Notification 表示（別タスク）
- フィルタリング（idle_prompt を無視する等のポリシー）— 収集後に分析してから次タスクで判断

## 参考

- 既存 hook 登録: skills/cmux-team/manager/main.ts:1542-1710
- hook_signals schema: skills/cmux-team/manager/trace-store.ts
- CLAUDE.md の「hook 全送信ポリシー（T216）」


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-266-1776580319` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-266-1776580319
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-266-1776580319/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/266-notification-hook-daemon-db-claude-code-native/runs/task-266-1776580319
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/266-notification-hook-daemon-db-claude-code-native/runs/task-266-1776580319/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら:

1. セッション上に完了レポートを表示する（conductor-role.md「完了時の処理」Step 12 参照。設計判断・試行錯誤・自己判断・懸念・成果の勘所を簡潔に出力）
2. 完了通知を送信する:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
   ```
