import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { Database } from "bun:sqlite";
import { initDB, insertHookSignal, getHookSignals } from "./trace-store";
import type { QueueMessage } from "./schema";

describe("trace-store: insertHookSignal (T216)", () => {
  let tmpDir: string;
  let db: Database;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "cmux-team-trace-store-test-"));
    db = initDB(tmpDir);
  });

  afterEach(async () => {
    try { db.close(); } catch {}
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("SESSION_STARTED を挿入して surface/pid/source 列が入る", () => {
    const message: QueueMessage = {
      type: "SESSION_STARTED",
      surface: "surface:100",
      pid: 12345,
      source: "startup",
      timestamp: "2026-04-16T10:00:00.000Z",
    };

    const id = insertHookSignal(db, message);
    expect(id).toBeGreaterThan(0);

    const row = db
      .prepare("SELECT COUNT(*) as c FROM hook_signals")
      .get() as { c: number };
    expect(row.c).toBe(1);

    const detail = db
      .prepare(
        "SELECT type, surface, pid, source, reason, payload_json FROM hook_signals LIMIT 1",
      )
      .get() as {
        type: string;
        surface: string;
        pid: number;
        source: string | null;
        reason: string | null;
        payload_json: string;
      };
    expect(detail.type).toBe("SESSION_STARTED");
    expect(detail.surface).toBe("surface:100");
    expect(detail.pid).toBe(12345);
    expect(detail.source).toBe("startup");
    expect(detail.reason).toBeNull();

    const decoded = JSON.parse(detail.payload_json);
    expect(decoded.type).toBe("SESSION_STARTED");
    expect(decoded.pid).toBe(12345);
    expect(decoded.source).toBe("startup");
  });

  test("SESSION_ENDED reason=other を挿入して reason 列が入り payload_json が復元できる", () => {
    const message: QueueMessage = {
      type: "SESSION_ENDED",
      surface: "surface:200",
      pid: 54321,
      reason: "other",
      timestamp: "2026-04-16T10:05:00.000Z",
    };

    insertHookSignal(db, message);

    const detail = db
      .prepare("SELECT type, surface, reason, payload_json FROM hook_signals LIMIT 1")
      .get() as {
        type: string;
        surface: string;
        reason: string;
        payload_json: string;
      };
    expect(detail.type).toBe("SESSION_ENDED");
    expect(detail.surface).toBe("surface:200");
    expect(detail.reason).toBe("other");

    const decoded = JSON.parse(detail.payload_json);
    expect(decoded.type).toBe("SESSION_ENDED");
    expect(decoded.reason).toBe("other");
    expect(decoded.pid).toBe(54321);
  });

  test("64KB 超の payload は truncate され length <= 65536 に収まる", () => {
    const huge = "x".repeat(100_000);
    const message: QueueMessage = {
      type: "SESSION_ASK",
      surface: "surface:300",
      pid: 777,
      question: huge,
      timestamp: "2026-04-16T10:10:00.000Z",
    };

    insertHookSignal(db, message);

    const row = db
      .prepare("SELECT payload_json FROM hook_signals LIMIT 1")
      .get() as { payload_json: string };
    expect(row.payload_json.length).toBeLessThanOrEqual(65536);

    const detail = db
      .prepare("SELECT type, surface, question FROM hook_signals LIMIT 1")
      .get() as { type: string; surface: string; question: string };
    expect(detail.type).toBe("SESSION_ASK");
    expect(detail.surface).toBe("surface:300");
    expect(detail.question.length).toBe(huge.length);
  });
});

describe("trace-store: getHookSignals (T217)", () => {
  let tmpDir: string;
  let db: Database;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "cmux-team-getHookSignals-test-"));
    db = initDB(tmpDir);

    insertHookSignal(db, {
      type: "SESSION_STARTED",
      surface: "surface:100",
      pid: 1,
      source: "startup",
      timestamp: "2026-04-16T10:00:00.000Z",
    } as unknown as QueueMessage);
    insertHookSignal(db, {
      type: "SESSION_ENDED",
      surface: "surface:100",
      pid: 1,
      reason: "completed",
      timestamp: "2026-04-16T10:01:00.000Z",
    } as unknown as QueueMessage);
    insertHookSignal(db, {
      type: "SESSION_STARTED",
      surface: "surface:200",
      pid: 2,
      source: "resume",
      taskRunId: "task-217-xxx",
      timestamp: "2026-04-16T10:02:00.000Z",
    } as unknown as QueueMessage);
    insertHookSignal(db, {
      type: "CONDUCTOR_DONE",
      surface: "surface:300",
      success: true,
      reason: "completed",
      timestamp: "2026-04-16T10:03:00.000Z",
    } as unknown as QueueMessage);
  });

  afterEach(async () => {
    try { db.close(); } catch {}
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("全件取得（オプション無し） — id DESC で最新順に返る", () => {
    const rows = getHookSignals(db, {});
    expect(rows.length).toBe(4);
    const first = rows[0]!;
    const last = rows[3]!;
    expect(first.type).toBe("CONDUCTOR_DONE");
    expect(last.type).toBe("SESSION_STARTED");
    expect(last.surface).toBe("surface:100");
    expect(first.id).toBeGreaterThan(last.id);
  });

  test("type フィルタ", () => {
    const rows = getHookSignals(db, { type: "SESSION_STARTED" });
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.type === "SESSION_STARTED")).toBe(true);
  });

  test("surface フィルタ", () => {
    const rows = getHookSignals(db, { surface: "surface:100" });
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.surface === "surface:100")).toBe(true);
  });

  test("task_run_id フィルタ", () => {
    const rows = getHookSignals(db, { taskRunId: "task-217-xxx" });
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.type).toBe("SESSION_STARTED");
    expect(row.surface).toBe("surface:200");
  });

  test("limit 指定 + ORDER BY id DESC", () => {
    const rows = getHookSignals(db, { limit: 2 });
    expect(rows.length).toBe(2);
    const first = rows[0]!;
    const second = rows[1]!;
    expect(first.type).toBe("CONDUCTOR_DONE");
    expect(second.type).toBe("SESSION_STARTED");
    expect(second.surface).toBe("surface:200");
  });
});
