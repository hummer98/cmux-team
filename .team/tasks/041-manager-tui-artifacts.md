---
id: 041
title: Manager TUI に Artifacts タブ追加
priority: medium
created_at: 2026-04-02T06:47:18.531Z
---

## タスク
## タスク

Manager daemon の TUI に Artifacts タブを統合し、Journal / Artifacts / Log の3タブ構成にする。

## 依存

T040 完了後に着手

## 機能

- .team/artifacts/ を watch して新規ファイルを自動検出・リスト更新
- カーソル移動で artifact 選択、下部にプレビュー表示
- ソート切り替え（番号順 / created / updated）
- タイプ絞り込み、検索

## 実装方針

- 既存の Rezi TUI のタブ切り替え機構を拡張
- T040 の frontmatter パースを共通モジュールとして利用
