/**
 * T379: `cmux-team metrics` サブコマンド本体。
 *
 * `metrics-aggregate.ts` の純粋関数を呼び、events.jsonl + traces.db の集計結果を
 * json / text / csv で出力する。CLI 構造は `events-cli.ts` を踏襲し、
 * `runMetricsCli({ args, projectRoot, stdout, stderr, abortSignal }): Promise<number>`
 * を export して in-process でテストできるようにする。
 *
 * オプション:
 *  - `--task-id <id>`            タスク 1 件にフィルタ（group-by task のみ）
 *  - `--since <duration|ts>`     `7d` / `24h` / ISO 8601。省略時は無制限
 *  - `--format json|text|csv`    既定 json
 *  - `--group-by task|day|week`  既定 task
 *  - `--help` / `-h`             ヘルプ表示
 */

import { existsSync } from "node:fs";
import { join } from "path";
import { initDB } from "./trace-store";
import { parseSince } from "./events-cli";
import {
  aggregateMetricsByTask,
  aggregateMetricsByBucket,
  type PerTaskMetrics,
  type PerBucketMetrics,
} from "./metrics-aggregate";
import { t } from "./i18n";

export interface RunMetricsCliOpts {
  /** "metrics" 自身を除いた残りの argv */
  args: string[];
  projectRoot: string;
  stdout: { write(s: string): boolean };
  stderr: { write(s: string): boolean };
  abortSignal: AbortSignal;
}

interface ParsedArgs {
  taskId: string | null;
  since: Date | null;
  format: "json" | "text" | "csv";
  groupBy: "task" | "day" | "week";
  help: boolean;
}

const KNOWN_FLAGS = new Set([
  "--task-id",
  "--since",
  "--format",
  "--group-by",
  "--help",
  "-h",
]);

const FLAGS_WITH_VALUE = new Set(["--task-id", "--since", "--format", "--group-by"]);

class ArgError extends Error {}

function parseArgs(argv: string[]): ParsedArgs {
  let taskId: string | null = null;
  let sinceRaw: string | undefined;
  let format: ParsedArgs["format"] = "json";
  let groupBy: ParsedArgs["groupBy"] = "task";
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!KNOWN_FLAGS.has(a)) {
      throw new ArgError(`unknown flag: ${a}`);
    }
    if (a === "--help" || a === "-h") {
      help = true;
      continue;
    }
    if (FLAGS_WITH_VALUE.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || KNOWN_FLAGS.has(v)) {
        throw new ArgError(`${a} requires a value`);
      }
      i++;
      if (a === "--task-id") taskId = v;
      else if (a === "--since") sinceRaw = v;
      else if (a === "--format") {
        if (v !== "json" && v !== "text" && v !== "csv") {
          throw new ArgError(`invalid --format value: ${v} (must be json, text, or csv)`);
        }
        format = v;
      } else if (a === "--group-by") {
        if (v !== "task" && v !== "day" && v !== "week") {
          throw new ArgError(`invalid --group-by value: ${v} (must be task, day, or week)`);
        }
        groupBy = v;
      }
    }
  }

  let since: Date | null = null;
  try {
    since = parseSince(sinceRaw);
  } catch (e: any) {
    throw new ArgError(e?.message ?? String(e));
  }

  if (taskId !== null && groupBy !== "task") {
    throw new ArgError("--task-id is only valid with --group-by task (default)");
  }

  return { taskId, since, format, groupBy, help };
}

// ────────────────────────────────────────────────────────────────────────
// formatter
// ────────────────────────────────────────────────────────────────────────

