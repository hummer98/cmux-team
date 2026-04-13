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

export async function log(event: string, detail: string = ""): Promise<void> {
  const projectRoot = process.env.PROJECT_ROOT || process.cwd();
  const logDir = join(projectRoot, ".team/logs");
  const logFile = join(logDir, "manager.log");
  await mkdir(logDir, { recursive: true });
  const timestamp = localISOString();
  const line = `[${timestamp}] ${event} ${detail}`.trimEnd() + "\n";
  await appendFile(logFile, line);
}
