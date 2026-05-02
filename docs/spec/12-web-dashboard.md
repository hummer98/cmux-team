# 12. Web ダッシュボード

> Manager daemon に同居する内部 HTTP server（`127.0.0.1:<ephemeral>`）が配信する 5 ページ SPA の仕様。
> retrospective 観察（observatory）強化のための UI で、real-time 観察（cmux ペイン）と TUI Metrics タブと共存する。

---

## 1. 概要

### 位置付け

cmux-team は **AI 観察箱（observatory）** であり（[`00-project-overview.md`](00-project-overview.md) 参照）、観察は二層構造を取る:

- **real-time 観察**: cmux ペイン
- **retrospective 観察**: `cmux-team metrics` CLI / **本 Web ダッシュボード** / cohort 比較

本ダッシュボードは retrospective 観察のうち「time-series グラフ・分布・drill-down」を担当する。CLI はそのまま残り（snapshot / cohort 比較 / 自動化に向く）、TUI Metrics タブも従来通り表示される。本ダッシュボードはそれらを置き換えず**追加**する。

### スコープ

| in scope | out of scope |
|---|---|
| Bun.serve 同居（`127.0.0.1:0` ephemeral） | 認証・ACL（127.0.0.1 限定でユーザー想定） |
| `team.json.dashboardServer.url` への atomic write | マルチ project 横断 |
| 7 endpoint × `?from&to` 共通クエリ | SSE / WebSocket |
| 5 ページ SPA（Overview / Tool Use / Agent Strategy / Tokens / Tasks） | サーバ側 export API |
| Agent 戦略の自動分類（6 値） | TUI Metrics タブの縮小（後続） |

---

## 2. 起動経路と port 公開ルール

### 2.1 同居プロセス

`Manager daemon`（Bun process）内で、proxy.ts と並んで `dashboard-server.ts` が `Bun.serve` を立ち上げる。**プロセスは 1 本に統合**（独立プロセスにしない）:

```
[Manager daemon (Bun)]
  ├── proxy.ts             Bun.serve(port=preferredPort)        0.0.0.0
  ├── dashboard-server.ts  Bun.serve({ hostname: "127.0.0.1", port: 0 })  ← 本 spec
  ├── EventBus / state
  └── dashboard.tsx (TUI)
```

### 2.2 SQLite ハンドル取得方針 — B 案（自前 initDB）

dashboard-server は **常に自前で `initDB(PROJECT_ROOT)`** を呼ぶ。proxy.ts の traceDb は共有しない。

| 採用理由 | 詳細 |
|---|---|
| `main.ts:752-759` のスコープ設計を侵さない | proxy 再利用パス (`existingProxyPort != null`) では traceDb を本プロセスでは開かない既存方針と整合 |
| 自己完結 | dashboard-server.ts は consts/関数の import のみで proxy.ts に依存しない |
| 単純な責務分離 | dashboard が自分で開いて自分で閉じる（テスト経路で `handle.stop()` 時のみ close） |

WAL mode の `bun:sqlite` は同一プロセス内・別プロセス間で複数 Database インスタンスの並走に安全である。

### 2.3 port 公開: `team.json.dashboardServer.url`

dashboard-server は team.json を**直接書かない**。`DaemonState.dashboardServerUrl` を経由し、既存 `updateTeamJson` (`daemon.ts:4141`) で他フィールドと同じ tmp+rename atomic write 経路に乗る:

```json
{
  ...
  "dashboardServer": { "url": "http://127.0.0.1:54321", "schemaVersion": 1 }
}
```

ephemeral port なので **daemon 再起動で URL は変わる**。ブックマークは無意味。利用側は `cat .team/team.json | jq -r .dashboardServer.url` で都度参照する。

### 2.4 lifecycle — shutdown 時に明示停止しない

`shutdown()` (`main.ts:816`) および `onFullQuit` 経路では **`server.stop()` を呼ばない**。process.exit による OS 級の close に委ねる。

