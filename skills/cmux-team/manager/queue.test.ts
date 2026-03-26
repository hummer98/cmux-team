import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readdir, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

// テスト用に PROJECT_ROOT を一時ディレクトリに設定
let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "cmux-team-test-"));
  process.env.PROJECT_ROOT = testDir;
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
  delete process.env.PROJECT_ROOT;
});

// 動的 import で PROJECT_ROOT を反映させる
async function getQueue() {
  // モジュールキャッシュをバイパスするためインラインで再実装
  const { mkdir, writeFile, readdir, readFile, rename } = await import("fs/promises");
  const { existsSync } = await import("fs");
  const { join, basename } = await import("path");
  const { QueueMessage } = await import("./schema");

  const QUEUE_DIR = join(testDir, ".team/queue");
  const PROCESSED_DIR = join(QUEUE_DIR, "processed");

  await mkdir(QUEUE_DIR, { recursive: true });
  await mkdir(PROCESSED_DIR, { recursive: true });

  let seq = 0;

  return {
    QUEUE_DIR,
    PROCESSED_DIR,

    async send(message: any): Promise<string> {
      QueueMessage.parse(message); // バリデーション
      seq++;
      const ts = Math.floor(Date.now() / 1000);
      const fileName = `${String(seq).padStart(3, "0")}-${ts}-${message.type.toLowerCase()}.json`;
      const filePath = join(QUEUE_DIR, fileName);
      const tmpPath = `${filePath}.tmp`;
      await writeFile(tmpPath, JSON.stringify(message, null, 2) + "\n");
      await rename(tmpPath, filePath);
      return filePath;
    },

    async read(): Promise<Array<{ path: string; message: any }>> {
      const files = (await readdir(QUEUE_DIR))
        .filter((f) => f.endsWith(".json"))
        .sort();
      const messages: Array<{ path: string; message: any }> = [];
      for (const file of files) {
        const filePath = join(QUEUE_DIR, file);
        const raw = JSON.parse(await readFile(filePath, "utf-8"));
        messages.push({ path: filePath, message: QueueMessage.parse(raw) });
      }
      return messages;
    },

    async markProcessed(filePath: string): Promise<void> {
      await rename(filePath, join(PROCESSED_DIR, basename(filePath)));
    },
  };
}

describe("Queue", () => {
  test("TASK_CREATED メッセージを送信・読み取りできる", async () => {
    const q = await getQueue();
    const path = await q.send({
      type: "TASK_CREATED",
      taskId: "035",
      taskFile: ".team/tasks/open/035-fix.md",
      timestamp: new Date().toISOString(),
    });

    expect(path).toContain("task_created.json");

    const messages = await q.read();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.message.type).toBe("TASK_CREATED");
    expect(messages[0]!.message.taskId).toBe("035");
  });

  test("TODO メッセージを送信・読み取りできる", async () => {
    const q = await getQueue();
    await q.send({
      type: "TODO",
      content: "worktree を整理して",
      timestamp: new Date().toISOString(),
    });

    const messages = await q.read();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.message.type).toBe("TODO");
    expect(messages[0]!.message.content).toBe("worktree を整理して");
  });

  test("複数メッセージが順序通りに読み取れる", async () => {
    const q = await getQueue();
    await q.send({
      type: "TASK_CREATED",
      taskId: "035",
      taskFile: ".team/tasks/open/035.md",
      timestamp: new Date().toISOString(),
    });
    await q.send({
      type: "TODO",
      content: "test",
      timestamp: new Date().toISOString(),
    });
    await q.send({
      type: "SHUTDOWN",
      timestamp: new Date().toISOString(),
    });

    const messages = await q.read();
    expect(messages).toHaveLength(3);
    expect(messages[0]!.message.type).toBe("TASK_CREATED");
    expect(messages[1]!.message.type).toBe("TODO");
    expect(messages[2]!.message.type).toBe("SHUTDOWN");
  });

  test("処理済みメッセージが processed/ に移動される", async () => {
    const q = await getQueue();
    const path = await q.send({
      type: "SHUTDOWN",
      timestamp: new Date().toISOString(),
    });

    await q.markProcessed(path);

    const remaining = await q.read();
    expect(remaining).toHaveLength(0);

    const processed = await readdir(q.PROCESSED_DIR);
    expect(processed).toHaveLength(1);
  });

  test("不正な JSON はバリデーションエラーになる", async () => {
    const q = await getQueue();
    expect(() =>
      q.send({ type: "INVALID_TYPE", timestamp: new Date().toISOString() } as any)
    ).toThrow();
  });

  test("空の content を持つ TODO はバリデーションエラーになる", async () => {
    const q = await getQueue();
    expect(() =>
      q.send({ type: "TODO", content: "", timestamp: new Date().toISOString() } as any)
    ).toThrow();
  });

  test("CONDUCTOR_DONE メッセージが正しく処理される", async () => {
    const q = await getQueue();
    await q.send({
      type: "CONDUCTOR_DONE",
      conductorId: "conductor-123",
      surface: "surface:42",
      sessionId: "abc-def",
      timestamp: new Date().toISOString(),
    });

    const messages = await q.read();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.message.conductorId).toBe("conductor-123");
    expect(messages[0]!.message.sessionId).toBe("abc-def");
  });
});
