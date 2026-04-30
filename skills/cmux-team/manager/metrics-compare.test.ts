/**
 * T381 S4 / S5 / S6: metrics-compare のテスト。
 * - S4: loadSnapshotsInRange + unionPerTask (dedup 2 段ルール)
 * - S5: compareCohorts + evaluateAlarms + derivePerDayFromSnapshots
 * - S6: runMetricsCompareCli
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { createDummyProject, type DummyProject } from "./test-project";
import {
  loadSnapshotsInRange,
  unionPerTask,
  compareCohorts,
  evaluateAlarms,
  derivePerDayFromSnapshots,
  runMetricsCompareCli,
} from "./metrics-compare";
import type { DailySnapshot } from "./metrics-snapshot";
import type { PerTaskMetrics } from "./metrics-aggregate";
import { DEFAULT_ALARM_THRESHOLDS } from "./metrics-thresholds";

let project: DummyProject;

beforeEach(async () => {
  project = await createDummyProject({ prefix: "cmux-metrics-compare-test-" });
});

afterEach(async () => {
  await project.dispose();
});

interface CapturedStreams {
  out: string[];
  err: string[];
  stdout: { write(s: string): boolean };
  stderr: { write(s: string): boolean };
  outText(): string;
  errText(): string;
}

function captureStreams(): CapturedStreams {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: { write: (s: string) => { out.push(s); return true; } },
    stderr: { write: (s: string) => { err.push(s); return true; } },
    outText: () => out.join(""),
    errText: () => err.join(""),
  };
}

function makePerTask(taskId: string, opts: Partial<PerTaskMetrics> = {}): PerTaskMetrics {
  return {
    task_id: taskId,
    assigned_ts: opts.assigned_ts ?? "2026-04-29T10:00:00.000Z",
    closed_ts: opts.closed_ts ?? null,
    duration_ms: opts.duration_ms ?? null,
    outcome: opts.outcome ?? "open",
    tool_calls: opts.tool_calls ?? {},
    tool_call_total: opts.tool_call_total ?? 0,
    tool_failure_rate: opts.tool_failure_rate ?? 0,
    time_to_first_edit_ms: opts.time_to_first_edit_ms ?? null,
    tokens: opts.tokens ?? { input: 0, output: 0, cache: 0, requests: 0 },
  };
}

function makeSnapshot(date: string, perTask: PerTaskMetrics[]): DailySnapshot {
  const completed = perTask.filter((p) => p.outcome === "completed").length;
  const aborted = perTask.filter((p) => p.outcome === "aborted").length;
  const forcedClose = perTask.filter((p) => p.outcome === "forced_close").length;
  const stateMismatch = perTask.filter((p) => p.outcome === "state_mismatch").length;
  const total = perTask.length;
  const durations = perTask.map((p) => p.duration_ms).filter((d): d is number => d !== null);
  const meanDur = durations.length === 0 ? 0 : durations.reduce((a, b) => a + b, 0) / durations.length;
  return {
    schema_version: 1,
    snapshot_date: date,
    window: { from: `${date}T00:00:00.000Z`, to: `${date}T00:00:00.000Z` },
    per_task: perTask,
    period: {
      tasks_assigned: total,
      tasks_completed: completed,
      tasks_aborted: aborted,
      tasks_forced_close: forcedClose,
      tasks_state_mismatch: stateMismatch,
      completion_rate: total === 0 ? 0 : completed / total,
      abort_rate: total === 0 ? 0 : aborted / total,
      forced_close_rate: total === 0 ? 0 : forcedClose / total,
      duration_ms_mean: meanDur,
      duration_ms_stddev: 0,
    },
    metadata: {
      generated_at: new Date().toISOString(),
      events_jsonl_size_bytes: 0,
      events_jsonl_path: "",
      traces_db_path: "",
    },
  };
}

async function writeSnapshotFile(dir: string, snap: DailySnapshot): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${snap.snapshot_date}.json`), JSON.stringify(snap, null, 2));
}

// ────────────────────────────────────────────────────────────────────────
// S4: loadSnapshotsInRange / unionPerTask
// ────────────────────────────────────────────────────────────────────────

describe("loadSnapshotsInRange (S4)", () => {
  test("3 日範囲 + 中間 1 日 missing で missing に列挙", async () => {
    const dir = join(project.root, ".team/metrics/snapshots");
    await writeSnapshotFile(dir, makeSnapshot("2026-04-29", []));
    await writeSnapshotFile(dir, makeSnapshot("2026-05-01", []));
    const r = await loadSnapshotsInRange(dir, "2026-04-29", "2026-05-01");
    expect(r.snapshots.length).toBe(2);
    expect(r.missing).toEqual(["2026-04-30"]);
    expect(r.skipped).toEqual([]);
  });

  test("schema_version != 1 は skipped に列挙", async () => {
    const dir = join(project.root, ".team/metrics/snapshots");
    await mkdir(dir, { recursive: true });
    const bogus = { ...makeSnapshot("2026-04-29", []), schema_version: 99 as unknown as 1 };
    await writeFile(join(dir, "2026-04-29.json"), JSON.stringify(bogus));
    const r = await loadSnapshotsInRange(dir, "2026-04-29", "2026-04-29");
    expect(r.snapshots.length).toBe(0);
    expect(r.skipped).toContain("2026-04-29.json");
  });

  test("JSON parse 失敗は skipped に列挙", async () => {
    const dir = join(project.root, ".team/metrics/snapshots");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "2026-04-29.json"), "not-json");
    const r = await loadSnapshotsInRange(dir, "2026-04-29", "2026-04-29");
    expect(r.snapshots.length).toBe(0);
    expect(r.skipped).toContain("2026-04-29.json");
  });

  test("range の from > to で throw", async () => {
    await expect(
      loadSnapshotsInRange(project.root, "2026-05-01", "2026-04-29"),
    ).rejects.toThrow();
  });
});

describe("unionPerTask (S4 dedup 2 段ルール)", () => {
  test("open + closed → closed が採用", () => {
    const s1 = makeSnapshot("2026-04-29", [makePerTask("T1", { outcome: "open" })]);
    const s2 = makeSnapshot("2026-04-30", [makePerTask("T1", { outcome: "completed", duration_ms: 1000 })]);
    const u = unionPerTask([s1, s2]);
    expect(u.length).toBe(1);
    expect(u[0]!.outcome).toBe("completed");
  });

  test("closed + closed → snapshot_date 昇順最後（=後発）が採用", () => {
    const s1 = makeSnapshot("2026-04-29", [makePerTask("T1", { outcome: "completed", duration_ms: 1000 })]);
    const s2 = makeSnapshot("2026-04-30", [makePerTask("T1", { outcome: "completed", duration_ms: 2000 })]);
    const u = unionPerTask([s2, s1]); // 順序がランダムでも同じ結果
    expect(u.length).toBe(1);
    expect(u[0]!.duration_ms).toBe(2000);
  });

  test("open + open → snapshot_date 昇順最後", () => {
    const s1 = makeSnapshot("2026-04-29", [makePerTask("T1", { outcome: "open", duration_ms: 100 })]);
    const s2 = makeSnapshot("2026-04-30", [makePerTask("T1", { outcome: "open", duration_ms: 200 })]);
    const u = unionPerTask([s1, s2]);
    expect(u.length).toBe(1);
    expect(u[0]!.duration_ms).toBe(200);
  });

  test("複数タスクが混在しても各タスクで dedup", () => {
    const s1 = makeSnapshot("2026-04-29", [
      makePerTask("T1", { outcome: "open" }),
      makePerTask("T2", { outcome: "completed", duration_ms: 1 }),
    ]);
    const s2 = makeSnapshot("2026-04-30", [
      makePerTask("T1", { outcome: "completed", duration_ms: 5 }),
      makePerTask("T2", { outcome: "completed", duration_ms: 9 }), // 同 outcome なら後発
    ]);
    const u = unionPerTask([s1, s2]).sort((a, b) => a.task_id.localeCompare(b.task_id));
    expect(u.length).toBe(2);
    expect(u[0]!.task_id).toBe("T1");
    expect(u[0]!.outcome).toBe("completed");
    expect(u[1]!.task_id).toBe("T2");
    expect(u[1]!.duration_ms).toBe(9);
  });
});

// ────────────────────────────────────────────────────────────────────────
// S5: compareCohorts + evaluateAlarms + derivePerDayFromSnapshots
// ────────────────────────────────────────────────────────────────────────

describe("compareCohorts (S5)", () => {
  test("baseline と comparison の主要 metric 差分と統計検定を返す", () => {
    const baseline: PerTaskMetrics[] = [
      makePerTask("B1", { outcome: "completed", duration_ms: 1000, tool_call_total: 5 }),
      makePerTask("B2", { outcome: "completed", duration_ms: 1100, tool_call_total: 6 }),
      makePerTask("B3", { outcome: "completed", duration_ms: 900, tool_call_total: 4 }),
    ];
    const comparison: PerTaskMetrics[] = [
      makePerTask("C1", { outcome: "completed", duration_ms: 2000, tool_call_total: 10 }),
      makePerTask("C2", { outcome: "completed", duration_ms: 2200, tool_call_total: 12 }),
      makePerTask("C3", { outcome: "completed", duration_ms: 1800, tool_call_total: 8 }),
    ];
    const r = compareCohorts(baseline, comparison);
    expect(r.samples.baseline_n).toBe(3);
    expect(r.samples.comparison_n).toBe(3);
    expect(r.metrics.duration_ms.baseline_mean).toBe(1000);
    expect(r.metrics.duration_ms.comparison_mean).toBe(2000);
    expect(r.metrics.duration_ms.delta).toBe(1000);
    expect(r.metrics.duration_ms.t_test.t).toBeDefined();
    expect(r.metrics.duration_ms.mann_whitney.u).toBeDefined();
  });

  test("rates: completion_rate / abort_rate / forced_close_rate が z-test 付きで出る", () => {
    const baseline: PerTaskMetrics[] = [
      makePerTask("B1", { outcome: "completed" }),
      makePerTask("B2", { outcome: "completed" }),
      makePerTask("B3", { outcome: "completed" }),
      makePerTask("B4", { outcome: "completed" }),
      makePerTask("B5", { outcome: "completed" }),
    ];
    const comparison: PerTaskMetrics[] = [
      makePerTask("C1", { outcome: "completed" }),
      makePerTask("C2", { outcome: "aborted" }),
      makePerTask("C3", { outcome: "aborted" }),
      makePerTask("C4", { outcome: "aborted" }),
      makePerTask("C5", { outcome: "aborted" }),
    ];
    const r = compareCohorts(baseline, comparison);
    expect(r.rates.completion_rate.baseline).toBe(1);
    expect(r.rates.completion_rate.comparison).toBe(0.2);
    expect(r.rates.completion_rate.delta_pp).toBe(-0.8);
    expect(r.rates.completion_rate.z_test.p).toBeLessThan(0.05);
  });

  test("空 cohort で n=0 でも crash しない", () => {
    const r = compareCohorts([], []);
    expect(r.samples.baseline_n).toBe(0);
    expect(r.samples.comparison_n).toBe(0);
    expect(r.metrics.duration_ms.t_test.p).toBe(1);
    expect(r.alarms.length).toBe(0);
  });
});

describe("evaluateAlarms (S5 alarm マトリクス)", () => {
  // direction map マトリクス: lower_is_worse / higher_is_worse × {超過 / 未超過 / 境界 / N/A}
  test("completion_rate (lower_is_worse) -10pp 超 → alarm", () => {
    const baseline: PerTaskMetrics[] = [
      makePerTask("B1", { outcome: "completed" }),
      makePerTask("B2", { outcome: "completed" }),
      makePerTask("B3", { outcome: "completed" }),
      makePerTask("B4", { outcome: "completed" }),
      makePerTask("B5", { outcome: "completed" }),
    ];
    const comparison: PerTaskMetrics[] = [
      makePerTask("C1", { outcome: "completed" }),
      makePerTask("C2", { outcome: "completed" }),
      makePerTask("C3", { outcome: "aborted" }),
      makePerTask("C4", { outcome: "aborted" }),
      makePerTask("C5", { outcome: "aborted" }),
    ];
    // baseline=1.0, comparison=0.4 → delta=-0.6 pp（threshold -0.10 を大きく超え）
    const diff = compareCohorts(baseline, comparison);
    const a = evaluateAlarms(diff, DEFAULT_ALARM_THRESHOLDS);
    expect(a.find((al) => al.metric === "completion_rate")).toBeDefined();
  });

  test("completion_rate (lower_is_worse) -5pp 未超 → alarm 無し", () => {
    // baseline 100%、comparison 95% → delta -5pp、threshold -10pp なので未超
    const baseline: PerTaskMetrics[] = Array.from({ length: 20 }, (_, i) =>
      makePerTask(`B${i}`, { outcome: "completed" }),
    );
    const comparison: PerTaskMetrics[] = [
      ...Array.from({ length: 19 }, (_, i) => makePerTask(`C${i}`, { outcome: "completed" })),
      makePerTask("Cx", { outcome: "aborted" }),
    ];
    const diff = compareCohorts(baseline, comparison);
    const a = evaluateAlarms(diff, DEFAULT_ALARM_THRESHOLDS);
    expect(a.find((al) => al.metric === "completion_rate")).toBeUndefined();
  });

  test("forced_close_rate (higher_is_worse) +10pp 超 → alarm", () => {
    const baseline: PerTaskMetrics[] = Array.from({ length: 10 }, (_, i) =>
      makePerTask(`B${i}`, { outcome: "completed" }),
    );
    const comparison: PerTaskMetrics[] = [
      ...Array.from({ length: 8 }, (_, i) => makePerTask(`C${i}`, { outcome: "completed" })),
      makePerTask("Cf1", { outcome: "forced_close" }),
      makePerTask("Cf2", { outcome: "forced_close" }),
    ];
    const diff = compareCohorts(baseline, comparison);
    const a = evaluateAlarms(diff, DEFAULT_ALARM_THRESHOLDS);
    expect(a.find((al) => al.metric === "forced_close_rate")).toBeDefined();
  });

  test("duration_ms_mean (higher_is_worse, pct) +50% 超 → alarm", () => {
    const baseline: PerTaskMetrics[] = [
      makePerTask("B1", { outcome: "completed", duration_ms: 1000 }),
      makePerTask("B2", { outcome: "completed", duration_ms: 1000 }),
    ];
    const comparison: PerTaskMetrics[] = [
      makePerTask("C1", { outcome: "completed", duration_ms: 1500 }),
      makePerTask("C2", { outcome: "completed", duration_ms: 1500 }),
    ];
    const diff = compareCohorts(baseline, comparison);
    const a = evaluateAlarms(diff, DEFAULT_ALARM_THRESHOLDS);
    expect(a.find((al) => al.metric === "duration_ms_mean")).toBeDefined();
  });

  test("duration_ms_mean (higher_is_worse, pct) baseline=0 → alarm 出さない (N/A)", () => {
    const baseline: PerTaskMetrics[] = [
      makePerTask("B1", { outcome: "open", duration_ms: null }),
    ];
    const comparison: PerTaskMetrics[] = [
      makePerTask("C1", { outcome: "completed", duration_ms: 5000 }),
    ];
    const diff = compareCohorts(baseline, comparison);
    const a = evaluateAlarms(diff, DEFAULT_ALARM_THRESHOLDS);
    // baseline_mean=0 では pct が定義不能なので alarm を出さない
    expect(a.find((al) => al.metric === "duration_ms_mean")).toBeUndefined();
  });

  test("higher_is_worse の境界一致では alarm 出さない (delta == threshold は超過しない)", () => {
    // forced_close_rate baseline=0, comparison=0.05 = +5pp、threshold=0.05 なので超過しない
    const baseline: PerTaskMetrics[] = Array.from({ length: 20 }, (_, i) =>
      makePerTask(`B${i}`, { outcome: "completed" }),
    );
    const comparison: PerTaskMetrics[] = [
      ...Array.from({ length: 19 }, (_, i) => makePerTask(`C${i}`, { outcome: "completed" })),
      makePerTask("Cfc", { outcome: "forced_close" }),
    ];
    const diff = compareCohorts(baseline, comparison);
    const a = evaluateAlarms(diff, DEFAULT_ALARM_THRESHOLDS);
    expect(a.find((al) => al.metric === "forced_close_rate")).toBeUndefined();
  });
});

describe("derivePerDayFromSnapshots (S5)", () => {
  test("snapshot 群を snapshot_date 昇順に並べて per-day を派生", () => {
    const s2 = makeSnapshot("2026-04-30", [makePerTask("T2", { outcome: "completed" })]);
    const s1 = makeSnapshot("2026-04-29", [makePerTask("T1", { outcome: "completed" })]);
    const days = derivePerDayFromSnapshots([s2, s1]);
    expect(days.length).toBe(2);
    expect(days[0]!.bucket).toBe("2026-04-29");
    expect(days[1]!.bucket).toBe("2026-04-30");
  });
});

// ────────────────────────────────────────────────────────────────────────
// S6: runMetricsCompareCli
// ────────────────────────────────────────────────────────────────────────

describe("runMetricsCompareCli (S6)", () => {
  test("--help で help 出力 + exit 0", async () => {
    const { stdout, stderr, outText } = captureStreams();
    const ac = new AbortController();
    const code = await runMetricsCompareCli({
      args: ["compare", "--help"],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
    });
    expect(code).toBe(0);
    expect(outText().length).toBeGreaterThan(0);
  });

  test("--baseline / --comparison 必須 - なしで exit 1", async () => {
    const { stdout, stderr, errText } = captureStreams();
    const ac = new AbortController();
    const code = await runMetricsCompareCli({
      args: ["compare"],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
    });
    expect(code).toBe(1);
    expect(errText()).toMatch(/baseline|comparison/);
  });

  test("range 形式不正で exit 1", async () => {
    const { stdout, stderr, errText } = captureStreams();
    const ac = new AbortController();
    const code = await runMetricsCompareCli({
      args: ["compare", "--baseline", "2026-04-29", "--comparison", "2026-04-30..2026-05-01"],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
    });
    expect(code).toBe(1);
    expect(errText()).toMatch(/baseline|range/i);
  });

  test("範囲 from > to で exit 1", async () => {
    const { stdout, stderr, errText } = captureStreams();
    const ac = new AbortController();
    const code = await runMetricsCompareCli({
      args: ["compare", "--baseline", "2026-05-01..2026-04-29", "--comparison", "2026-04-30..2026-05-01"],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
    });
    expect(code).toBe(1);
    expect(errText()).toMatch(/range|from|>/i);
  });

  test("通常 compare で diff JSON を stdout に出力 (exit 0)", async () => {
    const dir = join(project.root, ".team/metrics/snapshots");
    await writeSnapshotFile(dir, makeSnapshot("2026-04-29", [
      makePerTask("B1", { outcome: "completed", duration_ms: 1000 }),
      makePerTask("B2", { outcome: "completed", duration_ms: 1100 }),
    ]));
    await writeSnapshotFile(dir, makeSnapshot("2026-04-30", [
      makePerTask("C1", { outcome: "completed", duration_ms: 1050 }),
      makePerTask("C2", { outcome: "completed", duration_ms: 1080 }),
    ]));
    const { stdout, stderr, outText } = captureStreams();
    const ac = new AbortController();
    const code = await runMetricsCompareCli({
      args: ["compare", "--baseline", "2026-04-29..2026-04-29", "--comparison", "2026-04-30..2026-04-30"],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
    });
    expect(code).toBe(0);
    const json = JSON.parse(outText());
    expect(json.metrics).toBeDefined();
    expect(json.rates).toBeDefined();
    expect(json.alarms).toEqual([]);
    expect(json.samples.baseline_n).toBe(2);
    expect(json.samples.comparison_n).toBe(2);
  });

  test("alarm が立つケースで exit 2", async () => {
    const dir = join(project.root, ".team/metrics/snapshots");
    // baseline 100% completed
    await writeSnapshotFile(dir, makeSnapshot("2026-04-29", [
      makePerTask("B1", { outcome: "completed", duration_ms: 1000 }),
      makePerTask("B2", { outcome: "completed", duration_ms: 1000 }),
      makePerTask("B3", { outcome: "completed", duration_ms: 1000 }),
      makePerTask("B4", { outcome: "completed", duration_ms: 1000 }),
      makePerTask("B5", { outcome: "completed", duration_ms: 1000 }),
    ]));
    // comparison 半分 abort
    await writeSnapshotFile(dir, makeSnapshot("2026-04-30", [
      makePerTask("C1", { outcome: "completed", duration_ms: 1000 }),
      makePerTask("C2", { outcome: "completed", duration_ms: 1000 }),
      makePerTask("C3", { outcome: "aborted" }),
      makePerTask("C4", { outcome: "aborted" }),
      makePerTask("C5", { outcome: "aborted" }),
    ]));
    const { stdout, stderr, outText } = captureStreams();
    const ac = new AbortController();
    const code = await runMetricsCompareCli({
      args: ["compare", "--baseline", "2026-04-29..2026-04-29", "--comparison", "2026-04-30..2026-04-30"],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
    });
    expect(code).toBe(2);
    const json = JSON.parse(outText());
    expect(json.alarms.length).toBeGreaterThan(0);
    expect(json.alarms.some((a: { metric: string }) => a.metric === "completion_rate")).toBe(true);
  });

  test("--snapshot-dir が projectRoot 外 → exit 1 (--allow-outside-project 無)", async () => {
    const { stdout, stderr, errText } = captureStreams();
    const ac = new AbortController();
    const code = await runMetricsCompareCli({
      args: ["compare", "--baseline", "2026-04-29..2026-04-29", "--comparison", "2026-04-30..2026-04-30",
        "--snapshot-dir", "/tmp/cmux-team-traversal-compare"],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
    });
    expect(code).toBe(1);
    expect(errText()).toMatch(/outside.*project/i);
  });

  test("--format text で alarm 行を含む人間向け出力", async () => {
    const dir = join(project.root, ".team/metrics/snapshots");
    await writeSnapshotFile(dir, makeSnapshot("2026-04-29", [
      makePerTask("B1", { outcome: "completed", duration_ms: 1000 }),
      makePerTask("B2", { outcome: "completed", duration_ms: 1000 }),
    ]));
    await writeSnapshotFile(dir, makeSnapshot("2026-04-30", [
      makePerTask("C1", { outcome: "completed", duration_ms: 1500 }),
      makePerTask("C2", { outcome: "completed", duration_ms: 1500 }),
    ]));
    const { stdout, stderr, outText } = captureStreams();
    const ac = new AbortController();
    const code = await runMetricsCompareCli({
      args: ["compare", "--baseline", "2026-04-29..2026-04-29", "--comparison", "2026-04-30..2026-04-30", "--format", "text"],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
    });
    expect(code).toBe(2);
    const text = outText();
    expect(text).toMatch(/duration_ms/);
    expect(text).toMatch(/alarm/i);
  });
});
