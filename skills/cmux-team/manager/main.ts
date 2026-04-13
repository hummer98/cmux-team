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
 *   ./main.ts update-task --task-id <id> [--status <status>] [--body <text>] [--title <title>] [--depends-on <ids>]
 *   ./main.ts close-task --task-id <id> [--journal <text>] [--force]
 *   ./main.ts await-task --task-id <id> [--timeout <sec>]  # タスク完了待ち
 *   ./main.ts abort-task --task-id <id>
 *   ./main.ts restart-task --task-id <id> [--journal <text>]
 *   ./main.ts delete-task --task-id <id> [--journal <text>]
 */

import { join, dirname, basename } from "path";
import { existsSync, writeFileSync, mkdirSync, watch } from "fs";
import { homedir } from "os";
import { readFile, readdir, writeFile, mkdir, stat } from "fs/promises";
import { t } from "./i18n";
import { createDaemon, initInfra, startMaster, initializeLayout, tick, updateTeamJson, updateSidebarStatus, initSourceWatcher, initFileWatcher, sleepUntilWakeup, checkNpmUpdate, handleMessage } from "./daemon";
import { resolveMarkdownViewer, startDashboard, unmountDashboard } from "./dashboard";
import { log } from "./logger";
import { formatExecError } from "./exec-error";
import * as cmux from "./cmux";
import { start as startProxy } from "./proxy";
import { launchConductor } from "./conductor";
import { createHash } from "crypto";
import { initDB, insertTaskSession, getSessionsForTask, getTaskSessions } from "./trace-store";
import { loadTaskState, loadTasks, saveTaskState } from "./task";
import { loadArtifacts, searchArtifacts, validateArtifact, addArtifact } from "./artifact";
import { runPreflight, printPreflightIssues } from "./preflight";
import { ensureEnvrcHookPrompt } from "./envrc-prompt";
import type { QueueMessage, LayoutMode } from "./schema";
import { THROTTLE_5H_THRESHOLD, LAYOUT_MAX_CONDUCTORS } from "./schema";

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
  envrcHookPromptSkipped?: boolean;
  layout?: LayoutMode;
}

async function loadConfig(): Promise<TeamConfig> {
  const configPath = join(PROJECT_ROOT, ".team/config.json");
  try {
    return JSON.parse(await readFile(configPath, "utf-8"));
  } catch {
    return {};
  }
}

/**
 * レイアウトモードを解決する。
 * 優先順位: CLI フラグ (--layout) > config.json の layout > "wide"
 * 不正値は Error を throw する（呼び出し元で process.exit する想定）。
 */
