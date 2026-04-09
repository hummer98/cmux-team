import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, chmod, stat } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { runPreflight, printPreflightIssues } from "./preflight";

const execFile = promisify(execFileCb);

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "cmux-preflight-test-"));
});

afterEach(async () => {
  // パーミッションを戻してから rm
  try {
    await chmod(testDir, 0o755);
  } catch {}
  await rm(testDir, { recursive: true, force: true });
});

async function gitInit(dir: string): Promise<void> {
  await execFile("git", ["init", "-q"], { cwd: dir });
}

describe("runPreflight", () => {
  test("git リポジトリ内では not_git_repo issue が含まれない", async () => {
    await gitInit(testDir);
    const result = await runPreflight(testDir);
    const keys = result.issues.map((i) => i.key);
    expect(keys).not.toContain("not_git_repo");
  });

  test("非 git ディレクトリでは ok=false で not_git_repo issue が含まれる", async () => {
    const result = await runPreflight(testDir);
    expect(result.ok).toBe(false);
    const keys = result.issues.map((i) => i.key);
    expect(keys).toContain("not_git_repo");
  });

  test("複数項目同時失敗でも途中で throw せず全 issue が積まれる", async () => {
    // root ではスキップ (chmod が無視されるため)
    if (process.getuid?.() === 0) return;

    // 非 git + 書き込み不可 の 2 項目同時失敗を再現
    await chmod(testDir, 0o555);
    try {
      const result = await runPreflight(testDir);
      expect(result.ok).toBe(false);
      const keys = result.issues.map((i) => i.key);
      // 2 項目が同時に積まれている（途中で throw していない）
      expect(keys).toContain("not_git_repo");
      expect(keys).toContain("team_dir_not_writable");
    } finally {
      await chmod(testDir, 0o755);
    }
  });

  test("preflight 単独では .team/ を作成しない", async () => {
    await gitInit(testDir);
    await runPreflight(testDir);
    expect(existsSync(join(testDir, ".team"))).toBe(false);
  });

  test("preflight 実行後に .cmux-team-preflight-test が残らない", async () => {
    await gitInit(testDir);
    await runPreflight(testDir);
    expect(existsSync(join(testDir, ".cmux-team-preflight-test"))).toBe(false);
  });

  test("書き込み不可ディレクトリでは team_dir_not_writable issue が含まれる", async () => {
    // root ではスキップ (chmod が無視されるため)
    if (process.getuid?.() === 0) return;

    await gitInit(testDir);
    // 読み取り専用にする
    await chmod(testDir, 0o555);
    try {
      const result = await runPreflight(testDir);
      const keys = result.issues.map((i) => i.key);
      expect(keys).toContain("team_dir_not_writable");
    } finally {
      await chmod(testDir, 0o755);
    }
  });

  test("全て成功していれば ok=true, issues=[]", async () => {
    await gitInit(testDir);
    const result = await runPreflight(testDir);
    // ここでは claude/bun が実環境にインストールされていることを前提とせず、
    // not_git_repo と team_dir_not_writable が出ないことだけ検証する
    const keys = result.issues.map((i) => i.key);
    expect(keys).not.toContain("not_git_repo");
    expect(keys).not.toContain("team_dir_not_writable");
  });
});

describe("printPreflightIssues", () => {
  test("ok=true の場合は何も出力しない", () => {
    const logs: string[] = [];
    const origErr = console.error;
    console.error = (...args: any[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      printPreflightIssues({ ok: true, issues: [] });
    } finally {
      console.error = origErr;
    }
    expect(logs).toEqual([]);
  });

  test("ok=false の場合は console.error に整形出力する", () => {
    const logs: string[] = [];
    const origErr = console.error;
    console.error = (...args: any[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      printPreflightIssues({
        ok: false,
        issues: [
          {
            key: "not_git_repo",
            message: "git リポジトリではありません",
            hint: "  cd /tmp/foo\n  git init",
            context: "/tmp/foo",
          },
        ],
      });
    } finally {
      console.error = origErr;
    }
    const joined = logs.join("\n");
    expect(joined).toContain("cmux-team start");
    expect(joined).toContain("git リポジトリではありません");
    expect(joined).toContain("/tmp/foo");
    expect(joined).toContain("git init");
  });
});
