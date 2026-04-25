import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, writeFile, readdir, readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { createDummyProject, type DummyProject } from "./test-project";

// テスト用の一時ディレクトリ
let project: DummyProject;
let testDir: string;

beforeEach(async () => {
  project = await createDummyProject({
    prefix: "cmux-daemon-test-",
    subdirs: ["tasks", "output", "prompts", "logs"],
  });
  testDir = project.root;
  // team.json は旧 shape（master:{}, manager:{}）を期待するテストがあるため独自 seed
  await writeFile(
    join(testDir, ".team/team.json"),
    JSON.stringify({ phase: "init", master: {}, manager: {}, conductors: [] })
  );
});

afterEach(async () => {
  await project.dispose();
});

// ヘルパー: タスクファイルを作成
async function createTask(
  id: string,
  slug: string,
  opts: {
    status?: string;
    priority?: string;
    dependsOn?: string[];
    content?: string;
    createdAt?: string;
  } = {}
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

  yaml += `\n---\n\n## タスク\n${content}\n`;

  await writeFile(
    join(testDir, `.team/tasks/${id.padStart(3, "0")}-${slug}.md`),
    yaml
  );

  // task-state.json に状態を書き込む
  const { saveTaskState, loadTaskState } = await import("./task");
  const taskState = await loadTaskState(testDir);
  taskState[id] = { status };
  await saveTaskState(testDir, taskState);
}

// ヘルパー: タスクを closed にする（task-state.json を更新）
async function closeTask(id: string): Promise<void> {
  const { saveTaskState, loadTaskState } = await import("./task");
  const taskState = await loadTaskState(testDir);
  taskState[id] = { status: "closed", closedAt: new Date().toISOString() };
  await saveTaskState(testDir, taskState);
}


// --- task.ts の統合テスト（ファイルシステム経由）---

import { loadTasks, filterExecutableTasks, sortByPriority, sortOpenTasksForDisplay } from "./task";
import type { TaskMeta, TaskStateMap } from "./task";

// ヘルパー: loadTasks の結果から open タスクと closed ID セットを導出
function deriveOpenClosed(result: { tasks: TaskMeta[]; taskState: TaskStateMap }) {
  const closed = new Set(
    Object.entries(result.taskState)
      .filter(([_, s]) => s.status === "closed")
      .map(([id]) => id)
  );
  const open = result.tasks.filter(t => t.status !== "closed");
  return { open, closed };
}

describe("タスク依存解決（ファイルシステム統合）", () => {
  test("UC1: 連鎖依存 A→B→C の段階的実行", async () => {
    await createTask("1", "research", { priority: "high" });
    await createTask("2", "design", { dependsOn: ["1"] });
    await createTask("3", "implement", { dependsOn: ["2"] });

    // Phase 1: A のみ実行可能
    let { open, closed } = deriveOpenClosed(await loadTasks(testDir));
    let executable = filterExecutableTasks(open, closed, new Set());
    expect(executable.map((t) => t.id)).toEqual(["1"]);

    // A 完了
    await closeTask("1");

    // Phase 2: B が実行可能
    ({ open, closed } = deriveOpenClosed(await loadTasks(testDir)));
    executable = filterExecutableTasks(open, closed, new Set());
    expect(executable.map((t) => t.id)).toEqual(["2"]);

    // B 完了
    await closeTask("2");

    // Phase 3: C が実行可能
    ({ open, closed } = deriveOpenClosed(await loadTasks(testDir)));
    executable = filterExecutableTasks(open, closed, new Set());
    expect(executable.map((t) => t.id)).toEqual(["3"]);
  });

  test("UC2: 並列調査 → 統合（fan-out / fan-in）", async () => {
    await createTask("10", "research-api");
    await createTask("11", "research-db");
    await createTask("12", "research-auth");
    await createTask("13", "consolidate-report", { dependsOn: ["10", "11", "12"] });

    // Phase 1: 3 つの調査が並列実行可能
    let { open, closed } = deriveOpenClosed(await loadTasks(testDir));
    let executable = sortByPriority(filterExecutableTasks(open, closed, new Set()));
    expect(executable.map((t) => t.id).sort()).toEqual(["10", "11", "12"]);

    // 10, 11 完了、12 実行中
    await closeTask("10");
    await closeTask("11");

    ({ open, closed } = deriveOpenClosed(await loadTasks(testDir)));
    executable = filterExecutableTasks(open, closed, new Set(["12"]));
    // 統合はまだ不可（12 が未完了）
    expect(executable.map((t) => t.id)).toEqual([]);

    // 12 完了
    await closeTask("12");

    ({ open, closed } = deriveOpenClosed(await loadTasks(testDir)));
    executable = filterExecutableTasks(open, closed, new Set());
    expect(executable.map((t) => t.id)).toEqual(["13"]);
  });

  test("UC3: 実装タスク稼働中に新規タスク割り込み", async () => {
    await createTask("20", "implement-feature", { priority: "medium" });

    // 実装タスクがアサイン済み
    let { open, closed } = deriveOpenClosed(await loadTasks(testDir));
    let executable = filterExecutableTasks(open, closed, new Set(["20"]));
    expect(executable).toHaveLength(0);

    // 新規タスクが追加される
    await createTask("99999", "cleanup", { priority: "medium" });

    ({ open, closed } = deriveOpenClosed(await loadTasks(testDir)));
    executable = filterExecutableTasks(open, closed, new Set(["20"]));
    expect(executable.map((t) => t.id)).toEqual(["99999"]);
  });

  test("max_conductors による制限", async () => {
    await createTask("1", "task-a", { priority: "high" });
    await createTask("2", "task-b", { priority: "high" });
    await createTask("3", "task-c", { priority: "medium" });
    await createTask("4", "task-d", { priority: "medium" });
    await createTask("5", "task-e", { priority: "low" });

    const { open, closed } = deriveOpenClosed(await loadTasks(testDir));
    const executable = sortByPriority(
      filterExecutableTasks(open, closed, new Set())
    );

    // 全 5 タスクが実行可能
    expect(executable).toHaveLength(5);

    // max_conductors=3 の場合、上位 3 つを取得
    const toSpawn = executable.slice(0, 3);
    // high が先、medium が次。同一優先度内の順序は不定
    expect(toSpawn.filter((t) => t.priority === "high")).toHaveLength(2);
    expect(toSpawn.filter((t) => t.priority === "medium")).toHaveLength(1);
  });

  test("draft タスクは実行されない", async () => {
    await createTask("1", "draft-task", { status: "draft" });
    await createTask("2", "ready-task", { status: "ready" });

    const { open, closed } = deriveOpenClosed(await loadTasks(testDir));
    const executable = filterExecutableTasks(open, closed, new Set());
    expect(executable.map((t) => t.id)).toEqual(["2"]);
  });

  test("優先度ソート: high が先に実行される", async () => {
    await createTask("1", "low-priority", { priority: "low" });
    await createTask("2", "high-priority", { priority: "high" });
    await createTask("3", "medium-priority", { priority: "medium" });

    const { open, closed } = deriveOpenClosed(await loadTasks(testDir));
    const executable = sortByPriority(
      filterExecutableTasks(open, closed, new Set())
    );
    expect(executable.map((t) => t.id)).toEqual(["2", "3", "1"]);
  });
});


// --- taskList の並び順テスト ---

describe("taskList の並び順", () => {
  test("open タスクは createdAt 降順で並ぶ", async () => {
    await createTask("1", "oldest", { createdAt: "2026-04-01T00:00:00Z" });
    await createTask("2", "middle", { createdAt: "2026-04-05T00:00:00Z" });
    await createTask("3", "newest", { createdAt: "2026-04-08T00:00:00Z" });

    const { tasks } = await loadTasks(testDir);
    const open = tasks.filter(t => t.status !== "closed" && t.status !== "aborted");
    const sorted = sortOpenTasksForDisplay(open);
    expect(sorted.map(t => t.id)).toEqual(["3", "2", "1"]);
  });

  test("open タスクが closed タスクより上に来る（loadTasks 統合）", async () => {
    await createTask("1", "open-task", { createdAt: "2026-04-01T00:00:00Z" });
    await createTask("2", "closed-task", { createdAt: "2026-04-08T00:00:00Z" });
    await closeTask("2");

    const { tasks } = await loadTasks(testDir);
    const open = tasks.filter(t => t.status !== "closed" && t.status !== "aborted");
    const closedTasks = tasks.filter(t => t.status === "closed" || t.status === "aborted");
    const sortedOpen = sortOpenTasksForDisplay(open);
    // open が先、closed が後（combined の構造）
    const combined = [...sortedOpen, ...closedTasks];
    expect(combined.map(t => t.id)).toEqual(["1", "2"]);
  });

  test("priority はソート順に影響しない", async () => {
    await createTask("1", "high-old", { priority: "high", createdAt: "2026-04-01T00:00:00Z" });
    await createTask("2", "low-new", { priority: "low", createdAt: "2026-04-08T00:00:00Z" });

    const { tasks } = await loadTasks(testDir);
    const open = tasks.filter(t => t.status !== "closed" && t.status !== "aborted");
    const sorted = sortOpenTasksForDisplay(open);
    // low でも新しい方が上
    expect(sorted.map(t => t.id)).toEqual(["2", "1"]);
  });
});

// --- テンプレート生成テスト ---

import { generateConductorRolePrompt, generateConductorTaskPrompt } from "./template";

describe("テンプレート生成", () => {
  test("Conductor タスクプロンプトの生成", async () => {
    const promptFile = await generateConductorTaskPrompt(
      testDir,
      "conductor-test",
      "42",
      "テストタスクの内容",
      "/tmp/worktree",
      ".team/output/conductor-test",
      undefined,
      undefined,
      "main"
    );

    const content = await readFile(promptFile, "utf-8");
    // i18n: ja なら "タスク割り当て"、en なら "Task Assignment"
    expect(content.includes("タスク割り当て") || content.includes("Task Assignment")).toBe(true);
    expect(content).toContain("テストタスクの内容");
    expect(content).toContain("/tmp/worktree");
  });
});

// --- SESSION_IDLE テスト ---

describe("SESSION_IDLE メッセージ処理", () => {
  test("SESSION_IDLE は conductor.status を変更しない", async () => {
    // SESSION_IDLE メッセージのスキーマ検証
    const { SessionIdleMessage } = await import("./schema");
    const result = SessionIdleMessage.safeParse({
      type: "SESSION_IDLE",
      surface: "surface:100",
      timestamp: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
  });

  test("SESSION_ENDED はセッション終了時のみ使用される", async () => {
    // SESSION_ENDED メッセージが正しくパースされることを確認
    const { SessionEndedMessage } = await import("./schema");
    const result = SessionEndedMessage.safeParse({
      type: "SESSION_ENDED",
      surface: "surface:100",
      reason: "session_end",
      timestamp: new Date().toISOString(),
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reason).toBe("session_end");
    }
  });
});

// --- エラーハンドリング ---

describe("エラーハンドリング", () => {
  test("タスクディレクトリが存在しない場合でもクラッシュしない", async () => {
    await rm(join(testDir, ".team/tasks"), { recursive: true, force: true });

    const { tasks } = await loadTasks(testDir);
    expect(tasks).toEqual([]);
  });

  test("frontmatter なしのタスクファイルはスキップされる", async () => {
    await writeFile(
      join(testDir, ".team/tasks/001-bad.md"),
      "# ただのマークダウン\n\nfrontmatter なし"
    );
    await createTask("2", "good-task");

    const { tasks } = await loadTasks(testDir);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.id).toBe("2");
  });

  test("循環依存のタスクは永久に実行されない（安全に停止）", async () => {
    await createTask("1", "task-a", { dependsOn: ["2"] });
    await createTask("2", "task-b", { dependsOn: ["1"] });

    const { open, closed } = deriveOpenClosed(await loadTasks(testDir));
    const executable = filterExecutableTasks(open, closed, new Set());
    // どちらも依存が解決されないので実行不可
    expect(executable).toHaveLength(0);
  });

  test("存在しない依存先を持つタスクは実行されない", async () => {
    await createTask("1", "task-a", { dependsOn: ["999"] });

    const { open, closed } = deriveOpenClosed(await loadTasks(testDir));
    const executable = filterExecutableTasks(open, closed, new Set());
    expect(executable).toHaveLength(0);
  });
});

// --- scanTasks 統合テスト (assignTask エラー分離) ---

import { scanTasks, createDaemon, requestWakeup, sleepUntilWakeup, initFileWatcher, handleMessage, monitorConductors } from "./daemon";
import type { DaemonState } from "./daemon";
import type { ConductorState } from "./schema";

describe("scanTasks: assignTask エラー分離", () => {
  test("git 未初期化で assignTask 失敗時、タスクは aborted、Conductor は idle のまま", async () => {
    // testDir は git init していない → git worktree add が失敗する
    await createTask("100", "test-task", { priority: "high" });

    const state = await createDaemon(testDir);
    // T253: 本番では cmdStart が state.mainBranch を解決済み。テストは git 失敗の
    // 分類テストなので、assignTask が mainBranch empty で早期 throw しないよう明示セット。
    state.mainBranch = "main";
    const fakeConductor: ConductorState = {
      surface: "surface:fake-c1",
      startedAt: new Date().toISOString(),
      agents: [],
      status: "idle",
    };
    state.conductors.set(fakeConductor.surface, fakeConductor);

    await scanTasks(state);

    // Conductor は idle のまま維持される（disconnected にならない）
    expect(fakeConductor.status).toBe("idle");

    // タスクは aborted 状態になる
    const { loadTaskState } = await import("./task");
    const ts = await loadTaskState(testDir);
    expect(ts["100"]?.status).toBe("aborted");
    expect(ts["100"]?.abortedAt).toBeDefined();
    expect(ts["100"]?.journal).toContain("assign_failed");
    expect(ts["100"]?.journal).toContain("git worktree add");
  });

  test("idle Conductor 不在時は何も変更しない (throttled)", async () => {
    await createTask("101", "pending-task");

    const state = await createDaemon(testDir);
    // Conductor を登録しない
    await scanTasks(state);

    const { loadTaskState } = await import("./task");
    const ts = await loadTaskState(testDir);
    // タスクは ready のまま
    expect(ts["101"]?.status).toBe("ready");
  });
});

// --- requestWakeup / sleepUntilWakeup 単体テスト ---

describe("requestWakeup と sleepUntilWakeup", () => {
  test("tick 中に requestWakeup → 次の sleep は即 resolve", async () => {
    const state = await createDaemon(testDir);
    state.pollInterval = 10_000; // 10 秒（即 resolve を検証するため十分長く）

    // tick 中相当: state.wakeup は null、wakeupPending を立てる
    expect(state.wakeup).toBeNull();
    requestWakeup(state);
    expect(state.wakeupPending).toBe(true);

    const t0 = Date.now();
    await sleepUntilWakeup(state);
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(50);
    expect(state.wakeupPending).toBe(false);
    expect(state.wakeup).toBeNull();
  });

  test("sleep 中に requestWakeup → 即 resolve", async () => {
    const state = await createDaemon(testDir);
    state.pollInterval = 10_000;

    const sleepPromise = sleepUntilWakeup(state);
    // マイクロタスク 1 回で state.wakeup がセットされていること
    await Promise.resolve();
    expect(state.wakeup).not.toBeNull();

    requestWakeup(state);
    const t0 = Date.now();
    await sleepPromise;
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(50);
    expect(state.wakeupPending).toBe(false);
    expect(state.wakeup).toBeNull();
  });

  test("setTimeout 満了で resolve", async () => {
    const state = await createDaemon(testDir);
    state.pollInterval = 50;

    const t0 = Date.now();
    await sleepUntilWakeup(state);
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeGreaterThanOrEqual(45);
    expect(state.wakeup).toBeNull();
    expect(state.wakeupPending).toBe(false);
  });

  test("sleep 中の連続 requestWakeup で timer がリークしない", async () => {
    const state = await createDaemon(testDir);
    state.pollInterval = 10_000;

    const sleepPromise = sleepUntilWakeup(state);
    await Promise.resolve();
    // 1 回目で resolve、2 回目は state.wakeup が null なので noop だが wakeupPending が立つ
    requestWakeup(state);
    requestWakeup(state);
    await sleepPromise;

    // 2 回目の requestWakeup で wakeupPending が立ったので、次の sleep も即 resolve する
    const t0 = Date.now();
    await sleepUntilWakeup(state);
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(50);
    expect(state.wakeupPending).toBe(false);
    expect(state.wakeup).toBeNull();
  });

  test("tick ループ相当: 複数回の割り込みを全て消化する", async () => {
    const state = await createDaemon(testDir);
    state.pollInterval = 1_000; // タイムアウト保険

    const t0 = Date.now();
    for (let i = 0; i < 5; i++) {
      // tick に相当する同期処理（state.wakeup は null のまま）
      requestWakeup(state);
      await sleepUntilWakeup(state);
    }
    const elapsed = Date.now() - t0;

    // 5 ループが pollInterval に達せず合計 100ms 未満で完了すること
    expect(elapsed).toBeLessThan(100);
    expect(state.wakeupPending).toBe(false);
    expect(state.wakeup).toBeNull();
  });
});

// --- initFileWatcher 統合テスト ---

describe("initFileWatcher", () => {
  let watcherState: DaemonState | null = null;

  afterEach(() => {
    if (watcherState) {
      watcherState.fileWatcherAbort?.abort();
      watcherState.fileWatcherAbort = null;
      watcherState.running = false;
      watcherState = null;
    }
  });

  test("サブディレクトリ task.md 作成で wakeup 発火", async () => {
    const state = await createDaemon(testDir);
    watcherState = state;
    initFileWatcher(state);
    // watcher 起動を待つ
    await new Promise((r) => setTimeout(r, 100));

    expect(state.wakeupPending).toBe(false);

    // .team/tasks/999-foo/task.md を作成
    const subDir = join(testDir, ".team/tasks/999-foo");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "task.md"), "---\nid: 999\ntitle: foo\n---\n");

    // 300ms 以内に wakeupPending が立つこと
    let triggered = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 10));
      if (state.wakeupPending) {
        triggered = true;
        break;
      }
    }
    expect(triggered).toBe(true);
  });

  test("task-state.json 更新で wakeup 発火", async () => {
    const state = await createDaemon(testDir);
    watcherState = state;
    initFileWatcher(state);
    await new Promise((r) => setTimeout(r, 100));

    expect(state.wakeupPending).toBe(false);

    // saveTaskState で task-state.json を書き込む
    const { saveTaskState } = await import("./task");
    await saveTaskState(testDir, { "500": { status: "ready" } });

    let triggered = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 10));
      if (state.wakeupPending) {
        triggered = true;
        break;
      }
    }
    expect(triggered).toBe(true);
  });

  test(".team/output/ の変更では wakeup 発火しない", async () => {
    const state = await createDaemon(testDir);
    watcherState = state;
    initFileWatcher(state);
    await new Promise((r) => setTimeout(r, 100));

    expect(state.wakeupPending).toBe(false);

    await writeFile(join(testDir, ".team/output/foo.txt"), "dummy");

    // 1000ms 待っても wakeupPending が false のままであること
    await new Promise((r) => setTimeout(r, 1000));
    expect(state.wakeupPending).toBe(false);
  });
});

// --- crashed → disconnected 遷移とリカバリ (T121/T195) ---
// T195 以降: 生存確認は `cmux.isAlive(pid)` + `spawnPidWatcher` 一本。
// fake cmux / writeFakeCmux は不要になり、代わりに `__setIsAliveImpl` で差し替える。

describe("handleMessage: TASK_UPDATED", () => {
  test("TASK_UPDATED は requestWakeup を発火させる", async () => {
    const state = await createDaemon(testDir);
    expect(state.wakeupPending).toBe(false);

    await handleMessage(state, {
      type: "TASK_UPDATED",
      taskId: "183",
      taskFile: ".team/tasks/183-example.md",
      timestamp: new Date().toISOString(),
    });

    expect(state.wakeupPending).toBe(true);
  });
});

