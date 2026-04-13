/**
 * exec-error.ts のテスト。
 */
import { describe, test, expect } from "bun:test";
import { isExecTimeout, formatExecError, sanitizeForLog } from "./exec-error";

describe("isExecTimeout", () => {
  test("killed=true && signal=SIGTERM で true", () => {
    expect(isExecTimeout({ killed: true, signal: "SIGTERM" })).toBe(true);
  });

  test("killed=true && signal=SIGKILL で true", () => {
    expect(isExecTimeout({ killed: true, signal: "SIGKILL" })).toBe(true);
  });

  test("killed=false (code=1 の通常エラー) で false", () => {
    expect(isExecTimeout({ killed: false, signal: null, code: 1 })).toBe(false);
  });

  test("killed=true でも signal が別（例: SIGHUP）なら false", () => {
    expect(isExecTimeout({ killed: true, signal: "SIGHUP" })).toBe(false);
  });

  test("plain Error では false", () => {
    expect(isExecTimeout(new Error("plain"))).toBe(false);
  });

  test("null / undefined では false", () => {
    expect(isExecTimeout(null)).toBe(false);
    expect(isExecTimeout(undefined)).toBe(false);
  });

  test("cause 経由の判定（wrap 済み Error）", () => {
    const wrapped: any = new Error("Command failed");
    wrapped.cause = { killed: true, signal: "SIGTERM" };
    expect(isExecTimeout(wrapped)).toBe(true);
  });

  test("wrap 済みでも killed/signal が直接付いていれば true", () => {
    const wrapped: any = new Error("Command failed");
    wrapped.killed = true;
    wrapped.signal = "SIGTERM";
    expect(isExecTimeout(wrapped)).toBe(true);
  });
});

describe("formatExecError", () => {
  test("message のみ", () => {
    expect(formatExecError(new Error("boom"))).toBe("boom");
  });

  test("message + stderr", () => {
    const e: any = new Error("Command failed");
    e.stderr = "workspace not found";
    expect(formatExecError(e)).toBe("Command failed | stderr=workspace not found");
  });

  test("空 stderr は省略される（timeout ケース想定）", () => {
    const e: any = new Error("Command failed");
    e.stderr = "";
    e.stdout = "";
    expect(formatExecError(e)).toBe("Command failed");
  });
});

describe("sanitizeForLog", () => {
  test("null/undefined は空文字列", () => {
    expect(sanitizeForLog(null)).toBe("");
    expect(sanitizeForLog(undefined)).toBe("");
  });

  test("改行は空白に正規化される", () => {
    expect(sanitizeForLog("a\nb\nc")).toBe("a b c");
  });

  test("Buffer は utf8 文字列化される", () => {
    expect(sanitizeForLog(Buffer.from("hello"))).toBe("hello");
  });
});
