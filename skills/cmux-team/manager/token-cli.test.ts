/**
 * token-cli.test.ts (T319 / T325 cherry-pick)
 *
 * `cmux-team token <add|list|remove|rotate|set-plan>` の integration テスト。
 * abort 版 (`/Users/yamamoto/git/cmux-team/.worktrees/task-319-1777097734`) の
 * 56 ケースから main API 形状で実装可能なものだけを移植する。
 *
 * 詳細は plan §1.2 / §2-A / §4 (R1〜R11) を参照。
 *
 * モック戦略 (plan §2-A):
 * - **DB**: `process.env.TOKEN_STORE_DB_PATH` を一時ファイルに上書き。
 * - **Keychain**: `process.env.KEYCHAIN_TEST_MODE = "1"` で in-memory モードを使う。
 * - **readline**: ファイル top-level で `mock.module("readline", ...)` を install し、
 *   closure 配列 `askAnswers` を各テストで詰め替える (R5)。
 * - **fetch (probeOrganizationId)**: 関数毎に try/finally で `globalThis.fetch` を復元 (R4 / §8)。
 *   `mock.module` は使わない (hoisting 問題回避)。
 * - **process.exit**: 例外化して try/catch でキャッチ。afterEach で原状復帰。
 * - **process.argv**: beforeAll で original を保存し、afterEach で完全置換 (R8)。
 */

import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
  mock,
} from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";

// ─────────────────────────────────────────────────────────────────────────────
// readline / os モック (top-level install — R5 hoisting 対策)
//
// `os.homedir()` は Bun でも process.env.HOME の動的変更を尊重しない（起動時に
// 解決された値を返す）。`readClaudeCredentials()` が `~/.claude/.credentials.json`
// を読みに行くため、credentials 経路を testDir 配下にリダイレクトするには
// homedir() 自体を override する必要がある。
// ─────────────────────────────────────────────────────────────────────────────

const askAnswers: string[] = [];

mock.module("readline", () => ({
  createInterface: () => ({
    question: (_q: string, cb: (a: string) => void) => {
      const ans = askAnswers.shift() ?? "";
      cb(ans);
    },
    close: () => {},
  }),
}));

let homedirOverride: string | null = null;
const realOs = await import("node:os");
mock.module("os", () => ({
  ...realOs,
  homedir: () => homedirOverride ?? realOs.homedir(),
}));

// readline mock を install してから token-cli を import する。
import {
  cmdTokenAdd,
  cmdTokenList,
  cmdTokenRemove,
  cmdTokenRotate,
  cmdTokenSetPlan,
} from "./token-cli";
import {
  initTokenDB,
  insertToken,
  getTokenByHandle,
  retrieveTokenFromKeychain,
  storeTokenInKeychain,
  upsertUsageSnapshot,
  __resetInMemoryKeychainForTest,
  type InsertTokenInput,
} from "./token-store";

// ─────────────────────────────────────────────────────────────────────────────
// 共通セットアップ
// ─────────────────────────────────────────────────────────────────────────────

let testDir: string;
let originalArgv: string[];
let originalExit: typeof process.exit;
let originalEnv: Record<string, string | undefined>;
let originalFetch: typeof globalThis.fetch;
let consoleLogs: string[];
let consoleErrors: string[];
let originalConsoleLog: typeof console.log;
let originalConsoleError: typeof console.error;
let originalConsoleWarn: typeof console.warn;
let originalStdoutWrite: typeof process.stdout.write;

function setReadlineAnswers(...answers: string[]): void {
  askAnswers.length = 0;
  askAnswers.push(...answers);
}

class TestExitError extends Error {
  constructor(public code: number | string | null | undefined) {
    super(`__test_exit_${code}`);
  }
}

beforeAll(() => {
  originalArgv = process.argv.slice();
  originalExit = process.exit;
  originalFetch = globalThis.fetch;
  originalConsoleLog = console.log;
  originalConsoleError = console.error;
  originalConsoleWarn = console.warn;
  originalStdoutWrite = process.stdout.write.bind(process.stdout);
  originalEnv = {
    TOKEN_STORE_DB_PATH: process.env.TOKEN_STORE_DB_PATH,
    KEYCHAIN_TEST_MODE: process.env.KEYCHAIN_TEST_MODE,
    HOME: process.env.HOME,
  };
});

