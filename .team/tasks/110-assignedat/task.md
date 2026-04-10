---
id: 110
title: タスク時間管理: assignedAt 記録 + ダッシュボード表示改善
priority: high
created_at: 2026-04-08T18:09:56.626Z
---

## タスク
## 概要

タスクに作成時間・開始時間・終了時間を保持し、ダッシュボードの Tasks 欄の日時表示を状態に応じて切り替える。

## 変更内容

### 1. task-state.json に assignedAt を追加

**task.ts** の TaskState インターフェースに `assignedAt?: string` (ISO 8601) を追加。

**daemon.ts** の assignTask 処理で task-state.json に `assignedAt` を記録する。
具体的には scanTasks 内の assign 処理（status を 'assigned' に変更する箇所）で:

```typescript
taskState[taskId] = {
  ...taskState[taskId],
  status: 'assigned',
  assignedAt: new Date().toISOString(),
};
```

### 2. TaskSummary に assignedAt を追加

**daemon.ts** の TaskSummary インターフェースに `assignedAt?: string` を追加。
scanTasks 内の taskList 構築で `assignedAt: taskState[t.id]?.assignedAt` を設定。

### 3. ダッシュボードの timeInfo 表示を変更

**dashboard.tsx** の buildTaskRow 内の timeInfo ロジックを以下に変更:

| タスク状態 | 表示内容 | 例 |
|-----------|---------|-----|
| draft / ready / blocked | 作成時間（HH:MM形式） | `14:30` |
| running（assigned） | 開始時間 + 経過時間 | `14:30 (2h35m)` |
| closed | 完了時刻 + 総実行時間 | `16:05 (1h35m)` |
| aborted | 中止時刻 + 実行時間 | `15:00 (30m)` |

**経過時間のフォーマット（compactElapsed）**:
- 1分未満: `<1m`
- 1分〜59分: `5m`, `45m`
- 1時間以上: `1h`, `1h5m`, `2h35m`

**実装詳細**:
- running の経過時間は assignedAt からの差分
- closed の総実行時間は assignedAt → closedAt の差分（assignedAt がない場合は createdAt → closedAt）
- aborted の実行時間は assignedAt → abortedAt の差分
- 時刻表示は既存の `utcToLocal().slice(0, 5)` で HH:MM

### 4. 既存の formatElapsed は他で使っている可能性があるので削除しない

## 対象ファイル

- `skills/cmux-team/manager/task.ts` — TaskState に assignedAt 追加
- `skills/cmux-team/manager/daemon.ts` — TaskSummary に assignedAt 追加 + assign 時の記録 + taskList 構築
- `skills/cmux-team/manager/dashboard.tsx` — buildTaskRow の timeInfo 表示ロジック変更 + compactElapsed 関数追加
