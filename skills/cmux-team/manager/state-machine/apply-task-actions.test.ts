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
