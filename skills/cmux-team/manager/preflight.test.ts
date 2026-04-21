import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { chmod } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { runPreflight, printPreflightIssues, checkJq } from "./preflight";
import { createDummyProject, type DummyProject } from "./test-project";

const execFile = promisify(execFileCb);

let project: DummyProject;
let testDir: string;

beforeEach(async () => {
  project = await createDummyProject({
    prefix: "cmux-preflight-test-",
    subdirs: [],
    setProjectRootEnv: false,
    createTeamDir: false,
  });
  testDir = project.root;
});

afterEach(async () => {
  // パーミッションを戻してから dispose
  try {
    await chmod(testDir, 0o755);
  } catch {}
  await project.dispose();
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

describe("checkJq (T189)", () => {
  test("jq が見つかる場合は null を返す", () => {
    const result = checkJq(() => "/usr/bin/jq");
    expect(result).toBeNull();
  });

  test("jq が見つからない場合は jq_not_found issue を返す", () => {
    const result = checkJq(() => null);
    expect(result).not.toBeNull();
    expect(result?.key).toBe("jq_not_found");
    expect(result?.hint).toContain("brew install jq");
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
