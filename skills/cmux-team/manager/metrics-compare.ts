/**
 * T381 S4 / S5 / S6: snapshot ローダ + cohort 比較 + CLI。
 *
 * 設計:
 *  - S4: `loadSnapshotsInRange` で YYYY-MM-DD 範囲の snapshot を列挙し、
 *        欠損は `missing[]`、schema 不一致 / parse 失敗は `skipped[]` として返す。
 *  - S4: `unionPerTask` は task_id 重複の dedup を 2 段ルールで行う:
 *        (1) closed-state 優先（outcome != "open"）
 *        (2) 同 outcome 内では snapshot_date 昇順最後（=後発が完全）
 *  - S5: `compareCohorts` は主要 metric の差 + Welch / Mann-Whitney / 2-prop z-test を返す。
 *        `evaluateAlarms` は `metrics-thresholds.ts` の direction map を信頼。
 *  - S5: `derivePerDayFromSnapshots` は snapshot 群を snapshot_date 昇順に並べ
 *        period を per-day エントリに変換する。
 *  - S6: `runMetricsCompareCli` は CLI 入口。alarm が一つでもあれば exit 2。
 *
 * spec: T381 plan.md S4 / S5 / S6
 */

import { readdir, readFile } from "fs/promises";
import { existsSync } from "node:fs";
import { join } from "path";
import { resolveUnderRoot } from "./metrics-path";
import {
  welchTTest,
  mannWhitneyU,
  twoProportionZTest,
  type WelchResult,
  type MannWhitneyResult,
  type TwoProportionResult,
} from "./metrics-stats";
import {
  DEFAULT_ALARM_THRESHOLDS,
  type AlarmThreshold,
  type AlarmThresholds,
  type AlarmDirection,
} from "./metrics-thresholds";
import type { DailySnapshot } from "./metrics-snapshot";
import type { PerTaskMetrics, PerBucketMetrics } from "./metrics-aggregate";
import { t } from "./i18n";

// ────────────────────────────────────────────────────────────────────────
// S4: loadSnapshotsInRange
// ────────────────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface LoadSnapshotsResult {
  snapshots: DailySnapshot[];
  /** YYYY-MM-DD で snapshot ファイルが見つからなかった日 */
  missing: string[];
  /** ファイル名 (basename) で skip された snapshot（schema 不一致 / parse 失敗） */
  skipped: string[];
}

