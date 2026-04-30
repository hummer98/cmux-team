# T307 Plan — Dashboard に Metrics タブ追加（時系列 + ロール別 + バーンレート）

## 1. 課題分析

### 現状の問題点

- T305 で `api_usage` テーブルに `/v1/messages` 1 リクエストごとの usage / rate limit を記録する仕組みは整った（27 列、`insertApiUsage` / `getApiUsage`）が、**可視化手段がない**。
- ユーザーは「cmux-team を使うとトークンを大量消費している気がする」という不安を抱えても、`sqlite3 .team/traces/traces.db` で手元集計するしかない。
- 既存 dashboard はヘッダー右端に unified 5h / 7d 使用率（`buildRateLimitDisplay` / `.team/rate-limit.json`）を出しているが:
  - unified は 5 時間窓で粒度が粗く、「いま何 tok/s 消費してるか」が分からない
  - 分単位 rate limit（api_usage の `ratelimit_tokens_*`）は一切表示されない
  - ロール別（master/conductor/agent）や タスク別（T301/T302/...）の内訳が見えない

### 根本原因

- dashboard タブが「ログ・ジャーナル・タスク・GH Issues 系」の**事象追跡用途**に特化しており、**消費量の連続観測（時系列）**は設計上含まれていなかった。
- データパイプライン（proxy → insertApiUsage）は T305 で完成したが、TUI 側の消費者が実装されていない。

### 影響範囲

- `skills/cmux-team/manager/dashboard.tsx`: タブ列挙（`AppState["activeTab"]`）・キーバインド・rendering 分岐・footer ヘルプ・スクロール/カーソル処理
- `skills/cmux-team/manager/trace-store.ts`: api_usage 向け集計関数の追加
- 新規テスト: 集計ロジック（trace-store）＋ 表示ロジック（dashboard-metrics.test.tsx パターン）
- i18n 追加（英日ラベル）

---

## 2. 技術アプローチ

### 選択したアプローチ

**(A) Metrics タブを既存タブ群に 6 番目として追加**し、描画時に SQLite を直接 SUM/GROUP BY で集計、1 秒間隔で `loadMetricsData()` を再実行して AppState に反映する。Issues タブの `loadIssuesFromCache` と同じパターンを踏襲する。

集計クエリは純粋関数として `trace-store.ts` に追加し、dashboard は表示専用。表示ロジックは既存の `buildIssueRows` と同じく純粋関数にしてユニットテスト可能にする。

### 代替案と却下理由

| 代替案 | 却下理由 |
|-------|---------|
| dashboard のヘッダー部に burn rate を常時表示（タブ追加しない） | ロール別・タスク別まで見せる情報量に対しヘッダー幅が足りない。既に unified 5h/7d で右端を消費している。また「ユーザーが意識的に開きに来る」タブ形式のほうが情報消費コンテキストに合う |
| 集計を dashboard 側で in-memory（`getApiUsage()` 全件 → JS で sum） | `getApiUsage` は id DESC LIMIT 50 の単純 SELECT。直近 1h だと数百〜数千行オーダーになるため JS 側集計は CPU 的に無駄。SQLite の SUM/GROUP BY のほうが速く正確 |
| api_usage の raw 行を tail -f 風に流す | 「トークンが今 N tok/s 出ていってる」の判断には役立たない。集計こそが Metrics タブの本質 |
| unified 5h/7d（`.team/rate-limit.json`）だけを使う | 分単位ウィンドウ（api_usage の `ratelimit_tokens_*`）は unified と独立した観測軸で、秒オーダーのバーンレート計算には分単位のほうが妥当。両方見せる |
| 集計ロジックを daemon の tick に組み込み DaemonState に載せる | daemon 本体のホットパスに重い query を増やす必要はない。dashboard は子プロセスではなく同一 process なので、dashboard 側で independent interval から SQLite を直接叩くだけで十分 |

### 既存パターンとの整合性

