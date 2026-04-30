# T374 実装サマリー — pool capacity を 7d forecast ゲージ + next 候補 5h に再設計（A024）

## 変更ファイル一覧

### 新規

| ファイル | 概要 |
|---|---|
| `skills/cmux-team/manager/forecast.ts` | `computePool7dForecast(tokens, nowIso, timezone?)` 純関数（A024 §計算式） |
| `skills/cmux-team/manager/forecast.test.ts` | A024 §検証ケース 1 / 2 + エッジケース + 境界 reset off-by-one + DST safety |

### 変更

| ファイル | 概要 |
|---|---|
| `skills/cmux-team/manager/token-store.ts` | `peekNextToken` 追加 / `admitCandidates` 戻り値に `effUtil5h` / `effUtil7d` / `hasSnapshot` 追加 / `PeekedToken` export |
| `skills/cmux-team/manager/token-store.test.ts` | `peekNextToken` のケース 7 件追加 |
| `skills/cmux-team/manager/pool-summary.ts` | 旧 `header` 撤去・`forecast7d` / `nextCandidate` 追加・`policy` 引数追加・`buildSelectTokenPolicy` を `loadPoolSummary` で呼び出し |
| `skills/cmux-team/manager/pool-summary.test.ts` | case A-D を forecast/perHandle 検証に書き換え + T374 ケース 4 件追加 |
| `skills/cmux-team/manager/pool-status-header.ts` | スパークライン表示に全面書き換え（`mapBarToSparkline` / `pickSparklineColor` / `pickNextUtilColor` export） |
| `skills/cmux-team/manager/pool-status-header.test.ts` | 旧ボックス形式テスト全削除、新仕様 30 ケース（境界値 test.each 含む） |
| `skills/cmux-team/manager/pool-header-display.ts` | Ink 用 RateLimitPart を新仕様で書き換え |
| `skills/cmux-team/manager/pool-header-display.test.ts` | 13 ケースに置換、CLI ↔ TUI cross-validate 追加 |
| `skills/cmux-team/manager/dashboard.tsx` | legacy `buildPoolHeader` 削除、`buildPoolSuffixForSurface` / `buildConductorRowWithPool` 撤去、`buildConductorRow` を統合・per-surface decoration 削除 |
| `skills/cmux-team/manager/main.ts` | `formatSurfaceRow` import 削除、`lookupPool` / per-surface decoration 削除、新 `buildPoolHeaderLines` 入力に切り替え |
| `skills/cmux-team/manager/daemon.ts` | `buildPoolSummary(state.tokenDb, undefined, state.poolPolicy)` |
| `skills/cmux-team/manager/dashboard-pool.test.tsx` | 全面書き換え。per-surface / capacity 二値テスト撤去 |
| `skills/cmux-team/manager/dashboard-conductor.test.tsx` | T352 Agent 行 handle 表示テスト全削除（per-handle 撤去に伴い） |
| `docs/spec/09-token-pool.md` | §pool_capacity 指標を §7d Forecast ゲージ + next 候補 に置換 |
| `README.md` / `README.ja.md` | ヘッダー説明を新仕様に更新 |
| `CHANGELOG.md` | `[Unreleased]` セクション追加 |
| `.team/artifacts/A024-pool-capacity-7d-forecast-gauge.md` | §next 候補の選定 の「非 stale」に脚注追加（R2） |

### 削除

| ファイル | 理由 |
|---|---|
| `skills/cmux-team/manager/pool-surface-row.ts` | per-surface decoration 撤去 |
| `skills/cmux-team/manager/pool-surface-row.test.ts` | 上記に伴う |

## 各 Phase の実施結果

| Phase | テスト | tsc |
|---|---|---|
| Phase 0 (baseline) | pool-summary 7 / pool-status-header 8 / pool-header-display 11 / pool-next-reset 8 / pool-surface-row 12 / token-store 120+1skip 全 pass | n/a |
| Phase 1 (forecast.ts) | forecast.test.ts 16 / 16 pass | clean |
| Phase 2 (peekNextToken) | token-store.test.ts 128 + 1 skip pass | clean |
| Phase 3 (pool-summary 拡張 / header 残置) | pool-summary 12 pass / 既存型 stub 経由で他テストも維持 | clean |
| Phase 4 (pool-status-header 書き換え) | pool-status-header 30 pass | clean |
| Phase 5 (pool-header-display 書き換え + dashboard.tsx legacy 削除) | pool-header-display 13 pass | clean |
| Phase 5.5 (PoolSummary.header 削除) | pool-summary 12 pass | clean |
| Phase 6 (per-surface decoration 削除) | dashboard-pool 2 / dashboard-conductor 6 pass | clean |
| Phase 7-8 (統合テスト) | forecast / token-store / pool-summary / pool-status-header / pool-header-display / pool-cli / pool-throttle / pool-next-reset / dashboard-pool / dashboard-conductor / token-cli / daemon / dashboard-metrics / dashboard-issues / dashboard-scroll / state-machine 全 pass | clean |
| Phase 9 (docs) | ― | clean |

## 設計判断（plan からの逸脱）

### 1. dashboard.tsx::buildPoolHeader を Phase 4 ではなく Phase 5 で削除

plan §9 Phase 5 step 2 で "削除" と明示されていたが、Phase 4 の tsc clean 維持のため Phase 4 で「最小限新 API 化」→ Phase 5 で完全削除という 2 段階に分けた。dashboard-pool.test.tsx の `buildPoolHeader` テスト群も Phase 5 / 6 の 2 段階で撤去。Plan の意図（拡張 → 切替 → 削除の R1 原則）からは逸脱なし。

