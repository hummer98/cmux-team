/**
 * T379: cmux-team metrics サブコマンドの集計ロジック（純粋関数群）。
 *
 * 設計判断:
 *  - SQL は trace-store.ts に置き、ここでは events.jsonl reader と SQL 結果の組み立て＋計算を担う
 *    （dashboard-metrics.ts と同じ責務分担）
 *  - 戻り値はすべて plain object / Map。CLI 出力（json/text/csv）は metrics-cli.ts が責任を持つ
 *  - I/O 失敗時は throw する。CLI 側で stderr に書く
 *
 * spec: .team/tasks/379-cmux-team-metrics-hook-signals/runs/.../plan.md §4-§5
 */

import { open } from "fs/promises";
import { createInterface } from "node:readline";
import type { Database } from "bun:sqlite";
import {
  aggregateApiUsageByTask,
  countToolCallsByTask,
  failureRateByTask,
  denyRateByPeriod,
  firstEditPerTask,
  type AggregatedTaskRow,
  type ToolCallByTaskRow,
} from "./trace-store";

// ────────────────────────────────────────────────────────────────────────
// 型定義
// ────────────────────────────────────────────────────────────────────────

export type Outcome = "completed" | "aborted" | "state_mismatch" | "forced_close" | "open";

export interface Lifecycle {
  task_id: string;
  assigned_ts: string;
  closed_ts: string | null;
  duration_ms: number | null;
  outcome: Outcome;
}

export interface PerTaskMetrics {
  task_id: string;
  assigned_ts: string;
  closed_ts: string | null;
  duration_ms: number | null;
  outcome: Outcome;
  tool_calls: Record<string, number>;
  tool_call_total: number;
  tool_failure_rate: number;
  time_to_first_edit_ms: number | null;
  tokens: {
    input: number;
    output: number;
    cache: number;
    requests: number;
  };
}

export interface PerBucketMetrics {
  bucket: string;
  tasks_assigned: number;
  tasks_completed: number;
  tasks_aborted: number;
  completion_rate: number;
  abort_rate: number;
  forced_close_rate: number;
  deny_rate: number;
  tool_call_total: number;
  tool_call_stddev: number;
  duration_ms_mean: number;
  duration_ms_stddev: number;
  tokens_total: {
    input: number;
    output: number;
    cache: number;
  };
}

export interface PeriodSummary {
  tasks_assigned: number;
  tasks_completed: number;
  tasks_aborted: number;
  tasks_forced_close: number;
  tasks_state_mismatch: number;
  completion_rate: number;
  abort_rate: number;
  forced_close_rate: number;
  duration_ms_mean: number;
  duration_ms_stddev: number;
}

// ────────────────────────────────────────────────────────────────────────
// 汎用ユーティリティ
// ────────────────────────────────────────────────────────────────────────

/** 母集団標準偏差。空配列は 0 を返す。 */
export function stddev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// ────────────────────────────────────────────────────────────────────────
// events.jsonl reader: task lifecycle
// ────────────────────────────────────────────────────────────────────────

const TERMINAL_EVENTS = new Set([
  "task_completed",
  "task_completed_state_mismatch",
  "task_aborted",
  "conductor_disconnect_timeout",
]);

function classifyOutcome(event: string): Outcome | null {
  switch (event) {
    case "task_completed":
      return "completed";
    case "task_aborted":
      return "aborted";
    case "task_completed_state_mismatch":
      return "state_mismatch";
    case "conductor_disconnect_timeout":
      return "forced_close";
    default:
      return null;
  }
}

/**
 * events.jsonl から task lifecycle を読む。`since` 以降の terminal イベントを持つタスクのみ返す。
 * 1 タスクが複数回 terminal を持つ場合は **最新** の terminal を採用する（forced_close は最後）。
 *
 * @param filePath events.jsonl 絶対パス
 * @param since `null` ならフィルタ無し。Date 指定時は terminal イベントの ts >= since を持つタスクだけ返す。
 *              ただし task_assigned のみで terminal 無しの open タスクは ts >= since の場合に含める。
 */
