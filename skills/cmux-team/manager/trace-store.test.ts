import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { Database } from "bun:sqlite";
import { initDB, insertHookSignal } from "./trace-store";
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
