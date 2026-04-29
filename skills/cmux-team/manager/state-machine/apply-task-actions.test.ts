/**
 * T303: apply-task-actions.ts のユニットテスト。
 *
 * - log アクションが logger に書き込まれる
 * - cascade_children が cascadeAbortToChildrenInPlace を呼び state を in-place 更新する
 * - cascade 対象の各 childId に対して shadowObserveTask が呼ばれる (fsm_shadow_action log)
 * - 空 actions は no-op
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { applyTaskActions } from "./apply-task-actions";
import { __resetShadowState } from "./shadow";
import { createDummyProject, type DummyProject } from "../test-project";
import type { TaskStateMap } from "../task";
import type { TaskAction, TaskCtx } from "./events";

async function readLog(projectRoot: string): Promise<string> {
  const p = join(projectRoot, ".team/logs/manager.log");
  try {
    return await readFile(p, "utf-8");
  } catch {
    return "";
  }
}

async function readEvents(projectRoot: string): Promise<unknown[]> {
  const p = join(projectRoot, ".team/logs/events.jsonl");
  try {
    const c = await readFile(p, "utf-8");
    return c
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

async function seedTasksDir(
  projectRoot: string,
  defs: Array<{ id: string; title: string; status: string; dependsOn?: string[] }>,
): Promise<void> {
  const tasksDir = join(projectRoot, ".team/tasks");
  await mkdir(tasksDir, { recursive: true });
  for (const d of defs) {
    const dir = join(tasksDir, `${d.id}-${d.title}`);
    await mkdir(dir, { recursive: true });
    const depsLine =
      d.dependsOn && d.dependsOn.length > 0
        ? `depends_on: [${d.dependsOn.join(", ")}]\n`
        : "";
    const fm = `---\nid: ${d.id}\ntitle: ${d.title}\npriority: medium\n${depsLine}created_at: 2026-04-23T00:00:00Z\n---\n\n## Content\n`;
    await writeFile(join(dir, "task.md"), fm);
  }
}

describe("applyTaskActions — T303", () => {
  let project: DummyProject;

  beforeEach(async () => {
    project = await createDummyProject({ prefix: "apply-task-actions-" });
    __resetShadowState();
  });

  afterEach(async () => {
    await project.dispose();
  });

  test("empty actions array → no-op, returns revertedChildren=[]", async () => {
    const state: TaskStateMap = {};
    const result = await applyTaskActions([], {
      projectRoot: project.root,
      taskId: "001",
      state,
      childCtx: { hasConductor: false, parentAborted: true },
    });
    expect(result.revertedChildren).toEqual([]);
    expect(await readLog(project.root)).toBe("");
  });

  test("log action writes to logger.log", async () => {
    const actions: TaskAction[] = [
      { type: "log", event: "test_event", detail: "key=value" },
    ];
    await applyTaskActions(actions, {
      projectRoot: project.root,
      taskId: "001",
      state: {},
      childCtx: { hasConductor: false, parentAborted: false },
    });
    const logContent = await readLog(project.root);
    expect(logContent).toContain("test_event key=value");
  });

  test("log action without detail writes empty detail", async () => {
    const actions: TaskAction[] = [{ type: "log", event: "solo_event" }];
    await applyTaskActions(actions, {
      projectRoot: project.root,
      taskId: "001",
      state: {},
      childCtx: { hasConductor: false, parentAborted: false },
    });
    const logContent = await readLog(project.root);
    expect(logContent).toContain("solo_event");
  });

  test("cascade_children in-place mutates state and calls shadow for each child", async () => {
    await seedTasksDir(project.root, [
      { id: "001", title: "parent", status: "aborted" },
      { id: "002", title: "child-a", status: "ready", dependsOn: ["001"] },
      { id: "003", title: "child-b", status: "ready", dependsOn: ["001"] },
      { id: "004", title: "unrelated", status: "ready", dependsOn: [] },
    ]);

    const state: TaskStateMap = {
      "001": { status: "aborted" },
      "002": { status: "ready" },
      "003": { status: "ready" },
      "004": { status: "ready" },
    };

    const actions: TaskAction[] = [{ type: "cascade_children" }];
    const childCtx: TaskCtx = { hasConductor: false, parentAborted: true };

    const result = await applyTaskActions(actions, {
      projectRoot: project.root,
      taskId: "001",
      state,
      childCtx,
    });

    // in-place mutation 確認
    expect(state["002"]?.status).toBe("draft");
    expect(state["003"]?.status).toBe("draft");
    expect(state["004"]?.status).toBe("ready"); // 依存なしなので変更なし
    expect(result.revertedChildren.sort()).toEqual(["002", "003"]);

    // shadow observer が呼ばれた → fsm_shadow_action log が emit される
    const logContent = await readLog(project.root);
    // task_id=002 と task_id=003 の shadow action が記録されていること
    expect(logContent).toMatch(/scope=task task_id=002/);
    expect(logContent).toMatch(/scope=task task_id=003/);
  });

  test("cascade_children with no matching children returns empty revertedChildren", async () => {
    await seedTasksDir(project.root, [
      { id: "001", title: "parent", status: "aborted" },
      { id: "002", title: "standalone", status: "ready", dependsOn: [] },
    ]);

    const state: TaskStateMap = {
      "001": { status: "aborted" },
      "002": { status: "ready" },
    };

    const result = await applyTaskActions(
      [{ type: "cascade_children" }],
      {
        projectRoot: project.root,
        taskId: "001",
        state,
        childCtx: { hasConductor: false, parentAborted: true },
      },
    );
    expect(result.revertedChildren).toEqual([]);
    // state is untouched
    expect(state["002"]?.status).toBe("ready");
  });

  test("cascade_children skips children that are not in ready status", async () => {
    await seedTasksDir(project.root, [
      { id: "001", title: "parent", status: "aborted" },
      { id: "002", title: "child-draft", status: "draft", dependsOn: ["001"] },
      { id: "003", title: "child-ready", status: "ready", dependsOn: ["001"] },
    ]);

    const state: TaskStateMap = {
      "001": { status: "aborted" },
      "002": { status: "draft" },
      "003": { status: "ready" },
    };

    const result = await applyTaskActions(
      [{ type: "cascade_children" }],
      {
        projectRoot: project.root,
        taskId: "001",
        state,
        childCtx: { hasConductor: false, parentAborted: true },
      },
    );
    expect(result.revertedChildren).toEqual(["003"]);
    expect(state["002"]?.status).toBe("draft"); // unchanged
    expect(state["003"]?.status).toBe("draft"); // reverted
  });

  // ---- T358: events.jsonl emit -----------------------------------------

  test("T358: task_created log は events.jsonl に title 付きで emit される", async () => {
    await applyTaskActions(
      [{ type: "log", event: "task_created" }],
      {
        projectRoot: project.root,
        taskId: "T100",
        state: {},
        childCtx: { hasConductor: false, parentAborted: false },
        eventStream: { taskTitle: "hello world" },
      },
    );
    const events = (await readEvents(project.root)) as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("task_created");
    expect(events[0]?.task_id).toBe("T100");
    expect(events[0]?.title).toBe("hello world");
    expect(events[0]?.schema_version).toBe(2);
  });

  test("T358: task_ready log は events.jsonl に emit される", async () => {
    await applyTaskActions(
      [{ type: "log", event: "task_ready" }],
      {
        projectRoot: project.root,
        taskId: "T101",
        state: {},
        childCtx: { hasConductor: false, parentAborted: false },
      },
    );
    const events = (await readEvents(project.root)) as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("task_ready");
    expect(events[0]?.task_id).toBe("T101");
  });

  test("T358: task_assigned: eventStream を渡せば conductor_surface / task_run_id が emit される", async () => {
    await applyTaskActions(
      [{ type: "log", event: "task_assigned" }],
      {
        projectRoot: project.root,
        taskId: "T102",
        state: {},
        childCtx: { hasConductor: true, parentAborted: false },
        eventStream: {
          conductorSurface: "surface:5",
          taskRunId: "task-102-1700000000",
        },
      },
    );
    const events = (await readEvents(project.root)) as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0]?.conductor_surface).toBe("surface:5");
    expect(events[0]?.task_run_id).toBe("task-102-1700000000");
  });

  test("T358: task_assigned: eventStream を渡し忘れると events_writer_error が manager.log に出る", async () => {
    await applyTaskActions(
      [{ type: "log", event: "task_assigned" }],
      {
        projectRoot: project.root,
        taskId: "T103",
        state: {},
        childCtx: { hasConductor: true, parentAborted: false },
        // eventStream 渡し忘れ
      },
    );
    const events = await readEvents(project.root);
    expect(events).toHaveLength(0);
    const mlog = await readLog(project.root);
    expect(mlog).toContain("events_writer_error");
    expect(mlog).toContain("event=task_assigned");
    expect(mlog).toContain("task_id=T103");
  });

  test("T358: task_completed_state_mismatch: eventStream 全 field 付きで emit", async () => {
    await applyTaskActions(
      [{ type: "log", event: "task_completed_state_mismatch" }],
      {
        projectRoot: project.root,
        taskId: "T104",
        state: {},
        childCtx: { hasConductor: true, parentAborted: false },
        eventStream: {
          conductorSurface: "surface:6",
          worktreePath: "/tmp/wt",
          journalSummary: "auto-closed",
        },
      },
    );
    const events = (await readEvents(project.root)) as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("task_completed_state_mismatch");
    expect(events[0]?.reason).toBe("missing_close_task");
    expect(events[0]?.worktree_path).toBe("/tmp/wt");
    expect(events[0]?.journal_summary).toBe("auto-closed");
  });

  test("T358: task_completed_state_mismatch: eventStream 渡し忘れると events_writer_error", async () => {
    await applyTaskActions(
      [{ type: "log", event: "task_completed_state_mismatch" }],
      {
        projectRoot: project.root,
        taskId: "T105",
        state: {},
        childCtx: { hasConductor: true, parentAborted: false },
      },
    );
    const events = await readEvents(project.root);
    expect(events).toHaveLength(0);
    const mlog = await readLog(project.root);
    expect(mlog).toContain("events_writer_error");
    expect(mlog).toContain("event=task_completed_state_mismatch");
  });

  test("T358: task_reverted_to_ready: detail から reason 抽出", async () => {
    await applyTaskActions(
      [
        {
          type: "log",
          event: "task_reverted_to_ready",
          detail: "reason=worktree_missing",
        },
      ],
      {
        projectRoot: project.root,
        taskId: "T106",
        state: {},
        childCtx: { hasConductor: false, parentAborted: false },
      },
    );
    const events = (await readEvents(project.root)) as Array<Record<string, unknown>>;
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("task_reverted_to_ready");
    expect(events[0]?.reason).toBe("worktree_missing");
  });

  test("T358: allowlist 外の log action は events.jsonl に流れない", async () => {
    await applyTaskActions(
      [
        { type: "log", event: "task_aborted_core", detail: "reason=user_clear" },
        { type: "log", event: "task_closed" },
        { type: "log", event: "task_deleted" },
        { type: "log", event: "task_restarted" },
        { type: "log", event: "task_create_idempotent_skip" },
      ],
      {
        projectRoot: project.root,
        taskId: "T107",
        state: {},
        childCtx: { hasConductor: false, parentAborted: false },
      },
    );
    const events = await readEvents(project.root);
    expect(events).toHaveLength(0);
    const mlog = await readLog(project.root);
    expect(mlog).toContain("task_aborted_core");
    expect(mlog).toContain("task_closed");
  });

  test("mixed actions: log + cascade_children", async () => {
    await seedTasksDir(project.root, [
      { id: "001", title: "parent", status: "aborted" },
      { id: "002", title: "child", status: "ready", dependsOn: ["001"] },
    ]);
    const state: TaskStateMap = {
      "001": { status: "aborted" },
      "002": { status: "ready" },
    };

    const result = await applyTaskActions(
      [
        { type: "log", event: "task_aborted_core", detail: "reason=user_clear" },
        { type: "cascade_children" },
      ],
      {
        projectRoot: project.root,
        taskId: "001",
        state,
        childCtx: { hasConductor: false, parentAborted: true },
      },
    );
    expect(result.revertedChildren).toEqual(["002"]);
    expect(state["002"]?.status).toBe("draft");

    const logContent = await readLog(project.root);
    expect(logContent).toContain("task_aborted_core reason=user_clear");
  });
});
