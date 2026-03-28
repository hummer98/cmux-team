---
id: 027
title: TUI Tasks セクションに直近5件を表示（open/closed/draft混在）
priority: medium
status: ready
created_at: 2026-03-28T11:15:00+09:00
---

## タスク

TUI の Tasks セクションを改善し、open タスクだけでなく直近5件を open/closed/draft 混在で表示する。

### 要件

1. `scanTasks()` で closed タスクも含め `createdAt` 降順ソートし、最新5件を `state.taskList` に入れる
2. TasksSection で status に応じた色分け:
   - **running（Conductor アサイン済）**: green
   - **ready（待機中）**: yellow
   - **draft**: dim
   - **closed**: dim + 取り消し線風 or グレー
3. ready と running の区別は現状の `assignedTaskIds` ロジックを維持

## 対象ファイル

- `skills/cmux-team/manager/daemon.ts` — `scanTasks()` の taskList 生成ロジック
- `skills/cmux-team/manager/dashboard.tsx` — TasksSection の表示
- `skills/cmux-team/manager/task.ts` — closed タスクの読み込み（必要なら）

## 完了条件

- TUI Tasks セクションに直近5件が表示される
- 各 status が色で視覚的に区別できる
- ready と running（Conductor 実行中）が区別できる

## Journal

- summary: TUI Tasks セクションで open/closed/draft を createdAt 降順で直近5件表示、status 別色分け（running=green, ready=yellow, draft/closed=dim）を実装
- files_changed: 4