- 純粋 build 関数 + 独立テスト（`buildIssueRows` / `buildRateLimitDisplay`）
- タブ state は `AppState["activeTab"]` 列挙に追加
- キーバインドは `"1"-"5"` + `J/L/A/I` のパターンに `"6"` + `M` を追加
- Tab rotation 配列に `"metrics"` を末尾に追加
- i18n は `t()` 経由（`i18n.ts` に追加）
- Settings タブ同様 `switchTab` で `refresh()` + 専用 interval start、他タブ遷移時に interval stop

### データ集計方法: SQL で毎 tick 集計

- `aggregateApiUsageByRole(db, { sinceIso, untilIso })` — `SELECT role, COUNT(*) AS requests, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_creation_input_tokens + cache_read_input_tokens) AS cache, SUM(cache_read_input_tokens) AS cache_read FROM api_usage WHERE timestamp >= ? AND timestamp <= ? GROUP BY role`
- `aggregateApiUsageByTask(db, { sinceIso, untilIso, limit })` — 同様だが `GROUP BY task_id`、`ORDER BY (input+output) DESC LIMIT ?`
- `getLatestApiUsageRow(db)` — 最新 1 行（分単位 rate limit ヘッダー取得用。role を問わず全体最新）
- `getBurnRateWindow(db, windowSec)` — `SELECT SUM(input_tokens + output_tokens) AS total FROM api_usage WHERE timestamp >= datetime('now', '-N seconds')`。戻り値 `{ totalTokens, windowSec, tokPerSec }`

いずれも小〜中規模データ（直近 1h で数百〜数千行）で **< 10 ms** を目標。indexes は T305 で `idx_api_usage_timestamp` / `_task_id` / `_role` が既に存在する。

### Burn rate 計算

- ウィンドウサイズ: **60 秒固定**（Anthropic の分単位 rate limit window と整合）
- 計算式: `burnTokPerSec = totalInOutLast60s / 60`
- `projected_to_limit_sec = ratelimit_tokens_remaining / burnTokPerSec`（burn=0 は Infinity → "idle"）
- `reset_remaining_sec = (ratelimit_tokens_reset - now) / 1000`
- 判定:
  - `projected < reset_remaining`: RED ⚠ RISK（リセット前にリミット到達見込み）
  - `projected >= reset_remaining`: GREEN（余裕）
  - `remaining` 値が null（ヘッダー未取得、proxy 経由無し）: GRAY `no data`

### Rate limit 状況の取得方針

- 分単位 remaining/limit/reset: `api_usage` テーブルの **最新 1 行**（id DESC LIMIT 1）をそのまま使う。role 横断で最新（Anthropic 側はアカウント単位の共通ウィンドウ）。
- unified 5h/7d: **既存の `daemon.rateLimit`**（`.team/rate-limit.json`）をそのまま使う。`buildRateLimitDisplay` のヘッダー表示と同じソースだが、Metrics タブでは残り時間 + percentage を別レイアウトで見せる。
- 両方 null のケース（proxy 未稼働・接続前）は明示的に「no data」表示。

### 色分け基準

| 要素 | GREEN | YELLOW | RED |
|------|-------|--------|-----|
| tokens 使用率（limit に対する consumed 割合） | < 70% | 70-89% | ≥ 90% |
| requests 使用率 | < 70% | 70-89% | ≥ 90% |
| burn rate projected | `projected ≥ 2 × reset_remaining` | `reset_remaining ≤ projected < 2 × reset_remaining` | `projected < reset_remaining`（RISK） |
| unified 5h/7d（既存ロジックと揃える） | < 70% | 70-89% | ≥ 90% |

### 更新頻度

- Metrics タブ active かつ dashboard visible の間: **1 秒**（`setInterval(loadMetricsData, 1000)`）
- 非 active になったら `clearInterval`（他タブで無駄に query しない）
- daemon 全体の refresh（eventBus 駆動）とは独立。Metrics は時系列的連続性が本質なので polling が妥当。

---

## 3. 変更対象

### 変更ファイル