const ESCAPE_RE = /[\s="\\]/;

function fmtTextValue(v: unknown): string {
  if (v === null) return "null";
  if (v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return ESCAPE_RE.test(s) ? JSON.stringify(s) : s;
}

function formatTextPerTask(rows: PerTaskMetrics[]): string {
  return rows
    .map((r) =>
      [
        `task_id=${r.task_id}`,
        `outcome=${r.outcome}`,
        `assigned_ts=${r.assigned_ts}`,
        `closed_ts=${fmtTextValue(r.closed_ts)}`,
        `duration_ms=${fmtTextValue(r.duration_ms)}`,
        `tool_call_total=${r.tool_call_total}`,
        `tool_failure_rate=${r.tool_failure_rate.toFixed(4)}`,
        `time_to_first_edit_ms=${fmtTextValue(r.time_to_first_edit_ms)}`,
        `tokens_input=${r.tokens.input}`,
        `tokens_output=${r.tokens.output}`,
        `tokens_cache=${r.tokens.cache}`,
        `tokens_requests=${r.tokens.requests}`,
        `tool_calls=${fmtTextValue(r.tool_calls)}`,
      ].join(" "),
    )
    .join("\n");
}

function formatTextPerBucket(rows: PerBucketMetrics[]): string {
  return rows
    .map((r) =>
      [
        `bucket=${r.bucket}`,
        `tasks_assigned=${r.tasks_assigned}`,
        `tasks_completed=${r.tasks_completed}`,
        `tasks_aborted=${r.tasks_aborted}`,
        `completion_rate=${r.completion_rate.toFixed(4)}`,
        `abort_rate=${r.abort_rate.toFixed(4)}`,
        `forced_close_rate=${r.forced_close_rate.toFixed(4)}`,
        `deny_rate=${r.deny_rate.toFixed(4)}`,
        `tool_call_total=${r.tool_call_total}`,
        `tool_call_stddev=${r.tool_call_stddev.toFixed(2)}`,
        `duration_ms_mean=${r.duration_ms_mean.toFixed(0)}`,
        `duration_ms_stddev=${r.duration_ms_stddev.toFixed(0)}`,
        `tokens_input=${r.tokens_total.input}`,
        `tokens_output=${r.tokens_total.output}`,
        `tokens_cache=${r.tokens_total.cache}`,
      ].join(" "),
    )
    .join("\n");
}

/** RFC 4180 準拠の値エスケープ。 */
export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "object" ? JSON.stringify(value) : String(value);
  if (/[,\r\n"]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function formatCsvRow(values: unknown[]): string {
  return values.map(csvEscape).join(",");
}

const PER_TASK_HEADER = [
  "task_id",
  "outcome",
  "assigned_ts",
  "closed_ts",
  "duration_ms",
  "tool_call_total",
  "tool_failure_rate",
  "time_to_first_edit_ms",
  "tokens_input",
  "tokens_output",
  "tokens_cache",
  "tokens_requests",
  "tool_calls",
];

function formatCsvPerTask(rows: PerTaskMetrics[]): string {
  const header = formatCsvRow(PER_TASK_HEADER);
  const body = rows.map((r) =>
    formatCsvRow([
      r.task_id,
      r.outcome,
      r.assigned_ts,
      r.closed_ts,
      r.duration_ms,
      r.tool_call_total,
      r.tool_failure_rate.toFixed(4),
      r.time_to_first_edit_ms,
      r.tokens.input,
      r.tokens.output,
      r.tokens.cache,
      r.tokens.requests,
      JSON.stringify(r.tool_calls),
    ]),
  );
  return [header, ...body].join("\r\n");
}

const PER_BUCKET_HEADER = [
  "bucket",
  "tasks_assigned",
  "tasks_completed",
  "tasks_aborted",
  "completion_rate",
  "abort_rate",
  "forced_close_rate",
  "deny_rate",
  "tool_call_total",
  "tool_call_stddev",
  "duration_ms_mean",
  "duration_ms_stddev",
  "tokens_input",
  "tokens_output",
  "tokens_cache",
];

function formatCsvPerBucket(rows: PerBucketMetrics[]): string {
  const header = formatCsvRow(PER_BUCKET_HEADER);
  const body = rows.map((r) =>
    formatCsvRow([
      r.bucket,
      r.tasks_assigned,
      r.tasks_completed,
      r.tasks_aborted,
      r.completion_rate.toFixed(4),
      r.abort_rate.toFixed(4),
      r.forced_close_rate.toFixed(4),
      r.deny_rate.toFixed(4),
      r.tool_call_total,
      r.tool_call_stddev.toFixed(2),
      r.duration_ms_mean.toFixed(0),
      r.duration_ms_stddev.toFixed(0),
      r.tokens_total.input,
      r.tokens_total.output,
      r.tokens_total.cache,
    ]),
  );
  return [header, ...body].join("\r\n");
}

// ────────────────────────────────────────────────────────────────────────
// entry point
// ────────────────────────────────────────────────────────────────────────

export async function runMetricsCli(opts: RunMetricsCliOpts): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(opts.args);
  } catch (e) {
    if (e instanceof ArgError) {
      opts.stderr.write(`Error: ${e.message}\n`);
      opts.stderr.write(`Run 'cmux-team metrics --help' for usage.\n`);
      return 1;
    }
    throw e;
  }

  if (parsed.help) {
    opts.stdout.write(t("help_metrics"));
    opts.stdout.write("\n");
    return 0;
  }

  const eventsFile = join(opts.projectRoot, ".team/logs/events.jsonl");
  if (!existsSync(eventsFile)) {
    opts.stderr.write(`Error: events.jsonl not found at ${eventsFile}\n`);
    return 1;
  }
  const dbPath = join(opts.projectRoot, ".team/traces/traces.db");
  if (!existsSync(dbPath)) {
    opts.stderr.write(`Error: traces.db not found at ${dbPath}\n`);
    return 1;
  }

  const db = initDB(opts.projectRoot);
  try {
    const aggregateOpts = {
      since: parsed.since,
      until: new Date(),
      taskId: parsed.taskId ?? undefined,
    };

    if (parsed.groupBy === "task") {
      const rows = await aggregateMetricsByTask(db, eventsFile, aggregateOpts);
      writeOutput(opts.stdout, parsed.format, () => JSON.stringify(rows, null, 2),
        () => formatTextPerTask(rows),
        () => formatCsvPerTask(rows));
    } else {
      const rows = await aggregateMetricsByBucket(db, eventsFile, {
        ...aggregateOpts,
        groupBy: parsed.groupBy,
      });
      writeOutput(opts.stdout, parsed.format, () => JSON.stringify(rows, null, 2),
        () => formatTextPerBucket(rows),
        () => formatCsvPerBucket(rows));
    }
    return 0;
  } finally {
    try {
      db.close();
    } catch (e) {
      console.warn("[metrics-cli] db.close failed", e);
    }
  }
}

function writeOutput(
  out: { write(s: string): boolean },
  format: "json" | "text" | "csv",
  asJson: () => string,
  asText: () => string,
  asCsv: () => string,
): void {
  const body =
    format === "json" ? asJson() :
    format === "text" ? asText() :
    asCsv();
  out.write(body);
  // 末尾改行で stdout を行終端させる（jq / grep の expected な挙動）
  out.write("\n");
}
