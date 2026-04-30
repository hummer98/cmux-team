# T354 Implementation Report

worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-354-1777270522`
作成日: 2026-04-27

## Completed Tasks

| # | サブタスク | 状態 |
|---|-----------|------|
| S1  | trace-store: schema + insertRateLimitSnapshot | ✓ |
| S2  | proxy: snapshot INSERT 接続（streaming / 非 streaming 両経路）| ✓ |
| S3  | trace-store: getProjection5h / getProjection7d | ✓ |
| S4  | trace-store: aggregateApiUsageByRole の CASE 正規化 SQL | ✓ |
| S5  | config: metricsRefreshIntervalMs + resolveMetricsRefreshIntervalMs | ✓ |
| S6  | rate-limit-display: buildUtilizationBar export + padStart(3) | ✓ |
| S7  | dashboard-metrics: MetricsData 差替 + Rate Limit Projection 描画 | ✓ |
| S8  | dashboard-metrics: Pool Tokens セクション | ✓ |
| S9  | dashboard-metrics: ロール / タスク桁揃え + caption normalizeRole 適用 (F1) | ✓ |
| S10 | dashboard.tsx: metricsRefreshIntervalMs / projection / pool tokens 配線 | ✓ |
| S11 | dashboard.tsx: computeMetricsVisibleLines + Down キー clamp (F2) | ✓ |
| S12 | dashboard.tsx: Settings タブに metricsRefreshIntervalMs 行追加 | ✓ |
| S13 | i18n: 新キー追加（projection / pool tokens / long-term / recent 15m / before reset / no_selectable）+ 旧 rate limit 系キー削除 | ✓ |
| S14 | テスト更新 / 追加（dashboard-metrics / rate-limit-display / trace-store-projection / proxy-rate-limit-snapshot / config / dashboard-scroll）| ✓ |
| S15 | 統合動作確認（tsc / 個別 bun test）| ✓ |

design-review minor findings 全反映:

- F1: caption の role 正規化を `normalizeRole` 共通ヘルパで実装（trace-store.ts に export、SQL CASE と同ルール）
- F2: `computeMetricsVisibleLines(stdoutRows, envOverride)` を pure 関数として export、`RESERVED_LINES` const も export
- F3: dashboard-metrics.test.tsx の Pool Tokens 並び順テスト追加（util_5h DESC + 同 util handle ASC）
- F4: trace-store-projection.test.ts で role 集約 / config 反映のテストを担保（実環境動作は Inspector に委譲）
- F5: proxy.ts の `extractRateLimit` を 1 度だけ呼んで `rl{Streaming,NonStreaming}` を共有、INSERT は各 path 1 回
- F6: M / 6 キーは既に `switchTab("metrics")` 経由で `focusedArea: "metrics"` を設定済みのため修正 skip

## Files Changed

### 既存ファイルの編集

- `skills/cmux-team/manager/trace-store.ts`
  - SCHEMA に `rate_limit_snapshots` テーブル + index を追加
  - `ensureRateLimitSnapshotsColumns` 冪等マイグレーション
  - `insertRateLimitSnapshot` / `getProjection5h` / `getProjection7d` / `normalizeRole` を export
  - `RateLimitSnapshotRecord` / `ProjectionResult` 型追加
  - `aggregateApiUsageByRole` SQL を `WITH normalized AS (CASE ...)` 化、ORDER BY を master/conductor/agent/unknown 固定順 → input+output 降順に
- `skills/cmux-team/manager/proxy.ts`
  - `insertRateLimitSnapshot` import 追加
  - `maybeInsertRateLimitSnapshot` ヘルパ（opts.db null / util 両 null で skip）
  - streaming / 非 streaming で `extractRateLimit` を 1 回だけ呼んで `rl{Streaming,NonStreaming}` を再利用（DaemonState 反映 / snapshot INSERT / tokens.db 更新の 3 経路で共有）
- `skills/cmux-team/manager/dashboard-metrics.ts`（全面書き換え）
  - `MetricsData` の旧フィールド `tokensRemaining/Limit/ResetIso, requestsRemaining/Limit/ResetIso, burnTokPerSec` を削除
  - 新 `projection5h: ProjectionResult | null`, `projection7d: ProjectionResult | null`, `poolTokens: PoolTokenRow[] | null` を追加
  - 旧 Rate Limit セクションを削除し新 `Rate Limit Projection` セクションを追加（5h/7d × util bar / long-term / recent 15m の 3 行）
  - `buildPoolTokensSection` を追加（handle padEnd / 5h・7d util bar / no data 表示）
  - role / task テーブルの数値列を `padStart(12)` に統一（カンマ込み 10 桁対応）
  - caption の role を `normalizeRole` で正規化して汚染値の表示崩れを防止
  - 旧 `buildProgressBar / formatBurnRate / computeProjectedToLimit` の export 削除（utilization color など内部関数も簡略化）
  - `computeRiskLevel` は引き続き export（テスト互換）
- `skills/cmux-team/manager/rate-limit-display.ts`
  - `buildUtilizationBar` を `export function` 化
  - `${label}:${pct.padStart(3)}% ${bar}` 形式に変更（1% / 14% / 100% で `%` 位置が揃う）
- `skills/cmux-team/manager/config.ts`
  - `TeamConfig.metricsRefreshIntervalMs?: number` 追加
  - `resolveMetricsRefreshIntervalMs(config)` 追加（default 10_000、clamp [1_000, 600_000]、不正値は default）
- `skills/cmux-team/manager/dashboard.tsx`
  - import: `resolveMetricsRefreshIntervalMs` / `resolveProjectTokenPool` / `listTokens` / `getLatestUsageSnapshot` / `getProjection5h` / `getProjection7d` を追加、`getBurnRateWindow` を削除
  - `METRICS_VISIBLE_LINES = 30` 削除 → `RESERVED_LINES` 定数 + `computeMetricsVisibleLines(stdoutRows, envOverride)` pure 関数 + `getMetricsVisibleLines()` を導入
  - スライス処理 / `Down` キー / `G` キーの maxOffset を `getMetricsVisibleLines()` に切替
  - `Down` キーの metrics ケースで `Math.min(... + 1, maxOffset)` に clamp（従来は無制限）
  - `METRICS_POLL_INTERVAL_MS = 1000` 削除 → `startMetricsTimer` 内で `resolveMetricsRefreshIntervalMs(cachedConfig)` 経由
  - `loadMetricsData` を新 `MetricsData` 形に書き直し（projection / poolTokens を取得）
  - `buildPoolTokenRows` ヘルパ追加（selectableOnly + include/exclude フィルタ + util_5h DESC / handle ASC ソート）
  - `loadSettingsItems` に `metricsRefreshIntervalMs` 行追加
  - `cachedConfig` を `startDashboard` 起動時に 1 回 load し、Settings タブ表示時に reload
- `skills/cmux-team/manager/i18n.ts`
  - 新 i18n キー en/ja 両方:
    - `metrics_section_rate_limit_projection`
    - `metrics_section_pool_tokens`
    - `metrics_long_term`, `metrics_recent_15m`, `metrics_before_reset`
    - `metrics_pool_no_selectable`, `metrics_pool_no_data`
  - 旧キー削除: `metrics_section_rate_limit`, `metrics_label_tokens`, `metrics_label_requests`, `metrics_label_burn_rate`, `metrics_label_projected`, `metrics_label_reset_in`, `metrics_unit_tok_per_sec`

### 既存テストの更新

- `skills/cmux-team/manager/dashboard-metrics.test.tsx` 全面書き換え（旧 burn rate / TPM・RPM テスト削除、新 Projection / Pool Tokens / role 正規化 / 桁揃えテスト追加）
- `skills/cmux-team/manager/rate-limit-display.test.ts` に `buildUtilizationBar` の % padding テスト 4 件追加（1% / 14% / 100% / `%` 位置 invariant）
- `skills/cmux-team/manager/config.test.ts` に `resolveMetricsRefreshIntervalMs` テスト 10 件追加（default / clamp / 不正値）

### 新規ファイル

- `skills/cmux-team/manager/trace-store-projection.test.ts`（13 test、normalizeRole / SQL CASE 集約 / getProjection5h+7d）
- `skills/cmux-team/manager/proxy-rate-limit-snapshot.test.ts`（4 test、streaming / 非 streaming / util null skip / opts.db 未指定 skip）
- `skills/cmux-team/manager/dashboard-scroll.test.ts`（8 test、computeMetricsVisibleLines の env / clamp / fallback）

## TDD Cycles / Verification Results

bun test の全体実行は禁忌のため個別ファイルで検証:

```
=== dashboard-metrics.test.tsx ===          26 pass / 0 fail / 44 expects
=== rate-limit-display.test.ts ===          17 pass / 0 fail / 37 expects
=== trace-store-projection.test.ts ===      13 pass / 0 fail / 34 expects
=== proxy-rate-limit-snapshot.test.ts ===    4 pass / 0 fail /  6 expects
=== config.test.ts ===                      36 pass / 0 fail / 64 expects
=== dashboard-scroll.test.ts ===             8 pass / 0 fail / 13 expects
=== dashboard-conductor.test.tsx ===        14 pass / 0 fail / 72 expects (regression)
=== dashboard-issues.test.tsx ===           11 pass / 0 fail / 27 expects (regression)
=== dashboard-pool.test.tsx ===             17 pass / 0 fail / 62 expects (regression)
=== trace-store.test.ts ===                 32 pass / 0 fail / 214 expects (regression)
=== trace-store-metrics.test.ts ===         14 pass / 0 fail / 35 expects (regression)
=== proxy.test.ts ===                       44 pass / 0 fail / 163 expects (regression)
```

合計 236 test pass / 0 fail。既存テストの破壊なし。

### TypeScript 型チェック

```
bunx tsc --noEmit
→ scope 内ファイル (dashboard.tsx / dashboard-metrics.ts / rate-limit-display.ts /
   trace-store.ts / proxy.ts / config.ts / rate-limit-persistence.ts) は 0 件のエラー
