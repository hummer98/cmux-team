---
id: 309
title: Metrics タブから重複する「統合（5h/7d）」セクションを削除
priority: medium
created_by: surface:969
created_at: 2026-04-24T08:17:22.235Z
---

## タスク
## 背景

Metrics タブの「統合（5時間 / 7日）」セクション（`dashboard-metrics.ts:317-331`）は、ヘッダー右端の `buildRateLimitDisplay`（`rate-limit-display.ts`）が出している `5h: 45% ██████░░░░ 2h3m` / `7d: 20% ██░░░░░░░░ 5d` と情報が重複している。しかも Metrics 側はパーセントのみで、バー・reset 時間・stale 判定が落ちた**劣化表示**になっている。

Metrics タブの本質はヘッダーに載せきれない detail（burn rate・role/task 別消費）なので、このセクションは削除する。

## 変更対象

1. **`skills/cmux-team/manager/dashboard-metrics.ts`**
   - L317-331 の unified セクション描画ブロックを削除
   - `MetricsData` interface の `unifiedFive` / `unifiedSeven` / 関連 JSDoc（L49-52）を削除

2. **`skills/cmux-team/manager/dashboard.tsx`**
   - L1830-1831 および L1871-1872 の `unifiedFive` / `unifiedSeven` の代入を削除

3. **`skills/cmux-team/manager/i18n.ts`**
   - `metrics_section_unified` キーを en（L786）/ ja（L1569）両方から削除

4. **`skills/cmux-team/manager/dashboard-metrics.test.tsx`**
   - テストフィクスチャから `unifiedFive: 0.4,` / `unifiedSeven: 0.2,`（L40-41）を削除
   - 他に assertion で unified 文言を参照していないか確認（現状 grep では該当なし）

## 受け入れ条件

- `bun test` が通る（既存テスト含む）
- `bun run typecheck`（または相当）が通る
- dashboard 起動後、Metrics タブに「統合」セクションが表示されないこと
- ヘッダーの `5h:` / `7d:` 表示は従来通り出ること

## 補足

- `daemon.rateLimit` 本体の `unified5hUtilization` / `unified7dUtilization` フィールドはヘッダーと throttle 判定で使用されているため**触らない**
- 削除する「統合」セクションは Metrics タブ UI の劣化ビューのみ
