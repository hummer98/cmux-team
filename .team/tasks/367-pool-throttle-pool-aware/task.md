---
id: 367
title: pool有効時のTHROTTLE判定をpool-awareに変更
priority: medium
created_at: 2026-04-27T06:45:24.189Z
---

## タスク
## 問題

pool有効時でも THROTTLE 判定が `state.rateLimit`（最後のAPIレスポンスで観測した単一アカウントの5h utilization）を参照しているため、pool全体に余裕があっても1アカウントの5hが90%を超えると THROTTLED になってしまう。

## 影響箇所

- `spawn-agent` throttle ガード（main.ts: /rate-limit エンドポイント問い合わせ）
- `scanTasks` throttle ガード（daemon.ts: state.rateLimit 参照）
- dashboard/statusline の ⏸ 表示（daemon.ts）

## 変更方針（案）

pool が有効な場合、THROTTLE 判定に `state.rateLimit` ではなく pool の状態（tokens.db の各アカウントの utilization）を使う:

- pool 内に selectable かつ 5h utilization < 90% のアカウントが1つ以上あれば THROTTLED にしない
- pool が無効な場合は従来通り `state.rateLimit` の5h utilization >= 90% で判定

`/rate-limit` エンドポイントのレスポンスにも pool-aware な `throttled` 値を返す。
