#!/usr/bin/env bun
/**
 * cmux-team — マルチエージェント開発オーケストレーション
 *
 * Usage:
 *   ./main.ts start                            # daemon 起動 + Master spawn + ダッシュボード
 *   ./main.ts send TASK_CREATED --task-id 035 --task-file ...
 *   ./main.ts send SHUTDOWN
 *   ./main.ts status                           # ダッシュボード表示
 *   ./main.ts status --log 20                  # ログ末尾20行
 *   ./main.ts stop                             # graceful shutdown
 *   ./main.ts spawn-agent --conductor-id <id> --role <role> --prompt <prompt> [--pane <paneId>]
 *   ./main.ts agents                           # 稼働中エージェント一覧
 *   ./main.ts kill-agent --surface <s> [--conductor-id <id>]
 *   ./main.ts create-task --title <title> [--priority <p>] [--status <s>] [--body <text>]
 *   ./main.ts update-task --task-id <id> --status <status>
 *   ./main.ts close-task --task-id <id> [--journal <text>]
 */

import { join, dirname } from "path";
import { existsSync } from "fs";
import { readFile, readdir, writeFile, mkdir } from "fs/promises";
import { sendMessage, ensureQueueDirs } from "./queue";
import { createDaemon, initInfra, startMaster, initializeLayout, tick, updateTeamJson } from "./daemon";
import { startDashboard, unmountDashboard } from "./dashboard";
import { log } from "./logger";
import * as cmux from "./cmux";
import { start as startProxy } from "./proxy";
import { loadTaskState, loadTasks, saveTaskState } from "./task";
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

