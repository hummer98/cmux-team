---
id: 033
title: CLI create-task コマンドで ID 自動採番タスク作成
priority: high
status: ready
created_at: 2026-03-28T04:40:00Z
---

## タスク

`main.ts create-task` サブコマンドを追加し、タスク作成と ID 採番を自動化する。

### 仕様

```bash
# 引数で指定
bun run main.ts create-task \
  --title "ジャーナル修正" \
  --priority high \
  --status ready \
  --body "daemon_reload をジャーナルから除外する"

# status 省略時は draft
```

### 内部処理

1. `.team/tasks/open/` と `.team/tasks/closed/` のファイル名から最大 ID を取得
2. +1 してゼロパディング（3桁）
3. タスクファイルを `.team/tasks/open/<id>-<slug>.md` に生成
4. status が ready の場合のみ、キューに `TASK_CREATED` を自動送信
5. stdout に作成したファイルパスと ID を出力: `TASK_ID=033 FILE=.team/tasks/open/033-slug.md`

### タスクファイル形式

```markdown
---
id: <自動採番>
title: <--title の値>
priority: <--priority の値、デフォルト medium>
status: <--status の値、デフォルト draft>
created_at: <ISO 8601>
---

## タスク
<--body の値>
```

## 対象ファイル

- `skills/cmux-team/manager/main.ts` — `cmdCreateTask()` 関数の追加とルーティング
- `skills/cmux-team/templates/master.md`（と `.team/prompts/master.md`）— タスク作成手順を CLI 経由に更新

## 完了条件

- `bun run main.ts create-task --title "test" --status ready` でタスクファイルが生成され、Manager に通知される
- ID が既存タスクと衝突しない
- master.md のタスク作成手順が CLI 利用に更新されている

## Journal

- summary: main.ts に create-task サブコマンドを追加し、ID 自動採番・タスクファイル生成・TASK_CREATED 通知を一括実行。master.md テンプレートも CLI 推奨に更新
- files_changed: 2

## Journal

- summary: main.ts に create-task サブコマンドを追加し、master.md テンプレートのタスク作成手順を CLI 経由に更新
- files_changed: 43
