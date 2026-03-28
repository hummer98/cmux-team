import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
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
  await mkdir(join(testDir, ".team/queue/processed"), { recursive: true });
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
  } = {}
): Promise<void> {
  const {
    status = "ready",
    priority = "medium",
    dependsOn,
    content = "テストタスク",
  } = opts;

  let yaml = `---
id: ${id}
title: ${slug}
priority: ${priority}
created_at: ${new Date().toISOString()}`;

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

// ヘルパー: キューメッセージを作成
async function enqueueMessage(message: any): Promise<void> {
  const ts = Math.floor(Date.now() / 1000);
  const fileName = `${ts}-${message.type.toLowerCase()}.json`;
  await writeFile(
    join(testDir, ".team/queue", fileName),
    JSON.stringify(message)
  );
}

// --- task.ts の統合テスト（ファイルシステム経由）---

import { loadTasks, filterExecutableTasks, sortByPriority } from "./task";
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

// --- キュー統合テスト ---

import { readQueue, markProcessed, sendMessage, ensureQueueDirs } from "./queue";

describe("キュー処理（ファイルシステム統合）", () => {
  test("SHUTDOWN メッセージが正しく伝達される", async () => {
    await enqueueMessage({
      type: "SHUTDOWN",
      timestamp: new Date().toISOString(),
    });

    const messages = await readQueue();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.message.type).toBe("SHUTDOWN");
  });

  test("複数メッセージがタイムスタンプ順に処理される", async () => {
    // 意図的に逆順で作成
    await writeFile(
      join(testDir, ".team/queue/003-shutdown.json"),
      JSON.stringify({ type: "SHUTDOWN", timestamp: new Date().toISOString() })
    );
    await writeFile(
      join(testDir, ".team/queue/001-task.json"),
      JSON.stringify({
        type: "TASK_CREATED",
        taskId: "1",
        taskFile: ".team/tasks/001.md",
        timestamp: new Date().toISOString(),
      })
    );
    await writeFile(
      join(testDir, ".team/queue/002-agent-done.json"),
      JSON.stringify({
        type: "AGENT_DONE",
        conductorId: "conductor-1",
        surface: "surface:1",
        timestamp: new Date().toISOString(),
      })
    );

    const messages = await readQueue();
    expect(messages.map((m) => m.message.type)).toEqual([
      "TASK_CREATED",
      "AGENT_DONE",
      "SHUTDOWN",
    ]);
  });

  test("不正な JSON ファイルはスキップされる", async () => {
    await writeFile(
      join(testDir, ".team/queue/001-bad.json"),
      "this is not json"
    );
    await writeFile(
      join(testDir, ".team/queue/002-good.json"),
      JSON.stringify({
        type: "SHUTDOWN",
        timestamp: new Date().toISOString(),
      })
    );

    const messages = await readQueue();
    // 不正なファイルはスキップされ、正常なものだけ返る
    expect(messages).toHaveLength(1);
    expect(messages[0]!.message.type).toBe("SHUTDOWN");
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
    expect(content).toContain("done");
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
