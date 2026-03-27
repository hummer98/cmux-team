#!/usr/bin/env bun
/**
 * cmux-team — マルチエージェント開発オーケストレーション
 *
 * Usage:
 *   ./main.ts start                            # daemon 起動 + Master spawn + ダッシュボード
 *   ./main.ts send TASK_CREATED --task-id 035 --task-file ...
 *   ./main.ts send TODO --content "worktree 整理"
 *   ./main.ts send SHUTDOWN
 *   ./main.ts status                           # ダッシュボード表示
 *   ./main.ts status --log 20                  # ログ末尾20行
 *   ./main.ts stop                             # graceful shutdown
 */

import { join, dirname } from "path";
import { existsSync } from "fs";
import { readFile, readdir } from "fs/promises";
import { sendMessage, ensureQueueDirs } from "./queue";
import { createDaemon, initInfra, startMaster, tick, updateTeamJson } from "./daemon";
import { startDashboard, unmountDashboard } from "./dashboard";
import { log } from "./logger";
import type { QueueMessage } from "./schema";

// --- プロジェクトルート検出 ---
function findProjectRoot(): string {
  // 環境変数
  if (process.env.PROJECT_ROOT) return process.env.PROJECT_ROOT;

  // .team/ を含むディレクトリを探す
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, ".team"))) return dir;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }

  return process.cwd();
}

/** 最新の main.ts を検索（plugin キャッシュ → ローカル → 自分自身） */
function findLatestMainTs(): string {
  const home = require("os").homedir();
  const cacheBase = join(home, ".claude/plugins/cache/hummer98-cmux-team/cmux-team");
  try {
    const { execFileSync } = require("child_process");
    const stdout = execFileSync("ls", ["-d", join(cacheBase, "*/skills/cmux-team/manager/main.ts")]);
    const paths = stdout.toString().trim().split("\n").filter(Boolean).sort();
    if (paths.length > 0) return paths[paths.length - 1];
  } catch {}

  // ローカル
  const local = join(process.cwd(), "skills/cmux-team/manager/main.ts");
  if (existsSync(local)) return local;

  // 自分自身
  return process.argv[1] || import.meta.path;
}

const PROJECT_ROOT = findProjectRoot();
process.env.PROJECT_ROOT = PROJECT_ROOT;
process.chdir(PROJECT_ROOT);

// --- サブコマンド ---
const args = process.argv.slice(2);
const command = args[0];

function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function requireArg(name: string): string {
  const val = getArg(name);
  if (!val) {
    console.error(`Error: --${name} is required`);
    process.exit(1);
  }
  return val;
}