| 理由 | |
|---|---|
| 既存 proxy の方針と整合 | `main.ts:815` 付近のコメントで「quit 時は proxy を停止しない」と既存方針が明記 |
| in-flight な fetch を破壊しない | server.stop() は SPA の polling fetch を中途切断し SPA に `TypeError: Failed to fetch` を出す |
| 責務最小 | dashboard は SQLite を read-only で握っているだけで commit/flush 義務なし |

> **テスト時のみ例外**: `dashboard-server.test.ts` では Bun.serve を生かしたままだとテストランナーがハングするため、テスト経路に限り `handle.stop()` を呼ぶ。本番 lifecycle では呼ばない。

---

## 3. listen address と security

### 3.1 listen は 127.0.0.1 のみ

`Bun.serve({ hostname: "127.0.0.1", port: 0 })` を必ず指定する。外部 interface には bind しない。`?from` `?to` parse 失敗・`from > to` などのバリデーションは API 層で行う。

> 注: macOS / Linux で `0.0.0.0` への fetch が `127.0.0.1` にルーティングされる挙動は OS 仕様であり、bind 制約とは別問題。テストは bind ルール (`hostname: "127.0.0.1"` 指定 + URL prefix `http://127.0.0.1:`) で代替検証する。

### 3.2 CSP（4 + extra directive）

全 response（HTML / JSON）に以下を付与する:

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'
```

inline `<style>` / `<script>` を許可するため `style-src` / `script-src` に `'unsafe-inline'` を含める。SPA は単一 HTML に CSS / JS をすべて inline するため必須。

### 3.3 Cache-Control

すべての response に `Cache-Control: no-store` を付与する（観察値の即時性を優先）。サーバ側 response cache は導入しない。

---

## 4. API endpoint 一覧と response schema

| Path | 役割 | 主なクエリ |
|---|---|---|
| `GET /` | SPA HTML を返す（CSS / uPlot / JS は inline） | — |
| `GET /api/health` | server 起動状態（ok / version / uptime / proxyPort） | — |
| `GET /api/overview` | throughput stacked bar / failure-rate sparkline / tokens stacked area / risk badge | `?from&to` |
| `GET /api/tool-use` | per-tool calls / per-tool failure rate / failure timeline / deny timeline / recent failures | `?from&to` |
| `GET /api/agent-strategy` | strategy distribution / per-task / spawn timeline | `?from&to` |
| `GET /api/agent-strategy/:taskId` | drill-down: conductor + agent タイムライン + outcome | — |
| `GET /api/tokens` | timeline stacked area / Top tasks / per-role / per-task histogram | `?from&to` |
| `GET /api/tasks` | per-task table（sortable / CSV export 用 source） | `?from&to` |

### 4.1 共通 query

`?from=ISO&to=ISO` を全集計 endpoint で受け取る。`from` 既定 = `now - 24h`、`to` 既定 = `now`。ISO 8601 UTC を期待し、parse 失敗時は 400。

### 4.2 Response schema（TypeScript）

実装は `dashboard-server.ts` の export と一致する。

```ts
interface PeriodQuery { fromIso: string; toIso: string }
type RiskLevel = "green" | "yellow" | "red" | "gray"
interface ProjectionInfo { utilization: number | null; resetIso: string | null; risk: RiskLevel }

