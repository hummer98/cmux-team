# タスク割り当て

## タスク内容

---
id: 253
title: mainBranch の暗黙フォールバックを削除し、解決失敗で fail-stop する
priority: medium
created_by: surface:47
created_at: 2026-04-17T18:26:12.835Z
---

## タスク
## 背景

A015 の実装タスク (d) パラメータ暗黙フォールバック対策。

現状 `mainBranch` の解決は以下の 3 段構成:

1. `CMUX_TEAM_MAIN_BRANCH` 環境変数
2. `.team/config.json` の `mainBranch`
3. `git symbolic-ref refs/remotes/origin/HEAD` で検出
4. **`"main"` リテラルにフォールバック** (source=`fallback`)

4 番目のフォールバックは、main ブランチが存在しないプロジェクト
（trunk / master / develop 等）で worktree 作成が沈黙で壊れる原因になる。
commit やマージが意図しない branch に向かうリスクがある。

## やること

1. `main.ts:cmdStart` の `mainBranch` 解決ロジックから
   リテラル `"main"` フォールバック (source=`fallback`) を削除
2. detection 失敗時は exit 1 + エラーメッセージ（config への明示指定を促す）
3. ユーザーガイド / README の該当箇所を更新
4. `.team/config.json` への明示指定を強く推奨するメッセージを出す

## 判断が必要なポイント

- 既存プロジェクトで既に config 書き込み済みなら影響なし（T213 移行済みのはず）
- 初回 `cmux-team start` 時の UX: detection 失敗ケースで
  インタラクティブに尋ねるか、exit してメッセージで config 修正を促すか
- `git symbolic-ref` が失敗する具体パターンのドキュメント化
  （新規 repo で push 前、shallow clone で origin/HEAD 欠落、等）

## 参考

- A015 「現状コードの逸脱箇所インデックス」(d) 項
- CLAUDE.md 「`mainBranch` の優先順位」
- `daemon.ts` の `main_branch_resolved` ログ


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-253-1776514236` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-253-1776514236
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-253-1776514236/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/253-mainbranch-fail-stop/runs/task-253-1776514236
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/253-mainbranch-fail-stop/runs/task-253-1776514236/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら:

1. セッション上に完了レポートを表示する（conductor-role.md「完了時の処理」Step 12 参照。設計判断・試行錯誤・自己判断・懸念・成果の勘所を簡潔に出力）
2. 完了通知を送信する:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
   ```