| パス | 変更概要 |
|------|---------|
| `skills/cmux-team/manager/trace-store.ts` | `aggregateApiUsageByRole` / `aggregateApiUsageByTask` / `getLatestApiUsageRow` / `getBurnRateWindow` の 4 集計関数を追加。既存関数は触らない |
| `skills/cmux-team/manager/dashboard.tsx` | `AppState["activeTab"]` に `"metrics"` 追加、`AppState["focusedArea"]` に `"metrics"` 追加、`AppState` に `metricsData`/`metricsError` フィールド追加、`FOCUSED_AREA_FOR_TAB` / tab rotation / key bindings `"6"` + `M` / rendering 分岐 / footer / `loadMetricsData` / `switchTab` 拡張 / interval 管理を追加 |
| `skills/cmux-team/manager/i18n.ts` | `metrics_tab_title`, `metrics_tokens_label`, `metrics_burn_rate_label`, `metrics_projected_to_limit_label`, `metrics_risk_label`, `metrics_no_data_label` など Metrics タブ用ラベル（英日）を追加 |

### 新規ファイル

| パス | 内容 |
|------|------|
| `skills/cmux-team/manager/dashboard-metrics.ts` | Metrics タブの純粋 build 関数群（`buildMetricsRows`, `buildBurnRateBar`, `buildRoleTable`, `buildTaskTable`）。ink / Rezi UI 依存最小、テスト容易性のため専用モジュールに分離 |
| `skills/cmux-team/manager/dashboard-metrics.test.tsx` | `buildMetricsRows` 系のユニットテスト。`dashboard-issues.test.tsx` のパターンを踏襲 |
| `skills/cmux-team/manager/trace-store-metrics.test.ts` | 集計関数 4 つのユニットテスト。`trace-store.test.ts` と同じ `createDummyProject` + `initDB` パターン |

既存の `trace-store.test.ts` の `describe("trace-store: api_usage (T305)")` ブロック末尾に追加する案もあるが、Metrics 関連集計は **T307 の responsibility であることを明示**するため別ファイルに切り出す。

### 削除ファイル

なし。

---

## 4. サブタスク分割

### (1) 集計関数を `trace-store.ts` に追加

- **対象ファイル**: `skills/cmux-team/manager/trace-store.ts`
- **内容**:
  1. `AggregatedRoleRow` / `AggregatedTaskRow` / `BurnRateResult` 型を export
  2. `aggregateApiUsageByRole(db, { sinceIso, untilIso })` を実装（`GROUP BY role`, SUM/COUNT）
  3. `aggregateApiUsageByTask(db, { sinceIso, untilIso, limit })` を実装（`GROUP BY task_id`, 降順）
  4. `getLatestApiUsageRow(db)` を実装（`ORDER BY id DESC LIMIT 1`）
  5. `getBurnRateWindow(db, windowSec)` を実装（`WHERE timestamp >= datetime(...)` + SUM）
- **完了条件**:
  - 4 つの関数が export されていること
  - `bunx tsc --noEmit` で新規エラーなし
- **メソッド制約**:
  - 既存の `insertApiUsage` / `getApiUsage` と同じ `better-sqlite3` スタイル (`db.prepare(...).all()` / `.get()`)
  - `$param` バインディング（SQL インジェクション回避）
  - timestamp 比較は **TEXT カラムに対する ISO 8601 文字列比較** で OK（ISO 8601 は辞書順 = 時系列順）
- **検証コマンド**:
  - `grep -n 'aggregateApiUsageByRole\|aggregateApiUsageByTask\|getLatestApiUsageRow\|getBurnRateWindow' skills/cmux-team/manager/trace-store.ts`

### (2) 集計関数のユニットテストを追加

- **対象ファイル**: `skills/cmux-team/manager/trace-store-metrics.test.ts`（新規）
- **内容**:
  - `createDummyProject` + `initDB` → `insertApiUsage` × 複数レコードを仕込む → 集計関数を検証
  - ロール別 SUM、タスク別 SUM、最新 1 行、burn rate window の各ケース
  - **境界ケース**: 空テーブル、null 値混在（`input_tokens=null` の行は SUM で無視される挙動）、windowSec 境界（now-60s ちょうどの行）
- **完了条件**:
  - `bun test trace-store-metrics.test.ts` が green
  - 各関数につき最低 3 ケース（正常・空・境界）
- **メソッド制約**:
  - `trace-store.test.ts` の既存 `describe("trace-store: api_usage (T305)")` と同じセットアップ手順（`beforeEach` で DB 作成、`afterEach` で dispose）