interface HealthResponse {
  ok: true; version: string; projectRoot: string;
  startedAt: string; uptimeSec: number;
  proxyPort: number | null; serverPort: number;
  schemaVersion: 1;
}
interface OverviewResponse {
  period: PeriodQuery;
  throughput: Array<{ bucket: string; assigned: number; completed: number; aborted: number; forced_close: number }>;
  toolFailureRate: Array<{ bucket: string; pre_total: number; failures: number; rate: number }>;
  tokens: Array<{ bucket: string; input: number; output: number; cache_creation: number; cache_read: number }>;
  activeTasks: { count: number; taskIds: string[] };
  rateLimit: { projection5h: ProjectionInfo; projection7d: ProjectionInfo };
}
interface ToolUseResponse {
  period: PeriodQuery;
  perTool: Array<{ tool_name: string; calls: number }>;
  perToolFailure: Array<{ tool_name: string; total: number; failures: number; rate: number }>;
  failureTimeline: Array<{ bucket: string; bash: number; other: number }>;
  denyTimeline:    Array<{ bucket: string; pre_total: number; denied: number; rate: number }>;
  recentFailures:  Array<{ timestamp: string; task_id: string | null; tool_name: string; error: string }>;
}
interface AgentStrategyResponse {
  period: PeriodQuery;
  perTask: Array<{ task_id: string; roles: Record<string, number>; label: AgentStrategyLabel }>;
  distribution: Record<AgentStrategyLabel, number>;
  spawnTimeline: Array<{ bucket: string; counts: Record<string, number> }>;
}
type AgentStrategyLabel = "solo" | "research-only" | "plan-impl" | "parallel-impl" | "full-cycle" | "other"
interface AgentStrategyDrillDownResponse {
  task_id: string;
  conductor: { surface: string | null; assignedTs: string; closedTs: string | null;
               outcome: "completed" | "aborted" | "state_mismatch" | "forced_close" | "open" };
  agents: Array<{ role: string; surface: string; spawnedTs: string; closedTs: string | null; sessionId: string }>;
}
interface TokensResponse {
  period: PeriodQuery;
  timeline: Array<{ bucket: string; input: number; output: number; cache_creation: number; cache_read: number }>;
  topTasks: Array<{ task_id: string; input: number; output: number; cache: number; requests: number }>;
  perRole:  Array<{ role: "master" | "conductor" | "agent" | "unknown"; input: number; output: number; cache: number; requests: number }>;
  perTaskHistogram: { bins: number[]; counts: number[]; median: number; p95: number; max: number };
}
interface TasksResponse {
  period: PeriodQuery;
  rows: Array<{
    task_id: string; outcome: string;
    assigned_ts: string; closed_ts: string | null; duration_ms: number | null;
    tool_call_total: number; tool_failure_rate: number;
    tokens: { input: number; output: number; cache: number; requests: number };
    agent_count: number; time_to_first_edit_ms: number | null;
  }>;
}
/** 400 / 404 / 500 / 503 共通 error */
interface ApiErrorResponse { error: string; message?: string; endpoint?: string; windowSec?: number }
```

### 4.3 エラー設計

| status | 条件 | レスポンス body |
|---|---|---|
| 200 | 正常 | `application/json` の各 ResponseShape |
| 400 | `?from` / `?to` の ISO 8601 parse 失敗、または `from > to` | `{ "error": "bad_request", "message": "..." }` |
| 404 | endpoint 不一致、`/api/agent-strategy/:taskId` の taskId 不在 | `{ "error": "not_found" }` |
| 500 | SQLite throw / events.jsonl I/O 例外 | `{ "error": "internal", "message": "..." }` + `manager.log` に `dashboard_server_error` |
| 503 | 集計タイムアウト（5s 超え） | `{ "error": "timeout", "endpoint": "...", "windowSec": 5 }` + `manager.log` に `dashboard_server_timeout` |

### 4.4 Timeout race（5s）

各 endpoint ハンドラ内で集計呼び出しを以下で囲む:

```ts
Promise.race([
  aggregator(...),
  sleep(5000).then(() => TIMEOUT_SENTINEL),
])
```

TIMEOUT が返ったら 503。`Bun.serve` の `idleTimeout` は 30s デフォルトのままで、5s が race 内で先に発火する。`AbortSignal` を `metrics-aggregate.ts` 全体に通す改修は本タスクで行わない（SSOT を破壊しないため）。timeout 後も background で集計が完走するが GC に任せる。

---

## 5. SSOT 原則 — 集計は trace-store / metrics-aggregate / agent-strategy

dashboard-server.ts は **集計しない**。SSOT は以下に分散:

| SSOT | 担当 |
|---|---|
| `metrics-aggregate.ts` | events.jsonl reader + per-task / per-bucket 集計 |
| `trace-store.ts` | 全 SQL（`countToolCallsByPeriod` / `failureRateByTool` / `aggregateApiUsageByBucket` 等の T414 追加分含む） |
| `agent-strategy.ts` | 6 値分類 + agent_spawned 集約 + drill-down |
| `dashboard-metrics.ts` | TUI Metrics タブ用（本タスクで未変更） |
| `dashboard-server.ts` | routing + period parse + ResponseShape 整形 + timeout race のみ |

dashboard-server は集計関数を **DI で受け取れる**（`opts.aggregators`）。テストで一部だけ never-resolve に差し替えて 503 race を検証する。

---

## 6. HTML ページ構成

### 6.1 単一 HTML 配信

`skills/cmux-team/manager/dashboard-web/{index.html, style.css, app.js, vendor/{uplot.min.js, uplot.min.css, UPLOT_VERSION}}` を `dashboard-web-bundle.ts` が起動時に読み、4 placeholder (`/*__INLINE_CSS__*/` `/*__INLINE_UPLOT__*/` `/*__INLINE_UPLOT_CSS__*/` `/*__INLINE_APP__*/`) を置換して 1 HTML を返す。**外部 fetch ゼロ**。

### 6.2 SPA — vanilla JS

フレームワーク不採用（5 ページ × グラフ中心 × URL に状態集約できる）。

| 状態 | 永続化先 |
|---|---|
| 時間範囲 | `?from=ISO&to=ISO` |
| 自動 refresh ON/OFF | `?refresh=on/off` |
| 現在ページ | URL hash `#page` |
| Agent Strategy drill-down | hash 内 query `#agent-strategy?task=414` |