### 2. main.ts の per-surface handle 表示も完全撤去

Plan §6.2 の例示では per-surface decoration 全体を削除する方針（`@pers <5h:10%/7d:30%> cap:100%` を例として一括撤去）。当初は handle のみ残す案も検討したが、`cmux-team token list` / `pool status` で確認できるため「徹底的にヘッダー集約」する A024 方針を尊重し、`main.ts` / `dashboard.tsx` 双方で handle 表示も削除した。

### 3. PeekedToken.util_5h の null 判定基準

plan §2.1 では「snapshot 不在時 null」と記述。実装では `admitCandidates` に `hasSnapshot: snap !== null` を持たせ、peekNextToken で `hasSnapshot ? effUtil5h : null` を返す形に。`snap.util_5h` が個別に null だが snap 自体は存在する場合は `effUtil5h=0` を返す（plan の literal 仕様通り）。

### 4. R3 (TZ 注入) の実装は plan §1.4 通り

`buildBinRanges(nowIso, timezone)` を純関数化、`Intl.DateTimeFormat({ timeZone, hourCycle: "h23" })` で指定 TZ の time-of-day を取得。test では `"UTC"` / `"America/New_York"` を直接注入。`process.env.TZ` 操作不要。

### 5. R2 (A024 脚注追加) の脚注スタイル

plan §8.4 で提示された脚注本文をそのまま採用し、Markdown footnote (`[^stale-rescue]`) で artifact §next 候補の選定 内にインライン参照を追加。

### 6. N1 / N2 / N3 の対応

- N1 (`[87.5, "▆"]` typo): forecast.test.ts ではなく pool-status-header.test.ts §7.4 の問題。実装時に `[87.5, "▇"]` で書いて pass を確認
- N2 (`buildSelectTokenPolicy` の sync/async): grep で `export async function buildSelectTokenPolicy` を確認、`await` を維持
- N3 (dashboard.tsx 未使用 import): Phase 5 完了時に `buildPoolHeaderLines` import を削除、Phase 6 で `PerHandleSummary` import 削除

## 検証ケース 1 / 2 の bar 配列実測値（許容誤差 ±1）

| ケース | 期待 | 実測 | 誤差 |
|---|---|---|---|
| Case 1 (now=00:00 UTC, Day 0=24h full) | `[108, 108, 71, 71, 71, 100, 100]` | `[108.500, 108.500, 71.000, 71.000, 71.000, 100.000, 100.000]` | 全要素 ≤ 0.5（A024 表は丸め値） |
| Case 2 (now=18:00 UTC, Day 0=6h, bin straddle) | `[126, 126, 94, 71, 71, 78, 100]` | `[126.000, 126.000, 93.917, 71.000, 71.000, 78.250, 100.000]` | Day 2: 0.083, Day 5: 0.250、他 0 |

両ケースとも plan §11 の許容誤差 ±1 内。境界 reset (Case 1 の token A: reset = 48h = Day 1 binEnd 一致) で off-by-one なし。

## 残課題・既知の制限

1. **`pool-next-reset.ts` は未削除**（plan §6.3 / §10.3 方針通り）。`pool-summary.ts` から import が消えたため dead code 化したが、tsconfig が `noUnusedLocals=false` のため tsc 警告なし。`pool-next-reset.test.ts` は引き続き pass。**別タスクで「補足表示として残す or 削除」を判断**。

2. **`computePoolCapacity` の 5h/7d 集計値 (`capacity_5h_pct` / `capacity_7d_pct`) も計算自体は残存**。`per_token cap_pct` が `pool-cli.ts` / `token-cli.ts` の per-token 表示で必要なため。`buildPoolSummary` 内で `forCap` を組み立てて `computePoolCapacity` を呼ぶ経路は維持し、集計値はレスポンスに含めるが UI で使わない（dead value）。次の cleanup で `computePoolCapacity` の戻り値型から `capacity_5h_pct` / `capacity_7d_pct` を取り除くなら別タスクで対応可能。

3. **DST 跨ぎ Day 1..6 の固定 24h 仮定**。plan §10.4 の通り、Day 1..6 は固定 24h で進めるため DST 切替日に物理的に 23h or 25h になっても bin 端ズレが発生する。許容誤差 ±1% 内（A024 §エッジケース対象外）。

4. **`bun test` 全体実行は依然禁忌**（CLAUDE.md ガード）。本タスクの検証は影響範囲を for ループで個別実行する方式。

## 受け入れ基準確認

- [x] A024 §検証ケース 1 / 2 のテストが通る（forecast.test.ts 16/16 pass）
- [x] スパークライン境界値テスト（mapBarToSparkline）が通る（pool-status-header.test.ts test.each 12 ケース pass）
- [x] DST safety テスト（buildBinRanges）が通る（forecast.test.ts America/New_York 春・秋シフトケース pass）
- [x] `cmux-team status` ヘッダーが新形式で出る（buildPoolHeaderLines + main.ts で `pool 7d <spark>   next: @handle 5h:NN%` を出力）
- [x] pool 機能 OFF / 全 blocked / 候補なし / snapshot 待ちの 4 エッジケース表示（pool-status-header.test.ts / pool-header-display.test.ts）
- [x] 既存の pool 関連テストすべて pass
- [x] `bunx tsc --noEmit` が clean（manager dir 内）
- [x] A024 artifact に脚注追加（R2 §next 候補の選定）
- [x] docs/spec/09-token-pool.md / README / README.ja / CHANGELOG が更新済み