describe("crashed → disconnected 遷移 (T121/T195)", () => {
  test("1. spawnPidWatcher tick: dead 検出で disconnected + taskRunId 保持", async () => {
    const { __setIsAliveImpl } = await import("./cmux");
    const { __testSpawnPidWatcherTick } = await import("./daemon");
    __setIsAliveImpl(() => false);
    try {
      const state = await createDaemon(testDir);
      const conductor: ConductorState = {
        surface: "surface:71",
        startedAt: new Date().toISOString(),
        taskRunId: "task-010-1712345678",
        taskId: "010",
        taskTitle: "journal-generator",
        worktreePath: join(testDir, ".worktrees/task-010-1712345678"),
        outputDir: ".team/output/task-010-1712345678",
        agents: [],
        status: "running",
        pid: 99999,
      };
      state.conductors.set(conductor.surface, conductor);

      const result = await __testSpawnPidWatcherTick(state, conductor, 99999);

      expect(result).toBe("dead");
      expect(conductor.status).toBe("disconnected");
      expect(conductor.disconnectedAt).toBeDefined();
      // pid はクリアされる
      expect(conductor.pid).toBeUndefined();
      // taskRunId 等は保持される（意図的に残す設計）
      expect(conductor.taskRunId).toBe("task-010-1712345678");
      expect(conductor.taskId).toBe("010");
      expect(conductor.worktreePath).toBe(join(testDir, ".worktrees/task-010-1712345678"));
    } finally {
      __setIsAliveImpl(null);
    }
  });

  test("1b. spawnPidWatcher tick: alive なら状態変化なし", async () => {
    const { __setIsAliveImpl } = await import("./cmux");
    const { __testSpawnPidWatcherTick } = await import("./daemon");
    __setIsAliveImpl(() => true);
    try {
      const state = await createDaemon(testDir);
      const conductor: ConductorState = {
        surface: "surface:71",
        startedAt: new Date().toISOString(),
        taskRunId: "task-010-x",
        taskId: "010",
        agents: [],
        status: "running",
        pid: 12345,
      };
      state.conductors.set(conductor.surface, conductor);

      const result = await __testSpawnPidWatcherTick(state, conductor, 12345);

      expect(result).toBe("alive");
      expect(conductor.status).toBe("running");
      expect(conductor.pid).toBe(12345);
      expect(conductor.disconnectedAt).toBeUndefined();
    } finally {
      __setIsAliveImpl(null);
    }
  });

  test("1c. spawnPidWatcher tick: daemon 停止中は stopped で no-op", async () => {
    const { __setIsAliveImpl } = await import("./cmux");
    const { __testSpawnPidWatcherTick } = await import("./daemon");
    __setIsAliveImpl(() => false);
    try {
      const state = await createDaemon(testDir);
      state.running = false;
      const conductor: ConductorState = {
        surface: "surface:71",
        startedAt: new Date().toISOString(),
        agents: [],
        status: "running",
        pid: 99999,
      };
      state.conductors.set(conductor.surface, conductor);

      const result = await __testSpawnPidWatcherTick(state, conductor, 99999);

      expect(result).toBe("stopped");
      expect(conductor.status).toBe("running");
    } finally {
      __setIsAliveImpl(null);
    }
  });

  test("1d. spawnPidWatcher tick: pid ミスマッチ（再起動後）は stale で abort", async () => {
    const { __setIsAliveImpl } = await import("./cmux");
    const { __testSpawnPidWatcherTick } = await import("./daemon");
    __setIsAliveImpl(() => false);
    try {
      const state = await createDaemon(testDir);
      const conductor: ConductorState = {
        surface: "surface:71",
        startedAt: new Date().toISOString(),
        agents: [],
        status: "running",
        pid: 22222, // 新しい pid
      };
      state.conductors.set(conductor.surface, conductor);

      // 古い pid を渡す（restart 前のウォッチャー）
      const result = await __testSpawnPidWatcherTick(state, conductor, 11111);

      expect(result).toBe("stale");
      // conductor はそのまま（新しい pid の session は生きている）
      expect(conductor.status).toBe("running");
      expect(conductor.pid).toBe(22222);
    } finally {
      __setIsAliveImpl(null);
    }
  });

  test("2. disconnected + CONDUCTOR_DONE で late cleanup が走る", async () => {
    // T251: resetConductor が surface 実在確認 (getPaneForSurface) を行うようになったため、
    //       surface 存在ケースとしてモックする（本テストの意図は late cleanup 経路の検証）。
    const cmux = await import("./cmux");
    const { spyOn } = await import("bun:test");
    const paneSpy = spyOn(cmux, "getPaneForSurface").mockResolvedValue("pane:1");
    try {
      const state = await createDaemon(testDir);
      const conductor: ConductorState = {
        surface: "surface:71",
        startedAt: new Date().toISOString(),
        disconnectedAt: new Date().toISOString(),
        taskRunId: "task-010-1712345678",
        taskId: "010",
        taskTitle: "journal-generator",
        // worktreePath は存在しないパスを指定する。
        // resetConductor は existsSync ガード (conductor.ts:425) で worktree remove を
        // スキップするため、実ファイルシステムに worktree が無くてもテストは成功する (Minor 7)。
        worktreePath: join(testDir, ".worktrees/task-010-nothing"),
        outputDir: ".team/output/task-010",
        agents: [],
        status: "disconnected",
      };
      state.conductors.set(conductor.surface, conductor);

      await handleMessage(state, {
        type: "CONDUCTOR_DONE",
        surface: "surface:71",
        success: true,
        timestamp: new Date().toISOString(),
      });

      // late cleanup 経路に入り、resetConductor で status=idle にリセット
      expect(conductor.status).toBe("idle");
      expect(conductor.taskRunId).toBeUndefined();
      expect(conductor.taskId).toBeUndefined();
      expect(conductor.worktreePath).toBeUndefined();
      // Minor 3: resetConductor で disconnectedAt もクリアされる
      expect(conductor.disconnectedAt).toBeUndefined();
    } finally {
      paneSpy.mockRestore();
    }
  });

  test("2b. disconnected + taskRunId なし + CONDUCTOR_DONE は no_task で ignore", async () => {
    const state = await createDaemon(testDir);
    const conductor: ConductorState = {
      surface: "surface:71",
      startedAt: new Date().toISOString(),
      disconnectedAt: new Date().toISOString(),
      agents: [],
      status: "disconnected",
      // taskRunId なし
    };
    state.conductors.set(conductor.surface, conductor);

    await handleMessage(state, {
      type: "CONDUCTOR_DONE",
      surface: "surface:71",
      success: true,
      timestamp: new Date().toISOString(),
    });

    // no_task ignore → 状態変更なし
    expect(conductor.status).toBe("disconnected");
  });

  test("3. disconnect timeout で forced close + journal + aborted", async () => {
    // git init で worktree 操作を有効化
    const { execFile: ef } = await import("child_process");
    const { promisify } = await import("util");
    await promisify(ef)("git", ["init", "-q"], { cwd: testDir });

    // テストタスクを作成
    await createTask("10", "journal-generator");
    // task-state に assigned を明示
    const { loadTaskState: loadTS, saveTaskState: saveTS } = await import("./task");
    const ts = await loadTS(testDir);
    ts["10"] = { status: "assigned", assignedAt: new Date().toISOString() };
    await saveTS(testDir, ts);

    const state = await createDaemon(testDir);
    const oldDisconnectedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();  // 10 分前
    const conductor: ConductorState = {
      surface: "surface:71",
      startedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      disconnectedAt: oldDisconnectedAt,
      taskRunId: "task-010-1712345678",
      taskId: "10",
      taskTitle: "journal-generator",
      agents: [],
      status: "disconnected",
    };
    state.conductors.set(conductor.surface, conductor);

    await monitorConductors(state);

    // T250: timeout 判定 → forced close で broken に遷移（idle ではなく）
    expect(conductor.status).toBe("broken");
    expect(conductor.taskRunId).toBeUndefined();
    // T250: broken は disconnectedAt を保持（UI 経過時間表示 + デバッグ用）
    expect(conductor.disconnectedAt).toBeDefined();
    // T250: broken Conductor は state.conductors に残ったまま（可視化のため）
    expect(state.conductors.has(conductor.surface)).toBe(true);

    // task-state が aborted になっている
    const tsAfter = await loadTS(testDir);
    expect(tsAfter["10"]?.status).toBe("aborted");
    expect(tsAfter["10"]?.journal).toContain("disconnect_timeout");
    expect(tsAfter["10"]?.abortedAt).toBeDefined();

    // ログは logger.ts のモジュールキャッシュにより testDir 外に書かれるため、
    // conductor_disconnect_timeout + task_aborted は状態遷移 (status/abortedAt) で検証。
  });

  test("3b. disconnect timeout 未到達ならスキップ", async () => {
    const state = await createDaemon(testDir);
    const recentDisconnectedAt = new Date(Date.now() - 10_000).toISOString();  // 10 秒前
    const conductor: ConductorState = {
      surface: "surface:71",
      startedAt: new Date().toISOString(),
      disconnectedAt: recentDisconnectedAt,
      taskRunId: "task-010-x",
      taskId: "10",
      agents: [],
      status: "disconnected",
    };
    state.conductors.set(conductor.surface, conductor);

    await monitorConductors(state);

    // まだ disconnected のまま
    expect(conductor.status).toBe("disconnected");
    expect(conductor.taskRunId).toBe("task-010-x");
  });

  test("4. SESSION_IDLE で disconnected + taskRunId 残存時は cleanup せず running に復帰", async () => {
    // Critical 1 反映: SESSION_IDLE はターン境界ごとに発火するため、
    //   disconnected + taskRunId 復帰時に resetConductor を呼ぶと生存中の Conductor の
    //   worktree を誤削除するリスクがある。
    //   新設計では「running に戻すだけ、cleanup はせず、taskRunId を保持する」ことを検証。
    const state = await createDaemon(testDir);
    const worktreePath = join(testDir, ".worktrees/task-010-y");
    const conductor: ConductorState = {
      surface: "surface:71",
      startedAt: new Date().toISOString(),
      disconnectedAt: new Date().toISOString(),
      taskRunId: "task-010-y",
      taskId: "10",
      taskTitle: "t",
      worktreePath,
      outputDir: ".team/output/task-010-y",
      agents: [],
      status: "disconnected",
    };
    state.conductors.set(conductor.surface, conductor);

    await handleMessage(state, {
      type: "SESSION_IDLE",
      surface: "surface:71",
      timestamp: new Date().toISOString(),
    });

    // status は running に戻る（cleanup されない）
    expect(conductor.status).toBe("running");
    // taskRunId / taskId / worktreePath は保持される
    expect(conductor.taskRunId).toBe("task-010-y");
    expect(conductor.taskId).toBe("10");
    expect(conductor.worktreePath).toBe(worktreePath);
    // alive の証拠として disconnectedAt はクリアされる
    expect(conductor.disconnectedAt).toBeUndefined();

    // ログは logger.ts のモジュールキャッシュにより testDir 外に書かれるため、
    // conductor_recovered + via=SESSION_IDLE + new_status=running は
    // status === "running" + taskRunId 保持で検証。
  });

  test("4b. SESSION_IDLE で disconnected + taskRunId なしは通常 recovery (idle)", async () => {
    const state = await createDaemon(testDir);
    const conductor: ConductorState = {
      surface: "surface:71",
      startedAt: new Date().toISOString(),
      disconnectedAt: new Date().toISOString(),
      agents: [],
      status: "disconnected",
    };
    state.conductors.set(conductor.surface, conductor);

    await handleMessage(state, {
      type: "SESSION_IDLE",
      surface: "surface:71",
      timestamp: new Date().toISOString(),
    });

    expect(conductor.status).toBe("idle");
  });
});

describe("spawnAgentPidWatcher tick (T195)", () => {
  test("dead 検出で agents から削除され done マーカーが書かれる", async () => {
    const { __setIsAliveImpl } = await import("./cmux");
    const { __testSpawnAgentPidWatcherTick } = await import("./daemon");
    __setIsAliveImpl(() => false);
    try {
      const state = await createDaemon(testDir);
      const agent = {
        surface: "surface:a1",
        spawnedAt: new Date().toISOString(),
        pid: 99999,
        status: "running" as const,
      };
      const conductor: ConductorState = {
        surface: "surface:c1",
        startedAt: new Date().toISOString(),
        agents: [agent],
        status: "running",
      };
      state.conductors.set(conductor.surface, conductor);
      await mkdir(join(testDir, ".team/conductors/surface_c1/agent-done"), { recursive: true });

      const result = await __testSpawnAgentPidWatcherTick(state, conductor, agent, 99999);

      expect(result).toBe("dead");
      expect(conductor.agents).toHaveLength(0);
      // done マーカーが書かれている
      const doneFile = join(testDir, ".team/conductors/surface_c1/agent-done/surface_a1.done");
      const done = await readFile(doneFile, "utf-8");
      expect(done).toContain("status=crashed");
      expect(done).toContain("reason=pid_watcher");
    } finally {
      __setIsAliveImpl(null);
    }
  });

  test("alive なら agents 配列は変化しない", async () => {
    const { __setIsAliveImpl } = await import("./cmux");
    const { __testSpawnAgentPidWatcherTick } = await import("./daemon");
    __setIsAliveImpl(() => true);
    try {
      const state = await createDaemon(testDir);
      const agent = {
        surface: "surface:a1",
        spawnedAt: new Date().toISOString(),
        pid: 12345,
        status: "running" as const,
      };
      const conductor: ConductorState = {
        surface: "surface:c1",
        startedAt: new Date().toISOString(),
        agents: [agent],
        status: "running",
      };
      state.conductors.set(conductor.surface, conductor);

      const result = await __testSpawnAgentPidWatcherTick(state, conductor, agent, 12345);

      expect(result).toBe("alive");
      expect(conductor.agents).toHaveLength(1);
    } finally {
      __setIsAliveImpl(null);
    }
  });

  test("冪等性: SESSION_ENDED で先に削除されていたら noop", async () => {
    const { __setIsAliveImpl } = await import("./cmux");
    const { __testSpawnAgentPidWatcherTick } = await import("./daemon");
    __setIsAliveImpl(() => false);
    try {
      const state = await createDaemon(testDir);
      // agent object は生き残っているが、conductor.agents 配列からは既に削除済み
      const agent = {
        surface: "surface:a1",
        spawnedAt: new Date().toISOString(),
        pid: 99999,
        status: "running" as const,
      };
      const conductor: ConductorState = {
        surface: "surface:c1",
        startedAt: new Date().toISOString(),
        agents: [], // 既に削除済み
        status: "running",
      };
      state.conductors.set(conductor.surface, conductor);

      const result = await __testSpawnAgentPidWatcherTick(state, conductor, agent, 99999);

      expect(result).toBe("noop");
      expect(conductor.agents).toHaveLength(0);
    } finally {
      __setIsAliveImpl(null);
    }
  });
});

describe("SESSION_CLEAR: pid リセット (T195)", () => {
  test("running-reset: conductor.pid が undefined になる", async () => {
    const state = await createDaemon(testDir);
    const conductor: ConductorState = {
      surface: "surface:c1",
      startedAt: new Date().toISOString(),
      agents: [],
      status: "running",
      pid: 99999,
      taskRunId: "task-010-x",
      taskId: "10",
    };
    state.conductors.set(conductor.surface, conductor);

    await handleMessage(state, {
      type: "SESSION_CLEAR",
      surface: "surface:c1",
      timestamp: new Date().toISOString(),
    });

    // pid はクリアされる（次の SESSION_STARTED で新 pid が入る）
    expect(conductor.pid).toBeUndefined();
  });
});

describe("Agent SESSION_STARTED (T195)", () => {
  test("agent surface にマッチする SESSION_STARTED で pid が登録されウォッチャーが起動", async () => {
    const state = await createDaemon(testDir);
    const agent = {
      surface: "surface:a1",
      spawnedAt: new Date().toISOString(),
      status: "starting" as const,
    };
    const conductor: ConductorState = {
      surface: "surface:c1",
      startedAt: new Date().toISOString(),
      agents: [agent],
      status: "running",
    };
    state.conductors.set(conductor.surface, conductor);

    await handleMessage(state, {
      type: "SESSION_STARTED",
      surface: "surface:a1",
      pid: 55555,
      timestamp: new Date().toISOString(),
    });

    // agent.pid が記録される
    const updated = conductor.agents.find(a => a.surface === "surface:a1");
    expect(updated?.pid).toBe(55555);
    // pidWatcherInterval がセットされている
    expect(updated?.pidWatcherInterval).toBeDefined();

    // クリーンアップ（interval を止める）
    if (updated?.pidWatcherInterval) {
      clearInterval(updated.pidWatcherInterval);
      updated.pidWatcherInterval = undefined;
    }
  });
});

describe("SESSION_STARTED で sessionId 更新 (T203)", () => {
  test("Conductor: sessionId が state に反映される", async () => {
    const state = await createDaemon(testDir);
    const conductor: ConductorState = {
      surface: "surface:c1",
      startedAt: new Date().toISOString(),
      agents: [],
      status: "starting",
    };
    state.conductors.set(conductor.surface, conductor);

    await handleMessage(state, {
      type: "SESSION_STARTED",
      surface: "surface:c1",
      pid: 11111,
      sessionId: "uuid-A",
      source: "startup",
      timestamp: new Date().toISOString(),
    });

    expect(conductor.sessionId).toBe("uuid-A");
    expect(conductor.pid).toBe(11111);
    expect(conductor.status).toBe("idle"); // n1: starting → idle 遷移は維持
  });

  test("Conductor: 2 回目の sessionId は上書きされる（/clear シナリオ）", async () => {
    const state = await createDaemon(testDir);
    const conductor: ConductorState = {
      surface: "surface:c2",
      startedAt: new Date().toISOString(),
      agents: [],
      status: "running",
      sessionId: "uuid-1",
      pid: 22222,
    };
    state.conductors.set(conductor.surface, conductor);

    await handleMessage(state, {
      type: "SESSION_STARTED",
      surface: "surface:c2",
      pid: 22223,
      sessionId: "uuid-2",
      source: "clear",
      timestamp: new Date().toISOString(),
    });

    expect(conductor.sessionId).toBe("uuid-2");
    expect(conductor.pid).toBe(22223);

    if (conductor.pidWatcherInterval) {
      clearInterval(conductor.pidWatcherInterval);
      conductor.pidWatcherInterval = undefined;
    }
  });

  test("Conductor: sessionId 無しメッセージは既存値を保つ（後方互換）", async () => {
    const state = await createDaemon(testDir);
    const conductor: ConductorState = {
      surface: "surface:c3",
      startedAt: new Date().toISOString(),
      agents: [],
      status: "running",
      sessionId: "uuid-keep",
    };
    state.conductors.set(conductor.surface, conductor);

    await handleMessage(state, {
      type: "SESSION_STARTED",
      surface: "surface:c3",
      pid: 33333,
      timestamp: new Date().toISOString(),
    });

    expect(conductor.sessionId).toBe("uuid-keep");

    if (conductor.pidWatcherInterval) {
      clearInterval(conductor.pidWatcherInterval);
      conductor.pidWatcherInterval = undefined;
    }
  });

  test("Agent: sessionId が agent state に反映される", async () => {
    const state = await createDaemon(testDir);
    const agent = {
      surface: "surface:a2",
      spawnedAt: new Date().toISOString(),
      status: "starting" as const,
    };
    const conductor: ConductorState = {
      surface: "surface:c4",
      startedAt: new Date().toISOString(),
      agents: [agent],
      status: "running",
    };
    state.conductors.set(conductor.surface, conductor);

    await handleMessage(state, {
      type: "SESSION_STARTED",
      surface: "surface:a2",
      pid: 44444,
      sessionId: "uuid-agent",
      source: "startup",
      timestamp: new Date().toISOString(),
    });

    const updated = conductor.agents.find(a => a.surface === "surface:a2");
    expect(updated?.sessionId).toBe("uuid-agent");
    expect(updated?.pid).toBe(44444);

    if (updated?.pidWatcherInterval) {
      clearInterval(updated.pidWatcherInterval);
      updated.pidWatcherInterval = undefined;
    }
  });

  test("C3: assigned タスクを持つ Conductor の /clear で task-state.json.sessionId が更新される", async () => {
    const { saveTaskState, loadTaskState } = await import("./task");
    const state = await createDaemon(testDir);

    // 事前条件: task-state.json に assigned + 旧 sessionId
    const initialTs = await loadTaskState(testDir);
    initialTs["T999"] = {
      status: "assigned",
      sessionId: "uuid-old",
      worktreePath: join(testDir, ".worktrees/task-999"),
    } as any;
    await saveTaskState(testDir, initialTs);

    const conductor: ConductorState = {
      surface: "surface:c5",
      startedAt: new Date().toISOString(),
      agents: [],
      status: "running",
      taskId: "T999",
      sessionId: "uuid-old",
    };
    state.conductors.set(conductor.surface, conductor);

    await handleMessage(state, {
      type: "SESSION_STARTED",
      surface: "surface:c5",
      pid: 55556,
      sessionId: "uuid-new",
      source: "clear",
      timestamp: new Date().toISOString(),
    });

    expect(conductor.sessionId).toBe("uuid-new");
    const updatedTs = await loadTaskState(testDir);
    expect((updatedTs["T999"] as any).sessionId).toBe("uuid-new");

    if (conductor.pidWatcherInterval) {
      clearInterval(conductor.pidWatcherInterval);
      conductor.pidWatcherInterval = undefined;
    }
  });

  test("C3: 同一 sessionId を受信した場合は task-state.json を書き換えない（冪等性）", async () => {
    const { saveTaskState, loadTaskState } = await import("./task");
    const state = await createDaemon(testDir);

    const initialTs = await loadTaskState(testDir);
    initialTs["T888"] = {
      status: "assigned",
      sessionId: "uuid-same",
      worktreePath: join(testDir, ".worktrees/task-888"),
    } as any;
    await saveTaskState(testDir, initialTs);

    // ファイルの mtime 比較で「書き換えていない」ことを確認するため取得
    const beforeStat = await import("fs/promises").then(m =>
      m.stat(join(testDir, ".team/task-state.json"))
    );

    const conductor: ConductorState = {
      surface: "surface:c6",
      startedAt: new Date().toISOString(),
      agents: [],
      status: "running",
      taskId: "T888",
      sessionId: "uuid-same",
    };
    state.conductors.set(conductor.surface, conductor);

    await handleMessage(state, {
      type: "SESSION_STARTED",
      surface: "surface:c6",
      pid: 66666,
      sessionId: "uuid-same",
      source: "clear",
      timestamp: new Date().toISOString(),
    });

    const afterStat = await import("fs/promises").then(m =>
      m.stat(join(testDir, ".team/task-state.json"))
    );
    // mtime が変わっていない（書き直されていない）
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);

    const ts = await loadTaskState(testDir);
    expect((ts["T888"] as any).sessionId).toBe("uuid-same");

    if (conductor.pidWatcherInterval) {
      clearInterval(conductor.pidWatcherInterval);
      conductor.pidWatcherInterval = undefined;
    }
  });
});

// --- T176: layout モード ---

import { updateTeamJson } from "./daemon";

describe("createDaemon: layout (T176)", () => {
  const prevEnv = process.env.CMUX_TEAM_MAX_CONDUCTORS;
  beforeEach(() => {
    delete process.env.CMUX_TEAM_MAX_CONDUCTORS;
  });
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.CMUX_TEAM_MAX_CONDUCTORS;
    else process.env.CMUX_TEAM_MAX_CONDUCTORS = prevEnv;
  });

  test("default (layout 未指定) → wide / maxConductors=3", async () => {
    const state = await createDaemon(testDir);
    expect(state.layout).toBe("wide");
    expect(state.maxConductors).toBe(3);
  });

  test("layout=16x9 → maxConductors=2", async () => {
    const state = await createDaemon(testDir, "16x9");
    expect(state.layout).toBe("16x9");
    expect(state.maxConductors).toBe(2);
  });

  test("layout=wide を明示 → maxConductors=3", async () => {
    const state = await createDaemon(testDir, "wide");
    expect(state.layout).toBe("wide");
    expect(state.maxConductors).toBe(3);
  });

  test("CMUX_TEAM_MAX_CONDUCTORS が env にあれば layout 派生値より優先", async () => {
    process.env.CMUX_TEAM_MAX_CONDUCTORS = "5";
    const state = await createDaemon(testDir, "16x9");
    expect(state.layout).toBe("16x9");
    expect(state.maxConductors).toBe(5); // env 優先
  });
});

describe("checkUpdateAndNotify (T187/T294)", () => {
  // T294: v4.5.0 で `task` モードと `createUpdateTask` を削除。
  // 残るモードは `off | notify` の 2 値で、いずれも副作用なし経路のみテストする。
  let origFetchEnv: string | undefined;
  beforeEach(() => {
    origFetchEnv = process.env.NO_UPDATE_NOTIFIER;
  });
  afterEach(() => {
    if (origFetchEnv === undefined) delete process.env.NO_UPDATE_NOTIFIER;
    else process.env.NO_UPDATE_NOTIFIER = origFetchEnv;
  });

  test("mode='notify' + NO_UPDATE_NOTIFIER=1 で早期 return する", async () => {
    const { checkUpdateAndNotify } = await import("./daemon");
    const state = await createDaemon(testDir, "wide");
    state.updateMode = "notify";
    process.env.NO_UPDATE_NOTIFIER = "1";
    await checkUpdateAndNotify(state, "notify");
    expect(state.updateAvailable).toBeNull();
  });

  test("mode='off' で即 return する", async () => {
    const { checkUpdateAndNotify } = await import("./daemon");
    const state = await createDaemon(testDir, "wide");
    await checkUpdateAndNotify(state, "off");
    expect(state.updateAvailable).toBeNull();
  });

  test("createUpdateTask は export されていない（T294 で削除）", async () => {
    const mod: any = await import("./daemon");
    expect(mod.createUpdateTask).toBeUndefined();
  });
});

// --- T189: SESSION_STOP 分類ルーティング ---

