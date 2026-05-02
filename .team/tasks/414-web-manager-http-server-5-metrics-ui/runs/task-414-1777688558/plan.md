# T414 実装計画書 — 内部 Web ダッシュボード

> Manager daemon 同居 HTTP server + 5 ページ Metrics UI

---

## 1. 概要

### 目的

現行の TUI Metrics タブ (`dashboard-metrics.ts` + `dashboard.tsx` の Metrics 分岐) は文字情報密度の限界に達しており、time-series グラフ・分布表示・drill-down・cohort 比較に向かない。Manager daemon プロセス内に `Bun.serve({ hostname: "127.0.0.1", port: 0 })` で内部 HTTP server を同居させ、ブラウザで開く Web ダッシュボードを提供する。CLI/snapshot/cohort 比較はそのまま CLI に残し、Web は **観察可能性 (observatory) 強化のための retrospective 観察 UI** として位置付ける（CLAUDE.md「観察箱」節を参照）。

### スコープ（本タスク T414）

- HTTP server を Manager daemon lifecycle に同居（ephemeral port、`127.0.0.1` only）
- `team.json.dashboardServer.url` への atomic write（`updateTeamJson` 経由）
- 7 endpoint × 共通クエリ `?from=ISO&to=ISO`（`/api/health` 含む）
- 5 ページ SPA（Overview / Tool Use / Agent Strategy / Tokens / Tasks）を単一 HTML にインライン
- Agent 戦略の自動分類 (`solo / research-only / plan-impl / parallel-impl / full-cycle / other`)
- `docs/spec/12-web-dashboard.md` 新設、`00-project-overview.md` / `glossary.md` / `CLAUDE.md` への参照追記
- 既存集計関数の period 対応化（**ほぼ既存のまま流用可能**。詳細は §4.1）
- 既存 TUI Metrics タブ・既存 CLI (`cmux-team metrics`) は本タスクで未変更

### 非スコープ（後続 T-2 以降）

- TUI Metrics タブの縮小 / 「URL を開く」プロンプト導線
- マルチ project 横断ダッシュボード
- 認証・ACL（127.0.0.1 のみ受け付ける時点で localhost 共有 user 想定）
- Server-Sent Events / WebSocket（**polling refresh 30s** で十分）
- エクスポート（CSV は Tasks ページのクライアント側で生成、サーバ側エクスポート API は不要）

---

## 2. アーキテクチャ

### 2.1 Manager daemon との同居方式

既存 `proxy.ts` (Anthropic 透過プロキシ) と並んで、新規 `dashboard-server.ts` を `Bun.serve` で立ち上げる。**プロセスは Manager daemon 1 本に統合**（独立プロセス化はしない）：

```
[Manager daemon process (Bun)]
  ├── proxy.ts             Bun.serve(port=preferredPort)   0.0.0.0   <- 既存
  │     └── traceDb (writer, WAL mode)  ※proxy 再利用パスでは未起動
  ├── dashboard-server.ts  Bun.serve(hostname=127.0.0.1, port=0)     <- 新規
  │     └── dashboardDb (reader, WAL mode)  ※常に自前で initDB を呼ぶ
  ├── EventBus / state
  └── dashboard.tsx (TUI)
```

**proxy.ts と分離する理由**:

- proxy.ts の責務は「Anthropic API 透過 + traces 書き込み」で、外部公開ポート（ANTHROPIC_BASE_URL）。混入させると `127.0.0.1` only 制約を proxy にも被せることになり、別プロセスから proxy を叩く運用 (`spawn-agent` 等) を壊す。
- proxy が `0.0.0.0`、dashboard が `127.0.0.1` と listen address ポリシーが異なる。
- proxy.ts は既に 1200 行超で、UI 配信ロジックを足すと責務肥大化。

**SQLite ハンドル取得方針**: dashboard-server は **常に自前で `initDB(PROJECT_ROOT)` を呼ぶ**（rev1 で B 案に確定）

WAL mode の `bun:sqlite` は同一プロセス内・別プロセス間を問わず複数 Database インスタンスの並走に安全である。proxy.ts が開いている `traceDb` を **共有しない** ことで、以下の利点を得る:

1. `main.ts:752-759` のコメントブロックで明示されている「proxy 再利用パス (`existingProxyPort != null`) では traceDb を本プロセスでは開かない」というポリシーを侵さない（共有方式だと proxy 再利用時のみ未定義参照が起こり、main.ts のスコープ設計を変える必要がある）
2. dashboard-server が自己完結し、proxy.ts への依存が consts/関数の import のみに留まる（テストでも `initDB(tmpdir)` だけで隔離できる）
3. 起動失敗・再試行時の責務分離が単純（dashboard が自分で開いて自分で閉じる）

`main.ts` から dashboard-server に渡すのは `projectRoot` / `version` / `getState` / `now()` のみ（`db` は渡さない）。dashboard-server.ts 内で `initDB(projectRoot)` を呼んで保持する。

> rev1 補足: §5.1 の擬似コードで `const dashboardDb = traceDb ?? initDB(PROJECT_ROOT)` と書いていた箇所は B 案に合わせて削除。B 案を採用した理由は、main.ts:752-759 のコメントブロック（proxy 再利用パスでは traceDb を意図的に開かない）と整合させるため。A 案（main.ts に `let traceDbHandle` を宣言して proxy 起動/再利用双方でセット）も実装可能だったが、main.ts 側のスコープ変更が増え、proxy.ts 側のリファクタも誘発するため採用しない。

### 2.2 新規ファイルツリー

```
skills/cmux-team/manager/
├── dashboard-server.ts          # 新規: Bun.serve + ルーター + JSON endpoint
├── dashboard-server.test.ts     # 新規: routing / response shape のユニットテスト
├── dashboard-web/               # 新規: HTML/CSS/JS と vendor グラフライブラリ
│   ├── index.html               # 単一 HTML (SPA)
│   ├── app.js                   # 5 ページ SPA ロジック
│   ├── style.css                # 最小限の CSS（dark theme + sidebar layout）
│   └── vendor/
│       └── uplot.min.js         # uPlot v1.6.31 vendored（npm dep を増やさないため）
├── dashboard-web-bundle.ts      # 新規: 上記 4 ファイルを Bun.file で束ねて HTML 1 発を返す
├── agent-strategy.ts            # 新規: task_sessions の集約 + 6 値分類関数
├── agent-strategy.test.ts       # 新規
└── (既存) main.ts / proxy.ts / metrics-aggregate.ts / trace-store.ts / ...
```

