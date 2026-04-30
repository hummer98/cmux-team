# T354 Task Summary

タスク: Metrics タブを Rate Limit Projection に作り直し + 更新間隔を config 化

worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-354-1777270522`
branch: `task-354-1777270522/task`

## 完了したサブタスク (S1-S15)

| # | サブタスク |
|---|-----------|
| S1 | trace-store: rate_limit_snapshots schema + insertRateLimitSnapshot |
| S2 | proxy: snapshot INSERT 配線（streaming / 非 streaming 両経路、INSERT は 1 リクエスト 1 行） |
| S3 | trace-store: getProjection5h / getProjection7d 純粋関数 |
| S4 | trace-store: aggregateApiUsageByRole の CASE 正規化 SQL（master/conductor/agent/unknown 4 値固定順） |
| S5 | config: metricsRefreshIntervalMs (default 10s, clamp [1s, 600s]) |
| S6 | rate-limit-display: buildUtilizationBar export + `padStart(3)` で % 桁揃え |
| S7 | dashboard-metrics: MetricsData 差替 + Rate Limit Projection 描画（5h/7d × util / long-term / recent 15m） |
| S8 | dashboard-metrics: Pool Tokens セクション (token pool 有効時のみ) |
| S9 | dashboard-metrics: ロール / タスク桁揃え + caption normalizeRole 適用 (F1) |
| S10 | dashboard.tsx: metricsRefreshIntervalMs / projection / pool tokens 配線 |
| S11 | dashboard.tsx: computeMetricsVisibleLines pure 関数 + Down キー clamp (F2) |
| S12 | dashboard.tsx: Settings タブに metricsRefreshIntervalMs 行追加 |
| S13 | i18n: 新キー追加 / 旧 rate limit 系キー削除 |
| S14 | テスト追加・更新 (236 test pass / 0 fail) |
| S15 | 統合動作確認 (tsc clean / 個別 bun test) |

## 変更ファイル

### 既存編集 (10)
- `skills/cmux-team/manager/config.ts`
- `skills/cmux-team/manager/config.test.ts`
- `skills/cmux-team/manager/dashboard-metrics.ts` (全面書き換え)
- `skills/cmux-team/manager/dashboard-metrics.test.tsx` (全面書き換え)
- `skills/cmux-team/manager/dashboard.tsx`
- `skills/cmux-team/manager/i18n.ts`
- `skills/cmux-team/manager/proxy.ts`
- `skills/cmux-team/manager/rate-limit-display.ts`
- `skills/cmux-team/manager/rate-limit-display.test.ts`
- `skills/cmux-team/manager/trace-store.ts`

### 新規 (3)
- `skills/cmux-team/manager/dashboard-scroll.test.ts`
- `skills/cmux-team/manager/proxy-rate-limit-snapshot.test.ts`
- `skills/cmux-team/manager/trace-store-projection.test.ts`

## テスト結果

236 test pass / 0 fail。既存テスト破壊なし。

| ファイル | pass / fail / expects |
|----------|----------------------|
| dashboard-metrics.test.tsx | 26 / 0 / 44 |
| rate-limit-display.test.ts | 17 / 0 / 37 |
| trace-store-projection.test.ts | 13 / 0 / 34 |
| proxy-rate-limit-snapshot.test.ts | 4 / 0 / 6 |
| config.test.ts | 36 / 0 / 64 |
| dashboard-scroll.test.ts | 8 / 0 / 13 |
| dashboard-conductor.test.tsx (regression) | 14 / 0 / 72 |
| dashboard-issues.test.tsx (regression) | 11 / 0 / 27 |
| dashboard-pool.test.tsx (regression) | 17 / 0 / 62 |
| trace-store.test.ts (regression) | 32 / 0 / 214 |
| trace-store-metrics.test.ts (regression) | 14 / 0 / 35 |
| proxy.test.ts (regression) | 44 / 0 / 163 |

TypeScript 型チェック: scope 内ファイル 0 件。`pool-header-display.test.ts` の 18 件は本タスクのスコープ外として T368 (cleanup タスク) に分離済み。

## design review 反映 (F1-F6)

- F1: `normalizeRole` を SQL CASE と JS ヘルパで同一規則化（DRY 担保テスト追加）
- F2: `computeMetricsVisibleLines(stdoutRows, envOverride)` pure 関数 export + `RESERVED_LINES` const export
- F3: Pool Tokens 並び順テスト追加 (util_5h DESC + handle ASC)
- F4: 動作確認 #11/#13/#14 を単体テストで担保
- F5: proxy の `extractRateLimit` を 1 度だけ呼んで rl{Streaming,NonStreaming} を共有 / `insertRateLimitSnapshot` も 1 path 1 回
- F6: M / 6 キーの focusedArea 復帰修正は既に効いているため skip（plan の指示通り）

## 関連タスク

- T368 (cleanup): `pool-header-display.test.ts` の `Object is possibly 'undefined'` 18 件を別途修正

## 設計判断ハイライト

- **rate_limit_snapshots は trace DB に新テーブル**: 既存 `.team/rate-limit.json` (ヘッダー表示用) は触らず、時系列保存は trace DB に分離（SSOT 維持）
- **役割分担**: projection 計算は trace-store の純粋関数（テスト容易性）、UI 描画は dashboard-metrics（責務分離）
- **桁揃え戦略**: `padStart(12)` で input/output/cache 列を統一（カンマ込み 10 桁対応）+ `padStart(8)` で requests
- **role 正規化は SQL 側**: `aggregateApiUsageByRole` の SQL で `WITH normalized AS (CASE ...)` を使い surface 別の分散を集約レベルで解消

## マージ・成果物

- 納品方式: ローカル ff-only マージ
- merge SHA: `ae1b5f34bb43f777ec760522e984765c9aa1ca24`
- マージ先: `main`
- close-task: `cmux-team close-task --task-id 354 --deliverable-kind merged --force` で確定