export async function readTaskLifecycle(
  filePath: string,
  since: Date | null,
): Promise<Map<string, Lifecycle>> {
  // task_id -> { assigned, terminal }
  type Buf = { assigned_ts?: string; terminal_ts?: string; outcome?: Outcome };
  const buf = new Map<string, Buf>();

  const fh = await open(filePath, "r");
  try {
    const stream = fh.createReadStream();
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let rec: any;
      try {
        rec = JSON.parse(line);
      } catch {
        // 壊れた JSON は読み飛ばす（events-cli と同じ方針）。
        continue;
      }
      const event = typeof rec.event === "string" ? rec.event : "";
      const ts = typeof rec.ts === "string" ? rec.ts : "";
      const taskId = typeof rec.task_id === "string" ? rec.task_id : "";

      if (event === "task_assigned" && taskId && ts) {
        const cur = buf.get(taskId) ?? {};
        cur.assigned_ts = ts;
        buf.set(taskId, cur);
        continue;
      }
      if (TERMINAL_EVENTS.has(event) && taskId && ts) {
        const outcome = classifyOutcome(event);
        if (!outcome) continue;
        const cur = buf.get(taskId) ?? {};
        cur.terminal_ts = ts;
        cur.outcome = outcome;
        buf.set(taskId, cur);
      }
    }
  } finally {
    try {
      await fh.close();
    } catch {
      // ignore
    }
  }

  const out = new Map<string, Lifecycle>();
  for (const [taskId, b] of buf) {
    if (!b.assigned_ts) continue;

    const closed_ts = b.terminal_ts ?? null;
    const outcome: Outcome = b.outcome ?? "open";
    const duration_ms =
      closed_ts !== null
        ? Date.parse(closed_ts) - Date.parse(b.assigned_ts)
        : null;

    if (since !== null) {
      // open は assigned_ts、それ以外は terminal_ts で since を判定する。
      const cmpTs = closed_ts ?? b.assigned_ts;
      if (Date.parse(cmpTs) < since.getTime()) continue;
    }
    out.set(taskId, {
      task_id: taskId,
      assigned_ts: b.assigned_ts,
      closed_ts,
      duration_ms,
      outcome,
    });
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────
// 期間集計
// ────────────────────────────────────────────────────────────────────────

export function aggregatePeriod(map: Map<string, Lifecycle>): PeriodSummary {
  const lcs = [...map.values()];
  const total = lcs.length;
  const completed = lcs.filter((l) => l.outcome === "completed").length;
  const aborted = lcs.filter((l) => l.outcome === "aborted").length;
  const forcedClose = lcs.filter((l) => l.outcome === "forced_close").length;
  const stateMismatch = lcs.filter((l) => l.outcome === "state_mismatch").length;
  const durations = lcs
    .map((l) => l.duration_ms)
    .filter((v): v is number => v !== null);
  return {
    tasks_assigned: total,
    tasks_completed: completed,
    tasks_aborted: aborted,
    tasks_forced_close: forcedClose,
    tasks_state_mismatch: stateMismatch,
    completion_rate: total === 0 ? 0 : completed / total,
    abort_rate: total === 0 ? 0 : aborted / total,
    forced_close_rate: total === 0 ? 0 : forcedClose / total,
    duration_ms_mean: mean(durations),
    duration_ms_stddev: stddev(durations),
  };
}

// ────────────────────────────────────────────────────────────────────────
// per-task 集計
// ────────────────────────────────────────────────────────────────────────

interface AggregateOpts {
  /** `--since` で指定された下限（含む）。null は下限なし。 */
  since: Date | null;
  /** 上限（含む）。集計範囲の SQL `<=` の右辺に使う。CLI 側で「現在時刻」を渡す想定。 */
  until: Date;
  /** `--task-id` 指定時のフィルタ。指定なら 1 タスクだけ返る。 */
  taskId?: string;
}

function isoOrEpoch(d: Date | null): string {
  return d === null ? "1970-01-01T00:00:00.000Z" : d.toISOString();
}

export async function aggregateMetricsByTask(
  db: Database,
  eventsFile: string,
  opts: AggregateOpts,
): Promise<PerTaskMetrics[]> {
  const lifecycle = await readTaskLifecycle(eventsFile, opts.since);
  const sinceIso = isoOrEpoch(opts.since);
  const untilIso = opts.until.toISOString();

  const toolRows = countToolCallsByTask(db, { sinceIso, untilIso, type: "PRE_TOOL_USE" });
  const failureRows = failureRateByTask(db, { sinceIso, untilIso });
  const firstEditRows = firstEditPerTask(db, { sinceIso, untilIso });
  const apiRows = aggregateApiUsageByTask(db, { sinceIso, untilIso, limit: 10_000 });

  const toolByTask = bucketByTask(toolRows);
  const failureByTask = new Map<string | null, { total: number; failures: number }>();
  for (const f of failureRows) {
    failureByTask.set(f.task_id, { total: f.total, failures: f.failures });
  }
  const firstEditByTask = new Map<string, string>();
  for (const r of firstEditRows) firstEditByTask.set(r.task_id, r.first_edit_ts);
  const apiByTask = new Map<string, AggregatedTaskRow>();
  for (const a of apiRows) apiByTask.set(a.task_id, a);

  const out: PerTaskMetrics[] = [];
  for (const [taskId, lc] of lifecycle) {
    if (opts.taskId && opts.taskId !== taskId) continue;
    const tools = toolByTask.get(taskId) ?? {};
    const tool_call_total = Object.values(tools).reduce((a, b) => a + b, 0);
    const fail = failureByTask.get(taskId);
    const tool_failure_rate =
      fail && fail.total > 0 ? fail.failures / fail.total : 0;
    const firstEditTs = firstEditByTask.get(taskId);
    const time_to_first_edit_ms =
      firstEditTs !== undefined
        ? Date.parse(firstEditTs) - Date.parse(lc.assigned_ts)
        : null;
    const api = apiByTask.get(taskId);
    out.push({
      task_id: taskId,
      assigned_ts: lc.assigned_ts,
      closed_ts: lc.closed_ts,
      duration_ms: lc.duration_ms,
      outcome: lc.outcome,
      tool_calls: tools,
      tool_call_total,
      tool_failure_rate,
      time_to_first_edit_ms,
      tokens: {
        input: api?.input ?? 0,
        output: api?.output ?? 0,
        cache: api?.cache ?? 0,
        requests: api?.requests ?? 0,
      },
    });
  }
  // task_id 昇順
  out.sort((a, b) => a.task_id.localeCompare(b.task_id, undefined, { numeric: true }));
  return out;
}

function bucketByTask(rows: ToolCallByTaskRow[]): Map<string, Record<string, number>> {
  const out = new Map<string, Record<string, number>>();
  for (const r of rows) {
    if (r.task_id === null) continue;
    const cur = out.get(r.task_id) ?? {};
    cur[r.tool_name] = (cur[r.tool_name] ?? 0) + r.n;
    out.set(r.task_id, cur);
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────
// per-bucket 集計（day / week）
// ────────────────────────────────────────────────────────────────────────

/** ISO 8601 タイムスタンプから bucket key を生成する。day=YYYY-MM-DD / week=ISO week 月曜日 YYYY-MM-DD。 */
export function bucketKey(ts: string, groupBy: "day" | "week"): string {
  const d = new Date(ts);
  if (groupBy === "day") {
    return d.toISOString().slice(0, 10);
  }
  // ISO week: 月曜日に揃える
  const day = d.getUTCDay(); // 0=Sun, 1=Mon, ...
  const offset = day === 0 ? -6 : 1 - day;
  const monday = new Date(d.getTime() + offset * 86400_000);
  return monday.toISOString().slice(0, 10);
}

export async function aggregateMetricsByBucket(
  db: Database,
  eventsFile: string,
  opts: AggregateOpts & { groupBy: "day" | "week" },
): Promise<PerBucketMetrics[]> {
  const perTask = await aggregateMetricsByTask(db, eventsFile, opts);
  // bucket -> tasks
  const buckets = new Map<string, PerTaskMetrics[]>();
  for (const t of perTask) {
    const key = bucketKey(t.assigned_ts, opts.groupBy);
    const arr = buckets.get(key) ?? [];
    arr.push(t);
    buckets.set(key, arr);
  }

  // deny_rate は時刻だけが必要なので、ここでは period 全体に対して算出して bucket ごとに同じ値を返す
  // ことは避け、bucket 範囲ごとに re-query する。
  const out: PerBucketMetrics[] = [];
  for (const [bucket, tasks] of buckets) {
    const total = tasks.length;
    const completed = tasks.filter((t) => t.outcome === "completed").length;
    const aborted = tasks.filter((t) => t.outcome === "aborted").length;
    const forcedClose = tasks.filter((t) => t.outcome === "forced_close").length;
    const durations = tasks
      .map((t) => t.duration_ms)
      .filter((v): v is number => v !== null);
    const toolTotals = tasks.map((t) => t.tool_call_total);

    // bucket の time range で deny_rate を SQL に問い合わせる
    const range = bucketRange(bucket, opts.groupBy);
    const dr = denyRateByPeriod(db, {
      sinceIso: range.start.toISOString(),
      untilIso: range.end.toISOString(),
    });
    const deny_rate = dr.pre_total > 0 ? dr.denied / dr.pre_total : 0;

    out.push({
      bucket,
      tasks_assigned: total,
      tasks_completed: completed,
      tasks_aborted: aborted,
      completion_rate: total === 0 ? 0 : completed / total,
      abort_rate: total === 0 ? 0 : aborted / total,
      forced_close_rate: total === 0 ? 0 : forcedClose / total,
      deny_rate,
      tool_call_total: toolTotals.reduce((a, b) => a + b, 0),
      tool_call_stddev: stddev(toolTotals),
      duration_ms_mean: mean(durations),
      duration_ms_stddev: stddev(durations),
      tokens_total: {
        input: tasks.reduce((s, t) => s + t.tokens.input, 0),
        output: tasks.reduce((s, t) => s + t.tokens.output, 0),
        cache: tasks.reduce((s, t) => s + t.tokens.cache, 0),
      },
    });
  }
  out.sort((a, b) => a.bucket.localeCompare(b.bucket));
  return out;
}

function bucketRange(bucket: string, groupBy: "day" | "week"): { start: Date; end: Date } {
  const start = new Date(`${bucket}T00:00:00.000Z`);
  const span = groupBy === "day" ? 86400_000 : 7 * 86400_000;
  const end = new Date(start.getTime() + span - 1);
  return { start, end };
}
