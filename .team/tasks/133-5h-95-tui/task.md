---
id: 133
title: 5hレート制限95%超で新規タスク実行を一時停止＋TUI表示
priority: high
created_at: 2026-04-10T14:09:39.363Z
---

## タスク
## 背景

複数エージェント同時実行で5hレート制限に達することがある。95%を超えたら新規タスクの割り当てを一時停止し、リセット時刻を過ぎたら自動再開したい。7dリミットは今回対象外。

## 要件

### 1. scanTasks でのスロットリングガード

`daemon.ts` の `scanTasks()` で、タスク割り当てループの前に 5h utilization をチェック:

- `state.rateLimit?.unified5hUtilization >= 0.95` の場合、新規タスクの assignTask をスキップ
- ログ出力: `throttled_rate_limit` イベント（task_id、utilization、reset 時刻）
- **実行中の Conductor は止めない**（新規割り当てのみブロック）
- リセット時刻を過ぎたら（= 次の API レスポンスで utilization が下がったら）自動的に割り当て再開

### 2. TUI ヘッダーにスロットリング状態を表示

ヘッダー行の `RUNNING` / `STARTING` / `vX.Y.Z` 部分を書き換える方式:

- スロットリング中: `⏸ THROTTLED (5h: 95% → reset 2h34m)` を赤色で表示
- `headerParts` の生成ロジック（dashboard.tsx:833付近）にスロットリング判定を追加
- 通常のバージョン表示は省略してスロットリング情報を優先表示
- スロットリング解除時は通常のヘッダーに戻る

### 3. 閾値の定数化

- `THROTTLE_5H_THRESHOLD = 0.95` として daemon.ts の先頭付近に定義
- dashboard.tsx からも参照できるよう export する（schema.ts に置いてもよい）

## 実装上の注意

- proxy.ts の `state.rateLimit` は API レスポンスごとに更新される。ポーリング不要
- スロットリング中もメインループ（tick）は通常通り動作させる（Conductor 監視・完了検出は継続）
- 7d リミットは今回対象外。将来追加しやすい構造にはしておく
