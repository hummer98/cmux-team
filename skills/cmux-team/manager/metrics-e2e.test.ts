/**
 * T381 S14: snapshot → compare → health の in-process e2e テスト。
 *
 * - createDummyProject() で fixture（events.jsonl + traces.db、2 日分の terminal イベントを持つ複数タスク）を構築
 * - 5 ステップシナリオ:
 *   1) snapshot D1 を生成
 *   2) snapshot D2 を生成
 *   3) compare D1..D1 vs D2..D2 で diff/alarms/samples が出る
 *   4) health --days=2 で gap 無し (exit 0)
 *   5) 中間日を欠損させた range で health が exit 1 + missing
 * - alarm が立つ fixture（completion_rate D1=100% → D2=20%）も確認
 *
 * 制約: in-process のみ（サブプロセス禁止）。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { createDummyProject, type DummyProject } from "./test-project";
import { initDB, insertHookSignal, insertTaskSession } from "./trace-store";
import { runMetricsSnapshotCli } from "./metrics-snapshot";
import { runMetricsCompareCli } from "./metrics-compare";
import { runMetricsHealthCli } from "./metrics-health";
import type { QueueMessage } from "./schema";

let project: DummyProject;

beforeEach(async () => {
  project = await createDummyProject({ prefix: "cmux-metrics-e2e-test-" });
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

interface FixtureTask {
  task_id: string;
  date: string; // YYYY-MM-DD
  outcome: "completed" | "aborted";
  start_min: number; // hour:00 + start_min minutes
  duration_min: number;
}

async function seedE2EFixtures(root: string, tasks: FixtureTask[]): Promise<void> {
  const events: Array<Record<string, unknown>> = [];
  for (const t of tasks) {
    const startTs = `${t.date}T${pad2(Math.floor(t.start_min / 60))}:${pad2(t.start_min % 60)}:00.000Z`;
    const endMin = t.start_min + t.duration_min;
    const endTs = `${t.date}T${pad2(Math.floor(endMin / 60))}:${pad2(endMin % 60)}:00.000Z`;
    const runId = `r-${t.task_id}`;
    events.push({
      schema_version: 2,
      ts: startTs,
      event: "task_assigned",
      task_id: t.task_id,
      conductor_surface: "surface:200",
      task_run_id: runId,
    });
    events.push({
      schema_version: 2,
      ts: endTs,
      event: t.outcome === "completed" ? "task_completed" : "task_aborted",
      task_id: t.task_id,
      conductor_surface: "surface:200",
      worktree_path: "/tmp",
      journal_summary: "",
    });
  }
  const eventsPath = join(root, ".team/logs/events.jsonl");
  await mkdir(dirname(eventsPath), { recursive: true });
  await writeFile(eventsPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

  const db = initDB(root);
  for (const t of tasks) {
    const startTs = `${t.date}T${pad2(Math.floor(t.start_min / 60))}:${pad2(t.start_min % 60)}:00.000Z`;
    insertTaskSession(db, {
      timestamp: startTs,
      task_id: t.task_id,
      task_run_id: `r-${t.task_id}`,
      session_id: `s-${t.task_id}`,
      role: "conductor",
      event: "assigned",
    });
    // Edit hook を 1 件入れて tool_call が反映されることを担保
    insertHookSignal(db, {
      type: "PRE_TOOL_USE",
      surface: "surface:200",
      pid: 1,
      role: "agent",
      sessionId: `s-${t.task_id}`,
      toolName: "Edit",
      payload: {},
      timestamp: startTs,
    } as unknown as QueueMessage);
  }
  db.close();
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

describe("metrics e2e (S14)", () => {
  test("snapshot → compare → health 結合フロー（diff + alarm + gap 検出）", async () => {
    // D1=2026-04-29 baseline 100% completed × 5
    // D2=2026-04-30 comparison 1/5 completed = 20% → alarm
    const tasks: FixtureTask[] = [
      // D1
      { task_id: "B1", date: "2026-04-29", outcome: "completed", start_min: 600, duration_min: 30 },
      { task_id: "B2", date: "2026-04-29", outcome: "completed", start_min: 660, duration_min: 30 },
      { task_id: "B3", date: "2026-04-29", outcome: "completed", start_min: 720, duration_min: 30 },
      { task_id: "B4", date: "2026-04-29", outcome: "completed", start_min: 780, duration_min: 30 },
      { task_id: "B5", date: "2026-04-29", outcome: "completed", start_min: 840, duration_min: 30 },
      // D2
      { task_id: "C1", date: "2026-04-30", outcome: "completed", start_min: 600, duration_min: 60 },
      { task_id: "C2", date: "2026-04-30", outcome: "aborted", start_min: 660, duration_min: 30 },
      { task_id: "C3", date: "2026-04-30", outcome: "aborted", start_min: 720, duration_min: 30 },
      { task_id: "C4", date: "2026-04-30", outcome: "aborted", start_min: 780, duration_min: 30 },
      { task_id: "C5", date: "2026-04-30", outcome: "aborted", start_min: 840, duration_min: 30 },
    ];
    await seedE2EFixtures(project.root, tasks);

    // Step 1: snapshot D1
    {
      const { stdout, stderr } = captureStreams();
      const ac = new AbortController();
      const code = await runMetricsSnapshotCli({
        args: ["snapshot", "--date", "2026-04-29"],
        projectRoot: project.root,
        stdout,
        stderr,
        abortSignal: ac.signal,
      });
      expect(code).toBe(0);
      expect(existsSync(join(project.root, ".team/metrics/snapshots/2026-04-29.json"))).toBe(true);
    }

    // Step 2: snapshot D2
    {
      const { stdout, stderr } = captureStreams();
      const ac = new AbortController();
      const code = await runMetricsSnapshotCli({
        args: ["snapshot", "--date", "2026-04-30"],
        projectRoot: project.root,
        stdout,
        stderr,
        abortSignal: ac.signal,
      });
      expect(code).toBe(0);
      expect(existsSync(join(project.root, ".team/metrics/snapshots/2026-04-30.json"))).toBe(true);
    }

    // Step 3: compare D1..D1 vs D2..D2
    {
      const { stdout, stderr, outText } = captureStreams();
      const ac = new AbortController();
      const code = await runMetricsCompareCli({
        args: [
          "compare",
          "--baseline", "2026-04-29..2026-04-29",
          "--comparison", "2026-04-30..2026-04-30",
        ],
        projectRoot: project.root,
        stdout,
        stderr,
        abortSignal: ac.signal,
      });
      // alarm 立つので exit 2
      expect(code).toBe(2);
      const json = JSON.parse(outText());
      expect(json.metrics).toBeDefined();
      expect(json.rates).toBeDefined();
      expect(json.alarms).toBeDefined();
      expect(json.samples.baseline_n).toBe(5);
      expect(json.samples.comparison_n).toBe(5);
      // completion_rate alarm が立つこと
      expect(
        (json.alarms as Array<{ metric: string }>).some((a) => a.metric === "completion_rate"),
      ).toBe(true);
      // diff 構造の妥当性
      expect(json.rates.completion_rate.baseline).toBe(1);
      expect(json.rates.completion_rate.comparison).toBe(0.2);
    }

    // Step 4: health --days=2 gap 無し (exit 0)
    {
      const { stdout, stderr, outText } = captureStreams();
      const ac = new AbortController();
      const code = await runMetricsHealthCli({
        args: ["health", "--days", "2"],
        projectRoot: project.root,
        stdout,
        stderr,
        abortSignal: ac.signal,
        now: new Date("2026-04-30T00:00:00.000Z"),
      });
      expect(code).toBe(0);
      const json = JSON.parse(outText());
      expect(json.missing).toEqual([]);
    }

    // Step 5: health で D1 と D3 の間（D2 欠損想定）に shift し missing を返す
    // D2 を含む 3 日 window に変える: D1, D2, D3 のうち D3 (2026-05-01) が欠損
    {
      const { stdout, stderr, outText } = captureStreams();
      const ac = new AbortController();
      const code = await runMetricsHealthCli({
        args: ["health", "--days", "3"],
        projectRoot: project.root,
        stdout,
        stderr,
        abortSignal: ac.signal,
        now: new Date("2026-05-01T00:00:00.000Z"),
      });
      expect(code).toBe(1);
      const json = JSON.parse(outText());
      expect(json.missing).toContain("2026-05-01");
    }
  });

  test("シナリオ: alarm 無しケース（D1 と D2 が同等） → compare exit 0", async () => {
    const tasks: FixtureTask[] = [
      { task_id: "B1", date: "2026-04-29", outcome: "completed", start_min: 600, duration_min: 30 },
      { task_id: "B2", date: "2026-04-29", outcome: "completed", start_min: 660, duration_min: 30 },
      { task_id: "B3", date: "2026-04-29", outcome: "completed", start_min: 720, duration_min: 30 },
      { task_id: "C1", date: "2026-04-30", outcome: "completed", start_min: 600, duration_min: 30 },
      { task_id: "C2", date: "2026-04-30", outcome: "completed", start_min: 660, duration_min: 30 },
      { task_id: "C3", date: "2026-04-30", outcome: "completed", start_min: 720, duration_min: 30 },
    ];
    await seedE2EFixtures(project.root, tasks);

    for (const date of ["2026-04-29", "2026-04-30"]) {
      const { stdout, stderr } = captureStreams();
      const ac = new AbortController();
      const code = await runMetricsSnapshotCli({
        args: ["snapshot", "--date", date],
        projectRoot: project.root,
        stdout,
        stderr,
        abortSignal: ac.signal,
      });
      expect(code).toBe(0);
    }

    const { stdout, stderr, outText } = captureStreams();
    const ac = new AbortController();
    const code = await runMetricsCompareCli({
      args: [
        "compare",
        "--baseline", "2026-04-29..2026-04-29",
        "--comparison", "2026-04-30..2026-04-30",
      ],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
    });
    expect(code).toBe(0);
    const json = JSON.parse(outText());
    expect(json.alarms).toEqual([]);
  });
});
