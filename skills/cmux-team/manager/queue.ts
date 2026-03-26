import { readdir, readFile, mkdir, rename, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join, basename } from "path";
import { QueueMessage } from "./schema";

function getQueueDir(): string {
  const root = process.env.PROJECT_ROOT || process.cwd();
  return join(root, ".team/queue");
}

function getProcessedDir(): string {
  return join(getQueueDir(), "processed");
}

export async function ensureQueueDirs(): Promise<void> {
  await mkdir(getQueueDir(), { recursive: true });
  await mkdir(getProcessedDir(), { recursive: true });
}

export async function readQueue(): Promise<
  Array<{ path: string; message: QueueMessage }>
> {
  const queueDir = getQueueDir();
  if (!existsSync(queueDir)) return [];

  const files = await readdir(queueDir);
  const jsonFiles = files
    .filter((f) => f.endsWith(".json"))
    .sort();

  const messages: Array<{ path: string; message: QueueMessage }> = [];

  for (const file of jsonFiles) {
    const filePath = join(queueDir, file);
    try {
      const raw = JSON.parse(await readFile(filePath, "utf-8"));
      const message = QueueMessage.parse(raw);
      messages.push({ path: filePath, message });
    } catch (e) {
      console.error(`[queue] invalid message: ${file}`, e);
      await rename(filePath, join(getProcessedDir(), file)).catch(() => {});
    }
  }

  return messages;
}

export async function markProcessed(filePath: string): Promise<void> {
  const file = basename(filePath);
  await rename(filePath, join(getProcessedDir(), file));
}

let sequence = 0;

export async function sendMessage(
  message: QueueMessage
): Promise<string> {
  await ensureQueueDirs();

  QueueMessage.parse(message);

  sequence++;
  const seq = String(sequence).padStart(3, "0");
  const ts = Math.floor(Date.now() / 1000);
  const fileName = `${seq}-${ts}-${message.type.toLowerCase()}.json`;
  const filePath = join(getQueueDir(), fileName);
  const tmpPath = `${filePath}.tmp`;

  await writeFile(tmpPath, JSON.stringify(message, null, 2) + "\n");
  await rename(tmpPath, filePath);

  return filePath;
}
