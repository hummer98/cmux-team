import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  resolveMainBranch,
  persistMainBranch,
  MainBranchResolutionError,
} from "./main-branch";

let testDir: string;
let savedProjectRoot: string | undefined;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "cmux-main-branch-test-"));
  savedProjectRoot = process.env.PROJECT_ROOT;
  process.env.PROJECT_ROOT = testDir;
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
  if (savedProjectRoot !== undefined) {
    process.env.PROJECT_ROOT = savedProjectRoot;
  } else {
    delete process.env.PROJECT_ROOT;
  }
});

describe("resolveMainBranch", () => {
  test("configMainBranch が指定されていれば source=config で即返す", async () => {
    const result = await resolveMainBranch(testDir, {
      configMainBranch: "develop",
      git: async () => {
        throw new Error("should not be called");
      },
    });
    expect(result).toEqual({ branch: "develop", source: "config" });
  });

  test("configMainBranch が空文字なら自動検出へフォールスルー", async () => {
    const result = await resolveMainBranch(testDir, {
      configMainBranch: "",
      git: async (args) => {
        if (args[0] === "symbolic-ref" && args[1] === "refs/remotes/origin/HEAD") {
          return "refs/remotes/origin/main";
        }
        throw new Error("unexpected");
      },
    });
    expect(result).toEqual({ branch: "main", source: "detected" });
  });

  test("configMainBranch が空白・改行のみなら自動検出へフォールスルー", async () => {
    const result = await resolveMainBranch(testDir, {
      configMainBranch: "  \n  ",
      git: async (args) => {
        if (args[0] === "symbolic-ref" && args[1] === "refs/remotes/origin/HEAD") {
          return "refs/remotes/origin/develop";
        }
        throw new Error("unexpected");
      },
    });
    expect(result).toEqual({ branch: "develop", source: "detected" });
  });

  test("origin/HEAD 成功時は末尾セグメントを抽出する", async () => {
    const result = await resolveMainBranch(testDir, {
      git: async (args) => {
        expect(args).toEqual(["symbolic-ref", "refs/remotes/origin/HEAD"]);
        return "refs/remotes/origin/main";
      },
    });
    expect(result).toEqual({ branch: "main", source: "detected" });
  });

  test("origin/HEAD の出力が refs/remotes/origin/ プレフィックスを含まなければ次段へ", async () => {
    const calls: string[][] = [];
    const result = await resolveMainBranch(testDir, {
      git: async (args) => {
        calls.push([...args]);
        if (args[1] === "refs/remotes/origin/HEAD") return "garbage";
        if (args.includes("--short")) return "develop";
        throw new Error("unexpected");
      },
    });
    expect(result).toEqual({ branch: "develop", source: "detected" });
    expect(calls.length).toBe(2);
  });

  test("origin/HEAD 失敗・HEAD 成功で source=detected に HEAD 名を採用", async () => {
    const result = await resolveMainBranch(testDir, {
      git: async (args) => {
        if (args[1] === "refs/remotes/origin/HEAD") {
          const e: any = new Error("fatal: ref is not symbolic");
          e.stderr = "fatal: ref refs/remotes/origin/HEAD is not a symbolic ref\n";
          throw e;
        }
        if (args.includes("--short")) return "develop";
        throw new Error("unexpected");
      },
    });
    expect(result).toEqual({ branch: "develop", source: "detected" });
  });

  test("両方失敗なら MainBranchResolutionError を throw する (T253)", async () => {
    const fn = resolveMainBranch(testDir, {
      git: async (args) => {
        const e: any = new Error("git not found");
        e.stderr =
          args[1] === "refs/remotes/origin/HEAD"
            ? "fatal: ref refs/remotes/origin/HEAD is not a symbolic ref\n"
            : "fatal: ref HEAD is not a symbolic ref\n";
        throw e;
      },
    });
    await expect(fn).rejects.toThrow(MainBranchResolutionError);
  });

  test("MainBranchResolutionError は stderr を保持する (T253)", async () => {
    let caught: MainBranchResolutionError | undefined;
    try {
      await resolveMainBranch(testDir, {
        git: async (args) => {
          const e: any = new Error("boom");
          e.stderr =
            args[1] === "refs/remotes/origin/HEAD"
              ? "origin-stderr-fixture"
              : "head-stderr-fixture";
          throw e;
        },
      });
    } catch (e) {
      caught = e as MainBranchResolutionError;
    }
    expect(caught).toBeInstanceOf(MainBranchResolutionError);
    expect(caught?.originHeadStderr).toContain("origin-stderr-fixture");
    expect(caught?.headStderr).toContain("head-stderr-fixture");
  });

  test("origin/HEAD が garbage prefix で次段へ流れ、HEAD も失敗すれば throw (T253)", async () => {
    const fn = resolveMainBranch(testDir, {
      git: async (args) => {
        if (args[1] === "refs/remotes/origin/HEAD") {
          return "unexpected/prefix/foo\n"; // prefix 不一致で次段へ
        }
        const e: any = new Error("boom");
        e.stderr = "head-failed";
        throw e;
      },
    });
    await expect(fn).rejects.toThrow(MainBranchResolutionError);
  });

  test("空 configMainBranch + 両 git 失敗 → throw (T253)", async () => {
    const fn = resolveMainBranch(testDir, {
      configMainBranch: "",
      git: async () => {
        const e: any = new Error("x");
        e.stderr = "";
        throw e;
      },
    });
    await expect(fn).rejects.toThrow(MainBranchResolutionError);
  });

  test("空白のみ configMainBranch + 両 git 失敗 → throw (T253)", async () => {
    const fn = resolveMainBranch(testDir, {
      configMainBranch: "   \n",
      git: async () => {
        const e: any = new Error("x");
        e.stderr = "";
        throw e;
      },
    });
    await expect(fn).rejects.toThrow(MainBranchResolutionError);
  });
});

