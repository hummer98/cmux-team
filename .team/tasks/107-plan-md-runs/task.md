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

plan.md の出力先を worktree 内ではなく `{{OUTPUT_DIR}}/plan.md` に変更。
- `plan.md を git commit` の指示を削除（runs/ 配下はコミット対象外でよい）
- worktree 内へのコピー指示も不要

### 2. conductor-role.md — Phase 2/3/4 の参照パス変更

Design Reviewer, Implementer, Inspector が plan.md を読む際のパスを `{{OUTPUT_DIR}}/plan.md` に統一。

### 3. Conductor のプロンプト生成（conductor.ts / template.ts）

Agent spawn 時のプロンプトに plan.md の絶対パスを注入する。`{{OUTPUT_DIR}}` は既に絶対パスで展開されるので、テンプレート内で `{{OUTPUT_DIR}}/plan.md` と記述すれば Agent がアクセスできる。

### 4. 各 Agent テンプレート（planner.md, design-reviewer.md, implementer.md, inspector.md）

plan.md の参照・書き込みパスを `{{OUTPUT_DIR}}/plan.md` に変更。

## 対象ファイル

- skills/cmux-team/templates/conductor-role.md
- skills/cmux-team/templates/planner.md
- skills/cmux-team/templates/design-reviewer.md
- skills/cmux-team/templates/implementer.md
- skills/cmux-team/templates/inspector.md
- skills/cmux-team/manager/conductor.ts（必要に応じて）
