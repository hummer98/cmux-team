/**
 * `cmux-team status` の `─ Rate Limit ─` セクション用に、
 * `RateLimitInfo | null` を plain-text 表示行 `string[]` に整形する純粋関数。
 *
 * - CLI 専用（Rezi / Ink 非依存）。dashboard 向け `rate-limit-display.ts` とは
 *   返り値型が異なるため共通化せず分離する（構造的に責務が別）。
 * - 軸別 stale 判定は `isStale5h` / `isStale7d` を再利用する。
 * - 絶対時刻は `toLocaleString("ja-JP", ...)` で locale 固定。タイムゾーンは
 *   ユーザー環境依存（テスト側では相対時刻・プレフィクスのみ検証する）。
 */
import type { RateLimitInfo } from "./schema";
import { isStale5h, isStale7d } from "./rate-limit-persistence";

export function buildRateLimitStatusLines(
  rl: RateLimitInfo | null,
  now: number,
): string[] {
  if (!rl) {
    return ["  (no rate limit data — proxy not running?)"];
  }

  const lines: string[] = [];
  const stale5h = isStale5h(rl, now);
  const stale7d = isStale7d(rl, now);

  if (rl.unified5hUtilization != null) {
    lines.push(buildAxisLine("5h", rl.unified5hUtilization, rl.unified5hReset, stale5h, now));
  }
  if (rl.unified7dUtilization != null) {
    lines.push(buildAxisLine("7d", rl.unified7dUtilization, rl.unified7dReset, stale7d, now));
  }

  lines.push(buildStatusLine(rl.unifiedStatus, rl.updatedAt, now));
  return lines;
}

function buildAxisLine(
  label: string,
  util: number,
  resetIso: string | null,
  stale: boolean,
  now: number,
): string {
  const pct = Math.round(util * 100);
  const bar = buildBar(util, 10);
  const resetMs = parseReset(resetIso);
  const rel = formatRelativeDuration(resetMs, now);
  const abs = formatAbsoluteTime(resetMs);
  const resetPart = rel ? `  reset in ${rel}` : "";
  const absPart = abs ? `  (${abs})` : "";
  const stalePart = stale ? "  (stale)" : "";
  const pctStr = String(pct).padStart(3);
  return `  ${label}: ${pctStr}% ${bar}${resetPart}${absPart}${stalePart}`;
}

function buildStatusLine(
  unifiedStatus: string | null,
  updatedAt: string,
  now: number,
): string {
  let statusText: string;
  if (unifiedStatus == null) {
    statusText = "unknown";
  } else if (unifiedStatus === "rate_limited") {
    statusText = "⚠ rate_limited";
  } else {
    statusText = unifiedStatus;
  }

  const updatedMs = new Date(updatedAt).getTime();
  const ageSec = isNaN(updatedMs) ? null : Math.max(0, Math.floor((now - updatedMs) / 1000));
  const ago = ageSec == null ? "" : formatAgoDuration(ageSec);
  const updatedStale = ageSec != null && ageSec > 60;
  const updatedPart = ago
    ? updatedStale
      ? `  (stale, updated ${ago} ago)`
      : `  (updated ${ago} ago)`
    : "";
  return `  status: ${statusText}${updatedPart}`;
}

/**
 * reset 文字列（unix 秒 string or ISO 8601）をミリ秒に変換する。
 * 解釈不能なら null。`rate-limit-display.ts::formatResetRemaining` と同じ流儀。
 */
function parseReset(resetIso: string | null): number | null {
  if (!resetIso) return null;
  const asNum = Number(resetIso);
  if (!isNaN(asNum) && asNum > 1e9) return asNum * 1000;
  const ms = new Date(resetIso).getTime();
  return isNaN(ms) ? null : ms;
}

/** reset までの残り時間。0 以下は `expired`、<60s は `<1m`、最大 2 単位。 */
function formatRelativeDuration(resetMs: number | null, now: number): string {
  if (resetMs == null) return "";
  const sec = Math.floor((resetMs - now) / 1000);
  if (sec <= 0) return "expired";
  if (sec < 60) return "<1m";
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return m > 0 ? `${h}h${m}m` : `${h}h`;
  }
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  return h > 0 ? `${d}d${h}h` : `${d}d`;
}

/** updatedAt 経過時間の短縮表記（s / m / h / d）。 */
function formatAgoDuration(ageSec: number): string {
  if (ageSec < 60) return `${ageSec}s`;
  if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m`;
  if (ageSec < 86400) return `${Math.floor(ageSec / 3600)}h`;
  return `${Math.floor(ageSec / 86400)}d`;
}

/** ja-JP ロケールで絶対時刻を `YYYY/MM/DD HH:mm` 形式に整形。 */
function formatAbsoluteTime(resetMs: number | null): string {
  if (resetMs == null) return "";
  try {
    return new Date(resetMs).toLocaleString("ja-JP", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function buildBar(util: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, util));
  const pct = Math.round(clamped * 100);
  const filled = Math.round((pct / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}
