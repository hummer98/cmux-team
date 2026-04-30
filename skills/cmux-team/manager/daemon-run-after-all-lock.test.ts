/**
 * T398: scanTasks の run_after_all lock guard テスト
 *
 * `runAfterAll: true && !exclusive` のタスクが assigned の間、
 * normal タスク（executable）の新規 dispatch を停止する guard を検証する。
 * 他の RAA タスクとは並走可能な semantics を維持していることも確認する。
 *
 * 既存 `daemon.test.ts` から `createTask` をエクスポートする代わりに、
 * 新ファイルに必要最小限の helper を直接コピーする方針（循環依存・export 拡大を避ける）。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFile, readFile } from "fs/promises";
import { join } from "path";
import { createDummyProject, type DummyProject } from "./test-project";
import { scanTasks, createDaemon } from "./daemon";
import type { ConductorState } from "./schema";

let project: DummyProject;
let testDir: string;

beforeEach(async () => {
  project = await createDummyProject({
    prefix: "cmux-daemon-raa-lock-",
    subdirs: ["tasks", "output", "prompts", "logs"],
  });
  testDir = project.root;
  await writeFile(
    join(testDir, ".team/team.json"),
    JSON.stringify({ phase: "init", master: {}, manager: {}, conductors: [] }),
  );
});

afterEach(async () => {
  await project.dispose();
});

// ---- helpers (daemon.test.ts の createTask / closeTask を runAfterAll/exclusive 対応に拡張したコピー) ----

async function createTask(
  id: string,
  slug: string,
  opts: {
    status?: string;
    priority?: string;
    dependsOn?: string[];
    content?: string;
    createdAt?: string;
    runAfterAll?: boolean;
    exclusive?: boolean;
  } = {},
): Promise<void> {
  const {
    status = "ready",
    priority = "medium",
    dependsOn,
    content = "テストタスク",
    createdAt = new Date().toISOString(),
  } = opts;

  let yaml = `---
id: ${id}
title: ${slug}
priority: ${priority}
created_at: ${createdAt}`;

  if (dependsOn?.length) {
    yaml += `\ndepends_on: [${dependsOn.join(", ")}]`;
  }
  if (opts.runAfterAll) {
    yaml += `\nrun_after_all: true`;
  }
  if (opts.exclusive) {
    yaml += `\nexclusive: true`;
  }

  yaml += `\n---\n\n## タスク\n${content}\n`;

  await writeFile(
    join(testDir, `.team/tasks/${id.padStart(3, "0")}-${slug}.md`),
    yaml,
  );

  const { saveTaskState, loadTaskState } = await import("./task");
  const taskState = await loadTaskState(testDir);
  taskState[id] = { status };
  await saveTaskState(testDir, taskState);
}

/**
 * task-state.json の status を直接書き換える（draft → ready の cross-process race 模擬）
 */
async function setTaskStatus(id: string, status: string): Promise<void> {
  const { saveTaskState, loadTaskState } = await import("./task");
  const taskState = await loadTaskState(testDir);
  const prev = taskState[id] ?? {};
  taskState[id] = { ...prev, status };
  await saveTaskState(testDir, taskState);
}

function makeConductor(
  surface: string,
  opts: { status?: ConductorState["status"]; taskId?: string } = {},
): ConductorState {
  return {
    surface,
    startedAt: new Date().toISOString(),
    agents: [],
    status: opts.status ?? "idle",
    taskId: opts.taskId,
  };
}

async function readManagerLog(): Promise<string> {
  try {
    return await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
  } catch {
    return "";
  }
}

// ---- TC1〜TC5 ----