`docs/spec/12-web-dashboard.md` を新設。`README.md` は本タスクでは触らない（将来 T-2 で「URL を開く」UX を追加するときに 1 行追記する）。

`package.json` の `files` 配列に **`skills/cmux-team/manager/dashboard-web/**`** を追加（npm publish に同梱）。`*.test.ts` は既存の exclude パターンで除外される。

---

## 3. 依存追加判断

### 評価対象

| 候補 | bundle サイズ (gzip) | ライセンス | time-series 適性 | npm dep 化 |
|---|---|---|---|---|
| **uPlot** | ~40 KB / ~14 KB gz | MIT | ◎ time-series specialized、Canvas 高速 | 不要（vendored） |
| Chart.js v4 | ~210 KB / ~70 KB gz | MIT | △ 汎用、time-series は plugin 経由 | npm dep 化が前提 |
| Apache ECharts | ~1 MB+ / ~340 KB gz | Apache-2.0 | ◎ 最も豊富、巨大 | npm dep 化が前提 |
| 自前 SVG / Canvas | 0 KB | — | × 工数大 | — |

### 結論: **uPlot を `skills/cmux-team/manager/dashboard-web/vendor/uplot.min.js` に vendor**

- **bundle**: gzip 14 KB は inline HTML に埋め込んでも実用範囲（5 ページ全体で ~150 KB）。Chart.js / ECharts は inline には大きすぎる。
- **ライセンス**: MIT（再配布可、attribution は `vendor/` 配下に LICENSE 同梱）。
- **適性**: 全 5 ページの主要グラフは「time-series 折れ線・stacked area・horizontal bar」に集約され、uPlot の strong suit と一致。pie / histogram は uPlot ではなく自前 Canvas 実装（30 行程度）で済ませる。
- **npm dep を増やさない理由**:
  1. ルートの `package.json` (npm publish 対象) に依存を増やすと postinstall / install サイズ・互換性検証コストが乗る
  2. `manager/package.json` は private で bun のみ使う想定。フロントエンド bundling step を導入すると `package.json` の `files` glob と publish 経路が複雑化
  3. vendor ファイル 1 個で済むなら、build step 不要のまま単一 HTML を返せる
- **取得元**: GitHub leeoniya/uPlot v1.6.31 リリースの `dist/uPlot.iife.min.js` をそのままコピー。`vendor/uplot.min.js` 冒頭に `/*! uPlot 1.6.31 ... MIT */` のヘッダコメントを残す。

**運用ルール**: uPlot のバージョン更新は手動。`vendor/UPLOT_VERSION` プレーンテキストにバージョン番号を書き、依存更新タスクで diff 可視化。

---

## 4. API 層設計

### 4.1 既存集計関数の period 対応方針 — **既に対応済み**（拡張不要）

既存実装を確認した結果、以下はすべて `sinceIso` / `untilIso` 引数を取る:

