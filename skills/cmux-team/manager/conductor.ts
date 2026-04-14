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
import { notifyStateChanged } from "./eventBus";
import { formatExecError } from "./exec-error";
import { initDB, insertTaskSession } from "./trace-store";
import type { ConductorState, LayoutMode } from "./schema";

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

// --- launchConductor ---

/** resume 復元の 1 件分 */
export interface ResumePlanItem {
  taskId: string;
  taskRunId: string;
  worktreePath: string;
  sessionId: string;
  taskTitle?: string;
}

/** resume 割当結果（surface と task の紐付け） */
export interface ResumeAssignment {
  surface: string;
  taskId: string;
  taskRunId: string;
  worktreePath: string;
  sessionId: string;
  taskTitle?: string;
}

/**
 * 指定 surface 上で Conductor Claude セッションを起動する。
 * - CONDUCTOR_REGISTERED を HTTP API 経由で daemon に送信
 * - 環境変数をシェルに焼き付け
 * - `cmux-team conductor` を起動（session-id は cmdConductor が自己生成）
 *   または `opts.resumeTaskId` 指定時は `cmux-team resume <id>` を起動
 * - タブ名を設定（resume 時は呼び出し元が T<id> に rename するためスキップ）
 */
export async function launchConductor(
  projectRoot: string,
  surface: string,
  paneId?: string,
  opts?: { resumeTaskId?: string },
): Promise<void> {
  // 0. paneId が未指定の場合（cmdSpawnConductor 経由等）、surface から解決する
  if (!paneId) {
    paneId = await getPaneIdForSurface(surface);
  }

  // 1. CONDUCTOR_REGISTERED を HTTP API 経由で送信
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

  // 2. 環境変数をシェルに焼き付け
  //    CMUX_SURFACE: cmdConductor / cmdResume が読み取る（必須）。hook も参照する
  //    CMUX_CLAUDE_HOOKS_DISABLED: 統一（旧 spawnSingleConductor のみ欠落していた）
  await cmux.send(surface, `export CMUX_SURFACE=${surface} CMUX_CLAUDE_HOOKS_DISABLED=1\n`);
  await sleep(500);

  // 3. Claude 起動
  //    - resumeTaskId 指定時: 既存セッションを cmdResume 経由で復元
  //    - それ以外: 通常起動（--session-id なし — cmdConductor が自己生成して daemon に通知）
  if (opts?.resumeTaskId) {
    await cmux.send(surface, `cmux-team resume ${opts.resumeTaskId}\n`);
  } else {
    await cmux.send(surface, `cmux-team conductor\n`);
  }

  // 4. タブ名設定
  //    resume 時はタブ名を呼び出し元（initializeLayout / main.ts）が
  //    `[N] ♦ T<id> <title>` に rename するため、ここでは idle を付けず何もしない。
  //    （二重 rename を避ける — plan/design-review で確認済み）
  if (!opts?.resumeTaskId) {
    const num = surface.replace("surface:", "");
    await cmux.renameTab(surface, `[${num}] ♦ idle`);
  }
}

// --- createConductorPanes ---

/**
 * Conductor 用の pane を分割作成する（Claude は起動しない）
 *
 * layout:
 *   - "wide" (default): 2x2 — 左上 daemon+Master、右上 C1、左下 C2、右下 C3（最大 3）
 *   - "16x9": 上段フル幅 daemon+Master、下段を 2 分割して C1（左）/ C2（右）（最大 2）
 */
