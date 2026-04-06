/**
 * Conductor の初期化・タスク割り当て・監視・結果回収・リセット
 */
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { readFile, mkdir, readdir, rm } from "fs/promises";
import { join } from "path";
import { loadTaskState } from "./task";
import * as cmux from "./cmux";
import { generateConductorTaskPrompt } from "./template";
import { log } from "./logger";
import type { ConductorState } from "./schema";

const execFile = promisify(execFileCb);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- paneId 取得ヘルパー ---

async function getPaneIdForSurface(surface: string): Promise<string | undefined> {
  // cmux tree をパースして surface が属する pane を特定
  try {
    const output = await cmux.tree();
    // tree 出力形式: pane:N の行の後に surface:M が続く
    const lines = output.split("\n");
    let currentPane: string | undefined;
    for (const line of lines) {
      const paneMatch = line.match(/(pane:\d+)/);
      if (paneMatch) currentPane = paneMatch[1];
      if (line.includes(surface) && currentPane) return currentPane;
    }
  } catch (e: any) {
    await log("error", `getPaneIdForSurface failed: surface=${surface} ${e.message}`);
  }
  return undefined;
}

// --- spawnSingleConductor ---

export async function spawnSingleConductor(
  projectRoot: string,
  direction: "right" | "down",
  parentSurface?: string,
): Promise<ConductorState> {
  const surface = await cmux.newSplit(direction, parentSurface ? { surface: parentSurface } : undefined);

  // Claude 起動
  await cmux.send(
    surface,
    `export CMUX_SURFACE=${surface} && cmux-team conductor ${surface}\n`
  );

  // タブ名設定
  const num = surface.replace("surface:", "");
  await cmux.renameTab(surface, `[${num}] ♦ idle`);

  // paneId 取得
  const paneId = await getPaneIdForSurface(surface);

  // CONDUCTOR_REGISTERED を HTTP API 経由で送信
  try {
    const portFile = join(projectRoot, ".team/proxy-port");
    const port = (await readFile(portFile, "utf-8")).trim();
    await fetch(`http://localhost:${port}/api/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "CONDUCTOR_REGISTERED",
        surface,
        paneId: paneId ?? "",
        timestamp: new Date().toISOString(),
      }),
    });
  } catch (e: any) {
    await log("error", `CONDUCTOR_REGISTERED send failed: surface=${surface} ${e.message}`);
  }

  return {
    surface,
    startedAt: new Date().toISOString(),
    agents: [],
    status: "starting" as const,
    paneId,
  };
}

// --- createConductorPanes ---

/**
 * Conductor 用の pane を分割作成する（Claude は起動しない）
 */
export async function createConductorPanes(
  count: number,
  daemonSurface?: string,
): Promise<{ surface: string; paneId?: string }[]> {
  const panes: { surface: string; paneId?: string }[] = [];

  // 1. daemon を右に split → Conductor-1 pane
  const s1 = await cmux.newSplit("right", daemonSurface ? { surface: daemonSurface } : undefined);
  panes.push({ surface: s1, paneId: await getPaneIdForSurface(s1) });

  if (count >= 2) {
    // 2. daemon を下に split → Conductor-2 pane
    const s2 = await cmux.newSplit("down", daemonSurface ? { surface: daemonSurface } : undefined);
    panes.push({ surface: s2, paneId: await getPaneIdForSurface(s2) });
  }

  if (count >= 3) {
    // 3. Conductor-1 を下に split → Conductor-3 pane
    const s3 = await cmux.newSplit("down", { surface: s1 });
    panes.push({ surface: s3, paneId: await getPaneIdForSurface(s3) });
  }

  return panes;
}

// --- launchConductorOnSurface ---

/**
 * 既存 pane 上で Claude を起動し CONDUCTOR_REGISTERED を送信する
 */
export async function launchConductorOnSurface(
  projectRoot: string,
  surface: string,
  paneId?: string,
): Promise<void> {
  // Claude 起動
  await cmux.send(
    surface,
    `export CMUX_SURFACE=${surface} && cmux-team conductor ${surface}\n`
  );

  // タブ名設定
  const num = surface.replace("surface:", "");
  await cmux.renameTab(surface, `[${num}] ♦ idle`);

  // CONDUCTOR_REGISTERED を HTTP API 経由で送信
  try {
    const portFile = join(projectRoot, ".team/proxy-port");
    const port = (await readFile(portFile, "utf-8")).trim();
    await fetch(`http://localhost:${port}/api/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "CONDUCTOR_REGISTERED",
        surface,
        paneId: paneId ?? "",
        timestamp: new Date().toISOString(),
      }),
    });
  } catch (e: any) {
    await log("error", `CONDUCTOR_REGISTERED send failed: surface=${surface} ${e.message}`);
  }
}

