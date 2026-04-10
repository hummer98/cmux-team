---
id: 136
title: update-task に --depends-on オプションを追加
priority: medium
created_at: 2026-04-10T17:59:36.322Z
---

## タスク
## 背景

`cmux-team update-task` は現在 `--status`, `--body`, `--title` のみ対応。`--depends-on` が指定できないため、タスク作成後に依存関係を変更できない。

## 要件

- `cmdUpdateTask` に `--depends-on <ids>` オプションを追加
- frontmatter の `depends_on:` 行を更新する（なければ追加）
- `--depends-on` 単体でも使えるようにする（`--status` 等なしでも OK）
- ヘルプテキスト（`help_update_task`）とコマンドヘッダーコメント（main.ts:17）も更新
- create-task と同じ形式（カンマ区切り ID リスト）で受け付ける
