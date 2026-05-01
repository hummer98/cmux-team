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

// ────────────────────────────────────────────────────────────────────────
// T407: R6 e2e fixture — agent_spawned 行 + hook_signals(PRE/POST) + api_usage で
//   metrics CLI 出力の 4 軸（tool_calls / first_edit / failure_rate / token_usage）が
//   全て task_id を解決して集計されることを確認する。
// ────────────────────────────────────────────────────────────────────────

describe("runMetricsCli (T407 R6) - Agent 由来 metrics e2e", () => {
  test("agent_spawned 行のみで 4 軸が task_id 解決される", async () => {
    // 事前: events.jsonl に T407 のライフサイクル
    await writeEventsFixture(project.root, [
      { schema_version: 2, ts: "2026-04-30T10:00:00.000Z", event: "task_assigned", task_id: "T407", conductor_surface: "surface:200", task_run_id: "r407" },
      { schema_version: 2, ts: "2026-04-30T11:00:00.000Z", event: "task_completed", task_id: "T407", conductor_surface: "surface:200", worktree_path: "/tmp", journal_summary: "" },
    ]);

    const db = initDB(project.root);
    // task_sessions: agent_spawned 行のみ（assigned 行なし、ただし conductor の session が無くても agent 単独で task_id 解決できる）
    insertTaskSession(db, {
      timestamp: "2026-04-30T10:00:30.000Z",
      task_id: "T407",
      task_run_id: "r407",
      session_id: "uuid-agent-r6",
      role: "agent",
      surface: "surface:301",
      event: "agent_spawned",
    });

    // hook_signals: agent 由来の Edit (PRE) + Bash success (POST) + Bash failure (POST)
    insertHookSignal(db, {
      type: "PRE_TOOL_USE",
      surface: "surface:301",
      pid: 1,
      role: "agent",
      sessionId: "uuid-agent-r6",
      toolName: "Edit",
      payload: {},
      timestamp: "2026-04-30T10:05:00.000Z",
    } as unknown as QueueMessage);
    insertHookSignal(db, {
      type: "POST_TOOL_USE",
      surface: "surface:301",
      pid: 1,
      role: "agent",
      sessionId: "uuid-agent-r6",
      toolName: "Bash",
      payload: { tool_response: { success: true } },
      timestamp: "2026-04-30T10:06:00.000Z",
    } as unknown as QueueMessage);
    insertHookSignal(db, {
      type: "POST_TOOL_USE",
      surface: "surface:301",
      pid: 1,
      role: "agent",
      sessionId: "uuid-agent-r6",
      toolName: "Bash",
      payload: { tool_response: { success: false } },
      timestamp: "2026-04-30T10:07:00.000Z",
    } as unknown as QueueMessage);

    // api_usage: 同じ task_id で
    insertApiUsage(db, {
      timestamp: "2026-04-30T10:08:00.000Z",
      task_id: "T407",
      role: "agent",
      input_tokens: 1234,
      output_tokens: 567,
    });

    db.close();

    const { stdout, stderr, outText } = captureStreams();
    const ac = new AbortController();
    const code = await runMetricsCli({
      args: ["--format", "json", "--task-id", "T407"],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(outText());
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(1);
    const row = parsed[0];
    // 1. tool counts (countToolCallsByTask)
    expect(row.task_id).toBe("T407");
    expect(row.tool_calls.Edit).toBe(1);
    // 2. first edit (firstEditPerTask) — task_assigned 10:00:00 → first Edit 10:05:00 → 5min = 300_000ms
    expect(row.time_to_first_edit_ms).toBe(300_000);
    // 3. failure rate (failureRateByTask) — 1 failure / 2 total = 0.5
    expect(row.tool_failure_rate).toBeCloseTo(0.5, 5);
    // 4. token usage (api_usage 集計)
    expect(row.tokens.input).toBe(1234);
    expect(row.tokens.output).toBe(567);
  });

  test("空 session_id 行が混ざっても unattached regression を起こさない", async () => {
    // (C2 regression) 過去の空 session_id 行が agent_spawned で残っていても
    // 集計時に task_id へ誤マッチせず、新規 fixture が unattached にされない。
    await writeEventsFixture(project.root, [
      { schema_version: 2, ts: "2026-04-30T10:00:00.000Z", event: "task_assigned", task_id: "T999", conductor_surface: "surface:200", task_run_id: "r999" },
      { schema_version: 2, ts: "2026-04-30T11:00:00.000Z", event: "task_completed", task_id: "T999", conductor_surface: "surface:200", worktree_path: "/tmp", journal_summary: "" },
    ]);

    const db = initDB(project.root);
    // 空 session_id の旧 agent_spawned 行（過去データ模倣）
    insertTaskSession(db, {
      timestamp: "2026-04-30T09:00:00.000Z",
      task_id: "T999",
      task_run_id: "r999",
      session_id: "",
      role: "agent",
      surface: "surface:399",
      event: "agent_spawned",
    });
    // 新規 agent_spawned 行（pre-inject UUID 付き）
    insertTaskSession(db, {
      timestamp: "2026-04-30T10:00:30.000Z",
      task_id: "T999",
      task_run_id: "r999",
      session_id: "uuid-fresh",
      role: "agent",
      surface: "surface:301",
      event: "agent_spawned",
    });

    // 新規 hook_signal (session_id="uuid-fresh") → task_id="T999" に解決される
    insertHookSignal(db, {
      type: "PRE_TOOL_USE",
      surface: "surface:301",
      pid: 1,
      role: "agent",
      sessionId: "uuid-fresh",
      toolName: "Read",
      payload: {},
      timestamp: "2026-04-30T10:05:00.000Z",
    } as unknown as QueueMessage);
    db.close();

    const { stdout, stderr, outText } = captureStreams();
    const ac = new AbortController();
    const code = await runMetricsCli({
      args: ["--format", "json", "--task-id", "T999"],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(outText());
    expect(parsed.length).toBe(1);
    expect(parsed[0].task_id).toBe("T999");
    expect(parsed[0].tool_calls.Read).toBe(1);
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
