# タスク割り当て

## タスク内容

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


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-103-1775527567` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-103-1775527567
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-103-1775527567/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/103-tasks-enter/runs/task-103-1775527567
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/103-tasks-enter/runs/task-103-1775527567/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら、最後に:
```bash
cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
```
