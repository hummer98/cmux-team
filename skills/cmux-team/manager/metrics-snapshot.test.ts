/**
 * T381 S2 / S3: metrics-snapshot のテスト。
 * - S2: buildDailySnapshot 純関数（aggregateMetricsByTask 1 度のみ呼ぶ、period 派生、per_day なし、metadata sub-object）
 * - S3: runMetricsSnapshotCli (atomic write + path traversal 対策)
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile, readdir } from "fs/promises";
import { dirname, join } from "path";
import { initDB, insertHookSignal, insertTaskSession } from "./trace-store";
import { createDummyProject, type DummyProject } from "./test-project";
import { buildDailySnapshot, runMetricsSnapshotCli, type DailySnapshot } from "./metrics-snapshot";
import type { QueueMessage } from "./schema";

let project: DummyProject;

beforeEach(async () => {
  project = await createDummyProject({ prefix: "cmux-metrics-snapshot-test-" });
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

async function writeEventsFixture(
  root: string,
  records: Array<Record<string, unknown>>,
): Promise<void> {
  const path = join(root, ".team/logs/events.jsonl");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

async function seedFixtures(root: string, dateIso: string): Promise<void> {
  await writeEventsFixture(root, [
    { schema_version: 2, ts: `${dateIso}T10:00:00.000Z`, event: "task_assigned", task_id: "T1", conductor_surface: "surface:200", task_run_id: "r1" },
    { schema_version: 2, ts: `${dateIso}T10:30:00.000Z`, event: "task_completed", task_id: "T1", conductor_surface: "surface:200", worktree_path: "/tmp", journal_summary: "" },
    { schema_version: 2, ts: `${dateIso}T11:00:00.000Z`, event: "task_assigned", task_id: "T2", conductor_surface: "surface:200", task_run_id: "r2" },
    { schema_version: 2, ts: `${dateIso}T11:45:00.000Z`, event: "task_aborted", task_id: "T2", conductor_surface: "surface:200" },
  ]);
  const db = initDB(root);
  insertTaskSession(db, {
    timestamp: `${dateIso}T10:00:00.000Z`,
    task_id: "T1",
    task_run_id: "r1",
    session_id: "s1",
    role: "conductor",
    event: "assigned",
  });
  insertHookSignal(db, {
    type: "PRE_TOOL_USE",
    surface: "surface:200",
    pid: 1,
    role: "agent",
    sessionId: "s1",
    toolName: "Edit",
    payload: {},
    timestamp: `${dateIso}T10:05:00.000Z`,
  } as unknown as QueueMessage);
  db.close();
}

// ────────────────────────────────────────────────────────────────────────
// S2: buildDailySnapshot 純関数
// ────────────────────────────────────────────────────────────────────────

describe("buildDailySnapshot (S2)", () => {
  test("snapshot_date 当日 UTC を [from, to) で window 化、per_task + period + metadata", async () => {
    const date = "2026-04-29";
    await seedFixtures(project.root, date);
    const db = initDB(project.root);
    try {
      const snap = await buildDailySnapshot({
        db,
        eventsFile: join(project.root, ".team/logs/events.jsonl"),
        snapshotDate: date,
        generatedAt: new Date("2026-05-01T00:05:00.000Z"),
      });
      expect(snap.schema_version).toBe(1);
      expect(snap.snapshot_date).toBe(date);
      expect(snap.window.from).toBe(`${date}T00:00:00.000Z`);
      expect(snap.window.to).toBe("2026-04-30T00:00:00.000Z");
      expect(Array.isArray(snap.per_task)).toBe(true);
      expect(snap.per_task.length).toBe(2);
      expect(snap.period.tasks_assigned).toBe(2);
      expect(snap.period.tasks_completed).toBe(1);
      expect(snap.period.tasks_aborted).toBe(1);
      expect(snap.metadata.generated_at).toBe("2026-05-01T00:05:00.000Z");
      expect(snap.metadata.events_jsonl_path).toContain(".team/logs/events.jsonl");
      expect(snap.metadata.traces_db_path).toContain(".team/traces/traces.db");
      expect(typeof snap.metadata.events_jsonl_size_bytes).toBe("number");
    } finally {
      db.close();
    }
  });

  test("per_day を含まない（fact / 派生分離）", async () => {
    const date = "2026-04-29";
    await seedFixtures(project.root, date);
    const db = initDB(project.root);
    try {
      const snap = await buildDailySnapshot({
        db,
        eventsFile: join(project.root, ".team/logs/events.jsonl"),
        snapshotDate: date,
        generatedAt: new Date("2026-04-30T00:05:00.000Z"),
      });
      expect((snap as unknown as Record<string, unknown>).per_day).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("per_task と period は同じ window から派生（整合性）", async () => {
    const date = "2026-04-29";
    await seedFixtures(project.root, date);
    const db = initDB(project.root);
    try {
      const snap = await buildDailySnapshot({
        db,
        eventsFile: join(project.root, ".team/logs/events.jsonl"),
        snapshotDate: date,
        generatedAt: new Date(),
      });
      expect(snap.period.tasks_assigned).toBe(snap.per_task.length);
    } finally {
      db.close();
    }
  });

  test("空の events / 該当 task なし → per_task: [], period 全 0", async () => {
    await writeEventsFixture(project.root, []);
    const db = initDB(project.root);
    try {
      const snap = await buildDailySnapshot({
        db,
        eventsFile: join(project.root, ".team/logs/events.jsonl"),
        snapshotDate: "2026-04-29",
        generatedAt: new Date(),
      });
      expect(snap.per_task).toEqual([]);
      expect(snap.period.tasks_assigned).toBe(0);
      expect(snap.period.completion_rate).toBe(0);
    } finally {
      db.close();
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// S3: runMetricsSnapshotCli
// ────────────────────────────────────────────────────────────────────────

describe("runMetricsSnapshotCli (S3) - 引数 parse", () => {
  test("--help で help 出力 + exit 0", async () => {
    const { stdout, stderr, outText } = captureStreams();
    const ac = new AbortController();
    const code = await runMetricsSnapshotCli({
      args: ["snapshot", "--help"],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
    });
    expect(code).toBe(0);
    expect(outText().length).toBeGreaterThan(0);
  });

  test("--date 不正値で exit 1", async () => {
    const { stdout, stderr, errText } = captureStreams();
    const ac = new AbortController();
    const code = await runMetricsSnapshotCli({
      args: ["snapshot", "--date", "2026/04/29"],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
    });
    expect(code).toBe(1);
    expect(errText()).toMatch(/--date/);
  });

  test("不明フラグで exit 1", async () => {
    const { stdout, stderr, errText } = captureStreams();
    const ac = new AbortController();
    const code = await runMetricsSnapshotCli({
      args: ["snapshot", "--foo"],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
    });
    expect(code).toBe(1);
    expect(errText()).toMatch(/unknown flag/);
  });

  test("events.jsonl 不在で exit 1", async () => {
    const { stdout, stderr, errText } = captureStreams();
    const ac = new AbortController();
    const code = await runMetricsSnapshotCli({
      args: ["snapshot", "--date", "2026-04-29"],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
    });
    expect(code).toBe(1);
    expect(errText()).toMatch(/events\.jsonl/);
  });
});

describe("runMetricsSnapshotCli (S3) - 出力ファイル", () => {
  beforeEach(async () => {
    await seedFixtures(project.root, "2026-04-29");
  });

  test("--date 指定で .team/metrics/snapshots/YYYY-MM-DD.json を生成", async () => {
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
    const out = join(project.root, ".team/metrics/snapshots/2026-04-29.json");
    expect(existsSync(out)).toBe(true);
    const parsed: DailySnapshot = JSON.parse(await readFile(out, "utf8"));
    expect(parsed.snapshot_date).toBe("2026-04-29");
    expect(parsed.schema_version).toBe(1);
    expect(parsed.metadata).toBeDefined();
  });

  test("既存ファイルあり --force なしで exit 1", async () => {
    const dir = join(project.root, ".team/metrics/snapshots");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "2026-04-29.json"), "{}");
    const { stdout, stderr, errText } = captureStreams();
    const ac = new AbortController();
    const code = await runMetricsSnapshotCli({
      args: ["snapshot", "--date", "2026-04-29"],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
    });
    expect(code).toBe(1);
    expect(errText()).toMatch(/exists/);
  });

  test("既存ファイルあり --force で上書き成功", async () => {
    const dir = join(project.root, ".team/metrics/snapshots");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "2026-04-29.json"), "{}");
    const { stdout, stderr } = captureStreams();
    const ac = new AbortController();
    const code = await runMetricsSnapshotCli({
      args: ["snapshot", "--date", "2026-04-29", "--force"],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
    });
    expect(code).toBe(0);
    const text = await readFile(join(dir, "2026-04-29.json"), "utf8");
    const parsed = JSON.parse(text);
    expect(parsed.snapshot_date).toBe("2026-04-29");
  });

  test("--out カスタム出力先 (projectRoot 配下、相対パス)", async () => {
    const { stdout, stderr } = captureStreams();
    const ac = new AbortController();
    const code = await runMetricsSnapshotCli({
      args: ["snapshot", "--date", "2026-04-29", "--out", "custom/x.json"],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
    });
    expect(code).toBe(0);
    expect(existsSync(join(project.root, "custom/x.json"))).toBe(true);
  });

  test("--out が projectRoot 外、--allow-outside-project なしで exit 1", async () => {
    const { stdout, stderr, errText } = captureStreams();
    const ac = new AbortController();
    const code = await runMetricsSnapshotCli({
      args: ["snapshot", "--date", "2026-04-29", "--out", "/tmp/cmux-team-traversal-test.json"],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
    });
    expect(code).toBe(1);
    expect(errText()).toMatch(/outside.*project/i);
  });

  test("--out に .. による traversal を試みても projectRoot 外なら exit 1", async () => {
    const { stdout, stderr, errText } = captureStreams();
    const ac = new AbortController();
    const code = await runMetricsSnapshotCli({
      args: ["snapshot", "--date", "2026-04-29", "--out", "../escape/x.json"],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
    });
    expect(code).toBe(1);
    expect(errText()).toMatch(/outside.*project/i);
  });

  test("生成後に tmp ファイルが残らない (atomic write 成功時)", async () => {
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
    const dir = join(project.root, ".team/metrics/snapshots");
    const entries = await readdir(dir);
    expect(entries.find((e) => e.startsWith(".tmp-"))).toBeUndefined();
    expect(entries).toContain("2026-04-29.json");
  });
});
