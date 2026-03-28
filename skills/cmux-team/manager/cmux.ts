/**
 * cmux コマンドラッパー — シェルスクリプト不要でペイン操作
 */
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";

const execFile = promisify(execFileCb);

export async function newSplit(
  direction: "left" | "right" | "up" | "down",
  opts?: { surface?: string }
): Promise<string> {
  const args = ["new-split", direction];
  if (opts?.surface) args.push("--surface", opts.surface);
  const { stdout } = await execFile("cmux", args);
  const surface = stdout.trim().split(/\s+/)[1];
  if (!surface?.startsWith("surface:")) {
    throw new Error(`Failed to create split: ${stdout}`);
  }
  return surface;
}

export async function newSurface(paneId: string): Promise<string> {
  const args = ["new-surface", "--pane", paneId];
  const { stdout } = await execFile("cmux", args);
  const surface = stdout.trim().split(/\s+/)[1];
  if (!surface?.startsWith("surface:")) {
    throw new Error(`Failed to create surface: ${stdout}`);
  }
  return surface;
}

export async function listPaneSurfaces(paneId: string): Promise<string[]> {
  const { stdout } = await execFile("cmux", ["list-pane-surfaces", "--pane", paneId]);
  return stdout.trim().split(/\s+/).filter(s => s.startsWith("surface:"));
}

export async function send(
  surface: string,
  text: string,
  opts?: { workspace?: string }
): Promise<void> {
  const args = ["send"];
  if (opts?.workspace) args.push("--workspace", opts.workspace);
  args.push("--surface", surface, text);
  await execFile("cmux", args);
}

export async function sendKey(
  surface: string,
  key: string,
  opts?: { workspace?: string }
): Promise<void> {
  const args = ["send-key"];
  if (opts?.workspace) args.push("--workspace", opts.workspace);
  args.push("--surface", surface, key);
  await execFile("cmux", args);
}

export async function readScreen(
  surface: string,
  lines: number = 10,
  opts?: { workspace?: string }
): Promise<string> {
  const args = ["read-screen", "--surface", surface, "--lines", String(lines)];
  if (opts?.workspace) args.push("--workspace", opts.workspace);
  const { stdout } = await execFile("cmux", args, { timeout: 10_000 });
  return stdout;
}

export async function closeSurface(surface: string): Promise<void> {
  await execFile("cmux", ["close-surface", "--surface", surface]).catch(
    () => {}
  );
}

export async function renameTab(
  surface: string,
  title: string
): Promise<void> {
  await execFile("cmux", ["rename-tab", "--surface", surface, title]).catch(
    () => {}
  );
}

export async function tree(): Promise<string> {
  const { stdout } = await execFile("cmux", ["tree"]);
  return stdout;
}

export async function validateSurface(surface: string): Promise<boolean> {
  try {
    const output = await tree();
    return output.includes(surface);
  } catch {
    return false;
  }
}

export async function waitForTrust(
  surface: string,
  maxAttempts: number = 10
): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(3000);
    try {
      const screen = await readScreen(surface, 10);
      if (screen.includes("Yes, I trust")) {
        await sendKey(surface, "return");
        await sleep(3000);
        return;
      }
      if (/Thinking|Reading|❯/.test(screen)) {
        return;
      }
    } catch {
      // surface がまだ準備できていない
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
