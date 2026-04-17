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
