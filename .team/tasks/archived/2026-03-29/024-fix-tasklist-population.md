---
id: 024
title: TUI Tasks セクションにデータが表示されないバグ修正
priority: high
status: ready
created_at: 2026-03-28T00:10:00+09:00
---

## タスク

`DaemonState.taskList` が初期化時の空配列のまま更新されず、TUI の Tasks セクションに何も表示されないバグを修正する。

### 原因

`daemon.ts` の `scanTasks()` で `state.openTasks`（数値）は更新しているが、`state.taskList`（詳細リスト）にデータを投入していない。

### 修正内容

`scanTasks()` 内で `loadTasks()` の結果から `state.taskList` を構築する:

```typescript
state.taskList = open.map((task) => ({
  id: task.id,
  title: task.title,
  status: task.status,
  isTodo: task.file.endsWith("-todo.md"),
  createdAt: task.createdAt,
}));
```

`loadTasks()` の返すタスクオブジェクトに `title`, `status`, `createdAt`, `file` が含まれているか確認し、不足していれば `task.ts` 側も修正する。

## 対象ファイル

- `skills/cmux-team/manager/daemon.ts` — `scanTasks()` に `state.taskList` 更新を追加
- `skills/cmux-team/manager/task.ts` — 必要に応じてタスク読み取り時に title/status/createdAt を返すよう修正

## 完了条件

- TUI の Tasks セクションに open タスクが一覧表示される
- タスクの id, title, status が正しく表示される
- TODO 由来のタスクが `TODO:` プレフィックス付きで表示される
- タスクがない場合は `no open tasks` と表示される
