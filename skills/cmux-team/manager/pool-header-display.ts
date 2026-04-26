/**
 * pool-header-display.ts (T363)
 *
 * dashboard ヘッダー右側に pool capacity を表示するための parts 組み立て純粋関数。
 *
 * `pool-status-header.ts` (CLI 用 `string[]` ボックス API) と異なり、本ファイルは
 * TUI 用 `RateLimitPart[]` 構造データを返す。dashboard.tsx 側は本関数の戻り値と
 * `buildRateLimitDisplay` の戻り値を同じループで描画できる。
 *
 * 色閾値（docs/spec/09-token-pool.md / 既存 buildPoolHeader と一致）:
 *   - capacityPct >= 100% → green
 *   - 40% 〜 100%        → yellow
 *   - < 40%              → red
 */
import type { PoolSummary } from "./pool-summary";
import type { RateLimitPart } from "./rate-limit-display";

export interface PoolHeaderDisplay {
  parts: RateLimitPart[];
}

export function buildPoolHeaderDisplay(
  summary: PoolSummary | null,
): PoolHeaderDisplay {
  if (summary == null) return { parts: [] };

  const capPct = summary.header.capacityPct;
  const capColor: RateLimitPart["color"] =
    capPct >= 100 ? "green" : capPct >= 40 ? "yellow" : "red";

  const parts: RateLimitPart[] = [
    {
      text: `pool capacity: ${Math.round(capPct)}%`,
      color: capColor,
      group: true,
    },
  ];

  const next = summary.header.nextReset;
  if (next) {
    const remain = formatRelativeDuration(next.remainingMs);
    const sign = next.deltaPct >= 0 ? "+" : "";
    parts.push({
      text: `next reset: ${next.handle} ${next.window} in ${remain}  (${sign}${next.deltaPct} pts)`,
      color: "gray",
    });
  }

  return { parts };
}

/**
 * remainingMs を `<1m` / `30m` / `2h` / `2h30m` / `3d2h` 流に整形する。
 * `pool-status-header.ts::formatRelativeDuration` と等価（cross-validate by test）。
 */
function formatRelativeDuration(remainingMs: number): string {
  const sec = Math.floor(remainingMs / 1000);
  if (sec <= 0) return "<1m";
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
