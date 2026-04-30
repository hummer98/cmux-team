---
id: 374
title: pool capacity を 7d forecast ゲージ + next 候補 5h に再設計（A024）
priority: high
created_at: 2026-04-28T11:52:52.012Z
---

## タスク
## 背景

A024（`.team/artifacts/A024-pool-capacity-7d-forecast-gauge.md`）参照。
現状の pool capacity 表示 `5h NN% / 7d NN%`（A019）は以下の違和感がある:

1. % の意味が不明瞭（100% 超え得る / 流量比率なので残量感覚と乖離）
2. 5h / 7d 二値表示の判断負荷
3. 「次に何ができるか」が読みにくい

## 設計（A024 §計算式 / §TUI 表示）

ヘッダー 1 行に集約:

```
pool 7d  ██▇▅▅▆█   next: @kddi 5h:65%
```

- **7d**: 今後 7 日の forecast（時間単位 rate 積分）。Day 0 = 残時間のみ
- **next**: spawn-agent で次に割り当てられる候補アカウントの util_5h（lease は取らない peek）

詳細式・検証ケース・エッジケース・色閾値はすべて A024 に記載済み。

## 実装スコープ

1. `forecast.ts`（新規、`skills/cmux-team/manager/`）
   - 純関数 `computePool7dForecast(tokens: TokenForCapacity[], nowIso): { bars: number[7] }`
   - rate 関数・bin 切り出し・bin 内積分・正規化
   - テスト: A024 §検証ケース 1 / 2 をそのまま回帰テストに

2. `pool-summary.ts` 拡張
   - `PoolSummary` 型に `forecast7d: number[7]` を追加
   - `buildPoolSummary` で `computePool7dForecast` を呼ぶ

3. `selectToken` peek API（既存関数の lease を取らない dry-run 版）
   - `peekNextToken(db, projectTags): { handle: string, util_5h: number | null } | null`
   - 既存の selection ロジックから lease 取得部分を分離

4. ヘッダー表示
   - `pool-status-header.ts::buildPoolHeaderLines`: スパークラインに置換
   - `pool-header-display.ts::buildPoolHeaderDisplay`: Ink 用 RateLimitPart に置換
   - スパークライン文字マッピング・色閾値は A024 §TUI 表示

5. 既存の以下を整理
   - `computePoolCapacity` の `capacity_5h_pct` / `capacity_7d_pct` は廃止（per_token cap 部分は当面残す可）
   - `pool-next-reset.ts::computeNextReset`: forecast から自然に読めるので削除候補（最初は残して別タスクで判断）
   - per-surface decoration `<5h:X%/7d:Y%> cap:Z%` は削除

6. ドキュメント更新
   - `docs/spec/09-token-pool.md` の表示仕様セクション
   - README / README.ja の該当スクリーンショット・例示
   - CHANGELOG

## 受け入れ基準

- A024 §検証ケース 1 / 2 のテストが通る
- `cmux-team status` ヘッダーに `pool 7d <spark>   next: @handle 5h:NN%` が出る
- pool 機能 OFF / 全 blocked / 候補なし / snapshot 待ちの 4 エッジケースが A024 通り表示される
- 既存の pool 関連テスト（pool-summary / pool-status-header / pool-header-display / pool-next-reset）を更新済み

## 非スコープ（別タスク）

- per-handle decoration の代替表示（必要なら別タスクで `cmux-team pool status` を拡張）
- 5h forecast 化（本リリースでは行わない）
- ETA 予測（A019 で明示的に避けた方針を継続）
