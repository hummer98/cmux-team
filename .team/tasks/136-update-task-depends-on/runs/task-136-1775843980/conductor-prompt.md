# タスク割り当て

## タスク内容

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


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-136-1775843980` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-136-1775843980
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-136-1775843980/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/136-update-task-depends-on/runs/task-136-1775843980
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/136-update-task-depends-on/runs/task-136-1775843980/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら、最後に:
```bash
cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
```
