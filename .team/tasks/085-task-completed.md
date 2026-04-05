---
id: 085
title: task_completed 二重記録の原因調査・修正
priority: high
created_at: 2026-04-05T15:49:26.455Z
---

## タスク
## 問題

Manager が task_completed イベントを二重に記録している。

### 再現パターン（manager.log より）

```
[2026-04-05T12:45:47] task_completed task_id=082 surface=surface:490 title=...  ← 正常
[2026-04-05T12:47:12] task_completed task_id=undefined surface=surface:490       ← 異常（二重記録）
```

1回目は正常（done マーカー検出時）、2回目は Conductor リセット後に taskId がクリアされた状態で再度完了検出が走っている。

### 調査ポイント

- `conductor.ts` の完了検出ロジック（done マーカー検出 → リセット → 再検出のフロー）
- taskId クリアのタイミングと完了ログ記録のタイミングの競合
- `daemon.ts` の tick ループで同じ Conductor に対して二重に completedTask 処理が走る条件

### ゴール

- task_completed が1タスクにつき1回だけ記録されるようにする
- 根本原因を特定し修正する
