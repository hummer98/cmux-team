# T377 implementation summary

## 変更ファイルと差分概要

- `skills/cmux-team/manager/dashboard-metrics.ts`
  - `buildPoolTokensSection` 内で各 token の 5h / 7d bar を事前計算する `computed` 配列を導入
  - 列ごとの最大 gray part 幅を算出するヘルパー `maxGrayPartLen` を追加
  - gray part のみ `padStart(maxLen)` で揃えるヘルパー `padGrayParts` を追加
  - `RateLimitPart` 型を `rate-limit-display` から import（type-only）
  - `buildUtilizationBar` / `formatResetRemaining` のシグネチャは変更なし
- `skills/cmux-team/manager/dashboard-metrics.test.tsx`
  - 新 describe block `buildMetricsRows: Pool Tokens reset alignment (T377)` を追加（4 ケース）

## 追加したテストケースと結果

| # | ケース | 結果 |
|---|---|---|
| 1 | 複数 token で 5h reset 桁が異なる場合 → 5h 列が padStart で揃う（"5m" → "   5m"、"1h30m" はそのまま） | pass |
| 2 | 複数 token で 7d 列も padStart で揃う（"1d" → " 1d"、"12h" はそのまま） | pass |
| 3 | hasSnapshot=false 混在時、snapshot 有り行の時刻列が揃う（hasSnapshot=false 行はパディング計算から除外） | pass |
| 4 | 1 token のみでパディング 0（従来挙動：単独 token は padStart(2)=no-op、"5m" のまま） | pass |

既存テスト（26 件）も全て pass を維持。最終: 30 pass / 0 fail / 52 expect()。

## tsc 結果

```
$ cd skills/cmux-team/manager && bunx tsc --noEmit
exit=0
```

新規エラーゼロ。`noUncheckedIndexedAccess: true` 環境でも型安全に通る。

## スナップショットの更新有無

スナップショットテストは存在しないため更新なし（テストは JSON.stringify → toContain パターン）。

## 想定外の判断・回避した落とし穴

- **noUncheckedIndexedAccess 対応**: 当初は parallel な `bars5h` / `bars7d` 配列 + `for (let i = 0; i < poolTokens.length; i++)` の index ループで実装したが、tsc が `poolTokens[i]` を `PoolTokenRow | undefined` と推論してエラー。`{ row, bar5h, bar7d }` を 1 オブジェクトにまとめた `computed` 配列を `for (const c of computed)` で反復する形に変更し、index アクセス自体を排除した。
- **gray 以外の part を誤って pad しない**: `buildUtilizationBar` の最初の part（bar 本体、color: green/yellow/red）は触らず、`color === "gray"` の part のみ `padStart` する。`partsToUiText` への入力 part 形状は変えていないため、ui.text への mapping は従来通り。
- **bar 自体の幅は触らない**: 「`5h: 86% ████████░`」部分は `buildUtilizationBar` が既に `padStart(3)` で % 桁を揃えており、本タスクのスコープ外。今回は gray reset 列のみを揃える変更に閉じている。
- **単独 token ケース**: 最大幅 = その 1 行の text 長 = `padStart` 引数と一致 → no-op。テストで `'"5m"'` の存在と `"   5m"` の不在を両方確認することで保証した。
