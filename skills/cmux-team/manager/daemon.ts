/**
 * Daemon — メインループ + surface 管理
 */
import { readdir, readFile, writeFile, mkdir, stat, watch, rename } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { execFile } from "child_process";
import {
  spawnConductor,
  checkConductorStatus,
  collectResults,
  initializeConductorSlots,
  assignTask,
  resetConductor,
} from "./conductor";
import { spawnMaster, isMasterAlive } from "./master";
import * as cmux from "./cmux";
import { loadTasks, filterExecutableTasks, filterRunAfterAllTasks, sortByPriority } from "./task";
import { log } from "./logger";
import type { ConductorState, QueueMessage } from "./schema";

export interface TaskSummary {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  closedAt?: string;
  abortedAt?: string;
  dependsOn: string[];
}

export interface DaemonState {
  running: boolean;
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
  /** fs.watch からの即時 tick 要求を通知する resolve 関数 */
  wakeup: (() => void) | null;
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
    wakeup: null,
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

/** .team/tasks/ を fs.watch で監視し、変更時に wakeup を呼ぶ */
export function initFileWatcher(state: DaemonState): void {
  const dirs = [
    join(state.projectRoot, ".team/tasks"),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    (async () => {
      try {
        const watcher = watch(dir);
        for await (const _event of watcher) {
          if (!state.running) break;
          state.wakeup?.();
        }
      } catch (e: any) {
        // ウォッチャーが壊れても daemon は停止しない（ポーリングで補完）
        log("error", `file watcher failed: dir=${dir} ${e.message}`);
      }
    })();
  }
}

/** pollInterval まで待つが、wakeup が呼ばれたら即座に返る */
export function sleepUntilWakeup(state: DaemonState): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      state.wakeup = null;
      resolve();
    }, state.pollInterval);
    state.wakeup = () => {
      clearTimeout(timer);
      state.wakeup = null;
      resolve();
    };
  });
}

export async function initInfra(state: DaemonState): Promise<void> {
  console.log("⏳ インフラ準備中...");
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
        const alive = await isMasterAlive(surface);
        if (alive) {
          state.masterSurface = surface;
          state.masterStatus = "idle";
          console.log("✅ Master: 既存セッション検出 (スキップ)");
          await log("master_alive", `surface=${surface}`);
          return;
        }
        await log("master_check_failed", `surface=${surface} alive=false`);
      }
    }
  } catch (e: any) {
    await log("master_check_error", e.message);
  }

  // Master spawn
  console.log("⏳ Master 起動中...");
  const master = await spawnMaster(state.projectRoot, daemonSurface);
  if (master) {
    state.masterSurface = master.surface;
    state.masterStatus = "idle";
    console.log(`✅ Master 起動完了 (${master.surface})`);
  } else {
    console.log("❌ Master 起動失敗");
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
          if (await cmux.validateSurface(c.surface)) {
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
          console.log(`✅ Conductor スロット: team.json から ${alive.length}個 を復元`);
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
  const slots = await initializeConductorSlots(state.projectRoot, state.maxConductors, daemonSurface);
  for (const slot of slots) {
    state.conductors.set(slot.surface, slot);
  }
}

export async function tick(state: DaemonState): Promise<void> {
  state.lastUpdate = new Date();
  await scanTasks(state);
  await monitorConductors(state);

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
      state.wakeup?.();
      break;
    }

    case "CONDUCTOR_DONE": {
      const isSuccess = message.success !== false;
      await log(
        isSuccess ? "conductor_done_signal" : "conductor_error",
        `surface=${message.surface}${!isSuccess && message.reason ? ` reason=${message.reason}` : ""}${message.exitCode != null ? ` exit_code=${message.exitCode}` : ""}`
      );
      const conductor = findConductor(state, message.surface);
      if (conductor) {
        await handleConductorDone(state, conductor);
      }
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
        conductor.disconnectedAt = undefined;  // alive の証拠
        if (message.pid) conductor.pid = message.pid;
        if (conductor.status === "disconnected") {
          conductor.status = "idle";
          await log("conductor_recovered", `surface=${message.surface} via=SESSION_IDLE new_status=idle`);
        }
        await log(
          "session_idle",
          `surface=${message.surface}`
        );
      }
      break;
    }

    case "SHUTDOWN":
      await log("shutdown_requested");
      state.running = false;
      break;
  }
}