/** 最新の main.ts を検索（npm グローバル → ローカル → 自分自身） */
function findLatestMainTs(): string {
  const { execFileSync } = require("child_process");

  // npm グローバルインストール先
  try {
    const npmGlobalPrefix = execFileSync("npm", ["prefix", "-g"]).toString().trim();
    const npmMainTs = join(npmGlobalPrefix, "lib/node_modules/cmux-team/skills/cmux-team/manager/main.ts");
    if (existsSync(npmMainTs)) return npmMainTs;
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
  console.log("🚀 cmux-team 起動開始");
  const state = await createDaemon(PROJECT_ROOT);

  // team.json から Conductor 状態を復元（リロード時の二重起動防止）
  try {
    const teamJson = JSON.parse(await readFile(join(PROJECT_ROOT, ".team/team.json"), "utf-8"));
    let restoredCount = 0;
    for (const c of teamJson.conductors ?? []) {
      if (c.surface && await cmux.validateSurface(c.surface)) {
        state.conductors.set(c.id, {
          conductorId: c.id,
          taskRunId: c.taskRunId,
          taskId: c.taskId,
          taskTitle: c.taskTitle,
          surface: c.surface,
          worktreePath: c.worktreePath,
          outputDir: c.outputDir,
          startedAt: c.startedAt ?? new Date().toISOString(),
          agents: (c.agents ?? []).map((a: any) => ({
            surface: a.surface,
            role: a.role,
            spawnedAt: a.spawnedAt ?? new Date().toISOString(),
          })),
          doneCandidate: false,
          status: c.status || "running",
          paneId: c.paneId,
        });
        restoredCount++;
      }
    }
    if (restoredCount > 0) {
      console.log(`✅ Conductor 状態復元: ${restoredCount}個`);
      await log("conductors_restored", `count=${state.conductors.size}`);
    }
  } catch {}

  // インフラ準備
  await initInfra(state);
  console.log("✅ インフラ準備完了");
  await log(
    "daemon_started",
    `pid=${process.pid} poll=${state.pollInterval}ms max_conductors=${state.maxConductors}`
  );

  // ロギングプロキシ起動
  console.log("⏳ ロギングプロキシ起動中...");
  let proxyHandle: { port: number; stop: () => void } | null = null;
  try {
    proxyHandle = await startProxy(PROJECT_ROOT, { getState: () => state });
    await writeFile(join(PROJECT_ROOT, ".team/proxy-port"), String(proxyHandle.port));
    console.log(`✅ ロギングプロキシ起動完了 (port ${proxyHandle.port})`);
    await log("proxy_started", `port=${proxyHandle.port}`);
  } catch (e: any) {
    console.log("⚠️  ロギングプロキシ起動失敗 (続行)");
    await log("proxy_start_failed", e.message);
  }

  // daemon surface 取得
  let daemonSurface: string | undefined;
  try {
    daemonSurface = await cmux.getCallerSurface();
    await log("daemon_surface", `surface=${daemonSurface}`);
  } catch (e: any) {
    await log("daemon_surface_fallback", e.message);
  }

  // Conductor を先に作成（全インフラ準備完了後に Master を起動）
  await initializeLayout(state, daemonSurface);

  // Master spawn（最後に作成）
  await startMaster(state, daemonSurface);

  await updateTeamJson(state);
  console.log("✅ 起動完了 — ダッシュボードに切り替えます\n");

  // シグナルハンドリング
  const shutdown = async () => {
    state.running = false;
    proxyHandle?.stop();
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
    onReload: async () => {
      // ink を解放し、exec でプロセスを置換（PID は変わらない、env は完全に引き継ぐ）
      unmountDashboard();
      const latestMainTs = findLatestMainTs();
      await log("daemon_reload");
      await log("daemon_reload_target", latestMainTs);
      state.running = false;
      // execSync で自プロセスを置換（bun → bash exec → bun）
      const { execFileSync } = require("child_process");
      try {
        execFileSync("bash", ["-c", `exec bun run "${latestMainTs}" start`], {
          stdio: "inherit",
          env: process.env,
          cwd: process.cwd(),
        });
      } catch {}
      process.exit(0);
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
        taskTitle: getArg("task-title"),
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
      console.error("Usage: send <TASK_CREATED|CONDUCTOR_DONE|AGENT_SPAWNED|AGENT_DONE|SHUTDOWN>");
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
    console.log(`  ● [${masterSurface.replace("surface:", "")}]`);
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
      console.log(`  ● [${c.surface.replace("surface:", "")}]  #${c.taskId}${title}  ${c.id}`);
    }
  }

  // --- Tasks ---
  const { tasks } = await loadTasks(PROJECT_ROOT);
  const closedCount = tasks.filter(t => t.status === "closed").length;
  const openCount = tasks.length - closedCount;
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
        const utcTs = m[1] ?? "";
        const time = new Date(utcTs).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
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

async function cmdSpawnAgent(): Promise<void> {
  const conductorId = requireArg("conductor-id");
  const role = requireArg("role");
  const prompt = getArg("prompt");
  const promptFile = getArg("prompt-file");
  const taskTitle = getArg("task-title");
  const pane = getArg("pane");

  if (!prompt && !promptFile) {
    console.error("Error: --prompt or --prompt-file is required");
    process.exit(1);
  }

  // --- 1. プロキシポート読み取り + 生存確認 ---
  const proxyPortFile = join(PROJECT_ROOT, ".team/proxy-port");
  let proxyPort: string | undefined;
  try {
    const port = (await readFile(proxyPortFile, "utf-8")).trim();
    // 実際に接続できるか確認してから採用
    const alive = await new Promise<boolean>((resolve) => {
      const net = require("net");
      const sock = net.connect({ port: Number(port), host: "127.0.0.1", timeout: 1000 }, () => {
        sock.destroy();
        resolve(true);
      });
      sock.on("error", () => resolve(false));
      sock.on("timeout", () => { sock.destroy(); resolve(false); });
    });
    if (alive) {
      proxyPort = port;
    }
  } catch {
    // プロキシ未起動の場合はなしで続行
  }

  // --- 2. タブ作成（--pane 直接指定 → team.json lookup → split フォールバック） ---
  let paneId: string | undefined = pane;  // --pane が最優先
  let worktreePath: string | undefined;
  try {
    const teamJson = JSON.parse(await readFile(join(PROJECT_ROOT, ".team/team.json"), "utf-8"));
    const conductor = teamJson.conductors?.find((c: any) => c.id === conductorId);
    if (!paneId) paneId = conductor?.paneId;
    worktreePath = conductor?.worktreePath;
  } catch {}

  let surface: string;
  if (paneId) {
    surface = await cmux.newSurface(paneId);
  } else {
    surface = await cmux.newSplit("down");
  }

  if (!(await cmux.validateSurface(surface))) {
    console.error(`Error: surface ${surface} validation failed`);
    process.exit(1);
  }

  // --- 3. Claude Code 起動 ---
  // 環境変数を export（Conductor のシェルセッションに永続化し子プロセスに自動継承）
  const exports: string[] = [
    `export CONDUCTOR_ID=${conductorId}`,
    `export ROLE=${role}`,
    `export PROJECT_ROOT=${PROJECT_ROOT}`,
  ];
  if (proxyPort) {
    exports.push(`export ANTHROPIC_BASE_URL=http://127.0.0.1:${proxyPort}`);
  }

  const cdPrefix = worktreePath ? `cd ${worktreePath} && ` : "";

  let claudeCmd: string;
  if (promptFile) {
    // --bare は OAuth 認証（Claude Max）をスキップするため使用しない
    claudeCmd = `${cdPrefix}${exports.join(" && ")} && claude --dangerously-skip-permissions '${promptFile} を読んで指示に従ってください。'`;
  } else {
    // 後方互換: --prompt でインライン渡し
    claudeCmd = `${cdPrefix}${exports.join(" && ")} && claude --dangerously-skip-permissions '${prompt}'`;
  }
  await cmux.send(surface, claudeCmd + "\n");

  // --- 4. Trust 承認 ---
  await cmux.waitForTrust(surface);

  // --- 5. タブ名設定 ---
  const roleIcons: Record<string, string> = {
    researcher: "🔍", research: "🔍",
    architect: "📐", design: "📐",
    implementer: "⚙", impl: "⚙",
    reviewer: "👀", review: "👀",
    tester: "🧪", test: "🧪",
    dockeeper: "📝", docs: "📝",
    "task-manager": "📋",
  };
  const roleIcon = roleIcons[role] ?? "▸";
  const num = surface.replace("surface:", "");
  const shortTitle = taskTitle
    ? (taskTitle.length > 25 ? taskTitle.slice(0, 25) + "…" : taskTitle)
    : "";
  const tabName = shortTitle ? `[${num}] ${roleIcon} ${shortTitle}` : `[${num}] ${roleIcon} ${role}`;
  await cmux.renameTab(surface, tabName);

  // --- 6. AGENT_SPAWNED をキューに送信 ---
  await ensureQueueDirs();
  await sendMessage({
    type: "AGENT_SPAWNED",
    conductorId,
    surface,
    role,
    taskTitle,
    timestamp: new Date().toISOString(),
  });

  // --- 7. stdout に surface を出力 ---
  console.log(`SURFACE=${surface}`);
}

async function cmdAgents(): Promise<void> {
  const teamJsonPath = join(PROJECT_ROOT, ".team/team.json");
  if (!existsSync(teamJsonPath)) {
    console.log("チーム未起動。");
    return;
  }

  const teamJson = JSON.parse(await readFile(teamJsonPath, "utf-8"));
  const conductors: Array<{
    id: string;
    taskId: string;
    taskTitle?: string;
    surface: string;
    agents?: Array<{ surface: string; role?: string }>;
  }> = teamJson.conductors || [];

  let agentCount = 0;
  for (const c of conductors) {
    const agents = c.agents || [];
    for (const a of agents) {
      agentCount++;
      const rolePart = a.role ? `role=${a.role}` : "role=unknown";
      console.log(`${a.surface}  ${rolePart}  conductor=${c.id}  task=${c.taskId}`);
    }
  }

  if (agentCount === 0) {
    console.log("稼働中のエージェントはありません。");
  }
}

async function cmdKillAgent(): Promise<void> {
  const surface = requireArg("surface");
  const conductorId = getArg("conductor-id");

  // --- 1. surface を閉じる ---
  await cmux.closeSurface(surface);

  // --- 2. AGENT_DONE をキューに送信 ---
  if (conductorId) {
    await ensureQueueDirs();
    await sendMessage({
      type: "AGENT_DONE",
      conductorId,
      surface,
      timestamp: new Date().toISOString(),
    });
  }

  console.log(`OK killed ${surface}`);
}

async function cmdCreateTask(): Promise<void> {
  const title = requireArg("title");
  const priority = getArg("priority") || "medium";
  const status = getArg("status") || "draft";
  const body = getArg("body") || "";

  // slug 生成
  let slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
  if (!slug) slug = "task";

  // 最大 ID 取得
  const tasksDir = join(PROJECT_ROOT, ".team/tasks");
  await mkdir(tasksDir, { recursive: true });

  let maxId = 0;
  try {
    const files = await readdir(tasksDir);
    for (const f of files) {
      const n = parseInt(f, 10);
      if (!isNaN(n) && n > maxId) maxId = n;
    }
  } catch {}

  const newId = String(maxId + 1).padStart(3, "0");
  const fileName = `${newId}-${slug}.md`;
  const filePath = join(tasksDir, fileName);

  // タスクファイル生成（status は含めない — task-state.json で管理）
  const content = `---
id: ${newId}
title: ${title}
priority: ${priority}
created_at: ${new Date().toISOString()}
---

## タスク
${body}
`;
  await writeFile(filePath, content);

  // task-state.json に初期状態を書き込む
  const taskState = await loadTaskState(PROJECT_ROOT);
  taskState[newId] = { status };
  await saveTaskState(PROJECT_ROOT, taskState);

  // status が ready の場合のみ TASK_CREATED を送信
  if (status === "ready") {
    await ensureQueueDirs();
    await sendMessage({
      type: "TASK_CREATED",
      taskId: newId,
      taskFile: filePath,
      timestamp: new Date().toISOString(),
    });
  }

  const relPath = `.team/tasks/${fileName}`;
  console.log(`TASK_ID=${newId} FILE=${relPath}`);
}

async function cmdUpdateTask(): Promise<void> {
  const taskId = requireArg("task-id");
  const newStatus = requireArg("status");

  // tasks/ からタスクファイルを検索（存在確認のみ）
  const tasksDir = join(PROJECT_ROOT, ".team/tasks");
  let taskFile: string | undefined;
  try {
    const files = await readdir(tasksDir);
    for (const f of files) {
      if (f.endsWith(".md") && f.startsWith(taskId)) {
        taskFile = join(tasksDir, f);
        break;
      }
    }
  } catch {}

  if (!taskFile) {
    // ファイル名が数値IDで始まらない場合、frontmatter の id でも検索
    try {
      const files = await readdir(tasksDir);
      for (const f of files) {
        if (!f.endsWith(".md")) continue;
        const content = await readFile(join(tasksDir, f), "utf-8");
        const idMatch = content.match(/^id:\s*(.+)$/m);
        if (idMatch && idMatch[1]?.trim() === taskId) {
          taskFile = join(tasksDir, f);
          break;
        }
      }
    } catch {}
  }

  if (!taskFile) {
    console.error(`Error: task ${taskId} not found in .team/tasks/`);
    process.exit(1);
  }

  // task-state.json の status を更新（ファイル自体は変更しない）
  const taskState = await loadTaskState(PROJECT_ROOT);
  taskState[taskId] = { ...taskState[taskId], status: newStatus };
  await saveTaskState(PROJECT_ROOT, taskState);

  // ready に変更された場合は TASK_CREATED を送信
  if (newStatus === "ready") {
    await ensureQueueDirs();
    await sendMessage({
      type: "TASK_CREATED",
      taskId,
      taskFile,
      timestamp: new Date().toISOString(),
    });
  }

  console.log(`OK updated ${taskId} status=${newStatus}`);
}

async function cmdCloseTask(): Promise<void> {
  const taskId = requireArg("task-id");
  const journal = getArg("journal");

  // tasks/ からタスクファイルを検索（存在確認のみ）
  const tasksDir = join(PROJECT_ROOT, ".team/tasks");
  let taskFile: string | undefined;
  try {
    const files = await readdir(tasksDir);
    for (const f of files) {
      if (f.endsWith(".md") && f.startsWith(taskId)) {
        taskFile = join(tasksDir, f);
        break;
      }
    }
  } catch {}

  if (!taskFile) {
    // frontmatter の id でも検索
    try {
      const files = await readdir(tasksDir);
      for (const f of files) {
        if (!f.endsWith(".md")) continue;
        const content = await readFile(join(tasksDir, f), "utf-8");
        const idMatch = content.match(/^id:\s*(.+)$/m);
        if (idMatch && idMatch[1]?.trim() === taskId) {
          taskFile = join(tasksDir, f);
          break;
        }
      }
    } catch {}
  }

  if (!taskFile) {
    console.error(`Error: task ${taskId} not found in .team/tasks/`);
    process.exit(1);
  }

  // task-state.json で closed + closedAt + journal を設定（ファイルは移動しない）
  const taskState = await loadTaskState(PROJECT_ROOT);
  taskState[taskId] = {
    status: "closed",
    closedAt: new Date().toISOString(),
    ...(journal ? { journal } : {}),
  };
  await saveTaskState(PROJECT_ROOT, taskState);

  console.log(`OK closed ${taskId}`);
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
  case "spawn-agent":
    await cmdSpawnAgent();
    break;
  case "agents":
    await cmdAgents();
    break;
  case "kill-agent":
    await cmdKillAgent();
    break;
  case "create-task":
    await cmdCreateTask();
    break;
  case "update-task":
    await cmdUpdateTask();
    break;
  case "close-task":
    await cmdCloseTask();
    break;
  default:
    console.log(`cmux-team — マルチエージェント開発オーケストレーション

Usage:
  cmux-team start                              daemon 起動 + Master spawn
  cmux-team send TASK_CREATED --task-id <id> --task-file <path>
  cmux-team send SHUTDOWN
  cmux-team status                             ステータス表示
  cmux-team stop                               graceful shutdown
  cmux-team spawn-agent --conductor-id <id> --role <role> --prompt <prompt> [--pane <paneId>]
  cmux-team agents                             稼働中エージェント一覧
  cmux-team kill-agent --surface <surface> [--conductor-id <id>]
  cmux-team create-task --title <title> [--priority <p>] [--status <s>] [--body <text>]
  cmux-team update-task --task-id <id> --status <status>
  cmux-team close-task --task-id <id> [--journal <text>]`);
    break;
}
