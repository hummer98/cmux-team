import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import {
  initDB,
  insertHookSignal,
  getHookSignals,
  insertTaskSession,
  getTaskSessions,
  updateNotificationEnrichment,
} from "./trace-store";
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

describe("trace-store: task_sessions base columns (T243)", () => {
  let tmpDir: string;
  let db: Database;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "cmux-team-task-sessions-base-"));
    db = initDB(tmpDir);
  });

  afterEach(async () => {
    try { db.close(); } catch {}
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("新規 DB: insertTaskSession で base_branch/base_sha/base_source が読み出せる", () => {
    insertTaskSession(db, {
      timestamp: "2026-04-17T10:00:00.000Z",
      task_id: "T243",
      task_run_id: "task-243-1776424220",
      session_id: "session-abc",
      role: "conductor",
      surface: "surface:665",
      worktree_path: "/tmp/wt",
      event: "assigned",
      base_branch: "origin/main",
      base_sha: "abcdef0123456789abcdef0123456789abcdef01",
      base_source: "config-origin",
    });

    const rows = getTaskSessions(db, { taskId: "T243", event: "assigned" });
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.base_branch).toBe("origin/main");
    expect(row.base_sha).toBe("abcdef0123456789abcdef0123456789abcdef01");
    expect(row.base_source).toBe("config-origin");
  });

  test("base_* 未指定時は NULL になる（旧コードパス互換）", () => {
    insertTaskSession(db, {
      timestamp: "2026-04-17T10:01:00.000Z",
      task_id: "T243",
      session_id: "session-def",
      event: "agent_spawned",
    });

    const rows = getTaskSessions(db, { taskId: "T243", event: "agent_spawned" });
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.base_branch ?? null).toBeNull();
    expect(row.base_sha ?? null).toBeNull();
    expect(row.base_source ?? null).toBeNull();
  });

  test("旧スキーマ DB → initDB 再呼び出しで ALTER TABLE による列追加が走る", async () => {
    // 旧 traces.db を手作業で作る（base_* 列なし）
    const oldDir = await mkdtemp(join(tmpdir(), "cmux-team-old-schema-"));
    try {
      await mkdir(join(oldDir, ".team/traces"), { recursive: true });
      const oldDb = new Database(join(oldDir, ".team/traces/traces.db"));
      oldDb.exec(`
        CREATE TABLE task_sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL,
          task_id TEXT NOT NULL,
          task_run_id TEXT,
          session_id TEXT NOT NULL,
          role TEXT,
          surface TEXT,
          worktree_path TEXT,
          event TEXT NOT NULL
        );
      `);
      // 旧形式のダミー行を 1 件入れる
      oldDb
        .prepare(
          `INSERT INTO task_sessions
            (timestamp, task_id, task_run_id, session_id, role, surface, worktree_path, event)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "2026-01-01T00:00:00.000Z",
          "T100",
          "task-100-old",
          "session-old",
          "conductor",
          "surface:100",
          "/old/path",
          "assigned",
        );
      oldDb.close();

      // initDB で migration が走る
      const migratedDb = initDB(oldDir);
      try {
        const cols = migratedDb
          .prepare("PRAGMA table_info(task_sessions)")
          .all() as Array<{ name: string }>;
        const names = new Set(cols.map((c) => c.name));
        expect(names.has("base_branch")).toBe(true);
        expect(names.has("base_sha")).toBe(true);
        expect(names.has("base_source")).toBe(true);

        // 旧行は NULL のまま生存
        const old = migratedDb
          .prepare(
            "SELECT task_id, base_branch, base_sha, base_source FROM task_sessions WHERE task_id = ?",
          )
          .get("T100") as {
            task_id: string;
            base_branch: string | null;
            base_sha: string | null;
            base_source: string | null;
          };
        expect(old.task_id).toBe("T100");
        expect(old.base_branch).toBeNull();
        expect(old.base_sha).toBeNull();
        expect(old.base_source).toBeNull();

        // 2 回目の initDB 呼び出しでも ALTER は冪等（throw しない）
        migratedDb.close();
        const reopen = initDB(oldDir);
        const cols2 = reopen
          .prepare("PRAGMA table_info(task_sessions)")
          .all() as Array<{ name: string }>;
        const names2 = new Set(cols2.map((c) => c.name));
        expect(names2.has("base_branch")).toBe(true);
        expect(names2.has("base_sha")).toBe(true);
        expect(names2.has("base_source")).toBe(true);
        reopen.close();
      } finally {
        try { migratedDb.close(); } catch {}
      }
    } finally {
      await rm(oldDir, { recursive: true, force: true });
    }
  });
});

describe("trace-store: hook_signals NOTIFICATION columns (T266)", () => {
  let tmpDir: string;
  let db: Database;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "cmux-team-hook-signals-t266-"));
    db = initDB(tmpDir);
  });

  afterEach(async () => {
    try { db.close(); } catch {}
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("新規 DB: hook_signals に新 8 列が存在する", () => {
    const cols = db
      .prepare("PRAGMA table_info(hook_signals)")
      .all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    for (const col of [
      "surface_uuid",
      "workspace_uuid",
      "role",
      "task_id",
      "conductor_surface",
      "agent_role",
      "message",
      "notification_type",
    ]) {
      expect(names.has(col)).toBe(true);
    }
  });

  test("既存 SESSION_* 系 insertHookSignal は新 8 列が NULL のまま green", () => {
    const id = insertHookSignal(db, {
      type: "SESSION_STARTED",
      surface: "surface:100",
      pid: 1234,
      source: "startup",
      timestamp: "2026-04-19T10:00:00.000Z",
    } as unknown as QueueMessage);

    const row = db
      .prepare(
        "SELECT surface_uuid, workspace_uuid, role, task_id, conductor_surface, agent_role, message, notification_type FROM hook_signals WHERE id = ?",
      )
      .get(id) as Record<string, string | null>;

    for (const col of [
      "surface_uuid",
      "workspace_uuid",
      "role",
      "task_id",
      "conductor_surface",
      "agent_role",
      "message",
      "notification_type",
    ]) {
      expect(row[col]).toBeNull();
    }
  });

  test("updateNotificationEnrichment: 指定行の 8 列が書き換わる", () => {
    const id = insertHookSignal(db, {
      type: "NOTIFICATION",
      surface: "surface:192",
      pid: 80850,
      timestamp: "2026-04-19T10:00:00.000Z",
    } as unknown as QueueMessage);

    updateNotificationEnrichment(db, id, {
      surfaceUuid: "22d8f9ab-1234",
      workspaceUuid: "ws-uuid",
      role: "conductor",
      taskId: "265",
      conductorSurface: "surface:192",
      agentRole: null,
      message: "Claude is waiting for your input",
      notificationType: "idle_prompt",
    });

    const row = db
      .prepare(
        "SELECT surface_uuid, workspace_uuid, role, task_id, conductor_surface, agent_role, message, notification_type FROM hook_signals WHERE id = ?",
      )
      .get(id) as Record<string, string | null>;

    expect(row.surface_uuid).toBe("22d8f9ab-1234");
    expect(row.workspace_uuid).toBe("ws-uuid");
    expect(row.role).toBe("conductor");
    expect(row.task_id).toBe("265");
    expect(row.conductor_surface).toBe("surface:192");
    expect(row.agent_role).toBeNull();
    expect(row.message).toBe("Claude is waiting for your input");
    expect(row.notification_type).toBe("idle_prompt");
  });

  test("updateNotificationEnrichment: 未指定フィールドは NULL のまま", () => {
    const id = insertHookSignal(db, {
      type: "NOTIFICATION",
      surface: "surface:100",
      pid: 1,
      timestamp: "2026-04-19T10:00:00.000Z",
    } as unknown as QueueMessage);

    updateNotificationEnrichment(db, id, {
      role: "master",
    });

    const row = db
      .prepare(
        "SELECT surface_uuid, role, task_id, message FROM hook_signals WHERE id = ?",
      )
      .get(id) as Record<string, string | null>;

    expect(row.role).toBe("master");
    expect(row.surface_uuid).toBeNull();
    expect(row.task_id).toBeNull();
    expect(row.message).toBeNull();
  });

  test("updateNotificationEnrichment: 存在しない id は no-op", () => {
    expect(() => {
      updateNotificationEnrichment(db, 99999, { role: "master" });
    }).not.toThrow();

    const count = db
      .prepare("SELECT COUNT(*) as c FROM hook_signals")
      .get() as { c: number };
    expect(count.c).toBe(0);
  });

  test("旧スキーマ DB → initDB 再呼び出しで hook_signals 新 8 列が ADD される", async () => {
    const oldDir = await mkdtemp(join(tmpdir(), "cmux-team-old-hook-signals-"));
    try {
      await mkdir(join(oldDir, ".team/traces"), { recursive: true });
      const oldDb = new Database(join(oldDir, ".team/traces/traces.db"));
      oldDb.exec(`
        CREATE TABLE hook_signals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL,
          type TEXT NOT NULL,
          surface TEXT,
          pid INTEGER,
          reason TEXT,
          source TEXT,
          question TEXT,
          task_run_id TEXT,
          payload_json TEXT NOT NULL
        );
      `);
      oldDb
        .prepare(
          `INSERT INTO hook_signals
            (timestamp, type, surface, pid, payload_json)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          "2026-01-01T00:00:00.000Z",
          "SESSION_STARTED",
          "surface:100",
          1234,
          "{}",
        );
      oldDb.close();

      const migratedDb = initDB(oldDir);
      try {
        const cols = migratedDb
          .prepare("PRAGMA table_info(hook_signals)")
          .all() as Array<{ name: string }>;
        const names = new Set(cols.map((c) => c.name));
        for (const col of [
          "surface_uuid",
          "workspace_uuid",
          "role",
          "task_id",
          "conductor_surface",
          "agent_role",
          "message",
          "notification_type",
        ]) {
          expect(names.has(col)).toBe(true);
        }

        const old = migratedDb
          .prepare(
            "SELECT type, surface, role, task_id, message FROM hook_signals WHERE type = ?",
          )
          .get("SESSION_STARTED") as Record<string, string | null>;
        expect(old.type).toBe("SESSION_STARTED");
        expect(old.surface).toBe("surface:100");
        expect(old.role).toBeNull();
        expect(old.task_id).toBeNull();
        expect(old.message).toBeNull();

        // 2 回目の initDB 呼び出しでも throw しない
        migratedDb.close();
        const reopen = initDB(oldDir);
        reopen.close();
      } finally {
        try { migratedDb.close(); } catch {}
      }
    } finally {
      await rm(oldDir, { recursive: true, force: true });
    }
  });
});

