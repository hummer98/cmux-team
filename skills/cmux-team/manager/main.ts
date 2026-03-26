#!/usr/bin/env bun
/**
 * cmux-team — マルチエージェント開発オーケストレーション
 *
 * Usage:
 *   ./main.ts start                            # daemon 起動 + Master spawn + ダッシュボード
 *   ./main.ts send TASK_CREATED --task-id 035 --task-file ...
 *   ./main.ts send TODO --content "worktree 整理"
 *   ./main.ts send SHUTDOWN
 *   ./main.ts status                           # ステータス1回表示
 *   ./main.ts stop                             # graceful shutdown
 */

import { join } from "path";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { sendMessage, ensureQueueDirs } from "./queue";
import { createDaemon, initInfra, startMaster, tick, updateTeamJson } from "./daemon";
import { startDashboard } from "./dashboard";
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

  // ダッシュボード表示
  startDashboard(() => state);

  // シグナルハンドリング
  const shutdown = async () => {
    state.running = false;
    await log("daemon_stopped");
    await updateTeamJson(state);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

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
        sessionId: getArg("session-id"),
        transcriptPath: getArg("transcript-path"),
        timestamp: now,
      };
      break;

    case "SHUTDOWN":
      message = { type: "SHUTDOWN", timestamp: now };
      break;

    default:
      console.error("Usage: send <TASK_CREATED|TODO|CONDUCTOR_DONE|SHUTDOWN>");
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
  const masterSurface = teamJson.master?.surface;

  console.log(`cmux-team status`);
  console.log(`  Master: ${masterSurface || "not spawned"}`);
  console.log(
    `  Manager: PID ${pid || "none"} ${
      pid && isProcessAlive(pid) ? "(alive)" : "(dead)"
    }`
  );

  const conductors = teamJson.conductors || [];
  console.log(`  Conductors: ${conductors.length}`);
  for (const c of conductors) {
    console.log(`    ${c.surface} task=${c.taskId} (${c.id})`);
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
