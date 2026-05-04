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
import { writeFile, unlink as realUnlink, readFile, mkdir } from "fs/promises";
import { readFileSync, unlinkSync } from "fs";
import { dirname } from "path";
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
      `kill ${existingPid} first, or close the cmux session (daemon auto-stops on cmux exit).`
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
  // T423 S5: stale 判定の事後追跡用にログ DI を追加（既存 DI パターンと一貫）
  logImpl?: (event: string, detail: string) => Promise<void>;
  // T425 minor #1: stale unlink の異常系を観測可能にするためテスト用 DI
  unlinkImpl?: (path: string) => Promise<void>;
}

// T425 minor #1: stale 削除の共通ヘルパ。ENOENT は並行 unlink 想定で silent return、
// それ以外（EBUSY / EPERM 等）は error_code 付きで pidfile_unlink_failed をログする。
async function removeStalePidFile(
  path: string,
  unlinkImpl: (path: string) => Promise<void>,
  logImpl: (event: string, detail: string) => Promise<void>,
): Promise<void> {
  try {
    await unlinkImpl(path);
  } catch (e: any) {
    if (e?.code === "ENOENT") return;
    await logImpl(
      "pidfile_unlink_failed",
      `path=${path} error_code=${e?.code ?? ""} error=${e?.message ?? e}`,
    );
  }
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

// T423 S2: cmux-team プロセスかどうかを 3 パターン OR で厳密判定する。
// 旧実装の `includes("main.ts") || includes("cmux-team")` は過寛容で、無関係な
// main.ts や substring "cmux-team" を含む別プロセスを誤って "cmux-team" と判定していた。
//   1. /skills/cmux-team/manager/main.ts(\s|$)  — dev / source 起動
//   2. /bin/cmux-team(\s|$)                      — npm global / Homebrew Cellar の bin
//   3. (^|\s)cmux-team(\s|$)                     — PATH 経由で arg0 として渡るケース
const CMUX_TEAM_PROCESS_PATTERNS: readonly RegExp[] = [
  /\/skills\/cmux-team\/manager\/main\.ts(\s|$)/,
  /\/bin\/cmux-team(\s|$)/,
  /(^|\s)cmux-team(\s|$)/,
];

export function looksLikeCmuxTeamProcess(psOutput: string): boolean {
  if (!psOutput) return false;
  return CMUX_TEAM_PROCESS_PATTERNS.some((re) => re.test(psOutput));
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
  const logImpl = opts?.logImpl ?? log;
  const unlinkImpl = opts?.unlinkImpl ?? realUnlink;

  // T287: pidfile の格納先（通常は <workspace>/.team/）が存在しない場合に備えて
  // 先に recursive mkdir する。新規フォルダ（git init 直後で .team/ 未作成）で
  // cmux-team start を実行すると、daemon.ts:initInfra より前に pidfile 取得が
  // 走るため ENOENT になる問題（T287）への対処。recursive:true なので既存時は no-op。
  await mkdir(dirname(path), { recursive: true });

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
        // T423 S5: 事後追跡用に reason 付きでログする
        await logImpl(
          "pidfile_stale_detected",
          `existing_pid=unparseable reason=unparseable`,
        );
        await removeStalePidFile(path, unlinkImpl, logImpl);
      } else if (!aliveImpl(existingPid)) {
        // 死亡プロセス → stale → 削除 → リトライ
        // T423 S5: 事後追跡用に reason 付きでログする
        await logImpl(
          "pidfile_stale_detected",
          `existing_pid=${existingPid} reason=dead`,
        );
        await removeStalePidFile(path, unlinkImpl, logImpl);
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
        // T423 S5: 再発時にどの別プロセスが PID を奪ったか追跡できるよう ps_output (truncated) を付与
        const truncatedPs = psOutput.slice(0, 80);
        await logImpl(
          "pidfile_stale_detected",
          `existing_pid=${existingPid} reason=pid_reused ps_output=${truncatedPs}`,
        );
        await removeStalePidFile(path, unlinkImpl, logImpl);
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
    await realUnlink(path);
  } catch (e: any) {
    if (e?.code === "ENOENT") return;
    await log("pidfile_release_failed", `path=${path} error=${e?.message ?? e}`);
  }
}

/**
 * T423 S3: uncaughtException / unhandledRejection / exit 時に pidfile を
 * PID-aware で cleanup する crash handler を install する。
 *
 * SIGINT / SIGTERM 経路は既存の `shutdown()` が `releasePidFile` を呼ぶが、
 * 異常終了 (uncaughtException / unhandledRejection) や normal exit 時には
 * pidfile が残置されていた。本 handler はそれらを補填する。
 *
 * **PID-aware が必須**: S1 (reload) では親が `releasePidFile` → spawn 子 →
 * 子が `acquirePidFile` (子の PID で書く) → 親 `process.exit(0)` の順で
 * 動く。親の exit handler が pidfile を無条件 unlink すると子の正当な
 * pidfile を消してしまう (race)。content と self pid を比較して一致時のみ
 * unlink することで、reload sequence でも安全に動く。
 *
 * `process.on("exit")` は sync コンテキスト限定なので readFileSync /
 * unlinkSync を使う。async log は呼べないので、ENOENT 以外のエラーは
 * stderr にだけ出す。
 *
 * @returns uninstall function — handler を `process.removeListener` する
 */
export interface CrashHandlerOptions {
  exitImpl?: (code: number) => void;
  selfPid?: number;
}

export function installCrashHandler(
  pidFilePath: string,
  opts?: CrashHandlerOptions,
): () => void {
  const exitImpl = opts?.exitImpl ?? ((code: number) => process.exit(code));
  const selfPid = opts?.selfPid ?? process.pid;
  const selfPidStr = String(selfPid);

  const cleanup = (): void => {
    let content: string;
    try {
      content = readFileSync(pidFilePath, "utf8").trim();
    } catch (e: any) {
      if (e?.code === "ENOENT") return;
      console.error(
        `[cmux-team] pidfile crash cleanup read failed: ${e?.message ?? e}`,
      );
      return;
    }
    if (content !== selfPidStr) {
      // 自分が書いた pidfile ではない（reload で子が上書きした場合等）→ 削除しない
      return;
    }
    try {
      unlinkSync(pidFilePath);
    } catch (e: any) {
      if (e?.code === "ENOENT") return;
      console.error(
        `[cmux-team] pidfile crash cleanup unlink failed: ${e?.message ?? e}`,
      );
    }
  };

  const exitHandler = (): void => {
    cleanup();
  };
  const fatalHandler = (err: unknown): void => {
    cleanup();
    if (err) console.error(err);
    exitImpl(1);
  };

  process.on("exit", exitHandler);
  process.on("uncaughtException", fatalHandler);
  process.on("unhandledRejection", fatalHandler);

  return (): void => {
    process.removeListener("exit", exitHandler);
    process.removeListener("uncaughtException", fatalHandler);
    process.removeListener("unhandledRejection", fatalHandler);
  };
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
