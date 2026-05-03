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

describe("ClaudeCodeBackend.reset (T421 kill+spawn / D7 atomic prompt)", () => {
  test("AC2: pid undefined (reserved 初回) では kill skip、env export → launchCmd の順で呼ぶ", async () => {
    const ref = backend.surfaceToRef(SURFACE);
    const t0 = Date.now();
    await backend.reset(ref, {
      launchCmd: "cmux-team spawn-conductor --task-prompt '/abs/path'",
      env: { FOO: "bar" },
    });
    const elapsed = Date.now() - t0;

    // 300ms (shell 復帰 wait) + 500ms (env export wait) = 800ms 以上
    expect(elapsed).toBeGreaterThanOrEqual(750);

    const events = timeline();
    // kill は呼ばれない (pid undefined)。export → launchCmd の 2 回 send。
    expect(events.length).toBe(2);
    expect(events[0]).toMatchObject({ kind: "send", args: [SURFACE, "export FOO=bar\n"] });
    expect(events[1]).toMatchObject({
      kind: "send",
      args: [SURFACE, "cmux-team spawn-conductor --task-prompt '/abs/path'\n"],
    });
  });

  test("env 省略時は launchCmd のみ送る（300ms shell 復帰 wait のみ）", async () => {
    const ref = backend.surfaceToRef(SURFACE);
    const t0 = Date.now();
    await backend.reset(ref, {
      launchCmd: "cmux-team spawn-conductor",
    });
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(sendSpy.mock.calls.length).toBe(1);
    expect(sendSpy.mock.calls[0]?.[1]).toBe("cmux-team spawn-conductor\n");
  });

  test("launchCmd 末尾に \\n がなければ自動付加する", async () => {
    const ref = backend.surfaceToRef(SURFACE);
    await backend.reset(ref, { launchCmd: "cmux-team spawn-conductor" });
    expect(sendSpy.mock.calls[0]?.[1]).toBe("cmux-team spawn-conductor\n");
  });

  test("launchCmd 末尾に \\n が既にあればそのまま送る", async () => {
    const ref = backend.surfaceToRef(SURFACE);
    await backend.reset(ref, { launchCmd: "cmux-team spawn-conductor\n" });
    expect(sendSpy.mock.calls[0]?.[1]).toBe("cmux-team spawn-conductor\n");
  });

  test("reset の戻り値は同一 sessionRef", async () => {
    const ref = backend.surfaceToRef(SURFACE);
    const ret = await backend.reset(ref, { launchCmd: "cmux-team spawn-conductor" });
    expect(ret).toBe(ref);
  });

  test("disposed 後に reset を呼ぶと throw する", async () => {
    const ref = backend.surfaceToRef(SURFACE);
    await backend.dispose();
    await expect(
      backend.reset(ref, { launchCmd: "cmux-team spawn-conductor" }),
    ).rejects.toThrow(/already disposed/);
  });

  test("pid 指定時は kill (process.kill SIGTERM) が呼ばれる", async () => {
    const killSpy = spyOn(process, "kill").mockImplementation(() => true);
    try {
      const ref = backend.surfaceToRef(SURFACE);
      // Bun の process.kill は最初の SIGTERM 後 200ms 待ち、`process.kill(pid, 0)` で生存確認 → 死亡なら return
      // ここでは killSpy を真とすると kill(pid, 0) も成功 (=生存) → SIGKILL に進む
      // mockImplementation は常に true なので両方 invoke される想定
      await backend.reset(ref, {
        launchCmd: "cmux-team spawn-conductor",
        pid: 12345,
      });
      // 1 回目 SIGTERM、2 回目 alive check (signal=0)、3 回目 SIGKILL
      const sigCalls = killSpy.mock.calls.filter(c => c[0] === 12345);
      expect(sigCalls.length).toBeGreaterThanOrEqual(1);
      expect(sigCalls[0]?.[1]).toBe("SIGTERM");
    } finally {
      killSpy.mockRestore();
    }
  });
});

