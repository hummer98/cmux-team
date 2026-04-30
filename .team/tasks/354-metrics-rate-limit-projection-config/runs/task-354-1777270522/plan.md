# T354 実装計画書 — Metrics タブを Rate Limit Projection に作り直し + 更新間隔 config 化

作成日: 2026-04-27
作業 worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-354-1777270522`
プランナー: surface:228

---

## 1. 課題分析

### 1-1. 旧 `── Rate Limit ──` セクションが no_data になる
- 参照ヘッダー (`anthropic-ratelimit-tokens-*` / `requests-*`) が Claude Code OAuth 経由のレスポンスに含まれず、`getLatestApiUsageRow` で得られる `ratelimit_tokens_*` / `ratelimit_requests_*` 列が常に NULL のまま `dashboard-metrics.ts:211-311` で no_data 描画される。
- `burnTokPerSec` は 60 秒平均の瞬間値で、5h / 7d ウィンドウ単位のリミッター挙動とは無関係。

**根本原因**: 表示しているリミット軸（分単位 TPM/RPM）と、実際にユーザーが律速される軸（unified 5h / 7d）が一致していない。

### 1-2. utilization の時系列が保存されていない
- `RateLimitInfo` は `extractRateLimit` (`proxy.ts:258-291`) でレスポンスごとに上書きされる構造で、`rate-limit-persistence.ts` も最新 1 件のみを `.team/rate-limit.json` に書き出す。
- 「直近 15 分の利用率増分」を計算するには `(timestamp, util_5h, util_7d, reset_5h, reset_7d)` の時系列が必要。

### 1-3. Metrics 更新間隔が 1 秒と過剰
- `dashboard.tsx:2006 METRICS_POLL_INTERVAL_MS = 1000`。Metrics は 1h ウィンドウ集計と最新 1 件取得が中心で、1 秒単位での再計算は CPU/IO 浪費。

### 1-4. token pool 利用時の selectable キー単位の rate limit が見えない
- token pool 有効時に各 handle の 5h/7d utilization・reset を確認したいが、現状は `buildPoolHeaderDisplay` がプール合算 capacity_pct を出すだけで、個別キーは TUI のヘッダーや `cmux-team pool status` でしか見えない。

### 1-5. ヘッダー右端の % 桁が揃わない
- `rate-limit-display.ts:105` の `${label}: ${pct}% ${bar}` がパディング無し。`5h: 1%` / `5h: 14%` / `5h:100%` で先頭の桁数が変わり、bar 開始位置がずれる。

### 1-6. Metrics タブのスクロールが効かない
- `METRICS_VISIBLE_LINES = 30` が固定値（`dashboard.tsx:62`）。ターミナル縦幅が 30 行未満のとき下端が切れ、`metricsScrollOffset` の上限計算 `total - METRICS_VISIBLE_LINES` も実画面と乖離する。
- `focusedArea` が `"global"` のままだと `Up`/`Down`/`g`/`G` のキー処理が `default` 経路に落ちて no-op（`dashboard.tsx:1730/1765/1886/1901`）。`switchTab("metrics")` は `focusedArea: "metrics"` を設定するが、`Escape` で `focusedArea: "global"` に戻った後、`M` / `6` で再来したケースで focus 復帰が ESC 経由のときに失われる経路が観察されている。
- Pool Tokens セクション追加で行数がさらに伸びる前提のため、スクロールを正常化しない限り情報が見えなくなる。

### 1-7. ロール別集計の表示崩れ
- `api_usage.role` 列に `master, x-cmux-surface: surface:123` のような汚染データが入っている（T355 修正済みだが過去データは残存）。`r.role.padEnd(10)` を超過し列がずれる。
- `r.requests.toLocaleString("en-US")` がカンマ込み 7 文字以上になるケースで `padStart(6)` も溢れる。

### 1-8. 影響範囲
- 表示層: `dashboard-metrics.ts` / `dashboard.tsx` / `rate-limit-display.ts` / `i18n.ts`
- データ層: `proxy.ts` / `trace-store.ts`
- 設定層: `config.ts`（`metricsRefreshIntervalMs` getter 追加）
- テスト: `dashboard-metrics.test.tsx` / `rate-limit-display.test.ts` / 新規 trace-store / proxy / config テスト

---

## 2. 技術アプローチ

### 2-1. データソース：unified utilization の時系列を別テーブルで持つ
- `.team/traces/traces.db` に `rate_limit_snapshots` テーブルを新設（`api_usage` と同 DB を再利用）。既存 SCHEMA / `ensure*Columns` パターンに準拠。
- proxy の `extractRateLimit` が non-null の `RateLimitInfo` を返したときに 1 行 INSERT。`unified5hUtilization` / `unified7dUtilization` のいずれかが non-null のレスポンスのみ書き込む（OAuth 未対応経路で空行を量産しない）。
- `.team/rate-limit.json` / `persistRateLimit` / `loadRateLimit` は触らない。ヘッダー表示 (`buildRateLimitDisplay`) の依存先を変えない。

**代替案（却下）**: 既存 `api_usage` 行に列を追加して INSERT する案。`api_usage` は 1 リクエスト 1 行で書き込み頻度が同じだが、(a) `api_usage.role IS NOT NULL` の cardinality が高くインデックスが膨らむ、(b) projection 計算は時刻 × utilization のスパース時系列で十分で、列幅を大きくする利点が薄い、ため新テーブルを優先する。

### 2-2. Projection 計算は trace-store の純粋関数として分離
- `getProjection5h(db, now)` / `getProjection7d(db, now)` を `trace-store.ts` に追加。
- 入力: `Database` / `now: number` （ms）。出力: `{ utilization, resetIso, longTermProjectedSec, recentProjectedSec, longTermRisk, recentRisk }`（数値 / null）。
- アルゴリズム:
  - **long-term**: 「直近 snapshot の utilization」と「reset_iso からの経過時間（5h - reset 残り時間）」から平均レート `util / elapsed_sec` を出し、残キャパ `(1 - util) / rate` で枯渇予測秒数。
  - **recent 15m**: 「直近 snapshot」と「now-15min より新しい最古 snapshot」の差分から `Δutil / Δsec` を出し `(1 - util) / rate` を計算。**reset を跨ぐ snapshot は除外**（reset で utilization が再 0 化するため負の Δ が出る）。簡便には `recorded_at >= max(now-15min, reset_5h_at の前回境界)` でフィルタ。実装上は「now-15min 以降かつ utilization が単調増加している区間」を採るか、「直近 reset 以降」のいずれかで切る。本実装では **直近 reset 以降の最古 snapshot** を採用（reset_iso を窓開始扱いで計算した long-term と一貫する）。
  - リスクは既存 `computeRiskLevel(projectedSec, resetRemainingSec)` を再利用（`dashboard-metrics.ts:109-118`）。

**代替案（却下）**: dashboard-metrics.ts 側で SQL を書く。テスト容易性と SQL 集中の方針上、trace-store に集約。

### 2-3. UI 差し替え
- `dashboard-metrics.ts:211-311` の旧 Rate Limit セクション全体を削除、新 `── Rate Limit Projection ──` セクションに置き換え。
- セクションは 5h / 7d それぞれ 3 行（util/reset、long-term 行、recent 15m 行）を出力。色分けは `mapRiskToColor` を再利用。
- `MetricsData` から `tokensRemaining/tokensLimit/tokensResetIso/requestsRemaining/requestsLimit/requestsResetIso/burnTokPerSec/computeProjectedToLimit` 系を削除し、`projection5h: ProjectionRow | null` / `projection7d: ProjectionRow | null` を新設（型は trace-store の戻り値）。
- 旧 `tokensRemaining` 等のフィールドおよび `formatBurnRate` / `computeProjectedToLimit` の export はテスト含めて全削除（互換性は不要、コードベース内の他参照は無し — `grep -n` で確認済み）。

### 2-4. Metrics 更新間隔 config 化
- `dashboard.tsx:2006 METRICS_POLL_INTERVAL_MS = 1000` を消し、`startMetricsTimer` の中で `resolveMetricsRefreshIntervalMs(config)` を読む。
- `config.ts`:
  - `TeamConfig` に `metricsRefreshIntervalMs?: number` を追加。
  - `resolveMetricsRefreshIntervalMs(config: Pick<TeamConfig, "metricsRefreshIntervalMs">): number` を追加。範囲 `[1000, 600_000]` で clamp（不正値は default に倒す）。default = 10_000。
- `loadSettingsItems` (`dashboard.tsx:327`) に `cfg` を読み込む形で `{ kind: "config", label: "metricsRefreshIntervalMs", value: ... }` を追加（既存 layout / autoUpdate / mainBranch / sleepPrevention と並列）。

### 2-5. Pool Tokens セクション
- `rate-limit-display.ts:93-112` の `buildUtilizationBar` をモジュール export に変更（同時に 2-6 の % padding 修正を入れる）。
- `dashboard-metrics.ts` 内に `buildPoolTokensSection(data)` を追加。`MetricsData` に `poolTokens: PoolTokenRow[] | null` を持たせる（null = pool 無効）。
- `PoolTokenRow` は `{ handle, util5h, reset5hIso, util7d, reset7dIso, hasSnapshot }`。
- `dashboard.tsx:loadMetricsData` で `daemon.tokenDb` （または `state.tokenDb` 相当の handle、`buildPoolSummary` と同経路）と `daemon.tokenPoolEnabled` を読み、enabled なら以下を実行:
  - `listTokens(db, { selectableOnly: true })` を取得。
  - `resolveProjectTokenPool(config)` の `default` / `include` / `exclude` を適用してフィルタ。
  - 各 token に対し `getLatestUsageSnapshot(db, t.id)` で snapshot を取り `PoolTokenRow` を作る。
  - `MetricsData.poolTokens` に格納。
- 並び順は `util_5h` 降順 → 同 util は handle 昇順（仕様書の「util_5h 高い順」に従う）。

**daemon との結線**: `DaemonState.tokenDb` の存在を確認する。

### 2-6. ヘッダー % padding
- `buildUtilizationBar` の `text` 組み立てを `${label}:${pct.toString().padStart(3)}% ${bar}` に変更。`100% / 14% / 1%` の桁を統一。Pool Tokens セクションも同関数を再利用するため自動で揃う。

### 2-7. スクロール修正
- `METRICS_VISIBLE_LINES = 30` を撤廃し、`getMetricsVisibleLines()` を導入：
  1. `process.stdout.rows` を読み、ヘッダー / Master / Conductors / Tasks / footer の固定行数 `RESERVED_LINES`（実測 ≈ 12-14、定数化）を引いて算出。
  2. 計算結果を `[8, 80]` で clamp。
  3. 環境変数 `CMUX_TEAM_METRICS_VISIBLE_LINES` が数値なら最優先で上書き（テスト・debug 用）。
- `dashboard.tsx:1559-1567` のスライス処理、`Down` キーの上限計算 (`s.metricsScrollOffset + 1` で +∞ になる現状の上限欠如)、`G` キーの maxOffset 計算で同 `getMetricsVisibleLines()` を使う。
- `Down` キーの metrics ケースは `Math.min(s.metricsScrollOffset + 1, maxOffset)` に修正（現状は無制限）。
- `M` / `6` キーで戻ったときの focus は既存 `switchTab("metrics")` で OK（再現確認の上で問題があれば `M` ハンドラを `switchTab("metrics")` 経由に統一、現状は既に `switchTab("metrics")`）。`Escape` 経由で `focusedArea: "global"` に戻った後の挙動は `switchTab` が呼ばれない別経路があるため、`M` キーは `switchTab("metrics")` 必須化を確認しコメント追加。
- footer のキーヒント `↑/↓ scroll  g/G top/bottom` は既出のためそのまま。

### 2-8. ロール別集計の桁揃え
- `aggregateApiUsageByRole` を SQL で正規化:
  ```sql
  SELECT
    CASE
      WHEN role LIKE 'master%'     THEN 'master'
      WHEN role LIKE 'conductor%'  THEN 'conductor'
      WHEN role LIKE 'agent%'      THEN 'agent'
      ELSE COALESCE(role, 'unknown')
    END AS role,
    ...
  GROUP BY role  -- 上で正規化した role
  ORDER BY
    CASE role WHEN 'master' THEN 1 WHEN 'conductor' THEN 2 WHEN 'agent' THEN 3 ELSE 4 END,
    (input + output) DESC
  ```
  GROUP BY と ORDER BY が同じ正規化値を見るよう、サブクエリ or `WITH normalized AS (...)` で 1 段階組み立てる。
- `dashboard-metrics.ts:313-342` ロール別 UI ブロック:
  - role 列: `padEnd(10)`（"conductor" 9 文字 + 1）。
  - 数値 4 列: `padStart(12)` で見出し / 値とも統一（カンマ込み 9-10 桁に対応）。
  - `gap: 2` 維持。
- `dashboard-metrics.ts:344-375` タスク別 UI ブロックも同じ数値桁（task_id は `padEnd(10)` のまま）。

---

## 3. 変更対象

### 3-1. 変更するファイル

| ファイル | 変更概要 |
|---------|---------|
| `skills/cmux-team/manager/proxy.ts` | `extractRateLimit` 直後に `insertRateLimitSnapshot(db, ...)` 呼び出しを追加（streaming / 非 streaming 両経路）。`opts.db` が無いケースは skip |
| `skills/cmux-team/manager/trace-store.ts` | (a) `rate_limit_snapshots` テーブル DDL を SCHEMA に追加 + ensureRateLimitSnapshotsColumns; (b) `insertRateLimitSnapshot` を export; (c) `getProjection5h` / `getProjection7d` を export; (d) `aggregateApiUsageByRole` の SQL を CASE 正規化 + ORDER BY 固定順に修正 |
| `skills/cmux-team/manager/dashboard-metrics.ts` | 旧 Rate Limit セクション削除。`MetricsData` 型から旧フィールド削除、`projection5h` / `projection7d` / `poolTokens` 追加。Projection / Pool Tokens セクションのレンダリング追加。ロール別 / タスク別 UI の桁揃え修正 (`padStart(12)` 等)。`buildProgressBar` / `formatBurnRate` / `computeProjectedToLimit` の使用が無くなれば export を整理 |
| `skills/cmux-team/manager/rate-limit-display.ts` | `buildUtilizationBar` を `export` 化 + `${label}:${pct.toString().padStart(3)}% ${bar}` 形式に変更 |
| `skills/cmux-team/manager/dashboard.tsx` | (a) `METRICS_VISIBLE_LINES` 削除 → `getMetricsVisibleLines()` 導入; (b) `loadMetricsData` を新 `MetricsData` 形に合わせて書き直し（projection / poolTokens 取得を追加）; (c) `METRICS_POLL_INTERVAL_MS` 削除 → `resolveMetricsRefreshIntervalMs(config)` 経由で取得; (d) Down キーで maxOffset clamp; (e) `loadSettingsItems` に `metricsRefreshIntervalMs` を追加 |
| `skills/cmux-team/manager/config.ts` | `TeamConfig.metricsRefreshIntervalMs?: number` 追加。`resolveMetricsRefreshIntervalMs(config)` 追加 |
| `skills/cmux-team/manager/i18n.ts` | `metrics_section_rate_limit_projection` / `metrics_pool_tokens_section` / `metrics_long_term` / `metrics_recent_15m` / `metrics_before_reset` 等の i18n キー追加。旧 `metrics_section_rate_limit` / `metrics_label_tokens` / `metrics_label_requests` / `metrics_label_burn_rate` / `metrics_label_projected` / `metrics_label_reset_in` / `metrics_label_risk` のうち未使用化したものは削除 |
| `skills/cmux-team/manager/dashboard-metrics.test.tsx` | 旧 Rate Limit アサーションを Projection に書き換え。Pool Tokens テスト追加。ロール正規化 / 桁揃えのテスト追加 |
| `skills/cmux-team/manager/rate-limit-display.test.ts` | 期待文字列を `5h: 42% ...` から `5h: 42% ...`（先頭 padStart 後）に更新。1% / 100% の境界ケースを追加 |
| `skills/cmux-team/manager/proxy.test.ts`（既存があれば）/ 新規 `proxy-rate-limit-snapshot.test.ts` | `extractRateLimit` 後に `rate_limit_snapshots` に 1 行 INSERT されることを確認するテスト |
| `skills/cmux-team/manager/trace-store-metrics.test.ts`（または既存テストに追記） | `getProjection5h` / `getProjection7d` の純関数テスト |
| `skills/cmux-team/manager/config.test.ts`（既存があれば）/ 新規 | `resolveMetricsRefreshIntervalMs` のテスト |

### 3-2. 新規作成するファイル

- 上記テストの新規ファイル（既存 test 命名規約 `<module>-<topic>.test.ts` に従う）。

### 3-3. 削除するファイル

- なし。コード単位の削除のみ（旧 Rate Limit セクション・関連 i18n キー・関連テスト）。

---

## 4. サブタスク分割（実装順序）

> 制約: 並列実装禁止。旧コードと新コードの並走を避ける。

### S1. trace-store: スキーマ + INSERT を追加
- **対象**: `skills/cmux-team/manager/trace-store.ts`
- **完了条件**:
  - `rate_limit_snapshots` テーブル DDL が SCHEMA に存在し、`initDB` 経由で作成される
  - `ensureRateLimitSnapshotsColumns` が冪等に動く（既存 DB を起動しても ALTER が破綻しない）
  - `insertRateLimitSnapshot(db, { unified5hUtilization, unified5hReset, unified7dUtilization, unified7dReset, timestamp })` が export される
  - `idx_rate_limit_snapshots_ts` インデックスが作成される
- **検証**: `grep -n "rate_limit_snapshots" skills/cmux-team/manager/trace-store.ts` で 4 箇所以上ヒット

### S2. proxy: snapshot INSERT 接続
- **対象**: `skills/cmux-team/manager/proxy.ts`
- **完了条件**:
  - `extractRateLimit` 直後（streaming `:656`、非 streaming `:728`）で `insertRateLimitSnapshot` を呼ぶ
  - 5h / 7d util がいずれも null のレスポンスは INSERT しない
  - `opts.db` が undefined のときは skip（既存テスト互換）
- **検証**: `grep -n "insertRateLimitSnapshot" skills/cmux-team/manager/proxy.ts` で 2 箇所以上、`bun test` で proxy 系テストが通る

### S3. trace-store: projection 集計関数
- **対象**: `skills/cmux-team/manager/trace-store.ts`
- **完了条件**:
  - `ProjectionResult` 型と `getProjection5h(db, now): ProjectionResult | null` / `getProjection7d(db, now): ProjectionResult | null` を export
  - 直近 snapshot が無いときは null
  - long-term は `util / elapsed_sec from window_start` で計算（5h: now - 5h で window_start を推定 / 7d: now - 7d）
  - recent 15m は「直近 reset 以降」かつ「now-15min 以降」の最古 snapshot を起点に計算。1 件しか無い / Δutil < 0 / Δsec ≤ 0 なら null
- **検証**: `bun test trace-store-projection.test.ts`（新規） が通る

### S4. trace-store: ロール正規化 SQL 修正
- **対象**: `skills/cmux-team/manager/trace-store.ts`
- **完了条件**:
  - `aggregateApiUsageByRole` の SQL が CASE 正規化 + ORDER BY 固定順 (master/conductor/agent/unknown) を使う
  - `master, x-cmux-surface: surface:123` のような汚染 role が `master` に集約される
- **検証**: `grep -n "WHEN 'master' THEN 1" skills/cmux-team/manager/trace-store.ts` で 1 箇所、追加テストで合算が確認できる

### S5. config: metricsRefreshIntervalMs
- **対象**: `skills/cmux-team/manager/config.ts`
- **完了条件**:
  - `TeamConfig` interface に `metricsRefreshIntervalMs?: number` を追加（JSDoc 付き）
  - `resolveMetricsRefreshIntervalMs(config: Pick<TeamConfig, "metricsRefreshIntervalMs">): number` を追加。default 10_000、`[1000, 600_000]` で clamp、不正値は default
- **検証**: `grep -n "metricsRefreshIntervalMs" skills/cmux-team/manager/config.ts` で 3 箇所以上、新規テストが通る

### S6. rate-limit-display: % padding + export 化
- **対象**: `skills/cmux-team/manager/rate-limit-display.ts`
- **完了条件**:
  - `buildUtilizationBar` を `export function buildUtilizationBar(...)` に変更
  - `${label}:${pct.toString().padStart(3)}% ${bar}` 形式に変更
  - 既存 `buildRateLimitDisplay` の動作が壊れない（同じ `RateLimitPart[]` を返し続ける）
- **検証**: `grep -n "padStart(3)" skills/cmux-team/manager/rate-limit-display.ts` で 1 箇所以上、`rate-limit-display.test.ts` の更新版が通る

### S7. dashboard-metrics: MetricsData の差し替え + Projection レンダリング
- **対象**: `skills/cmux-team/manager/dashboard-metrics.ts`
- **完了条件**:
  - `MetricsData` から `tokensRemaining` / `tokensLimit` / `tokensResetIso` / `requestsRemaining` / `requestsLimit` / `requestsResetIso` / `burnTokPerSec` を **削除**
  - `projection5h: ProjectionResult | null` / `projection7d: ProjectionResult | null` を **追加**
  - `poolTokens: PoolTokenRow[] | null` を **追加**（null = pool 無効）
  - 旧 `── Rate Limit ──` セクション (`:211-311`) を **削除**
  - 新 `── Rate Limit Projection ──` セクションを `buildMetricsRows` 内に追加
  - 旧 `formatBurnRate` / `computeProjectedToLimit` / `buildProgressBar` の export はテスト・他参照が無くなっていれば削除（要 grep 確認）
- **検証**: `grep -nE "tokensRemaining|burnTokPerSec" skills/cmux-team/manager/dashboard-metrics.ts` で 0 ヒット

### S8. dashboard-metrics: Pool Tokens セクション
- **対象**: `skills/cmux-team/manager/dashboard-metrics.ts`
- **完了条件**:
  - `MetricsData.poolTokens` が null なら section ごと省略
  - non-null なら `── Pool Tokens (selectable: N) ──` ヘッダー + 各 handle 1 行
  - 各行は `buildUtilizationBar` を 5h / 7d に対し呼んで連結
  - handle 列を最大幅で `padEnd`、5h/7d ブロック内も `padStart(3)` % 桁固定
  - snapshot が無い handle は `no data` 表示
- **検証**: 新規テスト `dashboard-metrics.test.tsx` の Pool Tokens 系列が通る

### S9. dashboard-metrics: ロール別 / タスク別 UI 桁揃え
- **対象**: `skills/cmux-team/manager/dashboard-metrics.ts`
- **完了条件**:
  - role 列 `padEnd(10)`、数値 4 列 `padStart(12)` で見出し / 値とも統一（タスク別も同じ）
  - SQL 側で正規化済み role は 4 値のみ（master / conductor / agent / unknown）
- **検証**: 新規テストで `master` 行と `agent` 行の数値列がカラム揃いになることを assertion

### S10. dashboard.tsx: metricsRefreshIntervalMs / projection / pool tokens 配線
- **対象**: `skills/cmux-team/manager/dashboard.tsx`
- **完了条件**:
  - `METRICS_POLL_INTERVAL_MS = 1000` を削除
  - `startMetricsTimer` が `resolveMetricsRefreshIntervalMs(config)` を読む（タブ切り替えごとに再読み込み）
  - `loadMetricsData` の中で `getProjection5h` / `getProjection7d` / `listTokens` + `getLatestUsageSnapshot` + `resolveProjectTokenPool` を使って新 `MetricsData` を構築
  - daemon の `tokenPoolEnabled` 判定（既存 `daemon.pool != null` 等で代替）が false なら `poolTokens: null`
  - 旧 `tokensRemaining` 等の代入経路を削除
- **検証**: `bun run typecheck` 相当で型エラーなし、`grep -n "METRICS_POLL_INTERVAL_MS" skills/cmux-team/manager/dashboard.tsx` で 0 ヒット

### S11. dashboard.tsx: スクロール正常化
- **対象**: `skills/cmux-team/manager/dashboard.tsx`
- **完了条件**:
  - `METRICS_VISIBLE_LINES = 30` 削除、`getMetricsVisibleLines()` 導入（`process.stdout.rows` ベース、`[8, 80]` で clamp、`CMUX_TEAM_METRICS_VISIBLE_LINES` 環境変数で上書き可）
  - スライス処理 / `Down` キー / `G` キーの maxOffset がすべて `getMetricsVisibleLines()` を使う
  - `Down` ケースで `Math.min(s.metricsScrollOffset + 1, maxOffset)` に clamp
  - `M` キーは `switchTab("metrics")` を呼ぶ（`focusedArea` を確実に metrics に設定）
- **検証**: 新規テストで MetricsData の rows.length > visible のとき `metricsScrollOffset` が `[0, rows.length - visible]` で動くこと

### S12. dashboard.tsx: Settings タブに 1 行追加
- **対象**: `skills/cmux-team/manager/dashboard.tsx` (`loadSettingsItems`)
- **完了条件**:
  - 既存 layout / autoUpdate / mainBranch / sleepPrevention の隣に `metricsRefreshIntervalMs` 行を追加（read-only / value のみ）
- **検証**: `grep -n "metricsRefreshIntervalMs" skills/cmux-team/manager/dashboard.tsx` で 2 箇所以上

### S13. i18n: 新キー追加 + 旧キー削除
- **対象**: `skills/cmux-team/manager/i18n.ts`
- **完了条件**:
  - 新 i18n キー（projection / pool tokens / long-term / recent 15m / before reset）が en / ja 両方に追加
  - 旧キー（`metrics_section_rate_limit` / `metrics_label_tokens` / `metrics_label_requests` / `metrics_label_burn_rate` / `metrics_label_projected` / `metrics_label_reset_in` / `metrics_label_risk` のうち未使用化したもの）を削除
- **検証**: `grep -n "metrics_label_tokens" skills/cmux-team/manager/` で 0 ヒット

### S14. テスト更新 / 追加
- **対象**: 各 `*.test.ts(x)`
- **完了条件**:
  - `dashboard-metrics.test.tsx`: 旧 Rate Limit アサーション削除、Projection / Pool Tokens / role 正規化 / 桁揃えのテスト追加
  - `rate-limit-display.test.ts`: padStart(3) を反映した期待値 + 1% / 100% / 14% の境界ケース
  - `trace-store-projection.test.ts`（新規）: getProjection5h / getProjection7d
  - `proxy-rate-limit-snapshot.test.ts`（新規）: streaming / 非 streaming で `rate_limit_snapshots` に 1 行 INSERT されること
  - `config.test.ts`（既存ならそこに）: resolveMetricsRefreshIntervalMs の境界
- **検証**: 推奨手順 `cd skills/cmux-team/manager && for f in dashboard-metrics.test.tsx rate-limit-display.test.ts trace-store-projection.test.ts proxy-rate-limit-snapshot.test.ts config.test.ts; do bun test --timeout 30000 "$f"; done` で全てパス

### S15. 統合動作確認
- 削除タスク必須（並列禁止）: S7 / S10 で旧コードを残さない
- 完了条件:
  - `bunx tsc --noEmit` がスコープ内ファイルでエラー 0
  - `bun test --timeout 30000` を上記 1 ファイルずつ実行して全て pass
  - 起動して Metrics タブで Projection / Pool Tokens セクションが表示される（pool 有効プロジェクトと無効プロジェクト両方で確認）

---

## 5. リスク

### 5-1. 既存機能への影響
- **`extractRateLimit` の null ガード**: streaming / 非 streaming 経路で 2 回呼ばれているが INSERT は重複させたくない。`opts?.db` が無いか util が両 null のときは skip し、それ以外は 1 リクエスト 1 INSERT に絞る（streaming 経路は upstream response 受信直後に 1 回だけ、非 streaming も同様）。`updateTokensDB` 内の重複呼び出しは触らない。
- **`api_usage` の旧汚染データ**: 物理 migration はしない方針。SQL CASE で読み出し時に正規化されるので集計は揃うが、`getLatestApiUsageRow` で `latestRowRole` に汚染値が入る可能性がある（`metrics_caption_from` 表示）。caption 部分も同じ正規化を JS 側で適用する（dashboard-metrics.ts 表示直前で `master, x-cmux-surface: ...` → `master` に丸める軽い preprocess）。
- **`rate_limit_snapshots` の GC 未実装**: 既知の注意点に追記する（CLAUDE.md「既知の注意点」セクションに「`rate_limit_snapshots` テーブルの自動 GC は未実装」を追加）。サイズ見積りは 1 リクエスト 1 行 × 60-200 byte。

### 5-2. エッジケース
- **proxy 未稼働**: snapshot がゼロ件のため `getProjection*` は null を返す → no_data 表示。
- **reset を跨ぐ recent 15m**: 「直近 reset 以降」フィルタで除外。Δutil < 0 / Δsec ≤ 0 なら null。
- **utilization が 100% に到達済み**: `(1 - util) <= 0` なら projection = 0s（exhaust now）として表示。色は red 固定。
- **snapshot は 1 件のみ**: long-term は計算可能、recent 15m は null。
- **token pool 有効だが selectable=0**: `── Pool Tokens (selectable: 0) ──` のヘッダーのみ表示し本文は空 1 行（`(no selectable tokens)`）。
- **handle 名が config の `default` で resolve されたが selectable=0**: include で強制候補化される設計だが、selectable=0 はそもそも候補から落ちる（`listTokens(db, { selectableOnly: true })` でフィルタ済み）。
- **terminal 縦幅 8 未満**: `getMetricsVisibleLines()` が 8 で clamp。スクロール余地はあっても表示が極端に狭まる。
- **CMUX_TEAM_METRICS_VISIBLE_LINES に 0 / 負 / NaN**: `[8, 80]` の clamp に倒す（fail-fast はしない、debug 用途のため寛容）。

### 5-3. テスト戦略
- 純粋関数ユニットテスト: `getProjection*` / `resolveMetricsRefreshIntervalMs` / `aggregateApiUsageByRole`（正規化）/ `buildUtilizationBar`（padStart）/ `buildMetricsRows`（projection / pool tokens / role 桁揃え）。
- 統合テスト（proxy）: in-memory `bun:sqlite` の trace-store DB を作って `extractRateLimit` 経由で呼ぶ smoke test。
- スクロールは pure 関数化が難しいので、`getMetricsVisibleLines()` 自体を rows / process.stdout.rows / env を引数で受ける純関数 `computeMetricsVisibleLines(stdoutRows, envOverride)` として分離してテスト。
- E2E: 推奨手順（`for f in *.test.ts*; do bun test --timeout 30000 $f; done`）で全パス。`bun test` 全体実行は禁忌（既知の注意点）。

---

## 6. 既存型エラーの先読み

実行コマンド:
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-354-1777270522/skills/cmux-team/manager
bunx tsc --noEmit 2>&1 | grep -E "^(dashboard|dashboard-metrics|rate-limit-display|trace-store|proxy|config|rate-limit-persistence)\.tsx?"
```

