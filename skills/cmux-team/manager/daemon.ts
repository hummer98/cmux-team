/**
 * Daemon — メインループ + surface 管理
 */
import { readdir, readFile, writeFile, mkdir, stat, watch, rename } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { execFile } from "child_process";
import {
  checkConductorStatus,
  collectResults,
  initializeConductorSlots,
  assignTask,
  resetConductor,
  AssignTaskError,
} from "./conductor";
import { spawnMaster, isMasterAlive } from "./master";
import * as cmux from "./cmux";
import { loadTasks, loadTaskState, saveTaskState, filterExecutableTasks, filterRunAfterAllTasks, sortByPriority, sortOpenTasksForDisplay } from "./task";
import { log } from "./logger";
import type { ConductorState, QueueMessage, RateLimitInfo } from "./schema";

export interface TaskSummary {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  assignedAt?: string;
  closedAt?: string;
  abortedAt?: string;
  dependsOn: string[];
  baseBranch?: string;
  filePath?: string;  // タスクファイルのパス
}

export interface DaemonState {
  running: boolean;
  bootPhase: "infra" | "conductors" | "master" | "ready";
  masterSurface: string | null;
  masterPid: number | undefined;
  masterStatus: "idle" | "running" | "disconnected";
  masterDisconnectedAt: string | undefined;
  masterPrompt: string | undefined;
  conductors: Map<string, ConductorState>;
  projectRoot: string;
  pollInterval: number;
  maxConductors: number;
  lastUpdate: Date;
  pendingTasks: number;
  openTasks: number;
  taskList: TaskSummary[];
  sourceMtimes: Map<string, number>;
  restartRequested: boolean;
  /** 最後に npm 更新チェックした時刻（Date.now()） */
  lastNpmCheckAt: number;
  /** API レート制限情報（proxy.ts が更新） */
  rateLimit: RateLimitInfo | null;
  /** ロギングプロキシのポート番号（null = 未起動または不明） */
  proxyPort: number | null;
  /** fs.watch からの即時 tick 要求を通知する resolve 関数 */
  wakeup: (() => void) | null;
  /** tick 実行中に届いた wakeup 要求を記録するフラグ */
  wakeupPending: boolean;
  /** fs.watch の async iterator を決定論的に停止するための AbortController */
  fileWatcherAbort: AbortController | null;
  /** Master PID ウォッチャーの interval */
  masterPidWatcherInterval?: ReturnType<typeof setInterval>;
  /** proxy ポートが前回起動時から変化したか（Master 再起動トリガー） */
  proxyPortChanged: boolean;
  /** daemon が稼働しているワークスペース（他 workspace の surface との混同を防ぐ） */
  workspace: string | null;
}

/** surface または taskRunId で Conductor を検索 */
function findConductor(state: DaemonState, surface: string): ConductorState | undefined {
  const direct = state.conductors.get(surface);
  if (direct) return direct;
  // taskRunId で検索（フォールバック）
  for (const c of state.conductors.values()) {
    if (c.taskRunId === surface) return c;
  }
  return undefined;
}

export async function createDaemon(projectRoot: string): Promise<DaemonState> {
  return {
    running: true,
    bootPhase: "infra",
    masterSurface: null,
    masterPid: undefined,
    masterStatus: "disconnected",
    masterDisconnectedAt: undefined,
    masterPrompt: undefined,
    conductors: new Map(),
    projectRoot,
    pollInterval: Number(process.env.CMUX_TEAM_POLL_INTERVAL ?? 10_000),
    maxConductors: Number(process.env.CMUX_TEAM_MAX_CONDUCTORS ?? 3),
    lastUpdate: new Date(),
    pendingTasks: 0,
    openTasks: 0,
    taskList: [],
    sourceMtimes: new Map(),
    restartRequested: false,
    lastNpmCheckAt: 0,
    rateLimit: null,
    proxyPort: null,
    wakeup: null,
    wakeupPending: false,
    fileWatcherAbort: null,
    proxyPortChanged: false,
    workspace: null,
  };
}

/** manager/ ディレクトリ内の全 .ts ファイルの mtime を記録した Map を返す */
export async function initSourceWatcher(): Promise<Map<string, number>> {
  const managerDir = dirname(import.meta.path);
  const mtimes = new Map<string, number>();
  try {
    const files = await readdir(managerDir);
    for (const f of files) {
      if (!f.endsWith(".ts") && !f.endsWith(".tsx")) continue;
      const filePath = join(managerDir, f);
      const s = await stat(filePath);
      mtimes.set(filePath, s.mtimeMs);
    }
  } catch (e: any) {
    await log("error", `initSourceWatcher failed: ${e.message}`);
  }
  return mtimes;
}