export async function createConductorPanes(
  count: number,
  daemonSurface?: string,
  layout: LayoutMode = "wide",
): Promise<{ surface: string; paneId?: string }[]> {
  const panes: { surface: string; paneId?: string }[] = [];

  if (layout === "16x9") {
    if (count > 2) {
      // env CMUX_TEAM_MAX_CONDUCTORS で 3 以上を要求されても 16x9 は 2 pane しか作らない。
      // 呼び出し元（daemon.ts）でも警告ログを出すが、ここでは clamp して続行する。
      await log(
        "layout_16x9_clamp",
        `requested=${count} clamped=2 — 16x9 layout supports max 2 conductors`,
      );
      count = 2;
    }
    // 1. daemon を下に split → Conductor-1 pane（下段の基底）
    const s1 = await cmux.newSplit(
      "down",
      daemonSurface ? { surface: daemonSurface } : undefined,
    );
    panes.push({ surface: s1, paneId: await getPaneIdForSurface(s1) });

    if (count >= 2) {
      // 2. Conductor-1 pane を右に split → Conductor-2 pane（下段を等幅 2 分割）
      const s2 = await cmux.newSplit("right", { surface: s1 });
      panes.push({ surface: s2, paneId: await getPaneIdForSurface(s2) });
    }

    return panes;
  }

  // --- layout === "wide"（既存ロジック） ---
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

// --- initializeConductorSlots ---

export async function initializeConductorSlots(
  projectRoot: string,
  conductors: Map<string, ConductorState>,
  count: number = 3,
  daemonSurface?: string,
  resumePlan?: ResumePlanItem[],
  layout: LayoutMode = "wide",
): Promise<ResumeAssignment[]> {
  const assignments: ResumeAssignment[] = [];
  try {
    await log("conductor_slots_creating", `count=${count} layout=${layout}`);

    // Phase 1: pane 分割（Claude は起動しない）
    await log("conductor_panes_creating", "");
    const panes = await createConductorPanes(count, daemonSurface, layout);
    await log("conductor_panes_created", `count=${panes.length}`);

    // Phase 2: Claude 一斉起動
    //   resumePlan がある場合は panes の先頭から順に 1:1 で割り当てる
    //   （resumePlan は呼び出し元で taskId 昇順 sort 済みの前提）
    await log("conductor_claude_launching", "");
    for (const [i, pane] of panes.entries()) {
      const resumeItem = resumePlan?.[i];
      if (resumeItem) {
        await launchConductor(projectRoot, pane.surface, pane.paneId, {
          resumeTaskId: resumeItem.taskId,
        });
        assignments.push({
          surface: pane.surface,
          taskId: resumeItem.taskId,
          taskRunId: resumeItem.taskRunId,
          worktreePath: resumeItem.worktreePath,
          sessionId: resumeItem.sessionId,
          taskTitle: resumeItem.taskTitle,
        });
      } else {
        await launchConductor(projectRoot, pane.surface, pane.paneId);
      }
    }

    // フォールバック: CONDUCTOR_REGISTERED の HTTP POST が失敗した場合に備え
    for (const [i, pane] of panes.entries()) {
      const resumeItem = resumePlan?.[i];
      if (!conductors.has(pane.surface)) {
        await log("conductor_registered_fallback", `surface=${pane.surface}`);
        if (resumeItem) {
          // resume 割当済みの場合は running + taskId を最初からセット
          conductors.set(pane.surface, {
            surface: pane.surface,
            paneId: pane.paneId,
            status: "running",
            startedAt: new Date().toISOString(),
            agents: [],
            taskId: resumeItem.taskId,
            taskRunId: resumeItem.taskRunId,
            worktreePath: resumeItem.worktreePath,
            taskTitle: resumeItem.taskTitle,
            // sessionId なし — CONDUCTOR_SESSION メッセージで後から設定される
          });
        } else {
          conductors.set(pane.surface, {
            surface: pane.surface,
            paneId: pane.paneId,
            status: "starting",
            startedAt: new Date().toISOString(),
            agents: [],
            // sessionId なし — CONDUCTOR_SESSION メッセージで後から設定される
          });
        }
      }
    }

    await log("conductor_slots_initialized", `count=${panes.length}`);
  } catch (e: any) {
    await log("error", `initializeConductorSlots failed: ${e.message}`);
  }
  return assignments;
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
      const worktreeArgs = ["worktree", "add", worktreePath, "-b", branch];
      if (baseBranch) {
        worktreeArgs.push(baseBranch);  // start-point を指定
      }
      await execFile("git", worktreeArgs, {
        cwd: projectRoot,
      });
      worktreeCreated = true;
      if (baseBranch) {
        log("worktree_created", `branch=${branch} baseBranch=${baseBranch} path=${worktreePath}`);
      }
    } catch (e: any) {
      throw new AssignTaskError("task", `git worktree add failed: ${formatExecError(e)}`, e);
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
        await log("error", `npm install failed in worktree: path=${worktreePath} ${formatExecError(e)}`);
      });
    }

    // direnv allow（.envrc が存在する場合のみ）
    if (existsSync(join(worktreePath, ".envrc"))) {
      try {
        await execFile("direnv", ["allow"], { cwd: worktreePath });
        await log("direnv_allowed", `worktree=${worktreePath}`);
      } catch (e: any) {
        await log("error", `direnv allow failed: worktree=${worktreePath} ${formatExecError(e)}`);
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
    // /clear + Enter でセッションリセット（Conductor は常駐セッション — /exit しない）
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

    // タスク-セッション索引に記録
    try {
      const db = initDB(projectRoot);
      insertTaskSession(db, {
        timestamp: new Date().toISOString(),
        task_id: taskId,
        task_run_id: taskRunId,
        session_id: conductor.sessionId ?? "",
        role: "conductor",
        surface: conductor.surface,
        worktree_path: worktreePath,
        event: "assigned",
      });
      db.close();
    } catch (e: any) {
      log("error", `trace DB assigned insert failed: ${e?.message ?? e}`).catch(() => {});
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
    // sessionId は初回起動時に発行済み — タスク割り当てで変更しない
    notifyStateChanged("conductor.ts:assignTask:status-running");

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
        await log("error", `assignTask cleanup worktree remove failed: path=${worktreePath} ${formatExecError(ce)}`);
      }
      try {
        await execFile("git", ["branch", "-D", branch], { cwd: projectRoot });
      } catch (ce: any) {
        await log("error", `assignTask cleanup branch delete failed: branch=${branch} ${formatExecError(ce)}`);
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
        await log("cleanup_failed", `resetConductor worktree remove: path=${conductor.worktreePath} ${formatExecError(e)}`);
      }
      // ブランチ削除（冪等: 既に削除済みでもエラーにしない）
      if (conductor.taskRunId) {
        const branch = `${conductor.taskRunId}/task`;
        try {
          await execFile("git", ["branch", "-d", branch], { cwd: projectRoot });
        } catch (e: any) {
          await log("cleanup_failed", `resetConductor branch delete: branch=${branch} ${formatExecError(e)}`);
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
    // sessionId は初回起動時に発行済み — reset で消さない（常駐セッション）
    notifyStateChanged("conductor.ts:resetConductor:status-idle");

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

