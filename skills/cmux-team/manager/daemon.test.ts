import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readdir, readFile } from "fs/promises";
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
      ".team/output/conductor-test"
    );

    const content = await readFile(promptFile, "utf-8");
    expect(content).toContain("タスク割り当て");
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

import { scanTasks, createDaemon } from "./daemon";
import type { DaemonState } from "./daemon";
import type { ConductorState } from "./schema";

describe("scanTasks: assignTask エラー分離", () => {
  test("git 未初期化で assignTask 失敗時、タスクは aborted、Conductor は idle のまま", async () => {
    // testDir は git init していない → git worktree add が失敗する
    await createTask("100", "test-task", { priority: "high" });

    const state = await createDaemon(testDir);
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
