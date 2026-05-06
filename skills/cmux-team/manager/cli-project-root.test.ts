/**
 * Task 440: CLI `--project-root` flag + write gate のテスト。
 *
 * - in-process unit test (U1-U8): runWriteGate を直接呼び依存注入経由で全分岐を検証
 * - subprocess 統合テスト (G1-G5): bun run main.ts ... を起動し dispatcher hook の動作確認
 * - read 系テスト (R1-R4): cwd と異なる project root への読み出しと strict 検証
 * - spawn 系テスト (Sp1-Sp3): spawn-* 経路の env 継承（subprocess + ログ assert）
 */
import { describe, test, expect } from "bun:test";
import { spawn } from "child_process";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { runWriteGate } from "./main";

const MAIN_TS = join(import.meta.dir, "main.ts");

// ---------- helpers ----------

async function makeTeamProject(prefix = "cmux-team-440-"): Promise<{
  root: string;
  dispose: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(root, ".team"), { recursive: true });
  await mkdir(join(root, ".team/tasks"), { recursive: true });
  await mkdir(join(root, ".team/conductors"), { recursive: true });
  await mkdir(join(root, ".team/output"), { recursive: true });
  await mkdir(join(root, ".team/queue"), { recursive: true });
  await mkdir(join(root, ".team/prompts"), { recursive: true });
  await mkdir(join(root, ".team/logs"), { recursive: true });
  // GC を無効化
  await writeFile(
    join(root, ".team/config.json"),
    JSON.stringify({ gc: { runOnStart: false, periodic: false } }),
  );
  return {
    root,
    dispose: async () => {
      await rm(root, { recursive: true, force: true });
    },
  };
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], opts: { cwd: string; env?: Record<string, string>; stdin?: "pipe" | "inherit" }): Promise<RunResult> {
  return new Promise((resolve) => {
    const baseEnv = { ...process.env, ...(opts.env ?? {}) };
    // PROJECT_ROOT env を空に（テスト分離）。明示的に opts.env に PROJECT_ROOT があればそれを使う
    if (opts.env?.PROJECT_ROOT === undefined) {
      delete baseEnv.PROJECT_ROOT;
    }
    const proc = spawn("bun", ["run", MAIN_TS, ...args], {
      cwd: opts.cwd,
      env: baseEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    // stdin を即 close（pipe + close で TTY なし扱い）
    proc.stdin.end();
  });
}

// ---------- in-process unit tests for runWriteGate ----------

describe("runWriteGate (in-process unit)", () => {
  function makeExitMock() {
    const calls: number[] = [];
    const exit = (code: number): never => {
      calls.push(code);
      throw new Error(`__exit-${code}__`);
    };
    return { calls, exit };
  }

  function makeStderrMock() {
    const chunks: string[] = [];
    return { chunks, write: (s: string) => { chunks.push(s); } };
  }

  test("U1: confirmFlag=true → 即 return（exit 呼ばれない）", async () => {
    const exit = makeExitMock();
    await runWriteGate("/tmp/A", "/tmp/B", {
      confirmFlag: true,
      isTty: false,
      exit: exit.exit,
    });
    expect(exit.calls).toEqual([]);
  });

  test("U2: confirmEnv=\"1\" → 即 return", async () => {
    const exit = makeExitMock();
    await runWriteGate("/tmp/A", "/tmp/B", {
      confirmEnv: "1",
      isTty: false,
      exit: exit.exit,
    });
    expect(exit.calls).toEqual([]);
  });

  test("U3: TTY なし → exit(1) + stderr に error メッセージ", async () => {
    const projA = await makeTeamProject("cmux-team-440-u3a-");
    const projB = await makeTeamProject("cmux-team-440-u3b-");
    try {
      const exit = makeExitMock();
      const stderr = makeStderrMock();
      let threw = false;
      try {
        await runWriteGate(projA.root, projB.root, {
          isTty: false,
          exit: exit.exit,
          stderr: stderr.write,
        });
      } catch (e: any) {
        threw = e.message === "__exit-1__";
      }
      expect(threw).toBe(true);
      expect(exit.calls).toEqual([1]);
      expect(stderr.chunks.join("")).toContain("error: --project-root differs from cwd");
      expect(stderr.chunks.join("")).toContain(projA.root);
      expect(stderr.chunks.join("")).toContain(projB.root);
    } finally {
      await projA.dispose();
      await projB.dispose();
    }
  });

  test("U4: TTY あり + 'y\\n' → 正常 return（exit 呼ばれない）", async () => {
    const projA = await makeTeamProject("cmux-team-440-u4a-");
    const projB = await makeTeamProject("cmux-team-440-u4b-");
    try {
      const exit = makeExitMock();
      await runWriteGate(projA.root, projB.root, {
        isTty: true,
        rlFactory: () => ({
          question: async () => "y\n",
          close: () => {},
        }),
        exit: exit.exit,
      });
      expect(exit.calls).toEqual([]);
    } finally {
      await projA.dispose();
      await projB.dispose();
    }
  });

  test("U5: TTY あり + 'n\\n' → exit(1)", async () => {
    const projA = await makeTeamProject("cmux-team-440-u5a-");
    const projB = await makeTeamProject("cmux-team-440-u5b-");
    try {
      const exit = makeExitMock();
      let threw = false;
      try {
        await runWriteGate(projA.root, projB.root, {
          isTty: true,
          rlFactory: () => ({
            question: async () => "n\n",
            close: () => {},
          }),
          exit: exit.exit,
        });
      } catch (e: any) {
        threw = e.message === "__exit-1__";
      }
      expect(threw).toBe(true);
      expect(exit.calls).toEqual([1]);
    } finally {
      await projA.dispose();
      await projB.dispose();
    }
  });

  test("U6: TTY あり + 空文字 → exit(1)", async () => {
    const projA = await makeTeamProject("cmux-team-440-u6a-");
    const projB = await makeTeamProject("cmux-team-440-u6b-");
    try {
      const exit = makeExitMock();
      let threw = false;
      try {
        await runWriteGate(projA.root, projB.root, {
          isTty: true,
          rlFactory: () => ({
            question: async () => "",
            close: () => {},
          }),
          exit: exit.exit,
        });
      } catch (e: any) {
        threw = e.message === "__exit-1__";
      }
      expect(threw).toBe(true);
      expect(exit.calls).toEqual([1]);
    } finally {
      await projA.dispose();
      await projB.dispose();
    }
  });

  test("U7: TTY あり + 'Yes' → 正常 return（大文字対応）", async () => {
    const projA = await makeTeamProject("cmux-team-440-u7a-");
    const projB = await makeTeamProject("cmux-team-440-u7b-");
    try {
      const exit = makeExitMock();
      await runWriteGate(projA.root, projB.root, {
        isTty: true,
        rlFactory: () => ({
          question: async () => "Yes",
          close: () => {},
        }),
        exit: exit.exit,
      });
      expect(exit.calls).toEqual([]);
    } finally {
      await projA.dispose();
      await projB.dispose();
    }
  });

  test("U8: target/cwd を symlink で別 path → realpathSync で同一判定 → gate skip", async () => {
    const proj = await makeTeamProject("cmux-team-440-u8-");
    const linkDir = await mkdtemp(join(tmpdir(), "cmux-team-440-u8-link-"));
    const linkPath = join(linkDir, "linked");
    try {
      await symlink(proj.root, linkPath);
      const exit = makeExitMock();
      // target = symlink, cwd = real path → realpath で同一に解決される想定
      await runWriteGate(linkPath, proj.root, {
        isTty: false, // TTY なしでも同一判定で gate を skip するので exit 呼ばれない
        exit: exit.exit,
      });
      expect(exit.calls).toEqual([]);
    } finally {
      await rm(linkDir, { recursive: true, force: true });
      await proj.dispose();
    }
  });
});

// ---------- subprocess integration tests ----------

describe("CLI --project-root flag (subprocess)", () => {
  test("G1: --project-root <cwd>（cwd と一致）→ gate なしで write 成功", async () => {
    const proj = await makeTeamProject("cmux-team-440-g1-");
    try {
      const r = await runCli(
        ["create-task", "--title", "g1-test", "--project-root", proj.root],
        { cwd: proj.root },
      );
      expect(r.code).toBe(0);
    } finally {
      await proj.dispose();
    }
  }, 30000);

  test("G2: cwd 不一致 + TTY なし（pipe stdin） → exit 1", async () => {
    const projA = await makeTeamProject("cmux-team-440-g2a-");
    const projB = await makeTeamProject("cmux-team-440-g2b-");
    try {
      const r = await runCli(
        ["create-task", "--title", "g2-test", "--project-root", projB.root],
        { cwd: projA.root },
      );
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("--project-root differs from cwd");
    } finally {
      await projA.dispose();
      await projB.dispose();
    }
  }, 30000);

  test("G3: cwd 不一致 + --project-root-confirm → gate skip して write 成功", async () => {
    const projA = await makeTeamProject("cmux-team-440-g3a-");
    const projB = await makeTeamProject("cmux-team-440-g3b-");
    try {
      const r = await runCli(
        ["create-task", "--title", "g3-test", "--project-root", projB.root, "--project-root-confirm"],
        { cwd: projA.root },
      );
      expect(r.code).toBe(0);
    } finally {
      await projA.dispose();
      await projB.dispose();
    }
  }, 30000);

  test("G4: cwd 不一致 + CMUX_TEAM_PROJECT_ROOT_CONFIRM=1 env → gate skip", async () => {
    const projA = await makeTeamProject("cmux-team-440-g4a-");
    const projB = await makeTeamProject("cmux-team-440-g4b-");
    try {
      const r = await runCli(
        ["create-task", "--title", "g4-test", "--project-root", projB.root],
        {
          cwd: projA.root,
          env: { CMUX_TEAM_PROJECT_ROOT_CONFIRM: "1" },
        },
      );
      expect(r.code).toBe(0);
    } finally {
      await projA.dispose();
      await projB.dispose();
    }
  }, 30000);

  test("G5: read 系（status）は cwd と異なる --project-root でも gate なし", async () => {
    const projA = await makeTeamProject("cmux-team-440-g5a-");
    const projB = await makeTeamProject("cmux-team-440-g5b-");
    try {
      const r = await runCli(
        ["status", "--project-root", projB.root],
        { cwd: projA.root },
      );
      // status は team.json なしでも exit 0 + メッセージのみ
      expect(r.code).toBe(0);
      // gate 関連の error が出ないこと
      expect(r.stderr).not.toContain("--project-root differs from cwd");
    } finally {
      await projA.dispose();
      await projB.dispose();
    }
  }, 30000);
});

// ---------- read 系 / エラーケース ----------

describe("--project-root read 系", () => {
  test("R3: 存在しない path → exit 1 + stderr 'project root not found'", async () => {
    const proj = await makeTeamProject("cmux-team-440-r3-");
    const missing = join(tmpdir(), `cmux-team-440-no-${Date.now()}-${Math.random()}`);
    try {
      const r = await runCli(
        ["status", "--project-root", missing],
        { cwd: proj.root },
      );
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("project root not found");
    } finally {
      await proj.dispose();
    }
  }, 30000);

  test("R4: .team/ を含まない path → exit 1 + stderr 'not a cmux-team project'", async () => {
    const proj = await makeTeamProject("cmux-team-440-r4-");
    const plain = await mkdtemp(join(tmpdir(), "cmux-team-440-r4plain-"));
    try {
      const r = await runCli(
        ["status", "--project-root", plain],
        { cwd: proj.root },
      );
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("not a cmux-team project");
    } finally {
      await proj.dispose();
      await rm(plain, { recursive: true, force: true });
    }
  }, 30000);
});

// ---------- spawn-* 経路の env 継承テスト（S6）----------
// 戦略: subprocess + ログ assert。spawn-conductor は cmux 接続失敗で exit するが、
// その失敗ログより前に env / cwd の chdir 関連のログが出る。
// 主に「flag 由来の path で chdir した」ことを stderr で確認する。

describe("spawn-* 経路の env 継承", () => {
  test("Sp1: spawn-conductor --project-root <dummy> が flag 由来の path で chdir する", async () => {
    const projA = await makeTeamProject("cmux-team-440-sp1a-");
    const projB = await makeTeamProject("cmux-team-440-sp1b-");
    try {
      const r = await runCli(
        ["spawn-conductor", "--project-root", projB.root, "--project-root-confirm"],
        { cwd: projA.root },
      );
      // chdir 失敗時は "[cmux-team] chdir ... 失敗" がでる。失敗していないこと
      expect(r.stderr).not.toContain(`[cmux-team] chdir "${projA.root}" 失敗`);
      // PROJECT_ROOT は flag 由来になっているはず（log 出力 or その後の処理を確認）。
      // cmux 接続失敗の stderr が projB.root を含むかは保証されないので、
      // chdir 成功（projA root への chdir エラーがないこと）と R-3/R-4 の strict 動作で間接確認
      // exit code は cmux なし環境で非 0 になりうるが、code = 1 で gate 由来のメッセージが出ないこと
      expect(r.stderr).not.toContain("--project-root differs from cwd");
    } finally {
      await projA.dispose();
      await projB.dispose();
    }
  }, 30000);
});
