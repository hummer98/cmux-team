import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { ConductorState } from "./schema";
import { log } from "./logger";

const execFile = promisify(execFileCb);

export async function spawnConductor(
  taskId: string,
  projectRoot: string
): Promise<ConductorState | null> {
  const scriptPath = `${projectRoot}/.team/scripts/spawn-conductor.sh`;

  if (!existsSync(scriptPath)) {
    log("error", `spawn-conductor.sh not found: ${scriptPath}`);
    return null;
  }

  try {
    const { stdout, stderr } = await execFile("bash", [scriptPath, taskId], {
      cwd: projectRoot,
      timeout: 120_000,
    });

    if (stderr) {
      log("info", `spawn stderr: ${stderr.trim().split("\n").pop()}`);
    }

    const vars: Record<string, string> = {};
    for (const line of stdout.trim().split("\n")) {
      const [key, ...rest] = line.split("=");
      if (key && rest.length) vars[key] = rest.join("=");
    }

    if (!vars.CONDUCTOR_ID || !vars.SURFACE) {
      log("error", `spawn output missing required fields: ${stdout}`);
      return null;
    }

    const state: ConductorState = {
      conductorId: vars.CONDUCTOR_ID,
      taskId,
      surface: vars.SURFACE,
      worktreePath: vars.WORKTREE_PATH || "",
      outputDir: vars.OUTPUT_DIR || "",
      startedAt: new Date().toISOString(),
    };

    log(
      "conductor_started",
      `task_id=${taskId} conductor_id=${state.conductorId} surface=${state.surface}`
    );

    return state;
  } catch (e: any) {
    log("error", `spawn failed for task ${taskId}: ${e.message}`);
    return null;
  }
}

export async function checkConductorStatus(
  surface: string
): Promise<"running" | "done" | "crashed"> {
  try {
    const { stdout } = await execFile(
      "cmux",
      ["read-screen", "--surface", surface, "--lines", "10"],
      { timeout: 10_000 }
    );

    const hasPrompt = stdout.includes("❯");
    const isExecuting = stdout.includes("esc to interrupt");

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

  try {
    await execFile("cmux", ["send", "--surface", conductor.surface, "/exit\n"]);
    await sleep(3000);

    const { stdout: exitScreen } = await execFile("cmux", [
      "read-screen",
      "--surface",
      conductor.surface,
      "--lines",
      "20",
    ]);
    const match = exitScreen.match(/claude --resume ([a-f0-9-]+)/);
    if (match) result.sessionId = match[1];

    await execFile("cmux", ["close-surface", "--surface", conductor.surface]);
  } catch {
    // surface が既に閉じている場合は無視
  }

  try {
    const branch = `${conductor.conductorId}/task`;
    await execFile("git", ["add", "-A"], { cwd: conductor.worktreePath });

    // 変更があればコミット
    try {
      await execFile("git", ["diff", "--cached", "--quiet"], {
        cwd: conductor.worktreePath,
      });
    } catch {
      await execFile(
        "git",
        ["commit", "-m", `feat: task ${conductor.taskId}`],
        { cwd: conductor.worktreePath }
      );
    }

    // メインブランチにマージ
    const { stdout: logOutput } = await execFile(
      "git",
      ["log", "--oneline", "-1", branch],
      { cwd: projectRoot }
    );

    if (logOutput.trim()) {
      await execFile("git", ["merge", branch], { cwd: projectRoot });
      const { stdout: head } = await execFile(
        "git",
        ["rev-parse", "--short", "HEAD"],
        { cwd: projectRoot }
      );
      result.mergeCommit = head.trim();
    }

    await execFile("git", ["worktree", "remove", conductor.worktreePath], {
      cwd: projectRoot,
    });
    await execFile("git", ["branch", "-d", branch], {
      cwd: projectRoot,
    }).catch(() => {});
  } catch (e: any) {
    log("error", `merge failed for ${conductor.conductorId}: ${e.message}`);
  }

  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
