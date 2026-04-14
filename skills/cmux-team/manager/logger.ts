import { appendFile, mkdir } from "fs/promises";
import { join } from "path";

// ローカルTZオフセット付きISO 8601タイムスタンプを生成
function localISOString(): string {
  const now = new Date();
  const off = now.getTimezoneOffset();
  const sign = off <= 0 ? "+" : "-";
  const absOff = Math.abs(off);
  const hh = String(Math.floor(absOff / 60)).padStart(2, "0");
  const mm = String(absOff % 60).padStart(2, "0");
  const pad = (n: number) => String(n).padStart(2, "0");
  const y = now.getFullYear();
  const mo = pad(now.getMonth() + 1);
  const d = pad(now.getDate());
  const h = pad(now.getHours());
  const mi = pad(now.getMinutes());
  const s = pad(now.getSeconds());
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${sign}${hh}:${mm}`;
}

/**
 * ログ内で使うロールプレフィックス
 * C = Conductor / A = Agent / M = Manager(daemon) / U = User session(Master)
 * S = Surface (role 不明 — cmux 低レベル箇所のみ)
 */
export type SurfaceRole = "C" | "A" | "M" | "U" | "S";

/**
 * "surface:665" や "665" を "C[665]" のような表記に整形する。
 * 空入力（""/undefined）は "" を返す（呼び出し側でテンプレート連結しても安全）。
 * すでに "C[665]" 形式のものはそのまま返す（冪等）。
 */
export function formatSurface(
  surface: string | null | undefined,
  role: SurfaceRole,
): string {
  if (!surface) return "";
  const alreadyFormatted = surface.match(/^[CAMUS]\[(\d+)\]$/);
  if (alreadyFormatted) return surface;
  const id = surface.startsWith("surface:") ? surface.slice("surface:".length) : surface;
  return `${role}[${id}]`;
}

/**
 * 親子関係の surface を "C[665]>A[719]" のように整形する。
 * 片方が空の場合は空でない側のみを返し、両方空なら "" を返す。
 */
export function formatPair(
  parent: string | null | undefined,
  child: string | null | undefined,
  parentRole: SurfaceRole,
  childRole: SurfaceRole,
): string {
  const p = formatSurface(parent, parentRole);
  const c = formatSurface(child, childRole);
  if (p && c) return `${p}>${c}`;
  return p || c;
}

export async function log(event: string, detail: string = ""): Promise<void> {
  const projectRoot = process.env.PROJECT_ROOT || process.cwd();
  const logDir = join(projectRoot, ".team/logs");
  const logFile = join(logDir, "manager.log");
  await mkdir(logDir, { recursive: true });
  const timestamp = localISOString();
  const line = `[${timestamp}] ${event} ${detail}`.trimEnd() + "\n";
  await appendFile(logFile, line);
}
