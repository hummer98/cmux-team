---
id: A003
type: research
title: "タスクステート管理の分析 — 設計 vs 実装の乖離"
created: 2026-04-04T13:00:00+09:00
updated: 2026-04-09T08:25:00+09:00
author: master
tags: [task, state-machine, bug]
---

## ステート図（設計 = 実装）

T061, T070, T077, T109, T110 の修正により、設計と実装が一致した。

```mermaid
stateDiagram-v2
    [*] --> draft : create-task (default)
    [*] --> ready : create-task --status ready

    draft --> ready : update-task --status ready

    ready --> assigned : assignTask() が task-state.json を更新
    assigned --> closed : close-task --journal "..."
    assigned --> aborted : abort-task [--journal "..."]

    ready --> closed : close-task (取り下げ)
    draft --> closed : close-task (取り下げ)
    draft --> deleted : delete-task
    ready --> deleted : delete-task

    note right of assigned
        SSOT: task-state.json が唯一の状態源
        assignedAt も記録
        daemon 再起動後も復元可能
    end note
```

## 修正済み問題一覧

### 問題 1: `assigned` ステータスへの遷移が存在しない → ✅ 修正済み (T110)

`daemon.ts:scanTasks()` 内で `assignTask()` 成功時に `task-state.json` を `assigned` + `assignedAt` に更新するようになった。

### 問題 2: `ensureQueueDirs` / `sendMessage` が未定義 → ✅ 修正済み (T070, T077)

queue.ts を削除し、全メッセージングを HTTP API (`POST /api/messages`) に移行。`ensureQueueDirs` / `sendMessage` の呼び出しは完全に除去された。

### 問題 3: `abort-task` が ready タスクに使えない → ✅ 修正済み (T061, T109)

`abort-task` コマンドを実装。assigned 状態のタスクを中止可能（PID kill・worktree 削除・Conductor 再起動）。journal オプション対応。draft/ready のタスクには `delete-task` を使用する設計。

### 問題 4: タスクステータスの情報源が二重化 → ✅ 修正済み (T110)

`task-state.json` が SSOT。`assignedAt` フィールドも追加され、daemon 再起動時に assigned タスクを正しく復元可能。