export function resolveLayout(
  config: Pick<TeamConfig, "layout">,
  cliLayout: string | undefined,
): LayoutMode {
  const raw = cliLayout ?? config.layout ?? "wide";
  if (raw !== "wide" && raw !== "16x9") {
    throw new Error(`Unknown layout: ${raw} (expected "wide" or "16x9")`);
  }
  return raw;
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

  // layout 解決（CLI --layout > config.json > "wide"）
  const startConfig = await loadConfig();
  let layout: LayoutMode;
  try {
    layout = resolveLayout(startConfig, getArg("layout"));
  } catch (e: any) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }

  const state = await createDaemon(PROJECT_ROOT, layout);

  // ソースファイル mtime 監視を初期化
  state.sourceMtimes = await initSourceWatcher();

  // ファイルシステム監視（tasks/, queue/ の変更で即時 tick）
  initFileWatcher(state);

  // インフラ準備
  await initInfra(state);
  await log("infra_ready");

  // .envrc に CMUX_CLAUDE_HOOKS_DISABLED を追記するか対話確認
  // proxy 起動・TUI 起動より前で同期実行する（Ink TUI が stdin/stdout を奪うため）
  await ensureEnvrcHookPrompt(PROJECT_ROOT);

  await log(
    "daemon_started",
    `pid=${process.pid} poll=${state.pollInterval}ms max_conductors=${state.maxConductors} layout=${state.layout}`
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
    if (state.workspace) {
      await cmux.clearStatus("claude_code", state.workspace);
    }
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

  // ワークスペース名を起動フォルダ名に設定
  const folderName = basename(PROJECT_ROOT);
  await cmux.renameWorkspace(folderName, state.workspace);

  // --- assigned タスクの resumePlan を boot 前に構築 ---
  //   launchConductor に `{ resumeTaskId }` を渡して起動時点で
  //   `cmux-team resume <id>` をシェルに投入する（旧実装は Claude 起動後に
  //   チャット入力として消費されるバグがあった）。
  const taskState = await loadTaskState(PROJECT_ROOT);
  let taskStateModified = false;
  const rawResumePlan: Array<{
    taskId: string;
    taskRunId: string;
    worktreePath: string;
    sessionId: string;
    taskTitle?: string;
  }> = [];

  for (const [taskId, ts] of Object.entries(taskState)) {
    if (ts.status !== "assigned") continue;

    const canResume = ts.sessionId
      && ts.worktreePath && existsSync(ts.worktreePath)
      && ts.taskRunId;

    if (!canResume) {
      // resume 不可 → ready に戻す（次の scanTasks で再割り当て）
      taskState[taskId] = { ...ts, status: "ready" };
      taskStateModified = true;
      await log(
        "resume_fallback_to_ready",
        `task_id=${taskId} reason=${!ts.sessionId ? "no_session_id" : "no_worktree"} worktreePath=${ts.worktreePath ?? "null"} sessionId=${ts.sessionId ? "present" : "absent"} taskRunId=${ts.taskRunId ?? "null"}`
      );
      continue;
    }

    rawResumePlan.push({
      taskId,
      taskRunId: ts.taskRunId!,
      worktreePath: ts.worktreePath!,
      sessionId: ts.sessionId!,
    });
  }

  // 順序の安定化: taskId を数値として昇順 sort。これによりどの pane に
  // どの task が割り当てられるかが task-state.json の記録順に依存しなくなる。
  rawResumePlan.sort((a, b) => {
    const na = parseInt(a.taskId, 10);
    const nb = parseInt(b.taskId, 10);
    if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
    return a.taskId.localeCompare(b.taskId);
  });

  // slot 数を超える場合は末尾から ready に差し戻す
  while (rawResumePlan.length > state.maxConductors) {
    const overflow = rawResumePlan.pop()!;
    taskState[overflow.taskId] = { ...taskState[overflow.taskId], status: "ready" };
    taskStateModified = true;
    await log("resume_overflow_to_ready", `task_id=${overflow.taskId}`);
  }

  // タスクタイトルを取得（renameTab 用）
  for (const item of rawResumePlan) {
    const taskFile = await findTaskFile(item.taskId);
    if (taskFile) {
      try {
        const content = await readFile(taskFile, "utf-8");
        item.taskTitle = content.match(/^title:\s*(.+)/m)?.[1]?.trim();
      } catch {}
    }
  }

  if (rawResumePlan.length > 0) {
    await log(
      "resume_plan_built",
      `count=${rawResumePlan.length} taskIds=[${rawResumePlan.map(r => r.taskId).join(",")}]`
    );
  }

  // Conductor スロット作成（resumePlan を透過）
  state.bootPhase = "conductors";
  scheduleRefresh();
  const resumeAssignments = await initializeLayout(state, daemonSurface, rawResumePlan);
  scheduleRefresh();

  // resume 割当結果を ConductorState に反映（タブ名 + state 詳細）
  for (const r of resumeAssignments) {
    const c = state.conductors.get(r.surface);
    if (!c) {
      await log("resume_assignment_missing_conductor", `surface=${r.surface} task_id=${r.taskId}`);
      continue;
    }
    c.taskId = r.taskId;
    c.taskRunId = r.taskRunId;
    c.worktreePath = r.worktreePath;
    c.taskTitle = r.taskTitle;
    c.status = "running";
    c.startedAt = new Date().toISOString();
    c.agents = [];

    const num = c.surface.replace("surface:", "");
    const shortTitle = (c.taskTitle ?? "").slice(0, 30);
    await cmux.renameTab(c.surface, `[${num}] ♦ T${r.taskId} ${shortTitle}`).catch(() => {});

    await log(
      "task_resumed",
      `task_id=${r.taskId} session_id=${r.sessionId} surface=${r.surface} (via boot)`
    );
  }

  if (taskStateModified) {
    await saveTaskState(PROJECT_ROOT, taskState);
  }

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
      await updateSidebarStatus(state);
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

    case "CONDUCTOR_SESSION":
      message = {
        type: "CONDUCTOR_SESSION",
        surface: requireArg("surface"),
        sessionId: requireArg("session-id"),
        timestamp: now,
      };
      break;

    case "SHUTDOWN":
      message = { type: "SHUTDOWN", timestamp: now };
      break;

    default:
      console.error("Usage: send <TASK_CREATED|CONDUCTOR_DONE|CONDUCTOR_REGISTERED|CONDUCTOR_SESSION|AGENT_SPAWNED|SESSION_STARTED|SESSION_ENDED|SESSION_ACTIVE|SESSION_IDLE|SESSION_CLEAR|SHUTDOWN>");
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
  const layout = typeof teamJson.layout === "string" ? teamJson.layout : "wide";
  console.log(`cmux-team  ${status}  PID ${pid || "-"}  conductors ${conductors.length}  layout=${layout}`);

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
 * conductor-settings.json を生成する共通ヘルパー。
 * cmdConductor と cmdResume の両方から使用される。
 * @returns 生成したファイルの絶対パス
 */
/**
 * PreToolUse hook 用の bash スクリプト。
 * Bash tool の command が `cmux send` / `cmux send-key` を叩こうとしていたら exit 2 で拒否する。
 * 代替手段として `cmux-team send-agent` を stderr で案内する（2 行構成、Design Review R3）。
 *
 * 正規表現の設計:
 *   - `(^|[^-[:alnum:]_])cmux[[:space:]]+(send|send-key)([[:space:]]|$)`
 *   - `cmux-team` は `-` が前置でマッチしないため通る
 *   - `sender` 等は `(send|send-key)` 直後の space/行末条件で除外
 */
const PRE_TOOL_USE_HOOK_SCRIPT = [
  'input="$(cat)"',
  'cmd="$(printf "%s" "$input" | grep -oE "\\"command\\"[[:space:]]*:[[:space:]]*\\"[^\\"]*\\"" | head -1 | sed -E "s/^\\"command\\"[[:space:]]*:[[:space:]]*\\"//; s/\\"$//")"',
  'if printf "%s" "$cmd" | grep -qE "(^|[^-[:alnum:]_])cmux[[:space:]]+(send|send-key)([[:space:]]|$)"; then',
  '  echo "cmux send / cmux send-key は Conductor から使用禁止です。" >&2',
  '  echo "代替: cmux-team send-agent --surface <agent-surface> <message>  (自分が spawn した Agent のみ送信可)" >&2',
  '  exit 2',
  'fi',
  'exit 0',
].join("\n");

export function generateConductorSettings(projectRoot: string, surface: string): string {
  const conductorSettingsPath = join(projectRoot, `.team/prompts/${surface}-settings.json`);
  const conductorSettings: Record<string, any> = {
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{
            type: "command",
            command: `bash -c '${PRE_TOOL_USE_HOOK_SCRIPT}'`,
            timeout: 3000,
          }],
        },
      ],
      SessionStart: [
        {
          matcher: "startup",
          hooks: [{
            type: "command",
            command: "bash -c 'cmux-team send SESSION_STARTED --conductor-id \"$CONDUCTOR_ID\" --surface \"${CMUX_SURFACE}\" --pid \"$PPID\" 2>/dev/null || true'",
            timeout: 5000,
          }],
        },
      ],
      Stop: [
        {
          matcher: "",
          hooks: [{
            type: "command",
            command: "bash -c 'cmux-team send SESSION_IDLE --conductor-id \"$CONDUCTOR_ID\" --surface \"${CMUX_SURFACE}\" --pid \"$PPID\" 2>/dev/null || true'",
            timeout: 5000,
          }],
        },
      ],
      SessionEnd: [
        {
          matcher: "clear",
          hooks: [{
            type: "command",
            command: "bash -c 'cmux-team send SESSION_CLEAR --conductor-id \"$CONDUCTOR_ID\" --surface \"${CMUX_SURFACE}\" --pid \"$PPID\" 2>/dev/null || true'",
            timeout: 5000,
          }],
        },
        {
          matcher: "logout|prompt_input_exit",
          hooks: [{
            type: "command",
            command: "bash -c 'cmux-team send SESSION_ENDED --conductor-id \"$CONDUCTOR_ID\" --surface \"${CMUX_SURFACE}\" --pid \"$PPID\" --reason \"session_end\" 2>/dev/null || true'",
            timeout: 5000,
          }],
        },
      ],
    },
  };

  // statusline.sh が存在する場合のみ statusLine 設定を追加
  const statuslineScript = join(homedir(), ".claude", "statusline.sh");
  if (existsSync(statuslineScript)) {
    conductorSettings.statusLine = {
      type: "command",
      command: statuslineScript,
    };
  }

  try { mkdirSync(join(projectRoot, ".team/prompts"), { recursive: true }); } catch {}
  writeFileSync(conductorSettingsPath, JSON.stringify(conductorSettings, null, 2));
  return conductorSettingsPath;
}

