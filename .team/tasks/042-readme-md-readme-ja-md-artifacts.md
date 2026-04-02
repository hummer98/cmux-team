---
id: 042
title: README.md / README.ja.md に Artifacts 機能のドキュメントを追加
priority: medium
created_at: 2026-04-02T14:55:33.237Z
---

## タスク
## 背景
v3.12.0 で Artifacts 機能が追加されたが、README.md / README.ja.md が未更新。CLAUDE.md は対応済み。

## 修正内容

### README.md
- CLI Commands 表に `cmux-team artifacts` (list / show / search) を追加
- Slash Commands 表に `/artifact [type] [title]` を追加

### README.ja.md
- CLI コマンド表に `cmux-team artifacts` を追加
- スラッシュコマンド表に `/artifact [type] "タイトル"]` を追加
- 「プロジェクト内に作られるもの」の `.team/` 構造に `artifacts/` を追加

## 参考
- CLAUDE.md の Artifacts セクション（行435-483）が正しい記載例
- commands/artifact.md にコマンド仕様あり