describe("handleMessage: SESSION_STOP (T189)", () => {
  async function writeTranscript(lines: any[]): Promise<string> {
    const path = join(testDir, ".team/transcript.jsonl");
    await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return path;
  }

  test("Agent / Case A (ASK) → writeAgentDone(status=ask) が呼ばれる", async () => {
    const state = await createDaemon(testDir);
    const conductor: ConductorState = {
      surface: "surface:c1",
      startedAt: new Date().toISOString(),
      agents: [{ surface: "surface:a1", spawnedAt: new Date().toISOString(), status: "running" as const }],
      status: "running",
    };
    state.conductors.set(conductor.surface, conductor);

    const transcriptPath = await writeTranscript([
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "どうしますか?" },
            { type: "tool_use", name: "AskUserQuestion", input: {} },
          ],
        },
      },
    ]);

    await handleMessage(state, {
      type: "SESSION_STOP",
      surface: "surface:a1",
      pid: 123,
      timestamp: new Date().toISOString(),
      payload: { transcript_path: transcriptPath },
    });

    // Agent の done マーカーが書かれる
    const doneFile = join(
      testDir,
      ".team/conductors/surface_c1/agent-done/surface_a1.done",
    );
    const done = await readFile(doneFile, "utf-8");
    expect(done).toContain("status=ask");
    expect(done).toContain("question=どうしますか?");

    // T238: agent.status が "asking" に遷移している
    const updatedAgent = conductor.agents.find(a => a.surface === "surface:a1");
    expect(updatedAgent?.status).toBe("asking");
  });

  test("Conductor / Case C (IDLE) → conductor.status 遷移", async () => {
    const state = await createDaemon(testDir);
    const conductor: ConductorState = {
      surface: "surface:c1",
      startedAt: new Date().toISOString(),
      agents: [],
      status: "asking",
      askQuestion: "old?",
    };
    state.conductors.set(conductor.surface, conductor);

    const transcriptPath = await writeTranscript([
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Read", input: {} },
            { type: "tool_result", content: "..." },
          ],
        },
      },
    ]);

    await handleMessage(state, {
      type: "SESSION_STOP",
      surface: "surface:c1",
      pid: 123,
      timestamp: new Date().toISOString(),
      payload: { transcript_path: transcriptPath },
    });

    // asking → idle（SESSION_IDLE handler の ask 解決パス）
    expect(conductor.status).toBe("idle");
    expect(conductor.askQuestion).toBeUndefined();
  });

  test("T208: Agent text-only end_turn → writeAgentDone(completed) が呼ばれる", async () => {
    const state = await createDaemon(testDir);
    const conductor: ConductorState = {
      surface: "surface:c1",
      startedAt: new Date().toISOString(),
      agents: [{ surface: "surface:a1", spawnedAt: new Date().toISOString(), status: "running" as const }],
      status: "running",
    };
    state.conductors.set(conductor.surface, conductor);

    const transcriptPath = await writeTranscript([
      { type: "assistant", message: { content: [{ type: "text", text: "考え中..." }] } },
    ]);

    await handleMessage(state, {
      type: "SESSION_STOP",
      surface: "surface:a1",
      pid: 123,
      timestamp: new Date().toISOString(),
      payload: { transcript_path: transcriptPath },
    });

    // T208: text-only でも IDLE 経由で done マーカー (status=completed) が書かれる
    const doneFile = join(
      testDir,
      ".team/conductors/surface_c1/agent-done/surface_a1.done",
    );
    expect(existsSync(doneFile)).toBe(true);
    const body = await readFile(doneFile, "utf-8");
    expect(body).toContain("status=completed");
  });

  test("T208 A[191] 再現: 多数 tool_use → 最後 text-only end_turn でも writeAgentDone が呼ばれる", async () => {
    const state = await createDaemon(testDir);
    const conductor: ConductorState = {
      surface: "surface:c1",
      startedAt: new Date().toISOString(),
      agents: [{ surface: "surface:a1", spawnedAt: new Date().toISOString(), status: "running" as const }],
      status: "running",
    };
    state.conductors.set(conductor.surface, conductor);

    const turns: any[] = [];
    for (let i = 0; i < 40; i++) {
      turns.push({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Write", input: { i } }] },
      });
    }
    turns.push({
      type: "assistant",
      message: { content: [{ type: "text", text: "plan.md を出力しました。" }] },
    });
    const transcriptPath = await writeTranscript(turns);

    await handleMessage(state, {
      type: "SESSION_STOP",
      surface: "surface:a1",
      pid: 42613,
      timestamp: new Date().toISOString(),
      payload: { transcript_path: transcriptPath },
    });

    const doneFile = join(
      testDir,
      ".team/conductors/surface_c1/agent-done/surface_a1.done",
    );
    expect(existsSync(doneFile)).toBe(true);
  });

  test("空 surface は早期 drop（副作用なし）", async () => {
    const state = await createDaemon(testDir);
    // masterSurface / conductor を一切セットしない状態で呼んでも throw しない
    await handleMessage(state, {
      type: "SESSION_STOP",
      surface: "",
      pid: 123,
      timestamp: new Date().toISOString(),
      payload: {},
    });
    // ここまで到達すれば OK（早期 return で break）
    expect(state.conductors.size).toBe(0);
  });

  // T326: Conductor SESSION_ASK 統合経路の入口テスト。
  // 既存の Agent ASK / Conductor IDLE / text-only end_turn とは独立して、
  // Conductor surface に対する ASK transcript を投入したときの副作用を検証する。
  test("T326: Conductor / Case A (ASK) → conductor.status='asking' に遷移し conductor_asking ログが出る (cmux.notify は呼ばれない)", async () => {
    const cmux = await import("./cmux");
    const { spyOn } = await import("bun:test");
    const notifySpy = spyOn(cmux, "notify").mockImplementation(async () => {});

    try {
      const state = await createDaemon(testDir);
      const fixedTimestamp = "2026-04-25T07:30:00.000Z";
      const conductor: ConductorState = {
        surface: "surface:c1",
        startedAt: new Date().toISOString(),
        agents: [],
        status: "running",
        taskRunId: "task-326-test",
        taskId: "326",
        taskTitle: "demo",
        // 後で undefined にクリアされることを確認するため敢えてセット
        disconnectedAt: new Date(0).toISOString(),
      };
      state.conductors.set(conductor.surface, conductor);

      const transcriptPath = await writeTranscript([
        {
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "どちらにしますか?" },
              { type: "tool_use", name: "AskUserQuestion", input: {} },
            ],
          },
        },
      ]);

      await handleMessage(state, {
        type: "SESSION_STOP",
        surface: "surface:c1",
        pid: 999,
        timestamp: fixedTimestamp,
        payload: { transcript_path: transcriptPath },
      });

      // 念のため fire-and-forget の解決待ち
      await new Promise(r => setImmediate(r));

      // conductor 副作用
      expect(conductor.status).toBe("asking");
      expect(conductor.askQuestion).toBe("どちらにしますか?");
      expect(conductor.disconnectedAt).toBeUndefined();
      expect(conductor.lastHookAt).toBe(fixedTimestamp);
      expect(conductor.pid).toBe(999);

      // conductor_asking ログが manager.log に出力されている
      const managerLog = await readFile(
        join(testDir, ".team/logs/manager.log"),
        "utf-8",
      );
      expect(managerLog).toContain("conductor_asking");
      expect(managerLog).toContain("question=どちらにしますか?");

      // Conductor の SESSION_ASK 経路では cmux.notify を呼ばない (Agent との非対称性)
      expect(notifySpy).toHaveBeenCalledTimes(0);
    } finally {
      notifySpy.mockRestore();
    }
  });

  test("T326: Agent / Case A (ASK) → cmux.notify が 1 回呼ばれ title='Agent asking' / subtitle に taskTitle/role が入る", async () => {
    const cmux = await import("./cmux");
    const { spyOn } = await import("bun:test");
    const notifySpy = spyOn(cmux, "notify").mockImplementation(async () => {});

    try {
      const state = await createDaemon(testDir);
      const conductor: ConductorState = {
        surface: "surface:c1",
        startedAt: new Date().toISOString(),
        agents: [
          {
            surface: "surface:a1",
            spawnedAt: new Date().toISOString(),
            status: "running" as const,
            role: "implementer",
            taskTitle: "demo agent task",
          },
        ],
        status: "running",
      };
      state.conductors.set(conductor.surface, conductor);

      const transcriptPath = await writeTranscript([
        {
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "どうしますか?" },
              { type: "tool_use", name: "AskUserQuestion", input: {} },
            ],
          },
        },
      ]);

      await handleMessage(state, {
        type: "SESSION_STOP",
        surface: "surface:a1",
        pid: 123,
        timestamp: new Date().toISOString(),
        payload: { transcript_path: transcriptPath },
      });

      // void cmux.notify(...) は fire-and-forget なのでマイクロタスクの解決を待つ
      await new Promise(r => setImmediate(r));

      expect(notifySpy).toHaveBeenCalledTimes(1);
      const call = notifySpy.mock.calls[0]!;
      expect(call[0]).toBe("surface:a1");
      expect(call[1]).toBe("Agent asking");
      expect(call[2]).toContain("どうしますか?"); // body = truncate(question, 200)
      // subtitle は taskTitle ?? role ?? "Agent" の優先順位で入る (daemon.ts:2224)
      expect(call[3]?.subtitle).toBe("demo agent task");
    } finally {
      notifySpy.mockRestore();
    }
  });
});

describe("updateTeamJson: layout 反映 (T176)", () => {
  test("team.json に layout フィールドが書き込まれる", async () => {
    const state = await createDaemon(testDir, "16x9");
    await updateTeamJson(state);

    const tj = JSON.parse(
      await (await import("fs/promises")).readFile(join(testDir, ".team/team.json"), "utf-8")
    );
    expect(tj.layout).toBe("16x9");
  });

  test("layout=wide でも team.json に反映される", async () => {
    const state = await createDaemon(testDir, "wide");
    await updateTeamJson(state);

    const tj = JSON.parse(
      await (await import("fs/promises")).readFile(join(testDir, ".team/team.json"), "utf-8")
    );
    expect(tj.layout).toBe("wide");
  });
});

describe("loadVersion (T192)", () => {
  test('ルート package.json から "vX.Y.Z" 形式の文字列を返す', async () => {
    const { loadVersion } = await import("./daemon");
    const version = await loadVersion();
    expect(version).toMatch(/^v\d+\.\d+\.\d+/);
  });

  test("createDaemon の初期 state.version は 'v?.?.?' (loadVersion 未呼び出し時)", async () => {
    const { createDaemon } = await import("./daemon");
    const state = await createDaemon(testDir, "wide");
    expect(state.version).toBe("v?.?.?");
  });
});

describe("startMaster restore (T229)", () => {
  const TEST_SURFACE = "surface:42";

  let originalPath: string | undefined;
  beforeEach(() => {
    originalPath = process.env.PATH;
    process.env.PATH = "/nonexistent-cmux-team-test";
  });
  afterEach(() => {
    if (originalPath !== undefined) process.env.PATH = originalPath;
    else delete process.env.PATH;
  });

  async function writeMasterFile(
    surface: string,
    pid: number | undefined,
  ): Promise<void> {
    await mkdir(join(testDir, ".team/masters"), { recursive: true });
    const normalized = surface.replace(/:/g, "_");
    const entry: Record<string, unknown> = {
      surface,
      status: "idle",
      startedAt: new Date().toISOString(),
    };
    if (typeof pid === "number") entry.pid = pid;
    await writeFile(
      join(testDir, ".team/masters", `${normalized}.json`),
      JSON.stringify(entry, null, 2) + "\n",
    );
  }

  async function readManagerLog(): Promise<string> {
    try {
      return await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
    } catch {
      return "";
    }
  }

  function stopWatchers(state: DaemonState): void {
    for (const m of state.masters.values()) {
      if (m.pidWatcherInterval) {
        clearInterval(m.pidWatcherInterval);
        m.pidWatcherInterval = undefined;
      }
    }
    state.running = false;
  }

  test("pid 生存 → Map に 1 個登録、spawn しない", async () => {
    const { __setIsAliveImpl } = await import("./cmux");
    const { startMaster, createDaemon } = await import("./daemon");
    __setIsAliveImpl(() => true);
    let state: DaemonState | null = null;
    try {
      await writeMasterFile(TEST_SURFACE, 12345);
      state = await createDaemon(testDir);

      await startMaster(state);

      expect(state.masters.size).toBe(1);
      const m = state.masters.get(TEST_SURFACE);
      expect(m?.surface).toBe(TEST_SURFACE);
      expect(m?.pid).toBe(12345);
      expect(m?.status).toBe("idle");

      const logContent = await readManagerLog();
      expect(logContent).toContain("master_restored");
      expect(logContent).not.toContain("master_spawning");
    } finally {
      if (state) stopWatchers(state);
      __setIsAliveImpl(null);
    }
  });

  test("pid 死亡 → ファイル discard、新規 spawn を試みる", async () => {
    const { __setIsAliveImpl } = await import("./cmux");
    const { startMaster, createDaemon } = await import("./daemon");
    __setIsAliveImpl(() => false);
    let state: DaemonState | null = null;
    try {
      await writeMasterFile(TEST_SURFACE, 999999);
      state = await createDaemon(testDir);

      await startMaster(state);

      expect(
        existsSync(
          join(testDir, ".team/masters", `${TEST_SURFACE.replace(/:/g, "_")}.json`),
        ),
      ).toBe(false);
      const logContent = await readManagerLog();
      expect(logContent).toContain("master_restore_discarded");
    } finally {
      if (state) stopWatchers(state);
      __setIsAliveImpl(null);
    }
  });

  test("pid 欠落 → ファイル discard、新規 spawn を試みる", async () => {
    const { __setIsAliveImpl } = await import("./cmux");
    const { startMaster, createDaemon } = await import("./daemon");
    __setIsAliveImpl(() => true);
    let state: DaemonState | null = null;
    try {
      await writeMasterFile(TEST_SURFACE, undefined);
      state = await createDaemon(testDir);

      await startMaster(state);

      expect(
        existsSync(
          join(testDir, ".team/masters", `${TEST_SURFACE.replace(/:/g, "_")}.json`),
        ),
      ).toBe(false);
      const logContent = await readManagerLog();
      expect(logContent).toContain("master_restore_discarded");
    } finally {
      if (state) stopWatchers(state);
      __setIsAliveImpl(null);
    }
  });
});

// --- T216: SESSION_ENDED reason=other は state を触らない ---

describe("handleMessage: SESSION_ENDED reason=other (T216)", () => {
  test("reason=other では conductor.status が遷移しない", async () => {
    const { createDaemon, handleMessage } = await import("./daemon");
    const { ConductorState } = await import("./schema");
    void ConductorState;

    const state = await createDaemon(testDir);
    const conductor = {
      surface: "surface:200",
      startedAt: new Date().toISOString(),
      taskRunId: "task-042-1712345678",
      taskId: "42",
      taskTitle: "t216-test",
      agents: [],
      status: "running" as const,
      pid: 99999,
    };
    state.conductors.set(conductor.surface, conductor as any);

    await handleMessage(state, {
      type: "SESSION_ENDED",
      surface: "surface:200",
      reason: "other",
      timestamp: new Date().toISOString(),
    });

    // running のまま（disconnected に遷移しない）
    expect(conductor.status).toBe("running");
    expect((conductor as any).pid).toBe(99999);
    expect((conductor as any).disconnectedAt).toBeUndefined();
  });

  test("reason=logout では従来通り disconnected に遷移する (regression)", async () => {
    const { createDaemon, handleMessage } = await import("./daemon");
    const state = await createDaemon(testDir);
    const conductor = {
      surface: "surface:201",
      startedAt: new Date().toISOString(),
      taskRunId: "task-043-1712345678",
      taskId: "43",
      taskTitle: "t216-regression",
      agents: [],
      status: "running" as const,
      pid: 88888,
    };
    state.conductors.set(conductor.surface, conductor as any);

    await handleMessage(state, {
      type: "SESSION_ENDED",
      surface: "surface:201",
      reason: "logout",
      timestamp: new Date().toISOString(),
    });

    expect((conductor as any).status).toBe("disconnected");
    expect((conductor as any).pid).toBeUndefined();
    expect((conductor as any).disconnectedAt).toBeDefined();
  });

  test("reason=prompt_input_exit も従来通り disconnected に遷移する (regression)", async () => {
    const { createDaemon, handleMessage } = await import("./daemon");
    const state = await createDaemon(testDir);
    const conductor = {
      surface: "surface:202",
      startedAt: new Date().toISOString(),
      taskRunId: "task-044-1712345678",
      taskId: "44",
      taskTitle: "t216-regression-2",
      agents: [],
      status: "running" as const,
      pid: 77777,
    };
    state.conductors.set(conductor.surface, conductor as any);

    await handleMessage(state, {
      type: "SESSION_ENDED",
      surface: "surface:202",
      reason: "prompt_input_exit",
      timestamp: new Date().toISOString(),
    });

    expect((conductor as any).status).toBe("disconnected");
  });
});

describe("handleMessage: CONDUCTOR_REGISTERED (T228)", () => {
  async function readManagerLog(): Promise<string> {
    try {
      return await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
    } catch {
      return "";
    }
  }

  test("新規 surface → state.conductors に set される（status=starting, agents=[]）", async () => {
    const state = await createDaemon(testDir);
    expect(state.conductors.size).toBe(0);

    const ts = new Date().toISOString();
    await handleMessage(state, {
      type: "CONDUCTOR_REGISTERED",
      surface: "surface:100",
      timestamp: ts,
    });

    expect(state.conductors.size).toBe(1);
    const c = state.conductors.get("surface:100");
    expect(c).toBeDefined();
    expect(c!.surface).toBe("surface:100");
    expect(c!.status).toBe("starting");
    expect(c!.startedAt).toBe(ts);
    expect(c!.agents).toEqual([]);

    const logContent = await readManagerLog();
    expect(logContent).toContain("conductor_registered");
  });

  test("既存あり + 同 surface 2 回目 → skip ログ、status/taskId/agents が破壊されない", async () => {
    const state = await createDaemon(testDir);
    // 事前に running + taskId + agents を持つ conductor を配置
    const initialAgents = [
      { surface: "surface:200", startedAt: new Date().toISOString() },
    ];
    state.conductors.set("surface:100", {
      surface: "surface:100",
      status: "running",
      startedAt: "2026-04-17T00:00:00.000Z",
      taskId: "042",
      taskRunId: "task-042-1712345678",
      taskTitle: "preserved-title",
      worktreePath: "/tmp/worktree-042",
      agents: initialAgents as any,
      pid: 12345,
    } as any);

    await handleMessage(state, {
      type: "CONDUCTOR_REGISTERED",
      surface: "surface:100",
      timestamp: new Date().toISOString(),
    });

    // 既存 state が破壊されないこと
    const c = state.conductors.get("surface:100")!;
    expect(c.status).toBe("running");
    expect(c.taskId).toBe("042");
    expect(c.taskRunId).toBe("task-042-1712345678");
    expect(c.taskTitle).toBe("preserved-title");
    expect(c.worktreePath).toBe("/tmp/worktree-042");
    expect(c.agents).toEqual(initialAgents as any);
    expect(c.pid).toBe(12345);

    const logContent = await readManagerLog();
    expect(logContent).toContain("conductor_register_skipped");
    expect(logContent).toContain("reason=already_registered");
    expect(logContent).toContain("existing_status=running");
    expect(logContent).toContain("existing_pid=12345");
  });

  test("state.conductors.size >= state.maxConductors 超過 → warning ログは出るが登録成功", async () => {
    const state = await createDaemon(testDir);
    // wide デフォルト = 3。3 つ登録してから 4 つ目を追加する
    state.conductors.set("surface:1", {
      surface: "surface:1",
      status: "running",
      startedAt: new Date().toISOString(),
      agents: [],
    } as any);
    state.conductors.set("surface:2", {
      surface: "surface:2",
      status: "running",
      startedAt: new Date().toISOString(),
      agents: [],
    } as any);
    state.conductors.set("surface:3", {
      surface: "surface:3",
      status: "running",
      startedAt: new Date().toISOString(),
      agents: [],
    } as any);
    expect(state.conductors.size).toBe(3);
    expect(state.maxConductors).toBe(3);

    await handleMessage(state, {
      type: "CONDUCTOR_REGISTERED",
      surface: "surface:4",
      timestamp: new Date().toISOString(),
    });

    // 登録自体は成功している
    expect(state.conductors.size).toBe(4);
    expect(state.conductors.has("surface:4")).toBe(true);
    const c4 = state.conductors.get("surface:4")!;
    expect(c4.status).toBe("starting");

    const logContent = await readManagerLog();
    expect(logContent).toContain("conductor_register_over_cap");
    expect(logContent).toContain("current=3");
    expect(logContent).toContain("max=3");
  });
});

describe("handleMessage: MASTER_REGISTERED (T230)", () => {
  async function readManagerLog(): Promise<string> {
    try {
      return await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
    } catch {
      return "";
    }
  }

  function stopWatchers(state: DaemonState): void {
    for (const m of state.masters.values()) {
      if (m.pidWatcherInterval) {
        clearInterval(m.pidWatcherInterval);
        m.pidWatcherInterval = undefined;
      }
    }
    state.running = false;
  }

  test("T1: 新規 surface → state.masters に set + .team/masters/<surface>.json 永続化 + master_registered ログ", async () => {
    const state = await createDaemon(testDir);
    expect(state.masters.size).toBe(0);

    const ts = new Date().toISOString();
    try {
      await handleMessage(state, {
        type: "MASTER_REGISTERED",
        surface: "surface:100",
        timestamp: ts,
      });

      expect(state.masters.size).toBe(1);
      const m = state.masters.get("surface:100");
      expect(m).toBeDefined();
      expect(m!.surface).toBe("surface:100");
      expect(m!.status).toBe("starting");
      expect(m!.startedAt).toBe(ts);
      expect(m!.pid).toBeUndefined();

      // 永続ファイル書き込みの確認
      const persistPath = join(testDir, ".team/masters/surface_100.json");
      expect(existsSync(persistPath)).toBe(true);
      const persisted = JSON.parse(await readFile(persistPath, "utf-8"));
      expect(persisted.surface).toBe("surface:100");
      expect(persisted.status).toBe("starting");
      expect(persisted.startedAt).toBe(ts);

      const logContent = await readManagerLog();
      expect(logContent).toContain("master_registered");
      expect(logContent).toContain("U[100]");
      expect(logContent).toContain("pid=none");
    } finally {
      stopWatchers(state);
    }
  });

  test("T2: 既存あり + 同 surface 2 回目 → skip ログ、6 フィールド（surface/pid/status/startedAt/disconnectedAt/prompt）全て保護", async () => {
    const state = await createDaemon(testDir);
    state.masters.set("surface:100", {
      surface: "surface:100",
      status: "running",
      pid: 54321,
      startedAt: "2026-04-17T00:00:00.000Z",
      disconnectedAt: "2026-04-17T01:00:00.000Z",
      prompt: "preserved-prompt",
    });

    try {
      await handleMessage(state, {
        type: "MASTER_REGISTERED",
        surface: "surface:100",
        timestamp: new Date().toISOString(),
      });

      // 6 フィールド全てが破壊されないこと
      const m = state.masters.get("surface:100")!;
      expect(m.surface).toBe("surface:100");
      expect(m.pid).toBe(54321);
      expect(m.status).toBe("running");
      expect(m.startedAt).toBe("2026-04-17T00:00:00.000Z");
      expect(m.disconnectedAt).toBe("2026-04-17T01:00:00.000Z");
      expect(m.prompt).toBe("preserved-prompt");

      const logContent = await readManagerLog();
      expect(logContent).toContain("master_register_skipped");
      expect(logContent).toContain("reason=already_registered");
      expect(logContent).toContain("existing_status=running");
      expect(logContent).toContain("existing_pid=54321");
    } finally {
      stopWatchers(state);
    }
  });

  test("T3: pid 同梱で POST された場合は即時 watcher 起動（第 2 経路）", async () => {
    const { __setIsAliveImpl } = await import("./cmux");
    __setIsAliveImpl(() => true);
    const state = await createDaemon(testDir);
    try {
      const ts = new Date().toISOString();
      await handleMessage(state, {
        type: "MASTER_REGISTERED",
        surface: "surface:101",
        pid: 12345,
        timestamp: ts,
      });

      const m = state.masters.get("surface:101")!;
      expect(m.pid).toBe(12345);
      // watcher が起動していること
      expect(m.pidWatcherInterval).toBeDefined();

      const logContent = await readManagerLog();
      expect(logContent).toContain("master_registered");
      expect(logContent).toContain("pid=12345");
    } finally {
      stopWatchers(state);
      __setIsAliveImpl(null);
    }
  });

  test("T4: SESSION_STARTED が MASTER_REGISTERED より先着した場合、F1 fallback で master として仮登録 + watcher 起動", async () => {
    const { __setIsAliveImpl } = await import("./cmux");
    __setIsAliveImpl(() => true);
    const state = await createDaemon(testDir);
    try {
      const ts = new Date().toISOString();
      // master/conductor/agent いずれにも該当しない surface の SESSION_STARTED
      await handleMessage(state, {
        type: "SESSION_STARTED",
        surface: "surface:200",
        pid: 99999,
        timestamp: ts,
      });

      // F1: master として仮登録される
      expect(state.masters.size).toBe(1);
      const m = state.masters.get("surface:200")!;
      expect(m.status).toBe("starting");
      expect(m.pid).toBe(99999);
      expect(m.startedAt).toBe(ts);
      expect(m.pidWatcherInterval).toBeDefined();

      // 永続化されていること
      expect(
        existsSync(join(testDir, ".team/masters/surface_200.json")),
      ).toBe(true);

      const logContent = await readManagerLog();
      expect(logContent).toContain("master_session_started_fallback");
      expect(logContent).toContain("reason=master_registered_not_received_yet");

      // 後続で MASTER_REGISTERED が届いても skip され、pid/startedAt が破壊されない
      await handleMessage(state, {
        type: "MASTER_REGISTERED",
        surface: "surface:200",
        timestamp: new Date(Date.now() + 1000).toISOString(),
      });
      const m2 = state.masters.get("surface:200")!;
      expect(m2.pid).toBe(99999);
      expect(m2.startedAt).toBe(ts);
      expect(m2.status).toBe("starting");

      const log2 = await readManagerLog();
      expect(log2).toContain("master_register_skipped");
    } finally {
      stopWatchers(state);
      __setIsAliveImpl(null);
    }
  });

  test("T5: SESSION_STARTED が既存 master entry に対して届いた場合、status=idle 遷移 + pid 更新（既存経路の維持）", async () => {
    const { __setIsAliveImpl } = await import("./cmux");
    __setIsAliveImpl(() => true);
    const state = await createDaemon(testDir);
    try {
      // 先に MASTER_REGISTERED
      await handleMessage(state, {
        type: "MASTER_REGISTERED",
        surface: "surface:300",
        timestamp: new Date().toISOString(),
      });
      const before = state.masters.get("surface:300")!;
      expect(before.status).toBe("starting");
      expect(before.pid).toBeUndefined();

      // 後続で SESSION_STARTED（pid 付き）
      await handleMessage(state, {
        type: "SESSION_STARTED",
        surface: "surface:300",
        pid: 77777,
        timestamp: new Date().toISOString(),
      });

      const after = state.masters.get("surface:300")!;
      expect(after.status).toBe("idle");
      expect(after.pid).toBe(77777);
      expect(after.pidWatcherInterval).toBeDefined();
    } finally {
      stopWatchers(state);
      __setIsAliveImpl(null);
    }
  });

  test("T6: proxy-port 変化時に全 Master が state と永続ファイルから除去される（縮退テスト）", async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = "/nonexistent-cmux-team-test";
    const { __setIsAliveImpl } = await import("./cmux");
    __setIsAliveImpl(() => true);
    const { startMaster } = await import("./daemon");
    const state = await createDaemon(testDir);
    try {
      // 既存の Master 2 件を永続ファイルごと配置して restore 経路を走らせる
      await mkdir(join(testDir, ".team/masters"), { recursive: true });
      await writeFile(
        join(testDir, ".team/masters/surface_400.json"),
        JSON.stringify({
          surface: "surface:400",
          status: "idle",
          pid: 11111,
          startedAt: new Date().toISOString(),
        }, null, 2),
      );
      await writeFile(
        join(testDir, ".team/masters/surface_401.json"),
        JSON.stringify({
          surface: "surface:401",
          status: "idle",
          pid: 22222,
          startedAt: new Date().toISOString(),
        }, null, 2),
      );
      state.proxyPortChanged = true;
      state.proxyPort = 19999;

      // restoreMasters → proxyPortChanged 分岐 → 全 Master を remove
      //   spawn は PATH 不在により失敗する（cmux コマンドが見つからない）が、
      //   縮退テストとして remove 完了までを検証する。
      await startMaster(state);

      // 2 件とも state から除去される
      expect(state.masters.size).toBe(0);
      // 永続ファイルも削除されている
      expect(
        existsSync(join(testDir, ".team/masters/surface_400.json")),
      ).toBe(false);
      expect(
        existsSync(join(testDir, ".team/masters/surface_401.json")),
      ).toBe(false);
      // フラグがリセットされている
      expect(state.proxyPortChanged).toBe(false);

      const logContent = await readManagerLog();
      expect(logContent).toContain("master_respawn_proxy_changed");
    } finally {
      stopWatchers(state);
      __setIsAliveImpl(null);
      if (originalPath !== undefined) process.env.PATH = originalPath;
      else delete process.env.PATH;
    }
  });
});
// --- T232: assigning state による daemon-clear と user-clear の分離 ---

