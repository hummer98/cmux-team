/**
 * T303: task-state-store.ts のユニットテスト。
 *
 * R13 反映のテスト一式:
 *   - reducer noop → committed=false、saveTaskState 未呼出
 *   - 遷移 → committed=true、save + shadow + notifyStateChanged 各 1 回
 *   - mutex 直列化 (ASSIGN_OK × 2 並行): 片方 committed=true、もう片方 noop
 *   - mutex 直列化 (ABORT + ASSIGN_OK 並行)
 *   - patch merge / remove の両対応
 *   - cascade_children で子 shadow 呼出
 *   - CREATE idempotent skip / 新規成功
 *   - notifyStateChanged source 文字列フォーマット
 *   - updateTaskSessionId 3 段 guard
 *   - T302 ガード相当 (ASSIGN_OK が terminal で noop)
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import {
  applyTaskEvent,
  updateTaskSessionId,
  __resetTaskStateLockForTest,
} from "./task-state-store";
import { __resetShadowState } from "./shadow";
import { __resetBusForTest, onStateChanged } from "../eventBus";
import { createDummyProject, type DummyProject } from "../test-project";
import type { TaskStateMap } from "../task";

async function readLog(projectRoot: string): Promise<string> {
  const p = join(projectRoot, ".team/logs/manager.log");
  try {
    return await readFile(p, "utf-8");
  } catch {
    return "";
  }
}

async function readState(projectRoot: string): Promise<TaskStateMap> {
  const p = join(projectRoot, ".team/task-state.json");
  try {
    return JSON.parse(await readFile(p, "utf-8"));
  } catch {
    return {};
  }
}

async function writeState(
  projectRoot: string,
  state: TaskStateMap,
): Promise<void> {
  const p = join(projectRoot, ".team/task-state.json");
  await writeFile(p, JSON.stringify(state, null, 2));
}

async function seedTasksDir(
  projectRoot: string,
  defs: Array<{ id: string; title: string; dependsOn?: string[] }>,
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
    await writeFile(
      join(dir, "task.md"),
      `---\nid: ${d.id}\ntitle: ${d.title}\npriority: medium\n${depsLine}created_at: 2026-04-23T00:00:00Z\n---\n\n## Content\n`,
    );
  }
}

describe("task-state-store — applyTaskEvent (T303)", () => {
  let project: DummyProject;

  beforeEach(async () => {
    project = await createDummyProject({ prefix: "task-state-store-" });
    __resetShadowState();
    __resetBusForTest();
    __resetTaskStateLockForTest();
  });

  afterEach(async () => {
    await project.dispose();
  });

  // ---- reducer noop → committed=false ----------------------------------
  test("reducer noop: ASSIGN_OK on closed → committed=false, state unchanged", async () => {
    await writeState(project.root, { "001": { status: "closed" } });
    const initialState = await readState(project.root);

    const result = await applyTaskEvent(project.root, {
      taskId: "001",
      event: { type: "ASSIGN_OK" },
      ctx: { hasConductor: true },
    });
    expect(result.committed).toBe(false);
    expect(result.prev).toBe("closed");
    expect(result.next).toBe("closed");

    const after = await readState(project.root);
    expect(after).toEqual(initialState);
  });

  test("reducer noop on aborted: ASSIGN_OK noop (T302 guard 相当)", async () => {
    await writeState(project.root, { "001": { status: "aborted" } });
    const result = await applyTaskEvent(project.root, {
      taskId: "001",
      event: { type: "ASSIGN_OK" },
    });
    expect(result.committed).toBe(false);
    expect(result.prev).toBe("aborted");
  });

  test("reducer noop on deleted: ASSIGN_OK noop", async () => {
    await writeState(project.root, { "001": { status: "deleted" } });
    const result = await applyTaskEvent(project.root, {
      taskId: "001",
      event: { type: "ASSIGN_OK" },
    });
    expect(result.committed).toBe(false);
    expect(result.prev).toBe("deleted");
  });

  // ---- 遷移成功: save + shadow + notifyStateChanged --------------------
  test("ready + ASSIGN_OK → assigned: commit, save, shadow, notify", async () => {
    await writeState(project.root, { "001": { status: "ready" } });

    let notifyCount = 0;
    onStateChanged(() => {
      notifyCount++;
    });

    const result = await applyTaskEvent(project.root, {
      taskId: "001",
      event: { type: "ASSIGN_OK" },
      ctx: { hasConductor: true },
      patch: (_prev, next) => ({
        merge: next === "assigned" ? { assignedAt: "2026-04-23T10:00:00Z" } : {},
      }),
    });
    expect(result.committed).toBe(true);
    expect(result.prev).toBe("ready");
    expect(result.next).toBe("assigned");

    const after = await readState(project.root);
    expect(after["001"]?.status).toBe("assigned");
    expect(after["001"]?.assignedAt).toBe("2026-04-23T10:00:00Z");

    // notifyStateChanged 1 回
    expect(notifyCount).toBe(1);

    // shadow action log 確認
    const logContent = await readLog(project.root);
    expect(logContent).toMatch(/scope=task task_id=001/);
  });

  // ---- patch remove ---------------------------------------------------
  test("RESTART with patch remove: field deletion reflected on-disk", async () => {
    await writeState(project.root, {
      "001": {
        status: "aborted",
        assignedAt: "2026-04-01T00:00:00Z",
        abortedAt: "2026-04-02T00:00:00Z",
        worktreePath: "/tmp/wt",
        taskRunId: "task-001-1234",
        conductorSlot: "surface:5",
        sessionId: "sess-abc",
      },
    });

    const result = await applyTaskEvent(project.root, {
      taskId: "001",
      event: { type: "RESTART" },
      patch: (_prev, next) =>
        next === "ready"
          ? {
              merge: { journal: "[restart] test" },
              remove: [
                "assignedAt",
                "abortedAt",
                "worktreePath",
                "taskRunId",
                "conductorSlot",
                "sessionId",
              ],
            }
          : {},
    });
    expect(result.committed).toBe(true);

    const after = await readState(project.root);
    expect(after["001"]?.status).toBe("ready");
    expect(after["001"]?.journal).toBe("[restart] test");
    expect(after["001"]?.assignedAt).toBeUndefined();
    expect(after["001"]?.abortedAt).toBeUndefined();
    expect(after["001"]?.worktreePath).toBeUndefined();
    expect(after["001"]?.taskRunId).toBeUndefined();
    expect(after["001"]?.conductorSlot).toBeUndefined();
    expect(after["001"]?.sessionId).toBeUndefined();
  });

  // ---- cascade_children ---------------------------------------------
  test("ABORT triggers cascade_children + shadow for each child", async () => {
    await seedTasksDir(project.root, [
      { id: "001", title: "parent" },
      { id: "002", title: "child-a", dependsOn: ["001"] },
      { id: "003", title: "child-b", dependsOn: ["001"] },
    ]);
    await writeState(project.root, {
      "001": { status: "assigned" },
      "002": { status: "ready" },
      "003": { status: "ready" },
    });

    const result = await applyTaskEvent(project.root, {
      taskId: "001",
      event: { type: "ABORT", reason: "user_clear" },
      patch: (_prev, next) =>
        next === "aborted"
          ? {
              merge: {
                abortedAt: "2026-04-23T11:00:00Z",
                journal: "reason=user_clear;",
              },
            }
          : {},
    });
    expect(result.committed).toBe(true);
    expect(result.revertedChildren.sort()).toEqual(["002", "003"]);

    const after = await readState(project.root);
    expect(after["001"]?.status).toBe("aborted");
    expect(after["001"]?.abortedAt).toBe("2026-04-23T11:00:00Z");
    expect(after["002"]?.status).toBe("draft");
    expect(after["003"]?.status).toBe("draft");
  });

  // ---- CREATE idempotent / 新規 -------------------------------------
  test("CREATE new entry with initialStatus=ready → committed=true + saved", async () => {
    const result = await applyTaskEvent(project.root, {
      taskId: "010",
      event: { type: "CREATE" },
      ctx: { initialStatus: "ready" },
    });
    expect(result.committed).toBe(true);
    expect(result.prev).toBeUndefined();
    expect(result.next).toBe("ready");

    const after = await readState(project.root);
    expect(after["010"]?.status).toBe("ready");
  });

  test("CREATE new entry with initialStatus=draft (default) → draft", async () => {
    const result = await applyTaskEvent(project.root, {
      taskId: "011",
      event: { type: "CREATE" },
    });
    expect(result.committed).toBe(true);
    expect(result.next).toBe("draft");

    const after = await readState(project.root);
    expect(after["011"]?.status).toBe("draft");
  });

  test("CREATE existing entry → idempotent skip + task_create_idempotent_skip log", async () => {
    await writeState(project.root, { "020": { status: "assigned" } });
    const initialState = await readState(project.root);

    const result = await applyTaskEvent(project.root, {
      taskId: "020",
      event: { type: "CREATE" },
      ctx: { initialStatus: "ready" },
    });
    expect(result.committed).toBe(false);
    expect(result.prev).toBe("assigned");
    expect(result.next).toBe("assigned");

    const after = await readState(project.root);
    expect(after).toEqual(initialState);

    const logContent = await readLog(project.root);
    expect(logContent).toMatch(/task_create_idempotent_skip task_id=020 existing_status=assigned/);
  });

  // ---- notifyStateChanged fires once per commit ----------------------
  test("notifyStateChanged fires once per successful commit", async () => {
    await writeState(project.root, { "030": { status: "ready" } });
    let fireCount = 0;
    onStateChanged(() => {
      fireCount++;
    });
    await applyTaskEvent(project.root, {
      taskId: "030",
      event: { type: "ASSIGN_OK" },
      ctx: { hasConductor: true },
    });
    expect(fireCount).toBe(1);
  });

  test("notifyStateChanged does NOT fire on reducer noop", async () => {
    await writeState(project.root, { "031": { status: "closed" } });
    let fireCount = 0;
    onStateChanged(() => {
      fireCount++;
    });
    await applyTaskEvent(project.root, {
      taskId: "031",
      event: { type: "ASSIGN_OK" },
    });
    expect(fireCount).toBe(0);
  });

  // ---- Mutex 直列化 --------------------------------------------------
  test("mutex serializes concurrent ASSIGN_OK: one commits, other noops", async () => {
    await writeState(project.root, { "040": { status: "ready" } });

    const [a, b] = await Promise.all([
      applyTaskEvent(project.root, {
        taskId: "040",
        event: { type: "ASSIGN_OK" },
        ctx: { hasConductor: true },
      }),
      applyTaskEvent(project.root, {
        taskId: "040",
        event: { type: "ASSIGN_OK" },
        ctx: { hasConductor: true },
      }),
    ]);

    const committedCount = [a, b].filter((r) => r.committed).length;
    const noopCount = [a, b].filter((r) => !r.committed).length;
    expect(committedCount).toBe(1);
    expect(noopCount).toBe(1);

    // noop 側は prev=assigned, next=assigned (2 回目の load 時は 1 回目の save 後の state を見る)
    const noop = a.committed ? b : a;
    expect(noop.prev).toBe("assigned");
    expect(noop.next).toBe("assigned");

    const after = await readState(project.root);
    expect(after["040"]?.status).toBe("assigned");
  });

  test("mutex serializes ABORT + ASSIGN_OK: ABORT first → ASSIGN noop", async () => {
    await writeState(project.root, { "041": { status: "ready" } });

    // ABORT を先に投入 → ASSIGN_OK が後回し
    const [abortR, assignR] = await Promise.all([
      applyTaskEvent(project.root, {
        taskId: "041",
        event: { type: "ABORT", reason: "user_clear" },
      }),
      applyTaskEvent(project.root, {
        taskId: "041",
        event: { type: "ASSIGN_OK" },
        ctx: { hasConductor: true },
      }),
    ]);

    // ABORT が先勝ちすれば ASSIGN は noop (prev=aborted)
    // 発行順序がFIFOならabortが先、その後assignはaborted→noopのはず
    expect(abortR.committed).toBe(true);
    expect(abortR.next).toBe("aborted");
    expect(assignR.committed).toBe(false);
    expect(assignR.prev).toBe("aborted");
    expect(assignR.next).toBe("aborted");

    const after = await readState(project.root);
    expect(after["041"]?.status).toBe("aborted");
  });

  // ---- REVERT_TO_READY -------------------------------------------
  test("REVERT_TO_READY on assigned → ready + task_reverted_to_ready log", async () => {
    await writeState(project.root, {
      "050": {
        status: "assigned",
        assignedAt: "2026-04-23T10:00:00Z",
        worktreePath: "/tmp/wt",
      },
    });

    const result = await applyTaskEvent(project.root, {
      taskId: "050",
      event: { type: "REVERT_TO_READY", reason: "launch_failed" },
    });
    expect(result.committed).toBe(true);
    expect(result.next).toBe("ready");

    const after = await readState(project.root);
    expect(after["050"]?.status).toBe("ready");

    const logContent = await readLog(project.root);
    expect(logContent).toMatch(
      /task_reverted_to_ready reason=launch_failed/,
    );
  });

  test("REVERT_TO_READY on ready → noop", async () => {
    await writeState(project.root, { "051": { status: "ready" } });
    const result = await applyTaskEvent(project.root, {
      taskId: "051",
      event: { type: "REVERT_TO_READY", reason: "unmatched" },
    });
    expect(result.committed).toBe(false);
    expect(result.prev).toBe("ready");
  });

  // ---- CLOSE autoClosed ------------------------------------------
  test("CLOSE autoClosed=true → task_completed_state_mismatch log", async () => {
    await writeState(project.root, { "060": { status: "assigned" } });
    await applyTaskEvent(project.root, {
      taskId: "060",
      event: { type: "CLOSE", autoClosed: true },
      patch: (_prev, next) =>
        next === "closed"
          ? {
              merge: {
                closedAt: "2026-04-23T12:00:00Z",
                journal: "auto_closed_by_daemon",
                deliverable: { kind: "none" },
              },
            }
          : {},
    });
    const after = await readState(project.root);
    expect(after["060"]?.status).toBe("closed");
    expect(after["060"]?.deliverable?.kind).toBe("none");

    const logContent = await readLog(project.root);
    expect(logContent).toMatch(/task_completed_state_mismatch/);
  });
});

describe("task-state-store — updateTaskSessionId (T303 R3)", () => {
  let project: DummyProject;

  beforeEach(async () => {
    project = await createDummyProject({ prefix: "update-session-" });
    __resetShadowState();
    __resetBusForTest();
    __resetTaskStateLockForTest();
  });

  afterEach(async () => {
    await project.dispose();
  });

  test("no entry → written=false, reason=no_entry", async () => {
    const r = await updateTaskSessionId(project.root, "001", "sess-x", "tr-1");
    expect(r.written).toBe(false);
    expect(r.reason).toBe("no_entry");
  });

  test("taskRunId mismatch → skip", async () => {
    await writeState(project.root, {
      "001": { status: "assigned", taskRunId: "tr-old" },
    });
    const r = await updateTaskSessionId(project.root, "001", "sess-x", "tr-new");
    expect(r.written).toBe(false);
    expect(r.reason).toBe("taskrun_mismatch");

    const after = await readState(project.root);
    expect(after["001"]?.sessionId).toBeUndefined();
  });

  test("not assigned (ready) → silent skip", async () => {
    await writeState(project.root, { "001": { status: "ready" } });
    const r = await updateTaskSessionId(project.root, "001", "sess-x", undefined);
    expect(r.written).toBe(false);
    expect(r.reason).toBe("not_assigned");
  });

  test("assigned + sessionId diff → write", async () => {
    await writeState(project.root, {
      "001": { status: "assigned", taskRunId: "tr-1", sessionId: "old" },
    });
    const r = await updateTaskSessionId(project.root, "001", "new", "tr-1");
    expect(r.written).toBe(true);

    const after = await readState(project.root);
    expect(after["001"]?.sessionId).toBe("new");
    expect(after["001"]?.status).toBe("assigned");
  });

  test("assigned + sessionId unchanged → silent skip", async () => {
    await writeState(project.root, {
      "001": { status: "assigned", taskRunId: "tr-1", sessionId: "same" },
    });
    const r = await updateTaskSessionId(project.root, "001", "same", "tr-1");
    expect(r.written).toBe(false);
    expect(r.reason).toBe("unchanged");
  });

  test("assigned + no taskRunId on entry → write (no mismatch check)", async () => {
    await writeState(project.root, {
      "001": { status: "assigned", sessionId: "old" },
    });
    const r = await updateTaskSessionId(project.root, "001", "new", "tr-1");
    expect(r.written).toBe(true);
  });
});