/** 現在の mtime と比較し、変更があれば変更ファイル名を返す（なければ null） */
export async function checkSourceChanged(mtimeMap: Map<string, number>): Promise<string | null> {
  const managerDir = dirname(import.meta.path);
  try {
    const files = await readdir(managerDir);
    for (const f of files) {
      if (!f.endsWith(".ts") && !f.endsWith(".tsx")) continue;
      const filePath = join(managerDir, f);
      const s = await stat(filePath);
      const prev = mtimeMap.get(filePath);
      if (prev === undefined || s.mtimeMs !== prev) {
        return f;
      }
    }
  } catch (e: any) {
    await log("error", `checkSourceChanged failed: ${e.message}`);
  }
  return null;
}

/**
 * .team/tasks/ を再帰監視し、.team 直下の task-state.json も別 watcher で監視。
 * 変更検出時は 50ms debounce で requestWakeup を呼ぶ。
 * 停止は state.fileWatcherAbort 経由（AbortController で for-await を決定論的に終わらせる）。
 */
export function initFileWatcher(state: DaemonState): void {
  const ac = new AbortController();
  state.fileWatcherAbort = ac;

  // 再帰: .team/tasks/ は NNN-slug/task.md の作成まで拾う
  // 非再帰: .team 直下で task-state.json のみフィルタして拾う（.team/output/ 等の高頻度書き込みを除外）
  const targets: { dir: string; recursive: boolean }[] = [
    { dir: join(state.projectRoot, ".team/tasks"), recursive: true },
    { dir: join(state.projectRoot, ".team"), recursive: false },
  ];

  // 50ms debounce: saveTaskState の writeFile→rename 間隔は通常 5-10ms なので
  // .tmp と task-state.json のイベントは十分同一バッチに収まる。
  // 受け入れ条件 200ms 以内の内訳: debounce 50ms + tick 数十-100ms + refresh 100ms。
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (state.running) requestWakeup(state);
    }, 50);
  };

  for (const { dir, recursive } of targets) {
    if (!existsSync(dir)) continue;
    (async () => {
      // AbortSignal を渡して ac.abort() で for-await を決定論的に抜けさせる
      const watcher = watch(dir, { recursive, signal: ac.signal });
      try {
        for await (const event of watcher) {
          if (!state.running) break;
          // .team 直下の watcher は task-state.json のみトリガ対象に絞る
          if (!recursive) {
            const name = event.filename ?? "";
            if (name !== "task-state.json" && name !== "task-state.json.tmp") continue;
          }
          schedule();
        }
      } catch (e: any) {
        // AbortController で停止した場合は AbortError が投げられる。正常終了として扱う
        if (e?.name === "AbortError") return;
        log("file_watch_failed", `dir=${dir} ${e.message}`).catch(() => {});
      } finally {
        // 冪等な後処理: 既に close 済みでも問題ない
        try { (watcher as any).close?.(); } catch {}
      }
    })();
  }
}

/**
 * 即時 tick 要求を発行する統一 API。
 * tick 実行中（sleep 未突入）でも wakeupPending に記録されるので取りこぼさない。
 * sleep 中なら state.wakeup?.() が resolve を呼び即座に起床する。
 */
export function requestWakeup(state: DaemonState): void {
  state.wakeupPending = true;
  state.wakeup?.();
}

/** pollInterval まで待つが、wakeup が呼ばれたら即座に返る */
export function sleepUntilWakeup(state: DaemonState): Promise<void> {
  return new Promise((resolve) => {
    // tick 中に requestWakeup で立ったフラグをここで消化する
    if (state.wakeupPending) {
      state.wakeupPending = false;
      // 不変条件「sleep 関数完了時点で state.wakeup は常に null」を維持
      state.wakeup = null;
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      state.wakeup = null;
      state.wakeupPending = false;
      resolve();
    }, state.pollInterval);
    state.wakeup = () => {
      clearTimeout(timer);
      state.wakeup = null;
      state.wakeupPending = false;
      resolve();
    };
  });
}

export async function initInfra(state: DaemonState): Promise<void> {
  await log("infra_init");
  const root = state.projectRoot;
  await mkdir(join(root, ".team/tasks"), { recursive: true });
  await mkdir(join(root, ".team/output"), { recursive: true });
  await mkdir(join(root, ".team/prompts"), { recursive: true });
  await mkdir(join(root, ".team/logs"), { recursive: true });

  // .gitignore
  const gitignore = join(root, ".team/.gitignore");
  if (!existsSync(gitignore)) {
    await writeFile(
      gitignore,
      "output/\nprompts/\ndocs-snapshot/\nlogs/\nqueue/\nconductors/\nmaster.surface\ntask-state.json\ntasks/*.status.json\n"
    );
  } else {
    // 既存 .gitignore に tasks/*.status.json がなければ追記
    const content = await readFile(gitignore, "utf-8");
    if (!content.includes("tasks/*.status.json")) {
      await writeFile(gitignore, content.trimEnd() + "\ntasks/*.status.json\n");
    }
  }

  // config.json（デフォルト生成）
  const configJson = join(root, ".team/config.json");
  if (!existsSync(configJson)) {
    await writeFile(
      configJson,
      JSON.stringify(
        {
          models: {
            master: "opus",
            conductor: "opus",
            agent: "opus",
          },
        },
        null,
        2
      ) + "\n"
    );
  }

  // team.json
  const teamJson = join(root, ".team/team.json");
  if (!existsSync(teamJson)) {
    await writeFile(
      teamJson,
      JSON.stringify(
        {
          project: "",
          phase: "init",
          architecture: "4-tier",
          master: {},
          manager: {},
          conductors: [],
        },
        null,
        2
      ) + "\n"
    );
  }
}

