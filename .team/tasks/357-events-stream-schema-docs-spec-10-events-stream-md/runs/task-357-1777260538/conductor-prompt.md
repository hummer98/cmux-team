# タスク割り当て

## タスク内容

---
id: 357
title: events stream の schema を docs/spec/10-events-stream.md として確定
priority: high
created_by: surface:123
created_at: 2026-04-26T22:33:14.729Z
---

## タスク
issue #42 で iterate した events stream schema v2（17 event 種）を spec として確定する。

参照:
- issue: https://github.com/hummer98/cmux-team/issues/42
- schema v2: https://github.com/hummer98/cmux-team/issues/42#issuecomment-4323201582

## 実装範囲

### 1. docs/spec/10-events-stream.md 新規作成

以下を spec として定義:

- **全 event 共通 field**: \`ts\`（ISO 8601）/ \`event\`（type）/ \`schema_version\`（integer）
- **17 event 種それぞれの payload schema**:
  - Task lifecycle: \`task_created\` / \`task_ready\` / \`task_assigned\` / \`task_completed\` / \`task_completed_state_mismatch\` / \`task_aborted\` / \`task_sync_guard_rejected\` / \`task_reverted_to_ready\`
  - Conductor lifecycle: \`conductor_running\` / \`conductor_recovered\` / \`conductor_disconnected\` / \`conductor_asking\` / \`conductor_done_unresolved\` / \`conductor_start_timeout\` / \`conductor_assign_timeout\` / \`conductor_disconnect_timeout\`
- **File format**: JSONL（1 行 1 record）
- **File location**: \`.team/logs/events.jsonl\`
- **Schema versioning rule**: breaking change 時に \`schema_version\` を bump

### 2. Retention policy（確定）

**方針: 無制限 append（rotate なし） + GC は別タスクで横断的に扱う**

理由（spec 本文にも記載すること）:

- 既存の \`.team/logs/manager.log\` および \`.team/traces/traces.db\` も同様に単一 append + GC 未実装で運用されている。CLAUDE.md の「既知の注意点」にも \`hook_signals\` / \`api_usage\` の手動 GC が明記済み。events.jsonl だけ rotate を入れると例外的になる
- watch mode (\`/cmux-team:watch\`) の live tail (\`cmux-team events --follow\`) と相性が良い。daily / size rotate を入れると reader が fd 切り替え時に event をロストするリスクがある
- reader は単純な append-only stream として扱える。\`--since\` / \`--types\` フィルタは reader 側で行えば十分でファイル境界を意識する必要がない
- 生成レートが低い（17 event 種 × 1 record 数百 byte ≒ 1 日数 MB レベル）ため、当面ディスクは詰まらない

**spec 本文に明記する事項**:

- events.jsonl は単一ファイルへ append 専用
- rotate / archive / 自動削除は **行わない**
- 手動 GC が必要になった場合の運用例: \`tail -n 100000 events.jsonl > events.jsonl.tmp && mv events.jsonl.tmp events.jsonl\`（ただし live tail 中の操作は非推奨）
- **将来の retention 設計は \`.team/\` 全体の GC ポリシー（\`hook_signals\` / \`api_usage\` / \`manager.log\` / \`events.jsonl\` を統合）として別タスクで扱う**

### 3. glossary 反映

\`docs/spec/glossary.md\` に \`events stream\` / \`event channel\` 用語を追加し、本 spec へのリンクを張る。

## scope outside

- Manager の writer 実装（T358）
- \`cmux-team events\` CLI（T359）
- \`/cmux-team:watch\` command（T360）
- CLAUDE.md / README への反映（T361）
- 横断的 GC ポリシーの設計・実装（別途タスク化）


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-357-1777260538` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-357-1777260538
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-357-1777260538/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/357-events-stream-schema-docs-spec-10-events-stream-md/runs/task-357-1777260538
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/357-events-stream-schema-docs-spec-10-events-stream-md/runs/task-357-1777260538/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
