/**
 * pool-surface-row.ts (T323 / T351)
 *
 * Master / Conductor / Agent 行のサフィックスを純粋関数で整形する。
 *
 * 警告閾値（display 用）: 5h>80% / 7d>90% / cap<20%
 *   これは A019 の selectable 判定閾値（5h>=95% でブロッカー）とは別。
 *   ブロッカー = pool 選択から外す閾値、警告 = 表示用に注意喚起する閾値。
 *   早めに注意喚起する設計意図のため警告閾値の方が低い（D11 の補足）。
 *
 * この関数は「Master」「Conductor」「Agent」のラベルや先頭インデントは含まない。
 * 呼び出し側でレイアウト責務を持つ。
 *
 * - `formatSurfaceRow`: CLI 用の文字列 API。`[surface] @handle  <5h:X%/7d:Y%>  cap:Z% ⚠`
 *   形式の **`[surface]` を含む** full row 文字列を返す。
 * - `buildSurfaceRowSuffix` (T351): dashboard 用の UiNode[] API。
 *   **`[surface]` を含まない** suffix のみを返し、呼び出し側の `ui.text(surfaceLabel)` の
 *   後ろに spread で append される。surface ラベル描画責務は完全に dashboard 側に残る。
 */
import { ui, rgb } from "@rezi-ui/core";

const YELLOW_VALUE = rgb(200, 160, 0);
const GRAY_VALUE = rgb(130, 130, 130);

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

/**
 * dashboard 用の per-surface サフィックスを UiNode 配列で返す（T351）。
 *
 * - 戻り値先頭に `[surface]` ラベルは **含まない**。dashboard 側が既に独立 node として
 *   描画しているため、この suffix を末尾に spread で append する。
 * - bind 済み: `[ui.text("@kddi"), ui.text("<5h:X%/7d:Y%>"), ui.text("cap:Z%"), ui.text("⚠"?)]`
 *   の順序固定。capPct=null の場合は `cap:Z%` ノードを省略する（既存 formatSurfaceRow と同じ）。
 *   util が両軸 null かつ capPct=null（pool ON だが該当 handle データなし）の場合は
 *   handle と util ノードのみ返す（cap セクションは省略）。
 * - bind なし: `[ui.text("(no token)", { dim })]`
 * - pool OFF の場合は呼び出し元で `[]` を append すれば何も足されない（責務はこの関数側ではなく呼び出し側）
 *
 * 警告閾値は `formatSurfaceRow` と同じ（5h>80% / 7d>90% / cap<20%）。⚠ は YELLOW で末尾追加。
 */
export function buildSurfaceRowSuffix(input: SurfaceRowInput): ReturnType<typeof ui.text>[] {
  // bind なし → "(no token)" のみ。
  if (input.handle == null) {
    return [ui.text("(no token)", { style: { fg: GRAY_VALUE } })];
  }

  const out: ReturnType<typeof ui.text>[] = [];
  out.push(ui.text(input.handle));

  // util 部分: `<5h:X%/7d:Y%>`（null は --）
  const utilPart = `<5h:${formatPct(input.util5h)}/7d:${formatPctTrailing(input.util7d)}>`;
  out.push(ui.text(utilPart, { dim: true }));

  // cap セクション: capPct=null は省略
  if (input.capPct != null) {
    out.push(ui.text(`cap:${Math.round(input.capPct)}%`, { dim: true }));
  }

  // 警告判定（formatSurfaceRow と同条件）
  const u5 = input.util5h ?? 0;
  const u7 = input.util7d ?? 0;
  const warn =
    u5 > UTIL5H_WARN
    || u7 > UTIL7D_WARN
    || (input.capPct != null && input.capPct < CAP_WARN);
  if (warn) {
    out.push(ui.text("⚠", { style: { fg: YELLOW_VALUE } }));
  }

  return out;
}
