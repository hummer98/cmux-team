/**
 * token-format.ts (T323)
 *
 * `cmux-team token list` / `cmux-team pool status` の双方が共有するフォーマッタ。
 * `token-cli.ts` 内の internal 関数を export 化したもの。コピペ重複禁止 / DRY。
 */
import type { Token, UsageSnapshot } from "./token-store";

/** util_5h / util_7d を `82%` / `--` 形式に整形 */
export function formatUtil(val: number | null): string {
  if (val == null) return "--";
  return `${(val * 100).toFixed(0)}%`;
}

/**
 * reset 時刻 ISO 文字列を `5h ago` / `1.5h` / `2.3d` / `now` / `--` に整形。
 * 過去日時は `now` を返す（負の経過は出さない）。
 */
export function formatReset(isoStr: string | null): string {
  if (!isoStr) return "--";
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return "--";
  const now = Date.now();
  const diffMs = d.getTime() - now;
  if (diffMs <= 0) return "now";
  const diffH = diffMs / 3_600_000;
  if (diffH < 24) return `${diffH.toFixed(1)}h`;
  return `${(diffH / 24).toFixed(1)}d`;
}

/**
 * selectable と最新 snapshot から表示用ラベルを返す。
 * - tok.selectable = false → "no"
 * - util_5h > 0.95 → "blocked"（A019 selectable 判定）
 * - それ以外 → "yes"
 */
export function formatSelectable(tok: Token, snap: UsageSnapshot | null): string {
  if (!tok.selectable) return "no";
  const util5h = snap?.util_5h ?? null;
  if (util5h != null && util5h > 0.95) return "blocked";
  return "yes";
}