export async function startMaster(state: DaemonState, daemonSurface?: string): Promise<void> {
  // マーカーファイルから既存 Master を検出
  const markerPath = join(state.projectRoot, ".team/master.surface");
  try {
    if (existsSync(markerPath)) {
      const surface = (await readFile(markerPath, "utf-8")).trim();
      if (surface) {
        const alive = await isMasterAlive(surface, state.workspace ?? undefined);
        if (alive) {
          // proxy ポート変化時: 旧 Master を close して再 spawn
          if (state.proxyPortChanged) {
            await log("master_respawn_proxy_changed", `surface=${surface} newPort=${state.proxyPort}`);
            await cmux.closeSurface(surface).catch(() => {});
            state.proxyPortChanged = false;  // フラグリセット
            // fall-through して下の spawn コードへ
          } else {
            state.masterSurface = surface;
            state.masterStatus = "idle";
            await log("master_alive", `surface=${surface}`);
            return;
          }
        }
        await log("master_check_failed", `surface=${surface} alive=false`);
      }
    }
  } catch (e: any) {
    await log("master_check_error", e.message);
  }

  // Master spawn
  await log("master_spawning");
  const master = await spawnMaster(state.projectRoot, daemonSurface);
  if (master) {
    state.masterSurface = master.surface;
    state.masterStatus = "idle";
    await log("master_started", `surface=${master.surface}`);
  } else {
    await log("master_spawn_failed");
  }
}

export async function initializeLayout(state: DaemonState, daemonSurface?: string): Promise<void> {
  // team.json から既存 Conductor を復元
  const teamJsonPath = join(state.projectRoot, ".team/team.json");
  try {
    if (existsSync(teamJsonPath)) {
      const teamJson = JSON.parse(await readFile(teamJsonPath, "utf-8"));
      const conductors: any[] = teamJson.conductors ?? [];

      if (conductors.length > 0) {
        const alive: ConductorState[] = [];
        for (const c of conductors) {
          if (!c.surface) continue;
          if (await cmux.validateSurface(c.surface, state.workspace ?? undefined)) {
            alive.push({
              surface: c.surface,
              taskRunId: c.taskRunId,
              taskId: c.taskId,
              taskTitle: c.taskTitle,
              worktreePath: c.worktreePath,
              outputDir: c.outputDir,
              startedAt: c.startedAt ?? new Date().toISOString(),
              paneId: c.paneId,
              agents: (c.agents ?? []).map((a: any) => ({
                surface: a.surface,
                role: a.role,
                sessionId: a.sessionId,
                spawnedAt: a.spawnedAt ?? new Date().toISOString(),
              })),
              // starting は復元しない（再起動時はセッション状態が不明なため idle として扱う）
              status: c.status === "running" ? "running" : c.status === "disconnected" ? "disconnected" : "idle",
            });
          }
        }

        if (alive.length > 0) {
          state.conductors.clear();
          for (const c of alive) {
            state.conductors.set(c.surface, c);
          }
          await log("conductors_restored", `count=${alive.length} surfaces=${alive.map(c => c.surface).join(",")}`);
          return;
        }
      }
    }
  } catch (e: any) {
    await log("error", `initializeLayout team.json restore failed: ${e.message}`);
  }

  // 既存なし → 新規作成
  await log("layout_creating_new_slots", `count=${state.maxConductors}`);
  await initializeConductorSlots(state.projectRoot, state.conductors, state.maxConductors, daemonSurface);
  // 状態登録は CONDUCTOR_REGISTERED メッセージハンドラ（+ フォールバック）で完了済み
}

/** proxy ポートに TCP 接続して生存確認 */
async function isProxyAlive(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const net = require("net");
    const sock = net.connect({ port, host: "127.0.0.1", timeout: 500 }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on("error", () => resolve(false));
    sock.on("timeout", () => { sock.destroy(); resolve(false); });
  });
}