describe("handleMessage: assigning 中の SESSION_CLEAR (T232)", () => {
  test("assigning + SESSION_CLEAR → task-state.json は変更されず status も保持", async () => {
    const state = await createDaemon(testDir);
    const conductor: ConductorState = {
      surface: "surface:232a",
      startedAt: new Date().toISOString(),
      agents: [],
      status: "assigning",
      pid: 44444,
      taskRunId: "task-232-x",
      taskId: "232",
    };
    state.conductors.set(conductor.surface, conductor);

    // task-state を assigned 状態にしておく（ユーザー手動 /clear では aborted に書き換わる）
    const { saveTaskState, loadTaskState } = await import("./task");
    const before = await loadTaskState(testDir);
    before["232"] = { status: "assigned", assignedAt: new Date().toISOString(), taskRunId: "task-232-x" };
    await saveTaskState(testDir, before);

    await handleMessage(state, {
      type: "SESSION_CLEAR",
      surface: "surface:232a",
      timestamp: new Date().toISOString(),
    });

    // status は assigning のまま（ユーザー手動 clear 誤認を防止）
    expect(conductor.status).toBe("assigning");
    // pid も保持される（running 分岐の pid=undefined には到達しない）
    expect(conductor.pid).toBe(44444);

    // task-state は assigned のまま（aborted に書き換わらない）
    const after = await loadTaskState(testDir);
    expect(after["232"]?.status).toBe("assigned");
    expect(after["232"]?.abortedAt).toBeUndefined();
  });

  test("running + SESSION_CLEAR は従来通り task_aborted 記録（回帰防止）", async () => {
    const state = await createDaemon(testDir);
    const conductor: ConductorState = {
      surface: "surface:232b",
      startedAt: new Date().toISOString(),
      agents: [],
      status: "running",
      pid: 55555,
      taskRunId: "task-233-y",
      taskId: "233",
    };
    state.conductors.set(conductor.surface, conductor);

    const { saveTaskState, loadTaskState } = await import("./task");
    const before = await loadTaskState(testDir);
    before["233"] = { status: "assigned", assignedAt: new Date().toISOString(), taskRunId: "task-233-y" };
    await saveTaskState(testDir, before);

    await handleMessage(state, {
      type: "SESSION_CLEAR",
      surface: "surface:232b",
      timestamp: new Date().toISOString(),
    });

    // user_clear として扱われるため aborted に書き換わる
    const after = await loadTaskState(testDir);
    expect(after["233"]?.status).toBe("aborted");
    expect(after["233"]?.abortedAt).toBeDefined();
    expect(after["233"]?.journal).toContain("user_clear");
  });
});

describe("handleMessage: assigning → running 遷移 (T232)", () => {
  test("assigning + SESSION_STARTED(source=clear) で running に遷移 / pid 更新", async () => {
    const state = await createDaemon(testDir);
    const conductor: ConductorState = {
      surface: "surface:232c",
      startedAt: new Date().toISOString(),
      agents: [],
      status: "assigning",
      taskRunId: "task-234-z",
      taskId: "234",
    };
    state.conductors.set(conductor.surface, conductor);

    await handleMessage(state, {
      type: "SESSION_STARTED",
      surface: "surface:232c",
      pid: 66666,
      source: "clear",
      timestamp: new Date().toISOString(),
    });

    expect(conductor.status).toBe("running");
    expect(conductor.pid).toBe(66666);

    // クリーンアップ（PID watcher 停止）
    if (conductor.pidWatcherInterval) {
      clearInterval(conductor.pidWatcherInterval);
      conductor.pidWatcherInterval = undefined;
    }
  });

  // T277: SESSION_IDLE R1 分岐撤去（SESSION_ACTIVE R1 は現状維持）
  test("SESSION_IDLE(assigning+taskRunId) で R1 は発火しない — status は assigning のまま (T277)", async () => {
    const state = await createDaemon(testDir);
    const conductor: ConductorState = {
      surface: "surface:277a",
      startedAt: new Date().toISOString(),
      agents: [],
      status: "assigning",
      taskRunId: "task-277-a",
      taskId: "277a",
    };
    state.conductors.set(conductor.surface, conductor);

    await handleMessage(state, {
      type: "SESSION_IDLE",
      surface: conductor.surface,
      pid: 77701,
      timestamp: new Date().toISOString(),
    });

    // status は assigning のまま（R1 発火しない）
    expect(conductor.status).toBe("assigning");
    // session_idle ログは出る（観測用）
    const logContent = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
    expect(logContent).toMatch(/session_idle C\[277a\]/);
    // assigning_window_close via=SESSION_IDLE は出ない
    expect(logContent).not.toMatch(/assigning_window_close C\[277a\] via=SESSION_IDLE/);
    // conductor_running via=SESSION_IDLE も出ない
    expect(logContent).not.toMatch(/conductor_running C\[277a\] via=SESSION_IDLE/);
  });

  // T277 regression: T276 race 事例の忠実再現
  test("daemon /clear 由来 SESSION_IDLE が SESSION_CLEAR より先着しても task が abort されない (T277 regression)", async () => {
    const state = await createDaemon(testDir);
    const clearSentAt  = "2026-04-20T17:18:58.000Z";
    const promptSentAt = "2026-04-20T17:18:58.200Z"; // clearSentAt + 200ms（T276 事例を忠実再現）
    const idleAt       = "2026-04-20T17:19:00.000Z"; // clearSentAt + 2s → source_guess=clear_transient
    const clearAt      = "2026-04-20T17:19:01.000Z";
    const startedAt    = "2026-04-20T17:19:03.000Z";

    const conductor: ConductorState = {
      surface: "surface:277b",
      startedAt: "2026-04-20T17:18:57.000Z",
      agents: [],
      status: "assigning",
      taskRunId: "task-277-b",
      taskId: "277b",
      clearSentAt,
      promptSentAt,
    };
    state.conductors.set(conductor.surface, conductor);

    // ① SESSION_IDLE 先着（R1 が発火しない → assigning 維持）
    await handleMessage(state, {
      type: "SESSION_IDLE",
      surface: conductor.surface,
      pid: 77702,
      timestamp: idleAt,
    });
    expect(conductor.status).toBe("assigning");

    // ② SESSION_CLEAR 後着（status=assigning なので daemon_assign_clear で早期 break）
    await handleMessage(state, {
      type: "SESSION_CLEAR",
      surface: conductor.surface,
      pid: 77702,
      timestamp: clearAt,
    });
    expect(conductor.status).toBe("assigning"); // まだ assigning のまま

    // ③ SESSION_STARTED(source=clear) で正規経路 → running
    await handleMessage(state, {
      type: "SESSION_STARTED",
      surface: conductor.surface,
      pid: 77702,
      source: "clear",
      timestamp: startedAt,
    });
    expect(conductor.status).toBe("running");

    // task_aborted reason=user_clear が出ていないこと
    const logContent = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
    expect(logContent).not.toMatch(/task_aborted.*reason=user_clear/);
    expect(logContent).toMatch(/session_clear_expected .*reason=daemon_assign_clear/);
    // source_guess=clear_transient が記録される（T276 事例の忠実再現を assertion で担保）
    expect(logContent).toMatch(/session_idle_source_guess=clear_transient/);

    // PID watcher 停止
    if (conductor.pidWatcherInterval) {
      clearInterval(conductor.pidWatcherInterval);
      conductor.pidWatcherInterval = undefined;
    }
  });

  test("R1: assigning + SESSION_ACTIVE(taskRunId あり) で running に遷移する", async () => {
    const state = await createDaemon(testDir);
    const conductor: ConductorState = {
      surface: "surface:232e",
      startedAt: new Date().toISOString(),
      agents: [],
      status: "assigning",
      taskRunId: "task-236-b",
      taskId: "236",
    };
    state.conductors.set(conductor.surface, conductor);

    await handleMessage(state, {
      type: "SESSION_ACTIVE",
      surface: "surface:232e",
      pid: 88888,
      timestamp: new Date().toISOString(),
    });

    expect(conductor.status).toBe("running");
    expect(conductor.pid).toBe(88888);
  });
});

describe("monitorConductors: assigning timeout (T232)", () => {
  test("assigning のまま 60 秒経過で disconnected に遷移する", async () => {
    const state = await createDaemon(testDir);
    // startedAt を 61 秒前にして即時 timeout 判定
    const past = new Date(Date.now() - 61_000).toISOString();
    const conductor: ConductorState = {
      surface: "surface:232f",
      startedAt: past,
      agents: [],
      status: "assigning",
      taskRunId: "task-237-c",
      taskId: "237",
    };
    state.conductors.set(conductor.surface, conductor);

    await monitorConductors(state);

    expect(conductor.status).toBe("disconnected");
    expect(conductor.disconnectedAt).toBeDefined();
  });

  test("assigning で 60 秒未満なら状態を維持（未 timeout）", async () => {
    const state = await createDaemon(testDir);
    // startedAt を 10 秒前（< 60s）
    const recent = new Date(Date.now() - 10_000).toISOString();
    const conductor: ConductorState = {
      surface: "surface:232g",
      startedAt: recent,
      agents: [],
      status: "assigning",
      taskRunId: "task-238-d",
      taskId: "238",
    };
    state.conductors.set(conductor.surface, conductor);

    await monitorConductors(state);

    // assigning のまま
    expect(conductor.status).toBe("assigning");
    expect(conductor.disconnectedAt).toBeUndefined();
  });
});

