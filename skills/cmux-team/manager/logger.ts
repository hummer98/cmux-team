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
 *
 * T266: optional uuid 引数を受け取り、非空なら末尾 6 文字を大文字化して `C[665/ABC123]`
 * 形式で付与する。冪等入力（`C[665]`）には付与しない（設計上、raw surface のみに適用）。
 */
export function formatSurface(
  surface: string | null | undefined,
  role: SurfaceRole,
  uuid?: string | null,
): string {
  if (!surface) return "";
  const alreadyFormatted = surface.match(/^[CAMUS]\[(\d+)\]$/);
  if (alreadyFormatted) return surface;
  const id = surface.startsWith("surface:") ? surface.slice("surface:".length) : surface;
  const tail = uuid ? uuid.slice(-6).toUpperCase() : "";
  return tail ? `${role}[${id}/${tail}]` : `${role}[${id}]`;
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

type LogLevel = "info" | "warn" | "error";

// T409: log / warn / error の共通 append helper。
// CMUX_TEAM_LOGGER_STRICT のチェックと PROJECT_ROOT 解決をここに集約する。
async function appendLine(level: LogLevel, event: string, detail: string): Promise<void> {
  // T292: CMUX_TEAM_LOGGER_STRICT=1 では PROJECT_ROOT 未設定を fail-fast させる。
  // テスト実行中に helper で PROJECT_ROOT を必ず設定するための安全装置。
  // 通常の daemon 実行では env を set しないので process.cwd() フォールバックが使われる。
  const envRoot = process.env.PROJECT_ROOT;
  if (!envRoot && process.env.CMUX_TEAM_LOGGER_STRICT === "1") {
    throw new Error(
      "logger: PROJECT_ROOT is not set but CMUX_TEAM_LOGGER_STRICT=1. " +
        "Wrap tests with createDummyProject() from test-project.ts, or pass setProjectRootEnv: true.",
    );
  }
  const projectRoot = envRoot || process.cwd();
  const logDir = join(projectRoot, ".team/logs");
  const logFile = join(logDir, "manager.log");
  await mkdir(logDir, { recursive: true });
  const timestamp = localISOString();
  // info の場合は prefix を挿入しない（既存ログの互換性維持）
  const levelPrefix = level === "info" ? "" : `[${level}] `;
  const line = `[${timestamp}] ${levelPrefix}${event} ${detail}`.trimEnd() + "\n";
  await appendFile(logFile, line);
}

export async function log(event: string, detail: string = ""): Promise<void> {
  return appendLine("info", event, detail);
}

export async function warn(event: string, detail: string = ""): Promise<void> {
  return appendLine("warn", event, detail);
}

export async function error(event: string, detail: string = ""): Promise<void> {
  return appendLine("error", event, detail);
}