describe("persistMainBranch", () => {
  test(".team ディレクトリが無くても ENOENT にならず作成する (T270)", async () => {
    // testDir 直下にまだ .team/ が無い状態で呼び出す
    await persistMainBranch(testDir, "main");
    const parsed = JSON.parse(
      await readFile(join(testDir, ".team/config.json"), "utf-8"),
    );
    expect(parsed).toEqual({ mainBranch: "main" });
  });

  test("既存 config がない場合は新規作成する", async () => {
    await mkdir(join(testDir, ".team"), { recursive: true });
    await persistMainBranch(testDir, "main");
    const txt = await readFile(join(testDir, ".team/config.json"), "utf-8");
    const parsed = JSON.parse(txt);
    expect(parsed).toEqual({ mainBranch: "main" });
    expect(txt.endsWith("\n")).toBe(true);
  });

  test("既存 config のフィールドを保持する", async () => {
    await mkdir(join(testDir, ".team"), { recursive: true });
    await writeFile(
      join(testDir, ".team/config.json"),
      JSON.stringify({ layout: "wide", models: { conductor: "opus" } }, null, 2) + "\n",
    );
    await persistMainBranch(testDir, "develop");
    const parsed = JSON.parse(
      await readFile(join(testDir, ".team/config.json"), "utf-8"),
    );
    expect(parsed).toEqual({
      layout: "wide",
      models: { conductor: "opus" },
      mainBranch: "develop",
    });
  });

  test("壊れた JSON なら空オブジェクトから書き直す", async () => {
    await mkdir(join(testDir, ".team"), { recursive: true });
    await writeFile(join(testDir, ".team/config.json"), "{ broken");
    await persistMainBranch(testDir, "trunk");
    const parsed = JSON.parse(
      await readFile(join(testDir, ".team/config.json"), "utf-8"),
    );
    expect(parsed).toEqual({ mainBranch: "trunk" });
  });
});