export async function tick(state: DaemonState): Promise<void> {
  state.lastUpdate = new Date();
  await scanTasks(state);
  await monitorConductors(state);

  // proxy 死活チェック（死んでいたらログに記録）
  if (state.proxyPort) {
    const alive = await isProxyAlive(state.proxyPort);
    if (!alive) {
      await log("proxy_dead", `port=${state.proxyPort} — Master/Conductor がAPIに接続できない状態`);
    }
  }

  // ソースファイルの mtime 変更を検出
  if (state.sourceMtimes.size > 0) {
    const changedFile = await checkSourceChanged(state.sourceMtimes);
    if (changedFile) {
      await log("source_changed", `file=${changedFile}`);
      state.running = false;
      state.restartRequested = true;
    }
  }
}

export async function handleMessage(state: DaemonState, message: QueueMessage): Promise<void> {
  switch (message.type) {
    case "TASK_CREATED": {
      let title = "";
      if (message.taskFile && existsSync(message.taskFile)) {
        try {
          const content = await readFile(message.taskFile, "utf-8");
          title = content.match(/^title:\s*(.+)$/m)?.[1]?.trim() ?? "";
        } catch (e: any) {
          await log("error", `handleMessage TASK_CREATED readFile failed: taskFile=${message.taskFile} ${e.message}`);
        }
      }
      await log("task_received", `task_id=${message.taskId}${title ? ` title=${title}` : ""}`);
      // wakeup で即時 tick を発火
      requestWakeup(state);
      break;
    }

    case "CONDUCTOR_DONE": {
      const conductor = findConductor(state, message.surface);
      if (!conductor) {
        await log(
          "conductor_done_ignored",
          `surface=${message.surface} reason=not_found`
        );
        break;
      }
      // running 以外でも taskRunId が残っていれば late cleanup を実行する
      // (crashed → disconnected 誤検出からの救済パス)
      if (conductor.status !== "running" && !conductor.taskRunId) {
        await log(
          "conductor_done_ignored",
          `surface=${message.surface} status=${conductor.status} reason=no_task`
        );
        break;
      }
      if (conductor.status !== "running") {
        await log(
          "conductor_done_late_cleanup",
          `surface=${message.surface} status=${conductor.status} taskRunId=${conductor.taskRunId}`
        );
      }
      const isSuccess = message.success !== false;
      await log(
        isSuccess ? "conductor_done_signal" : "conductor_error",
        `surface=${message.surface}${!isSuccess && message.reason ? ` reason=${message.reason}` : ""}${message.exitCode != null ? ` exit_code=${message.exitCode}` : ""}`
      );
      await handleConductorDone(state, conductor);
      break;
    }

    case "AGENT_SPAWNED": {
      const conductor = findConductor(state, message.conductorSurface);
      if (conductor) {
        conductor.agents.push({
          surface: message.surface,
          role: message.role,
          taskTitle: message.taskTitle,
          spawnedAt: message.timestamp,
        });
        await log(
          "agent_spawned",
          `conductor_surface=${message.conductorSurface} surface=${message.surface}${message.role ? ` role=${message.role}` : ""}`
        );
      }
      break;
    }

    case "SESSION_STARTED": {
      // Master surface チェック
      if (message.surface === state.masterSurface) {
        state.masterPid = message.pid;
        state.masterStatus = "idle";
        state.masterDisconnectedAt = undefined;
        spawnMasterPidWatcher(state, message.pid);
        await log("master_session_started", `surface=${message.surface} pid=${message.pid}`);
        break;
      }
      const conductor = findConductor(state, message.surface);
      if (conductor) {
        // starting / disconnected → idle に復帰
        if (conductor.status === "starting" || conductor.status === "disconnected") {
          const prevStatus = conductor.status;
          conductor.status = "idle";
          await log(
            prevStatus === "starting" ? "conductor_ready" : "conductor_recovered",
            `surface=${message.surface}`
          );
        }
        conductor.pid = message.pid;
        if (message.sessionId) conductor.sessionId = message.sessionId;
        conductor.disconnectedAt = undefined;
        spawnPidWatcher(state, conductor, message.pid);
        await log(
          "session_started",
          `surface=${message.surface} pid=${message.pid}`
        );
      } else {
        await log("session_started_ignored", `surface=${message.surface} reason=conductor_not_found`);
      }
      break;
    }

    case "CONDUCTOR_REGISTERED": {
      state.conductors.set(message.surface, {
        surface: message.surface,
        paneId: message.paneId,
        status: "starting",
        startedAt: message.timestamp,
        agents: [],
      });
      await log("conductor_registered", `surface=${message.surface} pane=${message.paneId}`);
      break;
    }

    case "SESSION_ENDED": {
      // Master surface チェック
      if (message.surface === state.masterSurface) {
        state.masterStatus = "disconnected";
        state.masterDisconnectedAt = message.timestamp;
        state.masterPid = undefined;
        await log("master_session_ended", `surface=${message.surface}${message.reason ? ` reason=${message.reason}` : ""}`);
        break;
      }
      const conductor = findConductor(state, message.surface);
      if (conductor) {
        // surface が一致しない場合は旧セッションからの stale イベント → 無視
        if (message.surface !== conductor.surface) {
          await log(
            "session_ended_ignored",
            `event_surface=${message.surface} current_surface=${conductor.surface}`
          );
          break;
        }
        conductor.status = "disconnected";
        conductor.disconnectedAt = message.timestamp;
        conductor.pid = undefined;
        conductor.sessionId = undefined;
        await log(
          "session_ended",
          `surface=${message.surface} status=disconnected${message.reason ? ` reason=${message.reason}` : ""}`
        );
      } else {
        // Agent surface かチェック
        for (const c of state.conductors.values()) {
          const idx = c.agents.findIndex(a => a.surface === message.surface);
          if (idx !== -1) {
            c.agents.splice(idx, 1);
            await log(
              "agent_done",
              `conductor_surface=${c.surface} surface=${message.surface} trigger=session_ended`
            );
            break;
          }
        }
      }
      break;
    }

    case "SESSION_ACTIVE": {
      // Master surface チェック
      if (message.surface === state.masterSurface) {
        state.masterStatus = "running";
        state.masterDisconnectedAt = undefined;
        if (message.pid) state.masterPid = message.pid;
        await log("master_session_active", `surface=${message.surface}`);
        break;
      }
      const conductor = findConductor(state, message.surface);
      if (conductor) {
        conductor.disconnectedAt = undefined;
        if (message.pid) conductor.pid = message.pid;
        if (conductor.status === "disconnected") {
          conductor.status = "running";
          await log("conductor_recovered", `surface=${message.surface} via=SESSION_ACTIVE new_status=running`);
        } else if (conductor.status === "starting") {
          conductor.status = "idle";
          await log("conductor_ready", `surface=${message.surface} via=SESSION_ACTIVE`);
        }
      }
      break;
    }

    case "SESSION_IDLE": {
      // Master surface チェック
      if (message.surface === state.masterSurface) {
        state.masterStatus = "idle";
        state.masterDisconnectedAt = undefined;
        if (message.pid) state.masterPid = message.pid;
        await log("master_session_idle", `surface=${message.surface}`);
        break;
      }
      const conductor = findConductor(state, message.surface);
      if (conductor) {
        conductor.disconnectedAt = undefined;  // alive の証拠 (Stop hook からのシグナル)
        if (message.pid) conductor.pid = message.pid;
        if (conductor.status === "disconnected") {
          if (conductor.taskRunId) {
            // タスク実行中だった Conductor が復活 → running に戻すだけ。
            // cleanup は C-1 (CONDUCTOR_DONE) か C-2 (disconnect_timeout) が担う。
            // ここで resetConductor を呼ぶと、生存中の Conductor の worktree を誤削除する
            // (Stop hook はターン境界ごとに発火するため、タスク実行中でも SESSION_IDLE は来る)
            conductor.status = "running";
            await log(
              "conductor_recovered",
              `surface=${message.surface} via=SESSION_IDLE new_status=running taskRunId=${conductor.taskRunId}`
            );
          } else {
            // taskRunId なし → 通常復帰 (idle)
            conductor.status = "idle";
            await log("conductor_recovered", `surface=${message.surface} via=SESSION_IDLE`);
          }
        } else if (conductor.status === "starting") {
          conductor.status = "idle";
          await log("conductor_ready", `surface=${message.surface} via=SESSION_IDLE`);
        }
        await log(
          "session_idle",
          `surface=${message.surface}`
        );
      }
      break;
    }

    case "SESSION_CLEAR": {
      const conductor = findConductor(state, message.surface);
      if (conductor && (conductor.status === "disconnected" || conductor.status === "starting")) {
        const event = conductor.status === "starting" ? "conductor_ready" : "conductor_recovered";
        conductor.status = "idle";
        conductor.disconnectedAt = undefined;
        if (message.pid) conductor.pid = message.pid;
        await log(event, `surface=${message.surface} via=SESSION_CLEAR`);
      }
      // idle/running 時は何もしない（TUI チラつき防止）
      break;
    }

    case "SHUTDOWN":
      await log("shutdown_requested");
      state.running = false;
      break;
  }
}

