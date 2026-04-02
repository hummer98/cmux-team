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

/**
 * daemon と同一 workspace 内の Conductor surface を発見する。
 * タブ名に "♦" を含む surface を Conductor とみなす。
 */
export async function findWorkspaceConductors(
  daemonSurface: string
): Promise<Array<{ surface: string; paneId: string }>> {
  const output = await tree();
  const lines = output.split("\n");

  // 1. daemon surface が属する workspace を特定
  let currentWorkspace: string | null = null;
  let daemonWorkspace: string | null = null;
  for (const line of lines) {
    const wsMatch = line.match(/workspace (workspace:\d+)/);
    if (wsMatch) currentWorkspace = wsMatch[1];
    if (line.includes(daemonSurface)) {
      daemonWorkspace = currentWorkspace;
      break;
    }
  }
  if (!daemonWorkspace) return [];

  // 2. その workspace 内で "♦" タブ名を持つ surface を収集
  const conductors: Array<{ surface: string; paneId: string }> = [];
  let inWorkspace = false;
  let currentPane: string | null = null;
  for (const line of lines) {
    const wsMatch = line.match(/workspace (workspace:\d+)/);
    if (wsMatch) {
      inWorkspace = wsMatch[1] === daemonWorkspace;
      continue;
    }
    if (!inWorkspace) continue;
    const paneMatch = line.match(/(pane:\d+)/);
    if (paneMatch) currentPane = paneMatch[1];
    if (currentPane && /surface:\d+/.test(line) && line.includes("♦")) {
      const surfaceMatch = line.match(/(surface:\d+)/);
      if (surfaceMatch) {
        conductors.push({ surface: surfaceMatch[1], paneId: currentPane });
      }
    }
  }
  return conductors;
}

export async function getCallerSurface(): Promise<string> {
  const { stdout } = await execFile("cmux", ["identify"]);
  const data = JSON.parse(stdout);
  const surface = data?.caller?.surface_ref;
  if (!surface?.startsWith("surface:")) {
    throw new Error(`Failed to get caller surface: ${stdout}`);
  }
  return surface;
}
