---
id: 368
title: cleanup: pool-header-display.test.ts の Object possibly undefined 18 件
priority: medium
created_by: surface:233
created_at: 2026-04-27T06:53:54.595Z
---

## タスク
## 発見経緯

T354 (Metrics タブ書き換え) の plan §6.2 で「out-of-scope な既存型エラー」として分離した cleanup タスク。T354 のスコープ内ファイル (dashboard.tsx / dashboard-metrics.ts / rate-limit-display.ts / trace-store.ts / proxy.ts / config.ts) には型エラーが無く、本件は完全に独立している。

## 対象

- ファイル: `skills/cmux-team/manager/pool-header-display.test.ts`
- エラー: 18 件全て `TS2532: Object is possibly 'undefined'`
- 行: 33, 34, 39, 44, 49, 54, 59, 71-76, 88, 98, 110, 115, 135

## 方針

各 `tokens[N]` / `parts[N]` 直後に `?` を挿入するか、テストの fixture 配列を `as const` で固定長 tuple 化して non-null 推論を効かせる。テストの assertion ロジックには影響しない。

## スコープ

- 修正対象: `pool-header-display.test.ts` のみ
- 関連実装の変更不要
