import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFile, mkdir } from "fs/promises";
import { join } from "path";
import { start, __resetTokensDbForTest } from "./proxy";
import { onStateChanged, __resetBusForTest, __listenerCountForTest } from "./eventBus";
import { createDummyProject, type DummyProject } from "./test-project";
import { initDB, getApiUsage } from "./trace-store";
import type { Database } from "bun:sqlite";

let project: DummyProject;
let testDir: string;

beforeEach(async () => {
  project = await createDummyProject({
    prefix: "cmux-proxy-test-",
    subdirs: ["logs"],
  });
  testDir = project.root;
});

afterEach(async () => {
  await project.dispose();
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
      conductorSurface: "cond-1",
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
      masters: new Map([
        [
          "surface:1",
          { surface: "surface:1", status: "idle", startedAt: "2026-03-29T00:00:00Z" },
        ],
      ]),
      conductors: new Map([
        ["surface:2", { taskId: "001", surface: "surface:2", agents: [] }],
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
    expect(Array.isArray(body.masters)).toBe(true);
    expect((body.masters as any[])[0].surface).toBe("surface:1");
    expect(body.lastUpdate).toBe("2026-03-29T00:00:00.000Z");
    expect((body.conductors as Record<string, any>)["surface:2"].surface).toBe("surface:2");
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
        ["surface:3", { taskId: "010", surface: "surface:3", agents: [] }],
        ["surface:4", { taskId: "011", surface: "surface:4", agents: [] }],
      ]),
      lastUpdate: new Date(),
      taskList: [],
    };

    const handle = await start(testDir, { getState: () => mockState });
    const res = await fetch(`http://127.0.0.1:${handle.port}/conductors`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, any>;
    expect(body["surface:3"].surface).toBe("surface:3");
    expect(body["surface:4"].taskId).toBe("011");
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

  // --- T211 POST /statusline エンドポイント ---
  describe("POST /statusline (T211)", () => {
    // branch 解決を安定させるため workspace は存在しない dir に固定
    const NO_GIT = "/nonexistent-dir-for-cmux-proxy-test";
    const statuslineState = () => ({
      running: true,
      bootPhase: "ready" as const,
      masters: new Map<string, any>([
        [
          "surface:100",
          { surface: "surface:100", status: "idle", startedAt: "2026-03-29T00:00:00Z" },
        ],
      ]),
      conductors: new Map<string, any>([
        [
          "surface:200",
          {
            surface: "surface:200",
            taskId: "042",
            taskTitle: "Test task",
            status: "running",
            agents: [
              { surface: "surface:300", role: "researcher", taskTitle: "Test task" },
            ],
          },
        ],
        [
          "surface:201",
          { surface: "surface:201", status: "idle", agents: [] },
        ],
      ]),
      taskList: [
        { id: "001", status: "ready", title: "A" },
        { id: "002", status: "assigned", title: "B" },
      ],
      // proxy.ts は state をそのまま GET /state にも流すため、他のフィールドも空で用意
      lastUpdate: new Date(),
    });

    async function postStatusline(port: number, surface: string | null, body = '{"model":"claude-opus-4-6","context_window":{"used_percentage":42},"workspace":{"current_dir":"' + NO_GIT + '"}}') {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        // ASCII fallback 固定（テストが NF glyph に依存しないようにする）
        "X-Cmux-Nerd-Font": "0",
      };
      if (surface !== null) headers["X-Cmux-Surface"] = surface;
      return await fetch(`http://127.0.0.1:${port}/statusline`, {
        method: "POST",
        headers,
        body,
      });
    }

    test("master surface で ASCII fallback テキストを返す", async () => {
      const handle = await start(testDir, { getState: () => statuslineState() });
      const res = await postStatusline(handle.port, "surface:100");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")?.replace(/\s+/g, "")).toBe("text/plain;charset=utf-8");
      const text = await res.text();
      expect(text).toBe("\u2666 Master |  opus-4-6 | ctx 42% | T:2 |  ");
      handle.stop();
    });

    test("conductor busy で T042 タイトルを含む", async () => {
      const handle = await start(testDir, { getState: () => statuslineState() });
      const res = await postStatusline(handle.port, "surface:200");
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toBe("\u2666 T042 Test task |  | ctx 42% |  opus-4-6");
      handle.stop();
    });

    test("conductor idle で idle セクションを返す", async () => {
      const handle = await start(testDir, { getState: () => statuslineState() });
      const res = await postStatusline(handle.port, "surface:201");
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toBe("\u2666 idle | ctx 42% |  opus-4-6");
      handle.stop();
    });

    test("agent で T042 + role 名を返す", async () => {
      const handle = await start(testDir, { getState: () => statuslineState() });
      const res = await postStatusline(handle.port, "surface:300");
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toBe("\u25B8 researcher | T042 | ctx 42%");
      handle.stop();
    });

    test("X-Cmux-Surface ヘッダー無し → 400", async () => {
      const handle = await start(testDir, { getState: () => statuslineState() });
      const res = await postStatusline(handle.port, null);
      expect(res.status).toBe(400);
      handle.stop();
    });

    test("X-Cmux-Surface 空文字 → 400", async () => {
      const handle = await start(testDir, { getState: () => statuslineState() });
      const res = await postStatusline(handle.port, "");
      expect(res.status).toBe(400);
      handle.stop();
    });

    test("getState 未設定 → 503", async () => {
      const handle = await start(testDir);
      const res = await postStatusline(handle.port, "surface:100");
      expect(res.status).toBe(503);
      handle.stop();
    });

    test("存在しない surface → 200 + 空ボディ", async () => {
      const handle = await start(testDir, { getState: () => statuslineState() });
      const res = await postStatusline(handle.port, "surface:9999");
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toBe("");
      handle.stop();
    });

    test("X-Cmux-Nerd-Font=0 で ASCII fallback、X-Cmux-Statusline-Color=1 で ANSI 色", async () => {
      const handle = await start(testDir, { getState: () => statuslineState() });
      const res = await fetch(`http://127.0.0.1:${handle.port}/statusline`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Cmux-Surface": "surface:100",
          "X-Cmux-Nerd-Font": "0",
          "X-Cmux-Statusline-Color": "1",
        },
        body: JSON.stringify({
          model: "claude-opus-4-6",
          context_window: { used_percentage: 42 },
          workspace: { current_dir: NO_GIT },
        }),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("\u2666 Master");
      expect(text).toContain("\x1b[36m"); // cyan
      expect(text).toContain("\x1b[0m");  // reset
      handle.stop();
    });

    test("末尾に改行を含めない", async () => {
      const handle = await start(testDir, { getState: () => statuslineState() });
      const res = await postStatusline(handle.port, "surface:100");
      const text = await res.text();
      expect(text.endsWith("\n")).toBe(false);
      handle.stop();
    });
  });

  // --- T175: POST /master-state ---
  describe("POST /master-state (T175)", () => {
    let origProjectRoot: string | undefined;

    beforeEach(() => {
      origProjectRoot = process.env.PROJECT_ROOT;
      process.env.PROJECT_ROOT = testDir;
      __resetBusForTest();
    });

    afterEach(() => {
      if (origProjectRoot !== undefined) {
        process.env.PROJECT_ROOT = origProjectRoot;
      } else {
        delete process.env.PROJECT_ROOT;
      }
      __resetBusForTest();
    });

    async function postMasterState(port: number, body: Record<string, any>) {
      return await fetch(`http://127.0.0.1:${port}/master-state`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    function buildMasterMockState(overrides: Partial<{ status: "idle" | "running" | "disconnected"; prompt: string | undefined }> = {}) {
      const master = {
        surface: "surface:100",
        status: overrides.status ?? "idle",
        startedAt: "2026-03-29T00:00:00Z",
        prompt: overrides.prompt,
      };
      return {
        masters: new Map([["surface:100", master]]),
        master,
      };
    }

    test("status=busy で master.status が running になり notifyStateChanged が発火する", async () => {
      const { masters, master } = buildMasterMockState();
      const mockState: any = { masters };
      const handle = await start(testDir, { getState: () => mockState });

      let emitCount = 0;
      const unsub = onStateChanged(() => { emitCount++; });

      const res = await postMasterState(handle.port, { status: "busy", prompt: "調査開始" });
      expect(res.status).toBe(200);
      expect(master.status).toBe("running");
      expect(master.prompt).toBe("調査開始");
      expect(emitCount).toBeGreaterThanOrEqual(1);

      unsub();
      handle.stop();
    });

    test("status=idle で master.status が idle + prompt クリア", async () => {
      const { masters, master } = buildMasterMockState({ status: "running", prompt: "前のプロンプト" });
      const mockState: any = { masters };
      const handle = await start(testDir, { getState: () => mockState });

      let emitCount = 0;
      const unsub = onStateChanged(() => { emitCount++; });

      const res = await postMasterState(handle.port, { status: "idle" });
      expect(res.status).toBe(200);
      expect(master.status).toBe("idle");
      expect(master.prompt).toBeUndefined();
      expect(emitCount).toBeGreaterThanOrEqual(1);

      unsub();
      handle.stop();
    });

    test("manager.log に master_state status=<...> が 1 行記録される", async () => {
      const { masters } = buildMasterMockState();
      const mockState: any = { masters };
      const handle = await start(testDir, { getState: () => mockState });

      const res = await postMasterState(handle.port, { status: "busy", prompt: "research topic X" });
      expect(res.status).toBe(200);

      await new Promise((r) => setTimeout(r, 50));

      const logPath = join(testDir, ".team/logs/manager.log");
      const content = await readFile(logPath, "utf-8");
      const masterStateLines = content.split("\n").filter((l) => l.includes("master_state"));
      expect(masterStateLines.length).toBeGreaterThanOrEqual(1);
      expect(masterStateLines[0]).toContain("status=busy");
      expect(masterStateLines[0]).toContain("prompt=");

      handle.stop();
    });

    test("prompt のみ更新でも notifyStateChanged が呼ばれる", async () => {
      const { masters, master } = buildMasterMockState({ status: "running" });
      const mockState: any = { masters };
      const handle = await start(testDir, { getState: () => mockState });

      let emitCount = 0;
      const unsub = onStateChanged(() => { emitCount++; });

      const res = await postMasterState(handle.port, { prompt: "追加プロンプト" });
      expect(res.status).toBe(200);
      expect(master.prompt).toBe("追加プロンプト");
      expect(emitCount).toBeGreaterThanOrEqual(1);

      unsub();
      handle.stop();
    });

    test("listener 数が /master-state ハンドラ呼び出し後も増えない（副作用で bus リスナー登録しない）", async () => {
      const before = __listenerCountForTest();
      const { masters } = buildMasterMockState();
      const mockState: any = { masters };
      const handle = await start(testDir, { getState: () => mockState });

      await postMasterState(handle.port, { status: "busy" });
      await postMasterState(handle.port, { status: "idle" });

      expect(__listenerCountForTest()).toBe(before);
      handle.stop();
    });

    test("複数 Master + surface 未指定 → 400 + master_state_surface_ambiguous ログ", async () => {
      const masters = new Map([
        ["surface:100", { surface: "surface:100", status: "idle" as const, startedAt: "2026-03-29T00:00:00Z" }],
        ["surface:200", { surface: "surface:200", status: "idle" as const, startedAt: "2026-03-29T00:00:00Z" }],
      ]);
      const mockState: any = { masters };
      const handle = await start(testDir, { getState: () => mockState });

      const res = await postMasterState(handle.port, { status: "busy" });
      expect(res.status).toBe(400);

      await new Promise((r) => setTimeout(r, 50));
      const logPath = join(testDir, ".team/logs/manager.log");
      const content = await readFile(logPath, "utf-8");
      expect(content).toContain("master_state_surface_ambiguous");

      handle.stop();
    });

    test("複数 Master + surface 明示 → 該当 Master のみ更新", async () => {
      const m1: { surface: string; status: string; startedAt: string } = {
        surface: "surface:100", status: "idle", startedAt: "2026-03-29T00:00:00Z",
      };
      const m2: { surface: string; status: string; startedAt: string } = {
        surface: "surface:200", status: "idle", startedAt: "2026-03-29T00:00:00Z",
      };
      const masters = new Map([
        ["surface:100", m1],
        ["surface:200", m2],
      ]);
      const mockState: any = { masters };
      const handle = await start(testDir, { getState: () => mockState });

      const res = await postMasterState(handle.port, { status: "busy", surface: "surface:200" });
      expect(res.status).toBe(200);
      expect(m1.status).toBe("idle");
      expect(m2.status).toBe("running");

      handle.stop();
    });
  });

  // --- T211 Phase 3: Agent 汚染 regression: .claude/settings.json の構造検証 ---
  // Phase 3 で Master hook を master-settings.json に移設した後の regression guard。
  describe("`.claude/settings.json` structural regression (T211)", () => {
    test("UserPromptSubmit / Stop hook は .claude/settings.json に存在しない", async () => {
      const repoRoot = join(import.meta.dir, "..", "..", "..");
      const settingsPath = join(repoRoot, ".claude/settings.json");
      const raw = await readFile(settingsPath, "utf-8");
      const settings = JSON.parse(raw);
      const upsList = settings?.hooks?.UserPromptSubmit;
      const stopList = settings?.hooks?.Stop;
      // hook が存在しない、または空配列であることを要求する
      expect(upsList == null || (Array.isArray(upsList) && upsList.length === 0)).toBe(true);
      expect(stopList == null || (Array.isArray(stopList) && stopList.length === 0)).toBe(true);
    });

    test("PreToolUse の .team/tasks/ 保護 hook は残っている", async () => {
      const repoRoot = join(import.meta.dir, "..", "..", "..");
      const settingsPath = join(repoRoot, ".claude/settings.json");
      const raw = await readFile(settingsPath, "utf-8");
      const settings = JSON.parse(raw);
      const preToolUse = settings?.hooks?.PreToolUse;
      expect(Array.isArray(preToolUse)).toBe(true);
      expect(preToolUse.length).toBeGreaterThan(0);
      // いずれかの hook コマンドに `.team/tasks/` 保護メッセージが含まれる
      const joined = preToolUse
        .flatMap((e: any) => (e.hooks ?? []).map((h: any) => h.command ?? ""))
        .join(" ");
      expect(joined).toContain(".team/tasks/");
      expect(joined).toContain("直接書き込みは禁止");
    });
  });

  // --- T305: api_usage テーブル書き込み ---
  describe("api_usage (T305)", () => {
    let db: Database;

    beforeEach(() => {
      db = initDB(testDir);
    });

    afterEach(() => {
      try { db.close(); } catch {}
    });

    test("非 streaming /v1/messages: usage / model / stop_reason / rate limit ヘッダーが INSERT される", async () => {
      const upstream = Bun.serve({
        port: 0,
        fetch() {
          return new Response(
            JSON.stringify({
              id: "msg_abc123",
              model: "claude-opus-4-7",
              stop_reason: "end_turn",
              usage: {
                input_tokens: 100,
                output_tokens: 50,
                cache_creation_input_tokens: 10,
                cache_read_input_tokens: 200,
              },
            }),
            {
              headers: {
                "content-type": "application/json",
                "anthropic-request-id": "req_xyz789",
                "anthropic-ratelimit-tokens-remaining": "900000",
                "anthropic-ratelimit-tokens-limit": "1000000",
                "anthropic-ratelimit-tokens-reset": "2026-04-24T10:05:00Z",
                "anthropic-ratelimit-requests-remaining": "4000",
                "anthropic-ratelimit-requests-limit": "5000",
              },
            },
          );
        },
      });

      const origEnv = process.env.ANTHROPIC_API_URL;
      process.env.ANTHROPIC_API_URL = `http://127.0.0.1:${upstream.port}`;

      const handle = await start(testDir, {
        conductorSurface: "surface:200",
        taskId: "T305",
        role: "agent",
        db,
      });

      const res = await fetch(`http://127.0.0.1:${handle.port}/v1/messages`, {
        method: "POST",
        headers: { "x-cmux-role": "agent" },
        body: JSON.stringify({ model: "test" }),
      });
      expect(res.status).toBe(200);
      await res.text();

      await new Promise((r) => setTimeout(r, 100));

      const rows = getApiUsage(db, { taskId: "T305" });
      expect(rows.length).toBe(1);
      const row = rows[0]!;
      expect(row.model).toBe("claude-opus-4-7");
      expect(row.request_id).toBe("msg_abc123"); // body の id を優先（なければヘッダ）
      expect(row.stop_reason).toBe("end_turn");
      expect(row.status_code).toBe(200);
      expect(row.input_tokens).toBe(100);
      expect(row.output_tokens).toBe(50);
      expect(row.cache_creation_input_tokens).toBe(10);
      expect(row.cache_read_input_tokens).toBe(200);
      expect(row.role).toBe("agent");
      expect(row.surface).toBe("surface:200");
      expect(row.ratelimit_tokens_remaining).toBe(900000);
      expect(row.ratelimit_requests_remaining).toBe(4000);
      expect(row.ratelimit_tokens_reset).toBe("2026-04-24T10:05:00Z");
      expect(row.error).toBeNull();

      handle.stop();
      upstream.stop();
      if (origEnv !== undefined) {
        process.env.ANTHROPIC_API_URL = origEnv;
      } else {
        delete process.env.ANTHROPIC_API_URL;
      }
    });

    test("SSE /v1/messages: message_start + message_delta + message_stop で usage が集約される", async () => {
      const upstream = Bun.serve({
        port: 0,
        fetch() {
          const encoder = new TextEncoder();
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `event: message_start\ndata: ${JSON.stringify({
                    type: "message_start",
                    message: {
                      id: "msg_sse_1",
                      model: "claude-sonnet-4-6",
                      usage: {
                        input_tokens: 500,
                        output_tokens: 1,
                        cache_creation_input_tokens: 20,
                        cache_read_input_tokens: 1000,
                      },
                    },
                  })}\n\n`,
                ),
              );
              // content_block_delta を 3 行（parse 対象外 — JSON.parse を発火させない）
              for (let i = 0; i < 3; i++) {
                controller.enqueue(
                  encoder.encode(
                    `event: content_block_delta\ndata: ${JSON.stringify({
                      type: "content_block_delta",
                      index: 0,
                      delta: { type: "text_delta", text: "x" },
                    })}\n\n`,
                  ),
                );
              }
              // message_delta を 2 回（累積 output_tokens + stop_reason）
              controller.enqueue(
                encoder.encode(
                  `event: message_delta\ndata: ${JSON.stringify({
                    type: "message_delta",
                    delta: { stop_reason: null, stop_sequence: null },
                    usage: { output_tokens: 50 },
                  })}\n\n`,
                ),
              );
              controller.enqueue(
                encoder.encode(
                  `event: message_delta\ndata: ${JSON.stringify({
                    type: "message_delta",
                    delta: { stop_reason: "end_turn", stop_sequence: null },
                    usage: { output_tokens: 120 },
                  })}\n\n`,
                ),
              );
              controller.enqueue(
                encoder.encode(
                  `event: message_stop\ndata: ${JSON.stringify({
                    type: "message_stop",
                  })}\n\n`,
                ),
              );
              controller.close();
            },
          });
          return new Response(stream, {
            headers: {
              "content-type": "text/event-stream",
              "anthropic-request-id": "req_sse_hdr_1",
            },
          });
        },
      });

      const origEnv = process.env.ANTHROPIC_API_URL;
      process.env.ANTHROPIC_API_URL = `http://127.0.0.1:${upstream.port}`;

      const handle = await start(testDir, {
        taskId: "T305-SSE",
        role: "conductor",
        db,
      });

      const res = await fetch(`http://127.0.0.1:${handle.port}/v1/messages`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      // client 側ですべて読み切る（tee の片方を drain 完了させるため）
      await res.text();

      await new Promise((r) => setTimeout(r, 200));

      const rows = getApiUsage(db, { taskId: "T305-SSE" });
      expect(rows.length).toBe(1);
      const row = rows[0]!;
      expect(row.model).toBe("claude-sonnet-4-6");
      // request_id: ヘッダー優先
      expect(row.request_id).toBe("req_sse_hdr_1");
      expect(row.input_tokens).toBe(500);
      // output_tokens: message_delta の最後の値で上書き
      expect(row.output_tokens).toBe(120);
      expect(row.cache_creation_input_tokens).toBe(20);
      expect(row.cache_read_input_tokens).toBe(1000);
      expect(row.stop_reason).toBe("end_turn");
      expect(row.status_code).toBe(200);
      expect(row.error).toBeNull();
      expect(row.role).toBe("conductor");

      handle.stop();
      upstream.stop();
      if (origEnv !== undefined) {
        process.env.ANTHROPIC_API_URL = origEnv;
      } else {
        delete process.env.ANTHROPIC_API_URL;
      }
    });

    test("SSE: chunk が行の途中で分断されてもバッファされて正しく parse される", async () => {
      const upstream = Bun.serve({
        port: 0,
        fetch() {
          const encoder = new TextEncoder();
          const full =
            `event: message_start\ndata: ${JSON.stringify({
              type: "message_start",
              message: {
                id: "msg_split",
                model: "claude-opus-4-7",
                usage: { input_tokens: 42, output_tokens: 1 },
              },
            })}\n\n` +
            `event: message_delta\ndata: ${JSON.stringify({
              type: "message_delta",
              delta: { stop_reason: "end_turn" },
              usage: { output_tokens: 17 },
            })}\n\n` +
            `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`;
          const fullBytes = encoder.encode(full);
          // 意図的に 3 バイトずつ chunk 分割（行境界・マルチバイト風）
          const stream = new ReadableStream({
            start(controller) {
              for (let i = 0; i < fullBytes.length; i += 3) {
                controller.enqueue(fullBytes.slice(i, i + 3));
              }
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

      const handle = await start(testDir, {
        taskId: "T305-SPLIT",
        role: "agent",
        db,
      });

      const res = await fetch(`http://127.0.0.1:${handle.port}/v1/messages`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      await res.text();

      await new Promise((r) => setTimeout(r, 200));

      const rows = getApiUsage(db, { taskId: "T305-SPLIT" });
      expect(rows.length).toBe(1);
      const row = rows[0]!;
      expect(row.model).toBe("claude-opus-4-7");
      expect(row.input_tokens).toBe(42);
      expect(row.output_tokens).toBe(17);
      expect(row.stop_reason).toBe("end_turn");

      handle.stop();
      upstream.stop();
      if (origEnv !== undefined) {
        process.env.ANTHROPIC_API_URL = origEnv;
      } else {
        delete process.env.ANTHROPIC_API_URL;
      }
    });

    test("非 streaming 429: error.type が rate_limit_error で INSERT される", async () => {
      const upstream = Bun.serve({
        port: 0,
        fetch() {
          return new Response(
            JSON.stringify({
              type: "error",
              error: { type: "rate_limit_error", message: "rate limit" },
            }),
            {
              status: 429,
              headers: { "content-type": "application/json" },
            },
          );
        },
      });

      const origEnv = process.env.ANTHROPIC_API_URL;
      process.env.ANTHROPIC_API_URL = `http://127.0.0.1:${upstream.port}`;

      const handle = await start(testDir, {
        taskId: "T305-429",
        role: "agent",
        db,
      });

      const res = await fetch(`http://127.0.0.1:${handle.port}/v1/messages`, {
        method: "POST",
      });
      expect(res.status).toBe(429);
      await res.text();

      await new Promise((r) => setTimeout(r, 100));

      const rows = getApiUsage(db, { taskId: "T305-429" });
      expect(rows.length).toBe(1);
      const row = rows[0]!;
      expect(row.status_code).toBe(429);
      expect(row.error).toBe("rate_limit_error");
      expect(row.input_tokens).toBeNull();
      expect(row.output_tokens).toBeNull();

      handle.stop();
      upstream.stop();
      if (origEnv !== undefined) {
        process.env.ANTHROPIC_API_URL = origEnv;
      } else {
        delete process.env.ANTHROPIC_API_URL;
      }
    });

    test("非 streaming 502 で body が空: error=http_502 で INSERT される", async () => {
      const upstream = Bun.serve({
        port: 0,
        fetch() {
          return new Response("", {
            status: 502,
            headers: { "content-type": "text/plain" },
          });
        },
      });

      const origEnv = process.env.ANTHROPIC_API_URL;
      process.env.ANTHROPIC_API_URL = `http://127.0.0.1:${upstream.port}`;

      const handle = await start(testDir, {
        taskId: "T305-502",
        role: "agent",
        db,
      });

      const res = await fetch(`http://127.0.0.1:${handle.port}/v1/messages`, {
        method: "POST",
      });
      expect(res.status).toBe(502);
      await res.text();

      await new Promise((r) => setTimeout(r, 100));

      const rows = getApiUsage(db, { taskId: "T305-502" });
      expect(rows.length).toBe(1);
      expect(rows[0]!.error).toBe("http_502");
      expect(rows[0]!.status_code).toBe(502);

      handle.stop();
      upstream.stop();
      if (origEnv !== undefined) {
        process.env.ANTHROPIC_API_URL = origEnv;
      } else {
        delete process.env.ANTHROPIC_API_URL;
      }
    });

    test("/v1/messages/count_tokens は api_usage に INSERT されない（完全一致判定）", async () => {
      const upstream = Bun.serve({
        port: 0,
        fetch() {
          return new Response(
            JSON.stringify({ input_tokens: 42 }),
            {
              headers: { "content-type": "application/json" },
            },
          );
        },
      });

      const origEnv = process.env.ANTHROPIC_API_URL;
      process.env.ANTHROPIC_API_URL = `http://127.0.0.1:${upstream.port}`;

      const handle = await start(testDir, {
        taskId: "T305-CT",
        role: "agent",
        db,
      });

      const res = await fetch(
        `http://127.0.0.1:${handle.port}/v1/messages/count_tokens`,
        { method: "POST" },
      );
      expect(res.status).toBe(200);
      await res.text();

      await new Promise((r) => setTimeout(r, 100));

      const rows = getApiUsage(db, { taskId: "T305-CT" });
      expect(rows.length).toBe(0);

      handle.stop();
      upstream.stop();
      if (origEnv !== undefined) {
        process.env.ANTHROPIC_API_URL = origEnv;
      } else {
        delete process.env.ANTHROPIC_API_URL;
      }
    });

    test("JSONL (api-trace.jsonl) と api_usage が並存する", async () => {
      const upstream = Bun.serve({
        port: 0,
        fetch() {
          return new Response(
            JSON.stringify({
              id: "msg_dual",
              model: "claude-opus-4-7",
              stop_reason: "end_turn",
              usage: { input_tokens: 1, output_tokens: 2 },
            }),
            { headers: { "content-type": "application/json" } },
          );
        },
      });

      const origEnv = process.env.ANTHROPIC_API_URL;
      process.env.ANTHROPIC_API_URL = `http://127.0.0.1:${upstream.port}`;

      const handle = await start(testDir, {
        taskId: "T305-DUAL",
        role: "agent",
        db,
      });

      const res = await fetch(`http://127.0.0.1:${handle.port}/v1/messages`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      await res.text();

      await new Promise((r) => setTimeout(r, 150));

      // JSONL が書かれている
      const traceFile = join(testDir, ".team/logs/traces/api-trace.jsonl");
      const jsonlContent = (await readFile(traceFile, "utf-8")).trim();
      expect(jsonlContent.length).toBeGreaterThan(0);
      const lastLine = jsonlContent.split("\n").pop()!;
      const entry = JSON.parse(lastLine);
      expect(entry.path).toBe("/v1/messages");
      expect(entry.status).toBe(200);

      // api_usage にも INSERT されている
      const rows = getApiUsage(db, { taskId: "T305-DUAL" });
      expect(rows.length).toBe(1);
      expect(rows[0]!.model).toBe("claude-opus-4-7");

      handle.stop();
      upstream.stop();
      if (origEnv !== undefined) {
        process.env.ANTHROPIC_API_URL = origEnv;
      } else {
        delete process.env.ANTHROPIC_API_URL;
      }
    });

    test("db 未指定時は api_usage に INSERT されない（既存テスト互換）", async () => {
      const upstream = Bun.serve({
        port: 0,
        fetch() {
          return new Response(
            JSON.stringify({
              id: "msg_nodb",
              model: "claude-opus-4-7",
              usage: { input_tokens: 5, output_tokens: 3 },
            }),
            { headers: { "content-type": "application/json" } },
          );
        },
      });

      const origEnv = process.env.ANTHROPIC_API_URL;
      process.env.ANTHROPIC_API_URL = `http://127.0.0.1:${upstream.port}`;

      // db を opts に渡さない
      const handle = await start(testDir, {
        taskId: "T305-NODB",
        role: "agent",
      });

      const res = await fetch(`http://127.0.0.1:${handle.port}/v1/messages`, {
        method: "POST",
      });
      expect(res.status).toBe(200);
      await res.text();

      await new Promise((r) => setTimeout(r, 100));

      // 別途手で db を開いて確認（opts.db は渡していない）
      const rows = getApiUsage(db, { taskId: "T305-NODB" });
      expect(rows.length).toBe(0);

      handle.stop();
      upstream.stop();
      if (origEnv !== undefined) {
        process.env.ANTHROPIC_API_URL = origEnv;
      } else {
        delete process.env.ANTHROPIC_API_URL;
      }
    });
  });
});

// ─── T323: proxy → MasterState/ConductorState の tokenHandle 反映 ───
describe("proxy: tokenHandle apply (T323)", () => {
  let tokenDbDir: string;
  let originalTokenDb: string | undefined;
  let originalKeychain: string | undefined;
  let originalApi: string | undefined;

  beforeEach(async () => {
    // 各テストでユニークな DB ファイルを使う（並行テストの handle/org_id 衝突回避）
    tokenDbDir = join(testDir, "token-store");
    await mkdir(tokenDbDir, { recursive: true });
    originalTokenDb = process.env.TOKEN_STORE_DB_PATH;
    originalKeychain = process.env.KEYCHAIN_TEST_MODE;
    process.env.TOKEN_STORE_DB_PATH = join(
      tokenDbDir,
      `tokens-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    process.env.KEYCHAIN_TEST_MODE = "1";
    originalApi = process.env.ANTHROPIC_API_URL;
    // proxy のシングルトン tokens.db を破棄（前テストの DB を参照しないように）
    __resetTokensDbForTest();
  });

  afterEach(() => {
    if (originalTokenDb !== undefined) {
      process.env.TOKEN_STORE_DB_PATH = originalTokenDb;
    } else {
      delete process.env.TOKEN_STORE_DB_PATH;
    }
    if (originalKeychain !== undefined) {
      process.env.KEYCHAIN_TEST_MODE = originalKeychain;
    } else {
      delete process.env.KEYCHAIN_TEST_MODE;
    }
    if (originalApi !== undefined) {
      process.env.ANTHROPIC_API_URL = originalApi;
    } else {
      delete process.env.ANTHROPIC_API_URL;
    }
  });

  function startUpstreamWithRateLimit(): { upstream: ReturnType<typeof Bun.serve> } {
    const upstream = Bun.serve({
      port: 0,
      fetch() {
        return new Response("{}", {
          headers: {
            "content-type": "application/json",
            "anthropic-organization-id": "org-pers",
            "anthropic-ratelimit-unified-5h-utilization": "0.10",
            "anthropic-ratelimit-unified-7d-utilization": "0.20",
            "anthropic-ratelimit-unified-5h-reset": "2099-01-01T00:00:00Z",
            "anthropic-ratelimit-unified-7d-reset": "2099-01-08T00:00:00Z",
            "anthropic-ratelimit-unified-status": "allowed",
            "anthropic-ratelimit-tokens-remaining": "1000",
            "anthropic-ratelimit-tokens-limit": "1000",
            "anthropic-ratelimit-tokens-reset": "2099-01-01T00:00:00Z",
            "anthropic-ratelimit-input-tokens-remaining": "100",
            "anthropic-ratelimit-output-tokens-remaining": "100",
          },
        });
      },
    });
    return { upstream };
  }

  test("既知 token + role=master → state.masters の tokenHandle が更新される", async () => {
    const { initTokenDB, insertToken } = await import("./token-store");
    const { createHash } = await import("crypto");
    const auth = "Bearer test-token-master";
    const authHash = createHash("sha256").update(auth).digest("hex").slice(0, 12);
    const db = initTokenDB();
    insertToken(db, {
      handle: "@pers",
      organization_id: "org-pers",
      auth_hash: authHash,
      plan: "max-x20",
      plan_ratio: 1.0,
      tags: ["any"],
      credential_source: "manual",
      selectable: true,
    });
    db.close();

    const { upstream } = startUpstreamWithRateLimit();
    process.env.ANTHROPIC_API_URL = `http://127.0.0.1:${upstream.port}`;

    const fakeState: any = {
      masters: new Map([
        ["surface:m1", { surface: "surface:m1", status: "running", tokenHandle: undefined }],
      ]),
      conductors: new Map(),
    };
    const handle = await start(testDir, { getState: () => fakeState });

    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: auth,
        "x-cmux-surface": "surface:m1",
        "x-cmux-role": "master",
      },
      body: "{}",
    });
    expect(res.status).toBe(200);
    await res.text();
    await new Promise((r) => setTimeout(r, 50));

    expect(fakeState.masters.get("surface:m1").tokenHandle).toBe("@pers");

    handle.stop();
    upstream.stop();
  });

  test("既知 token + role=agent → state は変更されない（spawn-agent 経路で確定済み）", async () => {
    const { initTokenDB, insertToken } = await import("./token-store");
    const { createHash } = await import("crypto");
    const auth = "Bearer test-token-agent";
    const authHash = createHash("sha256").update(auth).digest("hex").slice(0, 12);
    const db = initTokenDB();
    insertToken(db, {
      handle: "@kddi",
      organization_id: "org-kddi",
      auth_hash: authHash,
      plan: "max-x20",
      plan_ratio: 1.0,
      tags: ["any"],
      credential_source: "manual",
      selectable: true,
    });
    db.close();

    const { upstream } = startUpstreamWithRateLimit();
    process.env.ANTHROPIC_API_URL = `http://127.0.0.1:${upstream.port}`;

    const fakeState: any = {
      masters: new Map([
        ["surface:m1", { surface: "surface:m1", tokenHandle: undefined }],
      ]),
      conductors: new Map([
        ["surface:c1", { surface: "surface:c1", tokenHandle: undefined, agents: [] }],
      ]),
    };
    const handle = await start(testDir, { getState: () => fakeState });

    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: auth,
        "x-cmux-surface": "surface:agent-x",
        "x-cmux-role": "agent",
      },
      body: "{}",
    });
    expect(res.status).toBe(200);
    await res.text();
    await new Promise((r) => setTimeout(r, 50));

    expect(fakeState.masters.get("surface:m1").tokenHandle).toBeUndefined();
    expect(fakeState.conductors.get("surface:c1").tokenHandle).toBeUndefined();

    handle.stop();
    upstream.stop();
  });

  test("既知 token + role=conductor → state.conductors の tokenHandle が更新される", async () => {
    const { initTokenDB, insertToken } = await import("./token-store");
    const { createHash } = await import("crypto");
    const auth = "Bearer test-token-conductor";
    const authHash = createHash("sha256").update(auth).digest("hex").slice(0, 12);
    const db = initTokenDB();
    insertToken(db, {
      handle: "@pers",
      organization_id: "org-pers",
      auth_hash: authHash,
      plan: "max-x20",
      plan_ratio: 1.0,
      tags: ["any"],
      credential_source: "manual",
      selectable: true,
    });
    db.close();

    const { upstream } = startUpstreamWithRateLimit();
    process.env.ANTHROPIC_API_URL = `http://127.0.0.1:${upstream.port}`;

    const fakeState: any = {
      masters: new Map(),
      conductors: new Map([
        ["surface:c1", { surface: "surface:c1", tokenHandle: undefined, agents: [] }],
      ]),
    };
    const handle = await start(testDir, { getState: () => fakeState });

    const res = await fetch(`http://127.0.0.1:${handle.port}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: auth,
        "x-cmux-surface": "surface:c1",
        "x-cmux-role": "conductor",
      },
      body: "{}",
    });
    expect(res.status).toBe(200);
    await res.text();
    await new Promise((r) => setTimeout(r, 50));

    expect(fakeState.conductors.get("surface:c1").tokenHandle).toBe("@pers");

    handle.stop();
    upstream.stop();
  });
});
