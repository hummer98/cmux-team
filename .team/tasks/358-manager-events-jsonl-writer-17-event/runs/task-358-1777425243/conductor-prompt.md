# タスク割り当て

## タスク内容

---
id: 358
title: Manager に events.jsonl writer を実装し 17 event 種を結線
priority: high
depends_on: [357]
created_by: surface:123
created_at: 2026-04-26T22:33:33.336Z
---

## タスク
T357 で確定した schema に従い、Manager に JSONL writer を実装する。Task FSM / Conductor FSM transition で \`.team/logs/events.jsonl\` に append する。

参照:
- spec: \`docs/spec/10-events-stream.md\`（T357 成果物）
- issue: https://github.com/hummer98/cmux-team/issues/42
- 棚卸し（発火源詳細）: https://github.com/hummer98/cmux-team/issues/42#issuecomment-4323199218

## 実装範囲

### 1. Writer module 新規作成

\`skills/cmux-team/manager/eventStreamWriter.ts\`:

- \`.team/logs/events.jsonl\` に append-only で書き込む
- \`JSON.stringify\` で 1 record/line（trailing newline 含む）
- atomic append（\`fs.appendFile\` または stream 利用、複数 writer 競合は想定外）
- \`schema_version\` 自動付与（spec の現行バージョン定数を参照）
- \`ts\` 自動付与（書き込み時刻を ISO 8601 で）
- 書き込みエラー時は manager.log に error log し、daemon は継続

### 2. 17 event 種を結線

棚卸しレポートの発火源を参照して以下を結線:

**Task FSM（\`state-machine/task-fsm.ts\`）:**
- \`task_created\` / \`task_ready\` / \`task_assigned\` / \`task_completed\` / \`task_completed_state_mismatch\` / \`task_aborted\` / \`task_reverted_to_ready\`

**Conductor FSM（\`state-machine/conductor-fsm.ts\`）:**
- \`conductor_running\` / \`conductor_recovered\` / \`conductor_disconnected\` / \`conductor_asking\` / \`conductor_done_unresolved\` / \`conductor_start_timeout\` / \`conductor_assign_timeout\` / \`conductor_disconnect_timeout\`

**Wrapper 層（\`daemon.ts\`）:**
- \`task_aborted\` の reason 詳細（user_clear / judgment_pending / disconnect_timeout / other）を payload に含める
- sync state guard failure を \`task_sync_guard_rejected\` event として writer に送る（assign_failed から切り出し）

### 3. Retention policy 実装

T357 で決定した方針に従う（daily rotate / size limit / unlimited append のいずれか）。

## テスト

\`skills/cmux-team/manager/eventStreamWriter.test.ts\` を新規作成:

- 各 event 種について writer に届くか unit test
- file format が schema 通りか snapshot test（schema_version / ts が期待通り付与）
- 書き込みエラー時に daemon が落ちないこと
- retention policy が動作すること（rotate 採用時）

## scope outside

- CLI（\`cmux-team events\`）は T(task3)
- watch command は T(task4)
- 既存 manager.log との重複は許容（v1 では並行運用）


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-358-1777425243` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-358-1777425243
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-358-1777425243/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/358-manager-events-jsonl-writer-17-event/runs/task-358-1777425243
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/358-manager-events-jsonl-writer-17-event/runs/task-358-1777425243/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
