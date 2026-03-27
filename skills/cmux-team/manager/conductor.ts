/**
 * Conductor の spawn・監視・結果回収（spawn-conductor.sh を TypeScript で置換）
 */
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { readFile, mkdir, readdir, rename } from "fs/promises";
import { join } from "path";
import * as cmux from "./cmux";
import { generateConductorPrompt } from "./template";
import { log } from "./logger";
import type { ConductorState } from "./schema";

const execFile = promisify(execFileCb);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function spawnConductor(
  taskId: string,
  projectRoot: string
): Promise<ConductorState | null> {
  try {
    const conductorId = `conductor-${Math.floor(Date.now() / 1000)}`;

    // --- 1. タスクファイル検索 ---
    const tasksDir = join(projectRoot, ".team/tasks/open");
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
    const worktreePath = join(projectRoot, ".worktrees", conductorId);
    const branch = `${conductorId}/task`;

    await execFile("git", ["worktree", "add", worktreePath, "-b", branch], {
      cwd: projectRoot,
    });

    // worktree ブートストラップ
    if (existsSync(join(worktreePath, "package.json"))) {
      await execFile("npm", ["install"], { cwd: worktreePath }).catch(() => {});
    }

    // --- 3. Conductor プロンプト生成 ---
    const outputDir = `.team/output/${conductorId}`;
    await mkdir(join(projectRoot, outputDir), { recursive: true });

    const promptFile = await generateConductorPrompt(
      projectRoot,
      conductorId,
      taskId,
      taskContent,
      worktreePath,
      outputDir
    );

    // --- 4. cmux ペイン作成 ---
    const surface = await cmux.newSplit("down");

    if (!(await cmux.validateSurface(surface))) {
      await log("error", `Conductor surface ${surface} validation failed`);
      return null;
    }

    // --- 5. Claude Code 起動 ---
    await cmux.send(
      surface,
      `CONDUCTOR_ID=${conductorId} TASK_ID=${taskId} claude --dangerously-skip-permissions '${promptFile} を読んで指示に従って作業してください。'\n`
    );

    // --- 6. Trust 承認 ---
    await cmux.waitForTrust(surface);

    // --- 7. タブ名設定 ---
    const num = surface.replace("surface:", "");
    const shortTitle = taskTitle.length > 30 ? taskTitle.slice(0, 30) + "…" : taskTitle;
    await cmux.renameTab(surface, `[${num}] ${shortTitle}`);

    const state: ConductorState = {
      conductorId,
      taskId,
      taskTitle,
      surface,
      worktreePath,
      outputDir,
      startedAt: new Date().toISOString(),
    };

    await log(
      "conductor_started",
      `task_id=${taskId} conductor_id=${conductorId} surface=${surface}`
    );

    return state;
  } catch (e: any) {
    await log("error", `Conductor spawn failed for task ${taskId}: ${e.message}`);
    return null;
  }
}

const MIN_RUNTIME_MS = 30_000; // spawn 後 30 秒は "done" 判定しない

export async function checkConductorStatus(
  surface: string,
  startedAt: string
): Promise<"running" | "done" | "crashed"> {
  if (!(await cmux.validateSurface(surface))) return "crashed";

  // ガード期間: spawn 直後の誤判定を防ぐ
  const elapsed = Date.now() - new Date(startedAt).getTime();
  if (elapsed < MIN_RUNTIME_MS) return "running";

  try {
    const screen = await cmux.readScreen(surface, 10);
    const hasPrompt = screen.includes("❯");
    const isExecuting = screen.includes("esc to interrupt");

    if (hasPrompt && !isExecuting) return "done";
    if (hasPrompt && isExecuting) return "running";
    return "running";
  } catch {
    return "crashed";
  }
}

export async function collectResults(
  conductor: ConductorState,
  projectRoot: string
): Promise<{ sessionId?: string; mergeCommit?: string }> {
  const result: { sessionId?: string; mergeCommit?: string } = {};

  // 1. Conductor を /exit して session_id を取得
  try {
    await cmux.send(conductor.surface, "/exit\n");
    await sleep(3000);

    const exitScreen = await cmux.readScreen(conductor.surface, 20);
    const match = exitScreen.match(/claude --resume ([a-f0-9-]+)/);
    if (match) result.sessionId = match[1];

    await cmux.closeSurface(conductor.surface);
  } catch {
    // surface が既に閉じている場合
  }

  // 2. worktree クリーンアップ（マージは Conductor が完了前に実行済み）
  try {
    const branch = `${conductor.conductorId}/task`;

    await execFile("git", ["worktree", "remove", conductor.worktreePath, "--force"], {
      cwd: projectRoot,
    }).catch(() => {});
    await execFile("git", ["branch", "-d", branch], {
      cwd: projectRoot,
    }).catch(() => {});
  } catch (e: any) {
    await log(
      "error",
      `Worktree cleanup failed for ${conductor.conductorId}: ${e.message}`
    );
  }

  // 3. タスクをクローズ
  try {
    const tasksDir = join(projectRoot, ".team/tasks/open");
    const closedDir = join(projectRoot, ".team/tasks/closed");
    await mkdir(closedDir, { recursive: true });
    const files = await readdir(tasksDir);
    const taskFile = files.find((f) => {
      const fileId = f.match(/^0*(\d+)/)?.[1];
      return fileId === conductor.taskId || fileId === conductor.taskId.replace(/^0+/, "");
    });
    if (taskFile) {
      await rename(join(tasksDir, taskFile), join(closedDir, taskFile));
    }
  } catch {}

  return result;
}
