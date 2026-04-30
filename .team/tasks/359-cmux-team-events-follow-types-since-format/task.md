---
id: 359
title: cmux-team events サブコマンドを実装（--follow / --types / --since / --format）
priority: high
depends_on: [358]
created_by: surface:123
created_at: 2026-04-26T22:33:47.270Z
---

## タスク
T358 で書き込まれる \`.team/logs/events.jsonl\` を tail / filter / format conversion する CLI を実装する。

参照:
- spec: \`docs/spec/10-events-stream.md\`（T357）
- writer: T358 成果物
- issue: https://github.com/hummer98/cmux-team/issues/42

## CLI 仕様

\`\`\`
cmux-team events [--follow] [--types <list>] [--since <duration|timestamp>] [--format json|text]
\`\`\`

### Options

- \`--follow\` (\`-f\`): tail -F equivalent（rotate 対応）。生成された行を逐次 stdout に流す
- \`--types\`: comma-separated event type filter（exact match）。例: \`--types task_completed,task_aborted\`
- \`--since\`: 期間または絶対時刻
  - \`5m\` / \`1h\` / \`2d\` 形式（duration）
  - \`2026-04-27T12:00:00Z\` 形式（ISO 8601）
- \`--format json\`: JSONL そのまま出力（default）
- \`--format text\`: 人間可読 1 行 / record（debug 用、簡素な \`<ts> <event> <key fields>\` 形式）

### 終了コード

- \`0\`: 通常終了（\`--follow\` なしで EOF 到達）
- \`1\`: 引数エラー / events.jsonl 不在
- SIGINT: 即座に中断

## 実装場所

- \`bin/cmux-team\` の subcommand 追加
- 既存 subcommand pattern（create-task / status 等）に追従

## テスト

- 基本動作: file 全体読み取り、\`--types\` filter、\`--since\` filter
- \`--follow\`: 後発 append が拾えること、rotate を跨いで継続できること
- \`--format text\`: 人間可読出力の確認

## scope outside

- watch command の起動（T(task4)）
- writer 実装（T358）
- retention policy（T357 で決定）
