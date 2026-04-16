import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  checkDirenvAllowed,
  formatDirenvNotAllowedMessage,
  type CheckDirenvOptions,
} from "./direnv-check";

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "cmux-direnv-check-test-"));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

const whichDirenv = (bin: string) => (bin === "direnv" ? "/opt/homebrew/bin/direnv" : null);
const whichNone = (_bin: string) => null;

// direnv status 実測結果（cmux-team/.envrc を対象に検証済み、2026-04-17）:
//   direnv allow  → "Found RC allowed 0"
//   (未 allow)    → "Found RC allowed 1"
//   direnv deny   → "Found RC allowed 2"
// "Loaded RC allowed" は direnv hook が現シェルに入っていないと常に 0 になり
// 信頼できないため、"Found RC allowed" を判定に使う。
const STATUS_ALLOWED = [
  "direnv exec path /opt/homebrew/bin/direnv",
  "Loaded RC path /some/path/.envrc",
  "Loaded RC allowed 0",
  "Found RC path /some/path/.envrc",
  "Found RC allowed 0",
  "",
].join("\n");

const STATUS_NOT_ALLOWED = [
  "direnv exec path /opt/homebrew/bin/direnv",
  "Loaded RC path /some/path/.envrc",
  "Loaded RC allowed 0",
  "Found RC path /some/path/.envrc",
  "Found RC allowed 1",
  "",
].join("\n");

const STATUS_DENIED = [
  "direnv exec path /opt/homebrew/bin/direnv",
  "Loaded RC path /some/path/.envrc",
  "Loaded RC allowed 0",
  "Found RC path /some/path/.envrc",
  "Found RC allowed 2",
  "",
].join("\n");

const STATUS_NO_FOUND_LINE = [
  "direnv exec path /opt/homebrew/bin/direnv",
  "No .envrc or .env found",
  "",
].join("\n");

describe("checkDirenvAllowed", () => {
  test("1. .envrc が存在しなければ no_envrc", async () => {
    const opts: CheckDirenvOptions = {
      which: whichDirenv,
      runDirenvStatus: async () => ({ stdout: STATUS_NOT_ALLOWED, stderr: "" }),
    };
    const result = await checkDirenvAllowed(testDir, opts);
    expect(result).toBe("no_envrc");
  });

  test("2. .envrc あり / direnv バイナリ無し なら no_direnv", async () => {
    await writeFile(join(testDir, ".envrc"), "export FOO=bar\n");
    const opts: CheckDirenvOptions = {
      which: whichNone,
      runDirenvStatus: async () => ({ stdout: STATUS_ALLOWED, stderr: "" }),
    };
    const result = await checkDirenvAllowed(testDir, opts);
    expect(result).toBe("no_direnv");
  });

  test("3. .envrc あり / direnv あり / Found RC allowed 0 なら ok", async () => {
    await writeFile(join(testDir, ".envrc"), "export FOO=bar\n");
    const opts: CheckDirenvOptions = {
      which: whichDirenv,
      runDirenvStatus: async () => ({ stdout: STATUS_ALLOWED, stderr: "" }),
    };
    const result = await checkDirenvAllowed(testDir, opts);
    expect(result).toBe("ok");
  });

  test("4. .envrc あり / direnv あり / Found RC allowed 1 なら not_allowed", async () => {
    await writeFile(join(testDir, ".envrc"), "export FOO=bar\n");
    const opts: CheckDirenvOptions = {
      which: whichDirenv,
      runDirenvStatus: async () => ({ stdout: STATUS_NOT_ALLOWED, stderr: "" }),
    };
    const result = await checkDirenvAllowed(testDir, opts);
    expect(result).toBe("not_allowed");
  });

  test("5. Found RC allowed 行が無ければ not_allowed（fail-closed）", async () => {
    await writeFile(join(testDir, ".envrc"), "export FOO=bar\n");
    const opts: CheckDirenvOptions = {
      which: whichDirenv,
      runDirenvStatus: async () => ({ stdout: STATUS_NO_FOUND_LINE, stderr: "" }),
    };
    const result = await checkDirenvAllowed(testDir, opts);
    expect(result).toBe("not_allowed");
  });

  test("6. Found RC allowed 2（deny 状態）なら not_allowed", async () => {
    await writeFile(join(testDir, ".envrc"), "export FOO=bar\n");
    const opts: CheckDirenvOptions = {
      which: whichDirenv,
      runDirenvStatus: async () => ({ stdout: STATUS_DENIED, stderr: "" }),
    };
    const result = await checkDirenvAllowed(testDir, opts);
    expect(result).toBe("not_allowed");
  });

  test("7. runDirenvStatus が throw したら not_allowed（fail-closed）", async () => {
    await writeFile(join(testDir, ".envrc"), "export FOO=bar\n");
    const opts: CheckDirenvOptions = {
      which: whichDirenv,
      runDirenvStatus: async () => {
        const e = new Error("Command failed: direnv status") as Error & {
          stderr?: string;
          stdout?: string;
        };
        e.stderr = "permission denied";
        throw e;
      },
    };
    const result = await checkDirenvAllowed(testDir, opts);
    expect(result).toBe("not_allowed");
  });
});

describe("formatDirenvNotAllowedMessage", () => {
  test("8. メッセージに projectRoot / direnv allow / cmux-team が含まれる", () => {
    const msg = formatDirenvNotAllowedMessage("/path/to/project");
    expect(msg).toContain("/path/to/project");
    expect(msg).toContain("direnv allow");
    expect(msg).toContain("cmux-team");
    // plan §4.4 / §5.3 案 B: コマンド名は入れず共通の冒頭にする
    expect(msg).toContain("❌ cmux-team: .envrc が direnv allow されていません");
    // 解決方法に .envrc パスを含める
    expect(msg).toContain("/path/to/project/.envrc");
  });
});
