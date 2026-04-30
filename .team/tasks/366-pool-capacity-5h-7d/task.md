---
id: 366
title: pool capacity を 5h / 7d 別表示に変更
priority: medium
created_at: 2026-04-27T06:17:11.253Z
---

## タスク
## Context

現状 pool capacity はトークンごとに `min(5h候補, 7d候補)` を取って合計した単一数値（例: 352%）で表示されているが、5h ウィンドウと 7d ウィンドウのボトルネックがどちらか分からない。

## 変更内容

`computePoolCapacity` を 5h / 7d 別に合計を計算するよう変更し、以下の形式で表示する:

- TUI ヘッダー（pool-header-display.ts）: `pool capacity: 5h 120% / 7d 80%`
- CLI status（pool-status-header.ts）: 同様の形式
- 色分けは `min(5h, 7d)` をベースに既存閾値（>=100% GREEN / >=40% YELLOW / <40% RED）を維持

## 変更ファイル

- `token-store.ts`: `PoolCapacityResult` に `capacity_5h_pct` / `capacity_7d_pct` を追加
- `pool-status-header.ts`: `PoolHeaderInput.capacityPct` → `capacity5hPct` + `capacity7dPct`
- `pool-summary.ts`: header 構築を新型に変更
- `dashboard.tsx`: `buildPoolHeader` の色分けを `min(5h, 7d)` ベースに
- `pool-header-display.ts`: TUI ヘッダー表示を更新
- テスト: `pool-status-header.test.ts` を新型に合わせて更新