export async function scanTasks(state: DaemonState): Promise<void> {
  const { tasks, taskState } = await loadTasks(state.projectRoot);

  const closed = new Set(
    Object.entries(taskState)
      .filter(([_, s]) => s.status === "closed" || s.status === "aborted" || s.status === "deleted")
      .map(([id]) => id)
  );

  const openTasksList = tasks.filter(t => t.status !== "closed" && t.status !== "aborted" && t.status !== "deleted");
  state.openTasks = openTasksList.length;

  const assignedIds = new Set(
    [...state.conductors.values()].map((c) => c.taskId).filter((id): id is string => !!id)
  );

  const executable = sortByPriority(
    filterExecutableTasks(openTasksList, closed, assignedIds)
  );

  // run_after_all タスクの判定
  const runAfterAllExecutable = sortByPriority(
    filterRunAfterAllTasks(openTasksList, closed, assignedIds)
  );

  // 両方を結合（通常タスク優先）
  const allExecutable = [...executable, ...runAfterAllExecutable];
  state.pendingTasks = allExecutable.length;

  // taskList: open を優先表示、残り枠で closed（直近）を表示
  const openTasks = sortOpenTasksForDisplay(openTasksList);
  const closedMetas = tasks.filter(t => t.status === "closed" || t.status === "aborted");
  const closedTasks = [...closedMetas]
    .sort((a, b) => (taskState[b.id]?.closedAt ?? taskState[b.id]?.abortedAt ?? "").localeCompare(taskState[a.id]?.closedAt ?? taskState[a.id]?.abortedAt ?? ""));
  const MAX_CLOSED_DISPLAY = 20;
  const combined = [...openTasks, ...closedTasks.slice(0, MAX_CLOSED_DISPLAY)];
  state.taskList = combined.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    createdAt: t.createdAt,
    assignedAt: taskState[t.id]?.assignedAt,
    closedAt: taskState[t.id]?.closedAt,
    abortedAt: taskState[t.id]?.abortedAt,
    dependsOn: t.dependsOn.filter(dep => !closed.has(dep)),
    baseBranch: t.baseBranch,
    filePath: t.filePath,
  }));

  for (const task of allExecutable) {
    // idle Conductor を探す
    const idleConductor = [...state.conductors.values()].find(c => c.status === "idle");
    if (!idleConductor) {
      await log("throttled", `task_id=${task.id} no_idle_conductor`);
      break;
    }

    // spawn 前にロック（次の tick での二重起動を防止）
    assignedIds.add(task.id);

    let updated: ConductorState;
    try {
      updated = await assignTask(idleConductor, task.id, state.projectRoot);
    } catch (e: unknown) {
      if (e instanceof AssignTaskError) {
        if (e.kind === "task") {
          // タスク側の問題 → 該当タスクを abort し Conductor は idle のまま維持
          const ts = await loadTaskState(state.projectRoot);
          ts[task.id] = {
            ...ts[task.id],
            status: "aborted",
            abortedAt: new Date().toISOString(),
            journal: `assign_failed: ${e.reason}`,
          };
          await saveTaskState(state.projectRoot, ts);
          await log(
            "task_aborted",
            `task_id=${task.id} title=${task.title} journal_summary=assign_failed: ${e.reason}`
          );
          // 次のタスクへ。idle Conductor はそのまま維持
          continue;
        }
        // e.kind === "conductor" → 従来通り disconnected
        idleConductor.status = "disconnected";
        idleConductor.disconnectedAt = new Date().toISOString();
        await log(
          "conductor_disconnected",
          `surface=${idleConductor.surface} reason=assign_failed kind=conductor task_id=${task.id} detail=${e.reason}`
        );
        continue;
      }
      // AssignTaskError 以外の想定外例外（defensive: conductor.ts の catch-all が
      // すべてを AssignTaskError にラップしているためデッドコードに近いが、
      // 将来の変更に備えて最悪ケースとして conductor を落とす）
      await log("error", `assignTask unexpected: task_id=${task.id} ${(e as Error).message}`);
      idleConductor.status = "disconnected";
      idleConductor.disconnectedAt = new Date().toISOString();
      continue;
    }

    state.conductors.set(updated.surface, updated);
    // task-state.json に assigned + assignedAt を記録
    const ts = await loadTaskState(state.projectRoot);
    ts[task.id] = {
      ...ts[task.id],
      status: 'assigned',
      assignedAt: new Date().toISOString(),
    };
    await saveTaskState(state.projectRoot, ts);
  }
}