### 6.1. スコープ内で解消するエラー
**該当なし**。スコープ内ファイル（`dashboard.tsx` / `dashboard-metrics.ts` / `rate-limit-display.ts` / `trace-store.ts` / `proxy.ts` / `config.ts` / `rate-limit-persistence.ts`）に既存型エラーは無い（2026-04-27 時点）。

### 6.2. cleanup に分離するエラー
本タスクと無関係なテスト型エラー 18 件（全て `pool-header-display.test.ts` の `Object is possibly 'undefined'`）が存在する。本タスクのスコープ外として cleanup タスクに分離する。

---

## 7. Decision Log

| ID | 検討事項 | 結論 | 理由 |
|----|---------|------|------|
| D1 | utilization 時系列を `api_usage` 列に追加するか / 別テーブルにするか | 別テーブル `rate_limit_snapshots` | (a) `api_usage` は 1 req 1 行で、null が大量に並ぶスパース列を増やしたくない (b) projection 計算は (timestamp, util_5h, util_7d, reset) のみで十分 (c) インデックスを ts のみで張ればよく軽量 |
| D2 | snapshot INSERT を proxy / daemon どちらでやるか | proxy | (a) `extractRateLimit` の傍で書ける (b) daemon に push するイベントを増やすと EventBus 違反のリスク (c) `opts.db` を渡している既存パターン（api_usage と同経路）に揃う |
| D3 | INSERT を 5h / 7d 両方 null でもするか | 両方 null なら skip | (a) OAuth 未対応経路で空行を量産しない (b) projection 計算側で null フィルタする手間を減らす |
| D4 | recent 15m のレート計算で reset 跨ぎをどう扱うか | 直近 reset 以降の最古 snapshot を起点 | (a) reset で utilization が 0 化するため負の Δ が出る (b) long-term と窓開始の解釈が一貫する (c) snapshot 1 件しか無い場合は null（ユーザーには「データ蓄積中」を no_data で示す） |
| D5 | metricsRefreshIntervalMs の clamp 範囲 | `[1000, 600_000]` (1s〜10min) | (a) 1 秒未満は CPU 浪費 (b) 10 分超は実質手動 reload と変わらない (c) 不正値は default に倒す（fail-fast でなく warn のみ）— config 設定ミスで daemon 停止しないため |
| D6 | METRICS_VISIBLE_LINES の動的化 | `process.stdout.rows` ベース + env 上書き | (a) 固定 30 が原因でスクロール不能になる根本対策 (b) ink/rezi の標準 layout に追従 (c) env で test/debug 可能 |
| D7 | ロール正規化を SQL でやるか JS でやるか | SQL（GROUP BY と ORDER BY が同じ正規化値を見る） | (a) 複数 surface に分散した汚染 role が SQL 集約 1 段で master に統合される (b) 集計結果が JS に渡る前に行数が縮む (c) GROUP BY を JS でやる代替案は二度手間 |
| D8 | 旧汚染データの物理 migration | しない | (a) 仕様で「正規化で読めれば十分」と明記 (b) 過去データの整合性は集計レイヤで担保できる |
| D9 | Pool Tokens の並び順 | `util_5h` 降順 → handle 昇順 | (a) 仕様書に「util_5h 高い順」記載 (b) ユーザーは「枯渇しそうな handle」を最初に確認したい (c) handle 昇順は同 util の deterministic order を保証 |
| D10 | `MetricsData` の旧フィールド削除 | 完全削除（互換 shim 無し） | (a) 仕様で「互換は不要、消してよい」と明記 (b) 並列実装禁止の制約に合わせて削除タスクを明示 |
| D11 | latestRowRole の caption も正規化するか | する（JS 側で軽く） | (a) `from: master, x-cmux-surface: surface:300 (5s ago)` のような表示崩れを防ぐ (b) 単一行の preprocess で済む |
| D12 | `buildUtilizationBar` の export 化と padding 修正を同 PR/同 commit でやるか | 同サブタスク（S6） | (a) `${label}: ${pct}%` を再利用する Pool Tokens 側でフォーマットがズレない (b) test 期待値の更新も 1 回で済む |
| D13 | Settings タブの編集 UI | 作らない | (a) 仕様に「編集 UI は今回スコープ外」と明記 (b) read-only 1 行で十分 |
| D14 | `rate_limit_snapshots` の GC | 今回スコープ外 | (a) 仕様で除外 (b) `hook_signals` / `api_usage` と同じく既知の注意点に追記し、後続タスクで扱う |
| D15 | recent 15m を「直近 reset 以降」と「now-15min 以降」の AND にする時、スナップショットが reset 直後で 1 件しかない場合 | null を返す | (a) Δsec ≤ 0 / 1 件しか無いと計算不能 (b) UI では「データ蓄積中」を no_data 表示。ユーザーは long-term 行で代替判断できる |

---

## 出力先

`/Users/yamamoto/git/cmux-team/.team/tasks/354-metrics-rate-limit-projection-config/runs/task-354-1777270522/plan.md`（本ファイル）