async function cmdStart(): Promise<void> {
  const state = await createDaemon(PROJECT_ROOT);

  // インフラ準備
  await initInfra(state);
  await log(
    "daemon_started",
    `pid=${process.pid} poll=${state.pollInterval}ms max_conductors=${state.maxConductors}`
  );

  // Master spawn
  await startMaster(state);
  await updateTeamJson(state);

  // シグナルハンドリング
  const shutdown = async () => {
    state.running = false;
    await log("daemon_stopped");
    await updateTeamJson(state);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // バージョン取得（plugin.json から）
  let version: string | undefined;
  try {
    const pluginJsonPath = join(dirname(import.meta.path), "../../..", ".claude-plugin/plugin.json");
    if (existsSync(pluginJsonPath)) {
      version = JSON.parse(await readFile(pluginJsonPath, "utf-8")).version;
    }
  } catch {}

  // ダッシュボード表示（キーボードショートカット付き）
  startDashboard(() => state, {
    version,
    onReload: () => {
      // ink を先に解放してから新プロセスを起動
      unmountDashboard();
      log("daemon_reload").then(async () => {
        const latestMainTs = findLatestMainTs();
        await log("daemon_reload_target", latestMainTs);
        state.running = false;
        await updateTeamJson(state);
        Bun.spawn([process.execPath, "run", latestMainTs, "start"], {
          stdio: ["inherit", "inherit", "inherit"],
          cwd: process.cwd(),
          env: process.env,
        });
        process.exit(0);
      });
    },
    onQuit: () => { shutdown(); },
  });

  // メインループ
  while (state.running) {
    try {
      await tick(state);
      await updateTeamJson(state);
    } catch (e: any) {
      await log("error", `tick: ${e.message}`);
    }
    await sleep(state.pollInterval);
  }

  await shutdown();
}

async function cmdSend(): Promise<void> {
  await ensureQueueDirs();
  const type = args[1];
  const now = new Date().toISOString();

  let message: QueueMessage;

  switch (type) {
    case "TASK_CREATED":
      message = {
        type: "TASK_CREATED",
        taskId: requireArg("task-id"),
        taskFile: requireArg("task-file"),
        timestamp: now,
      };
      break;

    case "TODO":
      message = {
        type: "TODO",
        content: requireArg("content"),
        timestamp: now,
      };
      break;

    case "CONDUCTOR_DONE":
      message = {
        type: "CONDUCTOR_DONE",
        conductorId: requireArg("conductor-id"),
        surface: getArg("surface") || "unknown",
        success: getArg("success") !== "false",  // デフォルト true（後方互換）
        reason: getArg("reason"),
        exitCode: getArg("exit-code") ? Number(getArg("exit-code")) : undefined,
        sessionId: getArg("session-id"),
        transcriptPath: getArg("transcript-path"),
        timestamp: now,
      };
      break;

    case "AGENT_SPAWNED":
      message = {
        type: "AGENT_SPAWNED",
        conductorId: requireArg("conductor-id"),
        surface: requireArg("surface"),
        role: getArg("role"),
        timestamp: now,
      };
      break;

    case "AGENT_DONE":
      message = {
        type: "AGENT_DONE",
        conductorId: requireArg("conductor-id"),
        surface: requireArg("surface"),
        timestamp: now,
      };
      break;

    case "SHUTDOWN":
      message = { type: "SHUTDOWN", timestamp: now };
      break;

    default:
      console.error("Usage: send <TASK_CREATED|TODO|CONDUCTOR_DONE|AGENT_SPAWNED|AGENT_DONE|SHUTDOWN>");
      process.exit(1);
  }

  const path = await sendMessage(message);
  console.log(`OK ${path}`);
}

async function cmdStatus(): Promise<void> {
  const teamJsonPath = join(PROJECT_ROOT, ".team/team.json");
  if (!existsSync(teamJsonPath)) {
    console.log("チーム未起動。`start` で起動してください。");
    return;
  }

  const teamJson = JSON.parse(await readFile(teamJsonPath, "utf-8"));
  const pid = teamJson.manager?.pid;
  const alive = pid && isProcessAlive(pid);
  const masterSurface = teamJson.master?.surface;
  const conductors: Array<{ id: string; taskId: string; taskTitle?: string; surface: string }> = teamJson.conductors || [];
  const logLines = getArg("log") || "10";

  // --- ヘッダー ---
  const status = alive ? "RUNNING" : "STOPPED";
  console.log(`cmux-team  ${status}  PID ${pid || "-"}  conductors ${conductors.length}`);

  // --- Master ---
  console.log(`─ Master ${"─".repeat(50)}`);
  if (masterSurface) {
    console.log(`  ● ${masterSurface}`);
  } else {
    console.log(`  ○ not spawned`);
  }

  // --- Conductors ---
  console.log(`─ Conductors ${conductors.length} ${"─".repeat(44)}`);
  if (conductors.length === 0) {
    console.log(`  idle`);
  } else {
    for (const c of conductors) {
      const title = c.taskTitle ? `  ${c.taskTitle}` : "";
      console.log(`  ● ${c.surface}  task=${c.taskId}${title}  ${c.id}`);
    }
  }

  // --- Tasks ---
  const openDir = join(PROJECT_ROOT, ".team/tasks/open");
  const closedDir = join(PROJECT_ROOT, ".team/tasks/closed");
  let openCount = 0;
  let closedCount = 0;
  try { openCount = (await readdir(openDir)).filter(f => f.endsWith(".md")).length; } catch {}
  try { closedCount = (await readdir(closedDir)).filter(f => f.endsWith(".md")).length; } catch {}
  console.log(`─ Tasks ${"─".repeat(51)}`);
  console.log(`  open: ${openCount}  closed: ${closedCount}`);

  // --- Log tail ---
  const n = Math.max(1, parseInt(logLines, 10) || 10);
  console.log(`─ Log (last ${n}) ${"─".repeat(Math.max(0, 42 - String(n).length))}`);
  try {
    const log = await readFile(join(PROJECT_ROOT, ".team/logs/manager.log"), "utf-8");
    const lines = log.trim().split("\n").filter(Boolean).slice(-n);
    for (const line of lines) {
      const m = line.match(/^\[([^\]]+)\]\s+(.*)/);
      if (m) {
        const time = (m[1] ?? "").slice(11, 19);
        console.log(`  ${time} ${m[2]}`);
      } else {
        console.log(`  ${line}`);
      }
    }
  } catch {
    console.log(`  (no log)`);
  }
}

async function cmdStop(): Promise<void> {
  await ensureQueueDirs();
  const path = await sendMessage({
    type: "SHUTDOWN",
    timestamp: new Date().toISOString(),
  });
  console.log(`SHUTDOWN sent: ${path}`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- ルーティング ---
switch (command) {
  case "start":
    await cmdStart();
    break;
  case "send":
    await cmdSend();
    break;
  case "status":
    await cmdStatus();
    break;
  case "stop":
    await cmdStop();
    break;
  default:
    console.log(`cmux-team — マルチエージェント開発オーケストレーション

Usage:
  cmux-team start                              daemon 起動 + Master spawn
  cmux-team send TASK_CREATED --task-id <id> --task-file <path>
  cmux-team send TODO --content <text>
  cmux-team send SHUTDOWN
  cmux-team status                             ステータス表示
  cmux-team stop                               graceful shutdown`);
    break;
}