/** PID ウォッチャー: 指定 PID の終了を検出して disconnected にする */
function spawnPidWatcher(
  state: DaemonState,
  conductor: ConductorState,
  pid: number
): void {
  if (conductor.pidWatcherInterval) {
    clearInterval(conductor.pidWatcherInterval);
  }
  const checkInterval = setInterval(async () => {
    if (!state.running) {
      clearInterval(checkInterval);
      conductor.pidWatcherInterval = undefined;
      return;
    }
    try {
      process.kill(pid, 0);
    } catch {
      clearInterval(checkInterval);
      conductor.pidWatcherInterval = undefined;
      if (conductor.pid === pid) {
        conductor.status = "disconnected";
        conductor.disconnectedAt = new Date().toISOString();
        conductor.pid = undefined;
        conductor.sessionId = undefined;
        await log(
          "session_ended",
          `surface=${conductor.surface} pid=${pid} status=disconnected reason=pid_watcher`
        );
      }
    }
  }, 1000);
  conductor.pidWatcherInterval = checkInterval;
}

function spawnMasterPidWatcher(state: DaemonState, pid: number): void {
  if (state.masterPidWatcherInterval) {
    clearInterval(state.masterPidWatcherInterval);
  }
  const checkInterval = setInterval(async () => {
    if (!state.running) {
      clearInterval(checkInterval);
      state.masterPidWatcherInterval = undefined;
      return;
    }
    try {
      process.kill(pid, 0);
    } catch {
      clearInterval(checkInterval);
      state.masterPidWatcherInterval = undefined;
      if (state.masterPid === pid) {
        state.masterStatus = "disconnected";
        state.masterDisconnectedAt = new Date().toISOString();
        state.masterPid = undefined;
        await log(
          "master_session_ended",
          `surface=${state.masterSurface} pid=${pid} reason=pid_watcher`
        );
      }
    }
  }, 1000);
  state.masterPidWatcherInterval = checkInterval;
}

