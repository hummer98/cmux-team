# T374 Summary — pool capacity を 7d forecast ゲージ + next 候補 5h に再設計（A024）

## 完了したサブタスク

- forecast.ts (純関数 `computePool7dForecast`) を新設、A024 §計算式を実装
- forecast.test.ts に A024 §検証ケース 1 / 2 + エッジケース + DST safety + 境界 reset off-by-one テストを追加
- token-store.ts に `peekNextToken` を追加（lease を取らない dry-run）、`admitCandidates` の戻り値を拡張（effUtil5h / effUtil7d / hasSnapshot）
- pool-summary.ts: `forecast7d` / `nextCandidate` を PoolSummary に追加し、`header` フィールドを撤去
- pool-status-header.ts / pool-header-display.ts: スパークライン + next 候補表示に書き換え
- per-surface decoration（`<5h:X%/7d:Y%> cap:Z%` および @handle 表示）削除（pool-surface-row.ts / dashboard.tsx::buildPoolHeader）
- ドキュメント更新: docs/spec/09-token-pool.md / README.md / README.ja.md / CHANGELOG.md
- A024 artifact に脚注追加（T373 admit との整合）

## 変更ファイル一覧

### 新規（2 ファイル）
- skills/cmux-team/manager/forecast.ts
- skills/cmux-team/manager/forecast.test.ts

### 変更（17 ファイル）
- skills/cmux-team/manager/token-store.ts / token-store.test.ts
- skills/cmux-team/manager/pool-summary.ts / pool-summary.test.ts
- skills/cmux-team/manager/pool-status-header.ts / pool-status-header.test.ts
- skills/cmux-team/manager/pool-header-display.ts / pool-header-display.test.ts
- skills/cmux-team/manager/dashboard.tsx
- skills/cmux-team/manager/dashboard-pool.test.tsx
- skills/cmux-team/manager/dashboard-conductor.test.tsx
- skills/cmux-team/manager/main.ts
- skills/cmux-team/manager/daemon.ts
- docs/spec/09-token-pool.md
- README.md / README.ja.md
- CHANGELOG.md
- .team/artifacts/A024-pool-capacity-7d-forecast-gauge.md

### 削除（2 ファイル）
- skills/cmux-team/manager/pool-surface-row.ts
- skills/cmux-team/manager/pool-surface-row.test.ts

## テスト結果（Inspector 検証ログ）

| ファイル | 結果 |
|---|---|
| forecast.test.ts | 16 pass / 0 fail |
| pool-summary.test.ts | 12 pass / 0 fail |
| pool-status-header.test.ts | 30 pass / 0 fail |
| pool-header-display.test.ts | 13 pass / 0 fail |
| pool-cli.test.ts | 3 pass / 0 fail |
| pool-throttle.test.ts | 25 pass / 0 fail |
| pool-next-reset.test.ts | 8 pass / 0 fail |
| token-store.test.ts | 128 pass / 1 skip / 0 fail |
| dashboard-pool.test.tsx | 2 pass / 0 fail |
| dashboard-conductor.test.tsx | 6 pass / 0 fail |
| **合計** | **243 pass / 1 skip / 0 fail** |

`bunx tsc --noEmit` clean。

## 検証ケース 1 / 2 実測値（許容誤差 ±1）

| ケース | 期待 | 実測 | 最大誤差 |
|---|---|---|---|
| Case 1 (now=00:00 UTC, Day 0=24h full) | [108,108,71,71,71,100,100] | [108.500, 108.500, 71.000, 71.000, 71.000, 100.000, 100.000] | 0.5 |
| Case 2 (now=18:00 UTC, Day 0=6h, bin straddle) | [126,126,94,71,71,78,100] | [126.000, 126.000, 93.917, 71.000, 71.000, 78.250, 100.000] | 0.250 |

## 設計判断

- **Phase 順序「拡張 → 切替 → 削除」**: design-review v1 R1 を反映。各 Phase 末で `bunx tsc --noEmit` が clean に保たれる
- **TZ 注入の純関数化**: design-review v1 R3 を反映。`buildBinRanges(nowIso, timezone)` で `Intl.DateTimeFormat` を使用し、test では `tz="UTC"` / `"America/New_York"` を直接注入
- **A024 artifact 更新方針 (R2)**: 選択肢 A（artifact update）を採用、§next 候補の選定 の「非 stale」に脚注を追加し T373 admit 救済と整合
- **PeekedToken の拡張**: `{handle, util_5h, util_7d}` で将来の表示拡張余地を確保（admitCandidates が effUtil7d を持つので extra cost ゼロ）
- **Phase 4 で dashboard.tsx::buildPoolHeader を最小限新 API 化、Phase 5 で完全削除**: tsc clean を中間 Phase で維持するための 2 段階分割（plan §9 の "Phase 5 で削除" を厳密化）

## 残課題（本タスク非スコープ、Inspector も spec 通り認定）

1. `pool-next-reset.ts` 残置 — 別タスクで「補足表示として残す or 削除」判断
2. `computePoolCapacity` の集計値（`capacity_5h_pct` / `capacity_7d_pct`）残置 — `pool-cli.ts` / `token-cli.ts` の per-token 表示で `per_token.cap_pct` を使うため。dead value 化のクリーンアップは別タスク
3. DST 24h 仮定（Day 1..6 は固定 24h、DST 跨ぎ日に物理 23/25h でも bin 端ズレは A024 §エッジケース対象外、許容誤差 ±1%）
4. `bun test` 全体実行は引き続き禁忌（CLAUDE.md ガード）

## マージコミット / PR URL

（commit 後に追記）

**Merge commit**: 2168a2ad5e682de11c1d922122b6fa4a66c33804 (main にローカル ff-only マージ)
