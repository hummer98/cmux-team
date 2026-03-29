/**
 * Conductor の初期化・タスク割り当て・監視・結果回収・リセット
 */
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { readFile, writeFile, mkdir, readdir } from "fs/promises";
import { join, dirname } from "path";
import { loadTaskState } from "./task";
import * as cmux from "./cmux";
import { generateConductorRolePrompt, generateConductorTaskPrompt } from "./template";
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
  } catch {}
  return undefined;
}

// --- initializeConductorSlots ---

export async function initializeConductorSlots(
  projectRoot: string,
  count: number = 3,
  daemonSurface?: string
): Promise<ConductorState[]> {
  const slots: ConductorState[] = [];

  try {
    console.log(`⏳ Conductor スロット作成中 (${count}個)...`);

    // 1. daemon を右に split → Conductor-1
    const surface1 = await cmux.newSplit("right", daemonSurface ? { surface: daemonSurface } : undefined);
    await log("conductor_slot_created", `slot=1 surface=${surface1}`);

    // 2. daemon を下に split → Conductor-2
    const surface2 = await cmux.newSplit("down", daemonSurface ? { surface: daemonSurface } : undefined);
    await log("conductor_slot_created", `slot=2 surface=${surface2}`);

    // 3. Conductor-1 を下に split → Conductor-3
    const surface3 = await cmux.newSplit("down", { surface: surface1 });
    await log("conductor_slot_created", `slot=3 surface=${surface3}`);

    const surfaces = [surface1, surface2, surface3].slice(0, count);

    // ロールプロンプトファイル生成（全スロットで共有）
    const rolePromptFile = await generateConductorRolePrompt(projectRoot);

    for (let i = 0; i < surfaces.length; i++) {
      const surface = surfaces[i]!;
      const slotId = `conductor-slot-${i + 1}`;

      console.log(`  ⏳ Conductor ${i + 1}/${surfaces.length}: Claude 起動中 (${surface})...`);

      // 環境変数を export してから Claude を起動（子プロセスに自動継承させる）
      let proxyPort: string | undefined;
      try {
        proxyPort = (await readFile(join(projectRoot, ".team/proxy-port"), "utf-8")).trim();
      } catch {}
      const exports: string[] = [`export PROJECT_ROOT=${projectRoot}`];
      if (proxyPort) {
        exports.push(`export ANTHROPIC_BASE_URL=http://127.0.0.1:${proxyPort}`);
      }

      await cmux.send(
        surface,
        `${exports.join(" && ")} && claude --dangerously-skip-permissions --append-system-prompt-file ${rolePromptFile} 'あなたは Conductor スロットです。Manager が /clear + プロンプト送信でタスクを割り当てるまで、何もせず ❯ プロンプトで待機してください。タスクの検索・読み取り・実行は一切行わないこと。'\n`
      );

      // Trust 承認
      console.log(`  ⏳ Conductor ${i + 1}/${surfaces.length}: Trust 承認待ち...`);
      await cmux.waitForTrust(surface);

      // タブ名設定
      const num = surface.replace("surface:", "");
      await cmux.renameTab(surface, `[${num}] ♦ idle`);

      // paneId 取得
      const paneId = await getPaneIdForSurface(surface);

      const state: ConductorState = {
        conductorId: slotId,
        surface,
        startedAt: new Date().toISOString(),
        agents: [],
        doneCandidate: false,
        status: "idle",
        paneId,
      };
      slots.push(state);

      console.log(`  ✅ Conductor ${i + 1}/${surfaces.length}: 準備完了`);
    }

    console.log(`✅ Conductor スロット ${slots.length}個 準備完了`);
    await log("conductor_slots_initialized", `count=${slots.length}`);
  } catch (e: any) {
    await log("error", `initializeConductorSlots failed: ${e.message}`);
  }

  return slots;
}

// --- assignTask ---