afterAll(() => {
  process.argv = originalArgv.slice();
  process.exit = originalExit;
  globalThis.fetch = originalFetch;
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
  console.warn = originalConsoleWarn;
  process.stdout.write = originalStdoutWrite as typeof process.stdout.write;
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "cmux-token-cli-"));
  process.env.TOKEN_STORE_DB_PATH = join(testDir, "tokens.db");
  process.env.KEYCHAIN_TEST_MODE = "1";
  // HOME に加えて os.homedir() の override も設定する（Bun は HOME 動的変更を尊重しないため）
  process.env.HOME = testDir;
  homedirOverride = testDir;
  __resetInMemoryKeychainForTest();
  askAnswers.length = 0;

  consoleLogs = [];
  consoleErrors = [];
  console.log = (...args: unknown[]) => {
    consoleLogs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(" "));
  };
  console.warn = (...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(" "));
  };
  // process.stdout.write は probeOrganizationId のローディング表示等に使われるため抑制
  (process.stdout.write as unknown) = () => true;

  process.exit = ((code?: number | string | null) => {
    throw new TestExitError(code);
  }) as never;
});

afterEach(() => {
  process.argv = originalArgv.slice();
  process.exit = originalExit;
  globalThis.fetch = originalFetch;
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
  console.warn = originalConsoleWarn;
  process.stdout.write = originalStdoutWrite as typeof process.stdout.write;
  for (const [k, v] of Object.entries(originalEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  homedirOverride = null;
  askAnswers.length = 0;
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // CI など rm 失敗を許容
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ヘルパ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * fetch を probe 経路（organizationId）専用にスタブする。
 * orgId=null で「ヘッダ無し → probe 失敗」を再現する。
 */
function withMockedFetch<T>(
  orgId: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => {
    const headers = new Headers();
    if (orgId) headers.set("anthropic-organization-id", orgId);
    return new Response("", { status: 200, headers });
  }) as unknown as typeof globalThis.fetch;
  return fn().finally(() => {
    globalThis.fetch = orig;
  });
}

function setArgv(...rest: string[]): void {
  process.argv = ["bun", "cmux-team", "token", ...rest];
}

function makeToken(partial: Partial<InsertTokenInput> = {}): InsertTokenInput {
  return {
    handle: "@test",
    organization_id: "00000000-0000-0000-0000-000000000001",
    auth_hash: "abcdef012345",
    plan: "max-x20",
    plan_ratio: 20.0,
    tags: ["any"],
    credential_source: "manual",
    ...partial,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// credential ファイルを HOME=testDir に書き出すヘルパ (cmdTokenAdd / cmdTokenRotate 用)
// ─────────────────────────────────────────────────────────────────────────────

function writeClaudeCredentials(opts: {
  accessToken: string;
  rateLimitTier?: string;
}): void {
  const dir = join(testDir, ".claude");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: opts.accessToken,
        rateLimitTier: opts.rateLimitTier,
      },
    }),
    { mode: 0o600 },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// cmdTokenAdd
// ─────────────────────────────────────────────────────────────────────────────

describe("cmdTokenAdd (integration)", () => {
  test("credentials 経路成功 → DB / Keychain に登録される (org_id は probe 結果)", async () => {
    setArgv("add");
    writeClaudeCredentials({
      accessToken: "cred-token-AAA",
      rateLimitTier: "default_claude_max_20x",
    });
    setReadlineAnswers(
      "1", // source = credential
      "kddi-dev", // display name → @kddi
      "any,kddi", // tags
    );
    await withMockedFetch("org-cred-1", async () => {
      await cmdTokenAdd();
    });

    const db = initTokenDB();
    try {
      const tok = getTokenByHandle(db, "@kddi");
      expect(tok).not.toBeNull();
      expect(tok?.organization_id).toBe("org-cred-1");
      expect(tok?.plan).toBe("max-x20");
      expect(tok?.plan_ratio).toBe(20.0);
      expect(tok?.auth_hash).toMatch(/^[a-f0-9]{12}$/); // R7
      expect(tok?.credential_source).toBe("claude-credentials"); // R9
      expect(tok?.tags).toEqual(["any", "kddi"]);
      expect(retrieveTokenFromKeychain("@kddi")).toBe("cred-token-AAA");
    } finally {
      db.close();
    }
  });

  test("organization_id を probe できないと exit 1", async () => {
    setArgv("add");
    setReadlineAnswers(
      "2", // manual
      "tok-no-probe",
      "personal",
      "any",
    );
    let caught: TestExitError | null = null;
    try {
      await withMockedFetch(null, async () => {
        await cmdTokenAdd();
      });
    } catch (e) {
      caught = e as TestExitError;
    }
    expect(caught).toBeInstanceOf(TestExitError);
    expect(caught?.code).toBe(1);
    expect(consoleErrors.join("\n")).toContain("organization_id を取得できませんでした");

    // DB / Keychain には何も書かれていないこと
    const db = initTokenDB();
    try {
      expect(getTokenByHandle(db, "@pers")).toBeNull();
    } finally {
      db.close();
    }
  });

  test("organization_id 重複は exit 1 (rotate を使えと案内)", async () => {
    // 既存 token を仕込む
    {
      const db = initTokenDB();
      try {
        insertToken(db, makeToken({ handle: "@old", organization_id: "org-dup" }));
      } finally {
        db.close();
      }
    }

    setArgv("add");
    setReadlineAnswers(
      "2", // manual
      "new-token",
      "neww",
      "any",
    );
    let caught: TestExitError | null = null;
    try {
      await withMockedFetch("org-dup", async () => {
        await cmdTokenAdd();
      });
    } catch (e) {
      caught = e as TestExitError;
    }
    expect(caught).toBeInstanceOf(TestExitError);
    expect(caught?.code).toBe(1);
    const errs = consoleErrors.join("\n");
    expect(errs).toContain("@old");
    expect(errs).toContain("rotate");
  });

  test("handle 重複は exit 1", async () => {
    {
      const db = initTokenDB();
      try {
        insertToken(db, makeToken({ handle: "@pers", organization_id: "org-existing" }));
      } finally {
        db.close();
      }
    }

    setArgv("add");
    setReadlineAnswers(
      "2", // manual
      "new-token",
      "personal", // → @pers (重複)
      "any",
    );
    let caught: TestExitError | null = null;
    try {
      await withMockedFetch("org-fresh", async () => {
        await cmdTokenAdd();
      });
    } catch (e) {
      caught = e as TestExitError;
    }
    expect(caught).toBeInstanceOf(TestExitError);
    expect(caught?.code).toBe(1);
    expect(consoleErrors.join("\n")).toContain("@pers");
  });

  test("manual 経路成功 (readline で token 貼り付け)", async () => {
    setArgv("add");
    setReadlineAnswers(
      "2", // source = manual
      "manual-test-token-XYZ", // token
      "personal", // display name
      "any", // tags
    );
    await withMockedFetch("org-test-1", async () => {
      await cmdTokenAdd();
    });

    const db = initTokenDB();
    try {
      const tok = getTokenByHandle(db, "@pers");
      expect(tok).not.toBeNull();
      expect(tok?.organization_id).toBe("org-test-1");
      expect(tok?.auth_hash).toMatch(/^[a-f0-9]{12}$/); // R7: 12 文字 prefix
      expect(tok?.credential_source).toBe("manual"); // R9
      expect(tok?.tags).toEqual(["any"]);
      expect(retrieveTokenFromKeychain("@pers")).toBe("manual-test-token-XYZ");
    } finally {
      db.close();
    }
  });

  // skip: tags=auto 警告ロジックは main の cmdTokenAdd に存在しない。
  // 移植には main 側の token-cli.ts に warning 分岐を追加する必要があり、
  // Option C 制約（main の token-cli.ts は変更禁止）に抵触するため移植不能。(R1)
  test.skip("tags=auto 警告: main に該当ロジックなし (R1)", () => {});

  // skip: Keychain 失敗 → DB 巻き戻しの補償 tx は main の cmdTokenAdd に未実装。
  // abort 版の `__setKeychainTestFailureMode` フックも main の token-cli.ts には存在しない。
  // フォローアップタスク「T319 補償 tx 追加」で対応予定。(R3)
  test.skip("Keychain 失敗 → DB 巻き戻し: main に補償 tx 未実装 (R3)", () => {});
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdTokenList
// ─────────────────────────────────────────────────────────────────────────────

describe("cmdTokenList (integration)", () => {
  test("3 件表示 (max-x20 健全 / max-x5 利用率高 / unknown plan snapshot 無し)", async () => {
    {
      const db = initTokenDB();
      try {
        const t1 = insertToken(
          db,
          makeToken({
            handle: "@pers",
            organization_id: "org-1",
            plan: "max-x20",
            plan_ratio: 20.0,
            tags: ["any"],
          }),
        );
        upsertUsageSnapshot(db, {
          token_id: t1.id,
          util_5h: 0.1,
          util_7d: 0.2,
          reset_5h_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          reset_7d_at: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString(),
          unified_status: null,
        });

        const t2 = insertToken(
          db,
          makeToken({
            handle: "@kddi",
            organization_id: "org-2",
            plan: "max-x5",
            plan_ratio: 5.0,
            tags: ["kddi"],
          }),
        );
        upsertUsageSnapshot(db, {
          token_id: t2.id,
          util_5h: 0.97,
          util_7d: 0.5,
          reset_5h_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          reset_7d_at: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
          unified_status: null,
        });

        insertToken(
          db,
          makeToken({
            handle: "@unkn",
            organization_id: "org-3",
            plan: "unknown",
            plan_ratio: null,
            tags: ["any"],
          }),
        );
      } finally {
        db.close();
      }
    }

    setArgv("list");
    await cmdTokenList();
    const out = consoleLogs.join("\n");
    expect(out).toContain("@pers");
    expect(out).toContain("@kddi");
    expect(out).toContain("@unkn");
    expect(out).toContain("max-x20");
    expect(out).toContain("max-x5");
    expect(out).toContain("unknown");
    // util_5h > 0.95 → SELECTABLE 列に "blocked"
    const lines = out.split("\n");
    const kddiLine = lines.find((l) => l.startsWith("@kddi"));
    expect(kddiLine).toContain("blocked");
    // 健全 token は "yes"
    const persLine = lines.find((l) => l.startsWith("@pers"));
    expect(persLine).toContain("yes");
  });

  test("0 件は案内文が出る", async () => {
    setArgv("list");
    await cmdTokenList();
    const output = consoleLogs.join("\n");
    expect(output).toContain("登録済みトークンがありません");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdTokenRemove
// ─────────────────────────────────────────────────────────────────────────────

describe("cmdTokenRemove (integration)", () => {
  test("y 確認で DB と Keychain の両方から消える", async () => {
    {
      const db = initTokenDB();
      try {
        insertToken(db, makeToken({ handle: "@rm", organization_id: "org-rm" }));
      } finally {
        db.close();
      }
      storeTokenInKeychain("@rm", "secret-rm-token");
    }
    expect(retrieveTokenFromKeychain("@rm")).toBe("secret-rm-token");

    setArgv("remove", "@rm");
    setReadlineAnswers("y");
    await cmdTokenRemove();

    const db = initTokenDB();
    try {
      expect(getTokenByHandle(db, "@rm")).toBeNull();
    } finally {
      db.close();
    }
    // Keychain も削除されていること（in-memory モードで retrieve すると throw する）
    expect(() => retrieveTokenFromKeychain("@rm")).toThrow();
  });

  test("不存在 handle は exit 1", async () => {
    setArgv("remove", "@missing");
    let caught: TestExitError | null = null;
    try {
      await cmdTokenRemove();
    } catch (e) {
      caught = e as TestExitError;
    }
    expect(caught).toBeInstanceOf(TestExitError);
    expect(caught?.code).toBe(1);
    expect(consoleErrors.join("\n")).toContain("@missing");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdTokenRotate
// ─────────────────────────────────────────────────────────────────────────────

describe("cmdTokenRotate (integration)", () => {
  test("credential 再取得で auth_hash と Keychain が更新される (12 文字 prefix を維持)", async () => {
    let oldAuthHash: string;
    {
      const db = initTokenDB();
      try {
        const t = insertToken(db, makeToken({ handle: "@rot", organization_id: "org-rot" }));
        oldAuthHash = t.auth_hash;
      } finally {
        db.close();
      }
      storeTokenInKeychain("@rot", "old-token");
    }

    // 新しい credential ファイルを書き出す
    writeClaudeCredentials({ accessToken: "new-rotated-token", rateLimitTier: "default_claude_max_20x" });

    setArgv("rotate", "@rot");
    setReadlineAnswers("1"); // credential 再取得
    await cmdTokenRotate();

    const db = initTokenDB();
    try {
      const tok = getTokenByHandle(db, "@rot");
      expect(tok).not.toBeNull();
      expect(tok?.auth_hash).not.toBe(oldAuthHash);
      expect(tok?.auth_hash).toMatch(/^[a-f0-9]{12}$/); // R7
      expect(retrieveTokenFromKeychain("@rot")).toBe("new-rotated-token");
    } finally {
      db.close();
    }
  });

  // skip: main rotate に organization_id 不一致チェック未実装 (R2)。
  // abort 版は probe 結果と DB 上の organization_id を比較して不一致なら exit 1 するが、
  // main の cmdTokenRotate は credential を再取得して auth_hash を上書きするだけ。
  // 機能追加には main の token-cli.ts 変更が必要 → Option C 制約抵触。
  test.skip("organization_id 不一致は exit 1: main rotate に org_id check 未実装 (R2)", () => {});

  // skip: Keychain 失敗 → 旧 auth_hash 復元の補償 tx は main の cmdTokenRotate に未実装 (R3)。
  // フォローアップタスク「T319 補償 tx 追加」で対応予定。
  test.skip("Keychain 失敗 → 旧 auth_hash 復元: main に補償 tx 未実装 (R3)", () => {});
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdTokenSetPlan
// ─────────────────────────────────────────────────────────────────────────────

describe("cmdTokenSetPlan (integration)", () => {
  test("unknown plan を max-x20 に更新", async () => {
    {
      const db = initTokenDB();
      try {
        insertToken(
          db,
          makeToken({
            handle: "@sp",
            organization_id: "org-sp",
            plan: "unknown",
            plan_ratio: null,
          }),
        );
      } finally {
        db.close();
      }
    }

    setArgv("set-plan", "@sp", "max-x20");
    await cmdTokenSetPlan();

    const db = initTokenDB();
    try {
      const tok = getTokenByHandle(db, "@sp");
      expect(tok?.plan).toBe("max-x20");
      expect(tok?.plan_ratio).toBe(20.0);
    } finally {
      db.close();
    }
  });

  test("不正な plan 名は exit 1", async () => {
    {
      const db = initTokenDB();
      try {
        insertToken(db, makeToken({ handle: "@sp", organization_id: "org-sp" }));
      } finally {
        db.close();
      }
    }

    setArgv("set-plan", "@sp", "invalid-plan");
    let caught: TestExitError | null = null;
    try {
      await cmdTokenSetPlan();
    } catch (e) {
      caught = e as TestExitError;
    }
    expect(caught).toBeInstanceOf(TestExitError);
    expect(caught?.code).toBe(1);
    expect(consoleErrors.join("\n")).toContain("invalid-plan");
  });

  test("不存在 handle は exit 1", async () => {
    setArgv("set-plan", "@missing", "max-x20");
    let caught: TestExitError | null = null;
    try {
      await cmdTokenSetPlan();
    } catch (e) {
      caught = e as TestExitError;
    }
    expect(caught).toBeInstanceOf(TestExitError);
    expect(caught?.code).toBe(1);
    expect(consoleErrors.join("\n")).toContain("@missing");
  });
});
