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

export interface TaskSummary {
  id: string;
  title: string;
  status: string;
  isTodo: boolean;
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
  await mkdir(join(root, ".team/tasks/open"), { recursive: true });
  await mkdir(join(root, ".team/tasks/closed"), { recursive: true });
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

      case "TODO":
        await log("todo_received", `content=${message.content.slice(0, 50)}`);
        await handleTodo(state, message.content);
        break;

      case "CONDUCTOR_DONE": {
        const isSuccess = message.success !== false;
        await log(
          isSuccess ? "conductor_done_signal" : "conductor_error",
          `conductor_id=${message.conductorId}${!isSuccess && message.reason ? ` reason=${message.reason}` : ""}${message.exitCode != null ? ` exit_code=${message.exitCode}` : ""}`
        );
        const conductor = state.conductors.get(message.conductorId);
        if (conductor) {
          await handleConductorDone(state, conductor);
        }
        break;
      }

      case "AGENT_SPAWNED": {
        const conductor = state.conductors.get(message.conductorId);
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
        const conductor = state.conductors.get(message.conductorId);
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
  const { open, closed, closedMetas } = await loadTasks(state.projectRoot);
  state.openTasks = open.length;

  const assignedIds = new Set(
    [...state.conductors.values()].map((c) => c.taskId)
  );

  const executable = sortByPriority(
    filterExecutableTasks(open, closed, assignedIds)
  );
  state.pendingTasks = executable.length;

  // taskList: open + closed を統合し createdAt 降順で直近5件
  const allTasks = [
    ...open.map((t) => ({ ...t, isTodo: t.fileName.includes("-todo") })),
    ...closedMetas.map((t) => ({ ...t, isTodo: t.fileName.includes("-todo") })),
  ];
  allTasks.sort((a, b) => {
    const aTime = a.closedAt ?? a.createdAt ?? "";
    const bTime = b.closedAt ?? b.createdAt ?? "";
    if (!aTime && !bTime) return 0;
    if (!aTime) return 1;
    if (!bTime) return -1;
    return bTime.localeCompare(aTime);
  });
  state.taskList = allTasks.slice(0, 5).map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    isTodo: t.isTodo,
    createdAt: t.createdAt,
    closedAt: t.closedAt,
  }));

  for (const task of executable) {
    const runningCount = [...state.conductors.values()].filter(c => c.status === "running").length;
    if (runningCount >= state.maxConductors) {
      await log(
        "throttled",
        `task_id=${task.id} conductors=${state.conductors.size}/${state.maxConductors}`
      );
      break;
    }

    // spawn 前にロック（次の tick での二重起動を防止）
    assignedIds.add(task.id);

    const conductor = await spawnConductor(task.id, state.projectRoot);
    if (conductor) {
      state.conductors.set(conductor.conductorId, conductor);
    }
  }
}

async function monitorConductors(state: DaemonState): Promise<void> {
  for (const [id, conductor] of state.conductors) {
    if (conductor.status === "done") {
      const status = await checkConductorStatus(conductor.surface, conductor.startedAt);
      if (status === "crashed") {
        await log("conductor_surface_closed", `conductor_id=${id} surface=${conductor.surface}`);
        state.conductors.delete(id);
      }
      continue;
    }

    const status = await checkConductorStatus(conductor.surface, conductor.startedAt);

    switch (status) {
      case "done":
        if (conductor.doneCandidate) {
          // 2回連続 done → 確定
          await handleConductorDone(state, conductor);
        } else {
          // 1回目 → 候補としてマーク、次の tick で再確認
          conductor.doneCandidate = true;
        }
        break;
      case "running":
        // 実行中に戻ったら候補をリセット
        conductor.doneCandidate = false;
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
  const { sessionId, mergeCommit, journalSummary } = await collectResults(
    conductor,
    state.projectRoot
  );

  await log(
    "task_completed",
    `task_id=${conductor.taskId} conductor_id=${conductor.conductorId}${
      conductor.taskTitle ? ` title=${conductor.taskTitle}` : ""
    }${sessionId ? ` session=${sessionId}` : ""}${
      mergeCommit ? ` merged=${mergeCommit}` : ""
    }${journalSummary ? ` journal_summary=${journalSummary}` : ""}`
  );

  conductor.status = "done";
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
      taskId: c.taskId,
      taskTitle: c.taskTitle,
      surface: c.surface,
      status: c.status,
      worktreePath: c.worktreePath,
      outputDir: c.outputDir,
      startedAt: c.startedAt,
      agents: c.agents.map((a) => ({
        surface: a.surface,
        role: a.role,
      })),
    }));
    await writeFile(teamJsonPath, JSON.stringify(teamJson, null, 2) + "\n");
  } catch {}
}
