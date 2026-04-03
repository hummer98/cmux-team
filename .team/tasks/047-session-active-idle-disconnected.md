---
id: 047
title: SESSION_ACTIVE/IDLEでdisconnectedから復帰させる
priority: high
created_at: 2026-04-03T00:47:16.579Z
---

## タスク
## 概要
disconnected 状態の Conductor が SESSION_ACTIVE や SESSION_IDLE イベントを受信しても status が変わらないバグを修正する。

## 現状の問題
- SESSION_ACTIVE / SESSION_IDLE ハンドラは `disconnectedAt` をクリアするが `status` を変更しない
- セッションが生きている（= イベントが来ている）のに `disconnected` のままでタスク割り当てされない

## 修正方針
daemon.ts の SESSION_ACTIVE / SESSION_IDLE ハンドラで、`conductor.status === 'disconnected'` の場合に復帰させる:
- `SESSION_ACTIVE` → `status = 'running'`（アクティブなセッションなので）
- `SESSION_IDLE` → `status = 'idle'`（idle に復帰、タスク割り当て可能に）
- 復帰時にログ記録（`conductor_recovered`）

## 対象ファイル
- `skills/cmux-team/manager/daemon.ts` — SESSION_ACTIVE / SESSION_IDLE ハンドラの修正
