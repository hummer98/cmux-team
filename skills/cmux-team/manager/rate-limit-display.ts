/**
 * dashboard のレート制限行を組み立てる純粋関数モジュール。
 *
 * Rezi / Ink 非依存。色は文字列リテラル（"green" | "yellow" | "red" | "gray"）で返し、
 * 呼び出し側（dashboard.tsx）で RGB にマップする。
 */
import type { RateLimitInfo } from "./schema";
import { isStale } from "./rate-limit-persistence";

export type RateLimitColor = "green" | "yellow" | "red" | "gray";

export interface RateLimitPart {
  text: string;
  color: RateLimitColor;
  /** 親グループの先頭か（dashboard 側が間隔を入れる判定に使う） */
  group?: boolean;
}

export interface RateLimitDisplay {
  parts: RateLimitPart[];
}

/**
 * `.team/rate-limit.json` の内容（または daemon state の rateLimit）を
 * dashboard ヘッダー右端の表示に変換する。
 *
 * - stale なデータでは全パーツを GRAY 化し末尾に `(stale)` を付与する。
 * - `unifiedStatus === "rate_limited"` は non-stale のときだけ赤扱いにする。
 *
 * @param rl daemon state の rateLimit（null 時は `Rate: --`）
 * @param now Unix ミリ秒（テストから注入可能、既定は `Date.now()`）
 */
export function buildRateLimitDisplay(
  rl: RateLimitInfo | null,
  now: number = Date.now(),
): RateLimitDisplay {
  if (!rl) {
    return { parts: [{ text: "Rate: --", color: "gray" }] };
  }

  const stale = isStale(rl, now);

  // unified データあり
  if (rl.unified5hUtilization != null || rl.unified7dUtilization != null) {
    const parts: RateLimitPart[] = [];
    const forceRed = rl.unifiedStatus === "rate_limited" && !stale;

    if (rl.unified5hUtilization != null) {
      const h5 = buildUtilizationBar("5h", rl.unified5hUtilization, rl.unified5hReset, now);
      parts.push(
        ...h5.parts.map((p) => ({
          ...p,
          color: stale ? "gray" : forceRed && p.color !== "gray" ? "red" : p.color,
        } as RateLimitPart)),
      );
    }
    if (rl.unified7dUtilization != null) {
      const d7 = buildUtilizationBar("7d", rl.unified7dUtilization, rl.unified7dReset, now);
      parts.push(
        ...d7.parts.map((p) => ({
          ...p,
          color: stale ? "gray" : forceRed && p.color !== "gray" ? "red" : p.color,
        } as RateLimitPart)),
      );
    }

    if (stale && parts.length > 0) {
      parts.push({ text: "(stale)", color: "gray" });
    }

    return { parts };
  }

  // TPM フォールバック（unified 系と独立した分単位ウィンドウなので stale 判定は適用しない）
  if (rl.tokensLimit === 0) {
    return { parts: [{ text: "Rate: --", color: "gray" }] };
  }
  const pct = Math.round((rl.tokensRemaining / rl.tokensLimit) * 100);
  const barWidth = 10;
  const filled = Math.round((pct / 100) * barWidth);
  const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
  const color: RateLimitColor = pct >= 50 ? "green" : pct >= 20 ? "yellow" : "red";
  return { parts: [{ text: `TPM: ${pct}% ${bar}`, color }] };
}

/** 使用率のプログレスバーを1グループ生成。残り時間は GRAY で別パーツ化する。 */
function buildUtilizationBar(
  label: string,
  utilization: number,
  resetIso: string | null,
  now: number,
): { parts: RateLimitPart[] } {
  const pct = Math.round(utilization * 100);
  const barWidth = 10;
  const filled = Math.round((pct / 100) * barWidth);
  const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);
  const color: RateLimitColor = pct >= 90 ? "red" : pct >= 70 ? "yellow" : "green";
  const parts: RateLimitPart[] = [
    { text: `${label}: ${pct}% ${bar}`, color, group: true },
  ];
  const remaining = formatResetRemaining(resetIso, now);
  if (remaining) {
    parts.push({ text: remaining, color: "gray" });
  }
  return { parts };
}

/** リセットまでの残り時間を 1d4h / 3h12m / 45m 形式で整形（最大2単位）。 */
function formatResetRemaining(resetIso: string | null, now: number): string {
  if (!resetIso) return "";
  const asNum = Number(resetIso);
  const resetMs =
    !isNaN(asNum) && asNum > 1e9 ? asNum * 1000 : new Date(resetIso).getTime();
  if (isNaN(resetMs)) return "";
  const sec = Math.floor((resetMs - now) / 1000);
  if (sec <= 0) return "0m";
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