describe("scanTasks: run_after_all lock guard (T398)", () => {
  test("TC1: RAA assigned 中、新規 ready 化された normal は dispatch されない", async () => {
    // RAA タスク R を assigned 状態でセット
    await createTask("301", "raa-task", { runAfterAll: true, status: "assigned" });
    // normal タスク N（dispatch 候補）
    await createTask("302", "normal-task", { status: "ready" });

    const state = await createDaemon(testDir);
    state.mainBranch = "main";

    // R の所有者 conductor（running）+ idle conductor を 1 つ用意
    const owner = makeConductor("surface:301", { status: "running", taskId: "301" });
    const idle = makeConductor("surface:idle1", { status: "idle" });
    state.conductors.set(owner.surface, owner);
    state.conductors.set(idle.surface, idle);

    await scanTasks(state);

    // guard が効いていること:
    // - normal task N は ready のまま
    // - idle Conductor は idle のまま
    // - manager.log に run_after_all_lock_active が出る
    const { loadTaskState } = await import("./task");
    const ts = await loadTaskState(testDir);
    expect(ts["302"]?.status).toBe("ready");
    expect(idle.status).toBe("idle");

    const log = await readManagerLog();
    expect(log).toMatch(/run_after_all_lock_active.*task_ids=301.*pending_normal=1/);
    // exclusive guard は誤発火しない
    expect(log).not.toMatch(/exclusive_lock_active/);
  });

  test("TC2: RAA assigned 中でも、他の ready RAA は dispatch される（並走可）", async () => {
    // R1 assigned、R2 ready、normal タスクは無し
    await createTask("311", "raa-running", { runAfterAll: true, status: "assigned" });
    await createTask("312", "raa-ready", { runAfterAll: true, status: "ready" });

    const state = await createDaemon(testDir);
    state.mainBranch = "main";

    const owner = makeConductor("surface:311", { status: "running", taskId: "311" });
    const idle = makeConductor("surface:idle2", { status: "idle" });
    state.conductors.set(owner.surface, owner);
    state.conductors.set(idle.surface, idle);

    await scanTasks(state);

    // executable.length = 0 → guard は skip
    // dispatchTargets = allExecutable = [R2] → idle conductor が R2 に dispatch を試みる
    // git 未初期化なので assignTask は失敗 → R2 は aborted（task kind 失敗）
    // 重要なのは「dispatch が試行されたこと」「guard log が出ていないこと」
    const { loadTaskState } = await import("./task");
    const ts = await loadTaskState(testDir);
    // R2 は ready ではなくなっている（aborted or assigned）
    expect(ts["312"]?.status).not.toBe("ready");

    const log = await readManagerLog();
    expect(log).not.toMatch(/run_after_all_lock_active/);
    expect(log).not.toMatch(/exclusive_lock_active/);
  });

  test("TC3: T397 + T398 — RAA assigned 中、draft が ready 化された後も並走しない", async () => {
    // RAA R assigned、normal N (dependsOn: ["X"]) ready、X は draft
    await createTask("321", "raa-running", { runAfterAll: true, status: "assigned" });
    await createTask("322", "x-draft", { status: "draft" });
    await createTask("323", "n-blocked", { status: "ready", dependsOn: ["322"] });

    const state = await createDaemon(testDir);
    state.mainBranch = "main";

    const owner = makeConductor("surface:321", { status: "running", taskId: "321" });
    const idle = makeConductor("surface:idle3", { status: "idle" });
    state.conductors.set(owner.surface, owner);
    state.conductors.set(idle.surface, idle);

    // 1 回目: N は dep 未解決で executable=0、guard skip。X は draft なので何も dispatch されない。
    await scanTasks(state);
    {
      const { loadTaskState } = await import("./task");
      const ts = await loadTaskState(testDir);
      expect(ts["322"]?.status).toBe("draft");
      expect(ts["323"]?.status).toBe("ready");
      expect(idle.status).toBe("idle");
      const log = await readManagerLog();
      expect(log).not.toMatch(/run_after_all_lock_active/);
    }

    // X を ready 化（cross-process で task-state を書き換える模擬）
    await setTaskStatus("322", "ready");

    // 2 回目: X が executable になる。RAA R が assigned なので guard が立ち、
    // X (normal) は dispatch されない。
    await scanTasks(state);
    {
      const { loadTaskState } = await import("./task");
      const ts = await loadTaskState(testDir);
      // X は ready のまま、idle conductor も idle のまま
      expect(ts["322"]?.status).toBe("ready");
      expect(idle.status).toBe("idle");
      // R は依然 assigned
      expect(ts["321"]?.status).toBe("assigned");
      const log = await readManagerLog();
      expect(log).toMatch(/run_after_all_lock_active.*task_ids=321.*pending_normal=1/);
    }
  });

  test("TC4: --exclusive の単独実行 semantics は変わらない (regression)", async () => {
    // exclusive E assigned、normal N ready、RAA R ready、idle conductor 1
    await createTask("331", "exclusive", {
      runAfterAll: true,
      exclusive: true,
      status: "assigned",
    });
    await createTask("332", "normal", { status: "ready" });
    await createTask("333", "raa-ready", { runAfterAll: true, status: "ready" });

    const state = await createDaemon(testDir);
    state.mainBranch = "main";

    const owner = makeConductor("surface:331", { status: "running", taskId: "331" });
    const idle = makeConductor("surface:idle4", { status: "idle" });
    state.conductors.set(owner.surface, owner);
    state.conductors.set(idle.surface, idle);

    await scanTasks(state);

    // exclusive guard が先に return → N も R も ready のまま、idle は idle のまま
    const { loadTaskState } = await import("./task");
    const ts = await loadTaskState(testDir);
    expect(ts["331"]?.status).toBe("assigned");
    expect(ts["332"]?.status).toBe("ready");
    expect(ts["333"]?.status).toBe("ready");
    expect(idle.status).toBe("idle");

    const log = await readManagerLog();
    expect(log).toMatch(/exclusive_lock_active.*task_ids=331/);
    // 新 guard は誤発火しない（exclusive guard で先に return）
    expect(log).not.toMatch(/run_after_all_lock_active/);
  });

  test("TC5: RAA assigned 中、ready タスクが無ければ何も起きない (no-op regression)", async () => {
    await createTask("341", "raa-running", { runAfterAll: true, status: "assigned" });

    const state = await createDaemon(testDir);
    state.mainBranch = "main";

    const owner = makeConductor("surface:341", { status: "running", taskId: "341" });
    const idle = makeConductor("surface:idle5", { status: "idle" });
    state.conductors.set(owner.surface, owner);
    state.conductors.set(idle.surface, idle);

    await scanTasks(state);

    const { loadTaskState } = await import("./task");
    const ts = await loadTaskState(testDir);
    expect(ts["341"]?.status).toBe("assigned");
    expect(idle.status).toBe("idle");

    const log = await readManagerLog();
    // executable=0 で guard は skip される → log は出ない
    expect(log).not.toMatch(/run_after_all_lock_active/);
    expect(log).not.toMatch(/exclusive_lock_active/);
  });
});