**permalink 不変条件**: 任意の URL を copy → 別タブで開く → 同じ画面・同じ時間範囲で表示される（server side 状態を持たないため）。

### 6.3 5 ページのレンダリング責務

| ページ | endpoint | グラフ要素 |
|---|---|---|
| Overview | `/api/overview` | throughput stacked bar (Canvas) / failure-rate sparkline (uPlot) / tokens stacked area (uPlot) / risk badge (DOM) |
| Tool Use | `/api/tool-use` | per-tool horizontal bar (Canvas) / per-tool failure table (DOM) / failure timeline 2 系列 (uPlot) / deny timeline (uPlot) / recent table (DOM)。**Bash 強調** |
| Agent Strategy | `/api/agent-strategy` (+drill-down) | role × 起動回数 stacked bar (Canvas) / strategy 円 (Canvas) / spawn timeline stacked (Canvas) / drill-down timeline (DOM) |
| Tokens | `/api/tokens` | timeline stacked area (uPlot) / Top tasks ranking (DOM) / per-role pie (Canvas) / histogram (Canvas) |
| Tasks | `/api/tasks` | sortable table (DOM) / CSV export button (Blob URL) / 行クリック → Agent Strategy drill-down hash 連携 |

時間範囲 picker（preset chip + custom datetime）と sidebar nav は全ページ共通。auto refresh は `setInterval(render, 30_000)` で `state.refreshOn` を見て再 render。

### 6.4 Bash 強調 (Tool Use)

`tool_name === "Bash"` の行は per-tool table と failure 表で:

- **色付き**: `.bash-row` （warm warning 系の class）
- **table 上位ピン留め**: calls の sort 後でも Bash 行を先頭に固定（`pinBash()` 関数）
- **horizontal bar**: 太線描画（emphasize stroke）

即興スクリプト失敗の指標として視覚的に最優先で目に入るようにする（Design Reviewer rev2 §4.2 #3）。

### 6.5 手動検証チェックリスト

CI では SPA の自動描画テストはしない。本 spec のチェックリストを PR 内で手動実行:

- [ ] 5 ページ全て描画される
- [ ] preset chip [1h / 24h / 7d / 30d] で全グラフが連動する
- [ ] custom datetime ピッカーで任意範囲が指定できる
- [ ] permalink: URL を別タブで開いても同じ表示
- [ ] task drill-down: Tasks の行クリック → Agent Strategy drill-down にジャンプ
- [ ] 30s auto refresh ON / OFF
- [ ] 過去 task の Agent Strategy drill-down が timeline 表示される