→ pool-header-display.test.ts に 18 件の `Object is possibly 'undefined'` （out-of-scope）
   → cleanup task T368 に分離済み
```

### 各サブタスクの TDD サイクル概要

- **S1-S5（trace-store / proxy / config）**: 純粋関数 + DB スキーマ。`grep -n` で invariant 確認 →  S14 で書いた projection / role 正規化 / config テストが GREEN。
- **S6（rate-limit-display）**: padStart(3) 化と export 化。既存 17 + 新規 4 テストが GREEN。`5h: 42% ...` のパースが壊れないことを assertion で確認。
- **S7-S9（dashboard-metrics）**: 全面書き換えのため RED → GREEN → REFACTOR を 1 サイクルで実施。新 Projection / Pool Tokens / 桁揃え / caption 正規化のテストを書いてから実装、26 test GREEN。
- **S10-S12（dashboard.tsx）**: configed interval / projection / pool tokens / scroll 正常化を直接実装。`computeMetricsVisibleLines` を pure 関数として切り出して dashboard-scroll.test.ts で 8 test GREEN。
- **S13（i18n）**: 旧キー削除 → dashboard-metrics 側のコンパイル / テストが意図通り壊れないことを確認後、新キー追加。
- **S14（テスト）**: 既存 test の更新（旧 export を新 API に置換）+ 新規 5 ファイル追加。日本語ロケール下で動く実環境のため英 / 日両方の文言に耐える assertion（例: "loading" || "読み込み"、"projection" || "枯渇予測"）。
- **S15（統合）**: 全 scope tsc clean、各 test ファイル単体実行で 236 pass。

## Issues Encountered

### 1. pool-header-display.test.ts の既存型エラー → cleanup task **T368** に分離

- 場所: `skills/cmux-team/manager/pool-header-display.test.ts` の 18 件
- 内容: 全て `TS2532: Object is possibly 'undefined'`（テスト内 `tokens[N]` / `parts[N]` の non-null 推論不足）
- 判断: 本タスク（Metrics タブ書き換え）と完全に独立。plan §6.2 で out-of-scope 確認済み。
- 起票: `cmux-team create-task --title "cleanup: pool-header-display.test.ts の Object possibly undefined 18 件"` → **T368**

### 2. dashboard.tsx の `cachedConfig` リロード方針

`loadMetricsData` は同期コンテキストから呼ばれるため `await loadConfig` できず、起動時に 1 回 + Settings タブ reload で更新する方針を採用した。Manager 稼働中の `metricsRefreshIntervalMs` 変更は、

- Settings タブで Refresh が走った瞬間に cachedConfig が更新される
- 次回 startMetricsTimer 呼び出し時（M キー / 6 キー切替時）に新 interval 反映

の 2 段階で反映される。Manager 再起動を伴わずに即時反映する場合は別タスクで `cachedConfig` を eventBus 経由で push する設計が望ましいが、本タスクでは plan §1-3 の簡素実装に倒した（Settings タブ表示中の Manager 再起動 / リロードで即反映）。

### 3. 動作確認 #13 / #14（実環境動作）の扱い

plan F4 の指示に従い、

- **#13（config 反映）**: `resolveMetricsRefreshIntervalMs(config)` の単体テストでロジックを担保
- **#14（snapshot 蓄積）**: `proxy-rate-limit-snapshot.test.ts` で「streaming レスポンス 1 件 → INSERT 1 行」を assertion

実環境での Manager 再起動 + sqlite3 行数確認は Inspector ロールに委譲する。
