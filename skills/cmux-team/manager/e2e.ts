#!/usr/bin/env bun
/**
 * E2E テストランナー
 *
 * 実際の cmux workspace で daemon + Conductor を起動し、
 * Claude Code に実際のタスクを実行させてフルライフサイクルを検証する。
 *
 * Usage:
 *   ./e2e.ts [scenario]
 *
 * Scenarios:
 *   sequential   — UC1: 順序付き依存実行 (調査→設計→実装)
 *   parallel     — UC2: 並列調査 → 統合レポート
 *   interrupt    — UC3: 実装中の割り込み TODO
 *   all          — 全シナリオ実行
 *
 * 結果は .team/e2e-results/<timestamp>/ に保存される。
 * 各 Conductor のセッションは manager.log の session= から claude --resume で参照可能。
 */

import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { mkdir, writeFile, readFile, readdir, rm, cp } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

const execFile = promisify(execFileCb);

// --- 設定 ---
const SCRIPT_DIR = import.meta.dir;
const MAIN_TS = join(SCRIPT_DIR, "main.ts");
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const RESULTS_BASE = join(SCRIPT_DIR, "../../../.team/e2e-results");
const RESULTS_DIR = join(RESULTS_BASE, TIMESTAMP);

let testProjectRoot: string;
let passed = 0;
let failed = 0;
const results: Array<{ scenario: string; status: "pass" | "fail"; detail: string; duration: number }> = [];

// --- ユーティリティ ---

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mainTs(...args: string[]): Promise<string> {
  try {
    const { stdout } = await execFile("bun", ["run", MAIN_TS, ...args], {
      cwd: testProjectRoot,
      timeout: 30_000,
      env: { ...process.env, PROJECT_ROOT: testProjectRoot },
    });
    return stdout.trim();
  } catch (e: any) {
    return e.stdout?.trim() || e.message;
  }
}

async function createTaskFile(
  id: string,
  slug: string,
  opts: { status?: string; priority?: string; dependsOn?: string[]; content?: string } = {}
): Promise<string> {
  const { status = "ready", priority = "medium", dependsOn, content = "E2E テストタスク" } = opts;
  let yaml = `---\nid: ${id}\ntitle: ${slug}\npriority: ${priority}\nstatus: ${status}\ncreated_at: ${new Date().toISOString()}\n`;
  if (dependsOn?.length) yaml += `depends_on: [${dependsOn.join(", ")}]\n`;
  yaml += `---\n\n## タスク\n${content}\n\n## 完了条件\n- 指示された成果物が作成されていること\n`;

  const fileName = `${id.padStart(3, "0")}-${slug}.md`;
  const filePath = join(testProjectRoot, `.team/tasks/open/${fileName}`);
  await writeFile(filePath, yaml);
  return filePath;
}

async function readLog(): Promise<string> {
  try {
    return await readFile(join(testProjectRoot, ".team/logs/manager.log"), "utf-8");
  } catch {
    return "";
  }
}

async function waitForLog(pattern: string, timeoutMs: number = 180_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const log = await readLog();
    if (log.includes(pattern)) return true;
    await sleep(3000);
    process.stdout.write(".");
  }
  process.stdout.write("\n");
  return false;
}

async function captureSnapshot(label: string): Promise<void> {
  const snapDir = join(RESULTS_DIR, "snapshots");
  await mkdir(snapDir, { recursive: true });

  // manager.log
  try {
    const log = await readLog();
    await writeFile(join(snapDir, `${label}-manager.log`), log);
  } catch {}

  // queue/processed
  try {
    const qDir = join(testProjectRoot, ".team/queue/processed");
    if (existsSync(qDir)) {
      const files = await readdir(qDir);
      for (const f of files) {
        await cp(join(qDir, f), join(snapDir, `${label}-queue-${f}`));
      }
    }
  } catch {}

  // team.json
  try {
    await cp(join(testProjectRoot, ".team/team.json"), join(snapDir, `${label}-team.json`));
  } catch {}

  // tasks/closed
  try {
    const closedDir = join(testProjectRoot, ".team/tasks/closed");
    if (existsSync(closedDir)) {
      const files = await readdir(closedDir);
      for (const f of files) {
        await cp(join(closedDir, f), join(snapDir, `${label}-closed-${f}`));
      }
    }
  } catch {}
}

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.log(`  ✗ ${message}`);
    failed++;
  }
}

// --- セットアップ ---

