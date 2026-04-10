# タスク割り当て

## タスク内容

---
id: 135
title: 5hスロットリング閾値を95%→90%に変更
priority: high
depends_on: [133]
created_at: 2026-04-10T17:58:11.131Z
---

## タスク
T133 で実装されるスロットリング閾値を 0.95 から 0.90 に変更する。

対象: THROTTLE_5H_THRESHOLD 定数（daemon.ts または schema.ts に定義されているはず）を 0.90 に書き換えるだけ。


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-135-1775844007` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-135-1775844007
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-135-1775844007/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/135-5h-95-90/runs/task-135-1775844007
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/135-5h-95-90/runs/task-135-1775844007/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら、最後に:
```bash
cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
```
