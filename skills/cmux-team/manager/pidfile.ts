/**
 * daemon 多重起動防止の pidfile ロック（T259）
 *
 * `.team/daemon.pid` に daemon main.ts プロセスの PID を書き込み、既に
 * 生きている cmux-team daemon があれば 2 回目の `cmux-team start` を
 * fail-stop（exit 1）させる。proxy プロセスは別ライフサイクルで、この
 * pidfile は daemon main.ts プロセスのみを指す。
 *
 * 設計方針:
 *   - writeFile(..., { flag: "wx" }) で atomic に排他取得（O_CREAT|O_EXCL 相当）
 *   - 既存 pidfile が stale（プロセス死亡 or PID 再利用）なら削除して再試行
 *   - stale 判定: isAlive false → 死亡 / alive かつ ps 出力が cmux-team らしくない → PID 再利用
 *   - ps 取得失敗（空文字）時は保守的に "alive cmux-team" 扱いとし fail-stop
 *     （誤って稼働中の daemon を潰さないため）
 */
import { writeFile, unlink, readFile } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import { isAlive as realIsAlive } from "./cmux";
import { log } from "./logger";

const execFileAsync = promisify(execFile);

export { isAlive } from "./cmux";

export class PidFileLockedError extends Error {
  constructor(
    public readonly existingPid: number,
    public readonly workspace: string,
  ) {
    super(
      `Error: daemon already running (pid=${existingPid}) at workspace=${workspace}. ` +
      `Run 'cmux-team stop' or kill ${existingPid} first.`
    );
    this.name = "PidFileLockedError";
  }
}

export interface AcquireOptions {
  retries?: number;
  retryIntervalMs?: number;
  selfPid?: number;
  psCommandImpl?: (pid: number) => Promise<string>;
  isAliveImpl?: (pid: number) => boolean;
}

export async function psCommand(pid: number): Promise<string> {
  if (process.platform === "win32") return "";
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-p", String(pid), "-o", "command="],
      { timeout: 2000 },
    );
    return stdout.toString().trim();
  } catch {
    return "";
  }
}

export function looksLikeCmuxTeamProcess(psOutput: string): boolean {
  if (!psOutput) return false;
  return psOutput.includes("main.ts") || psOutput.includes("cmux-team");
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function readExistingPid(path: string): Promise<number | null> {
  try {
    const content = (await readFile(path, "utf-8")).trim();
    if (!content) return null;
    const parsed = parseInt(content, 10);
    return isNaN(parsed) ? null : parsed;
  } catch {
    return null;
  }
}

export async function acquirePidFile(
  path: string,
  workspace: string,
  opts?: AcquireOptions,
): Promise<void> {
  const retries = opts?.retries ?? 3;
  const retryIntervalMs = opts?.retryIntervalMs ?? 100;
  const selfPid = opts?.selfPid ?? process.pid;
  const psImpl = opts?.psCommandImpl ?? psCommand;
  const aliveImpl = opts?.isAliveImpl ?? realIsAlive;

  let attempt = 0;
  let lastLockedPid: number | null = null;

  while (true) {
    try {
      await writeFile(path, String(selfPid), { flag: "wx" });
      return;
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;

      const existingPid = await readExistingPid(path);

      if (existingPid === null) {
        // 解釈不能（空 / 非数値 / 消滅） → stale とみなして削除 → リトライ
        try { await unlink(path); } catch { /* ENOENT 等は無視 */ }
      } else if (!aliveImpl(existingPid)) {
        // 死亡プロセス → stale → 削除 → リトライ
        try { await unlink(path); } catch { /* ENOENT 等は無視 */ }
      } else {
        // 生きている → cmux-team らしさを ps で判定
        const psOutput = await psImpl(existingPid).catch(() => "");
        if (psOutput === "") {
          // ps 取得失敗：保守的に「生きている cmux-team」扱い → fail-stop
          throw new PidFileLockedError(existingPid, workspace);
        }
        if (looksLikeCmuxTeamProcess(psOutput)) {
          // 生きている cmux-team → locked
          throw new PidFileLockedError(existingPid, workspace);
        }
        // alive だが別プロセス（PID 再利用）→ stale → 削除 → リトライ
        try { await unlink(path); } catch { /* ENOENT 等は無視 */ }
      }

      lastLockedPid = existingPid ?? lastLockedPid;
      attempt++;
      if (attempt > retries) {
        throw new PidFileLockedError(lastLockedPid ?? 0, workspace);
      }
      if (retryIntervalMs > 0) await sleep(retryIntervalMs);
    }
  }
}

export async function releasePidFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (e: any) {
    if (e?.code === "ENOENT") return;
    await log("pidfile_release_failed", `path=${path} error=${e?.message ?? e}`);
  }
}

/**
 * acquirePidFile の薄いラッパー。PidFileLockedError を捕えたら
 * `console.error` + `log("pidfile_locked", ...)` + `process.exit(1)` する。
 * cmdStart の変更行数を最小化するために用意した。
 */
export async function acquireOrExit(
  path: string,
  workspace: string,
  opts?: AcquireOptions,
): Promise<void> {
  try {
    await acquirePidFile(path, workspace, opts);
  } catch (e: any) {
    if (e instanceof PidFileLockedError) {
      console.error(e.message);
      await log("pidfile_locked", `existing_pid=${e.existingPid} workspace=${workspace}`);
      process.exit(1);
    }
    throw e;
  }
}
