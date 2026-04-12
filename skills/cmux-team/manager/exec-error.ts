/**
 * 外部プロセス（execFile / execFileSync）のエラー情報を 1 行ログに整形する共通ユーティリティ。
 *
 * Node の child_process は失敗時の Error に stderr/stdout を Buffer または string で
 * 付与する。本モジュールはそれらを取り出して `key=value` 形式に整形する。
 *
 * ログフォーマットの規約（CLAUDE.md「ログフォーマット」§）:
 *   - 1 行 1 イベント（改行禁止）
 *   - スペース区切りの key=value
 *   - 値が長すぎる場合は 2KB で切り捨て、末尾に `...(truncated)` を付与
 */

const MAX_LEN = 2048;

/** stderr/stdout の生値（string | Buffer | undefined）をログ用 1 行文字列に正規化する */
export function sanitizeForLog(v: unknown): string {
  if (v == null) return "";
  let s: string;
  if (typeof v === "string") s = v;
  else if (v instanceof Uint8Array || (typeof Buffer !== "undefined" && Buffer.isBuffer(v))) {
    s = Buffer.from(v as Uint8Array).toString("utf8");
  } else {
    s = String(v);
  }
  const normalized = s.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return "";
  return normalized.length > MAX_LEN ? normalized.slice(0, MAX_LEN) + "...(truncated)" : normalized;
}

/**
 * execFile / execFileSync が投げた Error から、message + stderr + stdout を結合した
 * 1 行 detail を生成する。
 *
 * 例: `Command failed: cmux tree | stderr=workspace not found`
 */
export function formatExecError(e: unknown): string {
  const err = e as { message?: string; stderr?: unknown; stdout?: unknown };
  const baseMessage = err?.message ?? String(e);
  const stderr = sanitizeForLog(err?.stderr);
  const stdout = sanitizeForLog(err?.stdout);
  const parts = [baseMessage];
  if (stderr) parts.push(`stderr=${stderr}`);
  if (stdout) parts.push(`stdout=${stdout}`);
  return parts.join(" | ");
}
