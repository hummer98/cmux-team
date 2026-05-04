/**
 * pidfile.ts のテスト — daemon 多重起動防止ロック
 *
 * - createDummyProject で独立 tmp dir を使うため並列実行で衝突しない
 * - 実 PID（process.pid）の alive 判定は OS 依存のため、isAliveImpl / psCommandImpl を DI して決定論化する
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { writeFile, readFile, unlink as realUnlink } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import {
  acquirePidFile,
  releasePidFile,
  PidFileLockedError,
  isAlive,
  looksLikeCmuxTeamProcess,
  installCrashHandler,
} from "./pidfile";
import { createDummyProject, type DummyProject } from "./test-project";

let project: DummyProject;
let testDir: string;
let pidFilePath: string;

beforeEach(async () => {
  project = await createDummyProject({
    prefix: "cmux-pidfile-test-",
    subdirs: [],
    setProjectRootEnv: false,
    createTeamDir: false,
  });
  testDir = project.root;
  pidFilePath = join(testDir, "daemon.pid");
});

afterEach(async () => {
  await project.dispose();
});

// --- Step 1: isAlive / looksLikeCmuxTeamProcess 単体 -------------------

describe("isAlive (re-exported from cmux)", () => {
  test("現在のプロセス PID なら true", () => {
    expect(isAlive(process.pid)).toBe(true);
  });

  test("使われていそうにない大きな PID なら false", () => {
    // 4194303 = Linux の pid_max デフォルト上限近辺（macOS では到達し得ない領域）
    expect(isAlive(4194303)).toBe(false);
  });
});

describe("looksLikeCmuxTeamProcess", () => {
  test("空文字は false", () => {
    expect(looksLikeCmuxTeamProcess("")).toBe(false);
  });

  // T423 S2: cmux-team フルパスでのみ true を返すよう厳密化。
  // 旧 input は generic な main.ts だったが false にすべき → cmux-team 固有 path に修正。
  test("cmux-team フルパスの main.ts を含めば true", () => {
    expect(
      looksLikeCmuxTeamProcess(
        "/usr/local/bin/bun run /Users/foo/cmux-team/skills/cmux-team/manager/main.ts start",
      ),
    ).toBe(true);
  });

  test("cmux-team を含めば true", () => {
    expect(looksLikeCmuxTeamProcess("npx cmux-team start")).toBe(true);
  });

  test("関連のない command は false", () => {
    expect(looksLikeCmuxTeamProcess("node /some/other/script.js")).toBe(false);
  });

  test("単なるシェル(-zsh) は false", () => {
    expect(looksLikeCmuxTeamProcess("-zsh")).toBe(false);
  });

  // T423 S2: 過寛容判定の解消を assert する新規テスト
  test("無関係プロジェクトの main.ts は false (過寛容判定の解消)", () => {
    expect(
      looksLikeCmuxTeamProcess("bun run /Users/foo/other-project/main.ts"),
    ).toBe(false);
  });

  test("cmux-team フルパスの main.ts (引数なし) は true", () => {
    expect(
      looksLikeCmuxTeamProcess(
        "bun run /Users/yamamoto/cmux-team/skills/cmux-team/manager/main.ts start",
      ),
    ).toBe(true);
  });

  test("npm global bin の cmux-team は true", () => {
    expect(looksLikeCmuxTeamProcess("/usr/local/bin/cmux-team start")).toBe(true);
  });
});

// --- Step 2: acquirePidFile happy path ---------------------------------

describe("acquirePidFile - happy path", () => {
  test("空ディレクトリに pidfile を作成し selfPid が書き込まれる", async () => {
    await acquirePidFile(pidFilePath, testDir, { selfPid: 12345 });
    expect(existsSync(pidFilePath)).toBe(true);
    const content = await readFile(pidFilePath, "utf-8");
    expect(content).toBe("12345");
  });

  test("selfPid 未指定なら process.pid が書き込まれる", async () => {
    await acquirePidFile(pidFilePath, testDir);
    const content = await readFile(pidFilePath, "utf-8");
    expect(content).toBe(String(process.pid));
  });
});

describe("releasePidFile", () => {
  test("存在するパスを削除する", async () => {
    await writeFile(pidFilePath, "99999");
    await releasePidFile(pidFilePath);
    expect(existsSync(pidFilePath)).toBe(false);
  });

  test("不在のパスに対しては no-op（例外を投げない）", async () => {
    await expect(releasePidFile(pidFilePath)).resolves.toBeUndefined();
  });
});

// --- Step 2.5: parent dir 不在から作成 (T287) --------------------------

describe("acquirePidFile - missing parent directory", () => {
  test(".team/ が未作成でも pidfile を作成できる（T287）", async () => {
    const nestedPath = join(testDir, ".team/daemon.pid");
    expect(existsSync(join(testDir, ".team"))).toBe(false);
    await acquirePidFile(nestedPath, testDir, { selfPid: 12345 });
    expect(existsSync(nestedPath)).toBe(true);
    const content = await readFile(nestedPath, "utf-8");
    expect(content).toBe("12345");
  });

  test("parent dir がすでに存在する場合は no-op（既存 pidfile テストが regression しない）", async () => {
    await acquirePidFile(pidFilePath, testDir, { selfPid: 12345 });
    const content = await readFile(pidFilePath, "utf-8");
    expect(content).toBe("12345");
  });
});

// --- Step 3: 既存 pidfile (生存中 & cmux-team らしい) → fail-stop --------

describe("acquirePidFile - existing alive cmux-team process", () => {
  test("生きている cmux-team らしき pidfile があれば PidFileLockedError", async () => {
    await writeFile(pidFilePath, "54321");
    await expect(
      acquirePidFile(pidFilePath, testDir, {
        selfPid: 12345,
        isAliveImpl: () => true,
        psCommandImpl: async () =>
          "bun run /Users/foo/cmux-team/skills/cmux-team/manager/main.ts start",
        retries: 1,
        retryIntervalMs: 1,
      }),
    ).rejects.toBeInstanceOf(PidFileLockedError);
  });

  test("PidFileLockedError は existingPid / workspace を保持する", async () => {
    await writeFile(pidFilePath, "54321");
    try {
      await acquirePidFile(pidFilePath, testDir, {
        selfPid: 12345,
        isAliveImpl: () => true,
        psCommandImpl: async () => "cmux-team start",
        retries: 1,
        retryIntervalMs: 1,
      });
      throw new Error("should have thrown");
    } catch (e: any) {
      expect(e).toBeInstanceOf(PidFileLockedError);
      expect(e.existingPid).toBe(54321);
      expect(e.workspace).toBe(testDir);
      expect(e.message).toContain("54321");
      expect(e.message).toContain(testDir);
    }
  });

  test("PidFileLockedError 時は pidfile が上書きされない", async () => {
    await writeFile(pidFilePath, "54321");
    await acquirePidFile(pidFilePath, testDir, {
      selfPid: 12345,
      isAliveImpl: () => true,
      psCommandImpl: async () =>
        "bun run /Users/foo/cmux-team/skills/cmux-team/manager/main.ts start",
      retries: 1,
      retryIntervalMs: 1,
    }).catch(() => {});
    const content = await readFile(pidFilePath, "utf-8");
    expect(content).toBe("54321");
  });

  // T286 S6: `cmux-team stop` は廃止されたため、エラーメッセージの案内から削除する
  test("PidFileLockedError のメッセージに 'cmux-team stop' 案内が含まれない", () => {
    const err = new PidFileLockedError(54321, "/tmp/ws");
    expect(err.message).not.toContain("cmux-team stop");
  });

  test("PidFileLockedError のメッセージに daemon が cmux 終了で自動停止する旨の案内が含まれる", () => {
    const err = new PidFileLockedError(54321, "/tmp/ws");
    expect(err.message).toContain("kill 54321");
    // 「cmux セッション終了で daemon も停止する」という代替案内
    expect(err.message.toLowerCase()).toContain("cmux");
  });
});

// --- Step 4: 既存 pidfile (dead) → 上書き成功 ---------------------------

describe("acquirePidFile - existing dead process (stale)", () => {
  test("死んでいる pidfile は stale とみなされて上書きされる", async () => {
    await writeFile(pidFilePath, "99999");
    await acquirePidFile(pidFilePath, testDir, {
      selfPid: 12345,
      isAliveImpl: () => false,
      psCommandImpl: async () => "",
      retries: 3,
      retryIntervalMs: 1,
    });
    const content = await readFile(pidFilePath, "utf-8");
    expect(content).toBe("12345");
  });

  test("非数値 pidfile も stale として扱う", async () => {
    await writeFile(pidFilePath, "not-a-number");
    await acquirePidFile(pidFilePath, testDir, {
      selfPid: 12345,
      isAliveImpl: () => false,
      psCommandImpl: async () => "",
      retries: 3,
      retryIntervalMs: 1,
    });
    const content = await readFile(pidFilePath, "utf-8");
    expect(content).toBe("12345");
  });

  test("空の pidfile も stale として扱う", async () => {
    await writeFile(pidFilePath, "");
    await acquirePidFile(pidFilePath, testDir, {
      selfPid: 12345,
      isAliveImpl: () => false,
      psCommandImpl: async () => "",
      retries: 3,
      retryIntervalMs: 1,
    });
    const content = await readFile(pidFilePath, "utf-8");
    expect(content).toBe("12345");
  });
});

// --- Step 5: pid 再利用 (alive だが cmux-team 外) → 上書き成功 ----------

describe("acquirePidFile - pid reused by non-cmux-team process", () => {
  test("alive だが ps 出力が cmux-team でなければ stale とみなし上書き", async () => {
    await writeFile(pidFilePath, "99999");
    await acquirePidFile(pidFilePath, testDir, {
      selfPid: 12345,
      isAliveImpl: () => true,
      psCommandImpl: async () => "-zsh",
      retries: 3,
      retryIntervalMs: 1,
    });
    const content = await readFile(pidFilePath, "utf-8");
    expect(content).toBe("12345");
  });
});

// --- Step 6: EEXIST race リトライ --------------------------------------

describe("acquirePidFile - EEXIST retry", () => {
  test("pre-existing dead pidfile → EEXIST → stale 判定 → unlink → retry 成功", async () => {
    // 実装上 writeFile(..., { flag: 'wx' }) が最初 EEXIST を返す → 内部で stale 判定して再試行
    await writeFile(pidFilePath, "99999");
    await acquirePidFile(pidFilePath, testDir, {
      selfPid: 12345,
      isAliveImpl: () => false,
      psCommandImpl: async () => "",
      retries: 3,
      retryIntervalMs: 5,
    });
    expect(existsSync(pidFilePath)).toBe(true);
    const content = await readFile(pidFilePath, "utf-8");
    expect(content).toBe("12345");
  });
});

// --- Step 7: EEXIST 永続的 (alive cmux-team) → PidFileLockedError -------

describe("acquirePidFile - retries exhausted with persistent alive cmux-team", () => {
  test("リトライしても acquire できず PidFileLockedError", async () => {
    await writeFile(pidFilePath, "77777");
    await expect(
      acquirePidFile(pidFilePath, testDir, {
        selfPid: 12345,
        isAliveImpl: () => true,
        psCommandImpl: async () =>
          "bun run /Users/foo/cmux-team/skills/cmux-team/manager/main.ts start",
        retries: 2,
        retryIntervalMs: 1,
      }),
    ).rejects.toMatchObject({
      name: "PidFileLockedError",
      existingPid: 77777,
      workspace: testDir,
    });
  });
});

// --- T423 S5: stale 判定ログ -------------------------------------------

describe("acquirePidFile - stale detection logging", () => {
  test("dead プロセス検知時は pidfile_stale_detected reason=dead をログする", async () => {
    await writeFile(pidFilePath, "99999");
    const logs: Array<{ event: string; detail: string }> = [];
    await acquirePidFile(pidFilePath, testDir, {
      selfPid: 12345,
      isAliveImpl: () => false,
      psCommandImpl: async () => "",
      retries: 3,
      retryIntervalMs: 1,
      logImpl: async (event, detail) => {
        logs.push({ event, detail });
      },
    });
    const stale = logs.filter((l) => l.event === "pidfile_stale_detected");
    expect(stale.length).toBe(1);
    expect(stale[0]!.detail).toContain("existing_pid=99999");
    expect(stale[0]!.detail).toContain("reason=dead");
  });

  test("非数値 pidfile 検知時は pidfile_stale_detected reason=unparseable をログする", async () => {
    await writeFile(pidFilePath, "not-a-number");
    const logs: Array<{ event: string; detail: string }> = [];
    await acquirePidFile(pidFilePath, testDir, {
      selfPid: 12345,
      isAliveImpl: () => false,
      psCommandImpl: async () => "",
      retries: 3,
      retryIntervalMs: 1,
      logImpl: async (event, detail) => {
        logs.push({ event, detail });
      },
    });
    const stale = logs.filter((l) => l.event === "pidfile_stale_detected");
    expect(stale.length).toBe(1);
    expect(stale[0]!.detail).toContain("reason=unparseable");
  });

  test("PID 再利用検知時は pidfile_stale_detected reason=pid_reused と truncate された ps_output をログする", async () => {
    await writeFile(pidFilePath, "99999");
    const logs: Array<{ event: string; detail: string }> = [];
    // 80 文字を超える長い ps 出力を返して truncate を検証する
    const longPsOutput =
      "/bin/zsh --some-very-long-arguments-that-exceed-eighty-characters-for-truncation-x".padEnd(
        120,
        "x",
      );
    await acquirePidFile(pidFilePath, testDir, {
      selfPid: 12345,
      isAliveImpl: () => true,
      psCommandImpl: async () => longPsOutput,
      retries: 3,
      retryIntervalMs: 1,
      logImpl: async (event, detail) => {
        logs.push({ event, detail });
      },
    });
    const stale = logs.filter((l) => l.event === "pidfile_stale_detected");
    expect(stale.length).toBe(1);
    expect(stale[0]!.detail).toContain("existing_pid=99999");
    expect(stale[0]!.detail).toContain("reason=pid_reused");
    // 80 文字に truncate されていることを確認（ps_output= の値部分）
    const match = stale[0]!.detail.match(/ps_output=(.*)$/);
    expect(match).toBeTruthy();
    expect(match![1]!.length).toBeLessThanOrEqual(80);
  });
});

// --- T425 minor #1: unlink 失敗ログ ------------------------------------

describe("acquirePidFile - unlink failure logging (T425 minor #1)", () => {
  test("EBUSY 等の unlink エラーは pidfile_unlink_failed をログする (dead 経路)", async () => {
    await writeFile(pidFilePath, "99999");
    const logs: Array<{ event: string; detail: string }> = [];
    const ebusyError = Object.assign(new Error("resource busy"), { code: "EBUSY" });
    await expect(
      acquirePidFile(pidFilePath, testDir, {
        selfPid: 12345,
        isAliveImpl: () => false, // dead 判定 → unlink path 141
        psCommandImpl: async () => "",
        retries: 1,
        retryIntervalMs: 1,
        logImpl: async (event, detail) => {
          logs.push({ event, detail });
        },
        unlinkImpl: async () => {
          throw ebusyError;
        },
      }),
    ).rejects.toBeInstanceOf(PidFileLockedError); // 全 retry 失敗で locked 扱い
    const failed = logs.filter((l) => l.event === "pidfile_unlink_failed");
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect(failed[0]!.detail).toContain("error_code=EBUSY");
    expect(failed[0]!.detail).toContain("path=" + pidFilePath);
  });

  test("ENOENT は pidfile_unlink_failed をログしない（既存挙動の保持）", async () => {
    await writeFile(pidFilePath, "99999");
    const logs: Array<{ event: string; detail: string }> = [];
    const enoentError = Object.assign(new Error("no such file"), { code: "ENOENT" });
    let callCount = 0;
    await acquirePidFile(pidFilePath, testDir, {
      selfPid: 12345,
      isAliveImpl: () => false,
      psCommandImpl: async () => "",
      retries: 3,
      retryIntervalMs: 1,
      logImpl: async (event, detail) => {
        logs.push({ event, detail });
      },
      unlinkImpl: async (p) => {
        callCount++;
        if (callCount === 1) throw enoentError; // 1 回目だけ ENOENT
        await realUnlink(p); // 2 回目以降は real
      },
    });
    expect(logs.filter((l) => l.event === "pidfile_unlink_failed").length).toBe(0);
  });

  test("unparseable 経路 (line 133) でも EBUSY → pidfile_unlink_failed", async () => {
    await writeFile(pidFilePath, "not-a-number");
    const logs: Array<{ event: string; detail: string }> = [];
    const ebusyError = Object.assign(new Error("resource busy"), { code: "EBUSY" });
    await expect(
      acquirePidFile(pidFilePath, testDir, {
        selfPid: 12345,
        isAliveImpl: () => false,
        psCommandImpl: async () => "",
        retries: 1,
        retryIntervalMs: 1,
        logImpl: async (event, detail) => {
          logs.push({ event, detail });
        },
        unlinkImpl: async () => {
          throw ebusyError;
        },
      }),
    ).rejects.toBeInstanceOf(PidFileLockedError);
    const failed = logs.filter((l) => l.event === "pidfile_unlink_failed");
    expect(failed.length).toBeGreaterThanOrEqual(1);
  });

  test("pid_reused 経路 (line 160) でも EBUSY → pidfile_unlink_failed", async () => {
    await writeFile(pidFilePath, "99999");
    const logs: Array<{ event: string; detail: string }> = [];
    const ebusyError = Object.assign(new Error("resource busy"), { code: "EBUSY" });
    await expect(
      acquirePidFile(pidFilePath, testDir, {
        selfPid: 12345,
        isAliveImpl: () => true, // alive
        psCommandImpl: async () => "-zsh", // cmux-team でない → pid_reused
        retries: 1,
        retryIntervalMs: 1,
        logImpl: async (event, detail) => {
          logs.push({ event, detail });
        },
        unlinkImpl: async () => {
          throw ebusyError;
        },
      }),
    ).rejects.toBeInstanceOf(PidFileLockedError);
    const failed = logs.filter((l) => l.event === "pidfile_unlink_failed");
    expect(failed.length).toBeGreaterThanOrEqual(1);
  });
});

// --- 保守的な stale 判定: ps 取得失敗時は locked 扱い --------------------

// --- T423 S3: installCrashHandler の PID-aware cleanup ----------------

describe("installCrashHandler", () => {
  let uninstall: (() => void) | null = null;
  let errorSpy: ReturnType<typeof spyOn> | null = null;

  beforeEach(() => {
    // fatalHandler は console.error(err) で fatal エラーを stderr に出すが、
    // テスト内では意図的に投げているエラーなので mock で suppress する。
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    if (uninstall) {
      uninstall();
      uninstall = null;
    }
    errorSpy?.mockRestore();
    errorSpy = null;
  });

  test("self pid が書いた pidfile は exit handler 発火時に削除する", async () => {
    await writeFile(pidFilePath, String(process.pid));
    uninstall = installCrashHandler(pidFilePath, {
      exitImpl: () => {},
    });
    process.emit("exit", 0);
    expect(existsSync(pidFilePath)).toBe(false);
  });

  test("他 pid が書いた pidfile は handler 発火時に削除しない", async () => {
    const otherPid = process.pid + 1;
    await writeFile(pidFilePath, String(otherPid));
    uninstall = installCrashHandler(pidFilePath, {
      exitImpl: () => {},
    });
    process.emit("exit", 0);
    expect(existsSync(pidFilePath)).toBe(true);
    const content = await readFile(pidFilePath, "utf-8");
    expect(content).toBe(String(otherPid));
  });

  test("pidfile 不在時 (ENOENT) は no-op で例外も出さない", () => {
    expect(existsSync(pidFilePath)).toBe(false);
    uninstall = installCrashHandler(pidFilePath, {
      exitImpl: () => {},
    });
    expect(() => process.emit("exit", 0)).not.toThrow();
  });

  test("uncaughtException 経路でも PID-aware ロジックで動き exit(1) する", async () => {
    await writeFile(pidFilePath, String(process.pid));
    const exitCalls: number[] = [];
    uninstall = installCrashHandler(pidFilePath, {
      exitImpl: (code) => {
        exitCalls.push(code);
      },
    });
    process.emit("uncaughtException", new Error("test-fatal"));
    expect(existsSync(pidFilePath)).toBe(false);
    expect(exitCalls).toEqual([1]);
  });

  test("uncaughtException 経路で他 pid の pidfile は削除されない", async () => {
    const otherPid = process.pid + 1;
    await writeFile(pidFilePath, String(otherPid));
    const exitCalls: number[] = [];
    uninstall = installCrashHandler(pidFilePath, {
      exitImpl: (code) => {
        exitCalls.push(code);
      },
    });
    process.emit("uncaughtException", new Error("test-fatal"));
    expect(existsSync(pidFilePath)).toBe(true);
    expect(exitCalls).toEqual([1]);
  });

  test("unhandledRejection 経路でも PID-aware ロジックで動き exit(1) する", async () => {
    await writeFile(pidFilePath, String(process.pid));
    const exitCalls: number[] = [];
    uninstall = installCrashHandler(pidFilePath, {
      exitImpl: (code) => {
        exitCalls.push(code);
      },
    });
    process.emit(
      "unhandledRejection",
      new Error("test-rejection"),
      Promise.resolve(),
    );
    expect(existsSync(pidFilePath)).toBe(false);
    expect(exitCalls).toEqual([1]);
  });

  test("uninstall で hook が解除され exit handler が発火しない", async () => {
    await writeFile(pidFilePath, String(process.pid));
    uninstall = installCrashHandler(pidFilePath, {
      exitImpl: () => {},
    });
    uninstall();
    uninstall = null;
    process.emit("exit", 0);
    expect(existsSync(pidFilePath)).toBe(true);
  });
});

describe("acquirePidFile - ps command failure", () => {
  test("alive で ps 出力が空なら保守的に PidFileLockedError", async () => {
    // ps が失敗 (空文字) かつ isAlive が true の場合、保守的に alive 扱いとして fail-stop する
    // （誤って稼働中の cmux-team daemon を潰さないため）
    await writeFile(pidFilePath, "88888");
    await expect(
      acquirePidFile(pidFilePath, testDir, {
        selfPid: 12345,
        isAliveImpl: () => true,
        psCommandImpl: async () => "",
        retries: 1,
        retryIntervalMs: 1,
      }),
    ).rejects.toBeInstanceOf(PidFileLockedError);
  });
});
