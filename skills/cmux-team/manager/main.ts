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
 *   ./main.ts update-task --task-id <id> [--status <status>] [--body <text>] [--title <title>]
 *   ./main.ts close-task --task-id <id> [--journal <text>] [--force]
 */

import { join, dirname } from "path";
import { existsSync } from "fs";
import { readFile, readdir, writeFile, mkdir } from "fs/promises";
import { sendMessage, ensureQueueDirs } from "./queue";
import { createDaemon, initInfra, startMaster, initializeLayout, tick, updateTeamJson, initSourceWatcher, initFileWatcher, sleepUntilWakeup, checkNpmUpdate } from "./daemon";
import { startDashboard, unmountDashboard } from "./dashboard";
import { log } from "./logger";
import * as cmux from "./cmux";
import { start as startProxy } from "./proxy";
import { initDB, searchTraces, getTrace } from "./trace-store";
import { loadTaskState, loadTasks, saveTaskState } from "./task";
import { loadArtifacts, searchArtifacts, validateArtifact } from "./artifact";
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

/** tasks/ からタスクファイルを検索（ID プレフィックス or frontmatter id） */
async function findTaskFile(taskId: string): Promise<string | undefined> {
  const tasksDir = join(PROJECT_ROOT, ".team/tasks");
  try {
    const files = await readdir(tasksDir);
    for (const f of files) {
      if (f.endsWith(".md") && f.startsWith(taskId)) {
        return join(tasksDir, f);
      }
    }
  } catch {}
  // ファイル名が数値IDで始まらない場合、frontmatter の id でも検索
  try {
    const files = await readdir(tasksDir);
    for (const f of files) {
      if (!f.endsWith(".md")) continue;
      const content = await readFile(join(tasksDir, f), "utf-8");
      const idMatch = content.match(/^id:\s*(.+)$/m);
      if (idMatch && idMatch[1]?.trim() === taskId) {
        return join(tasksDir, f);
      }
    }
  } catch {}
  return undefined;
}

