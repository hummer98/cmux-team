---
id: 040
title: cmux-team artifacts CLI サブコマンド実装
priority: medium
created_at: 2026-04-02T06:47:13.311Z
---

## タスク
## タスク

cmux-team artifacts CLI サブコマンドを実装し、ターミナルからアーティファクトの管理・検索を行えるようにする。

## 依存

T039 完了後に着手

## サブコマンド

- list（デフォルト）: --sort created/updated, --type, --task で絞り込み
- show A001: 内容表示
- search "キーワード": frontmatter + 本文の全文検索
- --validate: フロントマター必須フィールドの検証

## 出力フォーマット

A001  research  タイトル  2026-04-02