/** starting 状態のタイムアウト（秒） */
const STARTING_TIMEOUT_SEC = 60;
/** disconnected 状態のタイムアウト（秒） — 超過で forced cleanup */
const DISCONNECT_TIMEOUT_SEC =
  Number(process.env.CMUX_TEAM_DISCONNECT_TIMEOUT_SEC) || 300;  // 5 分

export async function monitorConductors(state: DaemonState): Promise<void> {
  // tick 冒頭で tree() を 1 回だけ呼び、結果をキャッシュする (Major 1)
  //   成功時: surface 判定は treeOutput.includes(surface) で行う
  //   失敗時: リトライ付き validateSurface にフォールバック
  let treeOutput: string | null = null;
  try {
    treeOutput = await cmux.tree(state.workspace ?? undefined);
  } catch (e: any) {
    await log("monitor_tree_failed", `last_error=${e.message}`);
    treeOutput = null;
  }

  const surfaceAlive = async (surface: string): Promise<boolean> => {
    if (treeOutput !== null) return treeOutput.includes(surface);
    return cmux.validateSurface(surface, state.workspace ?? undefined);
  };

  for (const [surface, conductor] of state.conductors) {
    // starting: タイムアウトチェックのみ
    if (conductor.status === "starting") {
      const elapsed = (Date.now() - new Date(conductor.startedAt).getTime()) / 1000;
      if (elapsed > STARTING_TIMEOUT_SEC) {
        conductor.status = "disconnected";
        conductor.disconnectedAt = new Date().toISOString();
        await log(
          "conductor_start_timeout",
          `surface=${surface} elapsed=${Math.round(elapsed)}s`
        );
      }
      continue;
    }

    // disconnected: timeout チェック → forced cleanup。継続チェックはしない
    if (conductor.status === "disconnected") {
      if (conductor.disconnectedAt) {
        const elapsed = (Date.now() - new Date(conductor.disconnectedAt).getTime()) / 1000;
        if (elapsed > DISCONNECT_TIMEOUT_SEC) {
          await log(
            "conductor_disconnect_timeout",
            `surface=${surface} elapsed=${Math.round(elapsed)}s taskRunId=${conductor.taskRunId ?? "-"}`
          );
          await forceCloseDisconnectedConductor(state, conductor);
        }
      }
      continue;
    }

    // idle: 何もしない
    if (conductor.status === "idle") continue;

    // running: Conductor surface の生存確認
    const alive = await surfaceAlive(conductor.surface);
    if (!alive) {
      await log(
        "conductor_disconnected",
        `surface=${surface} reason=validate_surface_failed kind=crashed taskRunId=${conductor.taskRunId ?? "-"}`
      );
      conductor.status = "disconnected";
      conductor.disconnectedAt = new Date().toISOString();
      // taskRunId / taskTitle / worktreePath / outputDir / agents は意図的に保持
      // 復活時 (SESSION_ACTIVE/IDLE) または timeout 時 (C-2) に cleanup 判断
      continue;
    }

    // Agent surface の生存チェック — tree キャッシュを使う (Major 1)
    for (let i = conductor.agents.length - 1; i >= 0; i--) {
      const agent = conductor.agents[i]!;
      if (!(await surfaceAlive(agent.surface))) {
        conductor.agents.splice(i, 1);
        await log(
          "agent_done",
          `conductor_surface=${surface} surface=${agent.surface} trigger=surface_lost`
        );
      }
    }
  }
}

/**
 * disconnected timeout で Conductor の強制クローズ + タスク abort を行う。
 * CLAUDE.md「異常検知時のリカバリーは人間に委ねる」に従い、reopen はしない。
 */