export async function assignTask(
  conductor: ConductorState,
  taskId: string,
  projectRoot: string
): Promise<ConductorState | null> {
  try {
    const taskRunId = `run-${Math.floor(Date.now() / 1000)}`;

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

    // --- 2. git worktree 作成 ---
    const worktreePath = join(projectRoot, ".worktrees", taskRunId);
    const branch = `${taskRunId}/task`;

    await execFile("git", ["worktree", "add", worktreePath, "-b", branch], {
      cwd: projectRoot,
    });

    // worktree ブートストラップ
    if (existsSync(join(worktreePath, "package.json"))) {
      await execFile("npm", ["install"], { cwd: worktreePath }).catch(() => {});
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
      outputDir
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
    await cmux.renameTab(conductor.surface, `[${num}] ♦ #${taskId} ${shortTitle}`);

    // --- 6. ConductorState 更新 ---
    conductor.taskRunId = taskRunId;
    conductor.taskId = taskId;
    conductor.taskTitle = taskTitle;
    conductor.worktreePath = worktreePath;
    conductor.outputDir = outputDir;
    conductor.startedAt = new Date().toISOString();
    conductor.agents = [];
    conductor.doneCandidate = false;
    conductor.status = "running";

    await log(
      "conductor_started",
      `task_id=${taskId} conductor_id=${conductor.conductorId} task_run_id=${taskRunId} surface=${conductor.surface} title=${taskTitle}`
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
      } catch {}
    } else {
      // paneId なし → agents の surface を個別に閉じる
      for (const agent of conductor.agents) {
        await cmux.closeSurface(agent.surface);
      }
    }

    // 2. worktree 削除
    if (conductor.worktreePath && existsSync(conductor.worktreePath)) {
      try {
        await execFile("git", ["worktree", "remove", conductor.worktreePath, "--force"], {
          cwd: projectRoot,
        });
      } catch {}
      // ブランチ削除
      if (conductor.taskRunId) {
        const branch = `${conductor.taskRunId}/task`;
        try {
          await execFile("git", ["branch", "-d", branch], { cwd: projectRoot });
        } catch {}
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
    conductor.doneCandidate = false;

    await log("conductor_reset", `conductor_id=${conductor.conductorId} surface=${conductor.surface}`);
  } catch (e: any) {
    await log("error", `resetConductor failed: ${e.message}`);
  }
}

// --- checkConductorStatus ---

export async function checkConductorStatus(
  conductor: ConductorState
): Promise<"idle" | "running" | "done" | "crashed"> {
  if (conductor.status === "idle") return "idle";

  // done マーカーファイルのみで完了判定（画面判定はしない）
  if (conductor.outputDir && existsSync(join(conductor.outputDir, "done"))) {
    return "done";
  }

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
  } catch {}

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
      conductorId: `conductor-fallback-${Math.floor(Date.now() / 1000)}`,
      surface,
      startedAt: new Date().toISOString(),
      agents: [],
      doneCandidate: false,
      status: "idle",
      paneId,
    };

    // ロールプロンプトファイル生成
    const rolePromptFile = await generateConductorRolePrompt(projectRoot);

    // 環境変数を export してから Claude を起動（子プロセスに自動継承させる）
    let proxyPort: string | undefined;
    try {
      proxyPort = (await readFile(join(projectRoot, ".team/proxy-port"), "utf-8")).trim();
    } catch {}
    const exports: string[] = [`export PROJECT_ROOT=${projectRoot}`];
    if (proxyPort) {
      exports.push(`export ANTHROPIC_BASE_URL=http://127.0.0.1:${proxyPort}`);
    }
    await cmux.send(
      surface,
      `${exports.join(" && ")} && claude --dangerously-skip-permissions --append-system-prompt-file ${rolePromptFile} 'あなたは Conductor スロットです。Manager が /clear + プロンプト送信でタスクを割り当てるまで、何もせず ❯ プロンプトで待機してください。タスクの検索・読み取り・実行は一切行わないこと。'\n`
    );
    await cmux.waitForTrust(surface);

    return await assignTask(conductor, taskId, projectRoot);
  } catch (e: any) {
    await log("error", `spawnConductor failed for task ${taskId}: ${e.message}`);
    return null;
  }
}
