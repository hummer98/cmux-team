import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { resolveWorktreeBase } from "./worktree-base";

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "cmux-worktree-base-test-"));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

describe("resolveWorktreeBase", () => {
  test("baseBranch が明示されていれば explicit で即返す（git を呼ばない）", async () => {
    const result = await resolveWorktreeBase(testDir, {
      baseBranch: "feature-x",
      mainBranch: "main",
      git: async () => {
        throw new Error("should not be called");
      },
    });
    expect(result).toEqual({
      startPoint: "feature-x",
      source: "explicit",
      baseLabel: "feature-x",
    });
  });

  test("baseBranch が空白のみなら config 解決にフォールスルー", async () => {
    const result = await resolveWorktreeBase(testDir, {
      baseBranch: "  \n  ",
      mainBranch: "main",
      git: async (args) => {
        if (
          args[0] === "rev-parse" &&
          args.includes("refs/remotes/origin/main^{commit}")
        ) {
          return "abc123";
        }
        throw new Error("unexpected");
      },
    });
    expect(result).toEqual({
      startPoint: "origin/main",
      source: "config-origin",
      baseLabel: "origin/main",
    });
  });

  test("mainBranch ありで origin/<mainBranch> が存在すれば config-origin", async () => {
    const calls: string[][] = [];
    const result = await resolveWorktreeBase(testDir, {
      mainBranch: "dev",
      git: async (args) => {
        calls.push([...args]);
        if (
          args[0] === "rev-parse" &&
          args.includes("refs/remotes/origin/dev^{commit}")
        ) {
          return "deadbeef";
        }
        throw new Error("unexpected: " + args.join(" "));
      },
    });
    expect(result).toEqual({
      startPoint: "origin/dev",
      source: "config-origin",
      baseLabel: "origin/dev",
    });
    expect(calls.length).toBe(1);
  });

  test("origin/<mainBranch> が無ければ config-local にフォールバック", async () => {
    const result = await resolveWorktreeBase(testDir, {
      mainBranch: "dev",
      git: async (args) => {
        if (args[0] !== "rev-parse") throw new Error("unexpected");
        if (args.includes("refs/remotes/origin/dev^{commit}")) {
          const e: any = new Error("unknown revision");
          e.stderr = "fatal: unknown revision\n";
          throw e;
        }
        if (args.includes("refs/heads/dev^{commit}")) {
          return "cafef00d";
        }
        throw new Error("unexpected");
      },
    });
    expect(result).toEqual({
      startPoint: "dev",
      source: "config-local",
      baseLabel: "dev",
    });
  });

  test("origin も local も無ければ head-fallback", async () => {
    const result = await resolveWorktreeBase(testDir, {
      mainBranch: "dev",
      git: async () => {
        const e: any = new Error("unknown revision");
        e.stderr = "fatal: unknown revision\n";
        throw e;
      },
    });
    expect(result).toEqual({
      startPoint: null,
      source: "head-fallback",
      baseLabel: "HEAD",
    });
  });

  test("mainBranch が未指定（空）なら head-fallback", async () => {
    const result = await resolveWorktreeBase(testDir, {
      git: async () => {
        throw new Error("should not be called");
      },
    });
    expect(result).toEqual({
      startPoint: null,
      source: "head-fallback",
      baseLabel: "HEAD",
    });
  });

  test("mainBranch が空白のみなら head-fallback", async () => {
    const result = await resolveWorktreeBase(testDir, {
      mainBranch: " \n ",
      git: async () => {
        throw new Error("should not be called");
      },
    });
    expect(result).toEqual({
      startPoint: null,
      source: "head-fallback",
      baseLabel: "HEAD",
    });
  });

  test("mainBranch が空白付きでも trim される", async () => {
    const result = await resolveWorktreeBase(testDir, {
      mainBranch: "  dev  \n",
      git: async (args) => {
        if (args.includes("refs/remotes/origin/dev^{commit}")) return "abc";
        throw new Error("unexpected: " + args.join(" "));
      },
    });
    expect(result.source).toBe("config-origin");
    expect(result.startPoint).toBe("origin/dev");
  });

  test("baseBranch='HEAD' の場合は explicit として HEAD をそのまま使う（ローカル変更含める意図）", async () => {
    const result = await resolveWorktreeBase(testDir, {
      baseBranch: "HEAD",
      mainBranch: "main",
      git: async () => {
        throw new Error("should not be called");
      },
    });
    expect(result).toEqual({
      startPoint: "HEAD",
      source: "explicit",
      baseLabel: "HEAD",
    });
  });

  test("doFetch=true のとき fetch を打ってから rev-parse する", async () => {
    const calls: string[][] = [];
    const result = await resolveWorktreeBase(testDir, {
      mainBranch: "main",
      doFetch: true,
      git: async (args) => {
        calls.push([...args]);
        if (args[0] === "fetch") return "";
        if (args.includes("refs/remotes/origin/main^{commit}")) return "abc";
        throw new Error("unexpected");
      },
    });
    expect(calls[0]).toEqual(["fetch", "--quiet", "origin", "main"]);
    expect(result.source).toBe("config-origin");
  });

  test("doFetch=true で fetch が失敗しても解決処理は継続する（ベストエフォート）", async () => {
    const result = await resolveWorktreeBase(testDir, {
      mainBranch: "main",
      doFetch: true,
      git: async (args) => {
        if (args[0] === "fetch") {
          const e: any = new Error("fetch failed");
          e.stderr = "fatal: unable to access\n";
          throw e;
        }
        if (args.includes("refs/remotes/origin/main^{commit}")) return "abc";
        throw new Error("unexpected");
      },
    });
    expect(result.source).toBe("config-origin");
  });

  test("doFetch が未指定なら fetch を打たない", async () => {
    const calls: string[][] = [];
    await resolveWorktreeBase(testDir, {
      mainBranch: "main",
      git: async (args) => {
        calls.push([...args]);
        if (args.includes("refs/remotes/origin/main^{commit}")) return "abc";
        throw new Error("unexpected");
      },
    });
    expect(calls.find((c) => c[0] === "fetch")).toBeUndefined();
  });
});
