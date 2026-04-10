/**
 * Conductor の初期化・タスク割り当て・監視・結果回収・リセット
 */
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { existsSync, writeFileSync } from "fs";
import { readFile, mkdir, readdir, rm, stat, copyFile } from "fs/promises";
import { join, relative, dirname } from "path";
import { loadTaskState } from "./task";
import * as cmux from "./cmux";
import { generateConductorTaskPrompt } from "./template";
import { log } from "./logger";
import type { ConductorState } from "./schema";

const execFile = promisify(execFileCb);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- AssignTaskError ---

/**
 * assignTask 失敗時の分類
 * - "task": タスク固有の問題（worktree 作成失敗、タスクファイル不備など）
 *   → 該当タスクを abort、Conductor は idle のまま
 * - "conductor": Conductor 側の問題（cmux send 失敗、surface 不在など）
 *   → Conductor を disconnected にする
 */
export type AssignFailureKind = "task" | "conductor";

export class AssignTaskError extends Error {
  public readonly kind: AssignFailureKind;
  public readonly reason: string;
  constructor(kind: AssignFailureKind, reason: string, cause?: unknown) {
    super(reason);
    this.name = "AssignTaskError";
    this.kind = kind;
    this.reason = reason;
    if (cause !== undefined) {
      (this as any).cause = cause;
    }
  }
}

// --- paneId 取得ヘルパー ---