### (3) Metrics タブ用の純粋 build 関数を追加

- **対象ファイル**: `skills/cmux-team/manager/dashboard-metrics.ts`（新規）
- **内容**:
  - `MetricsData` 型: `{ nowMs, tokensRemaining, tokensLimit, tokensResetIso, requestsRemaining, requestsLimit, requestsResetIso, burnTokPerSec, roleRows: AggregatedRoleRow[], taskRows: AggregatedTaskRow[], unifiedFive: number | null, unifiedSeven: number | null }`
  - `buildMetricsRows(data: MetricsData | null, error: string | null): any[]`
    - null → 「loading... / no data」
    - error → エラー文言
    - data あり → 3 セクション（上段 rate limit + burn rate、中段 role、下段 task）
  - `buildProgressBar(consumed, limit, width=16): string` — `████░░░░` 風のプログレスバー
  - `formatBurnRate(tokPerSec: number): string` — `1,240 tok/s`
  - `computeProjectedToLimit(remaining: number | null, burnTokPerSec: number): number | null`
  - `computeRiskLevel(projectedSec: number | null, resetRemainingSec: number | null): "green" | "yellow" | "red" | "gray"`
- **完了条件**:
  - 全関数が export され tsc エラーなし
  - rendering が Rezi `ui.row` / `ui.column` / `ui.text` のみで完結（Ink / hook 非依存）

### (4) Metrics タブ rendering のユニットテスト

- **対象ファイル**: `skills/cmux-team/manager/dashboard-metrics.test.tsx`（新規）
- **内容**:
  - null `MetricsData` → 1 行の loading メッセージが出る
  - 通常データ → tokens/requests bar + burn rate + roleRows + taskRows 各行が含まれる
  - error 付き → 最終行にエラー表示
  - RISK 判定: `projected < reset` のケースで RED 色コードを含む
  - 空 roleRows / 空 taskRows → empty メッセージ
- **完了条件**:
  - `bun test dashboard-metrics.test.tsx` green
  - テスト数: 最低 6
- **メソッド制約**:
  - `dashboard-issues.test.tsx` と同じく `stringifyRows(rows)` + `toContain()` 方式

### (5) `AppState` に metrics 関連フィールドを追加

- **対象ファイル**: `skills/cmux-team/manager/dashboard.tsx`
- **内容**:
  - `activeTab` 型に `"metrics"` を追加
  - `focusedArea` 型に `"metrics"` を追加
  - 新フィールド:
    - `metricsData: MetricsData | null`
    - `metricsError: string | null`
    - `metricsLastLoadedMs: number`（refresh 時刻の表示用）
  - `initialState` / `createNodeApp` で 3 フィールドを初期化
- **完了条件**:
  - `bunx tsc --noEmit` で新規エラー 0
- **検証コマンド**:
  - `grep -nE '"metrics"|metricsData|metricsError' skills/cmux-team/manager/dashboard.tsx`

### (6) `loadMetricsData()` ヘルパを実装

- **対象ファイル**: `skills/cmux-team/manager/dashboard.tsx`
- **内容**:
  - `openTraceDBReadOnly(projectRoot)` で `.team/traces/traces.db` を read-only open
  - `aggregateApiUsageByRole` / `aggregateApiUsageByTask` / `getLatestApiUsageRow` / `getBurnRateWindow` を並行呼び出し
  - 結果を `MetricsData` にまとめて `app.update((s) => ({ ...s, metricsData, metricsError: null, metricsLastLoadedMs: Date.now() }))`
  - エラー時: `metricsError` に message、`metricsData` は維持（stale フォールバック）
  - unified 値は `getState().rateLimit` から直接取得
- **完了条件**:
  - tsc green
  - 例外時に dashboard がクラッシュせず `metricsError` に message が入る
- **メソッド制約**:
  - DB コネクションは **1 呼び出し内で open → close** する（`loadIssuesFromCache` と同じ）
  - 例外は `log("metrics_load_error", ...)` で記録
  - `sinceIso` はデフォルト `now-1h`（直近 1h）

