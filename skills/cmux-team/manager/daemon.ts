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
} from "./conductor";
import { spawnMaster, isMasterAlive } from "./master";
import { loadTasks, filterExecutableTasks, sortByPriority } from "./task";
import { log } from "./logger";
import type { ConductorState } from "./schema";

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
  };
}

export async function initInfra(state: DaemonState): Promise<void> {
  const root = state.projectRoot;
  await mkdir(join(root, ".team/tasks/open"), { recursive: true });
  await mkdir(join(root, ".team/tasks/closed"), { recursive: true });
  await mkdir(join(root, ".team/output"), { recursive: true });
  await mkdir(join(root, ".team/prompts"), { recursive: true });
  await mkdir(join(root, ".team/logs"), { recursive: true });
  await ensureQueueDirs();

  // .gitignore
  const gitignore = join(root, ".team/.gitignore");
  if (!existsSync(gitignore)) {
    await writeFile(
      gitignore,
      "output/\nprompts/\ndocs-snapshot/\nlogs/\nqueue/\n"
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

export async function startMaster(state: DaemonState): Promise<void> {
  // 既存 Master の存在チェック
  try {
    const teamJson = JSON.parse(
      await readFile(join(state.projectRoot, ".team/team.json"), "utf-8")
    );
    const surface = teamJson.master?.surface;
    if (surface && (await isMasterAlive(surface))) {
      state.masterSurface = surface;
      await log("master_alive", `surface=${surface}`);
      return;
    }
  } catch {}

  // Master spawn
  const master = await spawnMaster(state.projectRoot);
  if (master) {
    state.masterSurface = master.surface;
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
      case "TASK_CREATED":
        await log("task_received", `task_id=${message.taskId}`);
        break;

      case "TODO":
        await log("todo_received", `content=${message.content.slice(0, 50)}`);
        await handleTodo(state, message.content);
        break;

      case "CONDUCTOR_DONE": {
        await log(
          "conductor_done_signal",
          `conductor_id=${message.conductorId}`
        );
        const conductor = state.conductors.get(message.conductorId);
        if (conductor) {
          await handleConductorDone(state, conductor);
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
  const { open, closed } = await loadTasks(state.projectRoot);
  state.openTasks = open.length;

  const assignedIds = new Set(
    [...state.conductors.values()].map((c) => c.taskId)
  );

  const executable = sortByPriority(
    filterExecutableTasks(open, closed, assignedIds)
  );
  state.pendingTasks = executable.length;

  for (const task of executable) {
    if (state.conductors.size >= state.maxConductors) {
      await log(
        "throttled",
        `task_id=${task.id} conductors=${state.conductors.size}/${state.maxConductors}`
      );
      break;
    }

    const conductor = await spawnConductor(task.id, state.projectRoot);
    if (conductor) {
      state.conductors.set(conductor.conductorId, conductor);
    }
  }
}

async function monitorConductors(state: DaemonState): Promise<void> {
  for (const [id, conductor] of state.conductors) {
    const status = await checkConductorStatus(conductor.surface, conductor.startedAt);

    switch (status) {
      case "done":
        await handleConductorDone(state, conductor);
        break;
      case "crashed":
        await log(
          "conductor_crashed",
          `conductor_id=${id} surface=${conductor.surface}`
        );
        state.conductors.delete(id);
        break;
    }
  }
}

async function handleConductorDone(
  state: DaemonState,
  conductor: ConductorState
): Promise<void> {
  const { sessionId, mergeCommit } = await collectResults(
    conductor,
    state.projectRoot
  );

  await log(
    "task_completed",
    `task_id=${conductor.taskId} conductor_id=${conductor.conductorId}${
      sessionId ? ` session=${sessionId}` : ""
    }${mergeCommit ? ` merged=${mergeCommit}` : ""}`
  );

  state.conductors.delete(conductor.conductorId);
}

async function handleTodo(state: DaemonState, content: string): Promise<void> {
  const taskId = String(Math.floor(Date.now() / 1000));
  const taskFile = join(
    state.projectRoot,
    `.team/tasks/open/${taskId}-todo.md`
  );
  await writeFile(
    taskFile,
    `---
id: ${taskId}
title: ${content.slice(0, 80)}
priority: medium
status: ready
created_at: ${new Date().toISOString()}
---

## タスク
${content}

## 完了条件
- 指示された作業が完了すること
`
  );
  await log("todo_task_created", `task_id=${taskId}`);
}

export async function updateTeamJson(state: DaemonState): Promise<void> {
  const teamJsonPath = join(state.projectRoot, ".team/team.json");
  try {
    const teamJson = JSON.parse(await readFile(teamJsonPath, "utf-8"));
    teamJson.master = { surface: state.masterSurface || "" };
    teamJson.manager = {
      pid: process.pid,
      type: "typescript",
      status: state.running ? "running" : "stopped",
    };
    teamJson.phase = "running";
    teamJson.conductors = [...state.conductors.values()].map((c) => ({
      id: c.conductorId,
      taskId: c.taskId,
      surface: c.surface,
    }));
    await writeFile(teamJsonPath, JSON.stringify(teamJson, null, 2) + "\n");
  } catch {}
}
