import { describe, test, expect } from "bun:test";
import { shellQuote, buildLaunchCommand } from "./util";

describe("shellQuote", () => {
  test("通常パスは single-quote で包まれる", () => {
    expect(shellQuote("/path/to/file.md")).toBe("'/path/to/file.md'");
  });

  test("単一引用符を含む文字列は '\\'\\'' で escape される", () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
  });
});

describe("buildLaunchCommand", () => {
  test("絶対パスと command から cd ... && ... 形式の文字列を返す", () => {
    expect(buildLaunchCommand("/abs/path", "cmux-team spawn-master")).toBe(
      "cd '/abs/path' && cmux-team spawn-master",
    );
  });

  test("パスに単一引用符を含む場合は正しく escape される", () => {
    expect(buildLaunchCommand("/has' quote", "cmd")).toBe(
      "cd '/has'\\'' quote' && cmd",
    );
  });

  test("末尾改行は付かない", () => {
    const result = buildLaunchCommand("/abs/path", "cmd");
    expect(result.endsWith("\n")).toBe(false);
  });

  test("相対パスを渡すと throw する", () => {
    expect(() => buildLaunchCommand("relative/path", "cmd")).toThrow(
      /buildLaunchCommand: projectRoot must be absolute/,
    );
  });

  test("ドット始まりの相対パスも throw する", () => {
    expect(() => buildLaunchCommand("./local", "cmd")).toThrow(
      /buildLaunchCommand: projectRoot must be absolute/,
    );
  });

  test("空文字列を渡すと throw する", () => {
    expect(() => buildLaunchCommand("", "cmd")).toThrow(/must be absolute/);
  });

  test("command に args を含む場合も正しく組み立てる", () => {
    const result = buildLaunchCommand("/project/root", "cmux-team spawn-conductor --resume abc123");
    expect(result).toBe("cd '/project/root' && cmux-team spawn-conductor --resume abc123");
  });
});
