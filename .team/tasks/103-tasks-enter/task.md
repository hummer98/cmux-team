---
id: 103
title: Tasks タブで Enter 押下時にタスクドキュメントをフルスクリーン表示
priority: medium
created_at: 2026-04-07T02:06:07.192Z
---

## タスク
## 概要

ダッシュボードの Tasks タブでカーソル選択中のタスクに対し Enter を押すと、そのタスクの Markdown ファイルを glow（フルスクリーンページャー）で表示する。ESC/q で離脱し TUI に復帰。

## 実装方針

Artifacts タブの Enter 実装（dashboard.tsx:995-1013）と全く同じパターンを流用する。

### 変更点

1. **openArtifactInViewer を汎用化**: 関数名を `openMarkdownInViewer` 等に変更（または既存名のまま Tasks からも呼ぶ）
2. **Enter キーハンドラに tasks 分岐を追加**: `focusedArea === 'tasks'` の場合、選択中タスクの `filePath` を取得して viewer を起動
3. **ヘルプ表示更新**: Tasks タブのキーバインド表示に Enter: open を追加

### 既存の仕組み（そのまま使える）

- `resolveMarkdownViewer()`: CMUX_MD_VIEWER → glow → cat の優先順（dashboard.tsx:111-119）
- `openArtifactInViewer()`: TUI 停止 → glow フルスクリーン → TUI 復帰（dashboard.tsx:693-730）
- glow は標準で ESC/q でページャー離脱をサポート

## 対象ファイル

- skills/cmux-team/manager/dashboard.tsx
