/**
 * cmux コマンドラッパー — シェルスクリプト不要でペイン操作
 */
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { log } from "./logger";

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

export async function newSurface(paneId?: string): Promise<string> {
  const args = ["new-surface"];
  if (paneId) args.push("--pane", paneId);
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

/** surface を閉じる。SESSION_ENDED は送信しないため、呼び出し元が必要に応じて明示的に送信すること */
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

/** tree 呼び出しのタイムアウト（ミリ秒） */
const TREE_TIMEOUT_MS = 5_000;

export async function tree(workspace?: string): Promise<string> {
  const args = ["tree"];
  if (workspace) args.push("--workspace", workspace);
  const { stdout } = await execFile("cmux", args, { timeout: TREE_TIMEOUT_MS });
  return stdout;
}

export async function getPaneForSurface(surface: string, workspace?: string): Promise<string | undefined> {
  try {
    const output = await tree(workspace);
    const lines = output.split("\n");
    let currentPane: string | undefined;
    for (const line of lines) {
      const paneMatch = line.match(/pane (pane:\d+)/);
      if (paneMatch) currentPane = paneMatch[1];
      if (line.includes(surface) && currentPane) return currentPane;
    }
    return undefined;
  } catch (e: any) {
    await log("error", `getPaneForSurface failed: surface=${surface} ${e.message}`);
    return undefined;
  }
}

/** validateSurface の最大試行回数（1回目 + リトライ2回 = 計3回） */
const VALIDATE_SURFACE_RETRY_COUNT = 3;
/** 試行間のバックオフ（ミリ秒） */
const VALIDATE_SURFACE_BACKOFF_MS = [200, 400, 800] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * surface の生存確認。
 *
 * - tree() が成功した場合は結果を即返す（missing 判定は正常系のためリトライしない）。
 * - tree() が例外を投げた場合のみバックオフ付きでリトライする（cmux 側の一過性 I/O
 *   エラーによる誤 crash 判定を防ぐ）。
 */
export async function validateSurface(surface: string, workspace?: string): Promise<boolean> {
  for (let attempt = 0; attempt < VALIDATE_SURFACE_RETRY_COUNT; attempt++) {
    try {
      const output = await tree(workspace);
      // tree 成功時は即 return — missing は Agent 終了直後などの正常系
      return output.includes(surface);
    } catch (e: any) {
      if (attempt === VALIDATE_SURFACE_RETRY_COUNT - 1) {
        await log(
          "validate_surface_failed",
          `surface=${surface} attempts=${attempt + 1} last_error=${e.message}`
        );
        return false;
      }
      await sleep(VALIDATE_SURFACE_BACKOFF_MS[attempt] ?? 800);
    }
  }
  return false;
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

export async function getCallerWorkspace(): Promise<string | undefined> {
  try {
    const { stdout } = await execFile("cmux", ["identify"]);
    const data = JSON.parse(stdout);
    return data?.caller?.workspace_ref;
  } catch {
    return undefined;
  }
}
