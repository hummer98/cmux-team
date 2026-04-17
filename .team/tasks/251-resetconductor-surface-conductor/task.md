---
id: 251
title: resetConductor で surface 実在確認を行い、幽霊 Conductor を防ぐ
priority: high
created_by: surface:47
created_at: 2026-04-17T18:25:52.723Z
---

## タスク
## 背景

A015 の実装タスク (b) Surface 二重起動 / 幽霊 Conductor 対策。

現状 `resetConductor` (`conductor.ts:533`) は `conductor.status = "idle"` に
戻すだけで、surface が実在するかの確認をしない。結果、pane が既に消失している
のに idle として map に残り続ける「幽霊 Conductor」が発生する。

直近の事例: surface 112/113 が pid=null, status=idle で team.json に滞留。
daemon 再起動でのみ掃除される状態。

## やること

1. `resetConductor` の冒頭で surface 実在確認を行う
   (`cmux.validateSurface(surface, workspace)` 使用)
2. surface が存在しない場合は idle に戻さず `state.conductors.delete(surface)`
   で map から除去する
3. ログを `conductor_removed reason=surface_missing` のように明示
4. 並行して、idle Conductor にも低頻度で surface 存在確認を入れるか検討
   （tick() での監視対象拡張、または reset 時一発確認で十分か判断）

## 判断が必要なポイント

- broken 状態（別タスクで導入予定）との優先順位:
  surface 消失は broken に倒すべきか、即 delete すべきか
- idle Conductor への定期確認を入れる場合の間隔（tick 毎は過剰）
- 新規 Conductor pane 作成で埋めるかどうか
  （layout slot 数を維持する必要があるか）

## 参考

- A015 「現状コードの逸脱箇所インデックス」(b) 項
- `conductor.ts:533` resetConductor
