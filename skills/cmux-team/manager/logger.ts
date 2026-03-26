import { appendFile, mkdir } from "fs/promises";
import { join } from "path";

const PROJECT_ROOT = process.env.PROJECT_ROOT || process.cwd();
const LOG_DIR = join(PROJECT_ROOT, ".team/logs");
const LOG_FILE = join(LOG_DIR, "manager.log");

export async function log(event: string, detail: string = ""): Promise<void> {
  await mkdir(LOG_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const line = `[${timestamp}] ${event} ${detail}`.trimEnd() + "\n";
  await appendFile(LOG_FILE, line);
  console.error(`[manager] ${event} ${detail}`);
}
