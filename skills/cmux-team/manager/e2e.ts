#!/usr/bin/env bun
/**
 * E2E テストランナー
 *
 * 実際の cmux workspace で daemon + Master + Conductor を起動し、
 * CLI 経由でタスクを投入してフルライフサイクルを検証する。
 *
 * Usage:
 *   ./e2e.ts [scenario]
 *
 * Scenarios:
 *   sequential   — UC1: 順序付き依存実行 (調査→設計→実装)
 *   parallel     — UC2: 並列調査 → 統合レポート
 *   all          — 全シナリオ実行
 *
 * フロー:
 *   1. 独立した cmux workspace を作成
 *   2. daemon (main.ts start) を cmux send で起動 → dashboard + Master 自動 spawn
 *   3. CLI (main.ts send) でタスクをキューに投入
 *   4. manager.log で Conductor spawn/complete を監視
 *   5. クリーンアップ
 *
 * 結果は .team/e2e-results/<timestamp>/ に保存される。
 */

import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { mkdir, writeFile, readFile, readdir, rm, cp } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

const execFile = promisify(execFileCb);

// --- 設定 ---
const SCRIPT_DIR = import.meta.dir;
const PROJECT_ROOT = join(SCRIPT_DIR, "../../..");
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const RESULTS_BASE = join(PROJECT_ROOT, ".team/e2e-results");
const RESULTS_DIR = join(RESULTS_BASE, TIMESTAMP);
const WORKSPACE_DIR = join(RESULTS_BASE, "workspace");

// cmux リソース
let e2eWorkspace: string;
let daemonSurface: string;
let masterSurface: string;

let passed = 0;
let failed = 0;
const results: Array<{
  scenario: string;
  status: "pass" | "fail";
  detail: string;
  duration: number;
}> = [];

// --- ユーティリティ ---

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cmuxExec(...args: string[]): Promise<string> {
  const { stdout } = await execFile("cmux", args, { timeout: 15_000 });
  return stdout.trim();
}

/** cmux send (--workspace 必須) */
async function cmuxSend(surface: string, text: string): Promise<void> {
  await execFile("cmux", [
    "send", "--workspace", e2eWorkspace, "--surface", surface, text,
  ]);
}

async function cmuxSendKey(surface: string, key: string): Promise<void> {
  await execFile("cmux", [
    "send-key", "--workspace", e2eWorkspace, "--surface", surface, key,
  ]);
}

async function cmuxReadScreen(surface: string, lines: number = 15): Promise<string> {
  const { stdout } = await execFile("cmux", [
    "read-screen", "--workspace", e2eWorkspace, "--surface", surface,
    "--lines", String(lines),
  ], { timeout: 10_000 });
  return stdout;
}

