import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { start } from "./proxy";

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "cmux-proxy-test-"));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("proxy", () => {
  test("start() がポート番号と stop 関数を返す", async () => {
    const handle = await start(testDir);
    expect(handle.port).toBeGreaterThan(0);
    expect(typeof handle.stop).toBe("function");
    handle.stop();
  });

  test("traces ディレクトリが自動作成される", async () => {
    const handle = await start(testDir);
    const { existsSync } = await import("fs");
    expect(existsSync(join(testDir, ".team/logs/traces"))).toBe(true);
    handle.stop();
  });

  test("非 streaming リクエストのトレースが JSONL に記録される", async () => {
    // モックサーバーを上流として使う
    const upstream = Bun.serve({
      port: 0,
      fetch() {
        return new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        });
      },
    });

    // プロキシを上流に向ける
    const origEnv = process.env.ANTHROPIC_API_URL;
    process.env.ANTHROPIC_API_URL = `http://127.0.0.1:${upstream.port}`;

    const handle = await start(testDir, {
      conductorId: "cond-1",
      taskId: "42",
      role: "researcher",
    });

    // プロキシにリクエスト
    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/messages`, {
      method: "POST",
      body: JSON.stringify({ model: "test" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);

    // ログが書き込まれるのを少し待つ
    await new Promise((r) => setTimeout(r, 100));

    const traceFile = join(testDir, ".team/logs/traces/api-trace.jsonl");
    const lines = (await readFile(traceFile, "utf-8")).trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(1);

    const entry = JSON.parse(lines[0]!);
    expect(entry.conductor_id).toBe("cond-1");
    expect(entry.task_id).toBe("42");
    expect(entry.role).toBe("researcher");
    expect(entry.method).toBe("POST");
    expect(entry.path).toBe("/v1/messages");
    expect(entry.status).toBe(200);
    expect(entry.duration_ms).toBeGreaterThanOrEqual(0);

    handle.stop();
    upstream.stop();
    if (origEnv !== undefined) {
      process.env.ANTHROPIC_API_URL = origEnv;
    } else {
      delete process.env.ANTHROPIC_API_URL;
    }
  });

  test("streaming レスポンスが正しく転送・ログされる", async () => {
    // SSE を返すモックサーバー
    const upstream = Bun.serve({
      port: 0,
      fetch() {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode("data: chunk1\n\n"));
            controller.enqueue(encoder.encode("data: chunk2\n\n"));
            controller.close();
          },
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    const origEnv = process.env.ANTHROPIC_API_URL;
    process.env.ANTHROPIC_API_URL = `http://127.0.0.1:${upstream.port}`;

    const handle = await start(testDir);

    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/messages`);
    expect(res.status).toBe(200);

    // streaming レスポンスを全て読み取る
    const text = await res.text();
    expect(text).toContain("chunk1");
    expect(text).toContain("chunk2");

    // ログ書き込みを待つ
    await new Promise((r) => setTimeout(r, 200));

    const traceFile = join(testDir, ".team/logs/traces/api-trace.jsonl");
    const lines = (await readFile(traceFile, "utf-8")).trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(1);

    const entry = JSON.parse(lines[0]!);
    expect(entry.response_bytes).toBeGreaterThan(0);

    handle.stop();
    upstream.stop();
    if (origEnv !== undefined) {
      process.env.ANTHROPIC_API_URL = origEnv;
    } else {
      delete process.env.ANTHROPIC_API_URL;
    }
  });

  test("メタデータなしでも起動できる", async () => {
    const handle = await start(testDir);
    expect(handle.port).toBeGreaterThan(0);
    handle.stop();
  });

  test("GET /state が DaemonState 相当の JSON を返す", async () => {
    const mockState = {
      running: true,
      masterSurface: "surface:1",
      conductors: new Map([
        ["cond-1", { conductorId: "cond-1", taskId: "001", surface: "surface:2", agents: [] }],
      ]),
      projectRoot: testDir,
      pollInterval: 10000,
      maxConductors: 3,
      lastUpdate: new Date("2026-03-29T00:00:00Z"),
      pendingTasks: 1,
      openTasks: 2,
      taskList: [{ id: "001", title: "テスト", status: "ready", createdAt: "2026-03-29T00:00:00Z" }],
    };

    const handle = await start(testDir, { getState: () => mockState });
    const res = await fetch(`http://127.0.0.1:${handle.port}/state`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.running).toBe(true);
    expect(body.masterSurface).toBe("surface:1");
    expect(body.lastUpdate).toBe("2026-03-29T00:00:00.000Z");
    expect((body.conductors as Record<string, any>)["cond-1"].conductorId).toBe("cond-1");
    handle.stop();
  });

  test("GET /tasks が taskList 配列を返す", async () => {
    const mockState = {
      conductors: new Map(),
      lastUpdate: new Date(),
      taskList: [
        { id: "001", title: "タスクA", status: "ready", createdAt: "2026-03-29T00:00:00Z" },
        { id: "002", title: "タスクB", status: "done", createdAt: "2026-03-29T01:00:00Z" },
      ],
    };

    const handle = await start(testDir, { getState: () => mockState });
    const res = await fetch(`http://127.0.0.1:${handle.port}/tasks`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as any[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(2);
    expect(body[0].id).toBe("001");
    handle.stop();
  });

  test("GET /conductors が Map をオブジェクトとして返す", async () => {
    const mockState = {
      conductors: new Map([
        ["c1", { conductorId: "c1", taskId: "010", surface: "surface:3", agents: [] }],
        ["c2", { conductorId: "c2", taskId: "011", surface: "surface:4", agents: [] }],
      ]),
      lastUpdate: new Date(),
      taskList: [],
    };

    const handle = await start(testDir, { getState: () => mockState });
    const res = await fetch(`http://127.0.0.1:${handle.port}/conductors`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, any>;
    expect(body.c1.conductorId).toBe("c1");
    expect(body.c2.taskId).toBe("011");
    handle.stop();
  });

  test("getState 未設定時に /state が 404 を返す", async () => {
    const handle = await start(testDir);
    const res = await fetch(`http://127.0.0.1:${handle.port}/state`);
    expect(res.status).toBe(404);

    const res2 = await fetch(`http://127.0.0.1:${handle.port}/tasks`);
    expect(res2.status).toBe(404);

    const res3 = await fetch(`http://127.0.0.1:${handle.port}/conductors`);
    expect(res3.status).toBe(404);
    handle.stop();
  });
});
