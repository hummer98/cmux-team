# タスク割り当て

## タスク内容

---
id: 134
title: リリース
priority: medium
depends_on: [131, 132, 133, 135, 136]
created_at: 2026-04-10T14:13:53.733Z
---

T131, T132, T133, T135, T136 がすべて closed になったら /release を実行してリリースする。

## 手順

1. CHANGELOG.md の更新内容を確認
2. /release コマンドでバージョン自動判定・CHANGELOG更新・コミット・タグpush・plugin更新を実行


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-134-1775844735` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-134-1775844735
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-134-1775844735/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/134-task/runs/task-134-1775844735
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/134-task/runs/task-134-1775844735/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら、最後に:
```bash
cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
```
