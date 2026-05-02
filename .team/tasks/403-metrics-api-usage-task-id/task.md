---
id: 403
title: metrics: api_usage の task_id 解決の調査・修正
priority: medium
created_by: surface:510
created_at: 2026-04-30T16:09:11.030Z
---

## タスク
## 背景

T379 (cmux-team metrics サブコマンド + hook_signals 棚卸し) の inspection で発見された minor 指摘 #2。

`api_usage` テーブルの `task_id` が全件 NULL のため、`cmux-team metrics` の per-task `tokens` 集計が常に 0 になる。

実測 (T379 worktree から):
```sql
SELECT COUNT(*) AS total, SUM(task_id IS NULL) AS null_task_id FROM api_usage;
-- 12,583 rows, 12,583 NULL
```

集計ロジック自体は in-memory fixture テストで正しく動作するため T379 のスコープ外として別タスク化。

## 調査範囲

- `skills/cmux-team/manager/proxy.ts` の task_id 解決ロジック（T305 で追加）
- 解決失敗のパス（surface → role → task_id の lookup chain）
- 本リポジトリ運用の特定設定差異（pool key モード等）

## 期待される成果

1. `api_usage.task_id` が解決される条件を特定
2. 修正可能なら `proxy.ts` の resolution ロジックを fix
3. 修正不能（外部要因）なら `.team/artifacts/` に research を残す

## 関連

- 親タスク: T379 (cmux-team metrics + hook_signals 棚卸し)
- 関連 commit: T305 (api_usage に task_id 列追加)
