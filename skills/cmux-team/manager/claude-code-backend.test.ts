/**
 * ClaudeCodeBackend — send() / reset() / spawn() の cmux 呼び出し順序を検証する。
 *
 * 背景: T343 — リファクタ commit `09492cf` で send-key return 呼び出しが欠落し、
 * 長文プロンプトが Claude Code TUI で確定されないバグが発生した。
 * send() / reset() は `cmux.send` の後に必ず `cmux.sendKey(surface, "return")` を呼ぶ。
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as cmux from "./cmux";
import { ClaudeCodeBackend } from "./claude-code-backend";
import type { SessionRef } from "./runtime-backend";

const SURFACE = "surface:test-343";

let sendSpy: ReturnType<typeof spyOn>;
let sendKeySpy: ReturnType<typeof spyOn>;
let backend: ClaudeCodeBackend;

beforeEach(() => {
  sendSpy = spyOn(cmux, "send").mockImplementation(async () => {});
  sendKeySpy = spyOn(cmux, "sendKey").mockImplementation(async () => {});
  backend = new ClaudeCodeBackend();
});

afterEach(async () => {
  sendSpy.mockRestore();
  sendKeySpy.mockRestore();
  await backend.dispose();
});

/**
 * sendSpy / sendKeySpy の呼び出しを invocationCallOrder 付きで時系列に並べる。
 * { kind: "send" | "sendKey", args: any[] } のリストを返す。
 */
function timeline(): Array<{ kind: "send" | "sendKey"; args: any[]; order: number }> {
  const events: Array<{ kind: "send" | "sendKey"; args: any[]; order: number }> = [];
  const sendCalls = sendSpy.mock.calls as any[];
  const sendOrders = (sendSpy.mock as any).invocationCallOrder as number[];
  for (let i = 0; i < sendCalls.length; i++) {
    events.push({ kind: "send", args: sendCalls[i], order: sendOrders[i]! });
  }
  const keyCalls = sendKeySpy.mock.calls as any[];
  const keyOrders = (sendKeySpy.mock as any).invocationCallOrder as number[];
  for (let i = 0; i < keyCalls.length; i++) {
    events.push({ kind: "sendKey", args: keyCalls[i], order: keyOrders[i]! });
  }
  events.sort((a, b) => a.order - b.order);
  return events;
}

describe("ClaudeCodeBackend.send (T343)", () => {
  test("AC1: cmux.send → cmux.sendKey(return) の順で呼ぶ", async () => {
    const ref = backend.surfaceToRef(SURFACE);
    await backend.send(ref, "hello");

    const events = timeline();
    expect(events.length).toBe(2);
    expect(events[0]!.kind).toBe("send");
    expect(events[0]!.args[0]).toBe(SURFACE);
    expect(events[0]!.args[1]).toBe("hello");
    expect(events[1]!.kind).toBe("sendKey");
    expect(events[1]!.args[0]).toBe(SURFACE);
    expect(events[1]!.args[1]).toBe("return");
  });

  test("\\n 末尾は剥がして cmux.send に渡す", async () => {
    const ref = backend.surfaceToRef(SURFACE);
    await backend.send(ref, "hello\n");

    expect(sendSpy.mock.calls[0]?.[1]).toBe("hello");
    expect(sendKeySpy.mock.calls[0]?.[1]).toBe("return");
  });

  test("\\n 末尾無しならそのまま cmux.send に渡す", async () => {
    const ref = backend.surfaceToRef(SURFACE);
    await backend.send(ref, "hello world");

    expect(sendSpy.mock.calls[0]?.[1]).toBe("hello world");
    expect(sendKeySpy.mock.calls[0]?.[1]).toBe("return");
  });

  test("AC1 (long prompt): 80 char 以上の長文も同じ順序で send + return", async () => {
    const longPrompt = "a".repeat(120) + " end-of-prompt";
    const ref = backend.surfaceToRef(SURFACE);
    await backend.send(ref, longPrompt);

    const events = timeline();
    expect(events.length).toBe(2);
    expect(events[0]!.kind).toBe("send");
    expect(events[0]!.args[1]).toBe(longPrompt);
    expect(events[1]!.kind).toBe("sendKey");
    expect(events[1]!.args[1]).toBe("return");
  });

  test("AC1 (long prompt + \\n): 80 char 以上 + \\n 終端でも \\n が剥がれて enter 確定", async () => {
    const longPrompt = "x".repeat(200);
    const ref = backend.surfaceToRef(SURFACE);
    await backend.send(ref, longPrompt + "\n");

    expect(sendSpy.mock.calls[0]?.[1]).toBe(longPrompt);
    expect(sendKeySpy.mock.calls[0]?.[1]).toBe("return");
  });

  test("disposed 後に send を呼ぶと throw する", async () => {
    const ref = backend.surfaceToRef(SURFACE);
    await backend.dispose();
    await expect(backend.send(ref, "hi")).rejects.toThrow(/already disposed/);
  });
});

