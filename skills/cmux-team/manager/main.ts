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
 *   ./main.ts spawn-conductor
 *   ./main.ts spawn-agent --conductor-surface <surface> --role <role> --prompt <prompt>
 *   ./main.ts agents                           # 稼働中エージェント一覧
 *   ./main.ts kill-agent --surface <s>
 *   ./main.ts create-task --title <title> [--priority <p>] [--status <s>] [--body <text>] [--depends-on <ids>] [--run-after-all]
 *   ./main.ts update-task --task-id <id> [--status <status>] [--body <text>] [--title <title>]
 *   ./main.ts close-task --task-id <id> [--journal <text>] [--force]
 *   ./main.ts abort-task --task-id <id>
 *   ./main.ts restart-task --task-id <id> [--journal <text>]
 *   ./main.ts delete-task --task-id <id> [--journal <text>]
 */

import { join, dirname } from "path";
import { existsSync, writeFileSync, mkdirSync } from "fs";
import { readFile, readdir, writeFile, mkdir, stat } from "fs/promises";
import { t } from "./i18n";
import { createDaemon, initInfra, startMaster, initializeLayout, tick, updateTeamJson, initSourceWatcher, initFileWatcher, sleepUntilWakeup, checkNpmUpdate, handleMessage } from "./daemon";
import { startDashboard, unmountDashboard } from "./dashboard";
import { log } from "./logger";
import * as cmux from "./cmux";
import { start as startProxy } from "./proxy";
import { spawnSingleConductor } from "./conductor";
import { initDB, searchTraces, getTrace } from "./trace-store";
import { loadTaskState, loadTasks, saveTaskState } from "./task";
import { loadArtifacts, searchArtifacts, validateArtifact } from "./artifact";
import { runPreflight, printPreflightIssues } from "./preflight";
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

// --- config ---
const DEFAULT_MODEL = "opus";

interface TeamConfig {
  models?: {
    master?: string;
    conductor?: string;
    agent?: string;
  };
}

async function loadConfig(): Promise<TeamConfig> {
  const configPath = join(PROJECT_ROOT, ".team/config.json");
  try {
    return JSON.parse(await readFile(configPath, "utf-8"));
  } catch {
    return {};
  }
}

function getModelForRole(config: TeamConfig, role: "master" | "conductor" | "agent", cliOverride?: string): string {
  return cliOverride ?? config.models?.[role] ?? DEFAULT_MODEL;
}

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

/** --help / -h フラグの有無を判定 */
function hasHelpFlag(): boolean {
  return args.includes("--help") || args.includes("-h");
}

/** ヘルプテキストを表示して正常終了 */
function showHelp(text: string): never {
  console.log(text.trim());
  process.exit(0);
}

/** tasks/ からタスクファイルを検索（ID プレフィックス or frontmatter id） */
async function findTaskFile(taskId: string): Promise<string | undefined> {
  const tasksDir = join(PROJECT_ROOT, ".team/tasks");
  try {
    const files = await readdir(tasksDir);
    for (const f of files) {
      if (!f.startsWith(taskId)) continue;
      const fullPath = join(tasksDir, f);
      const s = await stat(fullPath);
      if (s.isDirectory()) {
        const taskMdPath = join(fullPath, "task.md");
        if (existsSync(taskMdPath)) return taskMdPath;
      } else if (f.endsWith(".md")) {
        return fullPath;
      }
    }
  } catch {}
  // ファイル名が数値IDで始まらない場合、frontmatter の id でも検索
  try {
    const files = await readdir(tasksDir);
    for (const f of files) {
      const fullPath = join(tasksDir, f);
      const s = await stat(fullPath);
      let content: string | undefined;
      if (s.isDirectory()) {
        const taskMdPath = join(fullPath, "task.md");
        if (existsSync(taskMdPath)) {
          content = await readFile(taskMdPath, "utf-8");
        }
      } else if (f.endsWith(".md")) {
        content = await readFile(fullPath, "utf-8");
      }
      if (content) {
        const idMatch = content.match(/^id:\s*(.+)$/m);
        if (idMatch && idMatch[1]?.trim() === taskId) {
          if (s.isDirectory()) return join(fullPath, "task.md");
          return fullPath;
        }
      }
    }
  } catch {}
  return undefined;
}