/** YYYY-MM-DD を Date に変換し、加算した結果を YYYY-MM-DD で返す。 */
function addDaysIso(dateIso: string, n: number): string {
  const d = new Date(`${dateIso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function enumerateDays(fromIso: string, toIso: string): string[] {
  if (fromIso > toIso) {
    throw new Error(`invalid range: from(${fromIso}) > to(${toIso})`);
  }
  const out: string[] = [];
  let cur = fromIso;
  while (cur <= toIso) {
    out.push(cur);
    cur = addDaysIso(cur, 1);
    if (out.length > 366 * 5) {
      throw new Error(`range too large: ${fromIso}..${toIso}`);
    }
  }
  return out;
}

export async function loadSnapshotsInRange(
  snapshotDir: string,
  fromInclusive: string,
  toInclusive: string,
): Promise<LoadSnapshotsResult> {
  if (!DATE_RE.test(fromInclusive) || !DATE_RE.test(toInclusive)) {
    throw new Error(`range endpoints must be YYYY-MM-DD: ${fromInclusive}..${toInclusive}`);
  }
  const days = enumerateDays(fromInclusive, toInclusive);

  const snapshots: DailySnapshot[] = [];
  const missing: string[] = [];
  const skipped: string[] = [];

  if (!existsSync(snapshotDir)) {
    return { snapshots: [], missing: days, skipped: [] };
  }
  const entries = new Set(await readdir(snapshotDir));

  for (const day of days) {
    const fname = `${day}.json`;
    if (!entries.has(fname)) {
      missing.push(day);
      continue;
    }
    const path = join(snapshotDir, fname);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      skipped.push(fname);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      skipped.push(fname);
      continue;
    }
    if (!isDailySnapshot(parsed)) {
      skipped.push(fname);
      continue;
    }
    snapshots.push(parsed);
  }
  return { snapshots, missing, skipped };
}

function isDailySnapshot(x: unknown): x is DailySnapshot {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  if (r.schema_version !== 1) return false;
  if (typeof r.snapshot_date !== "string") return false;
  if (!Array.isArray(r.per_task)) return false;
  if (!r.period || typeof r.period !== "object") return false;
  return true;
}

// ────────────────────────────────────────────────────────────────────────
// S4: unionPerTask (dedup 2 段ルール)
// ────────────────────────────────────────────────────────────────────────

export function unionPerTask(snapshots: DailySnapshot[]): PerTaskMetrics[] {
  // task_id -> { snap_date, perTask }
  const map = new Map<string, { date: string; record: PerTaskMetrics }>();
  for (const s of snapshots) {
    for (const rec of s.per_task) {
      const cur = map.get(rec.task_id);
      if (!cur) {
        map.set(rec.task_id, { date: s.snapshot_date, record: rec });
        continue;
      }
      const curOpen = cur.record.outcome === "open";
      const newOpen = rec.outcome === "open";
      // ルール 1: closed 優先
      if (curOpen && !newOpen) {
        map.set(rec.task_id, { date: s.snapshot_date, record: rec });
        continue;
      }
      if (!curOpen && newOpen) continue;
      // 同 outcome (両 open / 両 closed): ルール 2: snapshot_date 昇順最後
      if (s.snapshot_date >= cur.date) {
        map.set(rec.task_id, { date: s.snapshot_date, record: rec });
      }
    }
  }
  return [...map.values()].map((v) => v.record);
}

// ────────────────────────────────────────────────────────────────────────
// S5: compareCohorts
// ────────────────────────────────────────────────────────────────────────

export interface MetricDiff {
  baseline_mean: number;
  comparison_mean: number;
  delta: number;
  /** baseline=0 では NaN または Infinity になりうる。コードは null 化はせず、 alarm 評価で N/A 扱い */
  delta_pct: number;
  t_test: WelchResult;
  mann_whitney: MannWhitneyResult;
}

export interface RateDiff {
  baseline: number;
  comparison: number;
  delta_pp: number;
  delta_pct: number;
  z_test: TwoProportionResult;
}

export interface AlarmSignal {
  metric: string;
  direction: AlarmDirection;
  /** pp なら絶対差、pct なら相対変化率 */
  delta: number;
  threshold_delta: number;
  threshold_unit: AlarmThreshold["unit"];
}

export interface CohortDiff {
  metrics: {
    duration_ms: MetricDiff;
    tool_call_total: MetricDiff;
    tool_failure_rate: MetricDiff;
    time_to_first_edit_ms: MetricDiff;
    tokens_total: MetricDiff;
  };
  rates: {
    completion_rate: RateDiff;
    abort_rate: RateDiff;
    forced_close_rate: RateDiff;
  };
  alarms: AlarmSignal[];
  samples: { baseline_n: number; comparison_n: number };
}

function meanOf(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function metricSeries(records: PerTaskMetrics[], picker: (r: PerTaskMetrics) => number | null): number[] {
  const out: number[] = [];
  for (const r of records) {
    const v = picker(r);
    if (v !== null && v !== undefined && Number.isFinite(v)) out.push(v);
  }
  return out;
}

function buildMetricDiff(baseline: number[], comparison: number[]): MetricDiff {
  const bMean = meanOf(baseline);
  const cMean = meanOf(comparison);
  const delta = cMean - bMean;
  const deltaPct = bMean === 0 ? 0 : delta / bMean;
  return {
    baseline_mean: bMean,
    comparison_mean: cMean,
    delta,
    delta_pct: deltaPct,
    t_test: welchTTest(baseline, comparison),
    mann_whitney: mannWhitneyU(baseline, comparison),
  };
}

function countOutcome(records: PerTaskMetrics[], target: PerTaskMetrics["outcome"]): number {
  return records.filter((r) => r.outcome === target).length;
}

function buildRateDiff(baselineX: number, baselineN: number, compX: number, compN: number): RateDiff {
  const b = baselineN === 0 ? 0 : baselineX / baselineN;
  const c = compN === 0 ? 0 : compX / compN;
  const dPp = c - b;
  const dPct = b === 0 ? 0 : dPp / b;
  return {
    baseline: b,
    comparison: c,
    delta_pp: dPp,
    delta_pct: dPct,
    z_test: twoProportionZTest(baselineX, baselineN, compX, compN),
  };
}

export function compareCohorts(
  baseline: PerTaskMetrics[],
  comparison: PerTaskMetrics[],
  thresholds: AlarmThresholds = DEFAULT_ALARM_THRESHOLDS,
): CohortDiff {
  const durBase = metricSeries(baseline, (r) => r.duration_ms);
  const durComp = metricSeries(comparison, (r) => r.duration_ms);

  const toolBase = baseline.map((r) => r.tool_call_total);
  const toolComp = comparison.map((r) => r.tool_call_total);

  const failBase = baseline.map((r) => r.tool_failure_rate);
  const failComp = comparison.map((r) => r.tool_failure_rate);

  const editBase = metricSeries(baseline, (r) => r.time_to_first_edit_ms);
  const editComp = metricSeries(comparison, (r) => r.time_to_first_edit_ms);

  const tokenBase = baseline.map((r) => r.tokens.input + r.tokens.output + r.tokens.cache);
  const tokenComp = comparison.map((r) => r.tokens.input + r.tokens.output + r.tokens.cache);

  const completedBase = countOutcome(baseline, "completed");
  const completedComp = countOutcome(comparison, "completed");
  const abortedBase = countOutcome(baseline, "aborted");
  const abortedComp = countOutcome(comparison, "aborted");
  const forcedBase = countOutcome(baseline, "forced_close");
  const forcedComp = countOutcome(comparison, "forced_close");

  const diff: CohortDiff = {
    metrics: {
      duration_ms: buildMetricDiff(durBase, durComp),
      tool_call_total: buildMetricDiff(toolBase, toolComp),
      tool_failure_rate: buildMetricDiff(failBase, failComp),
      time_to_first_edit_ms: buildMetricDiff(editBase, editComp),
      tokens_total: buildMetricDiff(tokenBase, tokenComp),
    },
    rates: {
      completion_rate: buildRateDiff(completedBase, baseline.length, completedComp, comparison.length),
      abort_rate: buildRateDiff(abortedBase, baseline.length, abortedComp, comparison.length),
      forced_close_rate: buildRateDiff(forcedBase, baseline.length, forcedComp, comparison.length),
    },
    alarms: [],
    samples: { baseline_n: baseline.length, comparison_n: comparison.length },
  };

  diff.alarms = evaluateAlarms(diff, thresholds);
  return diff;
}

// ────────────────────────────────────────────────────────────────────────
// S5: evaluateAlarms
// ────────────────────────────────────────────────────────────────────────

/** 各 metric が alarm 閾値を超えたかを判定する。direction 信号は thresholds 側を信頼する。 */
export function evaluateAlarms(
  diff: CohortDiff,
  thresholds: AlarmThresholds,
): AlarmSignal[] {
  const out: AlarmSignal[] = [];

  for (const [metric, th] of Object.entries(thresholds)) {
    const eval_ = evaluateOne(diff, metric, th);
    if (eval_) out.push(eval_);
  }
  return out;
}

function evaluateOne(diff: CohortDiff, metric: string, th: AlarmThreshold): AlarmSignal | null {
  // metric 名と CohortDiff 構造の対応を取る
  let actualDelta: number;
  let valid: boolean;

  switch (metric) {
    case "completion_rate":
      actualDelta = diff.rates.completion_rate.delta_pp;
      valid = diff.samples.baseline_n > 0 && diff.samples.comparison_n > 0;
      break;
    case "forced_close_rate":
      actualDelta = diff.rates.forced_close_rate.delta_pp;
      valid = diff.samples.baseline_n > 0 && diff.samples.comparison_n > 0;
      break;
    case "duration_ms_mean":
      actualDelta = th.unit === "pct"
        ? diff.metrics.duration_ms.delta_pct
        : diff.metrics.duration_ms.delta;
      // pct の場合 baseline_mean が 0 だと評価不能 (N/A)
      valid = th.unit === "pct"
        ? diff.metrics.duration_ms.baseline_mean !== 0
        : true;
      break;
    case "tool_failure_rate":
      actualDelta = th.unit === "pp"
        ? diff.metrics.tool_failure_rate.delta
        : diff.metrics.tool_failure_rate.delta_pct;
      valid = diff.samples.baseline_n > 0 && diff.samples.comparison_n > 0;
      break;
    default:
      return null; // 未知の metric 名は noop
  }

  if (!valid) return null;
  // 浮動小数の自然な丸め誤差で「ぴったり閾値」のときに alarm 化しないよう、
  // strict greater (`>`) / strict less (`<`) を使う
  const exceeded = th.direction === "higher_is_worse"
    ? actualDelta > th.delta
    : actualDelta < -th.delta;
  if (!exceeded) return null;
  return {
    metric,
    direction: th.direction,
    delta: actualDelta,
    threshold_delta: th.delta,
    threshold_unit: th.unit,
  };
}

// ────────────────────────────────────────────────────────────────────────
// S5: derivePerDayFromSnapshots
// ────────────────────────────────────────────────────────────────────────

export function derivePerDayFromSnapshots(snapshots: DailySnapshot[]): PerBucketMetrics[] {
  const sorted = [...snapshots].sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
  return sorted.map((s) => {
    const total = s.period.tasks_assigned;
    return {
      bucket: s.snapshot_date,
      tasks_assigned: total,
      tasks_completed: s.period.tasks_completed,
      tasks_aborted: s.period.tasks_aborted,
      completion_rate: s.period.completion_rate,
      abort_rate: s.period.abort_rate,
      forced_close_rate: s.period.forced_close_rate,
      // deny_rate は per_day 派生では未計算（snapshot fact に含まれないため 0）
      deny_rate: 0,
      tool_call_total: s.per_task.reduce((acc, p) => acc + p.tool_call_total, 0),
      tool_call_stddev: 0,
      duration_ms_mean: s.period.duration_ms_mean,
      duration_ms_stddev: s.period.duration_ms_stddev,
      tokens_total: {
        input: s.per_task.reduce((acc, p) => acc + p.tokens.input, 0),
        output: s.per_task.reduce((acc, p) => acc + p.tokens.output, 0),
        cache: s.per_task.reduce((acc, p) => acc + p.tokens.cache, 0),
      },
    };
  });
}

// ────────────────────────────────────────────────────────────────────────
// S6: CLI
// ────────────────────────────────────────────────────────────────────────

export interface RunMetricsCompareCliOpts {
  args: string[];
  projectRoot: string;
  stdout: { write(s: string): boolean };
  stderr: { write(s: string): boolean };
  abortSignal: AbortSignal;
}

interface ParsedCompareArgs {
  baseline: { from: string; to: string } | null;
  comparison: { from: string; to: string } | null;
  format: "json" | "text";
  snapshotDir: string | null;
  allowOutsideProject: boolean;
  help: boolean;
}

const COMPARE_FLAGS = new Set([
  "--baseline",
  "--comparison",
  "--format",
  "--snapshot-dir",
  "--allow-outside-project",
  "--help",
  "-h",
]);
const COMPARE_FLAGS_WITH_VALUE = new Set(["--baseline", "--comparison", "--format", "--snapshot-dir"]);

class ArgError extends Error {}

const RANGE_RE = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/;

function parseRange(label: string, raw: string): { from: string; to: string } {
  const m = RANGE_RE.exec(raw);
  if (!m) {
    throw new ArgError(`${label} must be YYYY-MM-DD..YYYY-MM-DD: got ${raw}`);
  }
  const from = m[1]!;
  const to = m[2]!;
  if (from > to) {
    throw new ArgError(`${label} range from > to: ${from} > ${to}`);
  }
  return { from, to };
}

function parseCompareArgs(argv: string[]): ParsedCompareArgs {
  const out: ParsedCompareArgs = {
    baseline: null,
    comparison: null,
    format: "json",
    snapshotDir: null,
    allowOutsideProject: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!COMPARE_FLAGS.has(a)) {
      throw new ArgError(`unknown flag: ${a}`);
    }
    if (a === "--help" || a === "-h") {
      out.help = true;
      continue;
    }
    if (a === "--allow-outside-project") {
      out.allowOutsideProject = true;
      continue;
    }
    if (COMPARE_FLAGS_WITH_VALUE.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || COMPARE_FLAGS.has(v)) {
        throw new ArgError(`${a} requires a value`);
      }
      i++;
      if (a === "--baseline") out.baseline = parseRange("--baseline", v);
      else if (a === "--comparison") out.comparison = parseRange("--comparison", v);
      else if (a === "--format") {
        if (v !== "json" && v !== "text") {
          throw new ArgError(`invalid --format value: ${v} (must be json or text)`);
        }
        out.format = v;
      } else if (a === "--snapshot-dir") out.snapshotDir = v;
    }
  }
  return out;
}

export async function runMetricsCompareCli(opts: RunMetricsCompareCliOpts): Promise<number> {
  const argv = opts.args[0] === "compare" ? opts.args.slice(1) : opts.args;

  let parsed: ParsedCompareArgs;
  try {
    parsed = parseCompareArgs(argv);
  } catch (e) {
    if (e instanceof ArgError) {
      opts.stderr.write(`Error: ${e.message}\n`);
      opts.stderr.write(`Run 'cmux-team metrics compare --help' for usage.\n`);
      return 1;
    }
    throw e;
  }

  if (parsed.help) {
    opts.stdout.write(t("help_metrics_compare"));
    opts.stdout.write("\n");
    return 0;
  }
  if (!parsed.baseline) {
    opts.stderr.write("Error: --baseline is required (FORMAT: YYYY-MM-DD..YYYY-MM-DD)\n");
    return 1;
  }
  if (!parsed.comparison) {
    opts.stderr.write("Error: --comparison is required (FORMAT: YYYY-MM-DD..YYYY-MM-DD)\n");
    return 1;
  }

  let snapshotDir: string;
  if (parsed.snapshotDir) {
    const r = resolveUnderRoot(opts.projectRoot, parsed.snapshotDir, {
      allowOutside: parsed.allowOutsideProject,
    });
    if (r.outside && !parsed.allowOutsideProject) {
      opts.stderr.write(
        "Error: --snapshot-dir resolves outside projectRoot. Pass --allow-outside-project to override.\n",
      );
      return 1;
    }
    snapshotDir = r.path;
  } else {
    snapshotDir = join(opts.projectRoot, ".team/metrics/snapshots");
  }

  const baseline = await loadSnapshotsInRange(snapshotDir, parsed.baseline.from, parsed.baseline.to);
  const comparison = await loadSnapshotsInRange(snapshotDir, parsed.comparison.from, parsed.comparison.to);

  const baselineUnion = unionPerTask(baseline.snapshots);
  const comparisonUnion = unionPerTask(comparison.snapshots);
  const cohortDiff = compareCohorts(baselineUnion, comparisonUnion);

  const skipped = [...baseline.skipped, ...comparison.skipped];
  const missing = [...new Set([...baseline.missing, ...comparison.missing])].sort();

  const payload = {
    baseline_range: `${parsed.baseline.from}..${parsed.baseline.to}`,
    comparison_range: `${parsed.comparison.from}..${parsed.comparison.to}`,
    ...cohortDiff,
    skipped_files: skipped,
    missing,
  };

  if (parsed.format === "json") {
    opts.stdout.write(JSON.stringify(payload, null, 2));
    opts.stdout.write("\n");
  } else {
    opts.stdout.write(formatTextCohort(payload));
    opts.stdout.write("\n");
  }

  return cohortDiff.alarms.length > 0 ? 2 : 0;
}

type CohortPayload = {
  baseline_range: string;
  comparison_range: string;
  metrics: CohortDiff["metrics"];
  rates: CohortDiff["rates"];
  alarms: CohortDiff["alarms"];
  samples: CohortDiff["samples"];
  skipped_files: string[];
  missing: string[];
};

function formatTextCohort(p: CohortPayload): string {
  const lines: string[] = [];
  lines.push(`baseline=${p.baseline_range} (n=${p.samples.baseline_n})`);
  lines.push(`comparison=${p.comparison_range} (n=${p.samples.comparison_n})`);
  lines.push("metrics:");
  for (const [k, v] of Object.entries(p.metrics)) {
    lines.push(
      `  ${k}: baseline=${v.baseline_mean.toFixed(2)} comparison=${v.comparison_mean.toFixed(2)} ` +
        `delta=${v.delta.toFixed(2)} delta_pct=${(v.delta_pct * 100).toFixed(1)}% ` +
        `t=${formatT(v.t_test)} mw_p=${v.mann_whitney.p.toFixed(4)}`,
    );
  }
  lines.push("rates:");
  for (const [k, v] of Object.entries(p.rates)) {
    lines.push(
      `  ${k}: baseline=${(v.baseline * 100).toFixed(1)}% comparison=${(v.comparison * 100).toFixed(1)}% ` +
        `delta_pp=${(v.delta_pp * 100).toFixed(1)}pp z=${v.z_test.z.toFixed(2)} p=${v.z_test.p.toFixed(4)}`,
    );
  }
  if (p.alarms.length > 0) {
    lines.push("alarms:");
    for (const a of p.alarms) {
      lines.push(
        `  ! ${a.metric} (${a.direction}) delta=${a.delta.toFixed(4)} threshold=${a.threshold_delta}${a.threshold_unit}`,
      );
    }
  } else {
    lines.push("alarms: (none)");
  }
  if (p.skipped_files.length > 0) {
    lines.push(`skipped_files: ${p.skipped_files.join(", ")}`);
  }
  if (p.missing.length > 0) {
    lines.push(`missing: ${p.missing.join(", ")}`);
  }
  return lines.join("\n");
}

function formatT(r: WelchResult): string {
  if (Number.isNaN(r.t)) return "NaN";
  return `${r.t.toFixed(2)}(p=${r.p.toFixed(4)})`;
}

