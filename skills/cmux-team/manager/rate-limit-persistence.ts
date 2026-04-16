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
 * 観測値が stale かどうかを判定する。
 *
 * - `unified5hReset` / `unified7dReset` のいずれかが未来にある間は non-stale。
 * - 両方 null、両方過去、片方過去 + 片方 null は stale。
 * - stale 判定は `unifiedStatus` に依存しない。
 *
 * @param rl 観測値（null は stale 扱い）
 * @param now Unix ミリ秒（テストから注入可能、デフォルトは `Date.now()`）
 */
export function isStale(
  rl: RateLimitInfo | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!rl) return true;
  const nowSec = Math.floor(now / 1000);
  const has5hFuture = isFuture(rl.unified5hReset, nowSec);
  const has7dFuture = isFuture(rl.unified7dReset, nowSec);
  return !(has5hFuture || has7dFuture);
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
