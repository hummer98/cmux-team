/**
 * Daemon — メインループ + surface 管理
 */
import { readdir, readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { readQueue, markProcessed, ensureQueueDirs } from "./queue";
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
import { loadTasks, filterExecutableTasks, sortByPriority } from "./task";
import { log } from "./logger";
import type { ConductorState } from "./schema";

export interface TaskSummary {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  closedAt?: string;
}

export interface DaemonState {
  running: boolean;
  masterSurface: string | null;
  conductors: Map<string, ConductorState>;
  projectRoot: string;
  pollInterval: number;
  maxConductors: number;
  lastUpdate: Date;
  pendingTasks: number;
  openTasks: number;
  taskList: TaskSummary[];
}

/** conductorId または taskRunId で Conductor を検索 */
function findConductor(state: DaemonState, id: string): ConductorState | undefined {
  const direct = state.conductors.get(id);
  if (direct) return direct;
  // taskRunId で検索（Conductor セッションが taskRunId を conductorId として送信する場合）
  for (const c of state.conductors.values()) {
    if (c.taskRunId === id) return c;
  }
  return undefined;
}

export async function createDaemon(projectRoot: string): Promise<DaemonState> {
  return {
    running: true,
    masterSurface: null,
    conductors: new Map(),
    projectRoot,
    pollInterval: Number(process.env.CMUX_TEAM_POLL_INTERVAL ?? 10_000),
    maxConductors: Number(process.env.CMUX_TEAM_MAX_CONDUCTORS ?? 3),
    lastUpdate: new Date(),
    pendingTasks: 0,
    openTasks: 0,
    taskList: [],
  };
}

export async function initInfra(state: DaemonState): Promise<void> {
  const root = state.projectRoot;
  await mkdir(join(root, ".team/tasks"), { recursive: true });
  await mkdir(join(root, ".team/output"), { recursive: true });
  await mkdir(join(root, ".team/prompts"), { recursive: true });
  await mkdir(join(root, ".team/logs"), { recursive: true });
  await ensureQueueDirs();

  const scriptsDir = join(root, ".team/scripts");
  await mkdir(scriptsDir, { recursive: true });

  // .gitignore
  const gitignore = join(root, ".team/.gitignore");
  if (!existsSync(gitignore)) {
    await writeFile(
      gitignore,
      "output/\nprompts/\ndocs-snapshot/\nlogs/\nqueue/\ntask-state.json\n"
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
  // 既存 Master の存在チェック
  try {
    const teamJson = JSON.parse(
      await readFile(join(state.projectRoot, ".team/team.json"), "utf-8")
    );
    const surface = teamJson.master?.surface;
    if (surface) {
      const alive = await isMasterAlive(surface);
      if (alive) {
        state.masterSurface = surface;
        await log("master_alive", `surface=${surface}`);
        return;
      }
      await log("master_check_failed", `surface=${surface} alive=false`);
    }
  } catch (e: any) {
    await log("master_check_error", e.message);
  }

  // Master spawn
  const master = await spawnMaster(state.projectRoot, daemonSurface);
  if (master) {
    state.masterSurface = master.surface;
  }
}

export async function initializeLayout(state: DaemonState, daemonSurface?: string): Promise<void> {
  // team.json に既存 Conductor があり surface が生きていればスキップ
  if (state.conductors.size > 0) {
    const checks = await Promise.all(
      [...state.conductors.values()].map(c => cmux.validateSurface(c.surface))
    );
    if (checks.some(alive => alive)) return;
  }

  const slots = await initializeConductorSlots(state.projectRoot, state.maxConductors, daemonSurface);
  for (const slot of slots) {
    state.conductors.set(slot.conductorId, slot);
  }
}

export async function tick(state: DaemonState): Promise<void> {
  state.lastUpdate = new Date();
  await processQueue(state);
  await scanTasks(state);
  await monitorConductors(state);
}

async function processQueue(state: DaemonState): Promise<void> {
  const messages = await readQueue();

  for (const { path, message } of messages) {
    switch (message.type) {
      case "TASK_CREATED": {
        let title = "";
        if (message.taskFile && existsSync(message.taskFile)) {
          try {
            const content = await readFile(message.taskFile, "utf-8");
            title = content.match(/^title:\s*(.+)$/m)?.[1]?.trim() ?? "";
          } catch {}
        }
        await log("task_received", `task_id=${message.taskId}${title ? ` title=${title}` : ""}`);
        break;
      }

      case "CONDUCTOR_DONE": {
        const isSuccess = message.success !== false;
        await log(
          isSuccess ? "conductor_done_signal" : "conductor_error",
          `conductor_id=${message.conductorId}${!isSuccess && message.reason ? ` reason=${message.reason}` : ""}${message.exitCode != null ? ` exit_code=${message.exitCode}` : ""}`
        );
        const conductor = findConductor(state, message.conductorId);
        if (conductor) {
          await handleConductorDone(state, conductor);
        }
        break;
      }

      case "AGENT_SPAWNED": {
        const conductor = findConductor(state, message.conductorId);
        if (conductor) {
          conductor.agents.push({
            surface: message.surface,
            role: message.role,
            spawnedAt: message.timestamp,
          });
          await log(
            "agent_spawned",
            `conductor=${message.conductorId} surface=${message.surface}${message.role ? ` role=${message.role}` : ""}`
          );
        }
        break;
      }

      case "AGENT_DONE": {
        const conductor = findConductor(state, message.conductorId);
        if (conductor) {
          conductor.agents = conductor.agents.filter(
            (a) => a.surface !== message.surface
          );
          await log(
            "agent_done",
            `conductor=${message.conductorId} surface=${message.surface}`
          );
        }
        break;
      }

      case "SHUTDOWN":
        await log("shutdown_requested");
        state.running = false;
        break;
    }

    await markProcessed(path);
  }
}

async function scanTasks(state: DaemonState): Promise<void> {
  const { tasks, taskState } = await loadTasks(state.projectRoot);

  const closed = new Set(
    Object.entries(taskState)
      .filter(([_, s]) => s.status === "closed")
      .map(([id]) => id)
  );

  const openTasksList = tasks.filter(t => t.status !== "closed");
  state.openTasks = openTasksList.length;

  const assignedIds = new Set(
    [...state.conductors.values()].map((c) => c.taskId).filter((id): id is string => !!id)
  );

  const executable = sortByPriority(
    filterExecutableTasks(openTasksList, closed, assignedIds)
  );
  state.pendingTasks = executable.length;

  // taskList: open を優先表示、残り枠で closed（直近）を表示
  const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const openTasks = [...openTasksList]
    .sort((a, b) => (priorityOrder[a.priority] ?? 1) - (priorityOrder[b.priority] ?? 1));
  const closedMetas = tasks.filter(t => t.status === "closed");
  const closedTasks = [...closedMetas]
    .sort((a, b) => (taskState[b.id]?.closedAt ?? "").localeCompare(taskState[a.id]?.closedAt ?? ""));
  const maxItems = Math.max(5, openTasks.length);
  const combined = [...openTasks, ...closedTasks.slice(0, maxItems - openTasks.length)];
  state.taskList = combined.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    createdAt: t.createdAt,
    closedAt: taskState[t.id]?.closedAt,
  }));

  for (const task of executable) {
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
      state.conductors.set(updated.conductorId, updated);
    }
  }
}

