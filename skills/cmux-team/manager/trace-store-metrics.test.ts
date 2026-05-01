/**
 * T307: dashboard Metrics タブ用 api_usage 集計関数のユニットテスト。
 *
 * - aggregateApiUsageByRole
 * - aggregateApiUsageByTask
 * - getLatestApiUsageRow
 * - getBurnRateWindow
 *
 * `trace-store.test.ts` の `describe("trace-store: api_usage (T305)")` と同じ
 * `createDummyProject` + `initDB` パターンをそのまま踏襲する。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  initDB,
  insertApiUsage,
  insertHookSignal,
  insertTaskSession,
  aggregateApiUsageByRole,
  aggregateApiUsageByTask,
  countToolCallsByTask,
  failureRateByTask,
  firstEditPerTask,
  getLatestApiUsageRow,
  getBurnRateWindow,
} from "./trace-store";
import { createDummyProject, type DummyProject } from "./test-project";
import type { QueueMessage } from "./schema";

describe("trace-store: aggregateApiUsageByRole (T307)", () => {
  let project: DummyProject;
  let db: Database;

  beforeEach(async () => {
    project = await createDummyProject({
      prefix: "cmux-team-agg-role-t307-",
      subdirs: ["logs"],
    });
    db = initDB(project.root);
  });

  afterEach(async () => {
    try { db.close(); } catch {}
    await project.dispose();
  });

  test("空テーブル → 空配列", () => {
    const rows = aggregateApiUsageByRole(db, {
      sinceIso: "2026-04-24T00:00:00.000Z",
      untilIso: "2026-04-24T23:59:59.999Z",
    });
    expect(rows).toEqual([]);
  });

  test("ロール別 SUM を返す", () => {
    insertApiUsage(db, {
      timestamp: "2026-04-24T10:00:00.000Z",
      role: "master",
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 5,
    });
    insertApiUsage(db, {
      timestamp: "2026-04-24T10:01:00.000Z",
      role: "agent",
      input_tokens: 200,
      output_tokens: 80,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 100,
    });
    insertApiUsage(db, {
      timestamp: "2026-04-24T10:02:00.000Z",
      role: "agent",
      input_tokens: 300,
      output_tokens: 120,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: 200,
    });

    const rows = aggregateApiUsageByRole(db, {
      sinceIso: "2026-04-24T00:00:00.000Z",
      untilIso: "2026-04-24T23:59:59.999Z",
    });
    const byRole = new Map(rows.map((r) => [r.role, r]));

    expect(byRole.get("master")?.requests).toBe(1);
    expect(byRole.get("master")?.input).toBe(100);
    expect(byRole.get("master")?.output).toBe(50);

    expect(byRole.get("agent")?.requests).toBe(2);
    expect(byRole.get("agent")?.input).toBe(500);
    expect(byRole.get("agent")?.output).toBe(200);
    // cache = cache_creation + cache_read（NULL は SUM 内で無視され 0 扱い）
    expect(byRole.get("agent")?.cache).toBe(20 + 100 + 200);
    expect(byRole.get("agent")?.cache_read).toBe(300);
  });

  test("時間範囲外の行は除外される", () => {
    insertApiUsage(db, {
      timestamp: "2026-04-23T23:59:59.000Z", // 範囲外（手前）
      role: "master",
      input_tokens: 999,
    });
    insertApiUsage(db, {
      timestamp: "2026-04-24T10:00:00.000Z", // 範囲内
      role: "master",
      input_tokens: 100,
    });
    insertApiUsage(db, {
      timestamp: "2026-04-25T00:00:00.000Z", // 範囲外（奥）
      role: "master",
      input_tokens: 888,
    });
    const rows = aggregateApiUsageByRole(db, {
      sinceIso: "2026-04-24T00:00:00.000Z",
      untilIso: "2026-04-24T23:59:59.999Z",
    });
    const master = rows.find((r) => r.role === "master")!;
    expect(master.input).toBe(100);
  });

  test("role NULL 行は 'unknown' に fallback される", () => {
    insertApiUsage(db, {
      timestamp: "2026-04-24T10:00:00.000Z",
      role: null,
      input_tokens: 50,
      output_tokens: 10,
    });
    const rows = aggregateApiUsageByRole(db, {
      sinceIso: "2026-04-24T00:00:00.000Z",
      untilIso: "2026-04-24T23:59:59.999Z",
    });
    const unknown = rows.find((r) => r.role === "unknown");
    expect(unknown).toBeDefined();
    expect(unknown?.input).toBe(50);
    expect(unknown?.output).toBe(10);
  });
});

describe("trace-store: aggregateApiUsageByTask (T307)", () => {
  let project: DummyProject;
  let db: Database;

  beforeEach(async () => {
    project = await createDummyProject({
      prefix: "cmux-team-agg-task-t307-",
      subdirs: ["logs"],
    });
    db = initDB(project.root);
  });

  afterEach(async () => {
    try { db.close(); } catch {}
    await project.dispose();
  });

  test("空テーブル → 空配列", () => {
    const rows = aggregateApiUsageByTask(db, {
      sinceIso: "2026-04-24T00:00:00.000Z",
      untilIso: "2026-04-24T23:59:59.999Z",
      limit: 10,
    });
    expect(rows).toEqual([]);
  });

  test("タスク別 SUM を合計降順で返す", () => {
    insertApiUsage(db, {
      timestamp: "2026-04-24T10:00:00.000Z",
      task_id: "T100",
      input_tokens: 100,
      output_tokens: 50,
    });
    insertApiUsage(db, {
      timestamp: "2026-04-24T10:01:00.000Z",
      task_id: "T200",
      input_tokens: 500,
      output_tokens: 300,
    });
    insertApiUsage(db, {
      timestamp: "2026-04-24T10:02:00.000Z",
      task_id: "T200",
      input_tokens: 100,
      output_tokens: 100,
    });

    const rows = aggregateApiUsageByTask(db, {
      sinceIso: "2026-04-24T00:00:00.000Z",
      untilIso: "2026-04-24T23:59:59.999Z",
      limit: 10,
    });
    // T200 の合計は 500+300+100+100=1000、T100 は 150 → T200 が先頭
    expect(rows[0]?.task_id).toBe("T200");
    expect(rows[0]?.input).toBe(600);
    expect(rows[0]?.output).toBe(400);
    expect(rows[1]?.task_id).toBe("T100");
    expect(rows[1]?.input).toBe(100);
  });

  test("task_id IS NULL 行は除外される", () => {
    insertApiUsage(db, {
      timestamp: "2026-04-24T10:00:00.000Z",
      task_id: null,
      input_tokens: 10000, // 巨大でも結果に出ない
    });
    insertApiUsage(db, {
      timestamp: "2026-04-24T10:01:00.000Z",
      task_id: "T1",
      input_tokens: 1,
    });
    const rows = aggregateApiUsageByTask(db, {
      sinceIso: "2026-04-24T00:00:00.000Z",
      untilIso: "2026-04-24T23:59:59.999Z",
      limit: 10,
    });
    expect(rows.length).toBe(1);
    expect(rows[0]?.task_id).toBe("T1");
  });

  test("limit が効く", () => {
    for (let i = 1; i <= 5; i++) {
      insertApiUsage(db, {
        timestamp: `2026-04-24T10:0${i}:00.000Z`,
        task_id: `T${i}`,
        input_tokens: i * 100,
      });
    }
    const rows = aggregateApiUsageByTask(db, {
      sinceIso: "2026-04-24T00:00:00.000Z",
      untilIso: "2026-04-24T23:59:59.999Z",
      limit: 3,
    });
    expect(rows.length).toBe(3);
    // 降順: T5, T4, T3
    expect(rows[0]?.task_id).toBe("T5");
    expect(rows[2]?.task_id).toBe("T3");
  });
});

describe("trace-store: getLatestApiUsageRow (T307)", () => {
  let project: DummyProject;
  let db: Database;

  beforeEach(async () => {
    project = await createDummyProject({
      prefix: "cmux-team-latest-row-t307-",
      subdirs: ["logs"],
    });
    db = initDB(project.root);
  });

  afterEach(async () => {
    try { db.close(); } catch {}
    await project.dispose();
  });

  test("空テーブル → null", () => {
    expect(getLatestApiUsageRow(db)).toBeNull();
  });

  test("最新 1 行（id DESC）を返す", () => {
    insertApiUsage(db, {
      timestamp: "2026-04-24T10:00:00.000Z",
      role: "master",
      ratelimit_tokens_remaining: 900000,
    });
    insertApiUsage(db, {
      timestamp: "2026-04-24T10:01:00.000Z",
      role: "agent",
      ratelimit_tokens_remaining: 800000,
    });
    insertApiUsage(db, {
      timestamp: "2026-04-24T10:02:00.000Z",
      role: "conductor",
      ratelimit_tokens_remaining: 700000,
    });
    const row = getLatestApiUsageRow(db);
    expect(row?.role).toBe("conductor");
    expect(row?.ratelimit_tokens_remaining).toBe(700000);
  });
});

describe("trace-store: getBurnRateWindow (T307)", () => {
  let project: DummyProject;
  let db: Database;

  beforeEach(async () => {
    project = await createDummyProject({
      prefix: "cmux-team-burn-rate-t307-",
      subdirs: ["logs"],
    });
    db = initDB(project.root);
  });

  afterEach(async () => {
    try { db.close(); } catch {}
    await project.dispose();
  });

  test("空テーブル → totalTokens=0", () => {
    const r = getBurnRateWindow(db, 60);
    expect(r.totalTokens).toBe(0);
    expect(r.windowSec).toBe(60);
    expect(r.tokPerSec).toBe(0);
  });

  test("ウィンドウ内の input+output を合算する", () => {
    const nowIso = new Date().toISOString();
    const recent = new Date(Date.now() - 10_000).toISOString(); // 10s 前
    insertApiUsage(db, {
      timestamp: nowIso,
      input_tokens: 100,
      output_tokens: 50,
    });
    insertApiUsage(db, {
      timestamp: recent,
      input_tokens: 200,
      output_tokens: 100,
    });
    const r = getBurnRateWindow(db, 60);
    expect(r.totalTokens).toBe(450);
    expect(r.windowSec).toBe(60);
    expect(r.tokPerSec).toBeCloseTo(450 / 60, 5);
  });

  test("ウィンドウ外（60s 以前）の行は除外される", () => {
    const old = new Date(Date.now() - 120_000).toISOString(); // 2 min 前
    const recent = new Date(Date.now() - 30_000).toISOString();
    insertApiUsage(db, {
      timestamp: old,
      input_tokens: 9999,
      output_tokens: 9999,
    });
    insertApiUsage(db, {
      timestamp: recent,
      input_tokens: 10,
      output_tokens: 20,
    });
    const r = getBurnRateWindow(db, 60);
    expect(r.totalTokens).toBe(30);
  });

  test("NULL 値の input/output は無視される（COALESCE で 0 扱い）", () => {
    const recent = new Date(Date.now() - 5_000).toISOString();
    insertApiUsage(db, {
      timestamp: recent,
      input_tokens: null,
      output_tokens: null,
    });
    const r = getBurnRateWindow(db, 60);
    expect(r.totalTokens).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────
// T407: countToolCallsByTask / firstEditPerTask / failureRateByTask CTE 拡張
// ────────────────────────────────────────────────────────────────────────

const SINCE = "2026-04-30T00:00:00.000Z";
const UNTIL = "2026-05-01T23:59:59.999Z";

function insertPreToolUse(
  db: Database,
  args: { sessionId: string; toolName: string; timestamp: string; payload?: any },
) {
  const msg: QueueMessage = {
    type: "PRE_TOOL_USE",
    surface: "surface:300",
    pid: 1234,
    role: "agent",
    sessionId: args.sessionId,
    toolName: args.toolName,
    payload: args.payload ?? {},
    timestamp: args.timestamp,
  };
  insertHookSignal(db, msg);
}

function insertPostToolUse(
  db: Database,
  args: {
    sessionId: string;
    toolName: string;
    timestamp: string;
    success?: boolean;
    error?: string;
  },
) {
  const tool_response: Record<string, any> = {};
  if (args.success !== undefined) tool_response.success = args.success;
  if (args.error !== undefined) tool_response.error = args.error;
  const msg: QueueMessage = {
    type: "POST_TOOL_USE",
    surface: "surface:300",
    pid: 1234,
    role: "agent",
    sessionId: args.sessionId,
    toolName: args.toolName,
    payload: { tool_response },
    timestamp: args.timestamp,
  };
  insertHookSignal(db, msg);
}

describe("trace-store: countToolCallsByTask agent_spawned 行 + 防御 (T407)", () => {
  let project: DummyProject;
  let db: Database;

  beforeEach(async () => {
    project = await createDummyProject({
      prefix: "cmux-team-count-tool-t407-",
      subdirs: ["logs"],
    });
    db = initDB(project.root);
  });

  afterEach(async () => {
    try { db.close(); } catch {}
    await project.dispose();
  });

  test("(T-5) agent_spawned 行のみで task_id を解決する", () => {
    // task_sessions に agent_spawned 行のみ（assigned 行なし）
    insertTaskSession(db, {
      timestamp: "2026-04-30T10:00:00.000Z",
      task_id: "T123",
      session_id: "U_a-aaaaaaaaaaaa",
      role: "agent",
      surface: "surface:301",
      event: "agent_spawned",
    });
    insertPreToolUse(db, {
      sessionId: "U_a-aaaaaaaaaaaa",
      toolName: "Edit",
      timestamp: "2026-04-30T10:01:00.000Z",
    });

    const rows = countToolCallsByTask(db, { sinceIso: SINCE, untilIso: UNTIL });
    const t123 = rows.find((r) => r.task_id === "T123");
    expect(t123).toBeDefined();
    expect(t123?.tool_name).toBe("Edit");
    expect(t123?.n).toBe(1);
  });

  test("(R1) 重複検出: assigned + agent_spawned 併存で同 task_id に集約 (二重カウントしない)", () => {
    // 同 task_id に conductor の assigned 行 + agent の agent_spawned 行
    insertTaskSession(db, {
      timestamp: "2026-04-30T10:00:00.000Z",
      task_id: "Tn",
      session_id: "U_c-cccccccccccc",
      role: "conductor",
      event: "assigned",
    });
    insertTaskSession(db, {
      timestamp: "2026-04-30T10:00:30.000Z",
      task_id: "Tn",
      session_id: "U_a-aaaaaaaaaaaa",
      role: "agent",
      event: "agent_spawned",
    });
    // hook_signals に conductor 由来 1 件 + agent 由来 1 件
    insertPreToolUse(db, {
      sessionId: "U_c-cccccccccccc",
      toolName: "Bash",
      timestamp: "2026-04-30T10:01:00.000Z",
    });
    insertPreToolUse(db, {
      sessionId: "U_a-aaaaaaaaaaaa",
      toolName: "Bash",
      timestamp: "2026-04-30T10:02:00.000Z",
    });

    const rows = countToolCallsByTask(db, { sinceIso: SINCE, untilIso: UNTIL });
    // 同 (task_id=Tn, tool_name=Bash) で集約され n=2
    const tn = rows.find((r) => r.task_id === "Tn" && r.tool_name === "Bash");
    expect(tn?.n).toBe(2);
    // 行数: Tn の Bash 1 行のみ
    expect(rows.filter((r) => r.task_id === "Tn").length).toBe(1);
  });

  test("(R1) 異常状態: 同 session_id に複数 task_id → MIN(task_id) で 1 つに集約", () => {
    insertTaskSession(db, {
      timestamp: "2026-04-30T10:00:00.000Z",
      task_id: "T200",
      session_id: "U_a-aaaaaaaaaaaa",
      role: "agent",
      event: "agent_spawned",
    });
    insertTaskSession(db, {
      timestamp: "2026-04-30T10:01:00.000Z",
      task_id: "T100",
      session_id: "U_a-aaaaaaaaaaaa",
      role: "agent",
      event: "agent_spawned",
    });
    insertPreToolUse(db, {
      sessionId: "U_a-aaaaaaaaaaaa",
      toolName: "Read",
      timestamp: "2026-04-30T10:02:00.000Z",
    });

    const rows = countToolCallsByTask(db, { sinceIso: SINCE, untilIso: UNTIL });
    // MIN(T100, T200) = T100 で集約（決定論的）
    expect(rows.length).toBe(1);
    expect(rows[0]?.task_id).toBe("T100");
    expect(rows[0]?.n).toBe(1);
  });

  test("(C2) 空 session_id の行は集計から除外される", () => {
    // 空 session_id の agent_spawned 行（過去 backfill されない不正行）
    insertTaskSession(db, {
      timestamp: "2026-04-30T10:00:00.000Z",
      task_id: "T_empty",
      session_id: "",
      role: "agent",
      event: "agent_spawned",
    });
    // 正常な agent_spawned 行
    insertTaskSession(db, {
      timestamp: "2026-04-30T10:00:01.000Z",
      task_id: "T_ok",
      session_id: "U_ok-okokokokok",
      role: "agent",
      event: "agent_spawned",
    });
    // 空 session_id の hook_signal → 集計対象外
    insertPreToolUse(db, {
      sessionId: "",
      toolName: "Bash",
      timestamp: "2026-04-30T10:01:00.000Z",
    });
    insertPreToolUse(db, {
      sessionId: "U_ok-okokokokok",
      toolName: "Bash",
      timestamp: "2026-04-30T10:01:01.000Z",
    });

    const rows = countToolCallsByTask(db, { sinceIso: SINCE, untilIso: UNTIL });
    // T_empty 由来の集計は出ない
    expect(rows.find((r) => r.task_id === "T_empty")).toBeUndefined();
    // T_ok のみ集計
    const ok = rows.find((r) => r.task_id === "T_ok");
    expect(ok?.n).toBe(1);
    // 空 session_id の hook_signal は task_id=null として残るが、別 fixture: 空文字列 session_id 同士の誤マッチは起きない
    // 本テストでは空 session_id の hook_signal が T_empty と誤マッチしないことが要点
  });
});

describe("trace-store: firstEditPerTask agent_spawned 行 + 防御 (T407)", () => {
  let project: DummyProject;
  let db: Database;

  beforeEach(async () => {
    project = await createDummyProject({
      prefix: "cmux-team-first-edit-t407-",
      subdirs: ["logs"],
    });
    db = initDB(project.root);
  });

  afterEach(async () => {
    try { db.close(); } catch {}
    await project.dispose();
  });

  test("(T-6) agent_spawned 行のみで firstEditPerTask が解決する", () => {
    insertTaskSession(db, {
      timestamp: "2026-04-30T10:00:00.000Z",
      task_id: "T123",
      session_id: "U_a-firstedit",
      role: "agent",
      event: "agent_spawned",
    });
    insertPreToolUse(db, {
      sessionId: "U_a-firstedit",
      toolName: "Edit",
      timestamp: "2026-04-30T10:05:00.000Z",
    });
    insertPreToolUse(db, {
      sessionId: "U_a-firstedit",
      toolName: "Edit",
      timestamp: "2026-04-30T10:06:00.000Z",
    });

    const rows = firstEditPerTask(db, { sinceIso: SINCE, untilIso: UNTIL });
    const t123 = rows.find((r) => r.task_id === "T123");
    expect(t123?.first_edit_ts).toBe("2026-04-30T10:05:00.000Z");
  });

  test("(C2) 空 session_id 行は除外される", () => {
    insertTaskSession(db, {
      timestamp: "2026-04-30T10:00:00.000Z",
      task_id: "T_empty",
      session_id: "",
      role: "agent",
      event: "agent_spawned",
    });
    insertPreToolUse(db, {
      sessionId: "",
      toolName: "Edit",
      timestamp: "2026-04-30T10:05:00.000Z",
    });

    const rows = firstEditPerTask(db, { sinceIso: SINCE, untilIso: UNTIL });
    expect(rows.find((r) => r.task_id === "T_empty")).toBeUndefined();
  });
});

describe("trace-store: failureRateByTask agent_spawned 行 + 防御 (T407)", () => {
  let project: DummyProject;
  let db: Database;

  beforeEach(async () => {
    project = await createDummyProject({
      prefix: "cmux-team-fail-rate-t407-",
      subdirs: ["logs"],
    });
    db = initDB(project.root);
  });

  afterEach(async () => {
    try { db.close(); } catch {}
    await project.dispose();
  });

  test("(T-6) agent_spawned 行のみで failureRateByTask が解決する", () => {
    insertTaskSession(db, {
      timestamp: "2026-04-30T10:00:00.000Z",
      task_id: "T123",
      session_id: "U_a-failrate",
      role: "agent",
      event: "agent_spawned",
    });
    // 成功 1, 失敗 1
    insertPostToolUse(db, {
      sessionId: "U_a-failrate",
      toolName: "Bash",
      timestamp: "2026-04-30T10:05:00.000Z",
      success: true,
    });
    insertPostToolUse(db, {
      sessionId: "U_a-failrate",
      toolName: "Bash",
      timestamp: "2026-04-30T10:06:00.000Z",
      success: false,
    });

    const rows = failureRateByTask(db, { sinceIso: SINCE, untilIso: UNTIL });
    const t123 = rows.find((r) => r.task_id === "T123");
    expect(t123?.total).toBe(2);
    expect(t123?.failures).toBe(1);
  });

  test("(C2) 空 session_id 行は集計対象外（誤マッチしない）", () => {
    // 空 session_id の task_sessions 行 (task_id=T_empty)
    insertTaskSession(db, {
      timestamp: "2026-04-30T10:00:00.000Z",
      task_id: "T_empty",
      session_id: "",
      role: "agent",
      event: "agent_spawned",
    });
    // 空 session_id の POST_TOOL_USE → T_empty に誤マッチしてはいけない
    insertPostToolUse(db, {
      sessionId: "",
      toolName: "Bash",
      timestamp: "2026-04-30T10:05:00.000Z",
      success: false,
    });

    const rows = failureRateByTask(db, { sinceIso: SINCE, untilIso: UNTIL });
    expect(rows.find((r) => r.task_id === "T_empty")).toBeUndefined();
  });
});
