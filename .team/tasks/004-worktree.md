---
id: 004
title: 残存 worktree のクリーンアップ
priority: high
created_at: 2026-03-29T05:59:55.507Z
---

## タスク
## 目的

完了済みタスクの worktree 残骸を削除する。

## 対象

以下の worktree を削除する（稼働中タスクの worktree は除外）:

- .worktrees/conductor-1774670317
- .worktrees/conductor-1774671996
- .worktrees/conductor-1774673533
- .worktrees/conductor-1774710155
- .worktrees/conductor-1774712269
- .worktrees/run-1774719424
- .worktrees/run-1774719441
- .worktrees/run-1774719675
- .worktrees/run-1774720607
- .worktrees/run-1774728573
- .claude/worktrees/test-check

## 手順

git worktree remove <path> --force && git branch -d <branch> 2>/dev/null || true

削除後に git worktree prune を実行。

## 注意
- 稼働中の run-1774762754, run-1774763380 は絶対に削除しない
