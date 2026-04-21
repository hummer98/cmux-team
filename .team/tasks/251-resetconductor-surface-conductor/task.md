---
id: 251
title: resetConductor で surface 実在確認を行い、幽霊 Conductor を防ぐ
priority: high
created_by: surface:47
created_at: 2026-04-17T18:25:52.723Z
---

## 背景

A015 の実装タスク (b) Surface 二重起動 / 幽霊 Conductor 対策。

現状 `resetConductor` (`conductor.ts:502`) は PID 生存やタブ存在を確認せず `conductor.status = targetStatus` に遷移させるだけ。結果、pane が既に消失しているのに idle として map に残り続ける「幽霊 Conductor」が発生する。

直近の事例: surface 112/113 が pid=null, status=idle で team.json に滞留。daemon 再起動でのみ掃除される状態。

なお、broken 状態は T250 で既に導入済み（`opts.targetStatus: "idle" | "broken"`）。本タスクでは既存の broken 経路を流用する。

## やること

1. `resetConductor` の冒頭で surface 実在確認を行う（`cmux.validateSurface(surface, state.workspace)` 使用）
2. surface が存在しない場合は A015 方針に従い **broken 状態に倒す**（idle で握りつぶさずエラー痕跡を残す）
   - `opts.targetStatus: "broken"` 経路で cleanup + status 遷移（T250 既存機能）
   - `state.conductors.delete(surface)` はしない（UI での可視化を維持）
3. ログは既存の `conductor_broken` に `reason=surface_missing` を追加
4. 並行して、idle Conductor にも低頻度で surface 存在確認を入れるか検討
   - tick() 毎は過剰。`forceCloseDisconnectedConductor` のようなタイムアウト駆動が候補
   - ただし T255 で initializeLayout 側の検出が入るため、本タスクは reset 時一発確認に絞って良い

## 判断が必要なポイント

- 既に broken 状態の Conductor に対して再度 `resetConductor({targetStatus:"broken"})` が呼ばれた場合の idempotency
- idle 遷移時の surface 欠損はレアケース（通常は cleanup 中の tree 呼び出しで検出される）→ ログのみか broken に倒すか

## 参考

- A015 「現状コードの逸脱箇所インデックス」(b) 項
- `conductor.ts:502` resetConductor（broken 経路は T250 で導入済）
- 関連: T255（initializeLayout 単純化、旧 T252 を吸収）
- 本タスク完了後: T254（Task unique 制約）が broken 経路を利用する