async function readLog(): Promise<string> {
  try {
    return await readFile(join(WORKSPACE_DIR, ".team/logs/manager.log"), "utf-8");
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

async function readTeamJson(): Promise<any> {
  return JSON.parse(await readFile(join(WORKSPACE_DIR, ".team/team.json"), "utf-8"));
}

async function captureSnapshot(label: string): Promise<void> {
  const snapDir = join(RESULTS_DIR, "snapshots");
  await mkdir(snapDir, { recursive: true });

  try {
    await writeFile(join(snapDir, `${label}-manager.log`), await readLog());
  } catch {}

  try {
    const qDir = join(WORKSPACE_DIR, ".team/queue/processed");
    if (existsSync(qDir)) {
      for (const f of await readdir(qDir)) {
        await cp(join(qDir, f), join(snapDir, `${label}-queue-${f}`));
      }
    }
  } catch {}

  try {
    await cp(join(WORKSPACE_DIR, ".team/team.json"), join(snapDir, `${label}-team.json`));
  } catch {}

  try {
    // task-state.json から closed タスクを特定してスナップショット
    const stateFile = join(WORKSPACE_DIR, ".team/task-state.json");
    if (existsSync(stateFile)) {
      await cp(stateFile, join(snapDir, `${label}-task-state.json`));
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

async function countClosedTasks(): Promise<number> {
  try {
    const stateFile = join(WORKSPACE_DIR, ".team/task-state.json");
    const state = JSON.parse(await readFile(stateFile, "utf-8"));
    return Object.values(state).filter((s: any) => s.status === "closed").length;
  } catch {
    return 0;
  }
}

/** CLI でタスクファイルを作成 */
async function createTaskFile(
  id: string,
  slug: string,
  opts: { priority?: string; dependsOn?: string[]; content?: string } = {}
): Promise<string> {
  const { priority = "medium", dependsOn, content = "E2E テストタスク" } = opts;
  let yaml = `---\nid: ${id}\ntitle: ${slug}\npriority: ${priority}\nstatus: ready\ncreated_at: ${new Date().toISOString()}\n`;
  if (dependsOn?.length) yaml += `depends_on: [${dependsOn.join(", ")}]\n`;
  yaml += `---\n\n## タスク\n${content}\n\n## 完了条件\n- 指示された成果物が作成されていること\n`;

  const fileName = `${id.padStart(3, "0")}-${slug}.md`;
  const filePath = join(WORKSPACE_DIR, `.team/tasks/${fileName}`);
  await writeFile(filePath, yaml);
  return filePath;
}

/** CLI でキューにメッセージ送信 */
async function cliSend(...args: string[]): Promise<string> {
  try {
    const mainTs = join(WORKSPACE_DIR, ".team/manager/main.ts");
    const { stdout } = await execFile("bun", ["run", mainTs, "send", ...args], {
      cwd: WORKSPACE_DIR,
      timeout: 30_000,
      env: { ...process.env, PROJECT_ROOT: WORKSPACE_DIR },
    });
    return stdout.trim();
  } catch (e: any) {
    return e.stdout?.trim() || e.message;
  }
}

// --- セットアップ ---

async function setup(): Promise<void> {
  await rm(WORKSPACE_DIR, { recursive: true, force: true });
  await mkdir(WORKSPACE_DIR, { recursive: true });
  await mkdir(RESULTS_DIR, { recursive: true });

  // .team 基本構造
  for (const d of ["tasks", "queue/processed", "output", "prompts", "logs"]) {
    await mkdir(join(WORKSPACE_DIR, `.team/${d}`), { recursive: true });
  }

  await writeFile(
    join(WORKSPACE_DIR, ".team/team.json"),
    JSON.stringify({ phase: "init", master: {}, manager: {}, conductors: [] }, null, 2)
  );

  // git init（worktree に必要）
  await execFile("git", ["init"], { cwd: WORKSPACE_DIR });
  await writeFile(join(WORKSPACE_DIR, "README.md"), "# E2E Test Project\n");
  await execFile("git", ["add", "-A"], { cwd: WORKSPACE_DIR });
  await execFile("git", ["commit", "-m", "init"], { cwd: WORKSPACE_DIR });

  // manager ランタイムをコピー
  const managerDst = join(WORKSPACE_DIR, ".team/manager");
  await mkdir(managerDst, { recursive: true });
  for (const f of [
    "main.ts", "daemon.ts", "queue.ts", "schema.ts", "conductor.ts",
    "master.ts", "cmux.ts", "template.ts", "logger.ts", "task.ts",
    "dashboard.tsx", "package.json", "bun.lock", "tsconfig.json",
  ]) {
    if (existsSync(join(SCRIPT_DIR, f))) {
      await cp(join(SCRIPT_DIR, f), join(managerDst, f));
    }
  }
  await execFile("bun", ["install"], { cwd: managerDst });

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  cmux-team E2E Test Runner`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Workspace: ${WORKSPACE_DIR}`);
  console.log(`  Results:   ${RESULTS_DIR}`);
  console.log(`  Time:      ${new Date().toISOString()}`);
  console.log(`${"═".repeat(60)}\n`);
}

/**
 * 独立 cmux workspace で daemon を起動。
 * dashboard がそのペインに表示され、Master が new-split で自動 spawn される。
 */
async function startDaemon(): Promise<void> {
  console.log("Creating workspace + starting daemon...");

  // 1. 独立 workspace 作成
  const wsOutput = await cmuxExec("new-workspace", "--cwd", WORKSPACE_DIR);
  const workspaceMatch = wsOutput.match(/workspace:\d+/);
  if (!workspaceMatch) throw new Error(`Failed to create workspace: ${wsOutput}`);
  e2eWorkspace = workspaceMatch[0];

  // workspace 内の surface を tree から取得
  await sleep(3000);
  const treeOutput = await cmuxExec("tree");
  const wsRegex = new RegExp(`${e2eWorkspace}[\\s\\S]*?surface (surface:\\d+)`);
  const surfaceMatch = treeOutput.match(wsRegex);
  if (!surfaceMatch?.[1]) throw new Error(`Failed to find surface in ${e2eWorkspace}`);
  daemonSurface = surfaceMatch[1];
  console.log(`  workspace: ${e2eWorkspace}, daemon surface: ${daemonSurface}`);

  // 2. daemon 起動コマンドを送信（--workspace 指定必須）
  const mainTs = join(WORKSPACE_DIR, ".team/manager/main.ts");
  const cmd = `CMUX_TEAM_POLL_INTERVAL=5000 CMUX_TEAM_MAX_CONDUCTORS=3 PROJECT_ROOT=${WORKSPACE_DIR} bun run ${mainTs} start`;
  await cmuxSend(daemonSurface, cmd + "\n");

  // 3. daemon 起動を待つ
  const daemonReady = await waitForLog("daemon_started", 30_000);
  if (daemonReady) {
    console.log("  daemon started ✓");
  } else {
    console.log("  WARNING: daemon 起動未確認。テストを続行します。");
  }

  // 4. Master surface を team.json から取得（Master spawn + Trust 承認待ち）
  await sleep(10_000);
  try {
    const team = await readTeamJson();
    masterSurface = team.master?.surface;
    if (masterSurface) {
      console.log(`  master surface: ${masterSurface}`);
    } else {
      console.log("  WARNING: Master surface が見つかりません（Master spawn に失敗した可能性）");
    }
  } catch (e: any) {
    console.log(`  WARNING: team.json 読み取り失敗: ${e.message}`);
  }

  console.log();
}

async function stopDaemon(): Promise<void> {
  console.log("\nStopping daemon...");

  // SHUTDOWN キューメッセージ
  await cliSend("SHUTDOWN");
  await sleep(5000);

  // PID で確実に停止
  try {
    const team = await readTeamJson();
    if (team.manager?.pid) {
      process.kill(team.manager.pid, "SIGTERM");
    }
  } catch {}

  // Conductor surface をクリーンアップ
  try {
    const team = await readTeamJson();
    for (const c of team.conductors || []) {
      await cmuxExec("close-surface", "--surface", c.surface).catch(() => {});
    }
  } catch {}

  // Master surface をクリーンアップ
  if (masterSurface) {
    await cmuxExec("close-surface", "--surface", masterSurface).catch(() => {});
  }

  // daemon surface をクリーンアップ (Ctrl+C → close)
  if (daemonSurface) {
    try { await cmuxSendKey(daemonSurface, "C-c"); } catch {}
    await sleep(2000);
    await cmuxExec("close-surface", "--surface", daemonSurface).catch(() => {});
  }

  // git worktree クリーンアップ
  try {
    const worktreesDir = join(WORKSPACE_DIR, ".worktrees");
    if (existsSync(worktreesDir)) {
      const dirs = await readdir(worktreesDir);
      for (const d of dirs) {
        await execFile("git", ["worktree", "remove", join(worktreesDir, d), "--force"], {
          cwd: WORKSPACE_DIR,
        }).catch(() => {});
      }
    }
    await execFile("git", ["worktree", "prune"], { cwd: WORKSPACE_DIR }).catch(() => {});
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
    content: `.team/output/research-api.md を読み、データスキーマを設計し、.team/output/design-schema.md に書き出してください。

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

  await cliSend("TASK_CREATED", "--task-id", "1", "--task-file", ".team/tasks/001-research-api.md");

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

  await cliSend("TASK_CREATED", "--task-id", "10", "--task-file", ".team/tasks/010-research-frontend.md");

  console.log("  Waiting for parallel spawns...");
  const s10 = await waitForLog("conductor_started task_id=10", 60_000);
  const s11 = await waitForLog("conductor_started task_id=11", 60_000);
  const s12 = await waitForLog("conductor_started task_id=12", 60_000);

  assert(s10, "Task 10 (frontend research) spawn");
  assert(s11, "Task 11 (backend research) spawn");
  assert(s12, "Task 12 (database research) spawn");

  const logBefore = await readLog();
  assert(!logBefore.includes("conductor_started task_id=13"), "Task 13 (consolidate) はまだブロック中");

  console.log("  Waiting for all research to complete...");
  await waitForLog("task_completed task_id=10", 180_000);
  await waitForLog("task_completed task_id=11", 180_000);
  await waitForLog("task_completed task_id=12", 180_000);

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

// --- メイン ---

async function main(): Promise<void> {
  const scenario = process.argv[2] || "all";

  if (!process.env.CMUX_SOCKET_PATH) {
    console.log("⚠ cmux 環境外で実行中。");
    console.log("  cmux 内で実行してください: cmux で起動したターミナルから ./e2e.ts\n");
    process.exit(1);
  }

  await setup();
  await startDaemon();

  try {
    if (scenario === "all" || scenario === "sequential") await scenarioSequential();
    if (scenario === "all" || scenario === "parallel") await scenarioParallel();
  } finally {
    await stopDaemon();
    await captureSnapshot("final");

    console.log(`\n${"═".repeat(60)}`);
    console.log(`  Results: ${passed} passed, ${failed} failed`);
    console.log(`${"═".repeat(60)}`);

    for (const r of results) {
      const icon = r.status === "pass" ? "✓" : "✗";
      console.log(`  ${icon} ${r.scenario} (${Math.round(r.duration / 1000)}s): ${r.detail}`);
    }

    await writeFile(
      join(RESULTS_DIR, "results.json"),
      JSON.stringify({ passed, failed, results, timestamp: new Date().toISOString() }, null, 2)
    );

    console.log(`\n  アーティファクト: ${RESULTS_DIR}/`);
    console.log(`  manager.log:      ${RESULTS_DIR}/snapshots/final-manager.log`);

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
