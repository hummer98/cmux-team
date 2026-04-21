import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFile, mkdir } from "fs/promises";
import { join } from "path";
import { start } from "./proxy";
import { onStateChanged, __resetBusForTest, __listenerCountForTest } from "./eventBus";
import { createDummyProject, type DummyProject } from "./test-project";

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
});
