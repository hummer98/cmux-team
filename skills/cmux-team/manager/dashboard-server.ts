/**
 * T414: Web ダッシュボード — Manager daemon 同居 HTTP server
 *
 * Bun.serve({ hostname: "127.0.0.1", port: 0 }) で内部 SPA を配信する。
 * 集計は trace-store.ts / metrics-aggregate.ts / agent-strategy.ts の SSOT に委譲し、
 * 本ファイルは routing / period query parsing / response shape 整形 / timeout race のみ担う。
 *
 * 設計判断（plan §2.1 §5.1 §10）:
 *  - dashboard 側で常に自前 initDB(projectRoot)（B 案）。proxy 再利用パスでも本プロセスで開く
 *  - shutdown では呼び出し側が stop() を呼ばない（process.exit に委ねる）。テスト経路でのみ stop()
 *  - 集計は endpoint ハンドラ層で Promise.race([work, sleep(5000)])、TIMEOUT で 503
 *  - DI: aggregators / sleep / now を引数で差し替え可能（テストで sleep 関数を差し替える）
 */
import { Database } from "bun:sqlite";
import { join } from "path";
import {
  initDB,
  countToolCallsByPeriod,
  failureRateByTool,
  aggregateApiUsageByBucket,
  aggregateApiUsageByRole,
  aggregateApiUsageByTask,
  failureRateByTask,
  countToolCallsByTask,
  firstEditPerTask,
  denyRateByPeriod,
  getProjection5h,
  getProjection7d,
  getHookSignals,
} from "./trace-store";
import {
  aggregateMetricsByTask,
  readTaskLifecycle,
  type Outcome,
} from "./metrics-aggregate";
import {
  aggregateAgentStrategyByTask,
  aggregateAgentSpawnTimeline,
  getAgentStrategyForTask,
  type AgentStrategyRow,
  type AgentStrategyDrillDownResponse,
} from "./agent-strategy";
import { computeRiskLevel } from "./dashboard-metrics";
import { log } from "./logger";

export interface DashboardServerHandle {
  /** listen 中のポート番号（ephemeral） */
  port: number;
  /** http://127.0.0.1:<port> 形式の URL */
  url: string;
  /** server を停止する。本番 lifecycle では呼ばないが、テストで Bun ランナーをハングさせない用途 */
  stop: () => void;
}

export interface DashboardSleeper {
  (ms: number): Promise<void>;
}

/**
 * 集計関数を差し替え可能にするための DI surface。
 * 全関数は Database / events file path を受け取って Promise を返す。
 * テストで一部だけ 6s sleep に差し替える時に使う。
 */
export interface DashboardAggregators {
  overview: (db: Database, eventsFile: string, period: PeriodQuery) => Promise<OverviewResponse>;
  toolUse: (db: Database, period: PeriodQuery) => Promise<ToolUseResponse>;
  tokens: (db: Database, period: PeriodQuery) => Promise<TokensResponse>;
  tasks: (db: Database, eventsFile: string, period: PeriodQuery) => Promise<TasksResponse>;
  agentStrategy: (db: Database, period: PeriodQuery) => Promise<AgentStrategyResponse>;
  agentStrategyDrillDown: (
    db: Database,
    eventsFile: string,
    taskId: string,
  ) => Promise<AgentStrategyDrillDownResponse | null>;
}

export interface DashboardServerOptions {
  /** プロジェクトルート絶対パス */
  projectRoot: string;
  /** 任意: バージョン文字列。未指定なら "unknown" */
  version?: string;
  /** 任意: DaemonState を返す getter。/api/health 等で参照 */
  getState?: () => unknown;
  /** 任意: 現在時刻 ms（テスト用に固定したい場合）。default Date.now */
  now?: () => number;
  /** 任意: SQLite DB ハンドル。指定があれば initDB を呼ばずに使う（テスト用） */
  db?: Database;
  /** 任意: timeout race 用 sleep 関数。テストで 6s sleep に差し替える */
  sleep?: DashboardSleeper;
  /** 任意: 集計タイムアウト閾値 ms。default 5000 */
  aggregateTimeoutMs?: number;
  /** 任意: events.jsonl ファイルパスを上書き。default `<projectRoot>/.team/logs/events.jsonl` */
  eventsFile?: string;
  /** 任意: 集計関数の差し替え (DI)。指定がなければ default の SSOT 集計を使う */
  aggregators?: Partial<DashboardAggregators>;
  /** 任意: HTML を返す関数（Step 4 で実装）。未指定時は GET / は 404 */
  htmlBundle?: () => string;
}