// --- initializeConductorSlots ---

export async function initializeConductorSlots(
  projectRoot: string,
  conductors: Map<string, ConductorState>,
  count: number = 3,
  daemonSurface?: string,
): Promise<void> {
  try {
    await log("conductor_slots_creating", `count=${count}`);

    // Phase 1: pane 分割（Claude は起動しない）
    await log("conductor_panes_creating", "");
    const panes = await createConductorPanes(count, daemonSurface);
    await log("conductor_panes_created", `count=${panes.length}`);

    // Phase 2: Claude 一斉起動
    await log("conductor_claude_launching", "");
    for (const pane of panes) {
      await launchConductorOnSurface(projectRoot, pane.surface, pane.paneId);
    }

    // フォールバック: CONDUCTOR_REGISTERED の HTTP POST が失敗した場合に備え、
    // state.conductors に未登録の surface を直接登録する
    for (const pane of panes) {
      if (!conductors.has(pane.surface)) {
        await log("conductor_registered_fallback", `surface=${pane.surface}`);
        conductors.set(pane.surface, {
          surface: pane.surface,
          paneId: pane.paneId,
          status: "starting",
          startedAt: new Date().toISOString(),
          agents: [],
        });
      }
    }

    await log("conductor_slots_initialized", `count=${panes.length}`);
  } catch (e: any) {
    await log("error", `initializeConductorSlots failed: ${e.message}`);
  }
}

// --- assignTask ---

export async function assignTask(
  conductor: ConductorState,
  taskId: string,
  projectRoot: string
): Promise<ConductorState | null> {
  try {
    const taskRunId = `task-${taskId.padStart(3, '0')}-${Math.floor(Date.now() / 1000)}`;

    // --- 1. タスクファイル検索 ---
    const tasksDir = join(projectRoot, ".team/tasks");
    const files = await readdir(tasksDir);
    const taskFile = files.find((f) => {
      const id = f.match(/^0*(\d+)/)?.[1];
      return id === taskId || id === taskId.replace(/^0+/, "");
    });

    if (!taskFile) {
      await log("error", `Task file not found for ID=${taskId}`);
      return null;
    }

    const taskContent = await readFile(join(tasksDir, taskFile), "utf-8");
    const taskTitle = taskContent.match(/^title:\s*(.+)/m)?.[1]?.trim() || taskFile.replace(/^\d+-/, "").replace(/\.md$/, "");
    const baseBranch = taskContent.match(/^base_branch:\s*(.+)$/m)?.[1]?.trim();

    // --- 2. git worktree 作成 ---
    const worktreePath = join(projectRoot, ".worktrees", taskRunId);
    const branch = `${taskRunId}/task`;

    await execFile("git", ["worktree", "add", worktreePath, "-b", branch], {
      cwd: projectRoot,
    });

    // worktree ブートストラップ
    if (existsSync(join(worktreePath, "package.json"))) {
      await execFile("npm", ["install"], { cwd: worktreePath }).catch(async (e: any) => {
        await log("error", `npm install failed in worktree: path=${worktreePath} ${e.message}`);
      });
    }

    // --- 3. Conductor プロンプト生成 ---
    const outputDir = `.team/output/${taskRunId}`;
    await mkdir(join(projectRoot, outputDir), { recursive: true });

    const promptFile = await generateConductorTaskPrompt(
      projectRoot,
      taskRunId,
      taskId,
      taskContent,
      worktreePath,
      outputDir,
      baseBranch
    );

    // --- 4. 既存セッションをリセットして新プロンプトを送信 ---
    // /clear + Enter でセッションリセット
    await cmux.send(conductor.surface, "/clear");
    await sleep(500);
    await cmux.sendKey(conductor.surface, "return");
    await sleep(2000);

    // 新しいプロンプトを送信
    await cmux.send(
      conductor.surface,
      `${promptFile} を読んで指示に従って作業してください。`
    );
    await sleep(500);
    await cmux.sendKey(conductor.surface, "return");

    // --- 5. タブ名更新 ---
    const num = conductor.surface.replace("surface:", "");
    const shortTitle = taskTitle.length > 30 ? taskTitle.slice(0, 30) + "…" : taskTitle;
    await cmux.renameTab(conductor.surface, `[${num}] ♦ T${taskId} ${shortTitle}`);

    // --- 6. ConductorState 更新 ---
    conductor.taskRunId = taskRunId;
    conductor.taskId = taskId;
    conductor.taskTitle = taskTitle;
    conductor.worktreePath = worktreePath;
    conductor.outputDir = outputDir;
    conductor.startedAt = new Date().toISOString();
    conductor.agents = [];
    conductor.status = "running";

    await log(
      "conductor_started",
      `task_id=${taskId} task_run_id=${taskRunId} surface=${conductor.surface} title=${taskTitle}`
    );

    return conductor;
  } catch (e: any) {
    await log("error", `assignTask failed for task ${taskId}: ${e.message}`);
    return null;
  }
}

