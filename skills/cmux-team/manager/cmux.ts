/**
 * cmux コマンドラッパー — シェルスクリプト不要でペイン操作
 */
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { log } from "./logger";
import { formatExecError } from "./exec-error";

const execFile = promisify(execFileCb);

type RunCmuxOpts = { timeout?: number };

/**
 * cmux コマンドの execFile ラッパー。失敗時に stderr/stdout を含む新しい Error を throw する。
 *
 * - 二重ラップ防止: 既に runCmux で wrap 済みの Error はそのまま再 throw する
 * - 元の Error は `cause` および `__cmuxWrapped` チェーンで追跡可能
 * - 元 Error の `stderr` / `stdout` プロパティも wrap 後の Error に転写する（呼び出し元が必要なら参照可能）
 */
async function runCmux(args: string[], opts?: RunCmuxOpts): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFile("cmux", args, opts);
  } catch (e: any) {
    if (e?.__cmuxWrapped) throw e;
    const detail = formatExecError(e);
    const wrapped: any = new Error(detail);
    wrapped.cause = e;
    wrapped.stderr = e?.stderr;
    wrapped.stdout = e?.stdout;
    wrapped.__cmuxWrapped = true;
    throw wrapped;
  }
}

export async function newSplit(
  direction: "left" | "right" | "up" | "down",
  opts?: { surface?: string }
): Promise<string> {
  const args = ["new-split", direction];
  if (opts?.surface) args.push("--surface", opts.surface);
  const { stdout } = await runCmux(args);
  const surface = stdout.trim().split(/\s+/)[1];
  if (!surface?.startsWith("surface:")) {
    throw new Error(`Failed to create split: ${stdout}`);
  }
  return surface;
}

export async function newSurface(paneId?: string): Promise<string> {
  const args = ["new-surface"];
  if (paneId) args.push("--pane", paneId);
  const { stdout } = await runCmux(args);
  const surface = stdout.trim().split(/\s+/)[1];
  if (!surface?.startsWith("surface:")) {
    throw new Error(`Failed to create surface: ${stdout}`);
  }
  return surface;
}

export async function listPaneSurfaces(paneId: string): Promise<string[]> {
  const { stdout } = await runCmux(["list-pane-surfaces", "--pane", paneId]);
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
  await runCmux(args);
}

export async function sendKey(
  surface: string,
  key: string,
  opts?: { workspace?: string }
): Promise<void> {
  const args = ["send-key"];
  if (opts?.workspace) args.push("--workspace", opts.workspace);
  args.push("--surface", surface, key);
  await runCmux(args);
}

export async function readScreen(
  surface: string,
  lines: number = 10,
  opts?: { workspace?: string }
): Promise<string> {
  const args = ["read-screen", "--surface", surface, "--lines", String(lines)];
  if (opts?.workspace) args.push("--workspace", opts.workspace);
  const { stdout } = await runCmux(args, { timeout: 10_000 });
  return stdout;
}

/** surface を閉じる。SESSION_ENDED は送信しないため、呼び出し元が必要に応じて明示的に送信すること */
export async function closeSurface(surface: string): Promise<void> {
  await runCmux(["close-surface", "--surface", surface]).catch(
    () => {}
  );
}

export async function renameTab(
  surface: string,
  title: string
): Promise<void> {
  await runCmux(["rename-tab", "--surface", surface, title]).catch(
    () => {}
  );
}

export async function renameWorkspace(title: string, workspace?: string): Promise<void> {
  const args = ["rename-workspace"];
  if (workspace) args.push("--workspace", workspace);
  args.push(title);
  await runCmux(args).catch(() => {});
}

/** tree 呼び出しのタイムアウト（ミリ秒） */
const TREE_TIMEOUT_MS = 5_000;

export async function tree(workspace?: string): Promise<string> {
  const args = ["tree"];
  if (workspace) args.push("--workspace", workspace);
  const { stdout } = await runCmux(args, { timeout: TREE_TIMEOUT_MS });
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
  const { stdout } = await runCmux(["identify"]);
  const data = JSON.parse(stdout);
  const surface = data?.caller?.surface_ref;
  if (!surface?.startsWith("surface:")) {
    throw new Error(`Failed to get caller surface: ${stdout}`);
  }
  return surface;
}

export async function setStatus(
  key: string,
  value: string,
  icon: string,
  color: string,
  workspace?: string,
): Promise<void> {
  const args = ["set-status", key, value, "--icon", icon, "--color", color];
  if (workspace) args.push("--workspace", workspace);
  try {
    await runCmux(args);
  } catch (e: any) {
    await log("error", `setStatus failed: key=${key} value=${value} ${e.message}`);
  }
}

export async function clearStatus(
  key: string,
  workspace?: string,
): Promise<void> {
  const args = ["clear-status", key];
  if (workspace) args.push("--workspace", workspace);
  try {
    await runCmux(args);
  } catch {
    // 冪等な後処理のため、失敗は握りつぶす
  }
}

export async function getCallerWorkspace(): Promise<string | undefined> {
  try {
    const { stdout } = await runCmux(["identify"]);
    const data = JSON.parse(stdout);
    return data?.caller?.workspace_ref;
  } catch {
    return undefined;
  }
}