async function scanTasks(state: DaemonState): Promise<void> {
  const { tasks, taskState } = await loadTasks(state.projectRoot);

  const closed = new Set(
    Object.entries(taskState)
      .filter(([_, s]) => s.status === "closed" || s.status === "aborted")
      .map(([id]) => id)
  );

  const openTasksList = tasks.filter(t => t.status !== "closed" && t.status !== "aborted");
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
  const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const openTasks = [...openTasksList]
    .sort((a, b) => (priorityOrder[a.priority] ?? 1) - (priorityOrder[b.priority] ?? 1));
  const closedMetas = tasks.filter(t => t.status === "closed" || t.status === "aborted");
  const closedTasks = [...closedMetas]
    .sort((a, b) => (taskState[b.id]?.closedAt ?? taskState[b.id]?.abortedAt ?? "").localeCompare(taskState[a.id]?.closedAt ?? taskState[a.id]?.abortedAt ?? ""));
  const maxItems = Math.max(5, openTasks.length);
  const combined = [...openTasks, ...closedTasks.slice(0, maxItems - openTasks.length)];
  state.taskList = combined.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    createdAt: t.createdAt,
    closedAt: taskState[t.id]?.closedAt,
    abortedAt: taskState[t.id]?.abortedAt,
    dependsOn: t.dependsOn.filter(dep => !closed.has(dep)),
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

    const updated = await assignTask(idleConductor, task.id, state.projectRoot);
    if (updated) {
      state.conductors.set(updated.surface, updated);
    } else {
      // assignTask 失敗 → conductor を disconnected にして再選択を防ぐ
      idleConductor.status = "disconnected";
      idleConductor.disconnectedAt = new Date().toISOString();
      await log(
        "conductor_disconnected",
        `surface=${idleConductor.surface} reason=assign_failed task_id=${task.id}`
      );
    }
  }
}

/** PID ウォッチャー: 指定 PID の終了を検出して disconnected にする */
function spawnPidWatcher(
  state: DaemonState,
  conductor: ConductorState,
  pid: number
): void {
  const checkInterval = setInterval(async () => {
    if (!state.running) {
      clearInterval(checkInterval);
      return;
    }
    try {
      process.kill(pid, 0);
    } catch {
      clearInterval(checkInterval);
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
}

function spawnMasterPidWatcher(state: DaemonState, pid: number): void {
  const checkInterval = setInterval(async () => {
    if (!state.running) {
      clearInterval(checkInterval);
      return;
    }
    try {
      process.kill(pid, 0);
    } catch {
      clearInterval(checkInterval);
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
}

/** starting 状態のタイムアウト（秒） */
const STARTING_TIMEOUT_SEC = 60;

async function monitorConductors(state: DaemonState): Promise<void> {
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
    if (conductor.status === "idle" || conductor.status === "disconnected") continue;

    const status = await checkConductorStatus(conductor);

    switch (status) {
      case "running":
        break;
      case "crashed":
        await log(
          "conductor_crashed",
          `surface=${surface}`
        );
        // persistent Conductor がクラッシュ → idle に戻す
        conductor.status = "idle";
        conductor.taskId = undefined;
        break;
    }

    // Agent surface の生存チェック（pull型防御）
    // kill-agent 以外のルート（tmux quit 等）で surface が消失した場合に対応
    for (let i = conductor.agents.length - 1; i >= 0; i--) {
      const agent = conductor.agents[i]!;
      if (!(await cmux.validateSurface(agent.surface))) {
        conductor.agents.splice(i, 1);
        await log(
          "agent_done",
          `conductor_surface=${surface} surface=${agent.surface} trigger=surface_lost`
        );
      }
    }
  }
}

async function handleConductorDone(
  state: DaemonState,
  conductor: ConductorState
): Promise<void> {
  const { journalSummary } = await collectResults(conductor, state.projectRoot);

  await log(
    "task_completed",
    `task_id=${conductor.taskId} surface=${conductor.surface}${
      conductor.taskTitle ? ` title=${conductor.taskTitle}` : ""
    }${journalSummary ? ` journal_summary=${journalSummary}` : ""}`
  );

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