// --- resetConductor ---

export async function resetConductor(
  conductor: ConductorState,
  projectRoot: string
): Promise<void> {
  try {
    // 1. タブ内のサブ surface を閉じる
    if (conductor.paneId) {
      try {
        const surfaces = await cmux.listPaneSurfaces(conductor.paneId);
        for (const s of surfaces) {
          if (s !== conductor.surface) {
            await cmux.closeSurface(s);
          }
        }
      } catch (e: any) {
        await log("error", `resetConductor listPaneSurfaces failed: paneId=${conductor.paneId} ${e.message}`);
      }
    } else {
      // paneId なし → agents の surface を個別に閉じる
      for (const agent of conductor.agents) {
        await cmux.closeSurface(agent.surface);
      }
    }

    // 2. worktree 削除（冪等: 既に削除済みでもエラーにしない）
    if (conductor.worktreePath && existsSync(conductor.worktreePath)) {
      try {
        await execFile("git", ["worktree", "remove", conductor.worktreePath, "--force"], {
          cwd: projectRoot,
        });
      } catch (e: any) {
        await log("cleanup_failed", `resetConductor worktree remove: path=${conductor.worktreePath} ${e.message}`);
      }
      // ブランチ削除（冪等: 既に削除済みでもエラーにしない）
      if (conductor.taskRunId) {
        const branch = `${conductor.taskRunId}/task`;
        try {
          await execFile("git", ["branch", "-d", branch], { cwd: projectRoot });
        } catch (e: any) {
          await log("cleanup_failed", `resetConductor branch delete: branch=${branch} ${e.message}`);
        }
      }
    }

    // 3. タブ名をリセット
    const num = conductor.surface.replace("surface:", "");
    await cmux.renameTab(conductor.surface, `[${num}] ♦ idle`);

    // 4. ConductorState リセット
    conductor.status = "idle";
    conductor.taskRunId = undefined;
    conductor.taskId = undefined;
    conductor.taskTitle = undefined;
    conductor.worktreePath = undefined;
    conductor.outputDir = undefined;
    conductor.agents = [];

    await log("conductor_reset", `surface=${conductor.surface}`);
  } catch (e: any) {
    await log("error", `resetConductor failed: ${e.message}`);
  }
}

// --- checkConductorStatus ---

export async function checkConductorStatus(
  conductor: ConductorState
): Promise<"idle" | "running" | "crashed"> {
  if (conductor.status === "idle") return "idle";

  // surface 消失 → クラッシュ
  if (!(await cmux.validateSurface(conductor.surface))) return "crashed";

  return "running";
}

// --- collectResults ---

export async function collectResults(
  conductor: ConductorState,
  projectRoot: string
): Promise<{ journalSummary?: string }> {
  const result: { journalSummary?: string } = {};

  // Journal サマリーを task-state.json から読み取る
  try {
    if (conductor.taskId) {
      const taskState = await loadTaskState(projectRoot);
      const state = taskState[conductor.taskId];
      if (state?.journal) {
        result.journalSummary = state.journal;
      }
    }
  } catch (e: any) {
    await log("error", `collectResults journal read failed: taskId=${conductor.taskId} ${e.message}`);
  }

  return result;
}

// --- spawnConductor（後方互換ラッパー）---

export async function spawnConductor(
  taskId: string,
  projectRoot: string
): Promise<ConductorState | null> {
  // 新しい idle Conductor を作成してタスクを割り当てる（フォールバック）
  try {
    const surface = await cmux.newSplit("down");

    if (!(await cmux.validateSurface(surface))) {
      await log("error", `spawnConductor: surface ${surface} validation failed`);
      return null;
    }

    const paneId = await getPaneIdForSurface(surface);
    const conductor: ConductorState = {
      surface,
      startedAt: new Date().toISOString(),
      agents: [],
      status: "idle",
      paneId,
    };

    // cmux-team conductor ラッパー経由で起動（proxy ポートを動的解決）
    await cmux.send(
      surface,
      `export CMUX_SURFACE=${surface} && cmux-team conductor ${surface}\n`
    );

    return await assignTask(conductor, taskId, projectRoot);
  } catch (e: any) {
    await log("error", `spawnConductor failed for task ${taskId}: ${e.message}`);
    return null;
  }
}
