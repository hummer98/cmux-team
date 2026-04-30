import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir } from "fs/promises";
import { join } from "path";
import { Database } from "bun:sqlite";
import {
  initDB,
  insertHookSignal,
  getHookSignals,
  insertTaskSession,
  getTaskSessions,
  updateNotificationEnrichment,
  insertApiUsage,
  getApiUsage,
  getTaskUsageTotal,
  getTaskUsageByRole,
  getTaskUsageByModel,
  type ApiUsageRecord,
} from "./trace-store";
import type { QueueMessage } from "./schema";
import { createDummyProject, type DummyProject } from "./test-project";

describe("trace-store: insertHookSignal (T216)", () => {
  let project: DummyProject;
  let tmpDir: string;
  let db: Database;

  beforeEach(async () => {
    project = await createDummyProject({
      prefix: "cmux-team-trace-store-test-",
      subdirs: ["logs"],
    });
    tmpDir = project.root;
    db = initDB(tmpDir);
  });

  afterEach(async () => {
    try { db.close(); } catch {}
    await project.dispose();
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
  let project: DummyProject;
  let tmpDir: string;
  let db: Database;

  beforeEach(async () => {
    project = await createDummyProject({
      prefix: "cmux-team-getHookSignals-test-",
      subdirs: ["logs"],
    });
    tmpDir = project.root;
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
    await project.dispose();
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
  let project: DummyProject;
  let tmpDir: string;
  let db: Database;

  beforeEach(async () => {
    project = await createDummyProject({
      prefix: "cmux-team-task-sessions-base-",
      subdirs: ["logs"],
    });
    tmpDir = project.root;
    db = initDB(tmpDir);
  });

  afterEach(async () => {
    try { db.close(); } catch {}
    await project.dispose();
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
    const oldProject = await createDummyProject({
      prefix: "cmux-team-old-schema-",
      subdirs: [],
      setProjectRootEnv: false,
    });
    const oldDir = oldProject.root;
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
      await oldProject.dispose();
    }
  });
});

describe("trace-store: hook_signals NOTIFICATION columns (T266)", () => {
  let project: DummyProject;
  let tmpDir: string;
  let db: Database;

  beforeEach(async () => {
    project = await createDummyProject({
      prefix: "cmux-team-hook-signals-t266-",
      subdirs: ["logs"],
    });
    tmpDir = project.root;
    db = initDB(tmpDir);
  });

  afterEach(async () => {
    try { db.close(); } catch {}
    await project.dispose();
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
    const oldProject = await createDummyProject({
      prefix: "cmux-team-old-hook-signals-",
      subdirs: [],
      setProjectRootEnv: false,
    });
    const oldDir = oldProject.root;
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
      await oldProject.dispose();
    }
  });
});

describe("trace-store: hook_signals tool columns (T379)", () => {
  let project: DummyProject;
  let tmpDir: string;
  let db: Database;

  beforeEach(async () => {
    project = await createDummyProject({
      prefix: "cmux-team-hook-signals-t379-",
      subdirs: ["logs"],
    });
    tmpDir = project.root;
    db = initDB(tmpDir);
  });

  afterEach(async () => {
    try { db.close(); } catch {}
    await project.dispose();
  });

  test("新規 DB: hook_signals に session_id / tool_name 列が存在する", () => {
    const cols = db
      .prepare("PRAGMA table_info(hook_signals)")
      .all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    expect(names.has("session_id")).toBe(true);
    expect(names.has("tool_name")).toBe(true);
  });

  test("新規 DB: hook_signals に session_id / tool_name の index が作られている", () => {
    const idx = db
      .prepare("PRAGMA index_list(hook_signals)")
      .all() as Array<{ name: string }>;
    const idxNames = new Set(idx.map((i) => i.name));
    expect(idxNames.has("idx_hook_signals_session_id")).toBe(true);
    expect(idxNames.has("idx_hook_signals_tool_name")).toBe(true);
  });

  test("PRE_TOOL_USE 挿入で session_id / tool_name 列が埋まる", () => {
    const id = insertHookSignal(db, {
      type: "PRE_TOOL_USE",
      surface: "surface:200",
      pid: 22222,
      role: "agent",
      sessionId: "sess-pre-1",
      toolName: "Edit",
      payload: { tool_input: { file_path: "/tmp/x.ts" } },
      timestamp: "2026-04-29T10:00:00.000Z",
    } as unknown as QueueMessage);

    const row = db
      .prepare(
        "SELECT type, session_id, tool_name, role, surface FROM hook_signals WHERE id = ?",
      )
      .get(id) as Record<string, string | null>;
    expect(row.type).toBe("PRE_TOOL_USE");
    expect(row.session_id).toBe("sess-pre-1");
    expect(row.tool_name).toBe("Edit");
    expect(row.surface).toBe("surface:200");
    // role 列は updateNotificationEnrichment 経由ではなく、PRE_TOOL_USE は最初から
    // メッセージ本体に乗るため insert 時点で書き込まれる（NotificationEnrichment との一貫性）。
    expect(row.role).toBe("agent");
  });

  test("POST_TOOL_USE 挿入で session_id / tool_name 列が埋まる", () => {
    const id = insertHookSignal(db, {
      type: "POST_TOOL_USE",
      surface: "surface:201",
      pid: 22223,
      role: "agent",
      sessionId: "sess-post-1",
      toolName: "Read",
      payload: {
        tool_input: { file_path: "/tmp/y.ts" },
        tool_response: { success: true },
      },
      timestamp: "2026-04-29T10:00:01.000Z",
    } as unknown as QueueMessage);

    const row = db
      .prepare(
        "SELECT type, session_id, tool_name FROM hook_signals WHERE id = ?",
      )
      .get(id) as Record<string, string | null>;
    expect(row.type).toBe("POST_TOOL_USE");
    expect(row.session_id).toBe("sess-post-1");
    expect(row.tool_name).toBe("Read");
  });

  test("既存 SESSION_STARTED 挿入では session_id / tool_name が NULL", () => {
    const id = insertHookSignal(db, {
      type: "SESSION_STARTED",
      surface: "surface:100",
      pid: 1234,
      source: "startup",
      timestamp: "2026-04-29T10:00:00.000Z",
    } as unknown as QueueMessage);

    const row = db
      .prepare(
        "SELECT session_id, tool_name FROM hook_signals WHERE id = ?",
      )
      .get(id) as Record<string, string | null>;
    expect(row.session_id).toBeNull();
    expect(row.tool_name).toBeNull();
  });

  test("旧スキーマ DB → initDB 再呼び出しで session_id / tool_name 列が ADD される（idempotent）", async () => {
    const oldProject = await createDummyProject({
      prefix: "cmux-team-old-hook-tool-",
      subdirs: [],
      setProjectRootEnv: false,
    });
    const oldDir = oldProject.root;
    let migratedDb: Database | undefined;
    try {
      await mkdir(join(oldDir, ".team/traces"), { recursive: true });
      const oldDb = new Database(join(oldDir, ".team/traces/traces.db"));
      // T266 までの 8 列だけが ADD された旧 DB を再現
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
          payload_json TEXT NOT NULL,
          surface_uuid TEXT,
          workspace_uuid TEXT,
          role TEXT,
          task_id TEXT,
          conductor_surface TEXT,
          agent_role TEXT,
          message TEXT,
          notification_type TEXT
        );
      `);
      oldDb.close();

      migratedDb = initDB(oldDir);
      const cols = migratedDb
        .prepare("PRAGMA table_info(hook_signals)")
        .all() as Array<{ name: string }>;
      const names = new Set(cols.map((c) => c.name));
      expect(names.has("session_id")).toBe(true);
      expect(names.has("tool_name")).toBe(true);

      const idx = migratedDb
        .prepare("PRAGMA index_list(hook_signals)")
        .all() as Array<{ name: string }>;
      const idxNames = new Set(idx.map((i) => i.name));
      expect(idxNames.has("idx_hook_signals_session_id")).toBe(true);
      expect(idxNames.has("idx_hook_signals_tool_name")).toBe(true);

      // 2 回目の initDB 呼び出しでも ALTER は冪等（throw しない）
      migratedDb.close();
      migratedDb = undefined;
      const reopen = initDB(oldDir);
      const cols2 = reopen
        .prepare("PRAGMA table_info(hook_signals)")
        .all() as Array<{ name: string }>;
      const names2 = new Set(cols2.map((c) => c.name));
      expect(names2.has("session_id")).toBe(true);
      expect(names2.has("tool_name")).toBe(true);
      reopen.close();
    } finally {
      try { migratedDb?.close(); } catch {}
      await oldProject.dispose();
    }
  });
});

describe("trace-store: getHookSignals role/taskId filter (T266)", () => {
  let project: DummyProject;
  let tmpDir: string;
  let db: Database;

  beforeEach(async () => {
    project = await createDummyProject({
      prefix: "cmux-team-hook-signals-filter-",
      subdirs: ["logs"],
    });
    tmpDir = project.root;
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
    await project.dispose();
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

describe("trace-store: api_usage (T305)", () => {
  let project: DummyProject;
  let tmpDir: string;
  let db: Database;

  beforeEach(async () => {
    project = await createDummyProject({
      prefix: "cmux-team-api-usage-t305-",
      subdirs: ["logs"],
    });
    tmpDir = project.root;
    db = initDB(tmpDir);
  });

  afterEach(async () => {
    try { db.close(); } catch {}
    await project.dispose();
  });

  test("新規 DB: api_usage テーブルに全 27 列が作成される", () => {
    const cols = db
      .prepare("PRAGMA table_info(api_usage)")
      .all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    for (const col of [
      "id",
      "timestamp",
      "task_id",
      "role",
      "surface",
      "conductor_id",
      "model",
      "request_id",
      "status_code",
      "input_tokens",
      "output_tokens",
      "cache_creation_input_tokens",
      "cache_read_input_tokens",
      "stop_reason",
      "duration_ms",
      "ratelimit_tokens_remaining",
      "ratelimit_tokens_limit",
      "ratelimit_tokens_reset",
      "ratelimit_input_tokens_remaining",
      "ratelimit_input_tokens_limit",
      "ratelimit_input_tokens_reset",
      "ratelimit_output_tokens_remaining",
      "ratelimit_output_tokens_limit",
      "ratelimit_output_tokens_reset",
      "ratelimit_requests_remaining",
      "ratelimit_requests_limit",
      "ratelimit_requests_reset",
      "error",
    ]) {
      expect(names.has(col)).toBe(true);
    }
  });

  test("insertApiUsage: 全列を指定した往復で読み戻せる", () => {
    const record: ApiUsageRecord = {
      timestamp: "2026-04-24T10:00:00.000Z",
      task_id: "T305",
      role: "agent",
      surface: "surface:300",
      conductor_id: "surface:200",
      model: "claude-opus-4-7",
      request_id: "req_abc123",
      status_code: 200,
      input_tokens: 1234,
      output_tokens: 567,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 2000,
      stop_reason: "end_turn",
      duration_ms: 5432,
      ratelimit_tokens_remaining: 900000,
      ratelimit_tokens_limit: 1000000,
      ratelimit_tokens_reset: "2026-04-24T10:05:00Z",
      ratelimit_input_tokens_remaining: 800000,
      ratelimit_input_tokens_limit: 900000,
      ratelimit_input_tokens_reset: "2026-04-24T10:05:00Z",
      ratelimit_output_tokens_remaining: 100000,
      ratelimit_output_tokens_limit: 150000,
      ratelimit_output_tokens_reset: "2026-04-24T10:05:00Z",
      ratelimit_requests_remaining: 4000,
      ratelimit_requests_limit: 5000,
      ratelimit_requests_reset: "2026-04-24T10:05:00Z",
      error: null,
    };

    const id = insertApiUsage(db, record);
    expect(id).toBeGreaterThan(0);

    const rows = getApiUsage(db, { taskId: "T305" });
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.model).toBe("claude-opus-4-7");
    expect(row.request_id).toBe("req_abc123");
    expect(row.status_code).toBe(200);
    expect(row.input_tokens).toBe(1234);
    expect(row.output_tokens).toBe(567);
    expect(row.cache_creation_input_tokens).toBe(100);
    expect(row.cache_read_input_tokens).toBe(2000);
    expect(row.stop_reason).toBe("end_turn");
    expect(row.duration_ms).toBe(5432);
    expect(row.ratelimit_tokens_remaining).toBe(900000);
    expect(row.ratelimit_requests_remaining).toBe(4000);
    expect(row.ratelimit_tokens_reset).toBe("2026-04-24T10:05:00Z");
    expect(row.error).toBeNull();
  });

  test("insertApiUsage: 最小構成（timestamp のみ必須）でも INSERT できる、欠損は NULL", () => {
    const id = insertApiUsage(db, {
      timestamp: "2026-04-24T10:00:00.000Z",
    });
    expect(id).toBeGreaterThan(0);

    const rows = getApiUsage(db, {});
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.timestamp).toBe("2026-04-24T10:00:00.000Z");
    expect(row.task_id ?? null).toBeNull();
    expect(row.model ?? null).toBeNull();
    expect(row.input_tokens ?? null).toBeNull();
    expect(row.error ?? null).toBeNull();
  });

  test("getApiUsage: role / error フィルタが効く", () => {
    insertApiUsage(db, {
      timestamp: "2026-04-24T10:00:00.000Z",
      task_id: "T1",
      role: "master",
      input_tokens: 10,
      output_tokens: 20,
    });
    insertApiUsage(db, {
      timestamp: "2026-04-24T10:01:00.000Z",
      task_id: "T2",
      role: "agent",
      input_tokens: 30,
      output_tokens: 40,
    });
    insertApiUsage(db, {
      timestamp: "2026-04-24T10:02:00.000Z",
      task_id: "T3",
      role: "agent",
      status_code: 429,
      error: "rate_limit_error",
    });

    const agents = getApiUsage(db, { role: "agent" });
    expect(agents.length).toBe(2);

    const rateLimited = getApiUsage(db, { error: "rate_limit_error" });
    expect(rateLimited.length).toBe(1);
    expect(rateLimited[0]!.task_id).toBe("T3");

    // id DESC 順
    const all = getApiUsage(db, {});
    expect(all.length).toBe(3);
    expect(all[0]!.task_id).toBe("T3");
    expect(all[2]!.task_id).toBe("T1");
  });

  test("ensureApiUsageColumns: 列欠損の旧 api_usage があっても ALTER TABLE で補完される", async () => {
    const oldProject = await createDummyProject({
      prefix: "cmux-team-old-api-usage-",
      subdirs: [],
      setProjectRootEnv: false,
    });
    const oldDir = oldProject.root;
    try {
      await mkdir(join(oldDir, ".team/traces"), { recursive: true });
      const oldDb = new Database(join(oldDir, ".team/traces/traces.db"));
      // 列数少ない旧スキーマ (timestamp + input_tokens のみ)
      oldDb.exec(`
        CREATE TABLE api_usage (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL,
          input_tokens INTEGER
        );
      `);
      oldDb
        .prepare("INSERT INTO api_usage (timestamp, input_tokens) VALUES (?, ?)")
        .run("2026-01-01T00:00:00.000Z", 42);
      oldDb.close();

      const migratedDb = initDB(oldDir);
      try {
        const cols = migratedDb
          .prepare("PRAGMA table_info(api_usage)")
          .all() as Array<{ name: string }>;
        const names = new Set(cols.map((c) => c.name));
        for (const col of [
          "task_id",
          "role",
          "surface",
          "model",
          "request_id",
          "status_code",
          "output_tokens",
          "cache_creation_input_tokens",
          "cache_read_input_tokens",
          "stop_reason",
          "duration_ms",
          "ratelimit_tokens_remaining",
          "ratelimit_requests_reset",
          "error",
        ]) {
          expect(names.has(col)).toBe(true);
        }

        // 旧行は残ったまま
        const old = migratedDb
          .prepare(
            "SELECT timestamp, input_tokens, output_tokens, model FROM api_usage LIMIT 1",
          )
          .get() as {
            timestamp: string;
            input_tokens: number;
            output_tokens: number | null;
            model: string | null;
          };
        expect(old.timestamp).toBe("2026-01-01T00:00:00.000Z");
        expect(old.input_tokens).toBe(42);
        expect(old.output_tokens).toBeNull();
        expect(old.model).toBeNull();

        // 2 回目の initDB 呼び出しでも throw しない（冪等）
        migratedDb.close();
        const reopen = initDB(oldDir);
        reopen.close();
      } finally {
        try { migratedDb.close(); } catch {}
      }
    } finally {
      await oldProject.dispose();
    }
  });
});

describe("trace-store: api_usage metrics (T306)", () => {
  let project: DummyProject;
  let tmpDir: string;
  let db: Database;

  beforeEach(async () => {
    project = await createDummyProject({
      prefix: "cmux-team-api-usage-t306-",
      subdirs: ["logs"],
    });
    tmpDir = project.root;
    db = initDB(tmpDir);
  });

  afterEach(async () => {
    try { db.close(); } catch {}
    await project.dispose();
  });

  test("getTaskUsageTotal: 0 件タスクで requests=0 / 他列 0 を返す", () => {
    const total = getTaskUsageTotal(db, "T999");
    expect(total.requests).toBe(0);
    expect(total.inputTokens).toBe(0);
    expect(total.outputTokens).toBe(0);
    expect(total.cacheCreation).toBe(0);
    expect(total.cacheRead).toBe(0);
  });

  test("getTaskUsageTotal: cache 列 NULL 混在で NULL は合算されず他列は合算される", () => {
    insertApiUsage(db, {
      timestamp: "2026-04-24T10:00:00.000Z",
      task_id: "T306",
      role: "agent",
      model: "claude-opus-4-7",
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 200,
    });
    insertApiUsage(db, {
      timestamp: "2026-04-24T10:01:00.000Z",
      task_id: "T306",
      role: "agent",
      model: "claude-opus-4-7",
      input_tokens: 200,
      output_tokens: 100,
      // cache 列は null のまま（SUM は NULL を無視して他行と合算する）
    });

    const total = getTaskUsageTotal(db, "T306");
    expect(total.requests).toBe(2);
    expect(total.inputTokens).toBe(300);
    expect(total.outputTokens).toBe(150);
    expect(total.cacheCreation).toBe(10);
    expect(total.cacheRead).toBe(200);
  });

  test("getTaskUsageByRole: role=NULL 行は 'unknown' に集約される", () => {
    insertApiUsage(db, {
      timestamp: "2026-04-24T10:00:00.000Z",
      task_id: "T306",
      role: "agent",
      input_tokens: 100,
      output_tokens: 50,
    });
    insertApiUsage(db, {
      timestamp: "2026-04-24T10:01:00.000Z",
      task_id: "T306",
      // role は null
      input_tokens: 30,
      output_tokens: 20,
    });

    const rows = getTaskUsageByRole(db, "T306");
    const unknown = rows.find((r) => r.role === "unknown");
    expect(unknown).toBeDefined();
    expect(unknown!.requests).toBe(1);
    expect(unknown!.inputTokens).toBe(30);
    expect(unknown!.outputTokens).toBe(20);
  });

  test("getTaskUsageByModel: model=NULL 行は '(unknown)' に集約される", () => {
    insertApiUsage(db, {
      timestamp: "2026-04-24T10:00:00.000Z",
      task_id: "T306",
      role: "agent",
      model: "claude-opus-4-7",
      input_tokens: 100,
      output_tokens: 50,
    });
    insertApiUsage(db, {
      timestamp: "2026-04-24T10:01:00.000Z",
      task_id: "T306",
      role: "agent",
      // model null（エラー応答でモデル未取得のケース）
      status_code: 429,
      error: "rate_limit_error",
    });

    const rows = getTaskUsageByModel(db, "T306");
    const unknown = rows.find((r) => r.model === "(unknown)");
    expect(unknown).toBeDefined();
    expect(unknown!.requests).toBe(1);
  });

  test("getTaskUsageByRole: 合計 tokens 降順で並ぶ", () => {
    // conductor: 50 + 30 = 80
    insertApiUsage(db, {
      timestamp: "2026-04-24T10:00:00.000Z",
      task_id: "T306",
      role: "conductor",
      input_tokens: 50,
      output_tokens: 30,
    });
    // agent: 1000 + 500 = 1500（最大）
    insertApiUsage(db, {
      timestamp: "2026-04-24T10:01:00.000Z",
      task_id: "T306",
      role: "agent",
      input_tokens: 1000,
      output_tokens: 500,
    });
    // master: 200 + 100 = 300
    insertApiUsage(db, {
      timestamp: "2026-04-24T10:02:00.000Z",
      task_id: "T306",
      role: "master",
      input_tokens: 200,
      output_tokens: 100,
    });

    const rows = getTaskUsageByRole(db, "T306");
    expect(rows.length).toBe(3);
    expect(rows[0]!.role).toBe("agent");
    expect(rows[1]!.role).toBe("master");
    expect(rows[2]!.role).toBe("conductor");
  });

  test("getTaskUsageByModel: requests 降順で並ぶ", () => {
    // opus: 3 件
    for (let i = 0; i < 3; i++) {
      insertApiUsage(db, {
        timestamp: `2026-04-24T10:0${i}:00.000Z`,
        task_id: "T306",
        role: "agent",
        model: "claude-opus-4-7",
        input_tokens: 100,
        output_tokens: 50,
      });
    }
    // sonnet: 1 件
    insertApiUsage(db, {
      timestamp: "2026-04-24T10:10:00.000Z",
      task_id: "T306",
      role: "agent",
      model: "claude-sonnet-4-6",
      input_tokens: 100,
      output_tokens: 50,
    });
    // haiku: 2 件
    for (let i = 0; i < 2; i++) {
      insertApiUsage(db, {
        timestamp: `2026-04-24T10:2${i}:00.000Z`,
        task_id: "T306",
        role: "agent",
        model: "claude-haiku-4-5-20251001",
        input_tokens: 100,
        output_tokens: 50,
      });
    }

    const rows = getTaskUsageByModel(db, "T306");
    expect(rows.length).toBe(3);
    expect(rows[0]!.model).toBe("claude-opus-4-7");
    expect(rows[0]!.requests).toBe(3);
    expect(rows[1]!.model).toBe("claude-haiku-4-5-20251001");
    expect(rows[1]!.requests).toBe(2);
    expect(rows[2]!.model).toBe("claude-sonnet-4-6");
    expect(rows[2]!.requests).toBe(1);
  });

  test("エラー行（error NOT NULL）も集計に含まれる", () => {
    insertApiUsage(db, {
      timestamp: "2026-04-24T10:00:00.000Z",
      task_id: "T306",
      role: "agent",
      model: "claude-opus-4-7",
      input_tokens: 100,
      output_tokens: 50,
    });
    // エラー応答（model null, tokens null, error あり）
    insertApiUsage(db, {
      timestamp: "2026-04-24T10:01:00.000Z",
      task_id: "T306",
      role: "agent",
      status_code: 429,
      error: "rate_limit_error",
    });

    const total = getTaskUsageTotal(db, "T306");
    expect(total.requests).toBe(2); // エラー行も COUNT(*) に入る
    expect(total.inputTokens).toBe(100);
    expect(total.outputTokens).toBe(50);

    const byRole = getTaskUsageByRole(db, "T306");
    expect(byRole.length).toBe(1);
    expect(byRole[0]!.role).toBe("agent");
    expect(byRole[0]!.requests).toBe(2); // 成功 + エラーの 2 件

    const byModel = getTaskUsageByModel(db, "T306");
    // model null が "(unknown)" に入り、opus が 1 件 + unknown が 1 件
    expect(byModel.length).toBe(2);
    const opusRow = byModel.find((r) => r.model === "claude-opus-4-7");
    const unknownRow = byModel.find((r) => r.model === "(unknown)");
    expect(opusRow!.requests).toBe(1);
    expect(unknownRow!.requests).toBe(1);
  });
});
