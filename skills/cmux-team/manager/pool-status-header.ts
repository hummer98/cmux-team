/**
 * pool-status-header.ts (T374 / A024)
 *
 * `cmux-team status` 出力のヘッダー直後に表示する 1 行の forecast + next 候補表示を
 * 純粋関数で組み立てる。
 *
 * 旧 (T323/T366) の固定幅ボックス + capacity 二値表示は撤去（A024 §確定事項）。
 *
 * 表示例:
 *   pool 7d  ██▇▅▅▆█   next: @kddi 5h:65%
 *
 * - 7d スパークライン: 8 段マッピング（A024 §TUI 表示）
 *   - 0–12.5%: ` ` / 12.5–25%: ▁ / 25–37.5%: ▂ / 37.5–50%: ▃
 *   - 50–62.5%: ▄ / 62.5–75%: ▅ / 75–87.5%: ▆ / 87.5–100%: ▇
 *   - ≥100%: █
 * - 色（min(bar(d) for d=0..6) ベース、CLI は plain string で出力）:
 *   - ≥100% : green / 70–100%: yellow / <70% : red
 *
 * `mapBarToSparkline` / `pickSparklineColor` は `pool-header-display.ts` でも使うため export。
 */

import type { Pool7dForecast } from "./forecast";
import type { PeekedToken } from "./token-store";

export type SparklineCell = " " | "▁" | "▂" | "▃" | "▄" | "▅" | "▆" | "▇" | "█";

export interface PoolHeaderInput {
  forecast7d: Pool7dForecast;
  nextCandidate: PeekedToken | null;
}

/**
 * 1 行のヘッダー文字列配列を返す（CLI 用、色なし）。
 *
 * - input=null → []
 * - forecast7d.contributingTokens===0 → spark 省略、`next: ...` のみ（A024 §エッジケース）
 * - nextCandidate=null → `next: ⚠ no eligible account`
 * - util_5h=null → `next: @handle 5h:—`
 */
export function buildPoolHeaderLines(input: PoolHeaderInput | null): string[] {
  if (input == null) return [];
  const sparkPart = formatSparkPart(input.forecast7d);
  const nextPart = formatNextPart(input.nextCandidate);
  if (sparkPart === null) {
    return [nextPart];
  }
  return [`${sparkPart}  ${nextPart}`];
}

/**
 * forecast7d.bars を 7 セルのスパークラインに変換する。
 * contributingTokens===0 のとき null を返す（呼び出し側で省略）。
 */
function formatSparkPart(forecast: Pool7dForecast): string | null {
  if (forecast.contributingTokens === 0) return null;
  const spark = forecast.bars.map(mapBarToSparkline).join("");
  return `pool 7d  ${spark}`;
}

function formatNextPart(next: PeekedToken | null): string {
  if (next == null) return "next: ⚠ no eligible account";
  if (next.util_5h == null) return `next: ${next.handle} 5h:—`;
  const pct = Math.round(next.util_5h * 100);
  return `next: ${next.handle} 5h:${pct}%`;
}

/**
 * bar 高さ（%）を 8 段スパークライン文字に変換する（A024 §TUI 表示と整合）。
 *
 * - >= 100: cap (`█`)
 * - < 0: 異常値防御（` `）
 * - 0..100 を 8 段に区切り、境界値は上位 cell に倒す
 *
 * lookup table ではなく `if` チェイン採用（境界値判定の明示性 + off-by-one リスク回避）。
 */
export function mapBarToSparkline(barPct: number): SparklineCell {
  if (barPct >= 100) return "█";
  if (barPct < 0) return " ";
  if (barPct < 12.5) return " ";
  if (barPct < 25) return "▁";
  if (barPct < 37.5) return "▂";
  if (barPct < 50) return "▃";
  if (barPct < 62.5) return "▄";
  if (barPct < 75) return "▅";
  if (barPct < 87.5) return "▆";
  return "▇"; // [87.5, 100)
}

/**
 * `min(bar(d) for d=0..6)` ベースの色閾値（A024 §TUI 表示）。
 *
 * - >= 100: green
 * - 70..100: yellow
 * - < 70: red
 *
 * bars が空配列のときは red（防御）。
 */
export function pickSparklineColor(bars: number[]): "green" | "yellow" | "red" {
  if (bars.length === 0) return "red";
  const m = Math.min(...bars);
  if (m >= 100) return "green";
  if (m >= 70) return "yellow";
  return "red";
}

/**
 * next 候補の 5h util 色を返す（A024 §5h util の色）。
 *
 * - util_5h=null → "gray"（snapshot 待ち）
 * - >0.95 → "red"（実質 blocker）
 * - >0.70 → "yellow"
 * - それ以下 → "green"
 *
 * `pool-header-display.ts` の Ink 表示で使う。CLI 側 `buildPoolHeaderLines` は色を出さない。
 */
export function pickNextUtilColor(
  util_5h: number | null,
): "green" | "yellow" | "red" | "gray" {
  if (util_5h == null) return "gray";
  if (util_5h > 0.95) return "red";
  if (util_5h > 0.70) return "yellow";
  return "green";
}
