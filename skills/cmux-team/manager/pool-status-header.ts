/**
 * pool-status-header.ts (T323)
 *
 * `cmux-team status` 出力のヘッダー直後に表示する token pool ボックスを
 * 純粋関数で組み立てる。`rate-limit-status.ts` の流儀に準拠。
 *
 * 罫線は固定幅 60 文字（既存セクションヘッダー `─ Master ──...` と幅一致 / D10）。
 */

export interface PoolHeaderNextReset {
  handle: string;
  window: "5h" | "7d";
  remainingMs: number;
  deltaPct: number;
}

export interface PoolHeaderInput {
  capacityPct: number;
  nextReset: PoolHeaderNextReset | null;
}

const BOX_WIDTH = 60;

export function buildPoolHeaderLines(input: PoolHeaderInput | null): string[] {
  if (input == null) return [];

  const lines: string[] = [];
  lines.push(buildTopBorder());
  lines.push(buildContentLine(`pool capacity: ${Math.round(input.capacityPct)}%`));
  if (input.nextReset) {
    const r = input.nextReset;
    const remain = formatRelativeDuration(r.remainingMs);
    const sign = r.deltaPct >= 0 ? "+" : "";
    const text = `next reset: ${r.handle} ${r.window} in ${remain}  (${sign}${r.deltaPct} pts)`;
    lines.push(buildContentLine(text));
  }
  lines.push(buildBottomBorder());
  return lines;
}

function buildTopBorder(): string {
  // "┌─ token pool " label を含む top border
  const label = " token pool ";
  // ┌ + ─ + label + remaining ─ + ┐
  const remaining = BOX_WIDTH - 2 /* 角 2 */ - 1 /* 先頭 ─ */ - label.length;
  return "┌─" + label + "─".repeat(Math.max(remaining, 0)) + "┐";
}

function buildBottomBorder(): string {
  return "└" + "─".repeat(BOX_WIDTH - 2) + "┘";
}

function buildContentLine(text: string): string {
  // "│ " + text + padding + " │" で BOX_WIDTH
  const inner = BOX_WIDTH - 2; // 両端の │
  const padded = (" " + text).padEnd(inner, " ");
  // 念のため inner を超えたら truncate
  const fitted = padded.length > inner ? padded.slice(0, inner) : padded;
  return "│" + fitted + "│";
}

/**
 * remainingMs を `<1m` / `30m` / `2h` / `2h30m` / `3d2h` 流に整形する。
 * `rate-limit-status.ts::formatRelativeDuration` の流儀と一致。
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
