---
id: 106
title: close-task に CONDUCTOR_DONE メッセージ送信を追加
priority: high
created_at: 2026-04-07T09:17:45.064Z
---

## タスク
## バグ概要

`cmux-team close-task` 実行後、Manager に CONDUCTOR_DONE メッセージが送信されないため、Conductor が running のまま stuck する。

KDG-SHOWCASE プロジェクトで実際に発生。T004 が closed なのに Conductor-1 が running のまま解放されなかった。

## 原因

`cmdCloseTask()`（main.ts:1389-1436）に CONDUCTOR_DONE メッセージ送信が欠落している。
`cmdAbortTask()` には実装されている（main.ts:1536-1543）のに close-task にはない。

## 修正内容

`cmdCloseTask()` の `saveTaskState` 後に CONDUCTOR_DONE メッセージを送信する。abort-task の実装（L1536-1543）を参考に:

```typescript
// close-task 完了時に daemon へ通知
await postMessage({
  type: 'CONDUCTOR_DONE',
  surface: conductor.surface,
  success: true,
  timestamp: new Date().toISOString(),
});
```

Conductor surface の特定は team.json から taskId で逆引きする（abort-task と同様のロジック）。

## 対象ファイル

- skills/cmux-team/manager/main.ts（cmdCloseTask 関数）