### (7) `switchTab("metrics")` + interval 管理

- **対象ファイル**: `skills/cmux-team/manager/dashboard.tsx`
- **内容**:
  - `switchTab` 拡張: `if (tab === "metrics") startMetricsTimer(); else stopMetricsTimer();`
  - `startMetricsTimer()`: 既存 `metricsInterval` があれば clear、`setInterval(loadMetricsData, 1000)` を起動、即時 1 回 `loadMetricsData()` を呼ぶ
  - `stopMetricsTimer()`: clearInterval + 変数 null
  - `cleanup()` 時に stop を呼ぶ
- **完了条件**:
  - Metrics タブから他タブに切り替えた後、1 秒経っても `metricsData` が更新されないこと（interval clear されている）
- **メソッド制約**:
  - `spinnerInterval` と変数を混同しない（別 handle）

### (8) キーバインド & Tab rotation の更新

- **対象ファイル**: `skills/cmux-team/manager/dashboard.tsx`
- **内容**:
  - `"6": () => switchTab("metrics")`
  - `M: () => switchTab("metrics")`
  - `Tab` の rotation 配列末尾に `"metrics"` を追加
  - 既存 `"1"-"5"` / `J/L/A/I/T` を維持
- **完了条件**:
  - 手動で 6 / M / Tab 一周でタブ遷移できる（手動検証）
- **検証コマンド**:
  - `grep -n '"metrics"' skills/cmux-team/manager/dashboard.tsx | wc -l`（少なくとも tab rotation + switchTab + rendering 分岐 + FOCUSED_AREA で 4 箇所）

### (9) rendering 分岐 & footer 追加

- **対象ファイル**: `skills/cmux-team/manager/dashboard.tsx`
- **内容**:
  - `state.activeTab === "metrics" ? buildMetricsRows(state.metricsData, state.metricsError) : ...` を既存チェーンに追加
  - `state.focusedArea === "metrics"` の footer 追加: `↑/↓ scroll / ESC back`（当面 scroll は不要だが一貫性のため軸を合わせる）
  - global footer のヘルプキーに `M` / `6` を追加
  - タブバーに Metrics ラベルを追加（`ui.button({ id: "tab-metrics", label: t("metrics_tab_title"), ... })`）
- **完了条件**:
  - Metrics タブが既存 5 タブと同様に表示される
- **メソッド制約**:
  - `buildMetricsRows` は `dashboard-metrics.ts` から import

### (10) i18n ラベル追加

- **対象ファイル**: `skills/cmux-team/manager/i18n.ts`
- **内容**:
  - `metrics_tab_title` (Metrics / メトリクス)
  - `metrics_section_rate_limit`, `metrics_section_role`, `metrics_section_task`
  - `metrics_label_tokens`, `metrics_label_requests`, `metrics_label_burn_rate`, `metrics_label_projected`, `metrics_label_risk`, `metrics_label_no_data`
  - `metrics_unit_tok_per_sec` (`tok/s`)
  - `metrics_empty_role`, `metrics_empty_task`, `metrics_loading`
- **完了条件**:
  - en / ja 両方揃っている
  - dashboard-metrics.ts から参照する全キーが欠落なく存在

### (11) 手動動作確認

- **対象**: 実環境（cmux-team start で daemon 起動 → 複数タスクを並列実行）
- **内容**:
  1. Metrics タブに切り替える（6 or M）
  2. burn rate 数値が spawn 中は増加、idle 時は 0 近辺に落ちる
  3. 色分け: tokens 残量低下で YELLOW/RED に推移
  4. 他タブ切替 → Metrics に戻っても値が再取得される
  5. 既存タブ（journal / artifacts / log / settings / issues）の挙動に regression なし
  6. タブバーの順序と footer ヘルプキーが正しい
- **完了条件**:
  - 上記 6 項目を確認済み

### (12) 既存テスト swap 互換性の確認

- **内容**: `dashboard-issues.test.tsx` の `makeState()` が `metricsData` / `metricsError` / `metricsLastLoadedMs` 未指定で型エラーを起こさないよう、**新規フィールドは optional にしない**（AppState の型整合性を維持しつつ）、`makeState` を更新して 3 フィールドを初期値付きで追加する。
- **完了条件**:
  - `bun test dashboard-issues.test.tsx` green（変更前と同じ件数 pass）
