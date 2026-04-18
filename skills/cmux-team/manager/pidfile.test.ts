/**
 * pidfile.ts のテスト — daemon 多重起動防止ロック
 *
 * - mkdtemp で独立 tmp dir を使うため並列実行で衝突しない
 * - 実 PID（process.pid）の alive 判定は OS 依存のため、isAliveImpl / psCommandImpl を DI して決定論化する
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  acquirePidFile,
  releasePidFile,
  PidFileLockedError,
  isAlive,
  looksLikeCmuxTeamProcess,
} from "./pidfile";

let testDir: string;
let pidFilePath: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "cmux-pidfile-test-"));
  pidFilePath = join(testDir, "daemon.pid");
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
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

  test("main.ts を含めば true", () => {
    expect(looksLikeCmuxTeamProcess("/usr/local/bin/bun run /path/to/main.ts start")).toBe(true);
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

// --- Step 3: 既存 pidfile (生存中 & cmux-team らしい) → fail-stop --------

describe("acquirePidFile - existing alive cmux-team process", () => {
  test("生きている cmux-team らしき pidfile があれば PidFileLockedError", async () => {
    await writeFile(pidFilePath, "54321");
    await expect(
      acquirePidFile(pidFilePath, testDir, {
        selfPid: 12345,
        isAliveImpl: () => true,
        psCommandImpl: async () => "bun run /path/to/main.ts start",
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
      psCommandImpl: async () => "bun run main.ts start",
      retries: 1,
      retryIntervalMs: 1,
    }).catch(() => {});
    const content = await readFile(pidFilePath, "utf-8");
    expect(content).toBe("54321");
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
        psCommandImpl: async () => "bun run main.ts start",
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

// --- 保守的な stale 判定: ps 取得失敗時は locked 扱い --------------------

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
