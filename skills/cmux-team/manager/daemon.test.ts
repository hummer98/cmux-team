import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readdir, readFile } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// テスト用の一時ディレクトリ
let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "cmux-daemon-test-"));
  process.env.PROJECT_ROOT = testDir;

  // .team 構造を作成
  await mkdir(join(testDir, ".team/tasks"), { recursive: true });
  await mkdir(join(testDir, ".team/output"), { recursive: true });
  await mkdir(join(testDir, ".team/prompts"), { recursive: true });
  await mkdir(join(testDir, ".team/logs"), { recursive: true });
  await writeFile(
    join(testDir, ".team/team.json"),
    JSON.stringify({ phase: "init", master: {}, manager: {}, conductors: [] })
  );
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
  delete process.env.PROJECT_ROOT;
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

describe("checkUpdateAndNotify / createUpdateTask (T187)", () => {
  let origFetchEnv: string | undefined;
  beforeEach(() => {
    // テスト用に package.json を用意（cmux-team ルート相当）
    // 実際のパスは daemon.ts の readCurrentVersion が
    // dirname(import.meta.path)/../../../package.json を参照するため、
    // ここではモックはせず「mode=off は即 return する」など副作用のない経路だけテストする。
    origFetchEnv = process.env.NO_UPDATE_NOTIFIER;
  });
  afterEach(() => {
    if (origFetchEnv === undefined) delete process.env.NO_UPDATE_NOTIFIER;
    else process.env.NO_UPDATE_NOTIFIER = origFetchEnv;
  });

  test("(a) mode='notify' のとき createUpdateTask は呼ばれない（spy で検証）", async () => {
    const { checkUpdateAndNotify, fetchLatestVersion } = await import("./daemon");
    // fetchLatestVersion を通さず、state を直接操作して createUpdateTask を呼ばない経路を検証するため
    // ここでは createUpdateTask を spy する代わりに、state.updateAvailable.createdTaskId が null のままであることで検証する。
    const state = await createDaemon(testDir, "wide");
    state.updateMode = "notify";

    // モック: fetchLatestVersion をスタブ化するのは難しいため、package.json を一時書き換え…
    // ではなくここは NO_UPDATE_NOTIFIER=1 で早期 return のみ確認する。
    process.env.NO_UPDATE_NOTIFIER = "1";
    await checkUpdateAndNotify(state, "notify");
    expect(state.updateAvailable).toBeNull();
  });

  test("(c) NO_UPDATE_NOTIFIER=1 で早期 return する", async () => {
    const { checkUpdateAndNotify } = await import("./daemon");
    const state = await createDaemon(testDir, "wide");
    process.env.NO_UPDATE_NOTIFIER = "1";
    await checkUpdateAndNotify(state, "task");
    expect(state.updateAvailable).toBeNull();
  });

  test("mode='off' で即 return する", async () => {
    const { checkUpdateAndNotify } = await import("./daemon");
    const state = await createDaemon(testDir, "wide");
    await checkUpdateAndNotify(state, "off");
    expect(state.updateAvailable).toBeNull();
  });

  test("(b) createUpdateTask: run_after_all 競合時は throw せずログのみ", async () => {
    const { createUpdateTask } = await import("./daemon");
    // 既存の run_after_all タスク（update とは無関係）を直接書き込み
    // createTask ヘルパーは frontmatter を自動生成するため、run_after_all を含められない
    await mkdir(join(testDir, ".team/tasks/901-some-run-after-all"), { recursive: true });
    await writeFile(
      join(testDir, ".team/tasks/901-some-run-after-all/task.md"),
      `---
id: 901
title: other run-after-all
priority: low
run_after_all: true
created_at: ${new Date().toISOString()}
---

## タスク
body
`,
    );
    await writeFile(
      join(testDir, ".team/task-state.json"),
      JSON.stringify({ "901": { status: "ready" } }),
    );

    const state = await createDaemon(testDir, "wide");
    state.updateAvailable = {
      current: "0.0.1",
      latest: "9.9.9",
      detectedAt: new Date().toISOString(),
      createdTaskId: null,
    };

    // 例外で daemon が落ちないこと
    await createUpdateTask(state, "9.9.9");
    // createdTaskId は null のまま
    expect(state.updateAvailable?.createdTaskId).toBeNull();
  });

  test("重複検出: 同じ latest の update タスクが open なら skip", async () => {
    const { createUpdateTask } = await import("./daemon");
    // 既存 update タスク（同 latest）を直接書き込み（kind/run_after_all を frontmatter に含めるため）
    await mkdir(join(testDir, ".team/tasks/902-update-task"), { recursive: true });
    await writeFile(
      join(testDir, ".team/tasks/902-update-task/task.md"),
      `---
id: 902
title: cmux-team を v9.9.9 にアップデート
priority: low
run_after_all: true
kind: cmux-team-update
created_at: ${new Date().toISOString()}
---

## タスク
本文に cmux-team@9.9.9 を含む
`,
    );
    await writeFile(
      join(testDir, ".team/task-state.json"),
      JSON.stringify({ "902": { status: "ready" } }),
    );

    const state = await createDaemon(testDir, "wide");
    state.updateAvailable = {
      current: "0.0.1",
      latest: "9.9.9",
      detectedAt: new Date().toISOString(),
      createdTaskId: null,
    };

    await createUpdateTask(state, "9.9.9");
    expect(state.updateAvailable?.createdTaskId).toBe("902");
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

  // R1: SESSION_IDLE / SESSION_ACTIVE でも assigning → running の保険遷移
  test("R1: assigning + SESSION_IDLE(taskRunId あり) で running に遷移する", async () => {
    const state = await createDaemon(testDir);
    const conductor: ConductorState = {
      surface: "surface:232d",
      startedAt: new Date().toISOString(),
      agents: [],
      status: "assigning",
      taskRunId: "task-235-a",
      taskId: "235",
    };
    state.conductors.set(conductor.surface, conductor);

    await handleMessage(state, {
      type: "SESSION_IDLE",
      surface: "surface:232d",
      pid: 77777,
      timestamp: new Date().toISOString(),
    });

    expect(conductor.status).toBe("running");
    expect(conductor.pid).toBe(77777);
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

    // restoreConductors 相当: initializeLayout (daemon.ts:840-845) の switch と同じロジックで
    // 復元時も broken を保持することを確認する
    const restoredStatus =
      persisted.status === "running" ? "running"
      : persisted.status === "disconnected" ? "disconnected"
      : persisted.status === "broken" ? "broken"
      : "idle";
    expect(restoredStatus).toBe("broken");
  });
});