async function cmdStart(): Promise<void> {
  console.log("🚀 cmux-team 起動開始");
  const state = await createDaemon(PROJECT_ROOT);

  // ソースファイル mtime 監視を初期化
  state.sourceMtimes = await initSourceWatcher();

  // ファイルシステム監視（tasks/, queue/ の変更で即時 tick）
  initFileWatcher(state);

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
          taskStatusFile: c.taskStatusFile,
          startedAt: c.startedAt ?? new Date().toISOString(),
          agents: (c.agents ?? []).map((a: any) => ({
            surface: a.surface,
            role: a.role,
            spawnedAt: a.spawnedAt ?? new Date().toISOString(),
          })),
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

  // ロギングプロキシ起動（既存 proxy が生きていればスキップ）
  console.log("⏳ ロギングプロキシ確認中...");
  let proxyHandle: { port: number; stop: () => void } | null = null;
  const existingProxyPort = await resolveProxyPort();
  if (existingProxyPort) {
    console.log(`✅ ロギングプロキシ: 既存プロセスを再利用 (port ${existingProxyPort})`);
    await log("proxy_reused", `port=${existingProxyPort}`);
  } else {
    try {
      proxyHandle = await startProxy(PROJECT_ROOT, { getState: () => state });
      await writeFile(join(PROJECT_ROOT, ".team/proxy-port"), String(proxyHandle.port));
      console.log(`✅ ロギングプロキシ起動完了 (port ${proxyHandle.port})`);
      await log("proxy_started", `port=${proxyHandle.port}`);
    } catch (e: any) {
      console.log("⚠️  ロギングプロキシ起動失敗 (続行)");
      await log("proxy_start_failed", e.message);
    }
  }

  // daemon surface 取得（CMUX_SURFACE 環境変数 → cmux identify フォールバック）
  let daemonSurface: string | undefined = process.env.CMUX_SURFACE;
  if (daemonSurface) {
    await log("daemon_surface", `surface=${daemonSurface} (env)`);
  } else {
    try {
      daemonSurface = await cmux.getCallerSurface();
      await log("daemon_surface", `surface=${daemonSurface} (identify)`);
    } catch (e: any) {
      await log("daemon_surface_fallback", e.message);
    }
  }

  // daemon タブタイトル設定
  if (daemonSurface) {
    const num = daemonSurface.replace("surface:", "");
    await cmux.renameTab(daemonSurface, `[${num}] Manager`);
  }

  // Conductor を先に作成（全インフラ準備完了後に Master を起動）
  await initializeLayout(state, daemonSurface);

  // Master spawn（最後に作成）
  await startMaster(state, daemonSurface);

  await updateTeamJson(state);
  console.log("✅ 起動完了 — ダッシュボードに切り替えます\n");

  // シグナルハンドリング
  // quit 時は proxy を停止しない（既存 Master/Conductor の接続を維持するため）
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
  await startDashboard(() => state, {
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
    onFullQuit: async () => {
      await log("full_quit_requested");

      // 1. 全 Agent を close
      for (const [, conductor] of state.conductors) {
        for (const agent of conductor.agents) {
          await cmux.closeSurface(agent.surface).catch(() => {});
        }
      }

      // 2. 全 Conductor surface を close（Agent タブも含む）
      for (const [, conductor] of state.conductors) {
        // ペイン内の全サブ surface を close
        if (conductor.paneId) {
          const surfaces = await cmux.listPaneSurfaces(conductor.paneId).catch(() => [] as string[]);
          for (const s of surfaces) {
            await cmux.closeSurface(s).catch(() => {});
          }
        }
        await cmux.closeSurface(conductor.surface).catch(() => {});
      }

      // 3. Master surface を close
      if (state.masterSurface) {
        await cmux.closeSurface(state.masterSurface).catch(() => {});
      }

      // 4. worktree をクリーンアップ
      for (const [, conductor] of state.conductors) {
        if (conductor.worktreePath && existsSync(conductor.worktreePath)) {
          try {
            const { execFile: execFileCb } = require("child_process");
            const { promisify } = require("util");
            const execFileAsync = promisify(execFileCb);
            await execFileAsync("git", ["worktree", "remove", conductor.worktreePath, "--force"], { cwd: state.projectRoot });
            if (conductor.taskRunId) {
              await execFileAsync("git", ["branch", "-d", `${conductor.taskRunId}/task`], { cwd: state.projectRoot }).catch(() => {});
            }
          } catch {}
        }
      }

      await log("full_quit_completed");
      state.running = false;
      await updateTeamJson(state);
      process.exit(0);
    },
  });

  // メインループ
  const NPM_CHECK_INTERVAL = 300_000; // 5分
  while (state.running) {
    try {
      await tick(state);
      await updateTeamJson(state);
    } catch (e: any) {
      await log("error", `tick: ${e.message}`);
    }
    // npm 更新チェック（5分間隔）
    if (Date.now() - state.lastNpmCheckAt >= NPM_CHECK_INTERVAL) {
      state.lastNpmCheckAt = Date.now();
      await checkNpmUpdate(state);
    }
    await sleepUntilWakeup(state);
  }

  // ソース変更による再起動要求（proxy は停止しない — 再起動後に再利用される）
  if (state.restartRequested) {
    unmountDashboard();
    await log("daemon_auto_restart");
    await updateTeamJson(state);
    process.exit(42);
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

    case "SESSION_STARTED":
      message = {
        type: "SESSION_STARTED",
        conductorId: requireArg("conductor-id"),
        surface: getArg("surface") || "unknown",
        pid: Number(requireArg("pid")),
        sessionId: getArg("session-id"),
        timestamp: now,
      };
      break;

    case "SESSION_ENDED":
      message = {
        type: "SESSION_ENDED",
        conductorId: requireArg("conductor-id"),
        surface: getArg("surface") || "unknown",
        pid: getArg("pid") ? Number(getArg("pid")) : undefined,
        reason: getArg("reason"),
        timestamp: now,
      };
      break;

    case "SESSION_ACTIVE":
      message = {
        type: "SESSION_ACTIVE",
        conductorId: requireArg("conductor-id"),
        surface: getArg("surface") || "unknown",
        pid: getArg("pid") ? Number(getArg("pid")) : undefined,
        timestamp: now,
      };
      break;

    case "SESSION_IDLE":
      message = {
        type: "SESSION_IDLE",
        conductorId: requireArg("conductor-id"),
        surface: getArg("surface") || "unknown",
        pid: getArg("pid") ? Number(getArg("pid")) : undefined,
        timestamp: now,
      };
      break;

    case "SHUTDOWN":
      message = { type: "SHUTDOWN", timestamp: now };
      break;

    default:
      console.error("Usage: send <TASK_CREATED|CONDUCTOR_DONE|AGENT_SPAWNED|AGENT_DONE|SESSION_STARTED|SESSION_ENDED|SESSION_ACTIVE|SESSION_IDLE|SHUTDOWN>");
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
      console.log(`  ● [${c.surface.replace("surface:", "")}]  T${c.taskId}${title}  ${c.id}`);
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

/** proxy ポートを読み取り、生存確認して返す */
async function resolveProxyPort(): Promise<string | undefined> {
  const proxyPortFile = join(PROJECT_ROOT, ".team/proxy-port");
  try {
    const port = (await readFile(proxyPortFile, "utf-8")).trim();
    const alive = await new Promise<boolean>((resolve) => {
      const net = require("net");
      const sock = net.connect({ port: Number(port), host: "127.0.0.1", timeout: 1000 }, () => {
        sock.destroy();
        resolve(true);
      });
      sock.on("error", () => resolve(false));
      sock.on("timeout", () => { sock.destroy(); resolve(false); });
    });
    return alive ? port : undefined;
  } catch {
    return undefined;
  }
}

/**
 * cmux-team conductor <slot-id>
 * Conductor 用 Claude Code ラッパー。proxy ポートを動的に解決して claude を exec する。
 */
async function cmdConductor(): Promise<void> {
  const slotId = args[1];
  if (!slotId) {
    console.error("Usage: cmux-team conductor <slot-id>");
    process.exit(1);
  }

  // ロールプロンプトファイル生成
  const { generateConductorRolePrompt } = await import("./template");
  const rolePromptFile = await generateConductorRolePrompt(PROJECT_ROOT);

  // 環境変数を設定
  process.env.PROJECT_ROOT = PROJECT_ROOT;
  process.env.CONDUCTOR_ID = slotId;
  const proxyPort = await resolveProxyPort();
  if (proxyPort) {
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxyPort}`;
  }

  // claude を exec（プロセスを置換）
  const { execFileSync } = require("child_process");
  try {
    execFileSync("claude", [
      "--dangerously-skip-permissions",
      "--append-system-prompt-file", rolePromptFile,
      "あなたは Conductor スロットです。Manager が /clear + プロンプト送信でタスクを割り当てるまで、何もせず ❯ プロンプトで待機してください。タスクの検索・読み取り・実行は一切行わないこと。",
    ], {
      stdio: "inherit",
      env: process.env,
      cwd: PROJECT_ROOT,
    });
  } catch (e: any) {
    // claude の終了コードをそのまま返す
    process.exit(e.status ?? 1);
  }
}

/**
 * cmux-team launch-master
 * Master 用 Claude Code ラッパー。proxy ポートを動的に解決して claude を exec する。
 */
async function cmdLaunchMaster(): Promise<void> {
  // プロンプト生成
  const { generateMasterPrompt } = await import("./template");
  await generateMasterPrompt(PROJECT_ROOT);

  // 環境変数を設定
  process.env.PROJECT_ROOT = PROJECT_ROOT;
  const proxyPort = await resolveProxyPort();
  if (proxyPort) {
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxyPort}`;
  }

  // claude を exec
  const { execFileSync } = require("child_process");
  try {
    execFileSync("claude", [
      "--dangerously-skip-permissions",
      "--append-system-prompt-file", join(PROJECT_ROOT, ".team/prompts/master.md"),
      "ユーザーからのタスクを待ってください。",
    ], {
      stdio: "inherit",
      env: process.env,
      cwd: PROJECT_ROOT,
    });
  } catch (e: any) {
    process.exit(e.status ?? 1);
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
  let taskTitle = getArg("task-title");
  const pane = getArg("pane");

  if (!prompt && !promptFile) {
    console.error("Error: --prompt or --prompt-file is required");
    process.exit(1);
  }

  // --- 1. プロキシポート読み取り + 生存確認 ---
  const proxyPort = await resolveProxyPort();

  // --- 2. タブ作成（--pane 直接指定 → team.json lookup → CMUX_SURFACE 環境変数 → split フォールバック） ---
  let paneId: string | undefined = pane;  // --pane が最優先
  let worktreePath: string | undefined;
  try {
    const teamJson = JSON.parse(await readFile(join(PROJECT_ROOT, ".team/team.json"), "utf-8"));
    const conductors: any[] = teamJson.conductors ?? [];
    // conductor-id で検索
    const conductor = conductors.find((c: any) => c.id === conductorId);
    if (!paneId) paneId = conductor?.paneId;
    worktreePath = conductor?.worktreePath;
    // --task-title 省略時は conductor のタスクタイトルをフォールバック
    if (!taskTitle) taskTitle = conductor?.taskTitle;
    // フォールバック: 呼び出し元の CMUX_SURFACE 環境変数から pane を逆引き
    if (!paneId && process.env.CMUX_SURFACE) {
      const bySurface = conductors.find((c: any) => c.surface === process.env.CMUX_SURFACE);
      if (bySurface) paneId = bySurface.paneId;
    }
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
    `export CMUX_SURFACE=${surface}`,
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

  // --- 4. タブ名設定 ---
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
    agents?: Array<{ surface: string; role?: string; sessionId?: string }>;
  }> = teamJson.conductors || [];

  let agentCount = 0;
  for (const c of conductors) {
    const agents = c.agents || [];
    for (const a of agents) {
      agentCount++;
      const rolePart = a.role ? `role=${a.role}` : "role=unknown";
      const sessionPart = a.sessionId ? `  session=${a.sessionId}` : "";
      console.log(`${a.surface}  ${rolePart}  conductor=${c.id}  task=${c.taskId}${sessionPart}`);
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
  const newStatus = getArg("status");
  const body = getArg("body");
  const title = getArg("title");

  if (newStatus === undefined && body === undefined && title === undefined) {
    console.error("Error: at least one of --status, --body, or --title is required");
    process.exit(1);
  }

  const taskFile = await findTaskFile(taskId);
  if (!taskFile) {
    console.error(`Error: task ${taskId} not found in .team/tasks/`);
    process.exit(1);
  }

  // ステータス遷移ガード
  const taskState = await loadTaskState(PROJECT_ROOT);
  const currentStatus = taskState[taskId]?.status;

  if (currentStatus === "assigned") {
    console.error(`Error: task ${taskId} is assigned (running). Cannot update a running task. Create a new task instead.`);
    process.exit(1);
  }
  if (currentStatus === "closed") {
    console.error(`Error: task ${taskId} is closed. Cannot reopen a closed task. Use create-task to create a new one.`);
    process.exit(1);
  }

  // --title: frontmatter 内の title 行を更新
  if (title !== undefined) {
    const content = await readFile(taskFile, "utf-8");
    const updated = content.replace(/^title:\s*.+$/m, `title: ${title}`);
    await writeFile(taskFile, updated);
  }

  // --body: frontmatter 以降の本文を差し替え
  if (body !== undefined) {
    const content = await readFile(taskFile, "utf-8");
    const fmEnd = content.indexOf("---", content.indexOf("---") + 3);
    const frontmatter = content.slice(0, fmEnd + 3);
    await writeFile(taskFile, frontmatter + "\n\n" + body + "\n");
  }

  // --status: task-state.json を更新
  if (newStatus !== undefined) {
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
  }

  const parts: string[] = [];
  if (newStatus !== undefined) parts.push(`status=${newStatus}`);
  if (title !== undefined) parts.push("title updated");
  if (body !== undefined) parts.push("body updated");
  console.log(`OK updated ${taskId} ${parts.join(", ")}`);
}

async function cmdCloseTask(): Promise<void> {
  const taskId = requireArg("task-id");
  const journal = getArg("journal");
  const force = args.includes("--force");

  const taskFile = await findTaskFile(taskId);
  if (!taskFile) {
    console.error(`Error: task ${taskId} not found in .team/tasks/`);
    process.exit(1);
  }

  // assigned ガード: --journal あり（正常完了フロー）または --force で許可
  const taskState = await loadTaskState(PROJECT_ROOT);
  const currentStatus = taskState[taskId]?.status;
  if (currentStatus === "assigned" && !journal && !force) {
    console.error(`Error: task ${taskId} is assigned (running). Use --force to close a running task.`);
    process.exit(1);
  }

  // task-state.json で closed + closedAt + journal を設定（ファイルは移動しない）
  taskState[taskId] = {
    status: "closed",
    closedAt: new Date().toISOString(),
    ...(journal ? { journal } : {}),
  };
  await saveTaskState(PROJECT_ROOT, taskState);

  console.log(`OK closed ${taskId}`);
}

async function cmdTrace(): Promise<void> {
  const db = initDB(PROJECT_ROOT);
  const taskId = getArg("task");
  const conductorId = getArg("conductor");
  const role = getArg("role");
  const search = getArg("search");
  const showId = getArg("show");
  const limit = getArg("limit");

  if (showId) {
    const trace = getTrace(db, Number(showId));
    if (!trace) {
      console.log("Trace not found");
      db.close();
      return;
    }
    console.log(JSON.stringify(trace, null, 2));
    // リクエスト/レスポンス本文表示
    if (trace.request_body_path && existsSync(trace.request_body_path)) {
      console.log("\n--- Request Body ---");
      const body = await readFile(trace.request_body_path, "utf-8");
      try {
        const parsed = JSON.parse(body);
        console.log(`model: ${parsed.model || "unknown"}`);
        if (parsed.messages?.length) {
          console.log(`messages: ${parsed.messages.length}`);
          const first = parsed.messages[0];
          const content = typeof first.content === "string"
            ? first.content.slice(0, 200)
            : JSON.stringify(first.content).slice(0, 200);
          console.log(`first: ${content}...`);
        }
      } catch {
        console.log(body.slice(0, 500));
      }
    }
    db.close();
    return;
  }

  const traces = searchTraces(db, {
    taskId,
    conductorId,
    role,
    search,
    limit: limit ? Number(limit) : 20,
  });

  if (traces.length === 0) {
    console.log("No traces found");
    db.close();
    return;
  }

  // テーブル形式で出力
  console.log(`${"ID".padStart(6)}  ${"TIME".padEnd(19)}  ${"TASK".padEnd(6)}  ${"ROLE".padEnd(10)}  ${"METHOD".padEnd(6)}  ${"PATH".padEnd(30)}  ${"STATUS".padEnd(6)}  ${"DUR".padEnd(8)}  BYTES`);
  console.log("\u2500".repeat(110));
  for (const t of traces) {
    const time = t.timestamp?.slice(0, 19) || "";
    const task = (t.task_id || "-").padEnd(6);
    const r = (t.role || "-").padEnd(10);
    const method = (t.method || "-").padEnd(6);
    const path = (t.path || "-").padEnd(30).slice(0, 30);
    const status = String(t.status || "-").padEnd(6);
    const dur = t.duration_ms != null ? `${t.duration_ms}ms`.padEnd(8) : "-".padEnd(8);
    const bytes = `${t.request_bytes || 0}\u2192${t.response_bytes || 0}`;
    console.log(`${String(t.id).padStart(6)}  ${time}  ${task}  ${r}  ${method}  ${path}  ${status}  ${dur}  ${bytes}`);
  }
  db.close();
}

async function cmdRestartConductor(): Promise<void> {
  const conductorId = requireArg("conductor-id");
  const teamJsonPath = join(PROJECT_ROOT, ".team/team.json");
  const teamJson = JSON.parse(await readFile(teamJsonPath, "utf-8"));
  const conductor = teamJson.conductors?.find((c: any) => c.id === conductorId);
  if (!conductor) {
    console.error(`Conductor ${conductorId} not found`);
    process.exit(1);
  }
  await cmux.send(conductor.surface, `export CMUX_SURFACE=${conductor.surface} && cmux-team conductor ${conductorId}\n`);
  console.log(`Conductor ${conductorId} restarting on ${conductor.surface}`);
}

async function cmdResetConductor(): Promise<void> {
  const conductorId = requireArg("conductor-id");
  await ensureQueueDirs();
  const path = await sendMessage({
    type: "CONDUCTOR_DONE",
    conductorId,
    surface: getArg("surface") || "unknown",
    success: false,
    reason: "manual_reset",
    timestamp: new Date().toISOString(),
  });
  console.log(`Reset signal sent for conductor ${conductorId}: ${path}`);
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

// --- artifacts サブコマンド ---
async function cmdArtifacts(): Promise<void> {
  const subCmd = args[1];

  // cmux-team artifacts --validate
  if (getArg("validate") !== undefined || args.includes("--validate")) {
    const artifacts = await loadArtifacts(PROJECT_ROOT);
    if (artifacts.length === 0) {
      console.log("アーティファクトが見つかりません");
      return;
    }
    let hasError = false;
    for (const a of artifacts) {
      const errors = validateArtifact(a);
      if (errors.length > 0) {
        hasError = true;
        console.log(`⚠️  ${a.id || a.fileName}: ${errors.join(", ")}`);
      }
    }
    if (!hasError) {
      console.log(`All ${artifacts.length} artifacts valid`);
    }
    return;
  }

  // cmux-team artifacts show <id>
  if (subCmd === "show") {
    const rawId = args[2];
    if (!rawId) {
      console.error("Error: アーティファクト ID を指定してください");
      console.error("Usage: cmux-team artifacts show <id>");
      process.exit(1);
    }
    // "A001" でも "001" でも受け付ける
    const normalizedId = rawId.startsWith("A") ? rawId : `A${rawId.padStart(3, "0")}`;
    const artifacts = await loadArtifacts(PROJECT_ROOT);
    const found = artifacts.find((a) => a.id === normalizedId || a.id === rawId);
    if (!found) {
      console.error(`アーティファクト ${rawId} が見つかりません`);
      process.exit(1);
    }
    const content = await readFile(found.filePath, "utf-8");
    console.log(content);
    return;
  }

  // cmux-team artifacts search <query>
  if (subCmd === "search") {
    const query = args[2];
    if (!query) {
      console.error("Error: 検索クエリを指定してください");
      console.error("Usage: cmux-team artifacts search <query>");
      process.exit(1);
    }
    const results = await searchArtifacts(PROJECT_ROOT, query);
    if (results.length === 0) {
      console.log(`"${query}" に一致するアーティファクトが見つかりません`);
      return;
    }
    for (const { artifact, matches } of results) {
      console.log(`\n--- ${artifact.id}  ${artifact.type}  ${artifact.title} ---`);
      for (const m of matches) {
        // 前後1行のコンテキスト表示
        const content = await readFile(artifact.filePath, "utf-8");
        const lines = content.split("\n");
        const start = Math.max(0, m.lineNum - 2);
        const end = Math.min(lines.length - 1, m.lineNum);
        for (let i = start; i <= end; i++) {
          const prefix = i === m.lineNum - 1 ? ">" : " ";
          console.log(`${prefix} ${i + 1}: ${lines[i]}`);
        }
        console.log("");
      }
    }
    return;
  }

  // cmux-team artifacts (list — デフォルト)
  const artifacts = await loadArtifacts(PROJECT_ROOT);
  if (artifacts.length === 0) {
    console.log("アーティファクトが見つかりません");
    return;
  }

  // フィルタリング
  const typeFilter = getArg("type");
  const taskFilter = getArg("task");
  let filtered = artifacts;
  if (typeFilter) {
    filtered = filtered.filter((a) => a.type === typeFilter);
  }
  if (taskFilter) {
    filtered = filtered.filter((a) => a.task === taskFilter);
  }

  // ソート
  const sortBy = getArg("sort") || "created";
  filtered.sort((a, b) => {
    const aVal = sortBy === "updated" ? (a.updated || a.created) : a.created;
    const bVal = sortBy === "updated" ? (b.updated || b.created) : b.created;
    return aVal.localeCompare(bVal);
  });

  // 一覧表示
  for (const a of filtered) {
    const date = (a.updated || a.created).slice(0, 10);
    const taskLabel = a.task ? `  ${a.task}` : "";
    console.log(`${a.id.padEnd(6)} ${a.type.padEnd(10)} ${a.title}  ${date}${taskLabel}`);
  }
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
  case "trace":
    await cmdTrace();
    break;
  case "conductor":
    await cmdConductor();
    break;
  case "launch-master":
    await cmdLaunchMaster();
    break;
  case "restart-conductor":
    await cmdRestartConductor();
    break;
  case "reset-conductor":
    await cmdResetConductor();
    break;
  case "artifacts":
    await cmdArtifacts();
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
  cmux-team close-task --task-id <id> [--journal <text>]
  cmux-team trace --task <id>                  トレースをタスクIDでフィルタ
  cmux-team trace --search <query>             FTS5 全文検索
  cmux-team trace --show <id>                  トレース詳細表示
  cmux-team conductor <slot-id>                Conductor 起動（proxy 自動解決）
  cmux-team launch-master                      Master 起動（proxy 自動解決）
  cmux-team restart-conductor --conductor-id <id>  Conductor を再起動
  cmux-team reset-conductor --conductor-id <id>    Conductor をリセット（idle に戻す）
  cmux-team artifacts                              アーティファクト一覧
  cmux-team artifacts show <id>                    アーティファクト表示
  cmux-team artifacts search <query>               全文検索
  cmux-team artifacts --validate                   フロントマター検証`);
    break;
}