async function monitorConductors(state: DaemonState): Promise<void> {
  for (const [id, conductor] of state.conductors) {
    if (conductor.status === "idle") continue;

    if (conductor.status === "done") {
      // 既に done 処理済み、surface 消失チェックのみ
      if (!(await cmux.validateSurface(conductor.surface))) {
        await log("conductor_surface_lost", `conductor_id=${id}`);
      }
      continue;
    }

    const status = await checkConductorStatus(conductor);

    switch (status) {
      case "done":
        if (conductor.doneCandidate) {
          await handleConductorDone(state, conductor);
        } else {
          conductor.doneCandidate = true;
        }
        break;
      case "running":
        conductor.doneCandidate = false;
        break;
      case "crashed":
        await log(
          "conductor_crashed",
          `conductor_id=${id} surface=${conductor.surface}`
        );
        // persistent Conductor がクラッシュ → idle に戻す
        conductor.status = "idle";
        conductor.taskId = undefined;
        break;
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
    `task_id=${conductor.taskId} conductor_id=${conductor.conductorId}${
      conductor.taskTitle ? ` title=${conductor.taskTitle}` : ""
    }${journalSummary ? ` journal_summary=${journalSummary}` : ""}`
  );

  // Conductor をリセットして idle に戻す
  await resetConductor(conductor, state.projectRoot);
}

export async function updateTeamJson(state: DaemonState): Promise<void> {
  const teamJsonPath = join(state.projectRoot, ".team/team.json");
  try {
    const teamJson = JSON.parse(await readFile(teamJsonPath, "utf-8"));
    // master surface が null の場合は既存値を保持（reload 時に消さない）
    if (state.masterSurface) {
      teamJson.master = { surface: state.masterSurface };
    }
    teamJson.manager = {
      pid: process.pid,
      type: "typescript",
      status: state.running ? "running" : "stopped",
    };
    teamJson.phase = "running";
    teamJson.conductors = [...state.conductors.values()].map((c) => ({
      id: c.conductorId,
      taskRunId: c.taskRunId,
      taskId: c.taskId,
      taskTitle: c.taskTitle,
      surface: c.surface,
      status: c.status,
      worktreePath: c.worktreePath,
      outputDir: c.outputDir,
      startedAt: c.startedAt,
      paneId: c.paneId,
      agents: c.agents.map((a) => ({
        surface: a.surface,
        role: a.role,
      })),
    }));
    await writeFile(teamJsonPath, JSON.stringify(teamJson, null, 2) + "\n");
  } catch {}
}
