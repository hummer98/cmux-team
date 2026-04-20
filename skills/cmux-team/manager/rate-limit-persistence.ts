/**
 * RateLimitInfo を `.team/rate-limit.json` に永続化・復元する。
 *
 * - daemon 再起動時の stale 判定・throttle 抑止のために使う。
 * - `task.ts` の `saveTaskState` と同じ atomic write（.tmp → rename）。
 * - 破損 JSON / フィールド型不一致は `safeParse` で検出して null フォールバック。
 */
import { readFile, writeFile, rename } from "fs/promises";
import { join } from "path";
import { RateLimitInfoSchema } from "./schema";
import type { RateLimitInfo } from "./schema";
import { log } from "./logger";

const RATE_LIMIT_FILE = ".team/rate-limit.json";

export function rateLimitPath(projectRoot: string): string {
  return join(projectRoot, RATE_LIMIT_FILE);
}

/**
 * RateLimitInfo を atomic に書き出す。
 * proxy からは fire-and-forget で呼ばれるため、失敗時の扱いは呼び出し側に委ねる。
 */
export async function persistRateLimit(
  projectRoot: string,
  info: RateLimitInfo,
): Promise<void> {
  const filePath = rateLimitPath(projectRoot);
  const tmpPath = filePath + ".tmp";
  await writeFile(tmpPath, JSON.stringify(info, null, 2) + "\n");
  await rename(tmpPath, filePath);
}

/**
 * `.team/rate-limit.json` を読み込んで Zod スキーマで検証する。
 * 失敗系（ファイルなし / 破損 JSON / 型不一致 / 必須欠落）は null を返し、
 * ファイル不在以外はログを残す。
 */
export async function loadRateLimit(
  projectRoot: string,
): Promise<RateLimitInfo | null> {
  const filePath = rateLimitPath(projectRoot);
  let raw: string;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return null;
    await log("rate_limit_persist_failed", `load: read ${e.message}`);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    await log("rate_limit_persist_failed", `load: parse ${e.message}`);
    return null;
  }

  const result = RateLimitInfoSchema.safeParse(parsed);
  if (!result.success) {
    await log(
      "rate_limit_persist_failed",
      `load: schema ${result.error.issues.map((i) => `${i.path.join(".")}:${i.code}`).join(",")}`,
    );
    return null;
  }
  return result.data;
}

/**
 * 5h 軸の stale 判定（軸独立 / T281）。
 *
 * - `rl` が null / undefined → true
 * - `unified5hReset` が null / 過去 / 解釈不能 → true
 * - `unified5hReset` が未来 → false
 *
 * 7d 側の状態（`unified7dReset`）には一切影響されない。
 * daemon の throttle ガード・dashboard の throttle 表示・proxy の `/rate-limit`
 * エンドポイントなど「5h reset だけを見たい」箇所で使う。
 *
 * 注: 7d 軸については {@link isStale7d} を使う。**assignment ガードは 5h のみ**で、
 * `unified7dUtilization` が高値でも throttle は発動しない（観測のみ）。
 *
 * @param rl 観測値（null は stale 扱い）
 * @param now Unix ミリ秒（テストから注入可能、デフォルトは `Date.now()`）
 */
export function isStale5h(
  rl: RateLimitInfo | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!rl) return true;
  const nowSec = Math.floor(now / 1000);
  return !isFuture(rl.unified5hReset, nowSec);
}

/**
 * 7d 軸の stale 判定（軸独立 / T281）。
 *
 * - `rl` が null / undefined → true
 * - `unified7dReset` が null / 過去 / 解釈不能 → true
 * - `unified7dReset` が未来 → false
 *
 * 5h 側の状態には影響されない。現状は dashboard の 7d バー表示にのみ使う
 * （7d throttle ガードは未実装）。
 */
export function isStale7d(
  rl: RateLimitInfo | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!rl) return true;
  const nowSec = Math.floor(now / 1000);
  return !isFuture(rl.unified7dReset, nowSec);
}

/**
 * reset 文字列（unix 秒数値 or ISO 8601）が未来かどうかを判定する。
 * null / 解釈不能 / 過去は false。
 */
function isFuture(reset: string | null | undefined, nowSec: number): boolean {
  if (!reset) return false;
  const asNum = Number(reset);
  if (!isNaN(asNum) && asNum > 1e9) {
    return asNum > nowSec;
  }
  const ms = new Date(reset).getTime();
  if (isNaN(ms)) return false;
  return Math.floor(ms / 1000) > nowSec;
}