// T302-race: /clear 送信成功後に SESSION_ENDED race で conductor が disconnected に → タスクは ready のまま
describe("scanTasks: SESSION_ENDED race — assignTask 中に session が死んだ場合 (T302-race)", () => {
  test("sleep 中に conductor.status が disconnected → タスクは ready のまま + conductor は disconnected", async () => {
    const { execFile: execFileCb } = await import("child_process");
    const { promisify } = await import("util");
    const execFile = promisify(execFileCb);
    await execFile("git", ["init", "-q", "-b", "main"], { cwd: testDir });
    await execFile("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "init"], { cwd: testDir });

    await createTask("302", "race-task");

    const cmux = await import("./cmux");
    const { spyOn } = await import("bun:test");

    // conductor への参照を保持してスパイ内から変異させる
    let conductorRef: ConductorState | undefined;
    let sendCallCount = 0;
    const sendSpy = spyOn(cmux, "send").mockImplementation(async (_surface, _text) => {
      sendCallCount++;
      if (sendCallCount === 1 && conductorRef) {
        // 1 回目 (/clear) 送信完了直後に SESSION_ENDED race を模倣:
        // daemon の handleMessage が SESSION_ENDED を処理して disconnected にする
        conductorRef.status = "disconnected";
      }
    });
    const sendKeySpy = spyOn(cmux, "sendKey").mockImplementation(async () => {});

    try {
      const state = await createDaemon(testDir);
      state.mainBranch = "main"; // T302-race: assignTask の fail-stop を回避して cmux.send まで進める
      conductorRef = {
        surface: "surface:302r",
        startedAt: new Date().toISOString(),
        agents: [],
        status: "idle",
      };
      state.conductors.set(conductorRef.surface, conductorRef);

      await scanTasks(state);

      // race guard が発火 → AssignTaskError(conductor) → scanTasks が disconnected に倒す
      expect(conductorRef.status).toBe("disconnected");
      expect(conductorRef.disconnectedAt).toBeDefined();

      // send は /clear の 1 回だけ（race guard でプロンプト送信がブロックされた）
      expect(sendCallCount).toBe(1);

      // タスクは "ready" のまま（applyAssignCommit が呼ばれていない）
      const { loadTaskState } = await import("./task");
      const ts = await loadTaskState(testDir);
      expect(ts["302"]?.status ?? "ready").toBe("ready");
    } finally {
      sendSpy.mockRestore();
      sendKeySpy.mockRestore();
    }
  }, 30000);
});

// R4 (b): assignTask 中に /clear 送信失敗 → AssignTaskError("conductor") → disconnected
describe("scanTasks: /clear 送信失敗時の conductor disconnected (T232 R4)", () => {
  test("cmux.send で例外 → AssignTaskError(conductor) → idleConductor.status === 'disconnected'", async () => {
    const { execFile: execFileCb } = await import("child_process");
    const { promisify } = await import("util");
    const execFile = promisify(execFileCb);
    await execFile("git", ["init", "-q", "-b", "main"], { cwd: testDir });
    await execFile("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "init"], { cwd: testDir });

    await createTask("239", "clear-fail");

    const cmux = await import("./cmux");
    const { spyOn } = await import("bun:test");
    const sendSpy = spyOn(cmux, "send").mockImplementation(async () => {
      throw new Error("injected cmux send failure");
    });
    const sendKeySpy = spyOn(cmux, "sendKey").mockImplementation(async () => {});

    try {
      const state = await createDaemon(testDir);
      const idleConductor: ConductorState = {
        surface: "surface:232h",
        startedAt: new Date().toISOString(),
        agents: [],
        status: "idle",
      };
      state.conductors.set(idleConductor.surface, idleConductor);

      await scanTasks(state);

      // conductor kind の AssignTaskError → disconnected に倒される
      expect(idleConductor.status).toBe("disconnected");
      expect(idleConductor.disconnectedAt).toBeDefined();
    } finally {
      sendSpy.mockRestore();
      sendKeySpy.mockRestore();
    }
  }, 30000);
});

describe("handleMessage: AGENT_SPAWNED master fallback cleanup (T244)", () => {
  async function readManagerLog(): Promise<string> {
    try {
      return await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
    } catch {
      return "";
    }
  }

  function stopWatchers(state: DaemonState): void {
    for (const m of state.masters.values()) {
      if (m.pidWatcherInterval) {
        clearInterval(m.pidWatcherInterval);
        m.pidWatcherInterval = undefined;
      }
    }
    state.running = false;
  }

  test("fallback=true の master が存在する場合、AGENT_SPAWNED で master を掃除し conductor.agents に追加する", async () => {
    const state = await createDaemon(testDir);

    // 事前条件: SESSION_STARTED fallback 経由で master 仮登録された surface:500 がある
    state.masters.set("surface:500", {
      surface: "surface:500",
      status: "starting",
      startedAt: new Date().toISOString(),
      pid: 99999,
      fallback: true,
    });
    // 対応する conductor を事前登録
    state.conductors.set("surface:100", {
      surface: "surface:100",
      status: "running",
      startedAt: new Date().toISOString(),
      agents: [],
    } as any);

    try {
      await handleMessage(state, {
        type: "AGENT_SPAWNED",
        conductorSurface: "surface:100",
        surface: "surface:500",
        role: "inspector",
        taskTitle: "test task",
        timestamp: new Date().toISOString(),
      });

      // master 仮登録が削除されている
      expect(state.masters.has("surface:500")).toBe(false);
      // conductor の agents に追加されている
      const c = state.conductors.get("surface:100")!;
      expect(c.agents.length).toBe(1);
      expect(c.agents[0]!.surface).toBe("surface:500");
      expect(c.agents[0]!.role).toBe("inspector");

      // 掃除ログが記録されている
      const logContent = await readManagerLog();
      expect(logContent).toContain("master_fallback_cleanup");
      expect(logContent).toContain("reason=agent_spawned_late");
      expect(logContent).toContain("agent_spawned");
    } finally {
      stopWatchers(state);
    }
  });

  test("fallback=false(本物の master) が存在する場合、AGENT_SPAWNED で master は削除しない", async () => {
    const state = await createDaemon(testDir);

    // 実在の master として surface:500 が登録されている（fallback ではなく MASTER_REGISTERED 経由）
    state.masters.set("surface:500", {
      surface: "surface:500",
      status: "idle",
      startedAt: new Date().toISOString(),
      pid: 99999,
      // fallback flag 無し
    });
    state.conductors.set("surface:100", {
      surface: "surface:100",
      status: "running",
      startedAt: new Date().toISOString(),
      agents: [],
    } as any);

    try {
      await handleMessage(state, {
        type: "AGENT_SPAWNED",
        conductorSurface: "surface:100",
        surface: "surface:500",
        role: "inspector",
        taskTitle: "test task",
        timestamp: new Date().toISOString(),
      });

      // 本物の master は削除されない
      expect(state.masters.has("surface:500")).toBe(true);

      // 掃除ログは出ない
      const logContent = await readManagerLog();
      expect(logContent).not.toContain("master_fallback_cleanup");
    } finally {
      stopWatchers(state);
    }
  });

  test("master 未登録の通常経路では AGENT_SPAWNED は normally conductor.agents に追加されるだけ", async () => {
    const state = await createDaemon(testDir);
    state.conductors.set("surface:100", {
      surface: "surface:100",
      status: "running",
      startedAt: new Date().toISOString(),
      agents: [],
    } as any);

    try {
      await handleMessage(state, {
        type: "AGENT_SPAWNED",
        conductorSurface: "surface:100",
        surface: "surface:500",
        role: "inspector",
        taskTitle: "test task",
        timestamp: new Date().toISOString(),
      });

      expect(state.masters.size).toBe(0);
      const c = state.conductors.get("surface:100")!;
      expect(c.agents.length).toBe(1);
      expect(c.agents[0]!.surface).toBe("surface:500");
    } finally {
      stopWatchers(state);
    }
  });
});

describe("depends_on cascade on parent abort/delete (T241)", () => {
  test("ケース1: 親 abort → 子 ready が draft に戻る（journal 追記）", async () => {
    await createTask("1", "parent", { status: "ready" });
    await createTask("2", "child", { dependsOn: ["1"], status: "ready" });

    const { loadTaskState, saveTaskState, cascadeAbortToChildren } = await import("./task");
    const { tasks: loadedTasks } = await loadTasks(testDir);
    const ts = await loadTaskState(testDir);
    ts["1"] = { status: "aborted", abortedAt: new Date().toISOString(), journal: "test" };
    const result = cascadeAbortToChildren(ts, loadedTasks, "1");
    await saveTaskState(testDir, ts);

    expect(result.revertedChildren).toEqual(["2"]);
    const after = await loadTaskState(testDir);
    expect(after["2"]?.status).toBe("draft");
    expect(after["2"]?.journal).toBe("parent_aborted: 1");
  });

  test("ケース2: 親 abort → 子 assigned は維持（走行中の作業は止めない）", async () => {
    await createTask("10", "parent");
    await createTask("11", "child", { dependsOn: ["10"] });
    {
      const { saveTaskState, loadTaskState } = await import("./task");
      const ts = await loadTaskState(testDir);
      ts["11"] = { status: "assigned", assignedAt: new Date().toISOString() };
      await saveTaskState(testDir, ts);
    }

    const { loadTaskState, saveTaskState, cascadeAbortToChildren } = await import("./task");
    const { tasks: loadedTasks } = await loadTasks(testDir);
    const ts = await loadTaskState(testDir);
    ts["10"] = { status: "aborted", abortedAt: new Date().toISOString() };
    const result = cascadeAbortToChildren(ts, loadedTasks, "10");
    await saveTaskState(testDir, ts);

    expect(result.revertedChildren).toEqual([]);
    const after = await loadTaskState(testDir);
    expect(after["11"]?.status).toBe("assigned");
  });

  test("ケース3: 親 delete → 子 ready が draft に戻る", async () => {
    await createTask("20", "parent");
    await createTask("21", "child", { dependsOn: ["20"] });

    const { loadTaskState, saveTaskState, cascadeAbortToChildren } = await import("./task");
    const { tasks: loadedTasks } = await loadTasks(testDir);
    const ts = await loadTaskState(testDir);
    ts["20"] = { status: "deleted", deletedAt: new Date().toISOString() };
    const result = cascadeAbortToChildren(ts, loadedTasks, "20");
    await saveTaskState(testDir, ts);

    expect(result.revertedChildren).toEqual(["21"]);
    const after = await loadTaskState(testDir);
    expect(after["21"]?.status).toBe("draft");
    expect(after["21"]?.journal).toBe("parent_aborted: 20");
  });

  test("ケース4: 複数 depends_on のうち 1 つが abort でも draft に戻る", async () => {
    await createTask("30", "parent-a");
    await createTask("31", "parent-b");
    await createTask("32", "child", { dependsOn: ["30", "31"] });

    const { loadTaskState, saveTaskState, cascadeAbortToChildren } = await import("./task");
    const { tasks: loadedTasks } = await loadTasks(testDir);
    const ts = await loadTaskState(testDir);
    ts["30"] = { status: "aborted", abortedAt: new Date().toISOString() };
    const result = cascadeAbortToChildren(ts, loadedTasks, "30");
    await saveTaskState(testDir, ts);

    expect(result.revertedChildren).toEqual(["32"]);
    const after = await loadTaskState(testDir);
    expect(after["32"]?.status).toBe("draft");
    // もう片方の親 "31" は ready のまま
    expect(after["31"]?.status).toBe("ready");
  });

  test("ケース5: 孫世代 A→B→C で A abort → B=ready は draft、C は変化なし", async () => {
    await createTask("40", "task-A");
    await createTask("41", "task-B", { dependsOn: ["40"] });
    await createTask("42", "task-C", { dependsOn: ["41"] });

    const { loadTaskState, saveTaskState, cascadeAbortToChildren } = await import("./task");
    const { tasks: loadedTasks } = await loadTasks(testDir);
    const ts = await loadTaskState(testDir);
    ts["40"] = { status: "aborted", abortedAt: new Date().toISOString() };
    const result = cascadeAbortToChildren(ts, loadedTasks, "40");
    await saveTaskState(testDir, ts);

    // 直接の子 B のみ revert、C は A の直接の子ではないので変化なし
    expect(result.revertedChildren).toEqual(["41"]);
    const after = await loadTaskState(testDir);
    expect(after["41"]?.status).toBe("draft");
    expect(after["42"]?.status).toBe("ready");
  });

  test("ケース6（回帰）: 親 closed → 子 ready は filterExecutableTasks で拾われる", async () => {
    await createTask("50", "parent");
    await createTask("51", "child", { dependsOn: ["50"] });

    await closeTask("50");
    const { tasks: loadedTasks, taskState } = await loadTasks(testDir);
    const closed = new Set(
      Object.entries(taskState)
        .filter(([_, s]) => s.status === "closed")
        .map(([id]) => id)
    );
    const open = loadedTasks.filter(t => t.status !== "closed");
    const executable = filterExecutableTasks(open, closed, new Set());
    expect(executable.map(t => t.id)).toContain("51");
  });

  test("E2E: assign_failed 経路（git 未初期化）で親 abort → 子 ready が draft に戻る", async () => {
    // 親タスクは assign に失敗して aborted → cascade 発動で子 ready が draft に戻る
    await createTask("60", "parent-failing", { priority: "high" });
    await createTask("61", "child", { dependsOn: ["60"], status: "ready" });

    const state = await createDaemon(testDir);
    // T253: 本番では cmdStart が state.mainBranch を解決済み。テストは git 失敗の
    // 分類テストなので、assignTask が mainBranch empty で早期 throw しないよう明示セット。
    state.mainBranch = "main";
    const fakeConductor: ConductorState = {
      surface: "surface:fake-c241",
      startedAt: new Date().toISOString(),
      agents: [],
      status: "idle",
    };
    state.conductors.set(fakeConductor.surface, fakeConductor);

    await scanTasks(state);

    // 親は assign_failed で aborted
    const { loadTaskState } = await import("./task");
    const ts = await loadTaskState(testDir);
    expect(ts["60"]?.status).toBe("aborted");
    expect(ts["60"]?.journal).toContain("assign_failed");

    // 子は cascade で draft に戻される
    expect(ts["61"]?.status).toBe("draft");
    expect(ts["61"]?.journal).toBe("parent_aborted: 60");
  });
});

// --- T250: broken status テスト ---
describe("T250 broken status", () => {
  test("broken Conductor は scanTasks の割当候補から除外される", async () => {
    await createTask("250", "ready-task", { status: "ready" });

    const state = await createDaemon(testDir);
    const brokenConductor: ConductorState = {
      surface: "surface:broken-1",
      startedAt: new Date().toISOString(),
      disconnectedAt: new Date().toISOString(),
      agents: [],
      status: "broken",
    };
    state.conductors.set(brokenConductor.surface, brokenConductor);

    await scanTasks(state);

    // broken のまま
    expect(brokenConductor.status).toBe("broken");
    // タスクは ready のまま（broken に assign されない）
    const { loadTaskState } = await import("./task");
    const ts = await loadTaskState(testDir);
    expect(ts["250"]?.status).toBe("ready");
  });

  test("broken Conductor は SESSION_STARTED で idle に戻らない (source=startup)", async () => {
    const state = await createDaemon(testDir);
    const conductor: ConductorState = {
      surface: "surface:broken-ss1",
      startedAt: new Date().toISOString(),
      disconnectedAt: new Date().toISOString(),
      agents: [],
      status: "broken",
    };
    state.conductors.set(conductor.surface, conductor);

    await handleMessage(state, {
      type: "SESSION_STARTED",
      surface: conductor.surface,
      pid: 99001,
      sessionId: "uuid-bss1",
      source: "startup",
      timestamp: new Date().toISOString(),
    });

    expect(conductor.status).toBe("broken");
  });

  test("broken Conductor は SESSION_STARTED で idle に戻らない (source=resume)", async () => {
    const state = await createDaemon(testDir);
    const conductor: ConductorState = {
      surface: "surface:broken-ss2",
      startedAt: new Date().toISOString(),
      disconnectedAt: new Date().toISOString(),
      agents: [],
      status: "broken",
    };
    state.conductors.set(conductor.surface, conductor);

    await handleMessage(state, {
      type: "SESSION_STARTED",
      surface: conductor.surface,
      pid: 99002,
      sessionId: "uuid-bss2",
      source: "resume",
      timestamp: new Date().toISOString(),
    });

    expect(conductor.status).toBe("broken");
  });

  test("broken Conductor は SESSION_STARTED で idle に戻らない (source=clear)", async () => {
    const state = await createDaemon(testDir);
    const conductor: ConductorState = {
      surface: "surface:broken-ss3",
      startedAt: new Date().toISOString(),
      disconnectedAt: new Date().toISOString(),
      agents: [],
      status: "broken",
    };
    state.conductors.set(conductor.surface, conductor);

    await handleMessage(state, {
      type: "SESSION_STARTED",
      surface: conductor.surface,
      pid: 99003,
      sessionId: "uuid-bss3",
      source: "clear",
      timestamp: new Date().toISOString(),
    });

    expect(conductor.status).toBe("broken");
  });

  test("broken Conductor は SESSION_STARTED で idle に戻らない (source=compact)", async () => {
    const state = await createDaemon(testDir);
    const conductor: ConductorState = {
      surface: "surface:broken-ss4",
      startedAt: new Date().toISOString(),
      disconnectedAt: new Date().toISOString(),
      agents: [],
      status: "broken",
    };
    state.conductors.set(conductor.surface, conductor);

    await handleMessage(state, {
      type: "SESSION_STARTED",
      surface: conductor.surface,
      pid: 99004,
      sessionId: "uuid-bss4",
      source: "compact",
      timestamp: new Date().toISOString(),
    });

    expect(conductor.status).toBe("broken");
  });

  test("broken Conductor は SESSION_ACTIVE で idle に戻らない", async () => {
    const state = await createDaemon(testDir);
    const conductor: ConductorState = {
      surface: "surface:broken-sa",
      startedAt: new Date().toISOString(),
      disconnectedAt: new Date().toISOString(),
      agents: [],
      status: "broken",
    };
    state.conductors.set(conductor.surface, conductor);

    await handleMessage(state, {
      type: "SESSION_ACTIVE",
      surface: conductor.surface,
      timestamp: new Date().toISOString(),
    });

    expect(conductor.status).toBe("broken");
  });

  test("broken Conductor は SESSION_IDLE で idle に戻らない", async () => {
    const state = await createDaemon(testDir);
    const conductor: ConductorState = {
      surface: "surface:broken-si",
      startedAt: new Date().toISOString(),
      disconnectedAt: new Date().toISOString(),
      agents: [],
      status: "broken",
    };
    state.conductors.set(conductor.surface, conductor);

    await handleMessage(state, {
      type: "SESSION_IDLE",
      surface: conductor.surface,
      timestamp: new Date().toISOString(),
    });

    expect(conductor.status).toBe("broken");
  });

  test("broken Conductor は SESSION_CLEAR で idle に戻らない", async () => {
    const state = await createDaemon(testDir);
    const conductor: ConductorState = {
      surface: "surface:broken-sc",
      startedAt: new Date().toISOString(),
      disconnectedAt: new Date().toISOString(),
      agents: [],
      status: "broken",
    };
    state.conductors.set(conductor.surface, conductor);

    await handleMessage(state, {
      type: "SESSION_CLEAR",
      surface: conductor.surface,
      timestamp: new Date().toISOString(),
    });

    expect(conductor.status).toBe("broken");
  });

  test("CONDUCTOR_CLEAR で broken Conductor が idle に戻る（正常経路）", async () => {
    // T251: clear-conductor 経由で idle に戻す正常経路では surface は実在するため
    //       getPaneForSurface を存在ケースでモックする。
    const cmux = await import("./cmux");
    const { spyOn } = await import("bun:test");
    const paneSpy = spyOn(cmux, "getPaneForSurface").mockResolvedValue("pane:1");
    try {
      const state = await createDaemon(testDir);
      const conductor: ConductorState = {
        surface: "surface:broken-cc1",
        startedAt: new Date().toISOString(),
        disconnectedAt: new Date().toISOString(),
        agents: [],
        status: "broken",
      };
      state.conductors.set(conductor.surface, conductor);

      await handleMessage(state, {
        type: "CONDUCTOR_CLEAR",
        surface: conductor.surface,
        reason: "user_clear",
        timestamp: new Date().toISOString(),
      });

      expect(conductor.status).toBe("idle");
      expect(conductor.disconnectedAt).toBeUndefined();
      expect(conductor.taskRunId).toBeUndefined();
    } finally {
      paneSpy.mockRestore();
    }
  });

  test("CONDUCTOR_CLEAR が idle Conductor に来ても無視される", async () => {
    const state = await createDaemon(testDir);
    const conductor: ConductorState = {
      surface: "surface:idle-cc",
      startedAt: new Date().toISOString(),
      agents: [],
      status: "idle",
    };
    state.conductors.set(conductor.surface, conductor);

    await handleMessage(state, {
      type: "CONDUCTOR_CLEAR",
      surface: conductor.surface,
      reason: "user_clear",
      timestamp: new Date().toISOString(),
    });

    expect(conductor.status).toBe("idle");
  });

  test("CONDUCTOR_CLEAR が running Conductor に来ても無視される", async () => {
    const state = await createDaemon(testDir);
    const conductor: ConductorState = {
      surface: "surface:running-cc",
      startedAt: new Date().toISOString(),
      taskRunId: "task-1-xxx",
      taskId: "1",
      agents: [],
      status: "running",
    };
    state.conductors.set(conductor.surface, conductor);

    await handleMessage(state, {
      type: "CONDUCTOR_CLEAR",
      surface: conductor.surface,
      reason: "user_clear",
      timestamp: new Date().toISOString(),
    });

    expect(conductor.status).toBe("running");
    expect(conductor.taskRunId).toBe("task-1-xxx");
  });

  test("CONDUCTOR_CLEAR が disconnected Conductor に来ても無視される", async () => {
    const state = await createDaemon(testDir);
    const conductor: ConductorState = {
      surface: "surface:disc-cc",
      startedAt: new Date().toISOString(),
      disconnectedAt: new Date().toISOString(),
      taskRunId: "task-2-xxx",
      taskId: "2",
      agents: [],
      status: "disconnected",
    };
    state.conductors.set(conductor.surface, conductor);

    await handleMessage(state, {
      type: "CONDUCTOR_CLEAR",
      surface: conductor.surface,
      reason: "user_clear",
      timestamp: new Date().toISOString(),
    });

    expect(conductor.status).toBe("disconnected");
  });

  test("CONDUCTOR_CLEAR が未登録 surface に来ても無視される (not_found)", async () => {
    const state = await createDaemon(testDir);
    // 何も登録しない

    await handleMessage(state, {
      type: "CONDUCTOR_CLEAR",
      surface: "surface:ghost",
      reason: "user_clear",
      timestamp: new Date().toISOString(),
    });

    expect(state.conductors.has("surface:ghost")).toBe(false);
  });

  test("team.json round-trip: broken Conductor を書き出して読み戻しても broken のまま (ST-14)", async () => {
    const state = await createDaemon(testDir);
    const brokenSurface = "surface:broken-rt";
    const brokenDisconnectedAt = "2026-04-18T10:00:00.000Z";
    const conductor: ConductorState = {
      surface: brokenSurface,
      startedAt: "2026-04-18T09:00:00.000Z",
      disconnectedAt: brokenDisconnectedAt,
      agents: [],
      status: "broken",
      sessionId: "uuid-broken-rt",
    };
    state.conductors.set(brokenSurface, conductor);

    await updateTeamJson(state);

    const raw = await readFile(join(testDir, ".team/team.json"), "utf-8");
    const json = JSON.parse(raw);
    const persisted = (json.conductors ?? []).find((c: any) => c.surface === brokenSurface);
    expect(persisted).toBeDefined();
    expect(persisted.status).toBe("broken");
    expect(persisted.disconnectedAt).toBe(brokenDisconnectedAt);
    expect(persisted.sessionId).toBe("uuid-broken-rt");

    // restoreConductors 相当: initializeLayout (daemon.ts:restoreConductorState 内 status switch) と
    // 同じロジックで復元時も broken を保持することを確認する（T255 で関数抽出済み）
    const restoredStatus =
      persisted.status === "running" ? "running"
      : persisted.status === "disconnected" ? "disconnected"
      : persisted.status === "broken" ? "broken"
      : "idle";
    expect(restoredStatus).toBe("broken");
  });
});

// --- T255: initializeLayout マトリクス復帰 統合テスト (M6〜M16) ---
//
// pure 関数 (planLayoutRestore) のマトリクス分類は layout-restore.test.ts で検証済み。
// ここでは initializeLayout 全体の副作用 (state mutation / cleanup / resume 起動 / task-state 更新) を確認する。
describe("initializeLayout: マトリクス復帰 (T255 §8.3 M6〜M16)", () => {
  /**
   * team.json を書き出すヘルパー（initializeLayout が読み込む）。
   * conductors 配列と layout のみ指定可能。
   */
  async function writeTeamJson(
    conductors: any[],
    layout: "wide" | "16x9" = "wide",
  ): Promise<void> {
    await writeFile(
      join(testDir, ".team/team.json"),
      JSON.stringify({ phase: "ready", masters: [], manager: {}, conductors, layout }),
    );
  }

  /**
   * launchConductor の cmux 副作用を全 stub する（M6/M16 等で使う）。
   * 実 cmux は呼べないので send / sendKey / closeSurface / renameTab を no-op に置き換える。
   */
  async function stubCmuxIO() {
    const cmux = await import("./cmux");
    const { spyOn } = await import("bun:test");
    return {
      send: spyOn(cmux, "send").mockImplementation(async () => {}),
      sendKey: spyOn(cmux, "sendKey").mockImplementation(async () => {}),
      closeSurface: spyOn(cmux, "closeSurface").mockImplementation(async () => {}),
      renameTab: spyOn(cmux, "renameTab").mockImplementation(async () => {}),
    };
  }

  test("M6: pid_dead 2 + alive 1 + running task 1 → A 1 件 + B 1 件 + C 1 件 (部分復元バグ再現)", async () => {
    const { __setIsAliveImpl, __setTreeImpl } = await import("./cmux");
    __setIsAliveImpl((pid: number) => pid === 6001);
    __setTreeImpl(async () => "surface:600\nsurface:601\nsurface:602\n");
    const stubs = await stubCmuxIO();
    try {
      await writeTeamJson([
        { surface: "surface:600", pid: 6001 },
        { surface: "surface:601", pid: 6002, taskId: "111", taskRunId: "task-111-1700000000", worktreePath: testDir },
        { surface: "surface:602", pid: 6003 },
      ]);
      // task-state に taskId=111 を assigned で登録
      const { saveTaskState } = await import("./task");
      await saveTaskState(testDir, {
        "111": { status: "assigned", assignedAt: new Date().toISOString(), sessionId: "sess-111", worktreePath: testDir, taskRunId: "task-111-1700000000" },
      });

      const state = await createDaemon(testDir);
      state.workspace = "ws-test";
      // T253: 本番では cmdStart が state.mainBranch を解決済み。launchConductor の fail-stop を回避するため明示セット。
      state.mainBranch = "main";
      const { initializeLayout } = await import("./daemon");
      const resumePlan = [{
        taskId: "111", taskRunId: "task-111-1700000000",
        worktreePath: testDir, sessionId: "sess-111",
      }];
      const assignments = await initializeLayout(state, undefined, resumePlan);

      // A 経路: surface:600 が keep-alive で state に残る
      expect(state.conductors.has("surface:600")).toBe(true);
      // B 経路: surface:601 が state に残り、taskId 紐付け維持 + assignment 1 件
      expect(state.conductors.has("surface:601")).toBe(true);
      expect(state.conductors.get("surface:601")?.taskId).toBe("111");
      expect(assignments).toHaveLength(1);
      expect(assignments[0]?.taskId).toBe("111");
      // C 経路: surface:602 は close 呼ばれて state には残らない
      expect(state.conductors.has("surface:602")).toBe(false);
      expect(stubs.closeSurface).toHaveBeenCalled();
      const closeCalls = stubs.closeSurface.mock.calls.map((c: any[]) => c[0]);
      expect(closeCalls).toContain("surface:602");
    } finally {
      __setIsAliveImpl(null);
      __setTreeImpl(null);
      stubs.send.mockRestore();
      stubs.sendKey.mockRestore();
      stubs.closeSurface.mockRestore();
      stubs.renameTab.mockRestore();
    }
  }, 15000);

  test("M7: tree() 失敗時は pid_only に degrade — pid dead でも cleanup/B/D に倒さない", async () => {
    const { __setIsAliveImpl, __setTreeImpl } = await import("./cmux");
    __setIsAliveImpl((pid: number) => pid === 7001);
    __setTreeImpl(async () => { throw new Error("tree timeout"); });
    const stubs = await stubCmuxIO();
    try {
      await writeTeamJson([
        { surface: "surface:700", pid: 7001 },
        { surface: "surface:701", pid: 7002, taskId: "077", taskRunId: "tr-077", worktreePath: testDir },
      ]);

      const state = await createDaemon(testDir);
      state.workspace = "ws-test";
      const { initializeLayout } = await import("./daemon");
      const resumePlan = [{
        taskId: "077", taskRunId: "tr-077",
        worktreePath: testDir, sessionId: "sess-077",
      }];
      const assignments = await initializeLayout(state, undefined, resumePlan);

      // 全 entry が A 相当に倒れて state に残る
      expect(state.conductors.has("surface:700")).toBe(true);
      expect(state.conductors.has("surface:701")).toBe(true);
      // B/D 経路に入らないので resume assignment は 0 件
      expect(assignments).toHaveLength(0);
      // cleanup が呼ばれていないこと（C 経路に入らない）
      expect(stubs.closeSurface).not.toHaveBeenCalled();
    } finally {
      __setIsAliveImpl(null);
      __setTreeImpl(null);
      stubs.send.mockRestore();
      stubs.sendKey.mockRestore();
      stubs.closeSurface.mockRestore();
      stubs.renameTab.mockRestore();
    }
  }, 15000);

  test("M10: A 復元時に task-state が assigned でなければ taskId を reconcile (クリア)", async () => {
    const { __setIsAliveImpl, __setTreeImpl } = await import("./cmux");
    __setIsAliveImpl((pid: number) => pid === 1001);
    __setTreeImpl(async () => "surface:100\n");
    const stubs = await stubCmuxIO();
    try {
      // surface:100 alive + taskId=999 を持つが task-state では closed
      await writeTeamJson([
        { surface: "surface:100", pid: 1001, taskId: "999", taskRunId: "tr-999", worktreePath: "/tmp/wt" },
      ]);
      const { saveTaskState } = await import("./task");
      await saveTaskState(testDir, {
        "999": { status: "closed", closedAt: new Date().toISOString() },
      });

      const state = await createDaemon(testDir);
      state.workspace = "ws-test";
      const { initializeLayout } = await import("./daemon");
      await initializeLayout(state, undefined, []);

      // taskId 紐付けがクリアされて idle 状態に reset されている
      const c = state.conductors.get("surface:100");
      expect(c).toBeDefined();
      expect(c?.taskId).toBeUndefined();
      expect(c?.taskRunId).toBeUndefined();
      expect(c?.worktreePath).toBeUndefined();
      expect(c?.status).toBe("idle");
    } finally {
      __setIsAliveImpl(null);
      __setTreeImpl(null);
      stubs.send.mockRestore();
      stubs.sendKey.mockRestore();
      stubs.closeSurface.mockRestore();
      stubs.renameTab.mockRestore();
    }
  }, 15000);

  test("M11: workspace 不明 (state.workspace=null) 時は fetchLiveSurfaces=null → pid_only degrade", async () => {
    const { __setIsAliveImpl, __setTreeImpl } = await import("./cmux");
    __setIsAliveImpl((pid: number) => pid === 8001);
    let treeCalled = false;
    __setTreeImpl(async () => { treeCalled = true; return ""; });
    const stubs = await stubCmuxIO();
    try {
      await writeTeamJson([
        { surface: "surface:800", pid: 8001 },
        { surface: "surface:801", pid: 8002 },
      ]);

      const state = await createDaemon(testDir);
      state.workspace = null; // workspace 不明
      const { initializeLayout } = await import("./daemon");
      await initializeLayout(state, undefined, []);

      // tree は呼ばれない (fetchLiveSurfaces で early return)
      expect(treeCalled).toBe(false);
      // pid alive のみ keep、pid dead も degrade で keep
      expect(state.conductors.has("surface:800")).toBe(true);
      expect(state.conductors.has("surface:801")).toBe(true);
      expect(stubs.closeSurface).not.toHaveBeenCalled();
    } finally {
      __setIsAliveImpl(null);
      __setTreeImpl(null);
      stubs.send.mockRestore();
      stubs.sendKey.mockRestore();
      stubs.closeSurface.mockRestore();
      stubs.renameTab.mockRestore();
    }
  }, 15000);

  test("M12: team.json 空 + resumePlan 非空 → initializeConductorSlots に resumePlan が透過される", async () => {
    const { __setIsAliveImpl } = await import("./cmux");
    __setIsAliveImpl(() => true);
    const cmux = await import("./cmux");
    const { spyOn } = await import("bun:test");
    // newSplit を stub — Conductor 用 pane を順に "surface:c1" / "surface:c2" / "surface:c3" として返す
    let paneIdx = 0;
    const newSplitSpy = spyOn(cmux, "newSplit").mockImplementation(async () => {
      paneIdx += 1;
      return `surface:c${paneIdx}`;
    });
    const stubs = await stubCmuxIO();
    try {
      // team.json が空
      await writeTeamJson([]);

      const state = await createDaemon(testDir);
      state.workspace = "ws-test";
      // T253: 本番では cmdStart が state.mainBranch を解決済み。initializeConductorSlots の fail-stop を回避するため明示セット。
      state.mainBranch = "main";
      const { initializeLayout } = await import("./daemon");
      const resumePlan = [
        { taskId: "201", taskRunId: "tr-201", worktreePath: testDir, sessionId: "sess-201" },
        { taskId: "202", taskRunId: "tr-202", worktreePath: testDir, sessionId: "sess-202" },
      ];
      const assignments = await initializeLayout(state, undefined, resumePlan);

      // resumePlan の 2 件が assignment として返る (initializeConductorSlots 経路)
      expect(assignments).toHaveLength(2);
      expect(assignments.map(a => a.taskId).sort()).toEqual(["201", "202"]);
      // pre-set state.conductors に 2 件登録されている
      expect(state.conductors.size).toBe(2);
    } finally {
      __setIsAliveImpl(null);
      newSplitSpy.mockRestore();
      stubs.send.mockRestore();
      stubs.sendKey.mockRestore();
      stubs.closeSurface.mockRestore();
      stubs.renameTab.mockRestore();
    }
  }, 15000);

  test("M14: layout_mismatch_on_resume が team.json 読み込み直後に出力される", async () => {
    const { __setIsAliveImpl, __setTreeImpl } = await import("./cmux");
    __setIsAliveImpl(() => true);
    __setTreeImpl(async () => "surface:140\n");
    const stubs = await stubCmuxIO();
    try {
      // team.json は 16x9 で書き出すが、daemon の layout は wide
      await writeTeamJson([{ surface: "surface:140", pid: 14001 }], "16x9");

      const state = await createDaemon(testDir);
      state.workspace = "ws-test";
      state.layout = "wide";
      const { initializeLayout } = await import("./daemon");
      await initializeLayout(state, undefined, []);

      const logContent = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
      expect(logContent).toContain("layout_mismatch_on_resume");
      expect(logContent).toContain("restored=16x9");
      expect(logContent).toContain("current=wide");
    } finally {
      __setIsAliveImpl(null);
      __setTreeImpl(null);
      stubs.send.mockRestore();
      stubs.sendKey.mockRestore();
      stubs.closeSurface.mockRestore();
      stubs.renameTab.mockRestore();
    }
  }, 15000);

  test("M15: B 経路の pre-set state は CONDUCTOR_REGISTERED ハンドラで上書きされない (T228 idempotent)", async () => {
    const { __setIsAliveImpl, __setTreeImpl } = await import("./cmux");
    __setIsAliveImpl((pid: number) => pid === 1500); // surface:150 のみ alive
    __setTreeImpl(async () => "surface:150\nsurface:151\n");
    const stubs = await stubCmuxIO();
    try {
      // surface:151 は pid_dead + running task → B 経路
      await writeTeamJson([
        { surface: "surface:150", pid: 1500 },
        { surface: "surface:151", pid: 1501, taskId: "150", taskRunId: "tr-150", worktreePath: testDir, taskTitle: "preserved-title" },
      ]);
      const { saveTaskState } = await import("./task");
      await saveTaskState(testDir, {
        "150": { status: "assigned", assignedAt: new Date().toISOString(), sessionId: "sess-150", worktreePath: testDir, taskRunId: "tr-150" },
      });

      const state = await createDaemon(testDir);
      state.workspace = "ws-test";
      // T253: 本番では cmdStart が state.mainBranch を解決済み。launchConductor の fail-stop を回避するため明示セット。
      state.mainBranch = "main";
      const { initializeLayout } = await import("./daemon");
      const resumePlan = [{
        taskId: "150", taskRunId: "tr-150",
        worktreePath: testDir, sessionId: "sess-150", taskTitle: "preserved-title",
      }];
      await initializeLayout(state, undefined, resumePlan);

      // pre-set state を確認
      const preSet = state.conductors.get("surface:151");
      expect(preSet?.taskId).toBe("150");
      expect(preSet?.taskRunId).toBe("tr-150");
      expect(preSet?.worktreePath).toBe(testDir);
      expect(preSet?.taskTitle).toBe("preserved-title");

      // CONDUCTOR_REGISTERED が late に来ても skip 経路に入る (既存 entry は touch しない)
      await handleMessage(state, {
        type: "CONDUCTOR_REGISTERED",
        surface: "surface:151",
        timestamp: new Date().toISOString(),
      });

      // pre-set した値が破壊されていない
      const after = state.conductors.get("surface:151");
      expect(after?.taskId).toBe("150");
      expect(after?.taskRunId).toBe("tr-150");
      expect(after?.worktreePath).toBe(testDir);
      expect(after?.taskTitle).toBe("preserved-title");
    } finally {
      __setIsAliveImpl(null);
      __setTreeImpl(null);
      stubs.send.mockRestore();
      stubs.sendKey.mockRestore();
      stubs.closeSurface.mockRestore();
      stubs.renameTab.mockRestore();
    }
  }, 15000);

  test("M16: B 経路の launchConductor 失敗 → state rollback + task-state ready 戻し", async () => {
    const { __setIsAliveImpl, __setTreeImpl } = await import("./cmux");
    __setIsAliveImpl((pid: number) => false);
    __setTreeImpl(async () => "surface:160\n");
    const cmux = await import("./cmux");
    const { spyOn } = await import("bun:test");
    // cmux.send が throw する → launchConductor 失敗
    const sendSpy = spyOn(cmux, "send").mockImplementation(async () => {
      throw new Error("injected launch failure");
    });
    const sendKeySpy = spyOn(cmux, "sendKey").mockImplementation(async () => {});
    const closeSurfaceSpy = spyOn(cmux, "closeSurface").mockImplementation(async () => {});
    const renameTabSpy = spyOn(cmux, "renameTab").mockImplementation(async () => {});
    try {
      await writeTeamJson([
        { surface: "surface:160", pid: 1601, taskId: "160", taskRunId: "tr-160", worktreePath: testDir },
      ]);
      const { saveTaskState, loadTaskState } = await import("./task");
      await saveTaskState(testDir, {
        "160": { status: "assigned", assignedAt: new Date().toISOString(), sessionId: "sess-160", worktreePath: testDir, taskRunId: "tr-160" },
      });

      const state = await createDaemon(testDir);
      state.workspace = "ws-test";
      const { initializeLayout } = await import("./daemon");
      const resumePlan = [{
        taskId: "160", taskRunId: "tr-160",
        worktreePath: testDir, sessionId: "sess-160",
      }];
      const assignments = await initializeLayout(state, undefined, resumePlan);

      // assignment は 0 件 (rollback のため)
      expect(assignments).toHaveLength(0);
      // state.conductors から削除されている
      expect(state.conductors.has("surface:160")).toBe(false);
      // task-state が ready に戻されている
      const ts = await loadTaskState(testDir);
      expect(ts["160"]?.status).toBe("ready");
      // ログに conductor_resume_launch_failed が記録されている
      const logContent = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
      expect(logContent).toContain("conductor_resume_launch_failed");
    } finally {
      __setIsAliveImpl(null);
      __setTreeImpl(null);
      sendSpy.mockRestore();
      sendKeySpy.mockRestore();
      closeSurfaceSpy.mockRestore();
      renameTabSpy.mockRestore();
    }
  }, 15000);

  test("layout_kept_partial: kept < maxConductors なら part 復元ログを出す", async () => {
    const { __setIsAliveImpl, __setTreeImpl } = await import("./cmux");
    __setIsAliveImpl((pid: number) => pid === 9001);
    __setTreeImpl(async () => "surface:900\n");
    const stubs = await stubCmuxIO();
    try {
      // 1 件のみ alive — maxConductors=3 (wide のデフォルト) より少ない
      await writeTeamJson([{ surface: "surface:900", pid: 9001 }]);

      const state = await createDaemon(testDir);
      state.workspace = "ws-test";
      state.maxConductors = 3;
      const { initializeLayout } = await import("./daemon");
      await initializeLayout(state, undefined, []);

      const logContent = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
      expect(logContent).toContain("layout_kept_partial");
      expect(logContent).toMatch(/kept=1/);
      expect(logContent).toMatch(/max=3/);
    } finally {
      __setIsAliveImpl(null);
      __setTreeImpl(null);
      stubs.send.mockRestore();
      stubs.sendKey.mockRestore();
      stubs.closeSurface.mockRestore();
      stubs.renameTab.mockRestore();
    }
  }, 15000);

  test("conductor_resume_noop ログは廃止 — 出力されないこと", async () => {
    const { __setIsAliveImpl, __setTreeImpl } = await import("./cmux");
    __setIsAliveImpl((pid: number) => pid === 5001);
    __setTreeImpl(async () => "surface:500\n");
    const stubs = await stubCmuxIO();
    try {
      // alive 1 件 + resumePlan 1 件 (taskId 不一致で unmatched) → 旧コードでは noop ログ出力
      await writeTeamJson([{ surface: "surface:500", pid: 5001 }]);

      const state = await createDaemon(testDir);
      state.workspace = "ws-test";
      const { initializeLayout } = await import("./daemon");
      const resumePlan = [{
        taskId: "999", taskRunId: "tr-999",
        worktreePath: testDir, sessionId: "sess-999",
      }];
      await initializeLayout(state, undefined, resumePlan);

      const logContent = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
      expect(logContent).not.toContain("conductor_resume_noop");
      // 代わりに resume_unmatched_to_ready が出る
      expect(logContent).toContain("resume_unmatched_to_ready");
    } finally {
      __setIsAliveImpl(null);
      __setTreeImpl(null);
      stubs.send.mockRestore();
      stubs.sendKey.mockRestore();
      stubs.closeSurface.mockRestore();
      stubs.renameTab.mockRestore();
    }
  }, 15000);

  // T286: 全 discard 自己修復 fallback の 3 バリアント (M17a/M17b/M17c) + 任意 M17d
  // 発症条件: team.json に conductor entry はあるが、cmux 側で全 entry が
  //   消失 or idle 残骸しか残っていないケース（KDG-SSO 再現条件）。
  //   従来は state.conductors が空のまま boot_completed に到達していた。
  //   fallback 発動時は layout_restore_empty_fallback ログ + 新規 slot 作成パスに倒す。
  test("M17a: 全 entry が E (surface_missing_no_task) のみ → fallback 発動で新 slot 作成 (KDG-SSO 再現)", async () => {
    const { __setIsAliveImpl, __setTreeImpl } = await import("./cmux");
    __setIsAliveImpl(() => false); // 全 pid 死亡
    __setTreeImpl(async () => ""); // 全 surface 消失
    const cmux = await import("./cmux");
    const { spyOn } = await import("bun:test");
    let paneIdx = 0;
    const newSplitSpy = spyOn(cmux, "newSplit").mockImplementation(async () => {
      paneIdx += 1;
      return `surface:new${paneIdx}`;
    });
    const stubs = await stubCmuxIO();
    try {
      // team.json に 3 entry (全 idle 残骸、surface 消失相当)
      await writeTeamJson([
        { surface: "surface:52", pid: 52001 },
        { surface: "surface:53", pid: 53001 },
        { surface: "surface:54", pid: 54001 },
      ]);

      const state = await createDaemon(testDir);
      state.workspace = "ws-test";
      state.maxConductors = 3;
      state.mainBranch = "main";
      state.layout = "wide";

      const { initializeLayout } = await import("./daemon");
      await initializeLayout(state, undefined, []);

      const logContent = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
      // fallback ログが記録されていること (format 厳守)
      expect(logContent).toContain("layout_restore_empty_fallback");
      expect(logContent).toMatch(/layout_restore_empty_fallback .*kept=0/);
      expect(logContent).toMatch(/discarded=3/);
      expect(logContent).toMatch(/layout=wide/);
      // E 経路 surface に対して conductor_discarded が出ていること (3 件)
      const discardMatches = logContent.match(/conductor_discarded/g) ?? [];
      expect(discardMatches.length).toBe(3);
      // C 経路 surface は無いので conductor_stale_surface_closed は出ないこと
      expect(logContent).not.toContain("conductor_stale_surface_closed");
      // close-surface が呼ばれていないこと (E のみ → 副作用なし)
      expect(stubs.closeSurface).not.toHaveBeenCalled();
      // 新 slot 作成パスに倒れて newSplit が 3 回呼ばれていること
      expect(newSplitSpy).toHaveBeenCalledTimes(3);
    } finally {
      __setIsAliveImpl(null);
      __setTreeImpl(null);
      newSplitSpy.mockRestore();
      stubs.send.mockRestore();
      stubs.sendKey.mockRestore();
      stubs.closeSurface.mockRestore();
      stubs.renameTab.mockRestore();
    }
  }, 15000);

  test("M17b: 全 entry が C (pid_dead + surface 実在 + 全 idle) のみ → fallback で close-surface 3 + 新 slot", async () => {
    const { __setIsAliveImpl, __setTreeImpl } = await import("./cmux");
    __setIsAliveImpl(() => false); // 全 pid 死亡
    // 全 surface 実在
    __setTreeImpl(async () => "surface:52\nsurface:53\nsurface:54\n");
    const cmux = await import("./cmux");
    const { spyOn } = await import("bun:test");
    let paneIdx = 0;
    const newSplitSpy = spyOn(cmux, "newSplit").mockImplementation(async () => {
      paneIdx += 1;
      return `surface:new${paneIdx}`;
    });
    const stubs = await stubCmuxIO();
    try {
      // team.json に 3 entry (taskId 無し → 全 idle → C 経路)
      await writeTeamJson([
        { surface: "surface:52", pid: 52001 },
        { surface: "surface:53", pid: 53001 },
        { surface: "surface:54", pid: 54001 },
      ]);

      const state = await createDaemon(testDir);
      state.workspace = "ws-test";
      state.maxConductors = 3;
      state.mainBranch = "main";
      state.layout = "16x9";
      state.maxConductors = 2; // 16x9 は 2 conductor

      const { initializeLayout } = await import("./daemon");
      await initializeLayout(state, undefined, []);

      const logContent = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
      // fallback ログ format
      expect(logContent).toContain("layout_restore_empty_fallback");
      expect(logContent).toMatch(/kept=0/);
      expect(logContent).toMatch(/discarded=3/);
      expect(logContent).toMatch(/layout=16x9/);
      // C 経路なので conductor_stale_surface_closed が 3 件
      const staleMatches = logContent.match(/conductor_stale_surface_closed/g) ?? [];
      expect(staleMatches.length).toBe(3);
      // E 経路は無いので conductor_discarded ログは出ないこと
      // (C 経路の discarded entry は reason=pid_dead_idle_cleanup なのでフィルタ済)
      expect(logContent).not.toContain("conductor_discarded");
      // close-surface は sequential に 3 回呼ばれる (Promise.all 禁止 → 呼び出し順序が入力順と一致)
      expect(stubs.closeSurface).toHaveBeenCalledTimes(3);
      const closeCalls = stubs.closeSurface.mock.calls.map((c: any[]) => c[0]);
      expect(closeCalls).toEqual(["surface:52", "surface:53", "surface:54"]);
      // 新 slot 作成パスに倒れて newSplit が 2 回呼ばれていること (16x9 → 2 conductor)
      expect(newSplitSpy).toHaveBeenCalledTimes(2);
    } finally {
      __setIsAliveImpl(null);
      __setTreeImpl(null);
      newSplitSpy.mockRestore();
      stubs.send.mockRestore();
      stubs.sendKey.mockRestore();
      stubs.closeSurface.mockRestore();
      stubs.renameTab.mockRestore();
    }
  }, 15000);

  test("M17c: C + E 混在 → fallback で部分 close-surface + 部分 discard log + 新 slot", async () => {
    const { __setIsAliveImpl, __setTreeImpl } = await import("./cmux");
    __setIsAliveImpl(() => false); // 全 pid 死亡
    // surface:52 実在 (C 経路) / surface:53, 54 消失 (E 経路)
    __setTreeImpl(async () => "surface:52\n");
    const cmux = await import("./cmux");
    const { spyOn } = await import("bun:test");
    let paneIdx = 0;
    const newSplitSpy = spyOn(cmux, "newSplit").mockImplementation(async () => {
      paneIdx += 1;
      return `surface:new${paneIdx}`;
    });
    const stubs = await stubCmuxIO();
    try {
      await writeTeamJson([
        { surface: "surface:52", pid: 52001 },
        { surface: "surface:53", pid: 53001 },
        { surface: "surface:54", pid: 54001 },
      ]);

      const state = await createDaemon(testDir);
      state.workspace = "ws-test";
      state.maxConductors = 3;
      state.mainBranch = "main";
      state.layout = "wide";

      const { initializeLayout } = await import("./daemon");
      await initializeLayout(state, undefined, []);

      const logContent = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
      // fallback 発動
      expect(logContent).toContain("layout_restore_empty_fallback");
      expect(logContent).toMatch(/kept=0/);
      expect(logContent).toMatch(/discarded=3/);
      expect(logContent).toMatch(/layout=wide/);
      // C 経路 surface:52 のみ conductor_stale_surface_closed (1 件)
      const staleMatches = logContent.match(/conductor_stale_surface_closed/g) ?? [];
      expect(staleMatches.length).toBe(1);
      expect(logContent).toMatch(/conductor_stale_surface_closed.*\[52\]/);
      // E 経路 surface:53, :54 のみ conductor_discarded (2 件)
      const discardMatches = logContent.match(/conductor_discarded/g) ?? [];
      expect(discardMatches.length).toBe(2);
      expect(logContent).toMatch(/conductor_discarded.*\[53\].*surface_missing_no_task/);
      expect(logContent).toMatch(/conductor_discarded.*\[54\].*surface_missing_no_task/);
      // close-surface は C 経路 surface のみ (1 回)
      expect(stubs.closeSurface).toHaveBeenCalledTimes(1);
      const firstCloseCall = stubs.closeSurface.mock.calls[0];
      expect(firstCloseCall?.[0]).toBe("surface:52");
      // 新 slot 作成パスに倒れて newSplit が 3 回呼ばれていること (wide → 3 conductor)
      expect(newSplitSpy).toHaveBeenCalledTimes(3);
    } finally {
      __setIsAliveImpl(null);
      __setTreeImpl(null);
      newSplitSpy.mockRestore();
      stubs.send.mockRestore();
      stubs.sendKey.mockRestore();
      stubs.closeSurface.mockRestore();
      stubs.renameTab.mockRestore();
    }
  }, 15000);

  test("M17d: 全 E + resumePlan 2 件 (unmatched) → fallback で新 slot に resume 分配 (resumePlan 透過)", async () => {
    const { __setIsAliveImpl, __setTreeImpl } = await import("./cmux");
    __setIsAliveImpl(() => false);
    __setTreeImpl(async () => ""); // 全 surface 消失
    const cmux = await import("./cmux");
    const { spyOn } = await import("bun:test");
    let paneIdx = 0;
    const newSplitSpy = spyOn(cmux, "newSplit").mockImplementation(async () => {
      paneIdx += 1;
      return `surface:new${paneIdx}`;
    });
    const stubs = await stubCmuxIO();
    try {
      // team.json に 3 entry (taskId 無し → 全 E)
      await writeTeamJson([
        { surface: "surface:52", pid: 52001 },
        { surface: "surface:53", pid: 53001 },
        { surface: "surface:54", pid: 54001 },
      ]);

      const state = await createDaemon(testDir);
      state.workspace = "ws-test";
      state.maxConductors = 3;
      state.mainBranch = "main";
      state.layout = "wide";

      const { initializeLayout } = await import("./daemon");
      // resumePlan は team.json と無関係な taskId を持つ → plan.unmatchedResumes に入る
      const resumePlan = [
        { taskId: "201", taskRunId: "tr-201", worktreePath: testDir, sessionId: "sess-201" },
        { taskId: "202", taskRunId: "tr-202", worktreePath: testDir, sessionId: "sess-202" },
      ];
      const assignments = await initializeLayout(state, undefined, resumePlan);

      const logContent = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
      // fallback 発動
      expect(logContent).toContain("layout_restore_empty_fallback");
      // resumePlan が initializeConductorSlots 経路に透過されて 2 件 assignment が返る
      expect(assignments).toHaveLength(2);
      expect(assignments.map(a => a.taskId).sort()).toEqual(["201", "202"]);
      // 3 pane 作成 (先頭 2 resume, 末尾 1 非 resume)
      expect(newSplitSpy).toHaveBeenCalledTimes(3);
      // resume pre-population で state.conductors に 2 件登録されている
      expect(state.conductors.size).toBe(2);
    } finally {
      __setIsAliveImpl(null);
      __setTreeImpl(null);
      newSplitSpy.mockRestore();
      stubs.send.mockRestore();
      stubs.sendKey.mockRestore();
      stubs.closeSurface.mockRestore();
      stubs.renameTab.mockRestore();
    }
  }, 15000);
});

describe("T260: formatConductorSnapshot + disconnect snapshot ログ", () => {
  test("formatConductorSnapshot は pid/alive/lastHookAt/elapsed/taskRunId を 1 行で出力", async () => {
    const { __setIsAliveImpl } = await import("./cmux");
    const { formatConductorSnapshot } = await import("./daemon");
    __setIsAliveImpl(() => true);
    try {
      const conductor: ConductorState = {
        surface: "surface:700",
        startedAt: "2026-04-18T09:00:00.000Z",
        taskRunId: "task-260-1712345678",
        lastHookAt: "2026-04-18T09:00:00.000Z",
        agents: [],
        status: "running",
        pid: 12345,
      };
      const out = formatConductorSnapshot(conductor);
      expect(out).toContain("pid=12345");
      expect(out).toContain("alive=true");
      expect(out).toContain("last_hook_at=2026-04-18T09:00:00.000Z");
      expect(out).toContain("elapsed_since_last_hook=");
      expect(out).toContain("taskRunId=task-260-1712345678");
    } finally {
      __setIsAliveImpl(null);
    }
  });

  test("pid 未定義のとき pid=null alive=unknown を出力", async () => {
    const { formatConductorSnapshot } = await import("./daemon");
    const conductor: ConductorState = {
      surface: "surface:701",
      startedAt: "2026-04-18T09:00:00.000Z",
      agents: [],
      status: "broken",
    };
    const out = formatConductorSnapshot(conductor);
    expect(out).toContain("pid=null");
    expect(out).toContain("alive=unknown");
    expect(out).toContain("last_hook_at=-");
    expect(out).toContain("taskRunId=-");
  });

  test("SESSION_STARTED で conductor.lastHookAt が更新される", async () => {
    const { __setIsAliveImpl } = await import("./cmux");
    const { createDaemon, handleMessage } = await import("./daemon");
    __setIsAliveImpl(() => true);
    try {
      const state = await createDaemon(testDir);
      const conductor: ConductorState = {
        surface: "surface:710",
        startedAt: "2026-04-18T09:00:00.000Z",
        agents: [],
        status: "starting",
      };
      state.conductors.set(conductor.surface, conductor);

      const ts = "2026-04-18T09:00:30.000Z";
      await handleMessage(state, {
        type: "SESSION_STARTED",
        surface: conductor.surface,
        pid: 4242,
        timestamp: ts,
      });

      expect(conductor.lastHookAt).toBe(ts);
    } finally {
      __setIsAliveImpl(null);
    }
  });

  test("__testSpawnPidWatcherTick の dead 経路で conductor_disconnected snapshot が出る", async () => {
    const { __setIsAliveImpl } = await import("./cmux");
    const { __testSpawnPidWatcherTick, createDaemon } = await import("./daemon");
    __setIsAliveImpl(() => false);
    try {
      const state = await createDaemon(testDir);
      const conductor: ConductorState = {
        surface: "surface:720",
        startedAt: new Date().toISOString(),
        taskRunId: "task-260-pid-dead",
        taskId: "260",
        lastHookAt: "2026-04-18T09:00:00.000Z",
        agents: [],
        status: "running",
        pid: 88888,
      };
      state.conductors.set(conductor.surface, conductor);

      const result = await __testSpawnPidWatcherTick(state, conductor, 88888);
      expect(result).toBe("dead");

      const log = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
      expect(log).toMatch(/conductor_disconnected C\[720\] reason=pid_dead pid=88888 alive=false .*taskRunId=task-260-pid-dead/);
    } finally {
      __setIsAliveImpl(null);
    }
  });

  test("SESSION_ENDED (non-other) で conductor_disconnected snapshot が出る", async () => {
    const { __setIsAliveImpl } = await import("./cmux");
    const { createDaemon, handleMessage } = await import("./daemon");
    __setIsAliveImpl(() => false);
    try {
      const state = await createDaemon(testDir);
      const conductor: ConductorState = {
        surface: "surface:730",
        startedAt: new Date().toISOString(),
        taskRunId: "task-260-sess-end",
        lastHookAt: "2026-04-18T09:00:00.000Z",
        agents: [],
        status: "running",
        pid: 55555,
      };
      state.conductors.set(conductor.surface, conductor);

      await handleMessage(state, {
        type: "SESSION_ENDED",
        surface: conductor.surface,
        pid: 55555,
        reason: "manual_quit",
        timestamp: "2026-04-18T09:01:00.000Z",
      });

      const log = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
      expect(log).toMatch(/conductor_disconnected C\[730\] reason=session_ended:manual_quit pid=55555 alive=false .*taskRunId=task-260-sess-end/);
    } finally {
      __setIsAliveImpl(null);
    }
  });

  test("broken Conductor への SESSION_STARTED は session_event_ignored_broken と broken_conductor_still_alive を並行出力する", async () => {
    const { __setIsAliveImpl } = await import("./cmux");
    const { createDaemon, handleMessage } = await import("./daemon");
    __setIsAliveImpl(() => true);
    try {
      const state = await createDaemon(testDir);
      const conductor: ConductorState = {
        surface: "surface:750",
        startedAt: new Date().toISOString(),
        taskRunId: "task-260-broken-alive",
        lastHookAt: "2026-04-18T09:00:00.000Z",
        agents: [],
        status: "broken",
        disconnectedAt: "2026-04-18T08:50:00.000Z",
        pid: 22222,
      };
      state.conductors.set(conductor.surface, conductor);

      await handleMessage(state, {
        type: "SESSION_STARTED",
        surface: conductor.surface,
        pid: 22222,
        source: "startup",
        timestamp: "2026-04-18T09:05:00.000Z",
      });

      const log = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
      expect(log).toMatch(/session_event_ignored_broken C\[750\] event=SESSION_STARTED/);
      expect(log).toMatch(/broken_conductor_still_alive C\[750\] event=SESSION_STARTED pid=22222 alive=true .*taskRunId=task-260-broken-alive/);
    } finally {
      __setIsAliveImpl(null);
    }
  });

  test("broken かつ pid 死亡時は broken_conductor_still_alive を出さない", async () => {
    const { __setIsAliveImpl } = await import("./cmux");
    const { createDaemon, handleMessage } = await import("./daemon");
    __setIsAliveImpl(() => false);
    try {
      const state = await createDaemon(testDir);
      const conductor: ConductorState = {
        surface: "surface:751",
        startedAt: new Date().toISOString(),
        agents: [],
        status: "broken",
        disconnectedAt: "2026-04-18T08:50:00.000Z",
        pid: 22223,
      };
      state.conductors.set(conductor.surface, conductor);

      await handleMessage(state, {
        type: "SESSION_IDLE",
        surface: conductor.surface,
        pid: 22223,
        timestamp: "2026-04-18T09:05:00.000Z",
      });

      const log = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
      expect(log).toMatch(/session_event_ignored_broken C\[751\] event=SESSION_IDLE/);
      expect(log).not.toMatch(/broken_conductor_still_alive/);
    } finally {
      __setIsAliveImpl(null);
    }
  });

  test("AGENT_SPAWNED の callerSurface/callerPid は agent_spawned ログに載る", async () => {
    const { createDaemon, handleMessage } = await import("./daemon");
    const state = await createDaemon(testDir);
    const conductor: ConductorState = {
      surface: "surface:760",
      startedAt: new Date().toISOString(),
      agents: [],
      status: "idle",
      pid: 33333,
    };
    state.conductors.set(conductor.surface, conductor);

    await handleMessage(state, {
      type: "AGENT_SPAWNED",
      surface: "surface:761",
      conductorSurface: conductor.surface,
      role: "implementer",
      taskTitle: "demo",
      timestamp: "2026-04-18T09:05:00.000Z",
      callerPid: 44444,
      callerSurface: conductor.surface,
    });

    const log = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
    expect(log).toMatch(/agent_spawned C\[760\]>A\[761\] role=implementer caller=C\[760\] caller_pid=44444/);
  });

  test("broken Conductor への AGENT_SPAWNED は broken_conductor_still_alive を出す", async () => {
    const { __setIsAliveImpl } = await import("./cmux");
    const { createDaemon, handleMessage } = await import("./daemon");
    __setIsAliveImpl(() => true);
    try {
      const state = await createDaemon(testDir);
      const conductor: ConductorState = {
        surface: "surface:752",
        startedAt: new Date().toISOString(),
        taskRunId: "task-260-agent",
        lastHookAt: "2026-04-18T09:00:00.000Z",
        agents: [],
        status: "broken",
        disconnectedAt: "2026-04-18T08:50:00.000Z",
        pid: 22224,
      };
      state.conductors.set(conductor.surface, conductor);

      await handleMessage(state, {
        type: "AGENT_SPAWNED",
        surface: "surface:999",
        conductorSurface: conductor.surface,
        role: "implementer",
        taskTitle: "sample",
        timestamp: "2026-04-18T09:05:00.000Z",
      });

      const log = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
      expect(log).toMatch(/broken_conductor_still_alive C\[752\] event=AGENT_SPAWNED pid=22224 alive=true .*taskRunId=task-260-agent/);
    } finally {
      __setIsAliveImpl(null);
    }
  });
});

// --- T261: user_clear 誤判定観測用ログ / スナップショット ---

describe("handleMessage: user_clear_decision_snapshot (T261)", () => {
  test("assigning + SESSION_CLEAR は case=session_clear_expected の snapshot を task_aborted 無しで出す", async () => {
    const state = await createDaemon(testDir);
    const startedAt = "2026-04-19T10:00:00.000Z";
    const clearSentAt = "2026-04-19T10:00:00.100Z";
    const receivedAt = "2026-04-19T10:00:02.100Z";
    const conductor: ConductorState = {
      surface: "surface:261a",
      startedAt,
      agents: [],
      status: "assigning",
      pid: 11111,
      taskRunId: "task-261-a",
      taskId: "261a",
      clearSentAt,
    };
    state.conductors.set(conductor.surface, conductor);

    await handleMessage(state, {
      type: "SESSION_CLEAR",
      surface: conductor.surface,
      timestamp: receivedAt,
    });

    const logContent = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
    expect(logContent).toMatch(
      /user_clear_decision_snapshot C\[261a\] case=session_clear_expected prev_status=assigning clear_sent_at=2026-04-19T10:00:00.100Z .*decision_reason=daemon_assign_clear/
    );
    // elapsed は 2000ms（固定入力から計算）
    expect(logContent).toMatch(/elapsed_since_clear_sent=2000/);
    // session_clear_expected も続けて出ている
    expect(logContent).toMatch(/session_clear_expected C\[261a\]/);
    // task_aborted は出ていない
    expect(logContent).not.toMatch(/task_aborted.*task_id=261a/);
  });

  test("running + SESSION_CLEAR は case=user_clear snapshot → task_aborted の順で出る", async () => {
    const state = await createDaemon(testDir);
    const startedAt = "2026-04-19T10:10:00.000Z";
    const clearSentAt = "2026-04-19T10:10:00.200Z";
    const receivedAt = "2026-04-19T10:20:00.200Z";
    const conductor: ConductorState = {
      surface: "surface:261b",
      startedAt,
      agents: [],
      status: "running",
      pid: 22222,
      taskRunId: "task-261-b",
      taskId: "261b",
      clearSentAt,
      promptSentAt: "2026-04-19T10:10:00.500Z",
      promptBytes: 42,
    };
    state.conductors.set(conductor.surface, conductor);

    // task-state を assigned にしておく（user_clear → aborted 書き換えを発火させる）
    const { saveTaskState, loadTaskState } = await import("./task");
    const before = await loadTaskState(testDir);
    before["261b"] = { status: "assigned", assignedAt: startedAt, taskRunId: "task-261-b" };
    await saveTaskState(testDir, before);

    await handleMessage(state, {
      type: "SESSION_CLEAR",
      surface: conductor.surface,
      timestamp: receivedAt,
    });

    const logContent = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
    expect(logContent).toMatch(
      /user_clear_decision_snapshot C\[261b\] case=user_clear prev_status=running clear_sent_at=2026-04-19T10:10:00.200Z .*prompt_bytes=42 decision_reason=running_with_taskid/
    );
    expect(logContent).toMatch(/task_aborted task_id=261b reason=user_clear/);

    // 順序: snapshot が先、task_aborted が後
    const snapshotIdx = logContent.indexOf("user_clear_decision_snapshot C[261b]");
    const abortedIdx = logContent.indexOf("task_aborted task_id=261b");
    expect(snapshotIdx).toBeGreaterThanOrEqual(0);
    expect(abortedIdx).toBeGreaterThan(snapshotIdx);
  });

  // T265: assigning_set_at は conductor.assigningSetAt 由来（startedAt は参照しない）
  // キー名は互換のため維持し、値の解決元だけ startedAt → assigningSetAt に差し替えた。
  test("formatUserClearDecision の assigning_set_at は conductor.assigningSetAt 由来（startedAt 非参照）", async () => {
    const state = await createDaemon(testDir);
    const startedAt = "2026-04-19T10:00:00.000Z";
    const assigningSetAt = "2026-04-19T11:00:00.000Z";
    const clearSentAt = "2026-04-19T11:00:00.100Z";
    const receivedAt = "2026-04-19T11:00:02.100Z";
    const conductor: ConductorState = {
      surface: "surface:265f",
      startedAt,
      assigningSetAt,
      agents: [],
      status: "assigning",
      pid: 12345,
      taskRunId: "task-265-f",
      taskId: "265f",
      clearSentAt,
    };
    state.conductors.set(conductor.surface, conductor);

    await handleMessage(state, {
      type: "SESSION_CLEAR",
      surface: conductor.surface,
      timestamp: receivedAt,
    });

    const logContent = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
    expect(logContent).toMatch(/assigning_set_at=2026-04-19T11:00:00\.000Z/);
    expect(logContent).not.toMatch(/assigning_set_at=2026-04-19T10:00:00\.000Z/);
  });
});

describe("handleMessage: assigning_window_close (T261)", () => {
  test("SESSION_STARTED(source=clear) で assigning_window_close via=SESSION_STARTED_clear elapsed=<ms> が出る", async () => {
    const state = await createDaemon(testDir);
    const clearSentAt = "2026-04-19T10:30:00.000Z";
    const receivedAt = "2026-04-19T10:30:01.500Z";
    const conductor: ConductorState = {
      surface: "surface:261c",
      startedAt: "2026-04-19T10:29:59.000Z",
      agents: [],
      status: "assigning",
      taskRunId: "task-261-c",
      taskId: "261c",
      clearSentAt,
    };
    state.conductors.set(conductor.surface, conductor);

    await handleMessage(state, {
      type: "SESSION_STARTED",
      surface: conductor.surface,
      pid: 33333,
      source: "clear",
      timestamp: receivedAt,
    });

    expect(conductor.status).toBe("running");
    expect(conductor.sessionStartedClearAt).toBe(receivedAt);

    const logContent = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
    expect(logContent).toMatch(
      /assigning_window_close C\[261c\] via=SESSION_STARTED_clear elapsed=1500/
    );

    // PID watcher 停止
    if (conductor.pidWatcherInterval) {
      clearInterval(conductor.pidWatcherInterval);
      conductor.pidWatcherInterval = undefined;
    }
  });

  test("assigning timeout で assigning_window_close via=timeout が出る", async () => {
    const state = await createDaemon(testDir);
    const clearSentAt = new Date(Date.now() - 61_000).toISOString();
    const conductor: ConductorState = {
      surface: "surface:261e",
      startedAt: new Date(Date.now() - 61_000).toISOString(),
      agents: [],
      status: "assigning",
      taskRunId: "task-261-e",
      taskId: "261e",
      clearSentAt,
    };
    state.conductors.set(conductor.surface, conductor);

    await monitorConductors(state);

    expect(conductor.status).toBe("disconnected");

    const logContent = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
    expect(logContent).toMatch(
      /assigning_window_close C\[261e\] via=timeout elapsed=\d+/
    );
  });
});

describe("handleMessage: session_idle_source_guess (T261)", () => {
  test("prev=assigning + clearSentAt 差分 <5000ms → clear_transient", async () => {
    const state = await createDaemon(testDir);
    const clearSentAt = "2026-04-19T10:50:00.000Z";
    const receivedAt = "2026-04-19T10:50:01.500Z";
    const conductor: ConductorState = {
      surface: "surface:261f",
      startedAt: "2026-04-19T10:49:59.000Z",
      agents: [],
      status: "assigning",
      taskRunId: "task-261-f",
      taskId: "261f",
      clearSentAt,
      promptSentAt: "2026-04-19T10:50:00.300Z",
    };
    state.conductors.set(conductor.surface, conductor);

    await handleMessage(state, {
      type: "SESSION_IDLE",
      surface: conductor.surface,
      pid: 55555,
      timestamp: receivedAt,
    });

    const logContent = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
    expect(logContent).toMatch(
      /session_idle C\[261f\] session_idle_source_guess=clear_transient/
    );
  });

  test("prev=running + taskRunId → assigned", async () => {
    const state = await createDaemon(testDir);
    const conductor: ConductorState = {
      surface: "surface:261g",
      startedAt: "2026-04-19T11:00:00.000Z",
      agents: [],
      status: "running",
      pid: 66666,
      taskRunId: "task-261-g",
      taskId: "261g",
    };
    state.conductors.set(conductor.surface, conductor);

    await handleMessage(state, {
      type: "SESSION_IDLE",
      surface: conductor.surface,
      pid: 66666,
      timestamp: "2026-04-19T11:00:05.000Z",
    });

    const logContent = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
    expect(logContent).toMatch(
      /session_idle C\[261g\] session_idle_source_guess=assigned/
    );
  });

  test("prev=assigning + promptSentAt 未設定 → prompt_pending", async () => {
    const state = await createDaemon(testDir);
    const clearSentAt = "2026-04-19T11:10:00.000Z";
    // clear からの経過が 5000ms 以上 → clear_transient 判定から外れる
    const receivedAt = "2026-04-19T11:10:10.000Z";
    const conductor: ConductorState = {
      surface: "surface:261h",
      startedAt: "2026-04-19T11:09:59.000Z",
      agents: [],
      status: "assigning",
      taskRunId: "task-261-h",
      taskId: "261h",
      clearSentAt,
      // promptSentAt は意図的に未設定
    };
    state.conductors.set(conductor.surface, conductor);

    await handleMessage(state, {
      type: "SESSION_IDLE",
      surface: conductor.surface,
      pid: 77777,
      timestamp: receivedAt,
    });

    const logContent = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
    expect(logContent).toMatch(
      /session_idle C\[261h\] session_idle_source_guess=prompt_pending/
    );
  });
});

describe("updateTeamJson / restoreConductors: T261 フィールド永続化", () => {
  test("clearSentAt は team.json に書き出され restore 後も保持される / 他 3 フィールドは undefined に戻る", async () => {
    const { updateTeamJson, createDaemon } = await import("./daemon");

    const state = await createDaemon(testDir);
    const clearSentAt = "2026-04-19T12:00:00.000Z";
    const conductor: ConductorState = {
      surface: "surface:261i",
      startedAt: "2026-04-19T11:59:59.000Z",
      agents: [],
      status: "running",
      pid: 88888,
      taskRunId: "task-261-i",
      taskId: "261i",
      clearSentAt,
      // 以下 3 つはランタイム限定（team.json に書き出されない）
      promptSentAt: "2026-04-19T12:00:00.300Z",
      promptBytes: 123,
      sessionStartedClearAt: "2026-04-19T12:00:00.400Z",
    };
    state.conductors.set(conductor.surface, conductor);

    await updateTeamJson(state);

    const teamJson = JSON.parse(
      await readFile(join(testDir, ".team/team.json"), "utf-8"),
    );
    const serialized = teamJson.conductors.find((c: any) => c.surface === "surface:261i");
    expect(serialized).toBeDefined();
    expect(serialized.clearSentAt).toBe(clearSentAt);
    // 以下 3 つは永続化されない
    expect(serialized.promptSentAt).toBeUndefined();
    expect(serialized.promptBytes).toBeUndefined();
    expect(serialized.sessionStartedClearAt).toBeUndefined();

    // 復元経路: ConductorState スキーマの parse 相当（restoreConductorState は非公開のため、
    //          team.json の生データを schema.ts の parse で検証することで回帰を押さえる）
    const { ConductorState: ConductorStateSchema } = await import("./schema");
    const parsed = ConductorStateSchema.parse({
      ...serialized,
      // restore で必要な最小フィールドを補う
      agents: serialized.agents ?? [],
    });
    expect(parsed.clearSentAt).toBe(clearSentAt);
    expect(parsed.promptSentAt).toBeUndefined();
    expect(parsed.promptBytes).toBeUndefined();
    expect(parsed.sessionStartedClearAt).toBeUndefined();
  });
});

// --- T263: handleConductorDone success/task-state 分岐 ---
//
// `CONDUCTOR_DONE --success=false` で rebase 衝突等の「人間判断待ち」を表現する。
// 挙動テーブル（plan.md §2.4）の代表 4 ケースを検証:
//   #1  success=true  && task-state=closed   → task_completed、worktree 削除
//   #6  success=false && task-state=closed   → task_completed、worktree 削除
//   #9  success=false && task-state=assigned → conductor_done_unresolved、worktree 温存 ★本命
//   #10 success=false && task-state=missing  → conductor_done_unresolved、worktree 温存
describe("handleConductorDone success/task-state 分岐 (T263)", () => {
  async function setupRealGitWithWorktree(taskRunId: string): Promise<string> {
    const { execFile: ef } = await import("child_process");
    const { promisify } = await import("util");
    const execFile = promisify(ef);
    await execFile("git", ["init", "-q", "-b", "main"], { cwd: testDir });
    await execFile("git", ["config", "user.email", "test@test.local"], { cwd: testDir });
    await execFile("git", ["config", "user.name", "Test"], { cwd: testDir });
    await writeFile(join(testDir, "README.md"), "test");
    await execFile("git", ["add", "."], { cwd: testDir });
    await execFile("git", ["commit", "-q", "-m", "init"], { cwd: testDir });
    const worktreePath = join(testDir, ".worktrees", taskRunId);
    await execFile("git", ["worktree", "add", worktreePath, "-b", `${taskRunId}/task`], { cwd: testDir });
    return worktreePath;
  }

  async function stubPaneForSurface() {
    const cmux = await import("./cmux");
    const { spyOn } = await import("bun:test");
    return spyOn(cmux, "getPaneForSurface").mockResolvedValue("pane:1");
  }

  test("Case #9: success=false && assigned → conductor_done_unresolved + worktree 温存", async () => {
    const paneSpy = await stubPaneForSurface();
    try {
      const taskRunId = "task-263c9-1700009000";
      const worktreePath = await setupRealGitWithWorktree(taskRunId);
      await createTask("263", "rebase-conflict");
      // task-state を assigned に書き換え（createTask は ready のため）
      const { loadTaskState, saveTaskState } = await import("./task");
      const ts = await loadTaskState(testDir);
      ts["263"] = { status: "assigned", assignedAt: new Date().toISOString() };
      await saveTaskState(testDir, ts);

      const state = await createDaemon(testDir);
      const conductor: ConductorState = {
        surface: "surface:t263-c9",
        startedAt: new Date().toISOString(),
        taskRunId,
        taskId: "263",
        taskTitle: "rebase-conflict",
        worktreePath,
        agents: [],
        status: "running",
      };
      state.conductors.set(conductor.surface, conductor);

      await handleMessage(state, {
        type: "CONDUCTOR_DONE",
        surface: "surface:t263-c9",
        success: false,
        reason: "rebase_conflict",
        timestamp: new Date().toISOString(),
      });

      // worktree / branch 温存
      expect(existsSync(worktreePath)).toBe(true);
      // in-memory ConductorState はリセット（idle 状態）
      expect(conductor.status).toBe("idle");
      expect(conductor.taskRunId).toBeUndefined();
      expect(conductor.taskId).toBeUndefined();
      expect(conductor.worktreePath).toBeUndefined();
      // ログに conductor_done_unresolved が記録される
      const log = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
      const unresolvedLine = log.split("\n").find((l) => l.includes("conductor_done_unresolved"));
      expect(unresolvedLine).toBeDefined();
      expect(unresolvedLine).toContain("task_id=263");
      expect(unresolvedLine).toContain("task_state=assigned");
      expect(unresolvedLine).toContain("reason=rebase_conflict");
      expect(unresolvedLine).toContain(`worktreePath=${worktreePath}`);
      // task_completed は出ていない
      expect(log).not.toMatch(/\btask_completed\b.*task_id=263/);
      // conductor_reset ログに worktree_preserved=true が含まれる
      const resetLine = log.split("\n").find((l) => l.includes("conductor_reset"));
      expect(resetLine).toBeDefined();
      expect(resetLine).toContain("worktree_preserved=true");
      // T269: task-state が aborted に遷移し、journal に原因が記録される
      const { loadTaskState: loadTaskStateC9 } = await import("./task");
      const tsAfter = await loadTaskStateC9(testDir);
      expect(tsAfter["263"]?.status).toBe("aborted");
      expect(tsAfter["263"]?.abortedAt).toBeDefined();
      expect(tsAfter["263"]?.journal).toContain("conductor_done_unresolved");
      expect(tsAfter["263"]?.journal).toContain("rebase_conflict");
      expect(tsAfter["263"]?.journal).toContain(`worktree=${worktreePath}`);
      // T290: journal は reason=judgment_pending; で始まる（log reason と journal prefix の構造的整合）
      expect(tsAfter["263"]?.journal).toMatch(/^reason=judgment_pending;/);
      // task_aborted ログに reason=judgment_pending が記録される
      expect(log).toMatch(/task_aborted task_id=263 reason=judgment_pending/);
    } finally {
      paneSpy.mockRestore();
    }
  }, 30000);

  test("Case #1: success=true && closed → task_completed + worktree 削除", async () => {
    const paneSpy = await stubPaneForSurface();
    try {
      const taskRunId = "task-263c1-1700001000";
      const worktreePath = await setupRealGitWithWorktree(taskRunId);
      await createTask("264", "normal-success");
      await closeTask("264");

      const state = await createDaemon(testDir);
      const conductor: ConductorState = {
        surface: "surface:t263-c1",
        startedAt: new Date().toISOString(),
        taskRunId,
        taskId: "264",
        taskTitle: "normal-success",
        worktreePath,
        agents: [],
        status: "running",
      };
      state.conductors.set(conductor.surface, conductor);

      await handleMessage(state, {
        type: "CONDUCTOR_DONE",
        surface: "surface:t263-c1",
        success: true,
        timestamp: new Date().toISOString(),
      });

      // worktree 削除
      expect(existsSync(worktreePath)).toBe(false);
      expect(conductor.status).toBe("idle");
      const log = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
      expect(log).toMatch(/task_completed .*task_id=264/);
      expect(log).not.toMatch(/conductor_done_unresolved/);
      // conductor_reset に worktree_preserved=true は含まれない
      const resetLine = log.split("\n").find((l) => l.includes("conductor_reset"));
      expect(resetLine).toBeDefined();
      expect(resetLine).not.toContain("worktree_preserved=true");
      // T269 regression guard: 成功経路では judgment_pending を出さない
      expect(log).not.toMatch(/task_aborted .*reason=judgment_pending/);
    } finally {
      paneSpy.mockRestore();
    }
  }, 30000);

  test("Case #6: success=false && closed → task_completed + worktree 削除（既に完結済み）", async () => {
    const paneSpy = await stubPaneForSurface();
    try {
      const taskRunId = "task-263c6-1700006000";
      const worktreePath = await setupRealGitWithWorktree(taskRunId);
      await createTask("265", "closed-then-false");
      await closeTask("265");

      const state = await createDaemon(testDir);
      const conductor: ConductorState = {
        surface: "surface:t263-c6",
        startedAt: new Date().toISOString(),
        taskRunId,
        taskId: "265",
        taskTitle: "closed-then-false",
        worktreePath,
        agents: [],
        status: "running",
      };
      state.conductors.set(conductor.surface, conductor);

      await handleMessage(state, {
        type: "CONDUCTOR_DONE",
        surface: "surface:t263-c6",
        success: false,
        reason: "late_false",
        timestamp: new Date().toISOString(),
      });

      // 既に closed なので worktree 削除で OK
      expect(existsSync(worktreePath)).toBe(false);
      expect(conductor.status).toBe("idle");
      const log = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
      expect(log).toMatch(/task_completed .*task_id=265/);
      expect(log).not.toMatch(/conductor_done_unresolved.*task_id=265/);
      // T269 regression guard: closed 経路では judgment_pending を出さない（冪等）
      expect(log).not.toMatch(/task_aborted task_id=265 reason=judgment_pending/);
    } finally {
      paneSpy.mockRestore();
    }
  }, 30000);

  test("Case #10: success=false && task-state entry なし → conductor_done_unresolved + worktree 温存", async () => {
    const paneSpy = await stubPaneForSurface();
    try {
      const taskRunId = "task-263c10-1700010000";
      const worktreePath = await setupRealGitWithWorktree(taskRunId);
      // task-state にエントリを入れない（race ケース）

      const state = await createDaemon(testDir);
      const conductor: ConductorState = {
        surface: "surface:t263-c10",
        startedAt: new Date().toISOString(),
        taskRunId,
        taskId: "266",
        taskTitle: "missing-entry",
        worktreePath,
        agents: [],
        status: "running",
      };
      state.conductors.set(conductor.surface, conductor);

      await handleMessage(state, {
        type: "CONDUCTOR_DONE",
        surface: "surface:t263-c10",
        success: false,
        reason: "missing_state",
        timestamp: new Date().toISOString(),
      });

      // 保守側倒しで worktree 温存
      expect(existsSync(worktreePath)).toBe(true);
      expect(conductor.status).toBe("idle");
      const log = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
      const unresolvedLine = log.split("\n").find((l) => l.includes("conductor_done_unresolved"));
      expect(unresolvedLine).toBeDefined();
      expect(unresolvedLine).toContain("task_state=missing");
      expect(unresolvedLine).toContain("reason=missing_state");
      // conductor_reset に worktree_preserved=true
      const resetLine = log.split("\n").find((l) => l.includes("conductor_reset"));
      expect(resetLine).toContain("worktree_preserved=true");
      // T269: missing エントリも user_clear 経路と同挙動で aborted エントリを新規作成
      const { loadTaskState: loadTaskStateC10 } = await import("./task");
      const tsAfter = await loadTaskStateC10(testDir);
      expect(tsAfter["266"]?.status).toBe("aborted");
      expect(tsAfter["266"]?.journal).toContain("conductor_done_unresolved");
      // T290: journal は reason=judgment_pending; で始まる
      expect(tsAfter["266"]?.journal).toMatch(/^reason=judgment_pending;/);
      expect(log).toMatch(/task_aborted task_id=266 reason=judgment_pending/);
    } finally {
      paneSpy.mockRestore();
    }
  }, 30000);
});

// --- T274: handleConductorDone success=true + 整合性ガード ---
//
// Conductor が close-task を呼ばずに CONDUCTOR_DONE --success=true だけを送った場合、
// task-state が assigned のまま残り TUI / resume が壊れる（~/git/Dear T204 事案）。
// daemon が保険として整合性ガードで state を closed に倒す or warn のみ残す。
describe("T274: handleConductorDone success=true + 整合性ガード", () => {
  async function setupRealGitWithWorktree(taskRunId: string): Promise<string> {
    const { execFile: ef } = await import("child_process");
    const { promisify } = await import("util");
    const execFile = promisify(ef);
    await execFile("git", ["init", "-q", "-b", "main"], { cwd: testDir });
    await execFile("git", ["config", "user.email", "test@test.local"], { cwd: testDir });
    await execFile("git", ["config", "user.name", "Test"], { cwd: testDir });
    await writeFile(join(testDir, "README.md"), "test");
    await execFile("git", ["add", "."], { cwd: testDir });
    await execFile("git", ["commit", "-q", "-m", "init"], { cwd: testDir });
    const worktreePath = join(testDir, ".worktrees", taskRunId);
    await execFile("git", ["worktree", "add", worktreePath, "-b", `${taskRunId}/task`], { cwd: testDir });
    return worktreePath;
  }

  async function stubPaneForSurface() {
    const cmux = await import("./cmux");
    const { spyOn } = await import("bun:test");
    return spyOn(cmux, "getPaneForSurface").mockResolvedValue("pane:1");
  }

  test("Case #1: success=true && assigned → auto-close + task_completed + worktree 削除", async () => {
    const paneSpy = await stubPaneForSurface();
    try {
      const taskRunId = "task-274c1-1700274001";
      const worktreePath = await setupRealGitWithWorktree(taskRunId);
      await createTask("274", "missing-close-task");
      // task-state を assigned に書き換え（createTask は ready のため）
      const { loadTaskState, saveTaskState } = await import("./task");
      const ts = await loadTaskState(testDir);
      ts["274"] = { status: "assigned", assignedAt: new Date().toISOString() };
      await saveTaskState(testDir, ts);

      const { initDB, getTaskSessions } = await import("./trace-store");
      const state = await createDaemon(testDir);
      state.traceDb = initDB(testDir);
      const conductor: ConductorState = {
        surface: "surface:t274-c1",
        startedAt: new Date().toISOString(),
        taskRunId,
        taskId: "274",
        taskTitle: "missing-close-task",
        worktreePath,
        sessionId: "sess-274-c1",
        agents: [],
        status: "running",
      };
      state.conductors.set(conductor.surface, conductor);

      await handleMessage(state, {
        type: "CONDUCTOR_DONE",
        surface: "surface:t274-c1",
        success: true,
        timestamp: new Date().toISOString(),
      });

      // worktree 削除
      expect(existsSync(worktreePath)).toBe(false);
      expect(conductor.status).toBe("idle");

      // task-state が closed に倒されている + journal に固定プレフィクス
      const { loadTaskState: loadTaskStateC1 } = await import("./task");
      const tsAfter = await loadTaskStateC1(testDir);
      expect(tsAfter["274"]?.status).toBe("closed");
      expect(tsAfter["274"]?.closedAt).toBeDefined();
      expect(tsAfter["274"]?.journal).toContain(
        "auto_closed_by_daemon: CONDUCTOR_DONE without close-task"
      );
      expect(tsAfter["274"]?.journal).toContain(`taskRunId=${taskRunId}`);
      // T295: auto-close 経路では deliverable.kind === "none" が付与される
      expect(tsAfter["274"]?.deliverable).toEqual({ kind: "none" });

      // manager.log に task_completed_state_mismatch が出る
      const log = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
      const mismatchLine = log.split("\n").find((l) => l.includes("task_completed_state_mismatch"));
      expect(mismatchLine).toBeDefined();
      expect(mismatchLine).toContain("task_id=274");
      expect(mismatchLine).toContain("prev_status=assigned");
      expect(mismatchLine).toContain("reason=missing_close_task");

      // task_completed auto_closed=true も出る
      expect(log).toMatch(/task_completed .*task_id=274.*auto_closed=true/);

      // trace DB: event="closed" 行が入っている
      const sessions = getTaskSessions(state.traceDb!, { taskId: "274", event: "closed" });
      expect(sessions.length).toBeGreaterThanOrEqual(1);
      expect(sessions[0]!.task_run_id).toBe(taskRunId);

      // T263/T269 regression: unresolved / judgment_pending は出ていない
      expect(log).not.toMatch(/conductor_done_unresolved.*task_id=274/);
      expect(log).not.toMatch(/task_aborted task_id=274/);
    } finally {
      paneSpy.mockRestore();
    }
  }, 30000);

  test("Case #2: success=true && task-state entry なし → warn+skip + worktree 削除", async () => {
    const paneSpy = await stubPaneForSurface();
    try {
      const taskRunId = "task-274c2-1700274002";
      const worktreePath = await setupRealGitWithWorktree(taskRunId);
      // task-state にエントリを入れない（race or 手動削除後の goodbye）

      const { initDB } = await import("./trace-store");
      const state = await createDaemon(testDir);
      state.traceDb = initDB(testDir);
      const conductor: ConductorState = {
        surface: "surface:t274-c2",
        startedAt: new Date().toISOString(),
        taskRunId,
        taskId: "275",
        taskTitle: "missing-state-entry",
        worktreePath,
        sessionId: "sess-274-c2",
        agents: [],
        status: "running",
      };
      state.conductors.set(conductor.surface, conductor);

      await handleMessage(state, {
        type: "CONDUCTOR_DONE",
        surface: "surface:t274-c2",
        success: true,
        timestamp: new Date().toISOString(),
      });

      // worktree 削除
      expect(existsSync(worktreePath)).toBe(false);
      expect(conductor.status).toBe("idle");

      // task-state に新規 entry を作らない
      const { loadTaskState: loadTaskStateC2 } = await import("./task");
      const tsAfter = await loadTaskStateC2(testDir);
      expect(tsAfter["275"]).toBeUndefined();

      // manager.log に task_completed_state_missing が出る
      const log = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
      const missingLine = log.split("\n").find((l) => l.includes("task_completed_state_missing"));
      expect(missingLine).toBeDefined();
      expect(missingLine).toContain("task_id=275");
      expect(missingLine).toContain("reason=missing_state_entry");

      // T263/T269 regression: unresolved / judgment_pending は出ていない
      expect(log).not.toMatch(/conductor_done_unresolved.*task_id=275/);
      expect(log).not.toMatch(/task_aborted task_id=275/);
    } finally {
      paneSpy.mockRestore();
    }
  }, 30000);
});

// --- T269: preserveWorktree 経路で aborted 化されたタスクが resume 対象外になる ---
//
// handleConductorDone で unresolved 分岐を通ると task-state は `aborted` になり、
// worktree は温存される。applyResumeTransitions は `status === "assigned"` のみ
// 走査するため、T269 後は同タスクが resume 対象から外れる。これにより daemon
// 再起動時の勝手な resume → /clear → user_clear 事故が防がれる。
describe("T269: preserveWorktree 経路のタスクが restart 時に resume されない", () => {
  async function setupRealGitWithWorktree(taskRunId: string): Promise<string> {
    const { execFile: ef } = await import("child_process");
    const { promisify } = await import("util");
    const execFile = promisify(ef);
    await execFile("git", ["init", "-q", "-b", "main"], { cwd: testDir });
    await execFile("git", ["config", "user.email", "test@test.local"], { cwd: testDir });
    await execFile("git", ["config", "user.name", "Test"], { cwd: testDir });
    await writeFile(join(testDir, "README.md"), "test");
    await execFile("git", ["add", "."], { cwd: testDir });
    await execFile("git", ["commit", "-q", "-m", "init"], { cwd: testDir });
    const worktreePath = join(testDir, ".worktrees", taskRunId);
    await execFile("git", ["worktree", "add", worktreePath, "-b", `${taskRunId}/task`], { cwd: testDir });
    return worktreePath;
  }

  async function stubPaneForSurface() {
    const cmux = await import("./cmux");
    const { spyOn } = await import("bun:test");
    return spyOn(cmux, "getPaneForSurface").mockResolvedValue("pane:1");
  }

  test("preserveWorktree → aborted → applyResumeTransitions で resume 対象外", async () => {
    const paneSpy = await stubPaneForSurface();
    try {
      const taskRunId = "task-269r-1700269000";
      const worktreePath = await setupRealGitWithWorktree(taskRunId);
      await createTask("269", "judgment-pending");
      const { loadTaskState: loadTS, saveTaskState: saveTS } = await import("./task");
      const tsBefore = await loadTS(testDir);
      // 再起動 resume 判定で必要な 4 条件を満たす状態を作る（plan §1-2 相当）
      tsBefore["269"] = {
        status: "assigned",
        sessionId: "session-269",
        taskRunId,
        worktreePath,
        assignedAt: new Date().toISOString(),
      };
      await saveTS(testDir, tsBefore);

      const state = await createDaemon(testDir);
      const conductor: ConductorState = {
        surface: "surface:t269-r1",
        startedAt: new Date().toISOString(),
        taskRunId,
        taskId: "269",
        taskTitle: "judgment-pending",
        worktreePath,
        agents: [],
        status: "running",
      };
      state.conductors.set(conductor.surface, conductor);

      // Conductor が自力完遂不能を報告
      await handleMessage(state, {
        type: "CONDUCTOR_DONE",
        surface: "surface:t269-r1",
        success: false,
        reason: "rebase_conflict",
        timestamp: new Date().toISOString(),
      });

      // 期待: task-state は aborted、worktree 温存
      const tsAfter = await loadTS(testDir);
      expect(tsAfter["269"]?.status).toBe("aborted");
      expect(existsSync(worktreePath)).toBe(true);

      // 再起動を模した resume 判定を直接呼ぶ
      const { applyResumeTransitions } = await import("./main");
      const { loadTasks } = await import("./task");
      const { tasks } = await loadTasks(testDir);
      const result = await applyResumeTransitions(tsAfter, tasks, {
        findTaskFile: async () => undefined,
        exists: () => true,
        now: () => new Date().toISOString(),
      });

      // 期待: resume plan にも abortTargets にも含まれない（既に aborted なので走査対象外）
      expect(result.resumePlan.map((p) => p.taskId)).not.toContain("269");
      expect(result.abortTargets.map((t) => t.taskId)).not.toContain("269");
    } finally {
      paneSpy.mockRestore();
    }
  }, 30000);

  test("cascade: 親 269 aborted → depends_on:[269] の ready 子 270 が draft に戻る", async () => {
    const paneSpy = await stubPaneForSurface();
    try {
      const taskRunId = "task-269c-1700269100";
      const worktreePath = await setupRealGitWithWorktree(taskRunId);
      await createTask("269", "parent-task");
      await createTask("270", "child-task", { dependsOn: ["269"] });
      const { loadTaskState: loadTS, saveTaskState: saveTS } = await import("./task");
      const tsBefore = await loadTS(testDir);
      tsBefore["269"] = { status: "assigned", assignedAt: new Date().toISOString() };
      tsBefore["270"] = { status: "ready" };
      await saveTS(testDir, tsBefore);

      const state = await createDaemon(testDir);
      const conductor: ConductorState = {
        surface: "surface:t269-casc",
        startedAt: new Date().toISOString(),
        taskRunId,
        taskId: "269",
        taskTitle: "parent-task",
        worktreePath,
        agents: [],
        status: "running",
      };
      state.conductors.set(conductor.surface, conductor);

      await handleMessage(state, {
        type: "CONDUCTOR_DONE",
        surface: "surface:t269-casc",
        success: false,
        reason: "rebase_conflict",
        timestamp: new Date().toISOString(),
      });

      const tsAfter = await loadTS(testDir);
      expect(tsAfter["269"]?.status).toBe("aborted");
      expect(tsAfter["270"]?.status).toBe("draft");

      const log = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
      expect(log).toMatch(/child_reverted_to_draft parent=269 child=270 reason=parent_aborted/);
    } finally {
      paneSpy.mockRestore();
    }
  }, 30000);
});

// ---------- T266: NOTIFICATION hook の daemon 集約 ----------

describe("handleMessage: T216 不変条件 — 入口で必ず insertHookSignal", () => {
  test("NOTIFICATION も他 type と同様 hook_signals に 1 行 INSERT される", async () => {
    const { createDaemon, handleMessage } = await import("./daemon");
    const { initDB, getHookSignals } = await import("./trace-store");
    const state = await createDaemon(testDir);
    state.traceDb = initDB(testDir);

    // 任意の型 (TASK_UPDATED) で 1 行
    await handleMessage(state, {
      type: "TASK_UPDATED",
      taskId: "T266",
      timestamp: "2026-04-19T12:00:00.000Z",
    } as any);

    // NOTIFICATION で 1 行
    await handleMessage(state, {
      type: "NOTIFICATION",
      surface: "surface:9999",
      pid: 11111,
      payload: { message: "hello" },
      timestamp: "2026-04-19T12:00:01.000Z",
    } as any);

    expect(state.traceDb).not.toBeNull();
    const taskUpdated = getHookSignals(state.traceDb!, { type: "TASK_UPDATED" });
    const notification = getHookSignals(state.traceDb!, { type: "NOTIFICATION" });
    expect(taskUpdated.length).toBe(1);
    expect(notification.length).toBe(1);
  });
});

describe("handleMessage: NOTIFICATION case (T266)", () => {
  test("Master: role=master / task_id NULL / manager.log に notification_received", async () => {
    const { createDaemon, handleMessage } = await import("./daemon");
    const { initDB, getHookSignals } = await import("./trace-store");
    const state = await createDaemon(testDir);
    state.traceDb = initDB(testDir);

    state.masters.set("surface:100", {
      surface: "surface:100",
      status: "running",
      pid: 1000,
      startedAt: "2026-04-19T11:00:00.000Z",
    });

    await handleMessage(state, {
      type: "NOTIFICATION",
      surface: "surface:100",
      surfaceUuid: "abcdef12-3456-7890-abcd-ef0122d8f9",
      pid: 1000,
      payload: { message: "hello master", type: "idle_prompt" },
      timestamp: "2026-04-19T12:00:00.000Z",
    } as any);

    // state 遷移なし
    const m = state.masters.get("surface:100")!;
    expect(m.status).toBe("running");

    // DB: 1 行 + 8 列が UPDATE されている
    const rows = getHookSignals(state.traceDb!, { type: "NOTIFICATION" });
    expect(rows.length).toBe(1);
    const r = rows[0]!;
    expect(r.role).toBe("master");
    expect(r.task_id).toBeNull();
    expect(r.conductor_surface).toBeNull();
    expect(r.agent_role).toBeNull();
    expect(r.message).toBe("hello master");
    expect(r.notification_type).toBe("idle_prompt");
    expect(r.surface_uuid).toBe("abcdef12-3456-7890-abcd-ef0122d8f9");

    const logContent = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
    expect(logContent).toMatch(/notification_received U\[100\/22D8F9\] role=master/);
    expect(logContent).toContain("pid=1000");
    expect(logContent).toContain("ntype=idle_prompt");
    expect(logContent).toContain('message="hello master"');
  });

  test("Conductor: role=conductor / task_id 付与 / C[surface] 表記", async () => {
    const { createDaemon, handleMessage } = await import("./daemon");
    const { initDB, getHookSignals } = await import("./trace-store");
    const state = await createDaemon(testDir);
    state.traceDb = initDB(testDir);

    const conductor: ConductorState = {
      surface: "surface:192",
      startedAt: "2026-04-19T11:00:00.000Z",
      agents: [],
      status: "running",
      pid: 2000,
      taskId: "265",
      taskRunId: "task-265-1",
    };
    state.conductors.set(conductor.surface, conductor);

    await handleMessage(state, {
      type: "NOTIFICATION",
      surface: "surface:192",
      surfaceUuid: "abcdef12-3456-7890-abcd-ef0122d8f9",
      pid: 2000,
      role: "conductor",
      payload: { message: "conductor idle", notification_type: "idle_prompt" },
      timestamp: "2026-04-19T12:00:00.000Z",
    } as any);

    // state 遷移なし
    expect(state.conductors.get("surface:192")!.status).toBe("running");

    const rows = getHookSignals(state.traceDb!, { type: "NOTIFICATION" });
    expect(rows.length).toBe(1);
    const r = rows[0]!;
    expect(r.role).toBe("conductor");
    expect(r.task_id).toBe("265");
    expect(r.conductor_surface).toBe("surface:192");
    expect(r.agent_role).toBeNull();
    expect(r.notification_type).toBe("idle_prompt");

    const logContent = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
    expect(logContent).toMatch(/notification_received C\[192\/22D8F9\] role=conductor task_id=265/);
  });

  test("Agent: role=agent / 親 Conductor の task_id / agent_role 付与", async () => {
    const { createDaemon, handleMessage } = await import("./daemon");
    const { initDB, getHookSignals } = await import("./trace-store");
    const state = await createDaemon(testDir);
    state.traceDb = initDB(testDir);

    const conductor: ConductorState = {
      surface: "surface:665",
      startedAt: "2026-04-19T11:00:00.000Z",
      agents: [
        {
          surface: "surface:719",
          role: "implementer",
          spawnedAt: "2026-04-19T11:05:00.000Z",
          status: "running",
          pid: 3001,
        },
      ],
      status: "running",
      pid: 3000,
      taskId: "300",
      taskRunId: "task-300-1",
    };
    state.conductors.set(conductor.surface, conductor);

    await handleMessage(state, {
      type: "NOTIFICATION",
      surface: "surface:719",
      surfaceUuid: "xxxxxx00-0000-0000-0000-00000000ABcdef",
      pid: 3001,
      role: "agent",
      payload: { message: "agent asks confirmation", notification_type: "permission_request" },
      timestamp: "2026-04-19T12:00:00.000Z",
    } as any);

    const rows = getHookSignals(state.traceDb!, { type: "NOTIFICATION" });
    expect(rows.length).toBe(1);
    const r = rows[0]!;
    expect(r.role).toBe("agent");
    expect(r.task_id).toBe("300");
    expect(r.conductor_surface).toBe("surface:665");
    expect(r.agent_role).toBe("implementer");

    const logContent = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
    expect(logContent).toMatch(/notification_received A\[719\/ABCDEF\] role=agent task_id=300 agent_role=implementer/);
  });

  test("unknown: role なし surface も未登録 → role=unknown / S[surface]", async () => {
    const { createDaemon, handleMessage } = await import("./daemon");
    const { initDB, getHookSignals } = await import("./trace-store");
    const state = await createDaemon(testDir);
    state.traceDb = initDB(testDir);

    await handleMessage(state, {
      type: "NOTIFICATION",
      surface: "surface:9999",
      pid: 4000,
      payload: { message: "mystery" },
      timestamp: "2026-04-19T12:00:00.000Z",
    } as any);

    const rows = getHookSignals(state.traceDb!, { type: "NOTIFICATION" });
    expect(rows.length).toBe(1);
    const r = rows[0]!;
    expect(r.role).toBe("unknown");
    expect(r.task_id).toBeNull();
    expect(r.conductor_surface).toBeNull();
    expect(r.agent_role).toBeNull();

    const logContent = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
    expect(logContent).toMatch(/notification_received S\[9999\] role=unknown/);
  });

  test("escape: message 内の \" / 改行 / = が JSON.stringify で安全に記録される", async () => {
    const { createDaemon, handleMessage } = await import("./daemon");
    const { initDB } = await import("./trace-store");
    const state = await createDaemon(testDir);
    state.traceDb = initDB(testDir);

    await handleMessage(state, {
      type: "NOTIFICATION",
      surface: "surface:9999",
      pid: 4000,
      payload: { message: 'he said "hi"\nkey=val' },
      timestamp: "2026-04-19T12:00:00.000Z",
    } as any);

    const logContent = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
    // JSON.stringify で quote/newline/bs がエスケープされて 1 行に収まる
    expect(logContent).toMatch(/message="he said \\"hi\\"\\nkey=val"/);
  });

  test("traceDb 不在 → notification_skipped reason=no_db", async () => {
    const { createDaemon, handleMessage } = await import("./daemon");
    const state = await createDaemon(testDir);

    // DB を close して null にして、insertHookSignal 経路・UPDATE 経路の両方をスキップさせる
    try { state.traceDb?.close(); } catch {}
    state.traceDb = null;

    await handleMessage(state, {
      type: "NOTIFICATION",
      surface: "surface:9999",
      pid: 4000,
      payload: { message: "no db" },
      timestamp: "2026-04-19T12:00:00.000Z",
    } as any);

    const logContent = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
    expect(logContent).toMatch(/notification_skipped reason=no_db S\[9999\]/);
    expect(logContent).not.toContain("notification_received");
  });
});

// T302 assign_skipped_terminal guard テストは T303 で reducer noop に吸収された。
// applyTaskEvent(ASSIGN_OK) on terminal が committed=false を返す挙動は
// state-machine/task-state-store.test.ts の以下テストでカバー:
//   - "reducer noop: ASSIGN_OK on closed"
//   - "reducer noop on aborted: ASSIGN_OK noop (T302 guard 相当)"
//   - "reducer noop on deleted: ASSIGN_OK noop"
// T303 で挙動変更: missing entry (undefined) は `assign_skipped_unexpected` (reset せず)
//   に倒す (§3.6 R7)。従来の「undefined → assigned 書き込み」挙動は撤去。

// T315: .team/.gitignore テンプレートに daemon.pid と gh-cache.db* を追加
describe("initInfra: .team/.gitignore (T315)", () => {
  const T315_RUNTIME_ENTRIES = [
    "daemon.pid",
    "gh-cache.db",
    "gh-cache.db-shm",
    "gh-cache.db-wal",
  ] as const;

  test("新規生成: 4 項目すべてが template に含まれる", async () => {
    const state = await createDaemon(testDir);
    const { initInfra } = await import("./daemon");
    await initInfra(state);

    const content = await readFile(join(testDir, ".team/.gitignore"), "utf-8");
    const lines = content.split("\n").map((l) => l.trim());
    for (const name of T315_RUNTIME_ENTRIES) {
      expect(lines).toContain(name);
    }
    // proxy-port の直後に daemon.pid が来ること（T315 挿入位置）
    const proxyPortIdx = lines.indexOf("proxy-port");
    const daemonPidIdx = lines.indexOf("daemon.pid");
    expect(proxyPortIdx).toBeGreaterThanOrEqual(0);
    expect(daemonPidIdx).toBe(proxyPortIdx + 1);
  });

  test("migration: 旧 gitignore に 4 項目が追記される", async () => {
    // rate-limit.json と masters/ は含まれているが daemon.pid / gh-cache.db* は無い旧状態
    const legacy = [
      "# セッション固有（追跡不要）",
      "team.json",
      "masters/",
      "proxy-port",
      "rate-limit.json",
      "logs/",
      "output/",
      "prompts/",
      "queue/",
      "traces/",
      "sessions/",
      "conductors/",
      "docs-snapshot/",
      "e2e-results/",
      "",
    ].join("\n");
    await writeFile(join(testDir, ".team/.gitignore"), legacy);

    const state = await createDaemon(testDir);
    const { initInfra } = await import("./daemon");
    await initInfra(state);

    const content = await readFile(join(testDir, ".team/.gitignore"), "utf-8");
    const trimmed = content.split("\n").map((l) => l.trim());
    for (const name of T315_RUNTIME_ENTRIES) {
      expect(trimmed).toContain(name);
    }

    const logContent = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
    // team_gitignore_migrated ログに 4 項目すべてが現れる
    const migratedLine = logContent
      .split("\n")
      .find((l) => l.includes("team_gitignore_migrated"));
    expect(migratedLine).toBeDefined();
    for (const name of T315_RUNTIME_ENTRIES) {
      expect(migratedLine).toContain(name);
    }
  });

  test("冪等性: 2 回目の initInfra で内容が変化しない", async () => {
    const state = await createDaemon(testDir);
    const { initInfra } = await import("./daemon");
    await initInfra(state);
    const firstPass = await readFile(join(testDir, ".team/.gitignore"), "utf-8");

    // 同じ state で再実行
    await initInfra(state);
    const secondPass = await readFile(join(testDir, ".team/.gitignore"), "utf-8");

    expect(secondPass).toBe(firstPass);
  });

  test("冪等性: migration 後に再実行しても変化しない", async () => {
    const legacy = [
      "# セッション固有（追跡不要）",
      "team.json",
      "masters/",
      "proxy-port",
      "rate-limit.json",
      "",
    ].join("\n");
    await writeFile(join(testDir, ".team/.gitignore"), legacy);

    const state = await createDaemon(testDir);
    const { initInfra } = await import("./daemon");
    await initInfra(state);
    const afterMigrate = await readFile(join(testDir, ".team/.gitignore"), "utf-8");

    await initInfra(state);
    const afterSecond = await readFile(join(testDir, ".team/.gitignore"), "utf-8");

    expect(afterSecond).toBe(afterMigrate);
  });

  test("コメントアウト行は未記載扱い（コメントは残し本行を追記）", async () => {
    const legacy = [
      "# セッション固有（追跡不要）",
      "team.json",
      "masters/",
      "proxy-port",
      "# daemon.pid",
      "rate-limit.json",
      "",
    ].join("\n");
    await writeFile(join(testDir, ".team/.gitignore"), legacy);

    const state = await createDaemon(testDir);
    const { initInfra } = await import("./daemon");
    await initInfra(state);

    const content = await readFile(join(testDir, ".team/.gitignore"), "utf-8");
    const rawLines = content.split("\n");
    // コメント行は残っている
    expect(rawLines).toContain("# daemon.pid");
    // 本行も追記されている
    expect(rawLines).toContain("daemon.pid");
  });
});

// --- T323: AGENT_TOKEN_BOUND ハンドラと updateTeamJson の tokenHandle 出力 ---

describe("handleMessage: AGENT_TOKEN_BOUND case (T323)", () => {
  test("agent.tokenHandle が更新され notifyStateChanged 経由で永続化される", async () => {
    const { createDaemon, handleMessage, updateTeamJson } = await import("./daemon");
    const state = await createDaemon(testDir);

    const conductorSurface = "surface:323a";
    const agentSurface = "surface:323a-agent";
    state.conductors.set(conductorSurface, {
      surface: conductorSurface,
      startedAt: new Date().toISOString(),
      agents: [
        {
          surface: agentSurface,
          spawnedAt: new Date().toISOString(),
          status: "starting",
        },
      ],
      status: "running",
    });

    await handleMessage(state, {
      type: "AGENT_TOKEN_BOUND",
      surface: agentSurface,
      tokenHandle: "@kddi",
      timestamp: new Date().toISOString(),
    });

    const c = state.conductors.get(conductorSurface);
    const a = c?.agents.find((x) => x.surface === agentSurface);
    expect(a?.tokenHandle).toBe("@kddi");

    // updateTeamJson 経由で永続化される
    await updateTeamJson(state);
    const teamJson = JSON.parse(
      await readFile(join(testDir, ".team/team.json"), "utf-8"),
    );
    const sc = teamJson.conductors.find((x: any) => x.surface === conductorSurface);
    const sa = sc?.agents.find((x: any) => x.surface === agentSurface);
    expect(sa?.tokenHandle).toBe("@kddi");
  });

  test("対象 agent が見つからなければ orphan ログ + state 変更なし", async () => {
    const { createDaemon, handleMessage } = await import("./daemon");
    const state = await createDaemon(testDir);

    await handleMessage(state, {
      type: "AGENT_TOKEN_BOUND",
      surface: "surface:nonexistent",
      tokenHandle: "@kddi",
      timestamp: new Date().toISOString(),
    });

    expect(state.conductors.size).toBe(0);
    const logContent = await readFile(
      join(testDir, ".team/logs/manager.log"),
      "utf-8",
    );
    expect(logContent).toContain("agent_token_bound_orphan");
  });
});

describe("updateTeamJson: tokenHandle シリアライズ (T323)", () => {
  test("master / conductor / agent の tokenHandle が team.json に出力される", async () => {
    const { createDaemon, updateTeamJson } = await import("./daemon");
    const state = await createDaemon(testDir);

    state.masters.set("surface:m1", {
      surface: "surface:m1",
      pid: 11111,
      status: "idle",
      startedAt: new Date().toISOString(),
      tokenHandle: "@pers",
    });

    state.conductors.set("surface:c1", {
      surface: "surface:c1",
      startedAt: new Date().toISOString(),
      agents: [
        {
          surface: "surface:a1",
          spawnedAt: new Date().toISOString(),
          status: "running",
          tokenHandle: "@kddi",
        },
      ],
      status: "running",
      tokenHandle: "@pers",
    });

    await updateTeamJson(state);

    const teamJson = JSON.parse(
      await readFile(join(testDir, ".team/team.json"), "utf-8"),
    );
    const m = teamJson.masters.find((x: any) => x.surface === "surface:m1");
    expect(m?.tokenHandle).toBe("@pers");
    const c = teamJson.conductors.find((x: any) => x.surface === "surface:c1");
    expect(c?.tokenHandle).toBe("@pers");
    const a = c?.agents.find((x: any) => x.surface === "surface:a1");
    expect(a?.tokenHandle).toBe("@kddi");
  });
});