- **メソッド制約**:
  - AppState を optional で逃がすと全箇所に `?` チェックが伝播するので、**既存テストヘルパ側で初期値を埋める**のが正解

---

## 5. リスク

| # | リスク | 緩和策 |
|---|--------|--------|
| R1 | 既存 5 タブの rendering が壊れる（tab rotation / key binding のレグレッション） | 既存 `"1"-"5"` / `J/L/A/I` を**温存**し、`"6"` / `M` / tab rotation 末尾に**追加**するだけ。既存ケースは `dashboard-issues.test.tsx` に加えて手動 smoke test で確認 |
| R2 | Metrics タブ初回描画時のエッジケース: api_usage 0 行、rate limit ヘッダー未取得、proxy 未稼働 | `buildMetricsRows(null, null)` / `buildMetricsRows(data, error)` の両経路を明示ユニットテストで担保。色 GRAY + "no data" 表示でグレースフル |
| R3 | 1 秒間隔の SQLite query で CPU / I/O 負荷が上がる | 4 クエリとも index が効き < 10ms と見積もられる。万一負荷が見えたら window を 300s に広げるか interval を 2s に緩める（計測してから判断、初期は 1s で出す） |
| R4 | `MetricsData` を AppState に持たせたことで既存テストヘルパ `makeState()` が壊れる | サブタスク (12) で 3 フィールドを初期値付きで追加、`dashboard-issues.test.tsx` の green を維持 |
| R5 | dashboard と daemon が同一 process なのに traces.db を dashboard 側で重複 open する | `better-sqlite3` は複数接続を許容。**read-only** + `close()` 明示で leak 回避。長時間保持せず都度 open/close（loadIssuesFromCache と同じ方針） |
| R6 | タスク別ランキングが taskId=null 行（Master など）でも SUM 対象になり「無名タスク」行が出る | `WHERE task_id IS NOT NULL` で除外。ロール別側は `role IS NULL` を `unknown` に fallback |
| R7 | Metrics タブ active のまま daemon 再起動・DB 破損 | `loadMetricsData` の try/catch で `metricsError` に message、タブは落ちない。次の 1s tick で再試行 |
| R8 | 集計関数が null 値の SUM を誤計上（SQLite は NULL を無視するので 0 扱い） | `SUM(input_tokens)` は NULL 行を除外した合計。`COALESCE(SUM(...), 0)` で `null → 0` を明示。テストケースで担保 |

### テスト戦略

- **集計層**: `trace-store-metrics.test.ts` で純粋な SQLite ベースのユニットテスト。境界ケース（空、null 混在、windowSec 境界）を 4 関数 × 3 ケース = 12 件程度。
- **表示層**: `dashboard-metrics.test.tsx` で `buildMetricsRows(...)` を純粋関数として呼ぶ。Rezi `ui.row` / `ui.text` の戻り値を JSON stringify → `toContain` パターン（`buildIssueRows` 先例と同じ）。
- **統合**: dashboard.tsx 本体の `loadMetricsData` / `switchTab` / interval 管理は ink コンポーネント経由で自動テスト不可のため **手動 smoke test**（サブタスク 11）で補う。既存 `dashboard-issues.test.tsx` が Issues タブの rendering 層だけテストしているのと同じ粒度感。
- **レグレッション**: `bun test` 全体で green を保つ。特に `dashboard-issues.test.tsx` / `rate-limit-display.test.ts` / `trace-store.test.ts` が影響受けないこと。

---

## 6. 既存型エラーの先読み

実行: `cd skills/cmux-team/manager && bunx tsc --noEmit 2>&1 | grep -E "^(dashboard\.tsx|trace-store\.ts|rate-limit-display\.ts|dashboard-issues\.test\.tsx|trace-store\.test\.ts)"`

### 6.1 本タスクのスコープで解消するエラー

