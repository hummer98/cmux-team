/**
 * cmux コマンドラッパー — シェルスクリプト不要でペイン操作
 */
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { log, formatSurface } from "./logger";
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
    const { stdout, stderr } = await execFile("cmux", args, opts);
    return { stdout: stdout.toString(), stderr: stderr.toString() };
  } catch (e: any) {
    if (e?.__cmuxWrapped) throw e;
    const detail = formatExecError(e);
    const wrapped: any = new Error(detail);
    wrapped.cause = e;
    wrapped.stderr = e?.stderr;
    wrapped.stdout = e?.stdout;
    // T180: 上位で isExecTimeout() が wrapped にも反応できるよう転写する
    wrapped.killed = e?.killed;
    wrapped.signal = e?.signal;
    wrapped.code = e?.code;
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

/**
 * テストから tree の実体を差し替えるためのフック（R4）。
 * 未設定時は実 cmux コマンドを呼ぶ。テスト時は `__setTreeImpl()` で差し替える。
 */
let treeImpl: ((workspace?: string) => Promise<string>) | null = null;

/** テスト用: tree の実装を差し替える。`null` で元に戻す。 */
export function __setTreeImpl(impl: ((workspace?: string) => Promise<string>) | null): void {
  treeImpl = impl;
}

export async function tree(workspace?: string): Promise<string> {
  if (treeImpl) return treeImpl(workspace);
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
    await log("error", `getPaneForSurface failed: ${formatSurface(surface, "S")} ${formatExecError(e)}`);
    return undefined;
  }
}

/**
 * PID 生存確認（T195）。
 *
 * `process.kill(pid, 0)` で signal 0 を送信し、プロセス存在を確認する。
 * tree / list-status を使わないため cmux daemon の deadlock 影響を受けない。
 *
 * 注意: PID は OS で再利用されるため、kill(pid, 0) が true を返しても
 * それが元のプロセスとは限らない。Manager 再起動直後は team.json 永続化の
 * pid が別プロセスと衝突する可能性があるが、発生確率は低いため割り切る。
 */
let isAliveImpl: ((pid: number) => boolean) | null = null;

/** テスト用: `isAlive` の実装を差し替える。`null` で元に戻す。 */
export function __setIsAliveImpl(impl: ((pid: number) => boolean) | null): void {
  isAliveImpl = impl;
}

export function isAlive(pid: number): boolean {
  if (isAliveImpl) return isAliveImpl(pid);
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
    await log("error", `setStatus failed: key=${key} value=${value} ${formatExecError(e)}`);
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
