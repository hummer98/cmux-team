# Plan: タスク時間管理 assignedAt 記録 + ダッシュボード表示改善

## 作業ディレクトリ

```
/Users/yamamoto/git/cmux-team/.worktrees/task-110-1775671796
```

## 変更概要

3ファイルの変更。タスクに assignedAt を記録し、ダッシュボードの時刻表示を状態別に切り替える。

## 変更1: task.ts — TaskState に assignedAt 追加

**ファイル**: `skills/cmux-team/manager/task.ts`
**行**: 23-29（TaskState インターフェース）

```typescript
export interface TaskState {
  status: string;
  assignedAt?: string;  // ISO 8601 — assign 時のタイムスタンプ（追加）
  closedAt?: string;
  abortedAt?: string;
  deletedAt?: string;
  journal?: string;
}
```

## 変更2: daemon.ts — TaskSummary に assignedAt 追加 + assign 時の記録

### 2a. TaskSummary インターフェースに追加

**ファイル**: `skills/cmux-team/manager/daemon.ts`
**行**: 21-31（TaskSummary インターフェース）

```typescript
export interface TaskSummary {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  assignedAt?: string;   // ← 追加
  closedAt?: string;
  abortedAt?: string;
  dependsOn: string[];
  baseBranch?: string;
  filePath?: string;
}
```

### 2b. scanTasks 内の assign 処理で task-state.json に assignedAt を記録

**ファイル**: `skills/cmux-team/manager/daemon.ts`
**行**: 627 付近（`assignTask` 呼出し成功後）

現在のコード:
```typescript
const updated = await assignTask(idleConductor, task.id, state.projectRoot);
if (updated) {
  state.conductors.set(updated.surface, updated);
}
```

変更後:
```typescript
const updated = await assignTask(idleConductor, task.id, state.projectRoot);
if (updated) {
  state.conductors.set(updated.surface, updated);
  // task-state.json に assigned + assignedAt を記録
  const ts = await loadTaskState(state.projectRoot);
  ts[task.id] = {
    ...ts[task.id],
    status: 'assigned',
    assignedAt: new Date().toISOString(),
  };
  await saveTaskState(state.projectRoot, ts);
}
```

**import 追加**: daemon.ts の import に `saveTaskState` を追加。

### 2c. taskList 構築で assignedAt を設定

**行**: 604-614 付近

```typescript
state.taskList = combined.map((t) => ({
  id: t.id,
  title: t.title,
  status: t.status,
  createdAt: t.createdAt,
  assignedAt: taskState[t.id]?.assignedAt,   // ← 追加
  closedAt: taskState[t.id]?.closedAt,
  abortedAt: taskState[t.id]?.abortedAt,
  dependsOn: t.dependsOn.filter(dep => !closed.has(dep)),
  baseBranch: t.baseBranch,
  filePath: t.filePath,
}));
```

## 変更3: dashboard.tsx — timeInfo 表示ロジック + compactElapsed 関数

### 3a. compactElapsed 関数を追加

formatElapsed 関数の直後（行172付近）に追加:

```typescript
/** 経過時間のコンパクト表示（ダッシュボード用） */
function compactElapsed(startIso: string, endIso?: string): string {
  const startMs = new Date(startIso).getTime();
  const endMs = endIso ? new Date(endIso).getTime() : Date.now();
  const sec = Math.floor((endMs - startMs) / 1000);
  if (sec < 60) return "<1m";
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}
```

### 3b. buildTaskRow 内の timeInfo ロジックを変更

**行**: 482-486

現在:
```typescript
const timeInfo = isAborted && task.abortedAt
  ? utcToLocal(task.abortedAt).slice(0, 5)
  : isClosed && task.closedAt
  ? utcToLocal(task.closedAt).slice(0, 5)
  : !isClosed && task.createdAt ? formatElapsed(task.createdAt) : "";
```

変更後:
```typescript
const timeInfo = isAborted && task.abortedAt
  ? `${utcToLocal(task.abortedAt).slice(0, 5)}${task.assignedAt ? ` (${compactElapsed(task.assignedAt, task.abortedAt)})` : ""}`
  : isClosed && task.closedAt
  ? `${utcToLocal(task.closedAt).slice(0, 5)}${task.assignedAt ? ` (${compactElapsed(task.assignedAt, task.closedAt)})` : task.createdAt ? ` (${compactElapsed(task.createdAt, task.closedAt)})` : ""}`
  : assigned && task.assignedAt
  ? `${utcToLocal(task.assignedAt).slice(0, 5)} (${compactElapsed(task.assignedAt)})`
  : task.createdAt
  ? utcToLocal(task.createdAt).slice(0, 5)
  : "";
```

表示パターン:
| タスク状態 | 表示内容 | 例 |
|-----------|---------|-----|
| draft / ready / blocked | 作成時間（HH:MM形式） | `14:30` |
| running（assigned） | 開始時間 + 経過時間 | `14:30 (2h35m)` |
| closed | 完了時刻 + 総実行時間 | `16:05 (1h35m)` |
| aborted | 中止時刻 + 実行時間 | `15:00 (30m)` |

## 注意事項

- 既存の `formatElapsed` 関数は他で使用されている（Conductor の経過時間表示等）ので削除しない
- `saveTaskState` は daemon.ts では未 import のため追加が必要
- `loadTaskState` は daemon.ts の既存 import（`loadTasks` 内部で使用される）として存在するが、直接呼出し用に import 確認が必要