async function forceCloseDisconnectedConductor(
  state: DaemonState,
  conductor: ConductorState
): Promise<void> {
  const taskId = conductor.taskId;
  const taskRunId = conductor.taskRunId;

  // 1. task-state.json に aborted を記録
  if (taskId) {
    try {
      const ts = await loadTaskState(state.projectRoot);
      const current = ts[taskId];
      // 既に closed/aborted/deleted 済みならスキップ（冪等）
      if (
        current?.status !== "closed" &&
        current?.status !== "aborted" &&
        current?.status !== "deleted"
      ) {
        const journal = `disconnect_timeout: surface=${conductor.surface} taskRunId=${taskRunId ?? "-"} disconnectedAt=${conductor.disconnectedAt}`;
        ts[taskId] = {
          ...current,
          status: "aborted",
          abortedAt: new Date().toISOString(),
          journal,
        };
        await saveTaskState(state.projectRoot, ts);
        await log(
          "task_aborted",
          `task_id=${taskId} reason=disconnect_timeout journal_summary=${journal}`
        );
      }
    } catch (e: any) {
      await log(
        "error",
        `forceCloseDisconnectedConductor task-state update failed: task_id=${taskId} ${e.message}`
      );
    }
  }

  // 2. pidWatcherInterval をクリア (Minor 4)
  if (conductor.pidWatcherInterval) {
    clearInterval(conductor.pidWatcherInterval);
    conductor.pidWatcherInterval = undefined;
  }

  // 3. resetConductor で worktree/branch/タブ名をクリーンアップ
  await resetConductor(conductor, state.projectRoot);
}

async function handleConductorDone(
  state: DaemonState,
  conductor: ConductorState
): Promise<void> {
  const { journalSummary } = await collectResults(conductor, state.projectRoot);

  if (!conductor.taskId || conductor.taskId === "undefined") {
    await log(
      "error",
      `handleConductorDone: conductor.taskId is undefined surface=${conductor.surface}`
    );
  } else {
    await log(
      "task_completed",
      `task_id=${conductor.taskId} surface=${conductor.surface}${
        conductor.taskTitle ? ` title=${conductor.taskTitle}` : ""
      }${journalSummary ? ` journal_summary=${journalSummary}` : ""}`
    );
  }

  // Conductor をリセットして idle に戻す
  await resetConductor(conductor, state.projectRoot);
}

/** semver 大小比較: a > b なら true */
function isNewerVersion(latest: string, current: string): boolean {
  const l = latest.split(".").map(Number);
  const c = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((l[i] ?? 0) > (c[i] ?? 0)) return true;
    if ((l[i] ?? 0) < (c[i] ?? 0)) return false;
  }
  return false;
}

/** npm registry から最新バージョンを確認し、新バージョンがあれば自動インストール + 再起動フラグをセット */
export async function checkNpmUpdate(state: DaemonState): Promise<void> {
  try {
    // 現在バージョンを package.json から取得
    const pkgPath = join(dirname(import.meta.path), "../../../package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf-8"));
    const currentVersion: string = pkg.version;

    // npm registry の最新バージョンを確認
    const latestVersion = await new Promise<string>((resolve, reject) => {
      execFile("npm", ["view", "@hummer98/cmux-team", "version"], { timeout: 30_000 }, (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout.trim());
      });
    });

    // バージョンが異なれば更新
    if (isNewerVersion(latestVersion, currentVersion)) {
      await log("npm_auto_update", `current=${currentVersion} latest=${latestVersion} installing...`);

      await new Promise<void>((resolve, reject) => {
        execFile("npm", ["install", "-g", "@hummer98/cmux-team@latest"], { timeout: 120_000 }, (err) => {
          if (err) return reject(err);
          resolve();
        });
      });

      await log("npm_auto_update", `updated ${currentVersion} → ${latestVersion}`);
      state.running = false;
      state.restartRequested = true;
    }
  } catch (e: any) {
    await log("npm_update_check_failed", e.message);
  }
}

export async function updateTeamJson(state: DaemonState): Promise<void> {
  const teamJsonPath = join(state.projectRoot, ".team/team.json");
  try {
    const teamJson = JSON.parse(await readFile(teamJsonPath, "utf-8"));
    // master surface が null の場合は既存値を保持（reload 時に消さない）
    if (state.masterSurface) {
      teamJson.master = {
        surface: state.masterSurface,
        status: state.masterStatus,
        pid: state.masterPid,
      };
    }
    teamJson.manager = {
      pid: process.pid,
      type: "typescript",
      status: state.running ? "running" : "stopped",
    };
    teamJson.phase = "running";
    teamJson.conductors = [...state.conductors.values()].map((c) => ({
      surface: c.surface,
      taskRunId: c.taskRunId,
      taskId: c.taskId,
      taskTitle: c.taskTitle,
      status: c.status,
      worktreePath: c.worktreePath,
      outputDir: c.outputDir,
      startedAt: c.startedAt,
      paneId: c.paneId,
      agents: c.agents.map((a) => ({
        surface: a.surface,
        role: a.role,
        sessionId: a.sessionId,
      })),
    }));
    // アトミック書き込み: tmp → rename で中途半端な書き込みを防止
    const tmpPath = teamJsonPath + ".tmp";
    await writeFile(tmpPath, JSON.stringify(teamJson, null, 2) + "\n");
    await rename(tmpPath, teamJsonPath);
  } catch (e: any) {
    await log("error", `updateTeamJson failed: ${e.message}`);
  }
}
