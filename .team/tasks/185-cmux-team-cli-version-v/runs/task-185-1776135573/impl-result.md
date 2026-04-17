# T185 実装結果

## 変更ファイル

- `skills/cmux-team/manager/main.ts` — サブコマンド dispatch 直前に `--version` / `-v` の先行処理を追加。`import.meta.url` から `../../../package.json` を resolve し、`cmux-team X.Y.Z` を出力。読み取り失敗時は `cmux-team (version unknown)` へフォールバック。
- `skills/cmux-team/manager/i18n.ts` — `help_main` (en / ja) の Usage 先頭に `cmux-team --version` の行を追加。

## コミット

```
d7f11d6 feat(cli): add --version / -v flag to cmux-team
 2 files changed, 14 insertions(+)
```

## 動作確認ログ

```
$ bun skills/cmux-team/manager/main.ts --version
cmux-team 3.44.1

$ bun skills/cmux-team/manager/main.ts -v
cmux-team 3.44.1

$ bun skills/cmux-team/manager/main.ts --help | head -20
cmux-team — マルチエージェント開発オーケストレーション

Usage:
  cmux-team --version                          バージョン表示
  cmux-team start                              daemon 起動 + Master spawn
  cmux-team send TASK_CREATED --task-id <id> --task-file <path>
  cmux-team send SHUTDOWN
  cmux-team status                             ステータス表示
  cmux-team stop                               graceful shutdown
  cmux-team spawn-conductor
  cmux-team spawn-agent --conductor-surface <surface> --role <role> --prompt <prompt>
  cmux-team agents                             稼働中エージェント一覧
  cmux-team kill-agent --surface <surface>
  cmux-team send-agent --surface <surface> <message>    Agent にメッセージ送信
  cmux-team create-task --title <title> [--priority <p>] [--status <s>] [--body <text>] [--depends-on <ids>] [--run-after-all]
  cmux-team update-task --task-id <id> --status <status>
  cmux-team close-task --task-id <id> [--journal <text>]
  cmux-team await-task --task-id <id> [--timeout <sec>]    タスク完了待ち
  cmux-team abort-task --task-id <id> [--journal <text>] 実行中タスクを中止
  cmux-team restart-task --task-id <id> [--journal <text>] 実行中タスクを再実行
```

## 完了条件チェック

- [x] `--version` / `-v` で package.json の version が出力される
- [x] `--help` Usage 先頭に `cmux-team --version` の行が追加されている
- [x] 既存サブコマンド（`--help`）の動作に影響なし
- [x] コミット済み