| 関数 (file:line) | 既存シグネチャ | 流用可否 |
|---|---|---|
| `aggregateApiUsageByRole` (`trace-store.ts:1075`) | `(db, { sinceIso, untilIso })` | ◎ |
| `aggregateApiUsageByTask` (`trace-store.ts:1119`) | `(db, { sinceIso, untilIso, limit })` | ◎ |
| `countToolCallsByTask` (`trace-store.ts:1179`) | `(db, { sinceIso, untilIso, type? })` | ◎ |
| `firstEditPerTask` (`trace-store.ts:1227`) | `(db, { sinceIso, untilIso })` | ◎ |
| `failureRateByTask` (`trace-store.ts:1271`) | `(db, { sinceIso, untilIso })` | ◎ |
| `denyRateByPeriod` (`trace-store.ts:1321`) | `(db, { sinceIso, untilIso })` | ◎ |
| `aggregateMetricsByTask` (`metrics-aggregate.ts:263`) | `(db, eventsFile, { since, until, taskId? })` | ◎ |
| `aggregateMetricsByBucket` (`metrics-aggregate.ts:352`) | `(db, eventsFile, { since, until, groupBy })` | △ `groupBy: "hour"` 拡張要 (§4.1 #3 で対応) |
| `getProjection5h` / `getProjection7d` (`trace-store.ts:793/807`) | `(db, now?)` ※常に最新 snapshot 起点 | ◎ |
| `getLatestApiUsageRow` (`trace-store.ts:1348`) | `(db)` | ◎ |
| `readTaskLifecycle` (`metrics-aggregate.ts:143`) | `(filePath, since)` ※`until` は呼出側が filter | ◎ |

**新規追加が必要な集計のみ（最小限）**:

1. **per-tool 件数の period 集計**（task_id を集約せず tool_name で sum）→ `countToolCallsByPeriod(db, { sinceIso, untilIso, type? })`: `trace-store.ts` に追加
2. **tool_name 単位の failure rate**（`failureRateByTask` の per-task でなく per-tool 集計）→ `failureRateByTool(db, { sinceIso, untilIso })`: 同上
3. **time-bucket 単位の deny / failure / token timeline**: `aggregateMetricsByBucket` を `groupBy: "hour"` でも呼べるよう拡張（`bucketKey` にケース追加）+ token を bucket 集計する関数 `aggregateApiUsageByBucket(db, { sinceIso, untilIso, groupBy })` を新規追加
4. **Top tasks by tokens（Conductor + Agent 込み）** → 既存 `aggregateApiUsageByTask` で **role 区別なし** に SUM しているため要件を既に満たす（T407 で task_id が Agent にも紐付くようになっている。`docs/spec/11-metrics.md §3.5.1` 参照）
5. **Per-task agent breakdown** / **Strategy distribution** / **Spawn timeline** → §7 の `agent-strategy.ts` に集約

**SSOT 担保**: 集計ロジックの SSOT は `metrics-aggregate.ts` に一元化する。dashboard-server.ts は **集計せずに純粋に呼び出すだけ**（ResponseShape へのマッピング除く）。`dashboard-metrics.ts` (TUI 用) は触らない。

### 4.2 endpoint 一覧と response schema

`?from=ISO&to=ISO` を全 endpoint で共通受け取り。**`from` 既定 = now-24h**, **`to` 既定 = now**, ISO8601 UTC を期待し parse 失敗時は 400。

```ts
// dashboard-server.ts より抜粋

interface PeriodQuery { fromIso: string; toIso: string; }

interface HealthResponse {
  ok: true;
  version: string;
  projectRoot: string;
  startedAt: string;            // ISO 8601
  uptimeSec: number;
  proxyPort: number | null;
  serverPort: number;
  schemaVersion: 1;
}

interface OverviewResponse {
  period: PeriodQuery;
  throughput: Array<{           // day bucket
    bucket: string;             // "YYYY-MM-DD"
    assigned: number;
    completed: number;
    aborted: number;
    forced_close: number;
  }>;
  toolFailureRate: Array<{      // hour bucket
    bucket: string;             // "YYYY-MM-DDTHH"
    pre_total: number;
    failures: number;
    rate: number;               // 0..1
  }>;
  tokens: Array<{               // hour bucket, stacked area
    bucket: string;
    input: number;
    output: number;
    cache_creation: number;
    cache_read: number;
  }>;
  activeTasks: { count: number; taskIds: string[] };
  rateLimit: {
    projection5h: { utilization: number | null; resetIso: string | null; risk: "green"|"yellow"|"red"|"gray" };
    projection7d: { utilization: number | null; resetIso: string | null; risk: "green"|"yellow"|"red"|"gray" };
  };
}

interface ToolUseResponse {
  period: PeriodQuery;
  perTool: Array<{ tool_name: string; calls: number; }>;          // horizontal bar
  perToolFailure: Array<{ tool_name: string; total: number; failures: number; rate: number; }>;
  failureTimeline: Array<{ bucket: string; bash: number; other: number; }>; // hour
  denyTimeline:    Array<{ bucket: string; pre_total: number; denied: number; rate: number; }>;
  recentFailures:  Array<{                                          // 最新 20 件
    timestamp: string; task_id: string | null; tool_name: string; error: string; // 1KB 切り詰め
  }>;
}

interface AgentStrategyResponse {
  period: PeriodQuery;
  perTask: Array<{                                                  // 直近 30 タスク
    task_id: string;
    roles: Record<"researcher"|"planner"|"implementer"|"reviewer"|"tester"|"dockeeper"|"taskmanager"|"other", number>;
    label: AgentStrategyLabel;
  }>;
  distribution: Record<AgentStrategyLabel, number>;
  spawnTimeline: Array<{ bucket: string; counts: Record<string, number> }>; // day bucket × role
}

type AgentStrategyLabel =
  | "solo" | "research-only" | "plan-impl" | "parallel-impl" | "full-cycle" | "other";

interface AgentStrategyDrillDownResponse {
  task_id: string;
  conductor: {
    surface: string | null;
    assignedTs: string;
    closedTs: string | null;
    outcome: "completed" | "aborted" | "state_mismatch" | "forced_close" | "open";
  };
  agents: Array<{
    role: string;
    surface: string;
    spawnedTs: string;
    closedTs: string | null;
    sessionId: string;
  }>;
}

interface TokensResponse {
  period: PeriodQuery;
  timeline: Array<{ bucket: string; input: number; output: number; cache_creation: number; cache_read: number; }>;
  topTasks: Array<{ task_id: string; input: number; output: number; cache: number; requests: number; }>; // 20
  perRole:  Array<{ role: "master"|"conductor"|"agent"|"unknown"; input: number; output: number; cache: number; requests: number; }>;
  perTaskHistogram: { bins: number[]; counts: number[]; median: number; p95: number; max: number; }; // tokens.input+output per task
}

interface TasksResponse {
  period: PeriodQuery;
  rows: Array<{
    task_id: string;
    outcome: string;
    assigned_ts: string;
    closed_ts: string | null;
    duration_ms: number | null;
    tool_call_total: number;
    tool_failure_rate: number;
    tokens: { input: number; output: number; cache: number; requests: number };
    agent_count: number;
    time_to_first_edit_ms: number | null;
  }>;
}
```

### 4.3 エラー設計

| status | 条件 | レスポンス body |
|---|---|---|
| 200 | 正常 | `application/json` の各 ResponseShape |
| 400 | `?from` / `?to` の ISO 8601 parse 失敗、または `from > to` | `{ "error": "bad_request", "message": "..." }` |
| 404 | endpoint 不一致、`/api/agent-strategy/:taskId` の taskId 不在 | `{ "error": "not_found" }` |
| 500 | SQLite throw / events.jsonl I/O 例外 | `{ "error": "internal", "message": "..." }` + `manager.log` に `dashboard_server_error` で記録 |
| 503 | 集計タイムアウト（rev1: §10 の Promise.race で 5s 超え） | `{ "error": "timeout", "endpoint": "...", "windowSec": 5 }` + `manager.log` に `dashboard_server_timeout` で記録 |

**fail-soft**: 集計の一部関数が空配列を返す（snapshot 不足等）のは正常系。`projection5h: null` 等は frontend 側で「データ不足」表示にフォールバック。

---

## 5. HTTP server 統合

### 5.1 Manager daemon lifecycle hook

`main.ts:761` 付近の proxy 起動直後に dashboard-server を起動する。proxy reuse パス（`existingProxyPort != null`）でも dashboard-server は本プロセスで起動する（pidfile を握っている daemon が必ず 1 つだけ存在する前提）。

```ts
// main.ts (擬似コード差分)
import { startDashboardServer } from "./dashboard-server";

let dashboardHandle: { port: number; url: string; stop: () => void } | null = null;
try {
  // dashboard-server は自前で initDB(PROJECT_ROOT) を呼ぶ（§2.1 B 案）
  dashboardHandle = await startDashboardServer({
    projectRoot: PROJECT_ROOT,
    getState: () => state,
    version,
  });
  state.dashboardServerUrl = dashboardHandle.url;
  await log("dashboard_server_started", `url=${dashboardHandle.url}`);
} catch (e: any) {
  await log("dashboard_server_start_failed", e.message);
  // fail-soft: dashboard なしでも daemon は動く
}
```

**shutdown / onFullQuit での停止方針 — 明示停止しない**（rev1 で確定）

`shutdown()` (`main.ts:816`) および `onFullQuit` 経路（`main.ts:882`）では `dashboardHandle?.stop()` を **呼ばない**。process.exit による OS 級の close に委ねる。理由:

1. **既存 proxy と方針を揃える**: `main.ts:815` 付近のコメントで「quit 時は proxy を停止しない（既存 Master/Conductor の接続を維持するため）」と既存方針が明記されている。dashboard-server も同じ daemon プロセス内で動くため、process.exit 時に OS が socket を閉じる経路に乗せれば済む。
2. **in-flight な fetch を破壊しない**: dashboard の clients は SPA のブラウザのみ。`server.stop()` を明示的に呼ぶと in-flight な GET が途中で切られ、SPA 側で謎の `TypeError: Failed to fetch` が出る（無害だが観察ノイズになる）。process.exit に任せれば TCP RST で閉じるが、SPA は次の 30s polling で自然回復する。
3. **責務最小**: dashboard-server は SQLite を read-only で握っているだけで、外部に対する commit / flush 義務がない。明示 close は不要。

> **テスト時のみ例外**: `dashboard-server.test.ts` では Bun.serve を生かしたままだとテストランナーがハングするため、テスト経路に限り `handle.stop()` を呼ぶ。本番 lifecycle (main.ts) では呼ばない。

> rev1 補足: 旧 plan では「shutdown 冒頭で `dashboardHandle?.stop()` を呼ぶ」と書いていた。Reviewer 指摘どおり既存 proxy の方針 (`main.ts:815`) と乖離していたため、明示停止しない方針に揃える。これにより §5.3 の「停止順序: dashboard → proxy」も無効化（§5.3 の表を更新）。

### 5.2 `team.json` への atomic write 経路

`dashboard-server.ts` は team.json を**直接**書かない。`DaemonState` に `dashboardServerUrl?: string` 列を新設し、`updateTeamJson` (`daemon.ts:4141`) で他フィールドと同じ tmp+rename atomic write 経路に乗せる。

```ts
// daemon.ts: DaemonState
interface DaemonState {
  // ...既存
  dashboardServerUrl?: string;
}

// daemon.ts: updateTeamJson 内で追記
teamJson.dashboardServer = state.dashboardServerUrl
  ? { url: state.dashboardServerUrl, schemaVersion: 1 }
  : undefined;
```

**書き出しタイミング**: dashboard-server 起動完了後に `state.dashboardServerUrl = ...` をセットし、既存の `await updateTeamJson(state)` (main.ts:841 / shutdown) で自然に永続化される。新たに同期 flush ポイントを増やす必要はない（起動後 1〜2 秒以内に最初の `updateTeamJson` が走る）。

### 5.3 既存 `proxy.ts` との port / lifecycle 衝突確認

| 項目 | proxy.ts | dashboard-server.ts |
|---|---|---|
| listen address | `0.0.0.0`（明示なし＝Bun default） | **`127.0.0.1` 明示** |
| port 取得 | preferred (`.team/proxy-port`) → fallback random | **常に `port: 0` (ephemeral)** |
| port 再利用 | あり | なし（再起動で変わる） |
| port persistence file | `.team/proxy-port` | なし。`team.json.dashboardServer.url` のみ |
| daemon shutdown 時の stop | **呼ばない**（process.exit 任せ） | **呼ばない**（process.exit 任せ。§5.1 参照） |
| traceDb ハンドル | proxy 用に `initDB(PROJECT_ROOT)`（既存 / proxy 再利用パスでは開かない） | **dashboard が自前で `initDB(PROJECT_ROOT)`** を read-only 用途で開く |

OS がポートを競合させない限り両 server は独立に共存。`Bun.serve` 内部の AbortController は別インスタンス。**`server.stop()` の停止順序**: 旧 plan で「dashboard → proxy」と記載していたが、§5.1 で明示停止しない方針に変更したため停止順序の規定は不要（process.exit 時に OS が両 socket を同時に close）。テスト経路で stop() を呼ぶ場合のみ任意順で良い。

---

## 6. HTML / SPA 構造

### 6.1 単一 HTML ファイルの配置

ソース: `skills/cmux-team/manager/dashboard-web/{index.html, app.js, style.css, vendor/uplot.min.js}`

ランタイム配信: `dashboard-server.ts` が **GET `/`** で `dashboard-web-bundle.ts` から読んだ HTML 文字列を返す。HTML 内に `<style>...</style>` で `style.css` の中身を、`<script>...</script>` で `vendor/uplot.min.js` と `app.js` の中身を **連結インライン**する（外部 fetch ゼロ）。

```ts
// dashboard-web-bundle.ts（擬似）
import { readFileSync } from "fs";
import { join, dirname } from "path";

const ROOT = join(dirname(import.meta.path), "dashboard-web");

let cachedHtml: string | null = null;
export function getDashboardHtml(): string {
  if (cachedHtml) return cachedHtml;
  const html  = readFileSync(join(ROOT, "index.html"), "utf-8");
  const css   = readFileSync(join(ROOT, "style.css"),  "utf-8");
  const uplot = readFileSync(join(ROOT, "vendor/uplot.min.js"), "utf-8");
  const app   = readFileSync(join(ROOT, "app.js"),     "utf-8");
  cachedHtml = html
    .replace("/*__INLINE_CSS__*/",   css)
    .replace("/*__INLINE_UPLOT__*/", uplot)
    .replace("/*__INLINE_APP__*/",   app);
  return cachedHtml;
}
```

dev iteration: 起動時 1 回 cache。`?reload=1` を許容（development モード時のみ cache 無効化）するかは Implementer 判断。

### 6.2 SPA の実装方針 — **vanilla JS（フレームワーク不採用）**

**理由**:

- 5 ページ × グラフ中心 × 状態量は URL に集約できる（hash + query）→ data binding library の旨味が薄い
- Petite-Vue / Alpine.js を入れると CSP（inline script + eval 等）の検討が増える
- 単一ファイル制約下で「フレームワークを vendor + メンテ追跡」のコストが純コード以上
- 自前実装でも 600〜800 行に収まる見込み（5 ページ × 平均 120〜150 行）

**構造**:

```js
// app.js 概形
const state = {
  page: "overview",       // hash で同期
  fromIso: defaultFrom(), // ?from
  toIso:   defaultTo(),   // ?to
  refreshOn: true,        // toggle
  taskDrillDown: null,    // hash #task=NNN
};

// 1. URL 同期
window.addEventListener("hashchange", parseHashAndRender);
window.addEventListener("popstate",  parseHashAndRender);

// 2. ルーター
function render() {
  switch (state.page) {
    case "overview":       renderOverview();      break;
    case "tool-use":       renderToolUse();       break;
    case "agent-strategy": renderAgentStrategy(); break;
    case "tokens":         renderTokens();        break;
    case "tasks":          renderTasks();         break;
  }
}

// 3. fetch ヘルパ（period query を必ず付ける）
async function api(path, extra = {}) {
  const u = new URL(path, location.origin);
  u.searchParams.set("from", state.fromIso);
  u.searchParams.set("to",   state.toIso);
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  const r = await fetch(u);
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}

// 4. uPlot ラッパ（time-series 統一）
function timeSeriesChart(elt, dataMatrix, opts) { /* uPlot 呼び出し */ }
```

### 6.3 URL クエリ + URL hash の状態管理

| 状態 | 永続化先 | 例 |
|---|---|---|
| 時間範囲 | `?from=ISO&to=ISO` | `?from=2026-04-25T00:00:00Z&to=2026-05-02T00:00:00Z` |
| 自動 refresh ON/OFF | `?refresh=on` (省略は ON) | — |
| 現在ページ | URL hash `#page` | `#overview` `#tool-use` `#agent-strategy` `#tokens` `#tasks` |
| Agent Strategy drill-down | URL hash `#agent-strategy?task=414` | hash 内 query のため history.replaceState で操作 |

**permalink 不変条件**: 任意の URL を copy → 別タブで開く → 同じ画面・同じ時間範囲で表示される。Server side 状態を持たないため可能。

### 6.4 5 ページのレンダリング関数の責務分割

| ページ | endpoint 1 つ | グラフ要素 |
|---|---|---|
| `renderOverview()`       | GET `/api/overview`             | throughput stacked bar (uPlot) / failure-rate sparkline (uPlot) / tokens stacked area (uPlot) / risk badge (DOM) |
| `renderToolUse()`        | GET `/api/tool-use`             | per-tool horizontal bar (Canvas 自前) / per-tool table (DOM) / failure timeline 2系列 (uPlot) / deny timeline (uPlot) / recent table (DOM)。**Bash 強調**: `tool_name === "Bash"` の行は per-tool table と failure 表で色付き（warning trim 系の class）+ table 上位ピン留め、horizontal bar / failure timeline では太線描画する（即興スクリプト失敗の指標として視覚的に最優先で目に入るようにする。task.md 「Per-tool failure rate テーブル — Bash 強調」に対応） |
| `renderAgentStrategy()`  | GET `/api/agent-strategy` (+drill-down) | role × 起動回数 horizontal stacked bar (Canvas 自前) / strategy 円 (Canvas 自前) / spawn timeline stacked area (uPlot) / drill-down timeline (Canvas 自前) |
| `renderTokens()`         | GET `/api/tokens`               | timeline stacked area (uPlot) / Top tasks ranking (DOM) / per-role pie (Canvas 自前) / histogram (Canvas 自前) |
| `renderTasks()`          | GET `/api/tasks`                | sortable table (DOM) / CSV export button (Blob URL) |

時間範囲 picker（preset chip + custom datetime）と sidebar nav は全ページ共通。auto refresh は `setInterval(render, 30_000)` で `state.refreshOn` を見て再 render。

---

## 7. Agent 戦略分類のロジック実装

### 7.1 関数 signature

```ts
// agent-strategy.ts（新規）

export type AgentStrategyLabel =
  | "solo" | "research-only" | "plan-impl" | "parallel-impl" | "full-cycle" | "other";

export interface AgentStrategyRow {
  task_id: string;
  roles: Record<string, number>;     // role -> count
  label: AgentStrategyLabel;
}

export function aggregateAgentStrategyByTask(
  db: Database,
  opts: { sinceIso: string; untilIso: string; limit?: number },
): AgentStrategyRow[];

export function aggregateAgentSpawnTimeline(
  db: Database,
  opts: { sinceIso: string; untilIso: string; groupBy: "day" | "hour" },
): Array<{ bucket: string; counts: Record<string, number> }>;

export function getAgentStrategyForTask(
  db: Database,
  eventsFile: string,
  taskId: string,
): AgentStrategyDrillDownResponse;

/** ロジック単独テスト可能にするための pure function */
export function classifyStrategy(roles: Record<string, number>): AgentStrategyLabel;
```

### 7.2 SQL（新規追加）

```sql
-- aggregateAgentStrategyByTask: task_id × role 別の agent_spawned 件数
SELECT task_id, role, COUNT(*) AS n
FROM task_sessions
WHERE event = 'agent_spawned'
  AND timestamp >= $sinceIso
  AND timestamp <= $untilIso
  AND task_id IS NOT NULL
GROUP BY task_id, role
ORDER BY task_id DESC
LIMIT $limit;          -- limit は Implementer 判断。直近 30 task なら ORDER BY MAX(timestamp) で task_id を絞ってから JOIN

-- aggregateAgentSpawnTimeline: bucket × role の積み上げ
SELECT
  substr(timestamp, 1, $bucketLen) AS bucket,   -- day:10, hour:13
  role,
  COUNT(*) AS n
FROM task_sessions
WHERE event = 'agent_spawned'
  AND timestamp >= $sinceIso
  AND timestamp <= $untilIso
  AND role IS NOT NULL
GROUP BY bucket, role
ORDER BY bucket ASC;

-- getAgentStrategyForTask: 特定 task のタイムライン
SELECT timestamp, role, surface, session_id, event
FROM task_sessions
WHERE task_id = $taskId
ORDER BY id ASC;
```

drill-down の outcome は events.jsonl から `readTaskLifecycle` を呼んで補完する（既存 path）。

### 7.3 分類ロジック（pure function）

```ts
export function classifyStrategy(roles: Record<string, number>): AgentStrategyLabel {
  const has = (k: string) => (roles[k] ?? 0) > 0;
  const cnt = (k: string) =>  roles[k] ?? 0;
  const total = Object.values(roles).reduce((a, b) => a + b, 0);

  if (total === 0) return "solo";
  if (has("researcher") && total === cnt("researcher")) return "research-only";
  if (has("planner") && has("implementer") && total === cnt("planner") + cnt("implementer")) return "plan-impl";
  if (cnt("implementer") >= 2) return "parallel-impl";
  if (has("researcher") && has("planner") && has("implementer") && has("reviewer")) return "full-cycle";
  return "other";
}
```

仕様の暫定性は spec 12-web-dashboard.md に明記する（後続タスクで規則を見直す）。

---

## 8. テスト計画

### 8.1 既存 `metrics-aggregate.ts` のテスト追加

新規追加なし（既存テストが period 引数を網羅している）。**新規 SQL** (`countToolCallsByPeriod` / `failureRateByTool` / `aggregateApiUsageByBucket`) について以下を `trace-store-metrics.test.ts` に追加:

- 空テーブルで空配列・rate=0 が返る
- since/until 境界（`>=` / `<=`）の包含テスト
- `groupBy: "hour"` の bucket key が `YYYY-MM-DDTHH` 形式
- 複数 task_id × 複数 tool_name 混在で集計が崩れない（hook_signals fixture 追加）

### 8.2 新規 `dashboard-server.test.ts`

`Bun.serve` を `await startDashboardServer({...})` で実起動 → 自前で `fetch("http://127.0.0.1:<port>/api/...")` を打って JSON shape を検証する。**`expect-type` 不要** — runtime の shape チェックで十分。

| テスト | 内容 |
|---|---|
| `GET /api/health` | 200, `{ ok: true, version, projectRoot, serverPort }` |
| `GET /api/overview?from=...&to=...` | 200, レスポンス shape が `OverviewResponse` を満たす |
| `GET /api/overview` (param 省略) | 200, default 24h window |
| `GET /api/overview?from=NOT_ISO` | 400, `error: bad_request` |
| `GET /api/overview?from=2026-05-02&to=2026-05-01` | 400 (from > to) |
| `GET /api/agent-strategy/999999` | 404 |
| `GET /` | 200, `Content-Type: text/html`, body に `<title>cmux-team dashboard</title>` を含む。response header の `Content-Security-Policy` に `style-src 'self' 'unsafe-inline'` と `script-src 'self' 'unsafe-inline'` の両方が含まれる |
| 集計タイムアウト | 集計関数を 6s sleep に差し替えた fixture で `/api/overview` を叩き、503 + `error: timeout` を 5s〜6s で受ける（§10 Promise.race の動作確認） |
| 127.0.0.1 listen | `fetch("http://0.0.0.0:<port>/")` が ECONNREFUSED 相当（環境差吸収のため try/skip 可） |

`getState` モック / fixture DB（`initDB(tmpdir)` + 1〜数行 INSERT）で隔離。

### 8.3 新規 `agent-strategy.test.ts`

- `classifyStrategy({})` → `"solo"`
- `classifyStrategy({ researcher: 2 })` → `"research-only"`
- `classifyStrategy({ planner: 1, implementer: 1 })` → `"plan-impl"`
- `classifyStrategy({ implementer: 3 })` → `"parallel-impl"`
- `classifyStrategy({ researcher: 1, planner: 1, implementer: 1, reviewer: 1 })` → `"full-cycle"`
- `classifyStrategy({ tester: 1 })` → `"other"`
- `aggregateAgentStrategyByTask` の SQL: fixture DB に 3 task × 各 role を流し、limit / order を検証

### 8.4 SPA / グラフは手動検証

uPlot レンダリングや CSS layout は自動化に向かないため、以下のチェックリストを `docs/spec/12-web-dashboard.md` に書き、PR 内で手動実行する:

- [ ] 5 ページ全て描画される
- [ ] preset chip [1h / 24h / 7d / 30d] で全グラフが連動する
- [ ] permalink: URL を別タブで開いても同じ表示
- [ ] task drill-down: Tasks の行クリック → Agent Strategy drill-down にジャンプ
- [ ] 30s auto refresh ON / OFF
- [ ] 過去 task の Agent Strategy drill-down が timeline 表示される

### 8.5 `bun test` 全体実行禁止

CLAUDE.md「既知の注意点」の per-file 実行ルールを遵守。新規テストは個別ファイル単位で実行確認:

```bash
cd skills/cmux-team/manager
bun test --timeout 30000 dashboard-server.test.ts
bun test --timeout 30000 agent-strategy.test.ts
bun test --timeout 30000 trace-store-metrics.test.ts
```

---

## 9. 段階的実装ステップ

5〜7 ステップに分割。**各ステップは独立に PR 化可能**。ただしステップ間で TS 型が連動するため、merge 順は固定する。

### Step 1: 型・骨格・health endpoint

- `dashboard-server.ts` を新規作成、`/api/health` のみ実装。dashboard-server 内で自前 `initDB(projectRoot)`（§2.1 B 案）+ CSP header 付与（§10）を実装
- `DaemonState.dashboardServerUrl` を追加、`updateTeamJson` で書き出し
- `main.ts` で起動フック組み込み（**stop は呼ばない**、§5.1 参照）
- **変更ファイル**: `main.ts` / `daemon.ts` / `dashboard-server.ts` (新) / `dashboard-server.test.ts` (新)
- **テスト**: `bun test dashboard-server.test.ts` で health 200 を確認
- **動作確認**: `cmux-team start` → `cat .team/team.json | jq .dashboardServer` で URL 取得 → curl で `/api/health` 確認

### Step 2: 集計 API（agent-strategy 以外）

- `/api/overview` / `/api/tool-use` / `/api/tokens` / `/api/tasks` を実装
- 新規 SQL: `countToolCallsByPeriod` / `failureRateByTool` / `aggregateApiUsageByBucket` を `trace-store.ts` に追加
- **変更ファイル**: `dashboard-server.ts` / `trace-store.ts` / `metrics-aggregate.ts` / それぞれのテスト
- **テスト**: `bun test dashboard-server.test.ts trace-store-metrics.test.ts metrics-aggregate.test.ts`
- **動作確認**: curl で各 endpoint の JSON shape を確認

### Step 3: Agent Strategy

- `agent-strategy.ts` 新設 + 分類関数 + SQL 集計 + drill-down
- `/api/agent-strategy` / `/api/agent-strategy/:taskId` 追加
- **変更ファイル**: `agent-strategy.ts` (新) / `dashboard-server.ts` / `agent-strategy.test.ts` (新)
- **テスト**: `bun test agent-strategy.test.ts dashboard-server.test.ts`
- **動作確認**: curl で過去タスクの drill-down JSON を確認

### Step 4: HTML 配信 + sidebar + Overview ページ

- `dashboard-web/{index.html, style.css, app.js}` 初版（sidebar nav + 時間範囲 picker + Overview のみ）
- `dashboard-web/vendor/uplot.min.js` を vendor
- `dashboard-web-bundle.ts` で 1 HTML に連結
- `package.json` files に `dashboard-web/**` 追加
- **変更ファイル**: `dashboard-web/*` (新) / `dashboard-web-bundle.ts` (新) / `dashboard-server.ts` (GET / 追加) / `package.json`
- **動作確認**: ブラウザで `http://127.0.0.1:<port>/` を開いて Overview のグラフ 3 種が描画される

### Step 5: Tool Use ページ + Tokens ページ

- `app.js` に `renderToolUse()` / `renderTokens()` 追加
- failure timeline / deny timeline / per-role pie / histogram の Canvas 描画
- **変更ファイル**: `dashboard-web/app.js` のみ
- **動作確認**: ブラウザで Tool Use と Tokens タブを開いて全グラフ描画

### Step 6: Agent Strategy ページ + Tasks ページ + drill-down

- `app.js` に `renderAgentStrategy()` / `renderTasks()` + URL hash drill-down 連携
- Tasks ページの sort / filter / CSV export
- **変更ファイル**: `dashboard-web/app.js`
- **動作確認**: Tasks 行クリック → Agent Strategy drill-down にジャンプ、permalink 検証

### Step 7: docs/spec + 手動検証チェックリスト

- `docs/spec/12-web-dashboard.md` 新設
- `docs/spec/00-project-overview.md` / `glossary.md` への参照追記
- `CLAUDE.md` に 1 行追記
- **変更ファイル**: docs のみ
- **動作確認**: §8.4 の手動チェックリストを通す

---

## 10. リスクと対処

| リスク | 確度 | 対処 |
|---|---|---|
| **長クエリで daemon が止まる** | 中 | `aggregateMetricsByTask` は events.jsonl 全 scan + SQL 5 本。直近で 7d 範囲の events.jsonl が 100MB 超に膨らむと `for await (line of rl)` (`metrics-aggregate.ts:155`) がブロックする可能性。**対処方針 (rev1 で確定): endpoint ハンドラ層で `Promise.race`** —— 各 endpoint ハンドラ内で集計呼び出しを `Promise.race([work, sleep(5000).then(() => Symbol("TIMEOUT"))])` で囲み、TIMEOUT sentinel が返ったら 503 + `{ "error": "timeout", "endpoint": "...", "windowSec": 5 }` を返す。`readTaskLifecycle` 側に `AbortSignal` を threading しない理由: (1) `for await` ループは event loop を譲るため race は機能する, (2) AbortSignal を `metrics-aggregate.ts` 全体に通す改修コストが大きく SSOT (`metrics-aggregate.ts`) を本タスクで触りたくない, (3) timeout 後も background で集計が完走するが、それは問題視せず GC に任せる（5s 超えクエリは観察箱の即時性要件を超える稀ケース）。**閾値**: 5s。`Bun.serve` の `idleTimeout` は 30s デフォルトを変更しない（5s が race 内で先に発火） |
| **ephemeral port が再起動で変わる** | 高（仕様） | spec に明記。ブックマークは無意味、`team.json.dashboardServer.url` を都度参照する運用とする。後続 T-2 で TUI に "Open dashboard" コマンドを追加して摩擦を減らす |
| **SPA auto refresh と server 負荷** | 低 | 30s 間隔・1 ユーザー前提。endpoint 6 つ × 30s = 0.2 req/s。SQL は indexed なので問題なし。それでも **client side で `Cache-Control: no-store`** を付け、サーバ側に response cache は導入しない（観察値の即時性を優先） |
| **CSP / inline script & inline style** | 中 | 単一 HTML に script / style ともに inline する（§6.1）ため、`Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'` を付与。**rev1 で `style-src 'self' 'unsafe-inline'` を追加**（inline `<style>` を許可するため必須）。`dashboard-server.ts` が全 response（HTML / JSON）で同 header を返す |
| **127.0.0.1 listen の confirm** | 低 | `Bun.serve({ hostname: "127.0.0.1", port: 0 })` を必ず指定。テストで `fetch("http://0.0.0.0:<port>/")` が拒否されることを確認（環境差で `localhost` と `127.0.0.1` が同居するケースに注意） |
| **`existingProxyPort != null` 経路で traceDb 未開** | 低 | dashboard-server 側で `db ?? initDB(PROJECT_ROOT)` を必ず確保。WAL なので writer 別プロセスとも共存可 |
| **Agent 戦略分類規則の妥当性** | 中 | `solo / research-only / plan-impl / parallel-impl / full-cycle / other` は暫定。spec に「暫定であり実データを見て改訂する」と明記。後続タスクで再分類関数を差し替えやすいよう `classifyStrategy` を pure function 化 |
| **uPlot の vendor バージョン陳腐化** | 低 | `vendor/UPLOT_VERSION` を置き、依存更新タスクで diff 確認。security advisory が出たら手動更新 |
| **`bun test` 全体実行による hang** | 高（既知） | 新規テストファイルは per-file 実行を README やテスト docs に明記。CI workflow には触らない |

---

## 11. docs/spec 更新ポイント

### 11.1 新規 `docs/spec/12-web-dashboard.md`

章構成:

1. 概要（cmux-team 観察箱の retrospective 観察 UI）
2. 起動経路と port 公開ルール（`Bun.serve({ hostname: "127.0.0.1", port: 0 })`、`team.json.dashboardServer.url`）
3. listen address と security 方針（127.0.0.1 only / CSP）
4. API endpoint 一覧と response schema（§4 を移植）
5. HTML ページ構成（§6 を移植 + 手動検証チェックリスト）
6. Agent 戦略分類規則（暫定であることを明記）
7. uPlot vendoring 方針
8. TUI 連携（後続 T-2 で URL open）
9. 関連 spec / 関連コード

### 11.2 既存 doc への追記

| ファイル | 追記 |
|---|---|
| `docs/spec/00-project-overview.md` | 「観察 (observatory)」セクションに `12-web-dashboard.md` への参照リンクを追加 |
| `docs/spec/glossary.md` | §11 Metrics に「**Web ダッシュボード**: Manager daemon に同居する内部 HTTP server (`127.0.0.1:ephemeral`) が配信する 5 ページ SPA」エントリを追加、`12-web-dashboard.md` をリンク |
| `docs/spec/05-install-and-infrastructure.md` | `.team/` ディレクトリ構造表に `team.json.dashboardServer.url` の説明を追加（書き出しは daemon、外部 read-only） |
| `CLAUDE.md` | 「進捗情報の取得方法」表または「既知の注意点」近辺に 1 行: `Web ダッシュボード: cat .team/team.json \| jq -r .dashboardServer.url で URL 取得（ephemeral port、daemon 再起動で変わる）` |

---

## 12. 完了条件チェックリスト

タスク本文「検証要件」を実装側のチェックポイントに分解:

### サーバ起動 / 公開

- [ ] `cmux-team start` で manager daemon 起動と同時に dashboard server が立ち上がる
- [ ] `.team/team.json` に `dashboardServer: { url, schemaVersion: 1 }` が atomic write される（tmp+rename）
- [ ] daemon shutdown / `onFullQuit` 経路では `server.stop()` を呼ばない（既存 proxy と同様 process.exit に委ねる、§5.1 参照）。テスト経路でのみ `handle.stop()` を呼んで Bun ランナーをハングさせない
- [ ] 既存 proxy.ts の port / lifecycle に影響しない（既存テスト緑）

### Security

- [ ] `Bun.serve({ hostname: "127.0.0.1" })` が指定されている
- [ ] `fetch("http://0.0.0.0:<port>/")` が ECONNREFUSED 相当
- [ ] response header に `Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'` （inline `<style>` を許可するため `style-src 'unsafe-inline'` 必須）

### API

- [ ] `/api/health` / `/api/overview` / `/api/tool-use` / `/api/agent-strategy` / `/api/agent-strategy/:taskId` / `/api/tokens` / `/api/tasks` が全て 200 を返す
- [ ] `?from=ISO&to=ISO` が全 endpoint で動く / 既定は 24h
- [ ] parse 失敗 / `from > to` で 400
- [ ] 不在 task で 404
- [ ] 各レスポンスが §4.2 の TypeScript schema を満たす

### HTML / SPA

- [ ] ブラウザで開いて 5 ページすべてが描画される
- [ ] 時間範囲 preset chip [1h / 24h / 7d / 30d] を変更すると全ページの数値が連動する
- [ ] custom datetime ピッカーで任意範囲が指定できる
- [ ] permalink: URL コピー → 別タブで同じ表示
- [ ] auto refresh 30s ON/OFF トグル動作
- [ ] Tasks 行クリック → Agent Strategy drill-down にジャンプ（hash 連携）
- [ ] 過去 task で Agent Strategy drill-down が timeline 表示される

### 既存機能の不破壊

- [ ] 既存 TUI Metrics タブが従来通り表示される
- [ ] 既存 `cmux-team metrics ...` CLI が従来通り動く
- [ ] 既存 proxy（Anthropic 透過）が従来通り動く

### テスト

- [ ] `bun test --timeout 30000 dashboard-server.test.ts` 緑
- [ ] `bun test --timeout 30000 agent-strategy.test.ts` 緑
- [ ] `bun test --timeout 30000 trace-store-metrics.test.ts` 緑
- [ ] 新規 SQL の境界（`>=` / `<=`、空配列、bucket key 形式）テスト緑

### Docs

- [ ] `docs/spec/12-web-dashboard.md` 新設
- [ ] `docs/spec/00-project-overview.md` / `glossary.md` / `05-install-and-infrastructure.md` から参照リンク追加
- [ ] `CLAUDE.md` に URL 取得方法 1 行追記

### npm publish

- [ ] `package.json` files に `skills/cmux-team/manager/dashboard-web/**` を追加
- [ ] `npm pack --dry-run` で `dashboard-web/` 配下が含まれることを確認
- [ ] vendor uPlot のライセンスヘッダコメントが残っている

---

## 付録 A: 参考としたファイル

事前調査で読んだ箇所:

- `skills/cmux-team/manager/main.ts` (lines 740–930, 4140–4200): proxy 起動 / shutdown / `updateTeamJson` 呼び出し
- `skills/cmux-team/manager/proxy.ts` (lines 460–1012): 既存 `Bun.serve` 起動パターン
- `skills/cmux-team/manager/metrics-aggregate.ts` (lines 1–417): 集計純粋関数
- `skills/cmux-team/manager/trace-store.ts` (lines 1–1382): SQL クエリ + initDB
- `skills/cmux-team/manager/dashboard-metrics.ts` (lines 1–100): 既存 TUI Metrics の集計呼び出しパターン
- `skills/cmux-team/manager/dashboard.tsx` (lines 2190–2280): `loadMetricsData` の interval / state 管理
- `skills/cmux-team/manager/daemon.ts` (lines 4141–4200): `updateTeamJson` の atomic write 実装
- `docs/spec/11-metrics.md`: SSOT 構造、taxonomy 6 軸、cohort 比較
- `docs/spec/05-install-and-infrastructure.md`: 既存 server / proxy port のレイアウト規約
- `package.json` / `skills/cmux-team/manager/package.json`: 既存依存
- `docs/spec/glossary.md`: §11 Metrics エントリ構造
