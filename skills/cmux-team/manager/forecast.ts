/**
 * forecast.ts (T374 / A024)
 *
 * 今後 7 日（Day 0..6）の pool capacity 日次割当 forecast を bin 毎の bar 配列で返す純関数。
 * dashboard / status header のスパークライン表示に使う。
 *
 * 計算式は A024 §計算式 と一致:
 *
 *   rate_i(t) =
 *     t < hoursToReset_i  → (1 - util_7d_i) / hoursToReset_i        # reset 前: 残量 / 残時間
 *     t >= hoursToReset_i → 1 / 168                                  # reset 後: sustainable pace
 *
 *   alloc_i([a, b]) =
 *     b <= reset_i      : (b - a) * rate_pre_i
 *     a >= reset_i      : (b - a) / 168
 *     bin straddles     : (reset - a) * rate_pre + (b - reset) / 168
 *
 *   pool(d)  = Σ alloc_i(bin_d) * plan_ratio_i
 *   denom(d) = (bin_hours_d / 168) * Σ plan_ratio_i
 *   bar(d)   = pool(d) / denom(d) * 100   # 100% = sustainable pace
 *
 * Day 0 の bin は `[now, 今日 24:00 (local)]` の残り時間のみ（可変幅）。Day 1..6 は固定 24h。
 *
 * timezone は引数で受け取る純関数（R3）。本番呼び出し側 (pool-summary.ts) は
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` でランタイム TZ を解決して渡す。
 * test 側は `"UTC"` 等を直接注入できる。
 */

import { parseResetEpochMs } from "./token-store";

export const FORECAST_DAYS = 7 as const;
export const FULL_WEEK_HOURS = 168 as const;

/** Day 0..6 の bar 高さ（0..∞、% 単位）。100 で sustainable pace 同等、>100 は cap 表現で頭打ちに使う。 */
export interface Pool7dForecast {
  /** 長さ FORECAST_DAYS。NaN や負値は出さない */
  bars: number[];
  /** 計算に有効寄与した token 数（plan_ratio!=null かつ selectable=true かつ util_7d/reset_7d_at non-null）。0 なら全 cell が 0 */
  contributingTokens: number;
}

/** A024 §エッジケース「selectable=false は denom にも入れない」のため、policy 適用後の token を入力する */
export interface ForecastTokenInput {
  handle: string;
  plan_ratio: number | null;
  util_7d: number | null;
  reset_7d_at: string | null;
  selectable: boolean;
}

interface EligibleToken {
  plan_ratio: number;
  util_7d: number;
  hoursToReset: number; // >= 0（過去 reset は 0 に正規化）
}

interface BinRange {
  startH: number;
  endH: number;
}

/**
 * 7 日分の bin range を組み立てる純関数。
 *
 * Day 0 は now から「指定 TZ における当日 24:00（=翌日 00:00）」までの残り時間。
 * Day 1..6 は固定 24h。`Intl.DateTimeFormat` で TZ の time-of-day を取得するため
 * process TZ や JS Date のローカル変換に依存しない。
 *
 * DST 切替日は当該 TZ で物理的に Day 0 が 23h or 25h になりうるが、
 * A024 §確定事項「Day 0 は残り時間のみ（可変幅）」と整合する（許容誤差 ±1% 内）。
 */
function buildBinRanges(nowIso: string, timezone: string): BinRange[] {
  const now = new Date(nowIso);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = fmt.formatToParts(now);
  const hh = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const mm = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const ss = Number(parts.find((p) => p.type === "second")?.value ?? "0");
  const secsSinceMidnight = hh * 3600 + mm * 60 + ss;
  const day0Hours = (86_400 - secsSinceMidnight) / 3600;

  const bins: BinRange[] = [{ startH: 0, endH: day0Hours }];
  for (let d = 1; d < FORECAST_DAYS; d++) {
    bins.push({
      startH: day0Hours + 24 * (d - 1),
      endH: day0Hours + 24 * d,
    });
  }
  return bins;
}

/**
 * `reset_7d_at` を now 起点の経過時間（hour）に変換する。
 * 過去 reset は 0 を返す（post-reset rate を全 bin に適用）。
 * 解釈不能なら NaN を返す（呼び出し側で除外）。
 */
function hoursToReset(resetIso: string, nowMs: number): number {
  const resetMs = parseResetEpochMs(resetIso);
  if (!Number.isFinite(resetMs)) return NaN;
  const deltaH = (resetMs - nowMs) / 3_600_000;
  return Math.max(deltaH, 0);
}

function isEligible(t: ForecastTokenInput, nowMs: number): EligibleToken | null {
  if (t.plan_ratio == null) return null;
  if (!t.selectable) return null;
  if (t.util_7d == null) return null;
  if (t.reset_7d_at == null) return null;
  const h = hoursToReset(t.reset_7d_at, nowMs);
  if (!Number.isFinite(h)) return null;
  return { plan_ratio: t.plan_ratio, util_7d: t.util_7d, hoursToReset: h };
}

/**
 * bin [a, b] における allocation 積分（A024 §計算式）。
 *
 * - reset = 0 のとき pre rate は計算不能（0 除算）だが、isEligible で hoursToReset=0 を許容しているため
 *   その場合は a >= reset (=0) が常に成立し case "post-reset" にフォールスルーする。
 */
function integrateBin(
  t: EligibleToken,
  binStart: number,
  binEnd: number,
): number {
  const reset = t.hoursToReset;
  const remaining = 1 - t.util_7d;
  const postRate = 1 / FULL_WEEK_HOURS;

  if (binStart >= reset) {
    // case 2: 完全に post-reset
    return (binEnd - binStart) * postRate;
  }
  if (binEnd <= reset) {
    // case 1: 完全に pre-reset
    const preRate = remaining / reset;
    return (binEnd - binStart) * preRate;
  }
  // case 3: bin が reset を straddle する
  const preRate = remaining / reset;
  return (reset - binStart) * preRate + (binEnd - reset) * postRate;
}

export function computePool7dForecast(
  tokens: ForecastTokenInput[],
  nowIso: string,
  timezone?: string,
): Pool7dForecast {
  const tz =
    timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const nowMs = new Date(nowIso).getTime();

  const eligibles: EligibleToken[] = [];
  for (const t of tokens) {
    const e = isEligible(t, nowMs);
    if (e !== null) eligibles.push(e);
  }
  if (eligibles.length === 0) {
    return { bars: Array<number>(FORECAST_DAYS).fill(0), contributingTokens: 0 };
  }

  const bins = buildBinRanges(nowIso, tz);
  const sumPlanRatio = eligibles.reduce((acc, t) => acc + t.plan_ratio, 0);

  const bars = bins.map((bin) => {
    const binHours = bin.endH - bin.startH;
    let pool = 0;
    for (const t of eligibles) {
      const alloc = integrateBin(t, bin.startH, bin.endH);
      pool += alloc * t.plan_ratio;
    }
    const denom = (binHours / FULL_WEEK_HOURS) * sumPlanRatio;
    if (denom <= 0) return 0;
    const bar = (pool / denom) * 100;
    return bar < 0 ? 0 : bar;
  });

  return { bars, contributingTokens: eligibles.length };
}