該当なし。触る予定のファイル群（`dashboard.tsx` / `trace-store.ts` / `rate-limit-display.ts` / `i18n.ts` / `dashboard-issues.test.tsx` / `trace-store.test.ts`）にはいずれも既存 tsc エラーは存在しない。

### 6.2 後続タスク（cleanup）に分離するエラー

| ファイル | エラー | 分離理由 | 予定 cleanup タスク名 |
|---------|-------|---------|---------------------|
| `conductor.ts(201,3)` | `TS1016: A required parameter cannot follow an optional parameter` | T307 のスコープ（dashboard / trace-store 集計）と無関係、修正すると conductor 起動ロジックに波及 | `conductor-ts-ts1016-cleanup` |
| `daemon.ts(1558,22)` | `TS2352: SESSION_STARTED 分岐の unsafe cast` | 同上。hook 受信経路の型絞り込み修正は別タスクで扱うべき | `daemon-session-started-narrowing-cleanup` |
| `daemon.test.ts(3870,9)` | `TS2322: "new_session" は source 型に無い` | 同上、test fixture 側の type 整合修正。T216 / T266 の hook 型定義と紐付き別 scope | `daemon-test-session-source-cleanup` |

上記 3 件は T307 の **変更対象ファイルに含まれない** ため、本タスクでは触らない（sub-task 1-12 で編集するファイルに error は発生しない）。

---

## 7. Decision Log

| ID | 検討事項 | 結論 | 理由 |
|----|---------|------|------|
| D1 | burn rate のウィンドウサイズ | **60 秒固定** | Anthropic の分単位 rate limit window と整合。300s では平均化しすぎてリアルタイム感が失われる。60s は CLI で意識的に「バーンアウト対策」を考える粒度として人間の直感にも近い |
| D2 | ロール別テーブルの履歴スパン | **直近 1h を既定、セッション開始からの累積は Out of Scope 扱い** | 「今消費している」観測が本質。セッション累積は `cmux-team trace-task` で既に見られる。Metrics タブは時系列リアルタイムに徹する |
| D3 | キーバインド | **`"6"` と `M` の両方** | 既存 `"1"-"5"` + `J/L/A/I` のパターンに合わせる。数字は位置ベース、文字は意味ベースで並立が慣習 |
| D4 | 集計ロジックの配置 | **`trace-store.ts` に集計関数を新設。`dashboard-metrics.ts` は純粋表示関数のみ** | DB SQL は trace-store の責務、UI build は dashboard の責務。**責務分担 + テスト容易性**。既存の `getApiUsage` / `insertApiUsage` と同じ層に並ぶ自然な位置 |
| D5 | `MetricsData` を `AppState` に載せるか独立 hook にするか | **`AppState` に載せる** | 既存 `issueItems` / `journalEntries` / `logLines` と同じ方針。state 一元化で snapshot テストしやすい |
| D6 | 更新間隔 | **1 秒（Metrics active 時のみ）** | 秒単位 burn rate を見せる以上 1s 必要。他タブ時は 0 tick（interval clear）で DB 負荷ゼロ |
| D7 | 分単位 rate limit と unified 5h/7d をどう並べるか | **上段に両方、分単位を大きく、unified は小さく併置** | 両軸とも独立した観測価値あり。unified はヘッダーにも出ているが Metrics タブでは「数値 + リセット時刻」を別レイアウトで見せる。冗長ではなく補完 |
| D8 | taskId=NULL 行の扱い | **ロール別集計: 含める（`role` が null でも `unknown` に fallback）／ タスク別集計: 除外（`WHERE task_id IS NOT NULL`）** | ロール別は「master/conductor/agent 横断」で全消費を見たい用途、タスク別ランキングは「どのタスクが重いか」で NULL 行は無意味 |
| D9 | DB 接続の寿命 | **1 回の `loadMetricsData` 内で open → close** | `loadIssuesFromCache` と同じ方針。leak リスク低、再入安全、daemon 側の DB writer と競合しない（SQLite WAL モード）|
| D10 | エラー時の表示方針 | **直前の `metricsData` を保持して `metricsError` だけ更新（stale-while-error）** | 一瞬の DB lock や I/O エラーで画面がリセットされる UX を避ける。error は最終行に別文脈で表示 |
