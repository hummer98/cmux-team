/**
 * token-format.ts (T323)
 *
 * `cmux-team token list` / `cmux-team pool status` の双方が共有するフォーマッタ。
 * `token-cli.ts` 内の internal 関数を export 化したもの。コピペ重複禁止 / DRY。
 */
import { computeEffUtil, type Token, type UsageSnapshot } from "./token-store";

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

/**
 * per-handle 行の 5H/7D 列とマーカーを組み立てる（T390）。
 *
 * - util 値は `computeEffUtil` の effUtil（stale 救済反映後）を `formatUtil` で % 表示する。
 *   admit / throttle 判定と表示が同一値で一致するため、`pool status` と `spawn-agent` で
 *   選ばれる値の乖離が構造的に発生しない。
 * - snap が存在し、reset 通過済みの軸が 1 つでもあれば marker = "*" を返す。
 *   呼び出し側で凡例 `(* = reset 通過済みで実質クリア)` を出すことを想定。
 * - snap=null は `formatUtil(null)="--"` 相当を返し、marker は空文字。
 * - padEnd は呼び出し側 (pool-cli.ts / token-cli.ts) が決定する。
 */
export function formatPerHandleUtilCell(
  snap: UsageSnapshot | null,
  nowMs: number,
): { display5h: string; display7d: string; marker: string } {
  const eff = computeEffUtil(snap, nowMs);
  if (!eff.hasSnapshot) {
    return { display5h: "--", display7d: "--", marker: "" };
  }
  const display5h = formatUtil(eff.effUtil5h);
  const display7d = formatUtil(eff.effUtil7d);
  const marker = eff.reset5hPassed || eff.reset7dPassed ? "*" : "";
  return { display5h, display7d, marker };
}