async function setup(): Promise<void> {
  testProjectRoot = join(RESULTS_BASE, "workspace");
  await rm(testProjectRoot, { recursive: true, force: true });
  await mkdir(testProjectRoot, { recursive: true });

  const dirs = ["tasks/open", "tasks/closed", "queue/processed", "output", "prompts", "logs", "scripts"];
  for (const d of dirs) {
    await mkdir(join(testProjectRoot, `.team/${d}`), { recursive: true });
  }

  await writeFile(
    join(testProjectRoot, ".team/team.json"),
    JSON.stringify({ phase: "init", master: {}, manager: {}, conductors: [] }, null, 2)
  );

  // git init（worktree に必要）
  await execFile("git", ["init"], { cwd: testProjectRoot });
  await writeFile(join(testProjectRoot, "README.md"), "# E2E Test Project\n");
  await execFile("git", ["add", "-A"], { cwd: testProjectRoot });
  await execFile("git", ["commit", "-m", "init"], { cwd: testProjectRoot });

  // spawn-conductor.sh 等をコピー
  const scriptsDir = join(SCRIPT_DIR, "../scripts");
  if (existsSync(scriptsDir)) {
    for (const f of await readdir(scriptsDir)) {
      if (f.endsWith(".sh")) {
        await cp(join(scriptsDir, f), join(testProjectRoot, `.team/scripts/${f}`));
      }
    }
  }

  // manager ランタイムをコピー
  const managerDst = join(testProjectRoot, ".team/manager");
  await mkdir(managerDst, { recursive: true });
  for (const f of ["main.ts", "daemon.ts", "queue.ts", "schema.ts", "conductor.ts",
    "master.ts", "cmux.ts", "template.ts", "logger.ts", "task.ts",
    "dashboard.tsx", "package.json", "bun.lock", "tsconfig.json"]) {
    if (existsSync(join(SCRIPT_DIR, f))) {
      await cp(join(SCRIPT_DIR, f), join(managerDst, f));
    }
  }
  await execFile("bun", ["install"], { cwd: managerDst });

  await mkdir(RESULTS_DIR, { recursive: true });

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  cmux-team E2E Test Runner`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Workspace: ${testProjectRoot}`);
  console.log(`  Results:   ${RESULTS_DIR}`);
  console.log(`  Time:      ${new Date().toISOString()}`);
  console.log(`${"═".repeat(60)}\n`);
}

async function startDaemon(): Promise<void> {
  console.log("Starting daemon...");

  // daemon をバックグラウンドで起動
  Bun.spawn(["bun", "run", join(testProjectRoot, ".team/manager/main.ts"), "start"], {
    cwd: testProjectRoot,
    env: {
      ...process.env,
      PROJECT_ROOT: testProjectRoot,
      CMUX_TEAM_POLL_INTERVAL: "5000",
      CMUX_TEAM_MAX_CONDUCTORS: "3",
    },
    stdout: "ignore",
    stderr: "ignore",
  });

  await sleep(5000);

  const log = await readLog();
  if (log.includes("daemon_started")) {
    console.log("daemon started ✓\n");
  } else {
    console.log("WARNING: daemon 起動未確認。テストを続行します。\n");
  }
}

async function stopDaemon(): Promise<void> {
  console.log("\nStopping daemon...");
  await mainTs("stop");
  await sleep(5000);

  // PID で確実に停止
  try {
    const team = JSON.parse(await readFile(join(testProjectRoot, ".team/team.json"), "utf-8"));
    if (team.manager?.pid) {
      process.kill(team.manager.pid, "SIGTERM");
    }
  } catch {}

  console.log("daemon stopped ✓");
}

// --- シナリオ 1: 順序付き実行 ---