/**
 * 全 endpoint のレスポンスに付与する CSP header。
 * inline `<style>` / `<script>` を許可するため style-src / script-src に 'unsafe-inline' を含める。
 */
const CSP_HEADER =
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "connect-src 'self'; " +
  "object-src 'none'; " +
  "base-uri 'self'; " +
  "frame-ancestors 'none'";

const DEFAULT_TIMEOUT_MS = 5000;

const TIMEOUT_SENTINEL = Symbol("dashboard-server.timeout");

const defaultSleep: DashboardSleeper = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function jsonResponse(body: unknown, init: { status?: number } = {}): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Content-Security-Policy": CSP_HEADER,
  };
  return new Response(JSON.stringify(body), { status: init.status, headers });
}

function htmlResponse(body: string, init: { status?: number } = {}): Response {
  const headers: Record<string, string> = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": CSP_HEADER,
  };
  return new Response(body, { status: init.status, headers });
}

export interface ApiErrorResponse {
  error: string;
  message?: string;
  endpoint?: string;
  windowSec?: number;
}

function errorResponse(status: number, body: ApiErrorResponse): Response {
  return jsonResponse(body, { status });
}

export interface PeriodQuery {
  fromIso: string;
  toIso: string;
}

/**
 * `?from` `?to` を parse する。未指定なら 24h window を default として返す。
 * parse 失敗 / from > to のときは Error を投げる（呼び出し側で 400 にする）。
 */
export function parsePeriodQuery(
  url: URL,
  now: () => number = Date.now,
): PeriodQuery {
  const fromRaw = url.searchParams.get("from");
  const toRaw = url.searchParams.get("to");
  const nowMs = now();
  const defaultFromMs = nowMs - 24 * 60 * 60 * 1000;

  const fromMs = fromRaw === null ? defaultFromMs : Date.parse(fromRaw);
  const toMs = toRaw === null ? nowMs : Date.parse(toRaw);
  if (Number.isNaN(fromMs)) {
    throw new RangeError(`bad_from: ${fromRaw}`);
  }
  if (Number.isNaN(toMs)) {
    throw new RangeError(`bad_to: ${toRaw}`);
  }
  if (fromMs > toMs) {
    throw new RangeError(`from_after_to: from=${new Date(fromMs).toISOString()} to=${new Date(toMs).toISOString()}`);
  }
  return {
    fromIso: new Date(fromMs).toISOString(),
    toIso: new Date(toMs).toISOString(),
  };
}

/**
 * 集計呼び出しを 5s で打ち切る race ヘルパー。
 * timeout した場合は 503 用の sentinel を返す。集計は background で完走するが GC に任せる
 * （詳細は plan §10 の AbortSignal を threading しない理由を参照）。
 */
async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  sleep: DashboardSleeper,
): Promise<T | symbol> {
  const timer: Promise<symbol> = sleep(timeoutMs).then(() => TIMEOUT_SENTINEL);
  return Promise.race<T | symbol>([work, timer]);
}

// ────────────────────────────────────────────────────────────────────────
// Response 型定義（plan §4.2）
// ────────────────────────────────────────────────────────────────────────

interface HealthResponse {
  ok: true;
  version: string;
  projectRoot: string;
  startedAt: string;
  uptimeSec: number;
  proxyPort: number | null;
  serverPort: number;
  schemaVersion: 1;
}

export type RiskLevel = "green" | "yellow" | "red" | "gray";

export interface ProjectionInfo {
  utilization: number | null;
  resetIso: string | null;
  risk: RiskLevel;
}

export interface OverviewResponse {
  period: PeriodQuery;
  throughput: Array<{
    bucket: string;
    assigned: number;
    completed: number;
    aborted: number;
    forced_close: number;
  }>;
  toolFailureRate: Array<{
    bucket: string;
    pre_total: number;
    failures: number;
    rate: number;
  }>;
  tokens: Array<{
    bucket: string;
    input: number;
    output: number;
    cache_creation: number;
    cache_read: number;
  }>;
  activeTasks: { count: number; taskIds: string[] };
  rateLimit: {
    projection5h: ProjectionInfo;
    projection7d: ProjectionInfo;
  };
}