describe("ClaudeCodeBackend.killClaudeProcess (T421)", () => {
  test("pid に対して SIGTERM → 200ms wait → 生存確認 → SIGKILL の順で呼ぶ", async () => {
    const calls: Array<{ pid: number; signal: any }> = [];
    const killSpy = spyOn(process, "kill").mockImplementation((pid: number, signal: any) => {
      calls.push({ pid, signal });
      return true;
    });
    try {
      const ref = backend.surfaceToRef(SURFACE);
      await backend.killClaudeProcess(ref, 99999);
      // SIGTERM → signal=0 (alive check) → SIGKILL の 3 回呼ばれる想定
      expect(calls.length).toBe(3);
      expect(calls[0]).toEqual({ pid: 99999, signal: "SIGTERM" });
      expect(calls[1]).toEqual({ pid: 99999, signal: 0 });
      expect(calls[2]).toEqual({ pid: 99999, signal: "SIGKILL" });
    } finally {
      killSpy.mockRestore();
    }
  });

  test("SIGTERM が EPERM 等で throw すれば早期 return（後続 signal 送信なし）", async () => {
    const calls: Array<{ pid: number; signal: any }> = [];
    let firstCall = true;
    const killSpy = spyOn(process, "kill").mockImplementation((pid: number, signal: any) => {
      calls.push({ pid, signal });
      if (firstCall) {
        firstCall = false;
        throw new Error("EPERM");
      }
      return true;
    });
    try {
      const ref = backend.surfaceToRef(SURFACE);
      await backend.killClaudeProcess(ref, 99999);
      // SIGTERM が throw した時点で return → 1 回のみ
      expect(calls.length).toBe(1);
      expect(calls[0]).toEqual({ pid: 99999, signal: "SIGTERM" });
    } finally {
      killSpy.mockRestore();
    }
  });

  test("生存確認 (signal=0) が throw すれば SIGKILL は呼ばれない", async () => {
    const calls: Array<{ pid: number; signal: any }> = [];
    let callCount = 0;
    const killSpy = spyOn(process, "kill").mockImplementation((pid: number, signal: any) => {
      callCount++;
      calls.push({ pid, signal });
      // 1 回目 (SIGTERM): 成功
      // 2 回目 (signal=0 alive check): throw → 死亡確認
      if (callCount === 2) throw new Error("ESRCH");
      return true;
    });
    try {
      const ref = backend.surfaceToRef(SURFACE);
      await backend.killClaudeProcess(ref, 99999);
      // SIGTERM + signal=0 の 2 回のみ。SIGKILL は呼ばれない
      expect(calls.length).toBe(2);
      expect(calls[0]).toEqual({ pid: 99999, signal: "SIGTERM" });
      expect(calls[1]).toEqual({ pid: 99999, signal: 0 });
    } finally {
      killSpy.mockRestore();
    }
  });
});

describe("ClaudeCodeBackend.spawn (AC4: シェル経路は \\n 維持)", () => {
  test("launchCmd に \\n が無ければ自動付加してシェルに送る（send-key return は呼ばない）", async () => {
    const sessionRef = await backend.spawn({
      surface: SURFACE,
      launchCmd: "cmux-team spawn-conductor",
      role: "conductor",
      prompt: "",
      workdir: "/tmp",
    });

    expect(sessionRef).toBe(SURFACE as unknown as SessionRef);
    // シェル経路: \n 付き raw send のみ。sendKey return は呼ばれない。
    expect(sendSpy.mock.calls.length).toBe(1);
    expect(sendSpy.mock.calls[0]?.[0]).toBe(SURFACE);
    expect(sendSpy.mock.calls[0]?.[1]).toBe("cmux-team spawn-conductor\n");
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
      launchCmd: "cmux-team spawn-conductor",
      env: { FOO: "bar", BAZ: "qux" },
      role: "conductor",
      prompt: "",
      workdir: "/tmp",
    });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(450);

    expect(sendSpy.mock.calls.length).toBe(2);
    expect(sendSpy.mock.calls[0]?.[1]).toMatch(/^export FOO=bar BAZ=qux\n$/);
    expect(sendSpy.mock.calls[1]?.[1]).toBe("cmux-team spawn-conductor\n");
    // シェル経路なので sendKey return は呼ばれない
    expect(sendKeySpy.mock.calls.length).toBe(0);
  });
});
