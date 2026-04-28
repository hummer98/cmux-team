/**
 * pool-header-display.ts (T374 / A024)
 *
 * dashboard ヘッダー右側に pool capacity を表示するための parts 組み立て純粋関数。
 *
 * 旧 (T363/T366) の `pool capacity: 5h NN% / 7d NN%` 二値表示は撤去。
 * 新仕様: A024 §TUI 表示の `pool 7d <spark>  next: @handle 5h:NN%` 形式。
 *
 * `pool-status-header.ts` (CLI 用 `string[]` API) と表示文言を一致させるため
 * `mapBarToSparkline` / `pickSparklineColor` / `pickNextUtilColor` を共有する。
 *
 * dashboard.tsx 側は本関数の戻り値と `buildRateLimitDisplay` の戻り値を同じループで描画できる。
 */
import type { PoolSummary } from "./pool-summary";
import type { PeekedToken } from "./token-store";
import type { RateLimitPart } from "./rate-limit-display";
import {
  mapBarToSparkline,
  pickSparklineColor,
  pickNextUtilColor,
} from "./pool-status-header";

export interface PoolHeaderDisplay {
  parts: RateLimitPart[];
}

export function buildPoolHeaderDisplay(
  summary: PoolSummary | null,
): PoolHeaderDisplay {
  if (summary == null) return { parts: [] };

  const parts: RateLimitPart[] = [];
  const f = summary.forecast7d;

  // 1) "pool 7d" ラベル + spark (contributingTokens > 0 のみ)
  if (f.contributingTokens > 0) {
    const spark = f.bars.map(mapBarToSparkline).join("");
    const color = pickSparklineColor(f.bars);
    parts.push({ text: `pool 7d  ${spark}`, color, group: true });
  }

  // 2) next: @handle 5h:NN%
  parts.push(buildNextPart(summary.nextCandidate));

  return { parts };
}

function buildNextPart(next: PeekedToken | null): RateLimitPart {
  if (next == null) {
    return { text: "next: ⚠ no eligible account", color: "yellow", group: true };
  }
  if (next.util_5h == null) {
    return { text: `next: ${next.handle} 5h:—`, color: "gray", group: true };
  }
  const pct = Math.round(next.util_5h * 100);
  return {
    text: `next: ${next.handle} 5h:${pct}%`,
    color: pickNextUtilColor(next.util_5h),
    group: true,
  };
}