async function cmdStart(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_start"));
  // cmux 環境チェック
  if (!process.env.CMUX_SOCKET_PATH) {
    console.error(t("not_in_cmux"));
    process.exit(1);
  }

  // --- preflight チェック ---
  // daemon 起動前に前提を検証し、失敗時は即 exit
  // （daemon / Master / Conductor を spawn した後で失敗すると
  //  中途半端なプロセスが残るため、spawn する前に止める）
  const preflight = await runPreflight(PROJECT_ROOT);
  if (!preflight.ok) {
    printPreflightIssues(preflight);
    process.exit(1);
  }

  const state = await createDaemon(PROJECT_ROOT);

  // ソースファイル mtime 監視を初期化
  state.sourceMtimes = await initSourceWatcher();

  // ファイルシステム監視（tasks/, queue/ の変更で即時 tick）
  initFileWatcher(state);

  // インフラ準備
  await initInfra(state);
  await log("infra_ready");
  await log(
    "daemon_started",
    `pid=${process.pid} poll=${state.pollInterval}ms max_conductors=${state.maxConductors}`
  );

  // 前回のポートを記録（proxy 起動前にファイルから読む — alive チェック不要）
  let previousProxyPort: string | undefined;
  try {
    previousProxyPort = (await readFile(join(PROJECT_ROOT, ".team/proxy-port"), "utf-8")).trim();
  } catch {}

  // ロギングプロキシ起動（既存 proxy が生きていればスキップ）
  let proxyHandle: { port: number; stop: () => void } | null = null;
  const existingProxyPort = await resolveProxyPort();
  if (existingProxyPort) {
    state.proxyPort = parseInt(existingProxyPort, 10);
    await log("proxy_reused", `port=${existingProxyPort}`);
  } else {
    try {
      proxyHandle = await startProxy(PROJECT_ROOT, {
        getState: () => state,
        onMessage: async (msg) => { await handleMessage(state, msg); },
      });
      await writeFile(join(PROJECT_ROOT, ".team/proxy-port"), String(proxyHandle.port));
      state.proxyPort = proxyHandle.port;
      await log("proxy_started", `port=${proxyHandle.port}`);
    } catch (e: any) {
      await log("proxy_start_failed", e.message);
    }
  }

  // proxy ポート変化の検出
  if (previousProxyPort && state.proxyPort && String(state.proxyPort) !== previousProxyPort) {
    state.proxyPortChanged = true;
    await log("proxy_port_changed", `prev=${previousProxyPort} new=${state.proxyPort}`);
  }

  // バージョン取得（plugin.json から — startDashboard に渡すため先に実行）
  let version: string | undefined;
  try {
    const pluginJsonPath = join(dirname(import.meta.path), "../../..", ".claude-plugin/plugin.json");
    if (existsSync(pluginJsonPath)) {
      version = JSON.parse(await readFile(pluginJsonPath, "utf-8")).version;
    }
  } catch (e: any) {
    await log("error", `version read failed: ${e.message}`);
  }

  // シグナルハンドリング（TUI 起動前に設定）
  // quit 時は proxy を停止しない（既存 Master/Conductor の接続を維持するため）
  const shutdown = async () => {
    state.running = false;
    state.fileWatcherAbort?.abort();
    state.fileWatcherAbort = null;
    await log("daemon_stopped");
    await updateTeamJson(state);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // --- TUI ダッシュボード早期表示 ---
  const { scheduleRefresh } = await startDashboard(() => state, {
    version,
    onReload: async () => {
      unmountDashboard();
      const latestMainTs = findLatestMainTs();
      await log("daemon_reload");
      await log("daemon_reload_target", latestMainTs);
      state.running = false;
      state.fileWatcherAbort?.abort();
      state.fileWatcherAbort = null;
      const { execFileSync } = require("child_process");
      // exit 42（auto_restart）が来た場合も再起動ループを継続する（cmux-team.js と同じ挙動）
      // これがないと proxy_reused した子 daemon が auto_restart で終了した瞬間に
      // 親（onReload 呼び出し元）が process.exit(0) して proxy も道連れになる
      const MAX_RESTARTS = 10;
      let restarts = 0;
      while (restarts < MAX_RESTARTS) {
        let exitStatus = 0;
        try {
          execFileSync("bun", ["run", latestMainTs, "start"], {
            stdio: "inherit",
            env: process.env,
            cwd: process.cwd(),
          });
          break; // 正常終了
        } catch (e: any) {
          exitStatus = e.status ?? 1;
        }
        if (exitStatus === 42) {
          restarts++;
          await log("daemon_reload_restart", `restarts=${restarts}/${MAX_RESTARTS}`);
          try { execFileSync("sleep", ["1"]); } catch {}
          continue;
        }
        await log("error", `daemon reload exec failed status=${exitStatus}`);
        break;
      }
      if (restarts >= MAX_RESTARTS) {
        await log("error", "daemon reload restart limit reached");
      }
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
          } catch (e: any) {
            await log("error", `worktree cleanup failed: path=${conductor.worktreePath} error=${e.message}`);
          }
        }
      }

      await log("full_quit_completed");
      state.running = false;
      state.fileWatcherAbort?.abort();
      state.fileWatcherAbort = null;
      await updateTeamJson(state);
      process.exit(0);
    },
  });

  // --- Conductor + Master 起動（TUI 上で進捗表示） ---

  // daemon surface / workspace 取得（CMUX_SURFACE 環境変数 → cmux identify フォールバック）
  let daemonSurface: string | undefined = process.env.CMUX_SURFACE;
  if (daemonSurface) {
    await log("daemon_surface", `surface=${daemonSurface} (env)`);
    // surface が env 経由の場合も identify でworkspaceを取得
    const ws = await cmux.getCallerWorkspace();
    if (ws) {
      state.workspace = ws;
      await log("daemon_workspace", `workspace=${ws}`);
    }
  } else {
    try {
      daemonSurface = await cmux.getCallerSurface();
      await log("daemon_surface", `surface=${daemonSurface} (identify)`);
    } catch (e: any) {
      await log("daemon_surface_fallback", e.message);
    }
    const ws = await cmux.getCallerWorkspace();
    if (ws) {
      state.workspace = ws;
      await log("daemon_workspace", `workspace=${ws}`);
    }
  }

  // daemon タブタイトル設定
  if (daemonSurface) {
    const num = daemonSurface.replace("surface:", "");
    await cmux.renameTab(daemonSurface, `[${num}] Manager`);
  }

  // Conductor スロット作成
  state.bootPhase = "conductors";
  scheduleRefresh();
  await initializeLayout(state, daemonSurface);
  scheduleRefresh();

  // Master spawn
  state.bootPhase = "master";
  scheduleRefresh();
  await startMaster(state, daemonSurface);
  scheduleRefresh();

  // 起動完了
  state.bootPhase = "ready";
  await updateTeamJson(state);
  await log("boot_completed");
  scheduleRefresh();

  // メインループ
  const NPM_CHECK_INTERVAL = 300_000; // 5分
  while (state.running) {
    try {
      await tick(state);
      await updateTeamJson(state);
      scheduleRefresh(); // state 変更を TUI に反映（debounce 付き）
    } catch (e: any) {
      await log("error", `tick: ${e.message}`);
    }
    // npm 更新チェック（5分間隔、全 Conductor が idle のときのみ）
    if (Date.now() - state.lastNpmCheckAt >= NPM_CHECK_INTERVAL) {
      const allIdle = [...state.conductors.values()].every(c => c.status === "idle");
      if (allIdle) {
        state.lastNpmCheckAt = Date.now();
        await checkNpmUpdate(state);
      }
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
  if (hasHelpFlag()) showHelp(t("help_send"));
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
        surface: requireArg("surface"),
        success: getArg("success") !== "false",  // デフォルト true（後方互換）
        reason: getArg("reason"),
        exitCode: getArg("exit-code") ? Number(getArg("exit-code")) : undefined,
        sessionId: getArg("session-id"),
        transcriptPath: getArg("transcript-path"),
        timestamp: now,
      };
      break;

    case "CONDUCTOR_REGISTERED":
      message = {
        type: "CONDUCTOR_REGISTERED",
        surface: requireArg("surface"),
        paneId: getArg("pane-id") ?? "",
        timestamp: now,
      };
      break;

    case "AGENT_SPAWNED":
      message = {
        type: "AGENT_SPAWNED",
        conductorSurface: requireArg("conductor-surface"),
        surface: requireArg("surface"),
        role: getArg("role"),
        taskTitle: getArg("task-title"),
        timestamp: now,
      };
      break;

    case "SESSION_STARTED":
      message = {
        type: "SESSION_STARTED",
        surface: requireArg("surface"),
        pid: Number(requireArg("pid")),
        sessionId: getArg("session-id"),
        timestamp: now,
      };
      break;

    case "SESSION_ENDED":
      message = {
        type: "SESSION_ENDED",
        surface: requireArg("surface"),
        pid: getArg("pid") ? Number(getArg("pid")) : undefined,
        reason: getArg("reason"),
        timestamp: now,
      };
      break;

    case "SESSION_ACTIVE":
      message = {
        type: "SESSION_ACTIVE",
        surface: requireArg("surface"),
        pid: getArg("pid") ? Number(getArg("pid")) : undefined,
        timestamp: now,
      };
      break;

    case "SESSION_IDLE":
      message = {
        type: "SESSION_IDLE",
        surface: requireArg("surface"),
        pid: getArg("pid") ? Number(getArg("pid")) : undefined,
        timestamp: now,
      };
      break;

    case "SESSION_CLEAR":
      message = {
        type: "SESSION_CLEAR",
        surface: requireArg("surface"),
        conductorId: getArg("conductor-id"),
        pid: getArg("pid") ? Number(getArg("pid")) : undefined,
        timestamp: now,
      };
      break;

    case "SHUTDOWN":
      message = { type: "SHUTDOWN", timestamp: now };
      break;

    default:
      console.error("Usage: send <TASK_CREATED|CONDUCTOR_DONE|CONDUCTOR_REGISTERED|AGENT_SPAWNED|SESSION_STARTED|SESSION_ENDED|SESSION_ACTIVE|SESSION_IDLE|SESSION_CLEAR|SHUTDOWN>");
      process.exit(1);
  }

  // proxy-port ファイルからポート取得
  const portFile = join(PROJECT_ROOT, ".team/proxy-port");
  if (!existsSync(portFile)) {
    console.error(t("daemon_not_running"));
    process.exit(1);
  }
  const port = (await readFile(portFile, "utf-8")).trim();
  const url = `http://localhost:${port}/api/messages`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`Error: HTTP ${res.status} ${body}`);
      process.exit(1);
    }
    console.log("OK");
  } catch (e: any) {
    console.error(`Error: daemon に接続できません (${url}): ${e.message}`);
    process.exit(1);
  }
}

