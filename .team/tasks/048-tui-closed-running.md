---
id: 048
title: TUI: closedタスクがrunning表示のままになるバグ修正
priority: high
created_at: 2026-04-03T00:49:47.684Z
---

## タスク
## 概要
task-state.json で closed になったタスクが TUI の Tasks エリアで running のまま表示されるバグを修正する。

## 原因
dashboard.tsx の buildTaskRow() で:
```typescript
const label = assigned ? "running" : task.status;
```
task-state.json の status より conductor.taskId の存在（assignedTaskIds）を優先しているため、Conductor の resetConductor() が完了する前のダッシュボード描画で running のまま表示される。

## 修正方針
task-state.json の status が closed であれば、assignedTaskIds に含まれていても closed と表示する。例:
```typescript
const label = task.status === 'closed' ? 'closed' : (assigned ? 'running' : task.status);
```
task-state.json が真のソースなので、それを優先すべき。

## 対象ファイル
- `skills/cmux-team/manager/dashboard.tsx` — buildTaskRow() の表示ロジック修正
