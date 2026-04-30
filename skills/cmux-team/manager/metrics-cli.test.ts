/**
 * T379: `cmux-team metrics` CLI のテスト。
 * `runMetricsCli({ args, projectRoot, stdout, stderr, abortSignal })` を in-process で呼び
 * stdout / stderr / exit code を assert する（events-cli.test.ts と同パターン）。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { runMetricsCli, csvEscape, formatCsvRow } from "./metrics-cli";
import { initDB, insertHookSignal, insertTaskSession, insertApiUsage } from "./trace-store";
import { createDummyProject, type DummyProject } from "./test-project";
import type { QueueMessage } from "./schema";

let project: DummyProject;

beforeEach(async () => {
  project = await createDummyProject({ prefix: "cmux-metrics-cli-test-" });
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

async function writeEventsFixture(root: string, records: Array<Record<string, unknown>>): Promise<void> {
  const path = join(root, ".team/logs/events.jsonl");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

describe("runMetricsCli (T379) - 引数 parse", () => {
  test("--help で help テキストを出して exit 0", async () => {
    const { stdout, stderr, outText, errText } = captureStreams();
    const ac = new AbortController();
    const code = await runMetricsCli({
      args: ["--help"],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
    });
    expect(code).toBe(0);
    expect(outText().length).toBeGreaterThan(0);
    expect(errText()).toBe("");
  });

  test("不明なフラグで exit 1 / stderr に Error", async () => {
    const { stdout, stderr, errText } = captureStreams();
    const ac = new AbortController();
    const code = await runMetricsCli({
      args: ["--foo"],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
    });
    expect(code).toBe(1);
    expect(errText()).toMatch(/unknown flag/);
  });

  test("--format 不正値で exit 1", async () => {
    const { stdout, stderr, errText } = captureStreams();
    const ac = new AbortController();
    const code = await runMetricsCli({
      args: ["--format", "xml"],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
    });
    expect(code).toBe(1);
    expect(errText()).toMatch(/invalid --format value/);
  });

  test("--task-id と --group-by week の組み合わせで exit 1", async () => {
    const { stdout, stderr, errText } = captureStreams();
    const ac = new AbortController();
    const code = await runMetricsCli({
      args: ["--task-id", "T100", "--group-by", "week"],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
    });
    expect(code).toBe(1);
    expect(errText()).toMatch(/--task-id.*--group-by/);
  });

  test("events.jsonl 不在で exit 1", async () => {
    const { stdout, stderr, errText } = captureStreams();
    const ac = new AbortController();
    const code = await runMetricsCli({
      args: [],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
    });
    expect(code).toBe(1);
    expect(errText()).toMatch(/events\.jsonl not found/);
  });
});

describe("runMetricsCli (T379) - 出力 format", () => {
  beforeEach(async () => {
    await writeEventsFixture(project.root, [
      { schema_version: 2, ts: "2026-04-29T10:00:00.000Z", event: "task_assigned", task_id: "T1", conductor_surface: "surface:200", task_run_id: "r" },
      { schema_version: 2, ts: "2026-04-29T10:30:00.000Z", event: "task_completed", task_id: "T1", conductor_surface: "surface:200", worktree_path: "/tmp", journal_summary: "" },
    ]);
    const db = initDB(project.root);
    insertTaskSession(db, {
      timestamp: "2026-04-29T10:00:00.000Z",
      task_id: "T1",
      task_run_id: "r",
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
      timestamp: "2026-04-29T10:05:00.000Z",
    } as unknown as QueueMessage);
    db.close();
  });

  test("--format json で valid JSON 配列を返す", async () => {
    const { stdout, stderr, outText } = captureStreams();
    const ac = new AbortController();
    const code = await runMetricsCli({
      args: ["--format", "json"],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(outText());
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].task_id).toBe("T1");
    expect(parsed[0].tool_calls.Edit).toBe(1);
  });

  test("--format text で 1 行 1 task の key=value", async () => {
    const { stdout, stderr, outText } = captureStreams();
    const ac = new AbortController();
    const code = await runMetricsCli({
      args: ["--format", "text"],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
    });
    expect(code).toBe(0);
    expect(outText()).toContain("task_id=T1");
    expect(outText()).toContain("outcome=completed");
  });

  test("--format csv で header + 1 行を返す", async () => {
    const { stdout, stderr, outText } = captureStreams();
    const ac = new AbortController();
    const code = await runMetricsCli({
      args: ["--format", "csv"],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
    });
    expect(code).toBe(0);
    const lines = outText().trimEnd().split("\r\n");
    expect(lines[0]).toContain("task_id,outcome");
    expect(lines[1]).toContain("T1");
  });

  test("--task-id でフィルタすると 1 件だけ返る", async () => {
    const { stdout, stderr, outText } = captureStreams();
    const ac = new AbortController();
    const code = await runMetricsCli({
      args: ["--task-id", "T1", "--format", "json"],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(outText());
    expect(parsed.length).toBe(1);
  });

  test("--group-by day で bucket 形式に切り替わる", async () => {
    const { stdout, stderr, outText } = captureStreams();
    const ac = new AbortController();
    const code = await runMetricsCli({
      args: ["--group-by", "day", "--format", "json"],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(outText());
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].bucket).toBeDefined();
  });
});

describe("csvEscape / formatCsvRow (T379)", () => {
  test("通常文字列はそのまま", () => {
    expect(csvEscape("abc")).toBe("abc");
  });

  test("カンマを含む値はダブルクォートで囲む", () => {
    expect(csvEscape("a,b")).toBe('"a,b"');
  });

  test("ダブルクォートは \"\" でエスケープ", () => {
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
  });

  test("改行を含む値はダブルクォートで囲む", () => {
    expect(csvEscape("a\nb")).toBe('"a\nb"');
  });

  test("null / undefined は空文字列", () => {
    expect(csvEscape(null)).toBe("");
    expect(csvEscape(undefined)).toBe("");
  });

  test("formatCsvRow で配列を CSV 行にする", () => {
    expect(formatCsvRow(["a", "b,c", null, 42])).toBe('a,"b,c",,42');
  });
});