describe("ClaudeCodeBackend.reset (T343)", () => {
  test("AC2: /clear → return → 500ms wait → prompt → return の順で呼ぶ", async () => {
    const ref = backend.surfaceToRef(SURFACE);
    const t0 = Date.now();
    await backend.reset(ref, "next prompt");
    const elapsed = Date.now() - t0;

    // 500ms wait の検証（多少のブレを許容）
    expect(elapsed).toBeGreaterThanOrEqual(450);

    const events = timeline();
    expect(events.length).toBe(4);
    expect(events[0]).toMatchObject({ kind: "send", args: [SURFACE, "/clear"] });
    expect(events[1]).toMatchObject({ kind: "sendKey", args: [SURFACE, "return"] });
    expect(events[2]).toMatchObject({ kind: "send", args: [SURFACE, "next prompt"] });
    expect(events[3]).toMatchObject({ kind: "sendKey", args: [SURFACE, "return"] });
  });

  test("prompt の \\n 末尾は剥がす", async () => {
    const ref = backend.surfaceToRef(SURFACE);
    await backend.reset(ref, "next\n");

    // sendSpy.mock.calls = [ [/clear], [next] ]
    expect(sendSpy.mock.calls[0]?.[1]).toBe("/clear");
    expect(sendSpy.mock.calls[1]?.[1]).toBe("next");
    // sendKeySpy.mock.calls = [ [return], [return] ]
    expect(sendKeySpy.mock.calls.length).toBe(2);
    expect(sendKeySpy.mock.calls[0]?.[1]).toBe("return");
    expect(sendKeySpy.mock.calls[1]?.[1]).toBe("return");
  });

  test("AC2 (long prompt): 80 char 以上 + \\n 終端でも 4 ステップで enter 確定", async () => {
    const longPrompt = "p".repeat(150);
    const ref = backend.surfaceToRef(SURFACE);
    await backend.reset(ref, longPrompt + "\n");

    expect(sendSpy.mock.calls[0]?.[1]).toBe("/clear");
    expect(sendSpy.mock.calls[1]?.[1]).toBe(longPrompt);
    expect(sendKeySpy.mock.calls.length).toBe(2);
  });

  test("reset の戻り値は同一 sessionRef", async () => {
    const ref = backend.surfaceToRef(SURFACE);
    const ret = await backend.reset(ref, "hi");
    expect(ret).toBe(ref);
  });

  test("disposed 後に reset を呼ぶと throw する", async () => {
    const ref = backend.surfaceToRef(SURFACE);
    await backend.dispose();
    await expect(backend.reset(ref, "hi")).rejects.toThrow(/already disposed/);
  });
});

describe("ClaudeCodeBackend.spawn (AC4: シェル経路は \\n 維持)", () => {
  test("launchCmd に \\n が無ければ自動付加してシェルに送る（send-key return は呼ばない）", async () => {
    const sessionRef = await backend.spawn({
      surface: SURFACE,
      launchCmd: "cmux-team conductor",
      role: "conductor",
      prompt: "",
      workdir: "/tmp",
    });

    expect(sessionRef).toBe(SURFACE as unknown as SessionRef);
    // シェル経路: \n 付き raw send のみ。sendKey return は呼ばれない。
    expect(sendSpy.mock.calls.length).toBe(1);
    expect(sendSpy.mock.calls[0]?.[0]).toBe(SURFACE);
    expect(sendSpy.mock.calls[0]?.[1]).toBe("cmux-team conductor\n");
    expect(sendKeySpy.mock.calls.length).toBe(0);
  });

  test("launchCmd 末尾に \\n が既にあればそのまま送る", async () => {
    await backend.spawn({
      surface: SURFACE,
      launchCmd: "cmux-team master\n",
      role: "master",
      prompt: "",
      workdir: "/tmp",
    });

    expect(sendSpy.mock.calls[0]?.[1]).toBe("cmux-team master\n");
    expect(sendKeySpy.mock.calls.length).toBe(0);
  });

  test("env が指定されると export 行を先に \\n 付きで送る（500ms wait あり）", async () => {
    const t0 = Date.now();
    await backend.spawn({
      surface: SURFACE,
      launchCmd: "cmux-team conductor",
      env: { FOO: "bar", BAZ: "qux" },
      role: "conductor",
      prompt: "",
      workdir: "/tmp",
    });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(450);

    expect(sendSpy.mock.calls.length).toBe(2);
    expect(sendSpy.mock.calls[0]?.[1]).toMatch(/^export FOO=bar BAZ=qux\n$/);
    expect(sendSpy.mock.calls[1]?.[1]).toBe("cmux-team conductor\n");
    // シェル経路なので sendKey return は呼ばれない
    expect(sendKeySpy.mock.calls.length).toBe(0);
  });
});