export interface ToolUseResponse {
  period: PeriodQuery;
  perTool: Array<{ tool_name: string; calls: number }>;
  perToolFailure: Array<{ tool_name: string; total: number; failures: number; rate: number }>;
  failureTimeline: Array<{ bucket: string; bash: number; other: number }>;
  denyTimeline: Array<{ bucket: string; pre_total: number; denied: number; rate: number }>;
  recentFailures: Array<{
    timestamp: string;
    task_id: string | null;
    tool_name: string;
    error: string;
  }>;
}

export interface TokensResponse {
  period: PeriodQuery;
  timeline: Array<{
    bucket: string;
    input: number;
    output: number;
    cache_creation: number;
    cache_read: number;
  }>;
  topTasks: Array<{
    task_id: string;
    input: number;
    output: number;
    cache: number;
    requests: number;
  }>;
  perRole: Array<{
    role: "master" | "conductor" | "agent" | "unknown";
    input: number;
    output: number;
    cache: number;
    requests: number;
  }>;
  perTaskHistogram: { bins: number[]; counts: number[]; median: number; p95: number; max: number };
}

export interface TasksResponse {
  period: PeriodQuery;
  rows: Array<{
    task_id: string;
    outcome: Outcome;
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

export interface AgentStrategyResponse {
  period: PeriodQuery;
  perTask: AgentStrategyRow[];
  distribution: Record<string, number>;
  spawnTimeline: Array<{ bucket: string; counts: Record<string, number> }>;
}

// ────────────────────────────────────────────────────────────────────────
// SSOT default aggregators
// ────────────────────────────────────────────────────────────────────────

/**
 * UTF-8 multibyte を保ったまま byte length で切り詰める。1KB 上限で error 文字列を縮める。
 */
function truncateUtf8(s: string, maxBytes: number): string {
  const enc = new TextEncoder();
  const buf = enc.encode(s);
  if (buf.length <= maxBytes) return s;
  // 末尾 multibyte 境界を後退させる
  let end = maxBytes;
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(buf.slice(0, end));
}

function projectionToInfo(
  proj: { utilization: number; resetIso: string | null; longTermProjectedSec: number | null; recentProjectedSec: number | null } | null,
  nowMs: number,
): ProjectionInfo {
  if (proj === null) {
    return { utilization: null, resetIso: null, risk: "gray" };
  }
  const resetMs = proj.resetIso ? Date.parse(proj.resetIso) : NaN;
  const resetRemainingSec = !Number.isNaN(resetMs)
    ? Math.max(0, (resetMs - nowMs) / 1000)
    : null;
  const projected = proj.longTermProjectedSec;
  return {
    utilization: proj.utilization,
    resetIso: proj.resetIso,
    risk: computeRiskLevel(projected, resetRemainingSec),
  };
}

const defaultAggregators: DashboardAggregators = {
  async overview(db, eventsFile, period) {
    const sinceIso = period.fromIso;
    const untilIso = period.toIso;

    // throughput: events.jsonl の lifecycle を day bucket で集計
    const sinceDate = new Date(sinceIso);
    const untilMs = new Date(untilIso).getTime();
    const lifecycle = await safeReadLifecycle(eventsFile, sinceDate);
    const throughputBuckets = new Map<
      string,
      { assigned: number; completed: number; aborted: number; forced_close: number }
    >();
    for (const lc of lifecycle.values()) {
      if (Date.parse(lc.assigned_ts) > untilMs) continue;
      const bucket = lc.assigned_ts.slice(0, 10);
      const cur = throughputBuckets.get(bucket) ?? {
        assigned: 0,
        completed: 0,
        aborted: 0,
        forced_close: 0,
      };
      cur.assigned += 1;
      if (lc.outcome === "completed") cur.completed += 1;
      else if (lc.outcome === "aborted") cur.aborted += 1;
      else if (lc.outcome === "forced_close") cur.forced_close += 1;
      throughputBuckets.set(bucket, cur);
    }
    const throughput = [...throughputBuckets.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([bucket, v]) => ({ bucket, ...v }));

    // tool failure rate: hour bucket
    const toolFailRate = aggregateToolFailureTimeline(db, sinceIso, untilIso);

    // tokens: hour bucket stacked area
    const tokenBuckets = aggregateApiUsageByBucket(db, {
      sinceIso,
      untilIso,
      groupBy: "hour",
    });
    const tokens = tokenBuckets.map((b) => ({
      bucket: b.bucket,
      input: b.input,
      output: b.output,
      cache_creation: b.cache_creation,
      cache_read: b.cache_read,
    }));

    // active tasks: open のみ
    const activeIds: string[] = [];
    for (const lc of lifecycle.values()) {
      if (lc.outcome === "open") activeIds.push(lc.task_id);
    }

    // rate limit projections
    const nowMs = Date.now();
    const projection5h = projectionToInfo(getProjection5h(db, nowMs), nowMs);
    const projection7d = projectionToInfo(getProjection7d(db, nowMs), nowMs);

    return {
      period,
      throughput,
      toolFailureRate: toolFailRate,
      tokens,
      activeTasks: { count: activeIds.length, taskIds: activeIds },
      rateLimit: { projection5h, projection7d },
    };
  },

  async toolUse(db, period) {
    const sinceIso = period.fromIso;
    const untilIso = period.toIso;

    const perToolRows = countToolCallsByPeriod(db, { sinceIso, untilIso });
    const perTool = perToolRows.map((r) => ({ tool_name: r.tool_name, calls: r.n }));

    const failRows = failureRateByTool(db, { sinceIso, untilIso });
    const perToolFailure = failRows.map((r) => ({
      tool_name: r.tool_name,
      total: r.total,
      failures: r.failures,
      rate: r.total > 0 ? r.failures / r.total : 0,
    }));

    const failureTimeline = aggregateBashFailureTimeline(db, sinceIso, untilIso);
    const denyTimeline = aggregateDenyTimeline(db, sinceIso, untilIso);

    // recent failures (POST_TOOL_USE で success=0 / error 非 NULL の最新 20 件)
    const recentRaw = getHookSignals(db, { type: "POST_TOOL_USE", limit: 200 });
    const recentFailures: ToolUseResponse["recentFailures"] = [];
    for (const r of recentRaw) {
      if (recentFailures.length >= 20) break;
      let payload: any;
      try { payload = JSON.parse(r.payload_json); } catch { continue; }
      const tr = payload?.payload?.tool_response;
      const failed = tr && (tr.success === false || tr.error != null);
      if (!failed) continue;
      const errorRaw = String(tr.error ?? tr.message ?? "");
      recentFailures.push({
        timestamp: r.timestamp,
        task_id: r.task_id ?? null,
        tool_name: payload?.toolName ?? "unknown",
        error: truncateUtf8(errorRaw, 1024),
      });
    }

    return {
      period,
      perTool,
      perToolFailure,
      failureTimeline,
      denyTimeline,
      recentFailures,
    };
  },

  async tokens(db, period) {
    const sinceIso = period.fromIso;
    const untilIso = period.toIso;

    const buckets = aggregateApiUsageByBucket(db, { sinceIso, untilIso, groupBy: "hour" });
    const timeline = buckets.map((b) => ({
      bucket: b.bucket,
      input: b.input,
      output: b.output,
      cache_creation: b.cache_creation,
      cache_read: b.cache_read,
    }));

    const topTasksRaw = aggregateApiUsageByTask(db, { sinceIso, untilIso, limit: 20 });
    const topTasks = topTasksRaw.map((r) => ({
      task_id: r.task_id ?? "(unknown)",
      input: r.input,
      output: r.output,
      cache: r.cache,
      requests: r.requests,
    }));

    const perRoleRaw = aggregateApiUsageByRole(db, { sinceIso, untilIso });
    const perRole: TokensResponse["perRole"] = perRoleRaw.map((r) => ({
      role: (r.role as TokensResponse["perRole"][number]["role"]) ?? "unknown",
      input: r.input,
      output: r.output,
      cache: r.cache,
      requests: r.requests,
    }));

    // per-task histogram (input + output)
    const allTaskRows = aggregateApiUsageByTask(db, {
      sinceIso,
      untilIso,
      limit: 10_000,
    });
    const totals = allTaskRows.map((r) => r.input + r.output).filter((v) => v > 0);
    const perTaskHistogram = buildHistogram(totals);

    return { period, timeline, topTasks, perRole, perTaskHistogram };
  },

  async tasks(db, eventsFile, period) {
    const since = new Date(period.fromIso);
    const until = new Date(period.toIso);

    // SSOT: aggregateMetricsByTask に乗る
    const perTask = await aggregateMetricsByTask(db, eventsFile, { since, until });

    // agent_count 補完: task_sessions の event=agent_spawned を task_id 単位で count
    const agentCountRows = db
      .prepare(
        `SELECT task_id, COUNT(*) AS n
         FROM task_sessions
         WHERE event = 'agent_spawned'
           AND timestamp >= $sinceIso
           AND timestamp <= $untilIso
           AND task_id IS NOT NULL
         GROUP BY task_id`,
      )
      .all({
        $sinceIso: period.fromIso,
        $untilIso: period.toIso,
      }) as Array<{ task_id: string; n: number }>;
    const agentCountByTask = new Map<string, number>();
    for (const r of agentCountRows) agentCountByTask.set(r.task_id, r.n);

    const rows: TasksResponse["rows"] = perTask.map((m) => ({
      task_id: m.task_id,
      outcome: m.outcome,
      assigned_ts: m.assigned_ts,
      closed_ts: m.closed_ts,
      duration_ms: m.duration_ms,
      tool_call_total: m.tool_call_total,
      tool_failure_rate: m.tool_failure_rate,
      tokens: m.tokens,
      agent_count: agentCountByTask.get(m.task_id) ?? 0,
      time_to_first_edit_ms: m.time_to_first_edit_ms,
    }));

    return { period, rows };
  },

  async agentStrategy(db, period) {
    const perTask = aggregateAgentStrategyByTask(db, {
      sinceIso: period.fromIso,
      untilIso: period.toIso,
      limit: 30,
    });
    const distribution: Record<string, number> = {};
    for (const t of perTask) {
      distribution[t.label] = (distribution[t.label] ?? 0) + 1;
    }
    const spawnTimeline = aggregateAgentSpawnTimeline(db, {
      sinceIso: period.fromIso,
      untilIso: period.toIso,
      groupBy: "day",
    });
    return { period, perTask, distribution, spawnTimeline };
  },

  async agentStrategyDrillDown(db, eventsFile, taskId) {
    return getAgentStrategyForTask(db, eventsFile, taskId);
  },
};

// SSOT に依らない補助集計関数 ────────────────────────────────────────────

function aggregateToolFailureTimeline(
  db: Database,
  sinceIso: string,
  untilIso: string,
): Array<{ bucket: string; pre_total: number; failures: number; rate: number }> {
  const stmt = db.prepare(`
    SELECT
      substr(timestamp, 1, 13) AS bucket,
      SUM(CASE WHEN type = 'PRE_TOOL_USE' THEN 1 ELSE 0 END) AS pre_total,
      SUM(
        CASE WHEN type = 'POST_TOOL_USE' AND (
          JSON_EXTRACT(payload_json, '$.payload.tool_response.success') = 0
          OR JSON_EXTRACT(payload_json, '$.payload.tool_response.error') IS NOT NULL
        ) THEN 1 ELSE 0 END
      ) AS failures
    FROM hook_signals
    WHERE timestamp >= $sinceIso AND timestamp <= $untilIso
      AND type IN ('PRE_TOOL_USE','POST_TOOL_USE')
    GROUP BY bucket
    ORDER BY bucket ASC
  `);
  const rows = stmt.all({
    $sinceIso: sinceIso,
    $untilIso: untilIso,
  }) as Array<{ bucket: string; pre_total: number | null; failures: number | null }>;
  return rows.map((r) => {
    const pre_total = r.pre_total ?? 0;
    const failures = r.failures ?? 0;
    return {
      bucket: r.bucket,
      pre_total,
      failures,
      rate: pre_total > 0 ? failures / pre_total : 0,
    };
  });
}

function aggregateBashFailureTimeline(
  db: Database,
  sinceIso: string,
  untilIso: string,
): Array<{ bucket: string; bash: number; other: number }> {
  const stmt = db.prepare(`
    SELECT
      substr(timestamp, 1, 13) AS bucket,
      SUM(CASE WHEN tool_name = 'Bash' THEN 1 ELSE 0 END) AS bash,
      SUM(CASE WHEN tool_name != 'Bash' THEN 1 ELSE 0 END) AS other
    FROM hook_signals
    WHERE type = 'POST_TOOL_USE'
      AND timestamp >= $sinceIso AND timestamp <= $untilIso
      AND (
        JSON_EXTRACT(payload_json, '$.payload.tool_response.success') = 0
        OR JSON_EXTRACT(payload_json, '$.payload.tool_response.error') IS NOT NULL
      )
    GROUP BY bucket
    ORDER BY bucket ASC
  `);
  const rows = stmt.all({
    $sinceIso: sinceIso,
    $untilIso: untilIso,
  }) as Array<{ bucket: string; bash: number | null; other: number | null }>;
  return rows.map((r) => ({
    bucket: r.bucket,
    bash: r.bash ?? 0,
    other: r.other ?? 0,
  }));
}

function aggregateDenyTimeline(
  db: Database,
  sinceIso: string,
  untilIso: string,
): Array<{ bucket: string; pre_total: number; denied: number; rate: number }> {
  const stmt = db.prepare(`
    SELECT
      substr(timestamp, 1, 13) AS bucket,
      SUM(CASE WHEN type = 'PRE_TOOL_USE' THEN 1 ELSE 0 END) AS pre_total,
      SUM(CASE WHEN type = 'PRE_TOOL_USE_DENIED' THEN 1 ELSE 0 END) AS denied
    FROM hook_signals
    WHERE timestamp >= $sinceIso AND timestamp <= $untilIso
      AND type IN ('PRE_TOOL_USE','PRE_TOOL_USE_DENIED')
    GROUP BY bucket
    ORDER BY bucket ASC
  `);
  const rows = stmt.all({
    $sinceIso: sinceIso,
    $untilIso: untilIso,
  }) as Array<{ bucket: string; pre_total: number | null; denied: number | null }>;
  return rows.map((r) => {
    const pre_total = r.pre_total ?? 0;
    const denied = r.denied ?? 0;
    return {
      bucket: r.bucket,
      pre_total,
      denied,
      rate: pre_total > 0 ? denied / pre_total : 0,
    };
  });
}

function buildHistogram(values: number[]): TokensResponse["perTaskHistogram"] {
  if (values.length === 0) {
    return { bins: [], counts: [], median: 0, p95: 0, max: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const max = sorted[sorted.length - 1] ?? 0;
  const median = quantile(sorted, 0.5);
  const p95 = quantile(sorted, 0.95);
  const binCount = Math.min(20, Math.max(1, Math.ceil(Math.sqrt(values.length))));
  const min = sorted[0] ?? 0;
  const span = max - min || 1;
  const step = span / binCount;
  const bins: number[] = [];
  const counts: number[] = new Array(binCount).fill(0);
  for (let i = 0; i < binCount; i++) bins.push(min + i * step);
  for (const v of values) {
    let idx = Math.floor((v - min) / step);
    if (idx >= binCount) idx = binCount - 1;
    if (idx < 0) idx = 0;
    counts[idx] = (counts[idx] ?? 0) + 1;
  }
  return { bins, counts, median, p95, max };
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx] ?? 0;
}

async function safeReadLifecycle(
  eventsFile: string,
  since: Date,
): Promise<Map<string, { task_id: string; assigned_ts: string; closed_ts: string | null; duration_ms: number | null; outcome: Outcome }>> {
  // events.jsonl が存在しないときは空 Map を返す（fail-soft）
  try {
    return await readTaskLifecycle(eventsFile, since);
  } catch (e: any) {
    if (e?.code === "ENOENT") return new Map();
    throw e;
  }
}

// ────────────────────────────────────────────────────────────────────────
// startDashboardServer
// ────────────────────────────────────────────────────────────────────────

export async function startDashboardServer(
  opts: DashboardServerOptions,
): Promise<DashboardServerHandle> {
  const projectRoot = opts.projectRoot;
  const version = opts.version ?? "unknown";
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const timeoutMs = opts.aggregateTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const db = opts.db ?? initDB(projectRoot);
  const eventsFile = opts.eventsFile ?? join(projectRoot, ".team/logs/events.jsonl");
  const aggs: DashboardAggregators = {
    ...defaultAggregators,
    ...(opts.aggregators ?? {}),
  };

  const startedAtMs = now();
  const startedAtIso = new Date(startedAtMs).toISOString();

  const buildHealth = (serverPort: number): HealthResponse => {
    const state = opts.getState?.() as { proxyPort?: number | null } | undefined;
    const proxyPort = state?.proxyPort ?? null;
    return {
      ok: true,
      version,
      projectRoot,
      startedAt: startedAtIso,
      uptimeSec: Math.floor((now() - startedAtMs) / 1000),
      proxyPort,
      serverPort,
      schemaVersion: 1,
    };
  };

  const runWithTimeout = async <T>(
    endpoint: string,
    work: Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; res: Response }> => {
    const result = await withTimeout(work, timeoutMs, sleep);
    if (result === TIMEOUT_SENTINEL) {
      await log("dashboard_server_timeout", `endpoint=${endpoint} window_sec=${Math.floor(timeoutMs / 1000)}`);
      return {
        ok: false,
        res: errorResponse(503, {
          error: "timeout",
          endpoint,
          windowSec: Math.floor(timeoutMs / 1000),
        }),
      };
    }
    return { ok: true, value: result as T };
  };

  const fetchHandler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const pathname = url.pathname;

    if (req.method !== "GET") {
      return errorResponse(404, { error: "not_found" });
    }

    if (pathname === "/api/health") {
      return jsonResponse(buildHealth(server.port!));
    }

    // GET / で SPA HTML を返す（Step 4 で htmlBundle を渡す）
    if (pathname === "/" || pathname === "/index.html") {
      if (opts.htmlBundle) {
        return htmlResponse(opts.htmlBundle());
      }
      return errorResponse(404, { error: "not_found", endpoint: pathname });
    }

    // period query を必要とする集計 endpoint 群
    let period: PeriodQuery;
    try {
      period = parsePeriodQuery(url, now);
    } catch (e: any) {
      return errorResponse(400, { error: "bad_request", message: e?.message ?? String(e) });
    }

    if (pathname === "/api/overview") {
      const r = await runWithTimeout("/api/overview", aggs.overview(db, eventsFile, period));
      if (!r.ok) return r.res;
      return jsonResponse(r.value);
    }
    if (pathname === "/api/tool-use") {
      const r = await runWithTimeout("/api/tool-use", aggs.toolUse(db, period));
      if (!r.ok) return r.res;
      return jsonResponse(r.value);
    }
    if (pathname === "/api/tokens") {
      const r = await runWithTimeout("/api/tokens", aggs.tokens(db, period));
      if (!r.ok) return r.res;
      return jsonResponse(r.value);
    }
    if (pathname === "/api/tasks") {
      const r = await runWithTimeout("/api/tasks", aggs.tasks(db, eventsFile, period));
      if (!r.ok) return r.res;
      return jsonResponse(r.value);
    }
    if (pathname === "/api/agent-strategy") {
      const r = await runWithTimeout("/api/agent-strategy", aggs.agentStrategy(db, period));
      if (!r.ok) return r.res;
      return jsonResponse(r.value);
    }
    // /api/agent-strategy/<taskId>
    const drillMatch = /^\/api\/agent-strategy\/([^/]+)$/.exec(pathname);
    if (drillMatch) {
      const taskId = decodeURIComponent(drillMatch[1]!);
      const r = await runWithTimeout(
        "/api/agent-strategy/:taskId",
        aggs.agentStrategyDrillDown(db, eventsFile, taskId),
      );
      if (!r.ok) return r.res;
      if (r.value === null) {
        return errorResponse(404, { error: "not_found", endpoint: pathname });
      }
      return jsonResponse(r.value);
    }

    return errorResponse(404, { error: "not_found", endpoint: pathname });
  };

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        try {
          return await fetchHandler(req);
        } catch (e: any) {
          await log(
            "dashboard_server_error",
            `${req.method} ${req.url} ${e?.message ?? e}`,
          );
          return errorResponse(500, {
            error: "internal",
            message: e?.message ?? String(e),
          });
        }
      },
      development: false,
    });
  } catch (e: any) {
    throw new Error(`dashboard server bind failed: ${e?.message ?? e}`);
  }

  const port = server.port!;
  const url = `http://127.0.0.1:${port}`;

  return {
    port,
    url,
    stop: () => {
      try {
        server.stop();
      } catch {
        // 二重 stop は無害
      }
      if (opts.db === undefined) {
        try {
          db.close();
        } catch {
          // 既に閉じている場合は無視
        }
      }
    },
  };
}