/**
 * cmux-team conductor
 * Conductor 用 Claude Code ラッパー。proxy ポートを動的に解決して claude を exec する。
 * CMUX_SURFACE 環境変数が必須。
 */
async function cmdConductor(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_conductor", { model: DEFAULT_MODEL }));
  const surface = process.env.CMUX_SURFACE;
  if (!surface) {
    console.error("Error: CMUX_SURFACE environment variable is required");
    process.exit(1);
  }

  // ロールプロンプトファイル生成
  const { generateConductorRolePrompt } = await import("./template");
  const rolePromptFile = await generateConductorRolePrompt(PROJECT_ROOT);

  // 環境変数を設定
  process.env.PROJECT_ROOT = PROJECT_ROOT;
  process.env.CONDUCTOR_ID = surface;
  process.env.CMUX_ROLE = "conductor";
  process.env.CMUX_NO_RENAME_TAB = "1";
  process.env.CMUX_CLAUDE_HOOKS_DISABLED = "1";
  const proxyPort = await resolveProxyPort();
  if (proxyPort) {
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxyPort}`;
  }

  // モデル解決
  const config = await loadConfig();
  const model = getModelForRole(config, "conductor", getArg("model"));

  // sessionId を自己生成し daemon に通知
  const sessionId = crypto.randomUUID();
  try {
    const portFile = join(PROJECT_ROOT, ".team/proxy-port");
    if (existsSync(portFile)) {
      const port = (await readFile(portFile, "utf-8")).trim();
      await fetch(`http://localhost:${port}/api/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "CONDUCTOR_SESSION",
          surface,
          sessionId,
          timestamp: new Date().toISOString(),
        }),
      });
    }
  } catch {
    // daemon 未起動時は無視（Claude 起動は続行）
  }

  const taskPromptFile = getArg("task-prompt");

  // conductor-settings.json を生成（Conductor 固有の hook + cmux hooks を注入）
  const conductorSettingsPath = generateConductorSettings(PROJECT_ROOT, surface);

  // claude コマンド引数を組み立て
  const claudeArgs = [
    "--dangerously-skip-permissions",
    "--settings", conductorSettingsPath,
    "--model", model,
    "--append-system-prompt-file", rolePromptFile,
  ];
  claudeArgs.push("--session-id", sessionId);

  // 初期プロンプトを決定
  const initialPrompt = taskPromptFile
    ? `${taskPromptFile} を読んで指示に従って作業してください。`
    : t("conductor_wait_prompt");
  claudeArgs.push(initialPrompt);

  // claude を exec（プロセスを置換）
  const { execFileSync } = require("child_process");
  try {
    execFileSync("claude", claudeArgs, {
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
 * cmux-team resume <task-id>
 * assigned タスクの Conductor セッションを claude --resume で再開する。
 */
async function cmdResume(): Promise<void> {
  if (hasHelpFlag()) showHelp("Usage: cmux-team resume <task-id>");
  const surface = process.env.CMUX_SURFACE;
  if (!surface) {
    console.error("Error: CMUX_SURFACE environment variable is required");
    process.exit(1);
  }
  const taskId = args[1];
  if (!taskId) {
    console.error("Usage: cmux-team resume <task-id>");
    process.exit(1);
  }

  // task-state.json から resume 情報を取得
  const taskState = await loadTaskState(PROJECT_ROOT);
  const ts = taskState[taskId];
  if (!ts) {
    console.error(`Task ${taskId} not found in task-state.json`);
    process.exit(1);
  }
  if (ts.status !== "assigned") {
    console.error(`Task ${taskId} is not assigned (status: ${ts.status})`);
    process.exit(1);
  }
  if (!ts.sessionId) {
    console.error(`Task ${taskId} has no sessionId — cannot resume`);
    process.exit(1);
  }
  if (!ts.worktreePath || !existsSync(ts.worktreePath)) {
    console.error(`Task ${taskId} worktree not found: ${ts.worktreePath}`);
    process.exit(1);
  }

  // 環境変数を設定（cmdConductor と同等）
  process.env.PROJECT_ROOT = PROJECT_ROOT;
  process.env.CONDUCTOR_ID = surface;
  process.env.CMUX_ROLE = "conductor";
  process.env.CMUX_NO_RENAME_TAB = "1";
  process.env.CMUX_CLAUDE_HOOKS_DISABLED = "1";
  const proxyPort = await resolveProxyPort();
  if (proxyPort) {
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxyPort}`;
  }

  // モデル解決
  const config = await loadConfig();
  const model = getModelForRole(config, "conductor", getArg("model"));

  // conductor-settings.json 生成（cmdConductor と同一の hook 構成）
  const conductorSettingsPath = generateConductorSettings(PROJECT_ROOT, surface);

  // claude --resume で再開
  const { execFileSync } = require("child_process");
  try {
    execFileSync("claude", [
      "--resume", ts.sessionId,
      "--dangerously-skip-permissions",
      "--settings", conductorSettingsPath,
      "--model", model,
    ], {
      stdio: "inherit",
      env: process.env,
      cwd: ts.worktreePath,
    });
  } catch (e: any) {
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
  process.env.CMUX_ROLE = "master";
  process.env.CMUX_NO_RENAME_TAB = "1";
  process.env.CMUX_CLAUDE_HOOKS_DISABLED = "1";
  const proxyPort = await resolveProxyPort();
  if (proxyPort) {
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxyPort}`;
  }
  await log("master_spawn_proxy", `port=${proxyPort ?? "none"}`);

  // Master 用 settings.json 生成
  const masterSettingsPath = join(PROJECT_ROOT, ".team/prompts/master-settings.json");
  const statuslineScript = join(homedir(), ".claude", "statusline.sh");
  const masterSettings: Record<string, any> = {};
  if (existsSync(statuslineScript)) {
    masterSettings.statusLine = {
      type: "command",
      command: statuslineScript,
    };
  }
  try { mkdirSync(join(PROJECT_ROOT, ".team/prompts"), { recursive: true }); } catch {}
  writeFileSync(masterSettingsPath, JSON.stringify(masterSettings, null, 2));

  // モデル解決
  const config = await loadConfig();
  const model = getModelForRole(config, "master", getArg("model"));

  // claude を exec
  const { execFileSync } = require("child_process");
  try {
    execFileSync("claude", [
      "--dangerously-skip-permissions",
      "--settings", masterSettingsPath,
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

  await launchConductor(PROJECT_ROOT, surface);
  console.log(`SURFACE=${surface}`);
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

  // team.json から conductor 情報を前倒しで解決（throttle ログでも taskId を参照するため）
  let worktreePath: string | undefined;
  let paneId: string | undefined;
  let taskId: string | undefined;
  try {
    const teamJson = JSON.parse(await readFile(join(PROJECT_ROOT, ".team/team.json"), "utf-8"));
    const conductors: any[] = teamJson.conductors ?? [];
    const conductor = conductors.find((c: any) => c.surface === conductorSurface);
    worktreePath = conductor?.worktreePath;
    paneId = conductor?.paneId;
    taskId = conductor?.taskId;
    if (!taskTitle) taskTitle = conductor?.taskTitle;
  } catch {}

  // --- 1.5 throttle ガード ---
  // exit 75 = BSD sysexits EX_TEMPFAIL（一時的失敗、retry 可能）
  if (proxyPort) {
    try {
      const resp = await fetch(`http://127.0.0.1:${proxyPort}/rate-limit`, {
        signal: AbortSignal.timeout(2000),
      });
      if (resp.ok) {
        const rl = await resp.json() as {
          throttled: boolean;
          unified5hReset: number | null;
          unified5hUtilization: number | null;
          resetRemaining: string | null;
        };
        if (rl.throttled) {
          const util = rl.unified5hUtilization ?? 0;
          console.log(`THROTTLED=true`);
          console.log(`RESET_EPOCH=${rl.unified5hReset ?? 0}`);
          console.log(`RESET_REMAINING=${rl.resetRemaining ?? ""}`);
          console.log(`UTILIZATION=${(util * 100).toFixed(1)}%`);
          console.log(`THRESHOLD=${(THROTTLE_5H_THRESHOLD * 100).toFixed(0)}%`);
          console.log(`MESSAGE=Rate limit exceeded. Wait until RESET_EPOCH before retrying spawn-agent.`);
          await log("spawn_agent_throttled",
            `conductor=${conductorSurface} role=${role} task_id=${taskId ?? "-"} util=${(util * 100).toFixed(1)}% unified5hReset=${rl.unified5hReset ?? "null"}`);
          process.exit(75);
        }
      } else {
        await log("spawn_agent_ratelimit_warn", `status=${resp.status}`);
      }
    } catch (e: any) {
      await log("spawn_agent_ratelimit_warn", `fetch_failed=${e?.message ?? e}`);
      // best-effort: 続行
    }
  }

  // --- 2. タブ作成（new-surface → new-split right フォールバック） ---

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

  // Agent 用 settings.json 生成
  const statuslineScript = join(homedir(), ".claude", "statusline.sh");
  let agentSettingsFlag = "";
  if (existsSync(statuslineScript)) {
    const agentSettingsPath = join(PROJECT_ROOT, `.team/prompts/${surface}-agent-settings.json`);
    const agentSettings = {
      statusLine: {
        type: "command",
        command: statuslineScript,
      },
    };
    try { mkdirSync(join(PROJECT_ROOT, ".team/prompts"), { recursive: true }); } catch {}
    writeFileSync(agentSettingsPath, JSON.stringify(agentSettings, null, 2));
    agentSettingsFlag = `--settings '${agentSettingsPath}'`;
  }

  // 環境変数をシェルに焼き付け
  const exportVars = [
    `ROLE=${role}`,
    `CMUX_ROLE=agent`,
    `PROJECT_ROOT=${PROJECT_ROOT}`,
    `CMUX_SURFACE=${surface}`,
    `CMUX_NO_RENAME_TAB=1`,
    `CMUX_CLAUDE_HOOKS_DISABLED=1`,
  ];
  if (taskId) {
    exportVars.push(`CMUX_TASK_ID=${taskId}`);
  }
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
  const claudeFlags = ["--dangerously-skip-permissions"];
  if (agentSettingsFlag) {
    claudeFlags.push(agentSettingsFlag);
  }
  claudeFlags.push(`--model ${model}`);

  let claudeCmd: string;
  if (promptFile) {
    claudeCmd = `claude ${claudeFlags.join(" ")} '${promptFile} を読んで指示に従ってください。'`;
  } else {
    claudeCmd = `claude ${claudeFlags.join(" ")} '${prompt}'`;
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

  // タスク-セッション索引に記録
  try {
    const teamJson2 = JSON.parse(await readFile(join(PROJECT_ROOT, ".team/team.json"), "utf-8"));
    const cond = teamJson2?.conductors?.find((c: any) => c.surface === conductorSurface);
    if (cond?.taskId) {
      const db = initDB(PROJECT_ROOT);
      insertTaskSession(db, {
        timestamp: new Date().toISOString(),
        task_id: cond.taskId,
        task_run_id: cond.taskRunId,
        session_id: "",
        role,
        surface,
        worktree_path: worktreePath,
        event: "agent_spawned",
      });
      db.close();
    }
  } catch (e: any) {
    log("error", `trace DB agent_spawned insert failed: ${e?.message ?? e}`).catch(() => {});
  }

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

/**
 * `cmdSendAgent` で使用する検証結果の型。
 * reason は理由別ログ/エラーメッセージの分岐に使う。
 */
export type SendAgentValidationReason =
  | "not_a_conductor"
  | "agent_not_found"
  | "self_send";

export type SendAgentValidationResult =
  | { ok: true }
  | { ok: false; reason: SendAgentValidationReason };

/**
 * team.json と caller/target surface から send-agent の可否を判定する。
 * ファイル I/O を行わないため単体テストが容易。
 */
export function validateSendAgentTarget(
  teamJson: any,
  callerSurface: string,
  targetSurface: string,
): SendAgentValidationResult {
  if (callerSurface === targetSurface) {
    return { ok: false, reason: "self_send" };
  }
  const conductors: any[] = teamJson?.conductors ?? [];
  const conductor = conductors.find((c: any) => c.surface === callerSurface);
  if (!conductor) {
    return { ok: false, reason: "not_a_conductor" };
  }
  const agent = (conductor.agents ?? []).find((a: any) => a.surface === targetSurface);
  if (!agent) {
    return { ok: false, reason: "agent_not_found" };
  }
  return { ok: true };
}

/**
 * team.json の反映ラグを吸収するため、agent_not_found の場合のみリトライする。
 * 200ms × 最大 5 回（合計 1 秒）。他の reject 理由は恒久的なのでリトライしない。
 */
export async function waitForAgentRegistered(
  teamJsonPath: string,
  callerSurface: string,
  targetSurface: string,
  opts: { maxRetries?: number; intervalMs?: number } = {},
): Promise<SendAgentValidationResult> {
  const maxRetries = opts.maxRetries ?? 5;
  const intervalMs = opts.intervalMs ?? 200;
  let lastResult: SendAgentValidationResult = { ok: false, reason: "agent_not_found" };
  for (let i = 0; i < maxRetries; i++) {
    if (!existsSync(teamJsonPath)) {
      // team.json が未生成: agent_not_found 扱いで retry ループに乗せる
      lastResult = { ok: false, reason: "agent_not_found" };
    } else {
      try {
        const teamJson = JSON.parse(await readFile(teamJsonPath, "utf-8"));
        lastResult = validateSendAgentTarget(teamJson, callerSurface, targetSurface);
      } catch {
        lastResult = { ok: false, reason: "agent_not_found" };
      }
      if (lastResult.ok) return lastResult;
      if (lastResult.reason !== "agent_not_found") return lastResult;
    }
    if (i < maxRetries - 1) await sleep(intervalMs);
  }
  return lastResult;
}

async function cmdSendAgent(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_send_agent"));
  const targetSurface = requireArg("surface");

  // メッセージは positional 引数（複数個の場合は space で join）
  const flags = new Set(["--surface", "--no-return"]);
  const messageParts: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a === "--surface") { i++; continue; }
    if (flags.has(a)) continue;
    if (a.startsWith("--")) continue;
    messageParts.push(a);
  }
  const message = messageParts.join(" ");
  if (!message) {
    console.error("Error: <message> is required");
    process.exit(1);
  }
  const noReturn = args.includes("--no-return");

  // caller surface の解決
  let callerSurface = process.env.CMUX_SURFACE;
  if (!callerSurface) {
    try {
      callerSurface = await cmux.getCallerSurface();
    } catch {
      console.error("Error: CMUX_SURFACE が未設定で、cmux identify でも取得できません。Conductor 環境から実行してください。");
      process.exit(1);
    }
  }

  await log("send_agent_started", `caller=${callerSurface} target=${targetSurface}`);

  // team.json の存在確認
  const teamJsonPath = join(PROJECT_ROOT, ".team/team.json");
  if (!existsSync(teamJsonPath)) {
    console.error("Error: .team/team.json not found. cmux-team start を実行してください。");
    await log(
      "send_agent_rejected",
      `caller=${callerSurface} target=${targetSurface} reason=team_json_missing`,
    );
    process.exit(1);
  }

  // 自己送信は即時 reject（retry しても通らないため）
  if (callerSurface === targetSurface) {
    console.error(
      `Error: 自分自身 (${callerSurface}) には送信できません。cmux-team send-agent は自分が spawn した Agent 宛のみ使用可能です。`,
    );
    await log(
      "send_agent_rejected",
      `caller=${callerSurface} target=${targetSurface} reason=self_send`,
    );
    process.exit(1);
  }

  // team.json 反映ラグに対する retry（agent_not_found のみ）
  const result = await waitForAgentRegistered(teamJsonPath, callerSurface, targetSurface);
  if (!result.ok) {
    if (result.reason === "not_a_conductor") {
      console.error(
        `Error: caller surface ${callerSurface} は Conductor として登録されていません。`,
      );
    } else {
      console.error(
        `Error: surface ${targetSurface} はこの Conductor (${callerSurface}) が spawn した Agent ではありません。`,
      );
    }
    await log(
      "send_agent_rejected",
      `caller=${callerSurface} target=${targetSurface} reason=${result.reason}`,
    );
    process.exit(1);
  }

  // cmux 実態の validateSurface でも確認（team.json と実態のズレ対策）
  const workspace = await cmux.getCallerWorkspace();
  if (!(await cmux.validateSurface(targetSurface, workspace))) {
    console.error(`Error: surface ${targetSurface} validation failed`);
    await log(
      "send_agent_rejected",
      `caller=${callerSurface} target=${targetSurface} reason=validate_surface_failed`,
    );
    process.exit(1);
  }

  // 送信
  try {
    await cmux.send(targetSurface, message, { workspace });
    if (!noReturn) {
      await sleep(500);
      await cmux.sendKey(targetSurface, "return", { workspace });
    }
  } catch (e: any) {
    await log(
      "error",
      `send-agent failed: caller=${callerSurface} target=${targetSurface} ${e?.message ?? e} stderr=${e?.stderr ?? ""}`,
    );
    throw e;
  }

  await log(
    "send_agent_completed",
    `caller=${callerSurface} target=${targetSurface} bytes=${message.length}`,
  );
  console.log(`OK sent to ${targetSurface}`);
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
  const dependsOn = getArg("depends-on");

  if (newStatus === undefined && body === undefined && title === undefined && dependsOn === undefined) {
    console.error("Error: at least one of --status, --body, --title, or --depends-on is required");
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

  // --depends-on: frontmatter 内の depends_on 行を更新（なければ追加）
  if (dependsOn !== undefined) {
    const depsArray = dependsOn
      ? dependsOn.split(",").map(s => s.trim()).filter(Boolean)
      : [];
    const depsValue = depsArray.length > 0 ? `[${depsArray.join(", ")}]` : "[]";
    let content = await readFile(taskFile, "utf-8");
    if (content.match(/^depends_on:\s*.+$/m)) {
      // 既存の depends_on 行を更新
      content = content.replace(/^depends_on:\s*.+$/m, `depends_on: ${depsValue}`);
    } else {
      // depends_on 行がなければ、frontmatter の最後の --- 前に追加
      const fmEnd = content.indexOf("---", content.indexOf("---") + 3);
      content = content.slice(0, fmEnd) + `depends_on: ${depsValue}\n` + content.slice(fmEnd);
    }
    await writeFile(taskFile, content);
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
  if (dependsOn !== undefined) parts.push("depends_on updated");
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

  // タスク-セッション索引に記録
  try {
    const db = initDB(PROJECT_ROOT);
    insertTaskSession(db, {
      timestamp: new Date().toISOString(),
      task_id: taskId,
      task_run_id: conductor?.taskRunId,
      session_id: conductor?.sessionId ?? "",
      role: "conductor",
      surface: conductor?.surface,
      event: "closed",
    });
    db.close();
  } catch (e: any) {
    log("error", `trace DB closed insert failed: ${e?.message ?? e}`).catch(() => {});
  }

  console.log(`OK closed ${taskId}`);
}

async function cmdAwaitTask(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_await_task"));

  const taskIdRaw = requireArg("task-id");
  const timeoutSec = parseInt(getArg("timeout") ?? "3600", 10);

  // カンマ区切りで複数タスク ID をサポート
  const taskIds = taskIdRaw.split(",").map(s => s.trim()).filter(Boolean);

  if (taskIds.length === 0) {
    console.error("Error: --task-id requires at least one task ID");
    process.exit(1);
  }

  // 即座に現在の状態を確認（既に closed/aborted かもしれない）
  const initialState = await loadTaskState(PROJECT_ROOT);
  const remaining = new Set(taskIds);

  for (const id of taskIds) {
    const st = initialState[id];
    if (!st) {
      console.error(`Error: task ${id} not found in task-state.json`);
      process.exit(1);
    }
    if (st.status === "closed") {
      remaining.delete(id);
    }
    if (st.status === "aborted") {
      console.error(`Task ${id} was aborted: ${st.journal ?? "(no reason)"}`);
      process.exit(1);
    }
  }

  // 既に全部 closed ならすぐ結果を出力して終了
  if (remaining.size === 0) {
    await printSummaries(taskIds);
    process.exit(0);
  }

  // fs.watch で task-state.json を監視
  const taskStateFile = join(PROJECT_ROOT, ".team/task-state.json");
  const ac = new AbortController();

  // タイムアウトタイマー
  const timer = setTimeout(() => {
    ac.abort();
    console.error(`Timeout: ${timeoutSec}s elapsed, tasks still pending: ${[...remaining].join(",")}`);
    process.exit(2);
  }, timeoutSec * 1000);

  try {
    const watcher = watch(taskStateFile, { signal: ac.signal }, async () => {
      try {
        const state = await loadTaskState(PROJECT_ROOT);
        for (const id of [...remaining]) {
          const st = state[id];
          if (st?.status === "closed") {
            remaining.delete(id);
          }
          if (st?.status === "aborted") {
            clearTimeout(timer);
            watcher.close();
            console.error(`Task ${id} was aborted: ${st.journal ?? "(no reason)"}`);
            process.exit(1);
          }
        }
        if (remaining.size === 0) {
          clearTimeout(timer);
          watcher.close();
          await printSummaries(taskIds);
          process.exit(0);
        }
      } catch {
        // JSON パースエラーなどは無視（一時ファイル書き込み中の可能性）
      }
    });
  } catch (e: any) {
    if (e?.name === "AbortError") return;
    throw e;
  }
}

/** タスクの summary.md を探して stdout にダンプする */
async function printSummaries(taskIds: string[]): Promise<void> {
  for (const id of taskIds) {
    const taskFile = await findTaskFile(id);
    if (!taskFile) continue;

    // タスクディレクトリ形式の場合: .team/tasks/NNN-slug/runs/task-NNN-*/summary.md
    const taskDir = taskFile.endsWith("/task.md")
      ? dirname(taskFile)
      : null;

    if (taskDir) {
      const runsDir = join(taskDir, "runs");
      if (existsSync(runsDir)) {
        const runs = await readdir(runsDir);
        const sorted = runs.filter(r => r.startsWith(`task-${id}-`)).sort();
        const latestRun = sorted[sorted.length - 1];
        if (latestRun) {
          const summaryPath = join(runsDir, latestRun, "summary.md");
          if (existsSync(summaryPath)) {
            const content = await readFile(summaryPath, "utf-8");
            if (taskIds.length > 1) {
              console.log(`\n--- Task ${id} ---`);
            }
            console.log(content);
            continue;
          }
        }
      }
    }

    // summary が見つからない場合は journal を出力
    const state = await loadTaskState(PROJECT_ROOT);
    const journal = state[id]?.journal;
    if (journal) {
      if (taskIds.length > 1) {
        console.log(`\n--- Task ${id} ---`);
      }
      console.log(journal);
    } else {
      console.log(`Task ${id}: closed (no summary available)`);
    }
  }
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
    } catch (e: any) {
      await log("cleanup_failed", `abort-task worktree remove: path=${conductor.worktreePath} ${formatExecError(e)}`);
    }
    // ブランチ削除
    if (conductor.taskRunId) {
      const branch = `${conductor.taskRunId}/task`;
      try {
        const { execFile: execFileCb } = require("child_process");
        const { promisify } = require("util");
        const execFileAsync = promisify(execFileCb);
        await execFileAsync("git", ["branch", "-D", branch], { cwd: PROJECT_ROOT });
      } catch (e: any) {
        await log("cleanup_failed", `abort-task branch delete: branch=${branch} ${formatExecError(e)}`);
      }
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

  // タスク-セッション索引に記録
  try {
    const db = initDB(PROJECT_ROOT);
    insertTaskSession(db, {
      timestamp: new Date().toISOString(),
      task_id: taskId,
      task_run_id: conductor?.taskRunId,
      session_id: conductor?.sessionId ?? "",
      role: "conductor",
      surface: conductor?.surface,
      event: "aborted",
    });
    db.close();
  } catch (e: any) {
    log("error", `trace DB aborted insert failed: ${e?.message ?? e}`).catch(() => {});
  }

  // 7. CONDUCTOR_DONE メッセージ送信（daemon に通知）
  await postMessage({
    type: "CONDUCTOR_DONE",
    surface: conductor.surface,
    success: false,
    reason: "aborted",
    timestamp: new Date().toISOString(),
  });

  // 8. Conductor を再起動（session-id は cmdConductor が自己生成して daemon に通知する）
  await cmux.send(conductor.surface, `export CMUX_SURFACE=${conductor.surface} CMUX_CLAUDE_HOOKS_DISABLED=1\n`);
  await sleep(500);
  await cmux.send(conductor.surface, `cmux-team conductor\n`);

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

  // 6. Conductor を再起動（session-id は cmdConductor が自己生成して daemon に通知する）
  await cmux.send(conductor.surface, `export CMUX_SURFACE=${conductor.surface} CMUX_CLAUDE_HOOKS_DISABLED=1\n`);
  await sleep(500);
  await cmux.send(conductor.surface, `cmux-team conductor\n`);

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

async function cmdTraceTask(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_trace_task"));

  // task-id は第1引数（args[1]）から取得
  const taskId = args[1];
  if (!taskId) {
    console.error("Error: task ID is required");
    console.error("Usage: cmux-team trace-task <task-id>");
    process.exit(1);
  }

  // タスクタイトルを取得
  const { tasks, taskState } = await loadTasks(PROJECT_ROOT);
  const taskMeta = tasks.find(t => t.id === taskId);
  const title = taskMeta?.title ?? "(unknown)";

  // task-state.json から taskRunId と worktreePath を取得
  const state = taskState[taskId];
  const taskRunId = state?.taskRunId ?? "-";
  const worktreePath = state?.worktreePath;

  console.log(`Task T${taskId}: ${title}`);
  console.log(`Run: ${taskRunId}`);
  if (worktreePath) {
    const rel = worktreePath.startsWith(PROJECT_ROOT)
      ? worktreePath.slice(PROJECT_ROOT.length + 1)
      : worktreePath;
    console.log(`Worktree: ${rel}`);
  }
  console.log();

  // DB からセッション取得
  const db = initDB(PROJECT_ROOT);
  const sessions = getSessionsForTask(db, taskId);
  db.close();

  if (sessions.length === 0) {
    console.log("No sessions found.");
    return;
  }

  console.log("Sessions:");
  for (const s of sessions) {
    const role = (s.role ?? "-").padEnd(12);
    const sid = s.session_id ? s.session_id.slice(0, 8) : "--------";
    const surface = s.surface ? `surface:${s.surface.replace("surface:", "")}` : "-";

    // JSONL パス導出と行数カウント
    let jsonlPath = "-";
    let lineCount = "-";
    if (s.worktree_path && s.session_id) {
      const jsonlDir = deriveJsonlDir(s.worktree_path);
      const fullPath = join(jsonlDir, `${s.session_id}.jsonl`);
      if (existsSync(fullPath)) {
        jsonlPath = fullPath.replace(process.env.HOME ?? "~", "~");
        try {
          const content = await readFile(fullPath, "utf-8");
          const lines = content.split("\n").filter(l => l.trim()).length;
          lineCount = `${lines} lines`;
        } catch {
          lineCount = "? lines";
        }
      }
    }

    console.log(`  ${role} ${sid}  ${surface.padEnd(12)}  ${lineCount.padEnd(10)}  ${jsonlPath}`);
  }

  // --summary スタブ
  if (getArg("summary") !== undefined || args.includes("--summary")) {
    console.log("\n(summary mode is not yet implemented)");
  }
}

function deriveJsonlDir(worktreePath: string): string {
  const hash = createHash("sha256").update(worktreePath).digest("hex").slice(0, 16);
  return join(process.env.HOME ?? "~", ".claude/projects", hash);
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

  // cmux-team artifacts add <file>
  if (subCmd === "add") {
    const filePath = args[2];
    if (!filePath) {
      console.error(t("artifact_add_file_required"));
      process.exit(1);
    }
    const absPath = filePath.startsWith("/") ? filePath : join(process.cwd(), filePath);
    if (!existsSync(absPath)) {
      console.error(t("artifact_add_file_not_found", { path: filePath }));
      process.exit(1);
    }
    const tagsRaw = getArg("tags");
    const result = await addArtifact({
      projectRoot: PROJECT_ROOT,
      srcPath: absPath,
      type: getArg("type"),
      title: getArg("title"),
      task: getArg("task"),
      tags: tagsRaw ? tagsRaw.split(",").map(s => s.trim()) : undefined,
    });
    console.log(t("artifact_added", { id: result.id, path: result.destPath }));
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

  // cmux-team artifacts open <id>
  if (subCmd === "open") {
    const rawId = args[2];
    if (!rawId) {
      console.error(t("artifact_id_required_open"));
      process.exit(1);
    }
    const normalizedId = rawId.startsWith("A") ? rawId : `A${rawId.padStart(3, "0")}`;
    const artifacts = await loadArtifacts(PROJECT_ROOT);
    const found = artifacts.find((a) => a.id === normalizedId || a.id === rawId);
    if (!found) {
      console.error(t("artifact_not_found", { id: rawId }));
      process.exit(1);
    }

    const viewer = await resolveMarkdownViewer();

    const proc = Bun.spawn([viewer, found.filePath], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.exited;
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
// 単体テストから import した場合にトップレベル副作用を走らせないためのガード
if (import.meta.main) {
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
  case "send-agent":
    await cmdSendAgent();
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
  case "await-task":
    await cmdAwaitTask();
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
  case "trace-task":
    await cmdTraceTask();
    break;
  case "conductor":
    await cmdConductor();
    break;
  case "resume":
    await cmdResume();
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
}
