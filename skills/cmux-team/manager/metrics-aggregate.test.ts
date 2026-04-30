/**
 * T379: metrics-aggregate.ts の単体テスト。
 *
 * - DB は in-memory SQLite を initDB 相当で初期化（trace-store.test.ts のパターンを踏襲）
 * - events.jsonl は os.tmpdir() に隔離し、各 test で新規生成する
 * - fixture は task 4 件 + tool call 12 件 + api_usage 8 件相当の最小サイズ
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFile, mkdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import {
  initDB,
  insertHookSignal,
  insertTaskSession,
  insertApiUsage,
  type ApiUsageRecord,
} from "./trace-store";
import type { QueueMessage } from "./schema";
import {
  readTaskLifecycle,
  aggregatePeriod,
  aggregateMetricsByTask,
  aggregateMetricsByBucket,
  stddev,
  type Lifecycle,
} from "./metrics-aggregate";
import { createDummyProject, type DummyProject } from "./test-project";
import type { Database } from "bun:sqlite";

describe("stddev (T379)", () => {
  test("空配列は 0", () => {
    expect(stddev([])).toBe(0);
  });

  test("単一要素は 0", () => {
    expect(stddev([42])).toBe(0);
  });

  test("[2,4,4,4,5,5,7,9] の standard deviation は 2", () => {
    // 母集団標準偏差: 平均 5, 分散 (9+1+1+1+0+0+4+16)/8 = 4, sqrt = 2
    expect(stddev([2, 4, 4, 4, 5, 5, 7, 9])).toBe(2);
  });
});

describe("readTaskLifecycle (T379)", () => {
  let tmpFile: string;

  beforeEach(async () => {
    tmpFile = join(tmpdir(), `cmux-metrics-test-${randomUUID()}.jsonl`);
  });

  afterEach(async () => {
    try {
      await rm(tmpFile);
    } catch (e) {
      console.warn("[test cleanup] rm tmpFile failed", e);
    }
  });

  async function writeJsonl(records: Array<Record<string, unknown>>): Promise<void> {
    const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    await writeFile(tmpFile, lines);
  }

  test("task_assigned + task_completed で完了タスクの lifecycle を返す", async () => {
    await writeJsonl([
      {
        schema_version: 2,
        ts: "2026-04-29T10:00:00.000Z",
        event: "task_assigned",
        task_id: "T100",
        conductor_surface: "surface:200",
        task_run_id: "task-100-run",
      },
      {
        schema_version: 2,
        ts: "2026-04-29T10:30:00.000Z",
        event: "task_completed",
        task_id: "T100",
        conductor_surface: "surface:200",
        worktree_path: "/tmp/wt",
        journal_summary: "OK",
      },
    ]);
    const map = await readTaskLifecycle(tmpFile, null);
    expect(map.size).toBe(1);
    const lc = map.get("T100")!;
    expect(lc.assigned_ts).toBe("2026-04-29T10:00:00.000Z");
    expect(lc.closed_ts).toBe("2026-04-29T10:30:00.000Z");
    expect(lc.outcome).toBe("completed");
    expect(lc.duration_ms).toBe(30 * 60 * 1000);
  });

  test("task_aborted で aborted outcome", async () => {
    await writeJsonl([
      { schema_version: 2, ts: "2026-04-29T10:00:00.000Z", event: "task_assigned", task_id: "T101", conductor_surface: "surface:200", task_run_id: "r" },
      { schema_version: 2, ts: "2026-04-29T10:05:00.000Z", event: "task_aborted", task_id: "T101", reason: "user_clear", journal_summary: "" },
    ]);
    const map = await readTaskLifecycle(tmpFile, null);
    const lc = map.get("T101")!;
    expect(lc.outcome).toBe("aborted");
    expect(lc.duration_ms).toBe(5 * 60 * 1000);
  });

  test("task_completed_state_mismatch で state_mismatch outcome", async () => {
    await writeJsonl([
      { schema_version: 2, ts: "2026-04-29T10:00:00.000Z", event: "task_assigned", task_id: "T102", conductor_surface: "surface:200", task_run_id: "r" },
      { schema_version: 2, ts: "2026-04-29T10:10:00.000Z", event: "task_completed_state_mismatch", task_id: "T102", conductor_surface: "surface:200", reason: "missing_close_task", worktree_path: "/tmp/wt", journal_summary: "" },
    ]);
    const map = await readTaskLifecycle(tmpFile, null);
    expect(map.get("T102")!.outcome).toBe("state_mismatch");
  });

  test("conductor_disconnect_timeout で forced_close outcome", async () => {
    await writeJsonl([
      { schema_version: 2, ts: "2026-04-29T10:00:00.000Z", event: "task_assigned", task_id: "T103", conductor_surface: "surface:200", task_run_id: "r" },
      { schema_version: 2, ts: "2026-04-29T11:00:00.000Z", event: "conductor_disconnect_timeout", conductor_surface: "surface:200", task_id: "T103", elapsed_ms: 3600000 },
    ]);
    const map = await readTaskLifecycle(tmpFile, null);
    expect(map.get("T103")!.outcome).toBe("forced_close");
  });

  test("task_assigned のみは outcome=open / closed_ts=null", async () => {
    await writeJsonl([
      { schema_version: 2, ts: "2026-04-29T10:00:00.000Z", event: "task_assigned", task_id: "T104", conductor_surface: "surface:200", task_run_id: "r" },
    ]);
    const map = await readTaskLifecycle(tmpFile, null);
    const lc = map.get("T104")!;
    expect(lc.outcome).toBe("open");
    expect(lc.closed_ts).toBeNull();
    expect(lc.duration_ms).toBeNull();
  });

  test("--since 以降のレコードのみ返す（filter は terminal 行で判定する）", async () => {
    await writeJsonl([
      { schema_version: 2, ts: "2026-04-01T10:00:00.000Z", event: "task_assigned", task_id: "OLD", conductor_surface: "surface:200", task_run_id: "r" },
      { schema_version: 2, ts: "2026-04-01T11:00:00.000Z", event: "task_completed", task_id: "OLD", conductor_surface: "surface:200", worktree_path: "/tmp", journal_summary: "" },
      { schema_version: 2, ts: "2026-04-29T10:00:00.000Z", event: "task_assigned", task_id: "NEW", conductor_surface: "surface:200", task_run_id: "r2" },
      { schema_version: 2, ts: "2026-04-29T11:00:00.000Z", event: "task_completed", task_id: "NEW", conductor_surface: "surface:200", worktree_path: "/tmp", journal_summary: "" },
    ]);
    const since = new Date("2026-04-15T00:00:00.000Z");
    const map = await readTaskLifecycle(tmpFile, since);
    expect(map.has("OLD")).toBe(false);
    expect(map.has("NEW")).toBe(true);
  });

  test("壊れた JSON 行はスキップして警告し、他は正しく読む", async () => {
    const lines = [
      JSON.stringify({ schema_version: 2, ts: "2026-04-29T10:00:00.000Z", event: "task_assigned", task_id: "T105", conductor_surface: "surface:200", task_run_id: "r" }),
      "this is not json",
      JSON.stringify({ schema_version: 2, ts: "2026-04-29T10:30:00.000Z", event: "task_completed", task_id: "T105", conductor_surface: "surface:200", worktree_path: "/tmp", journal_summary: "" }),
    ].join("\n") + "\n";
    await writeFile(tmpFile, lines);
    const map = await readTaskLifecycle(tmpFile, null);
    expect(map.has("T105")).toBe(true);
  });
});

describe("aggregatePeriod (T379)", () => {
  function lc(
    task_id: string,
    outcome: Lifecycle["outcome"],
    duration_ms: number | null = 60000,
  ): [string, Lifecycle] {
    return [
      task_id,
      {
        task_id,
        assigned_ts: "2026-04-29T10:00:00.000Z",
        closed_ts: outcome === "open" ? null : "2026-04-29T11:00:00.000Z",
        duration_ms: outcome === "open" ? null : duration_ms,
        outcome,
      },
    ];
  }

  test("4 件 (completed×2, aborted×1, forced_close×1) で集計", () => {
    const map = new Map<string, Lifecycle>([
      lc("T1", "completed"),
      lc("T2", "completed"),
      lc("T3", "aborted"),
      lc("T4", "forced_close"),
    ]);
    const summary = aggregatePeriod(map);
    expect(summary.tasks_assigned).toBe(4);
    expect(summary.tasks_completed).toBe(2);
    expect(summary.tasks_aborted).toBe(1);
    expect(summary.completion_rate).toBeCloseTo(0.5, 5);
    expect(summary.abort_rate).toBeCloseTo(0.25, 5);
    expect(summary.forced_close_rate).toBeCloseTo(0.25, 5);
  });

  test("空 map で全 0、divide by zero しない", () => {
    const summary = aggregatePeriod(new Map());
    expect(summary.tasks_assigned).toBe(0);
    expect(summary.completion_rate).toBe(0);
    expect(summary.abort_rate).toBe(0);
  });
});

describe("aggregateMetricsByTask (T379)", () => {
  let project: DummyProject;
  let db: Database;
  let eventsFile: string;

  beforeEach(async () => {
    project = await createDummyProject({
      prefix: "cmux-team-metrics-by-task-",
      subdirs: ["logs"],
    });
    db = initDB(project.root);
    eventsFile = join(project.root, ".team/logs/events.jsonl");
    await mkdir(join(project.root, ".team/logs"), { recursive: true });
  });

  afterEach(async () => {
    try {
      db.close();
    } catch (e) {
      console.warn("[test cleanup] db.close failed", e);
    }
    await project.dispose();
  });

  test("task lifecycle + tool calls + api_usage を 1 タスク分まとめる", async () => {
    // events.jsonl
    const lines = [
      { schema_version: 2, ts: "2026-04-29T10:00:00.000Z", event: "task_assigned", task_id: "T200", conductor_surface: "surface:200", task_run_id: "r1" },
      { schema_version: 2, ts: "2026-04-29T10:30:00.000Z", event: "task_completed", task_id: "T200", conductor_surface: "surface:200", worktree_path: "/tmp", journal_summary: "" },
    ];
    await writeFile(eventsFile, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    // task_sessions: T200 に 1 行
    insertTaskSession(db, {
      timestamp: "2026-04-29T10:00:00.000Z",
      task_id: "T200",
      task_run_id: "r1",
      session_id: "sess-200",
      role: "conductor",
      event: "assigned",
    });

    // hook_signals: PRE_TOOL_USE 4 件 (Edit×2, Read×1, Bash×1)
    for (const tool of ["Edit", "Edit", "Read", "Bash"]) {
      insertHookSignal(db, {
        type: "PRE_TOOL_USE",
        surface: "surface:200",
        pid: 1234,
        role: "agent",
        sessionId: "sess-200",
        toolName: tool,
        payload: {},
        timestamp: "2026-04-29T10:05:00.000Z",
      } as unknown as QueueMessage);
    }
    // POST_TOOL_USE 4 件 (1 件 失敗)
    for (let i = 0; i < 4; i++) {
      insertHookSignal(db, {
        type: "POST_TOOL_USE",
        surface: "surface:200",
        pid: 1234,
        role: "agent",
        sessionId: "sess-200",
        toolName: "Edit",
        payload: { tool_response: i === 0 ? { success: false, error: "boom" } : { success: true } },
        timestamp: "2026-04-29T10:06:00.000Z",
      } as unknown as QueueMessage);
    }

    // api_usage: T200 に 2 件
    const apiBase: ApiUsageRecord = {
      timestamp: "2026-04-29T10:10:00.000Z",
      task_id: "T200",
      role: "agent",
      surface: "surface:200",
      conductor_id: null,
      model: "claude-opus",
      request_id: "req1",
      status_code: 200,
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      stop_reason: "end_turn",
      duration_ms: 1000,
      ratelimit_tokens_remaining: null,
      ratelimit_tokens_limit: null,
      ratelimit_tokens_reset: null,
      ratelimit_input_tokens_remaining: null,
      ratelimit_input_tokens_limit: null,
      ratelimit_input_tokens_reset: null,
      ratelimit_output_tokens_remaining: null,
      ratelimit_output_tokens_limit: null,
      ratelimit_output_tokens_reset: null,
      ratelimit_requests_remaining: null,
      ratelimit_requests_limit: null,
      ratelimit_requests_reset: null,
      error: null,
    };
    insertApiUsage(db, apiBase);
    insertApiUsage(db, { ...apiBase, request_id: "req2", input_tokens: 50, output_tokens: 25 });

    const result = await aggregateMetricsByTask(db, eventsFile, {
      since: null,
      until: new Date("2026-04-30T00:00:00.000Z"),
    });
    expect(result.length).toBe(1);
    const r = result[0]!;
    expect(r.task_id).toBe("T200");
    expect(r.outcome).toBe("completed");
    expect(r.duration_ms).toBe(30 * 60 * 1000);
    expect(r.tool_calls.Edit).toBe(2);
    expect(r.tool_calls.Read).toBe(1);
    expect(r.tool_calls.Bash).toBe(1);
    expect(r.tool_call_total).toBe(4);
    expect(r.tool_failure_rate).toBeCloseTo(0.25, 5);
    expect(r.tokens.input).toBe(150);
    expect(r.tokens.output).toBe(75);
    expect(r.tokens.requests).toBe(2);
  });

  test("session_id に対して task_sessions が 2 行ある場合でも tool_call は二重カウントされない (Recommendation 3)", async () => {
    const lines = [
      { schema_version: 2, ts: "2026-04-29T10:00:00.000Z", event: "task_assigned", task_id: "T300", conductor_surface: "surface:300", task_run_id: "r3" },
      { schema_version: 2, ts: "2026-04-29T10:30:00.000Z", event: "task_completed", task_id: "T300", conductor_surface: "surface:300", worktree_path: "/tmp", journal_summary: "" },
    ];
    await writeFile(eventsFile, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    // 同じ session_id に対して 2 行（resume / clear で append されたケース）
    insertTaskSession(db, {
      timestamp: "2026-04-29T10:00:00.000Z",
      task_id: "T300",
      task_run_id: "r3",
      session_id: "sess-dup",
      role: "conductor",
      event: "assigned",
    });
    insertTaskSession(db, {
      timestamp: "2026-04-29T10:15:00.000Z",
      task_id: "T300",
      task_run_id: "r3",
      session_id: "sess-dup",
      role: "conductor",
      event: "assigned",
    });

    // Edit 1 件のみ
    insertHookSignal(db, {
      type: "PRE_TOOL_USE",
      surface: "surface:300",
      pid: 1234,
      role: "agent",
      sessionId: "sess-dup",
      toolName: "Edit",
      payload: {},
      timestamp: "2026-04-29T10:05:00.000Z",
    } as unknown as QueueMessage);

    const result = await aggregateMetricsByTask(db, eventsFile, {
      since: null,
      until: new Date("2026-04-30T00:00:00.000Z"),
    });
    expect(result.length).toBe(1);
    expect(result[0]!.tool_calls.Edit).toBe(1);
    expect(result[0]!.tool_call_total).toBe(1);
  });

  test("--task-id でフィルタすると 1 タスクだけ返る", async () => {
    const lines = [
      { schema_version: 2, ts: "2026-04-29T10:00:00.000Z", event: "task_assigned", task_id: "T400", conductor_surface: "surface:200", task_run_id: "r" },
      { schema_version: 2, ts: "2026-04-29T10:30:00.000Z", event: "task_completed", task_id: "T400", conductor_surface: "surface:200", worktree_path: "/tmp", journal_summary: "" },
      { schema_version: 2, ts: "2026-04-29T11:00:00.000Z", event: "task_assigned", task_id: "T401", conductor_surface: "surface:200", task_run_id: "r" },
      { schema_version: 2, ts: "2026-04-29T11:30:00.000Z", event: "task_completed", task_id: "T401", conductor_surface: "surface:200", worktree_path: "/tmp", journal_summary: "" },
    ];
    await writeFile(eventsFile, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const result = await aggregateMetricsByTask(db, eventsFile, {
      since: null,
      until: new Date("2026-04-30T00:00:00.000Z"),
      taskId: "T401",
    });
    expect(result.length).toBe(1);
    expect(result[0]!.task_id).toBe("T401");
  });
});

describe("aggregateMetricsByBucket (T379)", () => {
  let project: DummyProject;
  let db: Database;
  let eventsFile: string;

  beforeEach(async () => {
    project = await createDummyProject({
      prefix: "cmux-team-metrics-bucket-",
      subdirs: ["logs"],
    });
    db = initDB(project.root);
    eventsFile = join(project.root, ".team/logs/events.jsonl");
    await mkdir(join(project.root, ".team/logs"), { recursive: true });
  });

  afterEach(async () => {
    try {
      db.close();
    } catch (e) {
      console.warn("[test cleanup] db.close failed", e);
    }
    await project.dispose();
  });

  test("group-by day で日別 bucket に集計", async () => {
    const lines = [
      { schema_version: 2, ts: "2026-04-29T10:00:00.000Z", event: "task_assigned", task_id: "T1", conductor_surface: "surface:200", task_run_id: "r" },
      { schema_version: 2, ts: "2026-04-29T10:30:00.000Z", event: "task_completed", task_id: "T1", conductor_surface: "surface:200", worktree_path: "/tmp", journal_summary: "" },
      { schema_version: 2, ts: "2026-04-30T10:00:00.000Z", event: "task_assigned", task_id: "T2", conductor_surface: "surface:200", task_run_id: "r" },
      { schema_version: 2, ts: "2026-04-30T10:30:00.000Z", event: "task_aborted", task_id: "T2", reason: "user_clear", journal_summary: "" },
    ];
    await writeFile(eventsFile, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const result = await aggregateMetricsByBucket(db, eventsFile, {
      since: null,
      until: new Date("2026-05-01T00:00:00.000Z"),
      groupBy: "day",
    });
    expect(result.length).toBe(2);
    const day29 = result.find((r) => r.bucket === "2026-04-29")!;
    const day30 = result.find((r) => r.bucket === "2026-04-30")!;
    expect(day29.tasks_assigned).toBe(1);
    expect(day29.tasks_completed).toBe(1);
    expect(day30.tasks_assigned).toBe(1);
    expect(day30.tasks_aborted).toBe(1);
  });

  test("group-by week は ISO week (月曜開始) で bucket 化", async () => {
    // 2026-04-27 (月) - 2026-05-03 (日) は同じ ISO week
    const lines = [
      { schema_version: 2, ts: "2026-04-27T10:00:00.000Z", event: "task_assigned", task_id: "T1", conductor_surface: "surface:200", task_run_id: "r" },
      { schema_version: 2, ts: "2026-04-27T11:00:00.000Z", event: "task_completed", task_id: "T1", conductor_surface: "surface:200", worktree_path: "/tmp", journal_summary: "" },
      { schema_version: 2, ts: "2026-05-03T10:00:00.000Z", event: "task_assigned", task_id: "T2", conductor_surface: "surface:200", task_run_id: "r" },
      { schema_version: 2, ts: "2026-05-03T11:00:00.000Z", event: "task_completed", task_id: "T2", conductor_surface: "surface:200", worktree_path: "/tmp", journal_summary: "" },
    ];
    await writeFile(eventsFile, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const result = await aggregateMetricsByBucket(db, eventsFile, {
      since: null,
      until: new Date("2026-05-10T00:00:00.000Z"),
      groupBy: "week",
    });
    expect(result.length).toBe(1);
    expect(result[0]!.bucket).toBe("2026-04-27"); // ISO week 開始日
    expect(result[0]!.tasks_assigned).toBe(2);
  });

  test("deny_rate は PRE_TOOL_USE_DENIED / PRE_TOOL_USE で算出される", async () => {
    const lines = [
      { schema_version: 2, ts: "2026-04-29T10:00:00.000Z", event: "task_assigned", task_id: "T1", conductor_surface: "surface:200", task_run_id: "r" },
      { schema_version: 2, ts: "2026-04-29T10:30:00.000Z", event: "task_completed", task_id: "T1", conductor_surface: "surface:200", worktree_path: "/tmp", journal_summary: "" },
    ];
    await writeFile(eventsFile, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    // PRE_TOOL_USE 10 件 / DENIED 2 件 → deny_rate = 0.2
    for (let i = 0; i < 10; i++) {
      insertHookSignal(db, {
        type: "PRE_TOOL_USE",
        surface: "surface:200",
        pid: 1234,
        role: "conductor",
        sessionId: "s",
        toolName: "Bash",
        payload: {},
        timestamp: "2026-04-29T10:05:00.000Z",
      } as unknown as QueueMessage);
    }
    for (let i = 0; i < 2; i++) {
      insertHookSignal(db, {
        type: "PRE_TOOL_USE_DENIED",
        surface: "surface:200",
        pid: 1234,
        role: "conductor",
        reason: "denied",
        timestamp: "2026-04-29T10:06:00.000Z",
      } as unknown as QueueMessage);
    }

    const result = await aggregateMetricsByBucket(db, eventsFile, {
      since: null,
      until: new Date("2026-04-30T00:00:00.000Z"),
      groupBy: "day",
    });
    const day = result.find((r) => r.bucket === "2026-04-29")!;
    expect(day.deny_rate).toBeCloseTo(0.2, 5);
  });
});