describe("trace-store: getHookSignals role/taskId filter (T266)", () => {
  let tmpDir: string;
  let db: Database;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "cmux-team-hook-signals-filter-"));
    db = initDB(tmpDir);

    const id1 = insertHookSignal(db, {
      type: "NOTIFICATION",
      surface: "surface:100",
      pid: 1,
      timestamp: "2026-04-19T10:00:00.000Z",
    } as unknown as QueueMessage);
    updateNotificationEnrichment(db, id1, { role: "master", taskId: null });

    const id2 = insertHookSignal(db, {
      type: "NOTIFICATION",
      surface: "surface:192",
      pid: 2,
      timestamp: "2026-04-19T10:01:00.000Z",
    } as unknown as QueueMessage);
    updateNotificationEnrichment(db, id2, { role: "conductor", taskId: "265" });

    const id3 = insertHookSignal(db, {
      type: "NOTIFICATION",
      surface: "surface:234",
      pid: 3,
      timestamp: "2026-04-19T10:02:00.000Z",
    } as unknown as QueueMessage);
    updateNotificationEnrichment(db, id3, { role: "agent", taskId: "265" });
  });

  afterEach(async () => {
    try { db.close(); } catch {}
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("role フィルタ: conductor のみ取得", () => {
    const rows = getHookSignals(db, { role: "conductor" });
    expect(rows.length).toBe(1);
    expect(rows[0]!.role).toBe("conductor");
    expect(rows[0]!.surface).toBe("surface:192");
  });

  test("taskId フィルタ: 265 のみ取得", () => {
    const rows = getHookSignals(db, { taskId: "265" });
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.task_id === "265")).toBe(true);
  });

  test("role + taskId + type の AND フィルタ", () => {
    const rows = getHookSignals(db, { role: "agent", taskId: "265", type: "NOTIFICATION" });
    expect(rows.length).toBe(1);
    expect(rows[0]!.role).toBe("agent");
  });
});
