# タスク割り当て

## タスク内容

---
id: 143
title: TUI の Tasks パネルで Enter キーを押すと task.md を mo で開く
priority: medium
depends_on: [140]
created_at: 2026-04-10T22:04:43.638Z
---

## タスク
## 概要

TUI ダッシュボードの Tasks パネルでタスクを選択し Enter キーを押すと、そのタスクの task.md を Markdown ビューア（mo）で開けるようにする。

## 仕様

- **トリガー**: Tasks パネルでタスク選択中に Enter キー
- **開くファイル**: `.team/tasks/<id>-<slug>/task.md`
- **ビューア優先順位**: T140（artifacts open）と共通
  1. 環境変数 `CMUX_TEAM_MD_VIEWER` が設定されていればそのコマンドを使用
  2. デフォルト: `mo`
  3. `mo` が見つからなければ `cat` にフォールバック
- **起動方法**: `<viewer> <task-file-path>` で実行

## 実装場所

- `skills/cmux-team/manager/dashboard.tsx` — Tasks パネルのキーハンドラに Enter を追加
- ビューア解決ロジックは T140 で実装済みの関数（main.ts 内）を共通化して再利用すること

## 依存

- T140（artifacts open）のビューア解決ロジックを共通ユーティリティとして切り出す（まだ切り出されていなければ）


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-143-1775858683` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-143-1775858683
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-143-1775858683/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/143-tui-tasks-enter-task-md-mo/runs/task-143-1775858683
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/143-tui-tasks-enter-task-md-mo/runs/task-143-1775858683/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら、最後に:
```bash
cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
```
