# タスク割り当て

## タスク内容

---
id: 249
title: Conductor: マージ前に origin/<mainBranch> へ rebase する手順を追加
priority: medium
created_by: surface:47
created_at: 2026-04-17T17:42:21.915Z
---

## タスク
## 背景

現状 Conductor は worktree 内で commit 後、そのまま main へ `git merge` する（`skills/cmux-team/templates/ja/conductor-role.md` Step 7→8）。
タスク実行中に main が進んでいた場合、コンフリクトが main 側で発生する / 意図せず古いベースのマージコミットが残る、という問題がある。

会話中の議論:
> worktree 内で `git fetch && git rebase origin/<mainBranch>` してから main に fast-forward でマージすれば、
> コンフリクトが worktree 側で surface して main は常にクリーンに保てる。

## やってほしいこと

Step 7（commit）と Step 8（納品）の間に rebase ステップを追加する。
対象ファイル:
- `skills/cmux-team/templates/ja/conductor-role.md`
- `skills/cmux-team/templates/en/conductor-role.md`

追加すべき内容のたたき台（実装者が調整する前提）:

1. commit 後、worktree 内で:
   ```bash
   git fetch origin main
   git rebase origin/main
   ```
2. rebase が成功した場合のみ Step 8（ローカルマージ / PR）へ進む。
   ローカルマージは `--ff-only` を付けて fast-forward に限定する。
3. rebase でコンフリクトが出た場合の分岐:
   - Conductor が解決できる性質か判断（自明な混在、同一ファイルの別箇所、など）
   - 解決が難しい / 判断が必要なら `git rebase --abort` してタスクを一旦完了保留にし、完了レポートに【判断必要】として明記する
   - どこまでを Conductor に任せ、どこから人間に委ねるかの線引きを明文化する

## 判断が必要なポイント（実装時に決める）

- PR パス（push 経路）でも rebase してから push するか（force push が必要になるケースの扱い）
- ローカルマージを `--ff-only` 固定にするか、現状の `git merge` を残すか
- rebase コンフリクト時の挙動: Conductor が解決試行する / 即 abort して報告する、のどちらをデフォルトにするか
- タスクファイル側でオプトアウトできる余地を残すか（`skip-rebase: true` 的な指定）

## 留意点

- Step 8 のブランチ名表記が「タスク割り当てで指定されたブランチ名」となっているが、実体（`{{TASK_RUN_ID}}` 系）も合わせて揃えたほうがよいかも調査
- `main` 変数は既に conductor-role.md / conductor-task.md で使用済み（CLAUDE.md の「テンプレート変数仕様」参照）なので追加箇所でも同じ変数で OK
- ランタイムプロンプト（`.team/prompts/*.md`）は直接編集せず、テンプレート編集 → 再生成のルートを守る（CLAUDE.md の「プロンプト編集ルール」参照）

## 参考

- `skills/cmux-team/templates/ja/conductor-role.md` Step 7-8（L423-L445 付近）
- 同 `en/conductor-role.md` の対応箇所
- CLAUDE.md の「git worktree（概要）」セクション


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-249-1776454069` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-249-1776454069
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-249-1776454069/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/249-conductor-origin-mainbranch-rebase/runs/task-249-1776454069
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/249-conductor-origin-mainbranch-rebase/runs/task-249-1776454069/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら:

1. セッション上に完了レポートを表示する（conductor-role.md「完了時の処理」ステップ 8 参照。設計判断・試行錯誤・自己判断・懸念・成果の勘所を簡潔に出力）
2. 完了通知を送信する:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
   ```