async function scenarioSequential(): Promise<void> {
  const start = Date.now();
  console.log("━━━ Scenario 1: Sequential Dependencies (A→B→C) ━━━");
  console.log("  3 つのタスクを連鎖依存で実行:");
  console.log("  Task 1 (調査) → Task 2 (設計) → Task 3 (実装)\n");

  await createTaskFile("1", "research-api", {
    priority: "high",
    content: `API エンドポイントの一覧を調査し、.team/output/research-api.md に結果を書き出してください。

具体的には:
1. このプロジェクトの README.md を読む
2. 「API エンドポイント: /health, /users, /tasks」という内容で .team/output/research-api.md を作成
3. 完了`,
  });

  await createTaskFile("2", "design-schema", {
    dependsOn: ["1"],
    content: `.team/output/research-api.md を読み、それに基づいてデータスキーマを設計し、.team/output/design-schema.md に書き出してください。

具体的には:
1. .team/output/research-api.md を読む
2. 各エンドポイントに対応するスキーマ定義を作成
3. .team/output/design-schema.md に書き出す`,
  });

  await createTaskFile("3", "implement-handler", {
    dependsOn: ["2"],
    content: `.team/output/design-schema.md を読み、handler.ts を実装してください。

具体的には:
1. .team/output/design-schema.md を読む
2. src/handler.ts を作成（簡単な Express ハンドラー）
3. 完了`,
  });

  await mainTs("send", "TASK_CREATED", "--task-id", "1", "--task-file", ".team/tasks/open/001-research-api.md");

  console.log("  Waiting for Task 1 (research)...");
  const t1 = await waitForLog("task_completed task_id=1", 180_000);
  assert(t1, "Task 1 (research) 完了");

  if (t1) {
    console.log("  Waiting for Task 2 (design)...");
    const t2 = await waitForLog("task_completed task_id=2", 180_000);
    assert(t2, "Task 2 (design) 依存解決 → 完了");

    if (t2) {
      console.log("  Waiting for Task 3 (implement)...");
      const t3 = await waitForLog("task_completed task_id=3", 180_000);
      assert(t3, "Task 3 (implement) 依存解決 → 完了");
    }
  }

  // 実行順序の検証
  const log = await readLog();
  const events = log.split("\n")
    .filter((l) => /conductor_started|task_completed/.test(l))
    .map((l) => l.trim());

  console.log("\n  実行ログ:");
  events.forEach((e) => console.log(`    ${e}`));

  const closedCount = await countClosedTasks();
  assert(closedCount >= 1, `${closedCount} タスクが closed に移動`);

  await captureSnapshot("sequential");

  results.push({
    scenario: "sequential",
    status: t1 ? "pass" : "fail",
    detail: `${events.length} events, ${closedCount} closed`,
    duration: Date.now() - start,
  });
  console.log();
}

