---
id: 059
title: ブランチ名・worktreeパスをタスクIDベースに変更
priority: medium
created_at: 2026-04-03T20:56:31.433Z
---

## タスク
## 概要

現状、Conductor のブランチ名と worktree パスは `run-<timestamp>` 形式（例: `run-1712345678/task`）で、タスクとの対応がわからない。

## 変更内容

ブランチ名と worktree パスを `task-<NNN>-<timestamp>` 形式に変更する。

例: タスク T042 → ブランチ `task-042-1712345678/task`、worktree `.worktrees/task-042-1712345678/`

## 対象ファイル

- `skills/cmux-team/manager/conductor.ts` — taskRunId 生成ロジック
- `skills/cmux-team/manager/template.ts` — テンプレート変数展開
- `skills/cmux-team/templates/conductor-task.md` — ブランチ名参照
- `skills/cmux-team/templates/conductor.md` — ブランチ名参照

## 理由

- git branch / git log でどのタスクの作業か一目でわかる
- 残留ブランチの掃除時にタスクを特定しやすい
- PR ブランチ名として意味を持つ
- timestamp を含むため同一タスクのリトライでも衝突しない