async function getPaneIdForSurface(surface: string, workspace?: string): Promise<string | undefined> {
  // cmux tree をパースして surface が属する pane を特定
  try {
    const output = await cmux.tree(workspace);
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
  surface: string,
): Promise<ConductorState> {
  const num = surface.replace("surface:", "");
  const paneId = await getPaneIdForSurface(surface);

  // CONDUCTOR_REGISTERED を HTTP API 経由で送信（Claude 起動前に登録）
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

  // 環境変数をシェルに焼き付け
  await cmux.send(surface, `export CMUX_SURFACE=${surface}\n`);
  await sleep(500);
  // Claude 起動
  await cmux.send(surface, `cmux-team conductor ${surface}\n`);
  await cmux.renameTab(surface, `[${num}] ♦ idle`);

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
  // CONDUCTOR_REGISTERED を HTTP API 経由で送信（Claude 起動前に登録）
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

  // 環境変数をシェルに焼き付け
  await cmux.send(surface, `export CMUX_SURFACE=${surface}\n`);
  await sleep(500);
  // Claude 起動
  await cmux.send(surface, `cmux-team conductor ${surface}\n`);

  // タブ名設定
  const num = surface.replace("surface:", "");
  await cmux.renameTab(surface, `[${num}] ♦ idle`);
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
): Promise<ConductorState> {
  const taskRunId = `task-${taskId.padStart(3, '0')}-${Math.floor(Date.now() / 1000)}`;
  const worktreePath = join(projectRoot, ".worktrees", taskRunId);
  const branch = `${taskRunId}/task`;
  let worktreeCreated = false;

  try {
    // --- 1. タスクファイル検索（ハイブリッド対応） ---
    const tasksDir = join(projectRoot, ".team/tasks");
    let entries: string[];
    try {
      entries = await readdir(tasksDir);
    } catch (e: any) {
      throw new AssignTaskError("task", `tasks dir not readable: ${e.message}`, e);
    }
    let taskContent: string | null = null;
    let taskDir: string | undefined;

    for (const entry of entries) {
      const id = entry.match(/^0*(\d+)/)?.[1];
      if (id !== taskId && id !== taskId.replace(/^0+/, "")) continue;

      const fullPath = join(tasksDir, entry);
      const s = await stat(fullPath);

      if (s.isDirectory()) {
        const taskMdPath = join(fullPath, "task.md");
        if (existsSync(taskMdPath)) {
          taskContent = await readFile(taskMdPath, "utf-8");
          taskDir = fullPath;
        }
      } else if (entry.endsWith(".md")) {
        taskContent = await readFile(fullPath, "utf-8");
      }
      break;
    }

    if (!taskContent) {
      throw new AssignTaskError("task", `task file not found: id=${taskId}`);
    }

    const taskTitle = taskContent.match(/^title:\s*(.+)/m)?.[1]?.trim() || "unknown";
    const baseBranch = taskContent.match(/^base_branch:\s*(.+)$/m)?.[1]?.trim();

    // --- 2. git worktree 作成 ---
    try {
      await execFile("git", ["worktree", "add", worktreePath, "-b", branch], {
        cwd: projectRoot,
      });
      worktreeCreated = true;
    } catch (e: any) {
      throw new AssignTaskError("task", `git worktree add failed: ${e.message}`, e);
    }

    // .claude/settings.local.json を worktree にコピー
    // （untracked なので worktree に含まれないが、Agent 起動時に必要）
    const settingsSrc = join(projectRoot, ".claude/settings.local.json");
    if (existsSync(settingsSrc)) {
      const settingsDst = join(worktreePath, ".claude/settings.local.json");
      await mkdir(dirname(settingsDst), { recursive: true })
        .then(() => copyFile(settingsSrc, settingsDst))
        .then(() => log("settings_copied_to_worktree", `worktree=${worktreePath}`))
        .catch(async (e: any) => {
          await log("error", `settings copy failed: worktree=${worktreePath} ${e.message}`);
        });
    }

    // .envrc を生成（source_up で親の .envrc を継承）
    const envrcSrc = join(projectRoot, '.envrc');
    if (existsSync(envrcSrc)) {
      writeFileSync(join(worktreePath, '.envrc'), 'source_up\n');
      await log("envrc_generated", `worktree=${worktreePath}`);
    }

    // worktree ブートストラップ
    if (existsSync(join(worktreePath, "package.json"))) {
      await execFile("npm", ["install"], { cwd: worktreePath }).catch(async (e: any) => {
        await log("error", `npm install failed in worktree: path=${worktreePath} ${e.message}`);
      });
    }

    // direnv allow（.envrc が存在する場合のみ）
    if (existsSync(join(worktreePath, ".envrc"))) {
      try {
        await execFile("direnv", ["allow"], { cwd: worktreePath });
        await log("direnv_allowed", `worktree=${worktreePath}`);
      } catch (e: any) {
        await log("error", `direnv allow failed: worktree=${worktreePath} ${e.message}`);
      }
    }

    // --- 3. Conductor プロンプト生成 ---
    let outputDir: string;
    if (taskDir) {
      // 新形式: タスクフォルダ内
      outputDir = relative(projectRoot, join(taskDir, "runs", taskRunId));
    } else {
      // 旧形式: .team/output/
      outputDir = `.team/output/${taskRunId}`;
    }
    await mkdir(join(projectRoot, outputDir), { recursive: true });

    let promptFile: string;
    try {
      promptFile = await generateConductorTaskPrompt(
        projectRoot,
        taskRunId,
        taskId,
        taskContent,
        worktreePath,
        outputDir,
        baseBranch,
        taskDir
      );
    } catch (e: any) {
      throw new AssignTaskError("task", `prompt generation failed: ${e.message}`, e);
    }

    // --- 4. 既存セッションをリセットして新プロンプトを送信 ---
    // /clear + Enter でセッションリセット
    try {
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
    } catch (e: any) {
      throw new AssignTaskError("conductor", `cmux send failed: ${e.message}`, e);
    }

    // --- 5. タブ名更新（失敗しても task は継続）---
    // renameTab は表示用の冪等な後処理。catch-all に捕まって task abort
    // されると実害の無い失敗でタスクが吹き飛ぶため、個別に握りつぶす。
    const num = conductor.surface.replace("surface:", "");
    const shortTitle = taskTitle.length > 30 ? taskTitle.slice(0, 30) + "…" : taskTitle;
    try {
      await cmux.renameTab(conductor.surface, `[${num}] ♦ T${taskId} ${shortTitle}`);
    } catch (e: any) {
      await log("error", `renameTab failed: surface=${conductor.surface} ${e.message}`);
    }

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
    // worktree 作成後に失敗した場合は cleanup する（残骸がブランチ名衝突を引き起こすのを防ぐ）
    if (worktreeCreated) {
      try {
        await execFile("git", ["worktree", "remove", "--force", worktreePath], { cwd: projectRoot });
      } catch (ce: any) {
        await log("error", `assignTask cleanup worktree remove failed: path=${worktreePath} ${ce.message}`);
      }
      try {
        await execFile("git", ["branch", "-D", branch], { cwd: projectRoot });
      } catch (ce: any) {
        await log("error", `assignTask cleanup branch delete failed: branch=${branch} ${ce.message}`);
      }
    }

    if (e instanceof AssignTaskError) throw e;
    // 想定外エラーはタスク側に寄せる（Conductor を守る保守的挙動）
    throw new AssignTaskError("task", `assignTask unexpected error: ${e.message}`, e);
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
    // disconnected 状態から reset される経路（forceCloseDisconnectedConductor 等）で
    // 古い disconnectedAt が残ることを防ぐ (Minor 3)
    conductor.disconnectedAt = undefined;

    await log("conductor_reset", `surface=${conductor.surface}`);
  } catch (e: any) {
    await log("error", `resetConductor failed: ${e.message}`);
  }
}

// --- checkConductorStatus ---

export async function checkConductorStatus(
  conductor: ConductorState,
  workspace?: string
): Promise<"idle" | "running" | "crashed"> {
  if (conductor.status === "idle") return "idle";

  // surface 消失 → クラッシュ
  if (!(await cmux.validateSurface(conductor.surface, workspace))) return "crashed";

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

    if (!(await cmux.validateSurface(surface, await cmux.getCallerWorkspace()))) {
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

    // 環境変数をシェルに焼き付け
    await cmux.send(surface, `export CMUX_SURFACE=${surface}\n`);
    await sleep(500);
    // cmux-team conductor ラッパー経由で起動（proxy ポートを動的解決）
    await cmux.send(surface, `cmux-team conductor ${surface}\n`);

    try {
      return await assignTask(conductor, taskId, projectRoot);
    } catch (e) {
      if (e instanceof AssignTaskError) {
        // spawnConductor は戻り値 null 仕様を維持するため、ここで kind/reason を log する
        // （daemon.scanTasks 経路とは異なり、呼び出し側には詳細情報を渡せない）
        await log("error", `spawnConductor assignTask failed: kind=${e.kind} ${e.reason}`);
        return null;
      }
      throw e;
    }
  } catch (e: any) {
    await log("error", `spawnConductor failed for task ${taskId}: ${e.message}`);
    return null;
  }
}
