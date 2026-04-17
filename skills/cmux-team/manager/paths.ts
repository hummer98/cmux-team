/**
 * 共通パスユーティリティ（T234）。
 *
 * surface 名のパス用正規化など、master.ts / daemon.ts で重複していた小さなヘルパーを集約する。
 * circular import を避けるため、他の manager モジュールに依存しない。
 */

/**
 * surface 名をファイルパス用に正規化する (T181 / T229)。
 * `surface:12` → `surface_12`。`.team/masters/<normalized>.json` や
 * `.team/conductors/<normalized>/agent-done/<normalized>.done` のファイル名に使う。
 *
 * 統合前は master.ts と daemon.ts で 2 定義されていた:
 * - master.ts: `replaceAll(":", "_")` — コロンのみ置換
 * - daemon.ts: `replaceAll(/[^a-zA-Z0-9_-]/g, "_")` — 英数字 / _ / - 以外を置換
 *
 * 実運用上の surface 名は `surface:NNN` 形式であり両者は同じ出力になるが、
 * 将来的に想定外の文字（空白等）が混入しても壊れないよう、防御的な
 * daemon.ts 版の regex を採用する。docs/spec/05 の「コロンのみ置換」は
 * 同じ出力の超集合表現として扱い、別途更新する。
 */
export function normalizeSurfaceForPath(surface: string): string {
  return surface.replaceAll(/[^a-zA-Z0-9_-]/g, "_");
}