async function cmdStatus(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_status"));
  const teamJsonPath = join(PROJECT_ROOT, ".team/team.json");
  if (!existsSync(teamJsonPath)) {
    console.log(t("team_not_started_start"));
    return;
  }

  const teamJson = JSON.parse(await readFile(teamJsonPath, "utf-8"));
  const pid = teamJson.manager?.pid;
  const alive = pid && isProcessAlive(pid);
  const masterSurface = teamJson.master?.surface;
  const conductors: Array<{ taskId: string; taskTitle?: string; surface: string }> = teamJson.conductors || [];
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
      const tid = c.taskId && c.taskId !== "undefined" ? `T${c.taskId}` : "---";
      console.log(`  ● [${c.surface.replace("surface:", "")}]  ${tid}${title}`);
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
        const time = new Date(utcTs).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
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

/** daemon の HTTP API にメッセージを送信する。daemon 未起動時はスキップ。 */
async function postMessage(msg: Record<string, unknown>): Promise<void> {
  const portFile = join(PROJECT_ROOT, ".team/proxy-port");
  if (!existsSync(portFile)) return;
  const port = (await readFile(portFile, "utf-8")).trim();
  try {
    await fetch(`http://localhost:${port}/api/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(msg),
    });
  } catch {
    // daemon 未起動・接続失敗時は無視
  }
}

/**
 * cmux-team conductor <slot-id>
 * Conductor 用 Claude Code ラッパー。proxy ポートを動的に解決して claude を exec する。
 */
async function cmdConductor(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_conductor", { model: DEFAULT_MODEL }));
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
  process.env.CMUX_NO_RENAME_TAB = "1";
  process.env.CMUX_CLAUDE_HOOKS_DISABLED = "1";
  const proxyPort = await resolveProxyPort();
  if (proxyPort) {
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxyPort}`;
  }

  // モデル解決
  const config = await loadConfig();
  const model = getModelForRole(config, "conductor", getArg("model"));

  // conductor-settings.json を生成（Conductor 固有の hook + cmux hooks を注入）
  const conductorSettingsPath = join(PROJECT_ROOT, `.team/prompts/${slotId}-settings.json`);
  const conductorSettings = {
    hooks: {
      SessionStart: [
        {
          matcher: "startup",
          hooks: [{
            type: "command",
            command: "bash -c 'cmux-team send SESSION_STARTED --conductor-id \"$CONDUCTOR_ID\" --surface \"${CMUX_SURFACE:-unknown}\" --pid \"$PPID\" --session-id \"${SESSION_ID:-}\" 2>/dev/null || true'",
            timeout: 5000,
          }],
        },
        {
          matcher: "",
          hooks: [{
            type: "command",
            command: "cmux claude-hook session-start",
            timeout: 10000,
          }],
        },
      ],
      Stop: [
        {
          matcher: "",
          hooks: [{
            type: "command",
            command: "bash -c 'cmux-team send SESSION_IDLE --conductor-id \"$CONDUCTOR_ID\" --surface \"${CMUX_SURFACE:-unknown}\" --pid \"$PPID\" 2>/dev/null || true'",
            timeout: 5000,
          }],
        },
        {
          matcher: "",
          hooks: [{
            type: "command",
            command: "cmux claude-hook stop",
            timeout: 10000,
          }],
        },
      ],
      SessionEnd: [
        {
          matcher: "clear",
          hooks: [{
            type: "command",
            command: "bash -c 'cmux-team send SESSION_CLEAR --conductor-id \"$CONDUCTOR_ID\" --surface \"${CMUX_SURFACE:-unknown}\" --pid \"$PPID\" 2>/dev/null || true'",
            timeout: 5000,
          }],
        },
        {
          matcher: "logout|prompt_input_exit",
          hooks: [{
            type: "command",
            command: "bash -c 'cmux-team send SESSION_ENDED --conductor-id \"$CONDUCTOR_ID\" --surface \"${CMUX_SURFACE:-unknown}\" --pid \"$PPID\" --reason \"session_end\" 2>/dev/null || true'",
            timeout: 5000,
          }],
        },
        {
          matcher: "",
          hooks: [{
            type: "command",
            command: "cmux claude-hook session-end",
            timeout: 1000,
          }],
        },
      ],
      Notification: [
        {
          matcher: "",
          hooks: [{
            type: "command",
            command: "cmux claude-hook notification",
            timeout: 10000,
          }],
        },
      ],
      UserPromptSubmit: [
        {
          matcher: "",
          hooks: [{
            type: "command",
            command: "cmux claude-hook prompt-submit",
            timeout: 10000,
          }],
        },
      ],
      PreToolUse: [
        {
          matcher: "",
          hooks: [{
            type: "command",
            command: "cmux claude-hook pre-tool-use",
            timeout: 5000,
            async: true,
          }],
        },
      ],
    },
  };
  try { mkdirSync(join(PROJECT_ROOT, ".team/prompts"), { recursive: true }); } catch {}
  writeFileSync(conductorSettingsPath, JSON.stringify(conductorSettings, null, 2));

  // claude を exec（プロセスを置換）
  const { execFileSync } = require("child_process");
  try {
    execFileSync("claude", [
      "--dangerously-skip-permissions",
      "--settings", conductorSettingsPath,
      "--model", model,
      "--append-system-prompt-file", rolePromptFile,
      t("conductor_wait_prompt"),
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
 * cmux-team spawn-master
 * Master 用 Claude Code ラッパー。proxy ポートを動的に解決して claude を exec する。
 */
async function cmdLaunchMaster(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_spawn_master", { model: DEFAULT_MODEL }));
  // プロンプト生成
  const { generateMasterPrompt } = await import("./template");
  await generateMasterPrompt(PROJECT_ROOT);

  // 環境変数を設定
  process.env.PROJECT_ROOT = PROJECT_ROOT;
  process.env.CMUX_NO_RENAME_TAB = "1";
  const proxyPort = await resolveProxyPort();
  if (proxyPort) {
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxyPort}`;
  }
  await log("master_spawn_proxy", `port=${proxyPort ?? "none"}`);

  // モデル解決
  const config = await loadConfig();
  const model = getModelForRole(config, "master", getArg("model"));

  // claude を exec
  const { execFileSync } = require("child_process");
  try {
    execFileSync("claude", [
      "--dangerously-skip-permissions",
      "--model", model,
      "--append-system-prompt-file", join(PROJECT_ROOT, ".team/prompts/master.md"),
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
  if (hasHelpFlag()) showHelp(t("help_stop"));
  await postMessage({
    type: "SHUTDOWN",
    timestamp: new Date().toISOString(),
  });
  console.log("SHUTDOWN sent");
}

async function cmdSpawnConductor(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_spawn_conductor"));
  const surface = process.env.CMUX_SURFACE ?? await cmux.getCallerSurface();

  const result = await spawnSingleConductor(PROJECT_ROOT, surface);
  console.log(`SURFACE=${result.surface}`);
}

async function cmdSpawnAgent(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_spawn_agent", { model: DEFAULT_MODEL }));
  const conductorSurface = requireArg("conductor-surface");
  const role = requireArg("role");
  const prompt = getArg("prompt");
  const promptFile = getArg("prompt-file");
  let taskTitle = getArg("task-title");
  if (!prompt && !promptFile) {
    console.error("Error: --prompt or --prompt-file is required");
    process.exit(1);
  }

  // --- 1. プロキシポート読み取り + 生存確認 ---
  const proxyPort = await resolveProxyPort();

  // --- 2. タブ作成（new-surface → new-split right フォールバック） ---
  let worktreePath: string | undefined;
  let paneId: string | undefined;
  try {
    const teamJson = JSON.parse(await readFile(join(PROJECT_ROOT, ".team/team.json"), "utf-8"));
    const conductors: any[] = teamJson.conductors ?? [];
    const conductor = conductors.find((c: any) => c.surface === conductorSurface);
    worktreePath = conductor?.worktreePath;
    paneId = conductor?.paneId;
    if (!taskTitle) taskTitle = conductor?.taskTitle;
  } catch {}

  // フォールバック: cmux tree から paneId を解決
  const callerWorkspace = await cmux.getCallerWorkspace();
  if (!paneId) {
    try {
      paneId = await cmux.getPaneForSurface(conductorSurface, callerWorkspace);
    } catch {}
  }

  let surface: string;
  try {
    surface = await cmux.newSurface(paneId);
  } catch {
    surface = await cmux.newSplit("right");
  }

  if (!(await cmux.validateSurface(surface, callerWorkspace))) {
    console.error(`Error: surface ${surface} validation failed`);
    process.exit(1);
  }

  // --- 3. Claude Code 起動 ---
  // モデル解決
  const config = await loadConfig();
  const model = getModelForRole(config, "agent", getArg("model"));

  // 環境変数をシェルに焼き付け
  const exportVars = [
    `ROLE=${role}`,
    `PROJECT_ROOT=${PROJECT_ROOT}`,
    `CMUX_SURFACE=${surface}`,
    `CMUX_NO_RENAME_TAB=1`,
  ];
  if (proxyPort) {
    exportVars.push(`ANTHROPIC_BASE_URL=http://127.0.0.1:${proxyPort}`);
  }
  await cmux.send(surface, `export ${exportVars.join(" ")}\n`);
  await sleep(500);

  // worktree ディレクトリに移動
  if (worktreePath) {
    await cmux.send(surface, `cd ${worktreePath}\n`);
    await sleep(500);
    await cmux.send(surface, `direnv allow 2>/dev/null\n`);
    await sleep(500);
  }

  // Claude Code 起動
  const modelFlag = `--model ${model}`;
  let claudeCmd: string;
  if (promptFile) {
    claudeCmd = `claude --dangerously-skip-permissions ${modelFlag} '${promptFile} を読んで指示に従ってください。'`;
  } else {
    claudeCmd = `claude --dangerously-skip-permissions ${modelFlag} '${prompt}'`;
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

  // --- 6. AGENT_SPAWNED を daemon に送信 ---
  await postMessage({
    type: "AGENT_SPAWNED",
    conductorSurface,
    surface,
    role,
    taskTitle,
    timestamp: new Date().toISOString(),
  });

  // --- 7. stdout に surface を出力 ---
  console.log(`SURFACE=${surface}`);
}

async function cmdAgents(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_agents"));
  const teamJsonPath = join(PROJECT_ROOT, ".team/team.json");
  if (!existsSync(teamJsonPath)) {
    console.log(t("team_not_started"));
    return;
  }

  const teamJson = JSON.parse(await readFile(teamJsonPath, "utf-8"));
  const conductors: Array<{
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
      console.log(`${a.surface}  ${rolePart}  conductor=${c.surface}  task=${c.taskId}${sessionPart}`);
    }
  }

  if (agentCount === 0) {
    console.log(t("no_running_agents"));
  }
}

async function cmdKillAgent(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_kill_agent"));
  const surface = requireArg("surface");

  // surface を閉じる（closeSurface は SESSION_ENDED を送信しないため、明示的に通知する）
  await cmux.closeSurface(surface);

  // daemon に SESSION_ENDED を通知して agents リストから削除させる
  await postMessage({
    type: "SESSION_ENDED",
    surface,
    reason: "kill-agent",
    timestamp: new Date().toISOString(),
  });

  console.log(`OK killed ${surface}`);
}

async function cmdCreateTask(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_create_task"));
  const title = requireArg("title");
  const priority = getArg("priority") || "medium";
  const status = getArg("status") || "draft";
  const body = getArg("body") || "";
  const baseBranch = getArg("base-branch") || "";
  const dependsOn = getArg("depends-on") || "";
  const runAfterAll = process.argv.includes("--run-after-all");

  // run_after_all タスクが既に存在する場合はエラー
  if (runAfterAll) {
    const { tasks } = await loadTasks(PROJECT_ROOT);
    const existingRunAfterAll = tasks.find(t =>
      t.runAfterAll && t.status !== "closed"
    );
    if (existingRunAfterAll) {
      console.error(`Error: run_after_all task already exists: ${existingRunAfterAll.id} (${existingRunAfterAll.title})`);
      process.exit(1);
    }
  }

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
  const dirName = `${newId}-${slug}`;
  const taskDir = join(tasksDir, dirName);
  await mkdir(taskDir, { recursive: true });
  const filePath = join(taskDir, "task.md");

  // depends_on パース
  const depsArray = dependsOn
    ? dependsOn.split(",").map(s => s.trim()).filter(Boolean)
    : [];

  // タスクファイル生成（status は含めない — task-state.json で管理）
  const content = `---
id: ${newId}
title: ${title}
priority: ${priority}${baseBranch ? `\nbase_branch: ${baseBranch}` : ""}${runAfterAll ? "\nrun_after_all: true" : ""}${depsArray.length > 0 ? `\ndepends_on: [${depsArray.join(", ")}]` : ""}
created_at: ${new Date().toISOString()}
---

## ${t("task_section_header")}
${body}
`;
  await writeFile(filePath, content);

  // task-state.json に初期状態を書き込む
  const taskState = await loadTaskState(PROJECT_ROOT);
  taskState[newId] = { status };
  await saveTaskState(PROJECT_ROOT, taskState);

  // status が ready の場合のみ TASK_CREATED を送信
  if (status === "ready") {
    await postMessage({
      type: "TASK_CREATED",
      taskId: newId,
      taskFile: filePath,
      timestamp: new Date().toISOString(),
    });
  }

  const relPath = `.team/tasks/${dirName}/task.md`;
  console.log(`TASK_ID=${newId} FILE=${relPath}`);
}

async function cmdUpdateTask(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_update_task"));
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
      await postMessage({
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
  if (hasHelpFlag()) showHelp(t("help_close_task"));
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

  // CONDUCTOR_DONE メッセージ送信（daemon に完了を通知）
  const teamJsonPath = join(PROJECT_ROOT, ".team/team.json");
  let teamJson: any;
  try {
    teamJson = JSON.parse(await readFile(teamJsonPath, "utf-8"));
  } catch {
    // team.json 読めなくても close 自体は成功させる
  }
  const conductor = teamJson?.conductors?.find((c: any) => c.taskId === taskId);
  if (conductor?.surface) {
    await postMessage({
      type: "CONDUCTOR_DONE",
      surface: conductor.surface,
      success: true,
      timestamp: new Date().toISOString(),
    });
  }

  console.log(`OK closed ${taskId}`);
}

/** assigned タスクのクリーンアップ（sub-agent close, PID kill, worktree/ブランチ削除） */
async function cleanupAssignedTask(conductor: any): Promise<void> {
  // Sub-agent の surface を閉じる
  if (conductor.agents?.length > 0) {
    for (const agent of conductor.agents) {
      try {
        await cmux.closeSurface(agent.surface);
      } catch {}
    }
  }

  // Conductor の PID を kill
  if (conductor.pid && isProcessAlive(conductor.pid)) {
    try {
      process.kill(conductor.pid, "SIGTERM");
    } catch {}
  }

  // worktree 削除
  if (conductor.worktreePath && existsSync(conductor.worktreePath)) {
    try {
      const { execFile: execFileCb } = require("child_process");
      const { promisify } = require("util");
      const execFileAsync = promisify(execFileCb);
      await execFileAsync("git", ["worktree", "remove", conductor.worktreePath, "--force"], {
        cwd: PROJECT_ROOT,
      });
    } catch {}
    // ブランチ削除
    if (conductor.taskRunId) {
      const branch = `${conductor.taskRunId}/task`;
      try {
        const { execFile: execFileCb } = require("child_process");
        const { promisify } = require("util");
        const execFileAsync = promisify(execFileCb);
        await execFileAsync("git", ["branch", "-D", branch], { cwd: PROJECT_ROOT });
      } catch {}
    }
  }
}

async function cmdAbortTask(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_abort_task"));
  const taskId = requireArg("task-id");
  const journalArg = getArg("journal");

  // タスクタイトル取得（journal デフォルト生成用）
  const taskFile = await findTaskFile(taskId);
  let title = "";
  if (taskFile) {
    const taskContent = await readFile(taskFile, "utf-8");
    title = taskContent.match(/^title:\s*["']?(.+?)["']?\s*$/m)?.[1] ?? "";
  }
  const journal = journalArg ?? t("abort_journal_default", { id: taskId, title }).replace(/\s+$/, "");

  // 1. タスク状態を確認
  const taskState = await loadTaskState(PROJECT_ROOT);
  const currentStatus = taskState[taskId]?.status;
  if (currentStatus !== "assigned") {
    console.error(`Error: task ${taskId} is not assigned (current status: ${currentStatus ?? "unknown"}). Only assigned tasks can be aborted.`);
    process.exit(1);
  }

  // 2. team.json から該当 Conductor を特定
  const teamJsonPath = join(PROJECT_ROOT, ".team/team.json");
  let teamJson: any;
  try {
    teamJson = JSON.parse(await readFile(teamJsonPath, "utf-8"));
  } catch {
    console.error("Error: team.json not found or unreadable");
    process.exit(1);
  }
  const conductor = teamJson.conductors?.find((c: any) => c.taskId === taskId);
  if (!conductor) {
    console.error(`Error: no conductor found for task ${taskId}`);
    // タスク状態だけ aborted にする
    taskState[taskId] = {
      ...taskState[taskId],
      status: "aborted",
      abortedAt: new Date().toISOString(),
      journal,
    };
    await saveTaskState(PROJECT_ROOT, taskState);
    await log("task_aborted", `task_id=${taskId}${title ? ` title=${title}` : ""} journal_summary=${journal}`);
    console.log(`OK aborted ${taskId} (no conductor found, state updated only)`);
    return;
  }

  // 3〜5. クリーンアップ（sub-agent close, PID kill, worktree 削除）
  await cleanupAssignedTask(conductor);

  // 6. タスク状態を aborted に変更
  taskState[taskId] = {
    ...taskState[taskId],
    status: "aborted",
    abortedAt: new Date().toISOString(),
    journal,
  };
  await saveTaskState(PROJECT_ROOT, taskState);

  await log("task_aborted", `task_id=${taskId}${title ? ` title=${title}` : ""} journal_summary=${journal}`);

  // 7. CONDUCTOR_DONE メッセージ送信（daemon に通知）
  await postMessage({
    type: "CONDUCTOR_DONE",
    surface: conductor.surface,
    success: false,
    reason: "aborted",
    timestamp: new Date().toISOString(),
  });

  // 8. Conductor を再起動（新しいセッション）
  const slotId = conductor.surface.replace("surface:", "");
  await cmux.send(conductor.surface, `export CMUX_SURFACE=${conductor.surface}\n`);
  await sleep(500);
  await cmux.send(conductor.surface, `cmux-team conductor ${slotId}\n`);

  console.log(`OK aborted ${taskId} (conductor ${conductor.surface} restarting)`);
}

async function cmdRestartTask(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_restart_task"));
  const taskId = requireArg("task-id");
  const journalArg = getArg("journal");

  // タスクタイトル取得（journal デフォルト生成用）
  const taskFile = await findTaskFile(taskId);
  let title = "";
  if (taskFile) {
    const taskContent = await readFile(taskFile, "utf-8");
    title = taskContent.match(/^title:\s*["']?(.+?)["']?\s*$/m)?.[1] ?? "";
  }
  const journal = journalArg ?? t("restart_journal_default", { id: taskId, title }).replace(/\s+$/, "");

  // 1. タスク状態を確認
  const taskState = await loadTaskState(PROJECT_ROOT);
  const currentStatus = taskState[taskId]?.status;
  if (currentStatus !== "assigned") {
    console.error(`Error: task ${taskId} is not assigned (current status: ${currentStatus ?? "unknown"}). Only assigned tasks can be restarted.`);
    process.exit(1);
  }

  // 2. team.json から該当 Conductor を特定
  const teamJsonPath = join(PROJECT_ROOT, ".team/team.json");
  let teamJson: any;
  try {
    teamJson = JSON.parse(await readFile(teamJsonPath, "utf-8"));
  } catch {
    console.error("Error: team.json not found or unreadable");
    process.exit(1);
  }
  const conductor = teamJson.conductors?.find((c: any) => c.taskId === taskId);
  if (!conductor) {
    // Conductor が見つからない場合: status を ready に戻して TASK_CREATED 通知
    taskState[taskId] = {
      ...taskState[taskId],
      status: "ready",
      journal: `[restart] ${journal}`,
    };
    delete taskState[taskId].assignedAt;
    await saveTaskState(PROJECT_ROOT, taskState);
    await log("task_restarted", `task_id=${taskId}${title ? ` title=${title}` : ""} journal_summary=${journal} no_conductor=true`);
    await postMessage({
      type: "TASK_CREATED",
      taskId,
      taskFile: taskFile ?? "",
      timestamp: new Date().toISOString(),
    });
    console.log(`OK restarted ${taskId} (no conductor found, re-queued as ready)`);
    return;
  }

  // 3. クリーンアップ（sub-agent close, PID kill, worktree 削除）
  await cleanupAssignedTask(conductor);

  // 4. タスク状態を ready に変更
  taskState[taskId] = {
    ...taskState[taskId],
    status: "ready",
    journal: `[restart] ${journal}`,
  };
  delete taskState[taskId].assignedAt;
  await saveTaskState(PROJECT_ROOT, taskState);

  await log("task_restarted", `task_id=${taskId}${title ? ` title=${title}` : ""} journal_summary=${journal}`);

  // 5. CONDUCTOR_DONE メッセージ送信（daemon に通知）
  await postMessage({
    type: "CONDUCTOR_DONE",
    surface: conductor.surface,
    success: false,
    reason: "restarted",
    timestamp: new Date().toISOString(),
  });

  // 6. Conductor を再起動（新しいセッション）
  const slotId = conductor.surface.replace("surface:", "");
  await cmux.send(conductor.surface, `export CMUX_SURFACE=${conductor.surface}\n`);
  await sleep(500);
  await cmux.send(conductor.surface, `cmux-team conductor ${slotId}\n`);

  // 7. TASK_CREATED 通知送信（自動再割り当て用）
  await postMessage({
    type: "TASK_CREATED",
    taskId,
    taskFile: taskFile ?? "",
    timestamp: new Date().toISOString(),
  });

  console.log(`OK restarted ${taskId} (conductor ${conductor.surface} restarting)`);
}

async function cmdDeleteTask(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_delete_task"));
  const taskId = requireArg("task-id");
  const journalArg = getArg("journal");

  const taskFile = await findTaskFile(taskId);
  if (!taskFile) {
    console.error(`Error: task ${taskId} not found in .team/tasks/`);
    process.exit(1);
  }

  const taskState = await loadTaskState(PROJECT_ROOT);
  const currentStatus = taskState[taskId]?.status;
  if (currentStatus === "assigned") {
    console.error(`Error: task ${taskId} is assigned (running). Use abort-task to stop a running task.`);
    process.exit(1);
  }
  if (currentStatus === "closed" || currentStatus === "aborted" || currentStatus === "deleted") {
    console.error(`Error: task ${taskId} is already ${currentStatus}.`);
    process.exit(1);
  }

  const taskContent = await readFile(taskFile, "utf-8");
  const titleMatch = taskContent.match(/^title:\s*["']?(.+?)["']?\s*$/m);
  const title = titleMatch?.[1] ?? "";

  const journal = journalArg ?? t("delete_journal_default", { id: taskId, title }).replace(/\s+$/, "");

  taskState[taskId] = {
    status: "deleted",
    deletedAt: new Date().toISOString(),
    journal,
  };
  await saveTaskState(PROJECT_ROOT, taskState);

  await log("task_deleted", `task_id=${taskId}${title ? ` title=${title}` : ""} journal_summary=${journal}`);

  console.log(`OK deleted ${taskId}`);
}

async function cmdTrace(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_trace"));
  const db = initDB(PROJECT_ROOT);
  const taskId = getArg("task");
  const conductorSurface = getArg("conductor");
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
    conductorId: conductorSurface,
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
  if (hasHelpFlag()) showHelp(t("help_artifacts"));
  const subCmd = args[1];

  // cmux-team artifacts --validate
  if (getArg("validate") !== undefined || args.includes("--validate")) {
    const artifacts = await loadArtifacts(PROJECT_ROOT);
    if (artifacts.length === 0) {
      console.log(t("no_artifacts"));
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
      console.error(t("artifact_id_required"));
      process.exit(1);
    }
    // "A001" でも "001" でも受け付ける
    const normalizedId = rawId.startsWith("A") ? rawId : `A${rawId.padStart(3, "0")}`;
    const artifacts = await loadArtifacts(PROJECT_ROOT);
    const found = artifacts.find((a) => a.id === normalizedId || a.id === rawId);
    if (!found) {
      console.error(t("artifact_not_found", { id: rawId }));
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
      console.error(t("search_query_required"));
      process.exit(1);
    }
    const results = await searchArtifacts(PROJECT_ROOT, query);
    if (results.length === 0) {
      console.log(t("no_artifacts_matching", { query }));
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
    console.log(t("no_artifacts"));
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
  case "spawn-conductor":
    await cmdSpawnConductor();
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
  case "abort-task":
    await cmdAbortTask();
    break;
  case "restart-task":
    await cmdRestartTask();
    break;
  case "delete-task":
    await cmdDeleteTask();
    break;
  case "trace":
    await cmdTrace();
    break;
  case "conductor":
    await cmdConductor();
    break;
  case "spawn-master":
    await cmdLaunchMaster();
    break;
  case "artifacts":
    await cmdArtifacts();
    break;
  default:
    if (!command || hasHelpFlag()) {
    console.log(t("help_main"));
      process.exit(0);
    }
    console.error(`Unknown command: ${command}`);
    console.error(`Run 'cmux-team --help' for usage.`);
    process.exit(1);
}
