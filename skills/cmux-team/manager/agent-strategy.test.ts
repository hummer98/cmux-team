/**
 * T414: agent-strategy.ts のユニットテスト。
 *
 * - classifyStrategy: 6 値分類の境界
 * - aggregateAgentStrategyByTask: SQL 集計 + ラベル付与
 * - aggregateAgentSpawnTimeline: bucket × role の積み上げ
 * - getAgentStrategyForTask: drill-down (events.jsonl 不在時の fail-soft 含む)
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { writeFile } from "fs/promises";
import { join } from "path";
import {
  classifyStrategy,
  aggregateAgentStrategyByTask,
  aggregateAgentSpawnTimeline,
  getAgentStrategyForTask,
} from "./agent-strategy";
import { initDB, insertTaskSession } from "./trace-store";
import { createDummyProject, type DummyProject } from "./test-project";

describe("classifyStrategy (T414)", () => {
  test("空 → solo", () => {
    expect(classifyStrategy({})).toBe("solo");
  });
  test("researcher だけ → research-only", () => {
    expect(classifyStrategy({ researcher: 2 })).toBe("research-only");
  });
  test("planner + implementer → plan-impl", () => {
    expect(classifyStrategy({ planner: 1, implementer: 1 })).toBe("plan-impl");
  });
  test("implementer 複数 → parallel-impl", () => {
    expect(classifyStrategy({ implementer: 3 })).toBe("parallel-impl");
  });
  test("4 役 全部 → full-cycle", () => {
    expect(
      classifyStrategy({ researcher: 1, planner: 1, implementer: 1, reviewer: 1 }),
    ).toBe("full-cycle");
  });
  test("tester だけ → other", () => {
    expect(classifyStrategy({ tester: 1 })).toBe("other");
  });
  test("plan-impl 判定の境界: planner+implementer に reviewer が混じれば other", () => {
    expect(
      classifyStrategy({ planner: 1, implementer: 1, reviewer: 1 }),
    ).toBe("other");
  });
});

describe("aggregateAgentStrategyByTask (T414)", () => {
  let project: DummyProject;
  let db: Database;

  beforeEach(async () => {
    project = await createDummyProject({
      prefix: "cmux-team-agent-strategy-",
      subdirs: ["logs", "traces"],
    });
    db = initDB(project.root);
  });

  afterEach(async () => {
    try { db.close(); } catch {}
    await project.dispose();
  });

  test("空 → 空配列", () => {
    const rows = aggregateAgentStrategyByTask(db, {
      sinceIso: "2026-04-30T00:00:00.000Z",
      untilIso: "2026-05-01T00:00:00.000Z",
    });
    expect(rows).toEqual([]);
  });

  test("3 task × 役割異なる → 各 task に正しいラベル", () => {
    // T_solo: agent_spawned 行なし (task_sessions に assigned のみ)
    insertTaskSession(db, {
      timestamp: "2026-04-30T10:00:00.000Z",
      task_id: "T_solo",
      session_id: "s_solo",
      event: "assigned",
    });
    // T_plan_impl: planner + implementer
    for (let i = 0; i < 2; i++) {
      insertTaskSession(db, {
        timestamp: `2026-04-30T11:0${i}:00.000Z`,
        task_id: "T_plan_impl",
        session_id: `s_pi_${i}`,
        role: i === 0 ? "planner" : "implementer",
        event: "agent_spawned",
      });
    }
    // T_parallel: implementer × 3
    for (let i = 0; i < 3; i++) {
      insertTaskSession(db, {
        timestamp: `2026-04-30T12:0${i}:00.000Z`,
        task_id: "T_parallel",
        session_id: `s_p_${i}`,
        role: "implementer",
        event: "agent_spawned",
      });
    }
    const rows = aggregateAgentStrategyByTask(db, {
      sinceIso: "2026-04-30T00:00:00.000Z",
      untilIso: "2026-05-01T00:00:00.000Z",
    });
    // T_solo は agent_spawned が無いので結果に出てこない
    const labels = new Map(rows.map((r) => [r.task_id, r.label]));
    expect(labels.get("T_plan_impl")).toBe("plan-impl");
    expect(labels.get("T_parallel")).toBe("parallel-impl");
  });

  test("limit で絞れる + last_ts 降順", () => {
    for (let i = 0; i < 5; i++) {
      insertTaskSession(db, {
        timestamp: `2026-04-30T1${i}:00:00.000Z`,
        task_id: `T_${i}`,
        session_id: `s_${i}`,
        role: "implementer",
        event: "agent_spawned",
      });
    }
    const rows = aggregateAgentStrategyByTask(db, {
      sinceIso: "2026-04-30T00:00:00.000Z",
      untilIso: "2026-05-01T00:00:00.000Z",
      limit: 2,
    });
    expect(rows.length).toBe(2);
    // last_ts 降順: T_4 (14:00) → T_3 (13:00)
    expect(rows[0]?.task_id).toBe("T_4");
    expect(rows[1]?.task_id).toBe("T_3");
  });
});

describe("aggregateAgentSpawnTimeline (T414)", () => {
  let project: DummyProject;
  let db: Database;

  beforeEach(async () => {
    project = await createDummyProject({
      prefix: "cmux-team-spawn-timeline-",
      subdirs: ["logs", "traces"],
    });
    db = initDB(project.root);
  });

  afterEach(async () => {
    try { db.close(); } catch {}
    await project.dispose();
  });

  test("day bucket に役割 stack されて返る", () => {
    insertTaskSession(db, {
      timestamp: "2026-04-30T10:00:00.000Z",
      task_id: "T1",
      session_id: "s1",
      role: "planner",
      event: "agent_spawned",
    });
    insertTaskSession(db, {
      timestamp: "2026-04-30T11:00:00.000Z",
      task_id: "T1",
      session_id: "s2",
      role: "implementer",
      event: "agent_spawned",
    });
    insertTaskSession(db, {
      timestamp: "2026-05-01T10:00:00.000Z",
      task_id: "T2",
      session_id: "s3",
      role: "researcher",
      event: "agent_spawned",
    });
    const rows = aggregateAgentSpawnTimeline(db, {
      sinceIso: "2026-04-30T00:00:00.000Z",
      untilIso: "2026-05-01T23:59:59.999Z",
      groupBy: "day",
    });
    expect(rows.length).toBe(2);
    expect(rows[0]?.bucket).toBe("2026-04-30");
    expect(rows[0]?.counts.planner).toBe(1);
    expect(rows[0]?.counts.implementer).toBe(1);
    expect(rows[1]?.bucket).toBe("2026-05-01");
    expect(rows[1]?.counts.researcher).toBe(1);
  });
});

describe("getAgentStrategyForTask (T414)", () => {
  let project: DummyProject;
  let db: Database;

  beforeEach(async () => {
    project = await createDummyProject({
      prefix: "cmux-team-strategy-drill-",
      subdirs: ["logs", "traces"],
    });
    db = initDB(project.root);
  });

  afterEach(async () => {
    try { db.close(); } catch {}
    await project.dispose();
  });

  test("不在 task → null", async () => {
    const r = await getAgentStrategyForTask(
      db,
      join(project.root, ".team/logs/events.jsonl"),
      "T_NONE",
    );
    expect(r).toBeNull();
  });

  test("conductor + 2 agent → drill-down に conductor.surface / agents 配列が反映", async () => {
    insertTaskSession(db, {
      timestamp: "2026-04-30T10:00:00.000Z",
      task_id: "T100",
      session_id: "s_c",
      surface: "surface:200",
      role: "conductor",
      event: "assigned",
    });
    insertTaskSession(db, {
      timestamp: "2026-04-30T10:05:00.000Z",
      task_id: "T100",
      session_id: "s_a1",
      surface: "surface:201",
      role: "implementer",
      event: "agent_spawned",
    });
    insertTaskSession(db, {
      timestamp: "2026-04-30T10:10:00.000Z",
      task_id: "T100",
      session_id: "s_a2",
      surface: "surface:202",
      role: "reviewer",
      event: "agent_spawned",
    });

    const eventsFile = join(project.root, ".team/logs/events.jsonl");
    await writeFile(
      eventsFile,
      [
        JSON.stringify({ event: "task_assigned", ts: "2026-04-30T10:00:00.000Z", task_id: "T100" }),
        JSON.stringify({ event: "task_completed", ts: "2026-04-30T11:00:00.000Z", task_id: "T100" }),
      ].join("\n") + "\n",
    );

    const r = await getAgentStrategyForTask(db, eventsFile, "T100");
    expect(r).not.toBeNull();
    expect(r!.task_id).toBe("T100");
    expect(r!.conductor.surface).toBe("surface:200");
    expect(r!.conductor.outcome).toBe("completed");
    expect(r!.agents.length).toBe(2);
    expect(r!.agents[0]?.role).toBe("implementer");
    expect(r!.agents[0]?.surface).toBe("surface:201");
    expect(r!.agents[1]?.role).toBe("reviewer");
  });

  test("events.jsonl 不在 → outcome は open にフォールバック", async () => {
    insertTaskSession(db, {
      timestamp: "2026-04-30T10:00:00.000Z",
      task_id: "T200",
      session_id: "s_c",
      surface: "surface:300",
      role: "conductor",
      event: "assigned",
    });
    const r = await getAgentStrategyForTask(
      db,
      join(project.root, ".team/logs/events.jsonl"),
      "T200",
    );
    expect(r).not.toBeNull();
    expect(r!.conductor.outcome).toBe("open");
  });
});
