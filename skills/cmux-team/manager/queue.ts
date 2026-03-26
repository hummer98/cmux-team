import { readdir, readFile, mkdir, rename, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { join, basename } from "path";
import { QueueMessage } from "./schema";

const QUEUE_DIR = ".team/queue";
const PROCESSED_DIR = join(QUEUE_DIR, "processed");

export async function ensureQueueDirs(): Promise<void> {
  await mkdir(QUEUE_DIR, { recursive: true });
  await mkdir(PROCESSED_DIR, { recursive: true });
}

export async function readQueue(): Promise<
  Array<{ path: string; message: QueueMessage }>
> {
  if (!existsSync(QUEUE_DIR)) return [];

  const files = await readdir(QUEUE_DIR);
  const jsonFiles = files
    .filter((f) => f.endsWith(".json"))
    .sort(); // ファイル名でソート（タイムスタンプ順）

  const messages: Array<{ path: string; message: QueueMessage }> = [];

  for (const file of jsonFiles) {
    const filePath = join(QUEUE_DIR, file);
    try {
      const raw = JSON.parse(await readFile(filePath, "utf-8"));
      const message = QueueMessage.parse(raw);
      messages.push({ path: filePath, message });
    } catch (e) {
      console.error(`[queue] invalid message: ${file}`, e);
      // 不正なファイルも processed に移動（無限リトライ防止）
      await rename(filePath, join(PROCESSED_DIR, file)).catch(() => {});
    }
  }

  return messages;
}

export async function markProcessed(filePath: string): Promise<void> {
  const file = basename(filePath);
  await rename(filePath, join(PROCESSED_DIR, file));
}

let sequence = 0;

export async function sendMessage(
  message: QueueMessage
): Promise<string> {
  await ensureQueueDirs();

  // バリデーション
  QueueMessage.parse(message);

  sequence++;
  const seq = String(sequence).padStart(3, "0");
  const ts = Math.floor(Date.now() / 1000);
  const fileName = `${seq}-${ts}-${message.type.toLowerCase()}.json`;
  const filePath = join(QUEUE_DIR, fileName);
  const tmpPath = `${filePath}.tmp`;

  // アトミック書き込み: tmp → rename
  await writeFile(tmpPath, JSON.stringify(message, null, 2) + "\n");
  await rename(tmpPath, filePath);

  return filePath;
}
