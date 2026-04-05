---
id: 086
title: task_completed 二重記録の原因調査・修正
priority: high
created_at: 2026-04-05T15:49:53.121Z
---

## タスク
## 問題

Manager が task_completed イベントを二重記録している。

### 再現パターン（manager.log より）

```
[2026-04-05T12:45:47+09:00] task_completed task_id=082 surface=surface:490 title=...  ← 正常
[2026-04-05T12:47:12+09:00] task_completed task_id=undefined surface=surface:490      ← 異常（二重）
```

正常な task_completed（done マーカー検出時）の後、Conductor リセット後に再度完了チェックが走り、taskId が既にクリアされた状態で 2回目の task_completed が記録される。

### 調査対象

- `skills/cmux-team/manager/conductor.ts` — done マーカー検出 → task_completed 記録 → Conductor リセットのフロー
- `skills/cmux-team/manager/daemon.ts` — tick() 内の完了チェックロジック

### 期待する修正

- taskId クリア後に task_completed が再記録されないようにする
- 根本原因を特定してログにコメントを残す