---

## 7. Agent 戦略分類規則（暫定）

`agent-strategy.ts` の純粋関数 `classifyStrategy(roles)` で分類する。

| Label | 条件 |
|---|---|
| `solo` | total = 0（agent_spawned 行なし） |
| `research-only` | researcher のみ（total === count(researcher)） |
| `plan-impl` | planner ≥ 1 かつ implementer ≥ 1 かつ total === planner + implementer |
| `parallel-impl` | implementer ≥ 2 |
| `full-cycle` | researcher + planner + implementer + reviewer すべて ≥ 1 |
| `other` | 上記以外 |

**規則は暫定**。実データを見て再分類する想定。差し替え容易性のため pure function に分離してある（テストファイル `agent-strategy.test.ts` の 7 ケースで境界カバー済み）。

---

## 8. uPlot vendoring 方針

| | 方針 |
|---|---|
| バージョン | uPlot **v1.6.31** （MIT） |
| 配置 | `skills/cmux-team/manager/dashboard-web/vendor/uplot.min.js` + `uplot.min.css` |
| バージョン管理 | `vendor/UPLOT_VERSION` プレーンテキストにバージョン番号 |
| 更新 | 手動。npm dep を増やさない（ルート `package.json` を肥大化させない） |
| ライセンス | MIT。再配布可 |
| security advisory | 出たら `vendor/UPLOT_VERSION` を base に手動更新 |

**npm dep を増やさない理由**:

1. ルートの `package.json` (npm publish 対象) に依存を増やすと postinstall / install サイズ・互換性検証コストが乗る
2. `manager/package.json` は private で bun のみ使う想定。フロントエンド bundling step を導入すると `package.json` の `files` glob と publish 経路が複雑化
3. vendor ファイル 1 個で済むなら、build step 不要のまま単一 HTML を返せる

---

## 9. TUI 連携（後続 T-2）

本タスクでは未実装。後続タスクで以下を導入予定:

- Master の TUI / Metrics タブに「Open dashboard」コマンドを追加し、ブラウザ起動の摩擦を減らす
- README に URL 取得方法 1 行追記（現状は CLAUDE.md の「進捗情報の取得方法」のみ）

---

## 10. 関連 spec / コード

- spec: [`11-metrics.md`](11-metrics.md)（CLI 側の SSOT）/ [`05-install-and-infrastructure.md`](05-install-and-infrastructure.md)（`.team/team.json` 構造）/ [`00-project-overview.md`](00-project-overview.md)（observatory コンセプト）
- 実装:
  - `skills/cmux-team/manager/dashboard-server.ts` — Bun.serve + routing + 7 endpoint + timeout race
  - `skills/cmux-team/manager/dashboard-web-bundle.ts` — HTML/CSS/JS 連結
  - `skills/cmux-team/manager/dashboard-web/` — index.html / style.css / app.js / vendor/
  - `skills/cmux-team/manager/agent-strategy.ts` — 6 値分類 + drill-down
  - `skills/cmux-team/manager/trace-store.ts` — 新規 SQL: `countToolCallsByPeriod` / `failureRateByTool` / `aggregateApiUsageByBucket`
  - `skills/cmux-team/manager/main.ts` — startDashboardServer の lifecycle 統合
  - `skills/cmux-team/manager/daemon.ts` — `DaemonState.dashboardServerUrl` + `team.json.dashboardServer` 書き出し
- テスト:
  - `dashboard-server.test.ts` — health / endpoint shape / 400 / 404 / 503 timeout / HTML inline 置換
  - `agent-strategy.test.ts` — classifyStrategy 7 ケース / SQL 集計 / drill-down
  - `trace-store-metrics.test.ts` — 新規 SQL 4 ケース（空 / 件数降順 / since-until 境界 / hour vs day bucket key）