async function countClosedTasks(): Promise<number> {
  try {
    return (await readdir(join(testProjectRoot, ".team/tasks/closed"))).filter((f) => f.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

// --- シナリオ 2: 並列調査 → 統合 ---

async function scenarioParallel(): Promise<void> {
  const start = Date.now();
  console.log("━━━ Scenario 2: Parallel Research → Consolidation ━━━");
  console.log("  3 つの調査を並列実行し、結果を統合:\n");

  await createTaskFile("10", "research-frontend", {
    content: `フロントエンド技術を調査し、.team/output/research-frontend.md に書き出してください。

具体的には:
1. 「React, Vue, Svelte の比較」という内容で .team/output/research-frontend.md を作成
2. 完了`,
  });

  await createTaskFile("11", "research-backend", {
    content: `バックエンド技術を調査し、.team/output/research-backend.md に書き出してください。

具体的には:
1. 「Express, Fastify, Hono の比較」という内容で .team/output/research-backend.md を作成
2. 完了`,
  });

  await createTaskFile("12", "research-database", {
    content: `データベース技術を調査し、.team/output/research-database.md に書き出してください。

具体的には:
1. 「PostgreSQL, MongoDB, SQLite の比較」という内容で .team/output/research-database.md を作成
2. 完了`,
  });

  await createTaskFile("13", "consolidate-report", {
    dependsOn: ["10", "11", "12"],
    content: `.team/output/research-*.md を全て読み、統合レポートを作成してください。

具体的には:
1. .team/output/research-frontend.md, research-backend.md, research-database.md を読む
2. 統合レポートを .team/output/tech-stack-report.md に作成
3. 完了`,
  });

  await mainTs("send", "TASK_CREATED", "--task-id", "10", "--task-file", ".team/tasks/open/010-research-frontend.md");

  // 並列 spawn を確認
  console.log("  Waiting for parallel spawns...");
  const s10 = await waitForLog("conductor_started task_id=10", 60_000);
  const s11 = await waitForLog("conductor_started task_id=11", 60_000);
  const s12 = await waitForLog("conductor_started task_id=12", 60_000);

  assert(s10, "Task 10 (frontend research) spawn");
  assert(s11, "Task 11 (backend research) spawn");
  assert(s12, "Task 12 (database research) spawn");

  // 統合タスクがまだ実行されていないことを確認
  const logBefore = await readLog();
  assert(!logBefore.includes("conductor_started task_id=13"), "Task 13 (consolidate) はまだブロック中");

  // 全調査完了を待つ
  console.log("  Waiting for all research to complete...");
  await waitForLog("task_completed task_id=10", 180_000);
  await waitForLog("task_completed task_id=11", 180_000);
  await waitForLog("task_completed task_id=12", 180_000);

  // 統合タスクの spawn を待つ
  console.log("  Waiting for consolidation...");
  const s13 = await waitForLog("conductor_started task_id=13", 120_000);
  assert(s13, "全調査完了後に Task 13 (consolidate) が spawn された");

  await captureSnapshot("parallel");

  results.push({
    scenario: "parallel",
    status: s10 && s11 && s12 ? "pass" : "fail",
    detail: `parallel: ${[s10, s11, s12].filter(Boolean).length}/3, consolidate: ${s13 ? "yes" : "no"}`,
    duration: Date.now() - start,
  });
  console.log();
}

// --- シナリオ 3: 割り込み TODO ---

async function scenarioInterrupt(): Promise<void> {
  const start = Date.now();
  console.log("━━━ Scenario 3: Implementation + Interrupt TODO ━━━");
  console.log("  実装タスク実行中に TODO を割り込み:\n");

  await createTaskFile("20", "implement-feature", {
    content: `新しい機能を実装してください。

具体的には:
1. src/feature.ts を作成（簡単な関数を定義）
2. 完了

注意: この作業には時間がかかります。焦らず丁寧に実装してください。`,
  });

  await mainTs("send", "TASK_CREATED", "--task-id", "20", "--task-file", ".team/tasks/open/020-implement-feature.md");

  console.log("  Waiting for implementation to start...");
  const implStarted = await waitForLog("conductor_started task_id=20", 60_000);
  assert(implStarted, "Task 20 (implement) Conductor が spawn された");

  // 実装中に TODO を割り込み
  console.log("  Sending interrupt TODO...");
  await sleep(5000);
  await mainTs("send", "TODO", "--content", "README.md に「E2E テスト実行中」と追記してください");

  const todoReceived = await waitForLog("todo_received", 30_000);
  assert(todoReceived, "TODO メッセージが受信された");

  const todoCreated = await waitForLog("todo_task_created", 30_000);
  assert(todoCreated, "TODO からタスクが生成された");

  // 2 つの Conductor が同時稼働しているか
  const log = await readLog();
  const starts = log.split("\n").filter((l) => l.includes("conductor_started"));
  assert(starts.length >= 2, `2 つ以上の Conductor が spawn された (実際: ${starts.length})`);

  // TODO の完了を待つ
  console.log("  Waiting for TODO completion...");
  const todoTaskId = log.match(/todo_task_created task_id=(\d+)/)?.[1];
  if (todoTaskId) {
    await waitForLog(`task_completed task_id=${todoTaskId}`, 120_000);
  }

  await captureSnapshot("interrupt");

  results.push({
    scenario: "interrupt",
    status: implStarted && todoReceived ? "pass" : "fail",
    detail: `impl: ${implStarted ? "yes" : "no"}, todo: ${todoReceived ? "yes" : "no"}, conductors: ${starts.length}`,
    duration: Date.now() - start,
  });
  console.log();
}

// --- メイン ---

async function main(): Promise<void> {
  const scenario = process.argv[2] || "all";

  await setup();

  if (!process.env.CMUX_SOCKET_PATH) {
    console.log("⚠ cmux 環境外で実行中。Conductor spawn は失敗します。");
    console.log("  cmux 内で実行してください: cmux で起動したターミナルから ./e2e.ts\n");
    process.exit(1);
  }

  await startDaemon();

  try {
    if (scenario === "all" || scenario === "sequential") await scenarioSequential();
    if (scenario === "all" || scenario === "parallel") await scenarioParallel();
    if (scenario === "all" || scenario === "interrupt") await scenarioInterrupt();
  } finally {
    await stopDaemon();
    await captureSnapshot("final");

    // 結果サマリー
    console.log(`\n${"═".repeat(60)}`);
    console.log(`  Results: ${passed} passed, ${failed} failed`);
    console.log(`${"═".repeat(60)}`);

    for (const r of results) {
      const icon = r.status === "pass" ? "✓" : "✗";
      console.log(`  ${icon} ${r.scenario} (${Math.round(r.duration / 1000)}s): ${r.detail}`);
    }

    // 結果保存
    await writeFile(
      join(RESULTS_DIR, "results.json"),
      JSON.stringify({ passed, failed, results, timestamp: new Date().toISOString() }, null, 2)
    );

    console.log(`\n  アーティファクト: ${RESULTS_DIR}/`);
    console.log(`  manager.log:      ${RESULTS_DIR}/snapshots/final-manager.log`);

    // セッション ID の一覧
    const finalLog = await readLog();
    const sessions = [...finalLog.matchAll(/session=([a-f0-9-]+)/g)].map((m) => m[1]);
    if (sessions.length > 0) {
      console.log(`\n  Conductor セッション（claude --resume で参照可能）:`);
      sessions.forEach((s) => console.log(`    claude --resume ${s}`));
    }

    console.log();
    process.exit(failed > 0 ? 1 : 0);
  }
}

main().catch((e) => {
  console.error("E2E test runner crashed:", e);
  process.exit(1);
});
