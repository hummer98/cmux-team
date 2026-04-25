/**
 * pool-surface-row.ts (T323)
 *
 * Master / Conductor / Agent 行のサフィックスを純粋関数で整形する。
 *
 * 警告閾値（display 用）: 5h>80% / 7d>90% / cap<20%
 *   これは A019 の selectable 判定閾値（5h>=95% でブロッカー）とは別。
 *   ブロッカー = pool 選択から外す閾値、警告 = 表示用に注意喚起する閾値。
 *   早めに注意喚起する設計意図のため警告閾値の方が低い（D11 の補足）。
 *
 * この関数は「Master」「Conductor」「Agent」のラベルや先頭インデントは含まない。
 * 呼び出し側でレイアウト責務を持つ。返すのは
 *   `[surface] @handle  <5h:X%/7d:Y%>  cap:Z% ⚠`
 * のサフィックス文字列。
 */

export interface SurfaceRowInput {
  /** "surface:123" 形式（または raw 値） */
  surface: string;
  /** undefined のとき "(no token)" 表記 */
  handle?: string;
  /** 0..1。null は `--` 表記 */
  util5h: number | null;
  /** 0..1。null は `--` 表記 */
  util7d: number | null;
  /** per-token cap_pct（pool 全体ではない）。null はセクションごと省略 */
  capPct: number | null;
}

const UTIL5H_WARN = 0.80;
const UTIL7D_WARN = 0.90;
const CAP_WARN = 20;

export function formatSurfaceRow(input: SurfaceRowInput): string {
  const surfaceLabel = `[${stripSurfacePrefix(input.surface)}]`;

  if (input.handle == null) {
    return `${surfaceLabel} (no token)`;
  }

  // 表記: 値あり → "<5h:10%/7d:30%>"、両軸 null → "<5h:--/7d:--%>"（D9 の表記に従う）
  const utilPart = `<5h:${formatPct(input.util5h)}/7d:${formatPctTrailing(input.util7d)}>`;
  // cap セクション
  const capPart = input.capPct == null ? "" : `  cap:${Math.round(input.capPct)}%`;

  // 警告判定
  const u5 = input.util5h ?? 0;
  const u7 = input.util7d ?? 0;
  const warn =
    u5 > UTIL5H_WARN
    || u7 > UTIL7D_WARN
    || (input.capPct != null && input.capPct < CAP_WARN);
  const warnPart = warn ? "  ⚠" : "";

  return `${surfaceLabel} ${input.handle}  ${utilPart}${capPart}${warnPart}`;
}

function stripSurfacePrefix(s: string): string {
  return s.startsWith("surface:") ? s.slice("surface:".length) : s;
}

function formatPct(util: number | null): string {
  if (util == null) return "--";
  return `${Math.round(util * 100)}%`;
}

// 7d 側は D9 表記で末尾 % が常に付くため null でも `--%` を返す
function formatPctTrailing(util: number | null): string {
  if (util == null) return "--%";
  return `${Math.round(util * 100)}%`;
}
