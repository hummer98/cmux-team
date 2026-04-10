# タスク割り当て

## タスク内容

---
id: 107
title: plan.md をタスクフォルダ runs/ 配下に配置するよう変更
priority: high
created_at: 2026-04-07T09:37:51.382Z
---

## タスク
## 背景

Planner Agent が worktree 内に plan.md を作成するが、worktree は前タスクのコミットを含むため plan.md が残存し、別タスクの plan.md と衝突する問題が発生した（KDG-lab T002 で実際に発生）。

T102 のフォルダ集約により `.team/tasks/TNNN-xxx/runs/<taskRunId>/` が使えるようになったので、plan.md もここに配置する。

## 変更内容

### 1. conductor-role.md — Phase 1 の指示変更

plan.md の出力先を worktree 内ではなく `/Users/yamamoto/git/cmux-team/.team/tasks/107-plan-md-runs/runs/task-107-1775554671/plan.md` に変更。
- `plan.md を git commit` の指示を削除（runs/ 配下はコミット対象外でよい）
- worktree 内へのコピー指示も不要

### 2. conductor-role.md — Phase 2/3/4 の参照パス変更

Design Reviewer, Implementer, Inspector が plan.md を読む際のパスを `/Users/yamamoto/git/cmux-team/.team/tasks/107-plan-md-runs/runs/task-107-1775554671/plan.md` に統一。

### 3. Conductor のプロンプト生成（conductor.ts / template.ts）

Agent spawn 時のプロンプトに plan.md の絶対パスを注入する。`/Users/yamamoto/git/cmux-team/.team/tasks/107-plan-md-runs/runs/task-107-1775554671` は既に絶対パスで展開されるので、テンプレート内で `/Users/yamamoto/git/cmux-team/.team/tasks/107-plan-md-runs/runs/task-107-1775554671/plan.md` と記述すれば Agent がアクセスできる。

### 4. 各 Agent テンプレート（planner.md, design-reviewer.md, implementer.md, inspector.md）

plan.md の参照・書き込みパスを `/Users/yamamoto/git/cmux-team/.team/tasks/107-plan-md-runs/runs/task-107-1775554671/plan.md` に変更。

## 対象ファイル

- skills/cmux-team/templates/conductor-role.md
- skills/cmux-team/templates/planner.md
- skills/cmux-team/templates/design-reviewer.md
- skills/cmux-team/templates/implementer.md
- skills/cmux-team/templates/inspector.md
- skills/cmux-team/manager/conductor.ts（必要に応じて）


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-107-1775554671` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-107-1775554671
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-107-1775554671/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/107-plan-md-runs/runs/task-107-1775554671
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/107-plan-md-runs/runs/task-107-1775554671/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら、最後に:
```bash
cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
```
