/**
 * Conductor の spawn・監視・結果回収（spawn-conductor.sh を TypeScript で置換）
 */
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { readFile, writeFile, mkdir, readdir, rename } from "fs/promises";
import { join, dirname } from "path";
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

    // --- 5. Conductor 用 settings 生成（Agent spawn 検出 + 完了通知 hook） ---
    const mainTs = join(dirname(import.meta.path), "main.ts");

    // PostToolUse hook: cmux new-split 実行時に AGENT_SPAWNED を通知
    const postToolUseCmd = [
      '[ "$TOOL_NAME" != "Bash" ] && exit 0;',
      'echo "$TOOL_INPUT" | grep -q "cmux new-split" || exit 0;',
      'SURFACE=$(echo "$TOOL_RESPONSE" | grep -o "surface:[0-9]*" | head -1);',
      '[ -z "$SURFACE" ] && exit 0;',
      'ROLE=$(echo "$TOOL_INPUT" | grep -o "Agent-[a-zA-Z]*" | head -1 | sed "s/Agent-//");',
      `ARGS="AGENT_SPAWNED --conductor-id ${conductorId} --surface $SURFACE";`,
      '[ -n "$ROLE" ] && ARGS="$ARGS --role $ROLE";',
      `bun run "${mainTs}" send $ARGS >/dev/null 2>&1 || true`,
    ].join(" ");

    // Stop hook: Conductor 終了時に CONDUCTOR_DONE を通知
    const stopCmd = `bun run "${mainTs}" send CONDUCTOR_DONE --conductor-id ${conductorId} --surface ${surface} --success true`;

    const conductorSettings = join(projectRoot, `.team/prompts/${conductorId}-settings.json`);
    await writeFile(conductorSettings, JSON.stringify({
      hooks: {
        PostToolUse: [{
          matcher: "Bash",
          hooks: [{
            type: "command",
            command: `bash -c '${postToolUseCmd}'`,
          }],
        }],
        Stop: [{
          hooks: [{
            type: "command",
            command: stopCmd,
          }],
        }],
      },
    }));

    // --- 6. Claude Code 起動 ---
    await cmux.send(
      surface,
      `CONDUCTOR_ID=${conductorId} TASK_ID=${taskId} PROJECT_ROOT=${projectRoot} claude --dangerously-skip-permissions --settings "${conductorSettings}" '${promptFile} を読んで指示に従って作業してください。'\n`
    );

    // --- 7. Trust 承認 ---
    await cmux.waitForTrust(surface);

    // --- 8. タブ名設定 ---
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
      agents: [],
    };

    await log(
      "conductor_started",
      `task_id=${taskId} conductor_id=${conductorId} surface=${surface} title=${taskTitle}`
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
): Promise<{ sessionId?: string; mergeCommit?: string; journalSummary?: string }> {
  const result: { sessionId?: string; mergeCommit?: string; journalSummary?: string } = {};

  // 1. (ペインクローズは上位層が担当)

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

  // 3. タスクをクローズ（Journal セクションからサマリーを抽出してログに記録）
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
      // Journal セクションからサマリーを抽出
      try {
        const content = await readFile(join(tasksDir, taskFile), "utf-8");
        const journalMatch = content.match(/## Journal\s*\n([\s\S]*?)(?=\n## |\n---|$)/);
        if (journalMatch) {
          const journalText = journalMatch[1]?.trim() ?? "";
          const summaryMatch = journalText.match(/summary:\s*(.+)/i);
          if (summaryMatch) {
            result.journalSummary = summaryMatch[1]?.trim();
          }
        }
      } catch {}
      await rename(join(tasksDir, taskFile), join(closedDir, taskFile));
    }
  } catch {}

  return result;
}
