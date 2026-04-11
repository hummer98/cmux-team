# タスク割り当て

## タスク内容

---
id: 160
title: Master statusline からコスト表示を削除し open タスク数を表示
priority: low
created_at: 2026-04-11T18:12:35.754Z
---

## タスク
## 背景

Master の statusline にコスト（\$0.00）が表示されているが、Claude Max サブスクでは従量課金が発生しないため無意味。

## やること

`skills/cmux-team/manager/statusline.sh` の master セクション（73-82行付近）:

- COST / COST_ICON の表示を削除
- 代わりに open タスク数（task-state.json の ready + assigned 件数）を表示する
  - 例: `T:3`（open タスク3件）
  - task-state.json を jq で集計

## 表示イメージ

変更前: `♦ Master | opus-4-6 | ctx 12% | \$0.00 |  main`
変更後: `♦ Master | opus-4-6 | ctx 12% | T:3 |  main`


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-160-1775931155` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-160-1775931155
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-160-1775931155/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/160-master-statusline-open/runs/task-160-1775931155
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/160-master-statusline-open/runs/task-160-1775931155/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら:

1. セッション上に完了レポートを表示する（conductor-role.md「完了時の処理」ステップ 8 参照。設計判断・試行錯誤・自己判断・懸念・成果の勘所を簡潔に出力）
2. 完了通知を送信する:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
   ```
