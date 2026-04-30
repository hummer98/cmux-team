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
  cmdTokenPromote,
  cmdTokenMigrateSubscription,
} from "./token-cli";
import {
  initTokenDB,
  insertToken,
  getTokenByHandle,
  getLatestUsageSnapshot,
  retrieveTokenFromKeychain,
  storeTokenInKeychain,
  upsertUsageSnapshot,
  KeychainNotFoundError,
  __resetInMemoryKeychainForTest,
  __setClaudeCodeKeychainForTest,
  __resetClaudeCodeKeychainForTest,
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
    USER: process.env.USER,
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
  process.env.USER = "testuser";
  homedirOverride = testDir;
  __resetInMemoryKeychainForTest();
  __resetClaudeCodeKeychainForTest();
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
  // T391: 旧 "credentials 経路成功" テスト（source=1 = cred 自動読み込み）は
  // claude-credentials credential_source の廃止により無効化。代わりに
  // `--subscription` flag のテスト群を後段の `describe("cmdTokenAdd --subscription")` に追加した。

  test("organization_id を probe できないと exit 1", async () => {
    setArgv("add");
    setReadlineAnswers(
      "1", // T391: 新仕様では [1] = manual (token 貼り付け)
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
      "1", // T391: source = manual (旧 [2])
      "new-token",
      "", // plan prompt = unknown (T349)
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
      "1", // T391: source = manual (旧 [2])
      "new-token",
      "", // plan prompt = unknown (T349)
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
      "1", // T391: source = manual (旧 [2] が [1] に統一された)
      "manual-test-token-XYZ", // token
      "", // plan prompt = unknown (T349)
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

  // T349: rateLimitTier 由来で plan が解決できない場合の対話 prompt
  test("T1: source=1 (manual) で plan prompt に max-x20 を入力すると plan/plan_ratio が確定する (T349)", async () => {
    setArgv("add");
    setReadlineAnswers(
      "1", // T391: source = manual
      "tok-T1", // token
      "max-x20", // plan prompt
      "personal", // display name → @pers
      "any", // tags
    );
    await withMockedFetch("org-T1", async () => {
      await cmdTokenAdd();
    });

    const db = initTokenDB();
    try {
      const tok = getTokenByHandle(db, "@pers");
      expect(tok).not.toBeNull();
      expect(tok?.plan).toBe("max-x20");
      expect(tok?.plan_ratio).toBe(20.0);
    } finally {
      db.close();
    }
  });

  test("T2: source=1 (manual) で plan prompt に空 Enter で plan=unknown / plan_ratio=null、organizationId 行と prompt 行の間に空行 (T349)", async () => {
    setArgv("add");
    setReadlineAnswers(
      "1", // T391: source = manual
      "tok-T2",
      "", // plan prompt → unknown
      "personal",
      "any",
    );
    await withMockedFetch("org-T2", async () => {
      await cmdTokenAdd();
    });

    const db = initTokenDB();
    try {
      const tok = getTokenByHandle(db, "@pers");
      expect(tok).not.toBeNull();
      expect(tok?.plan).toBe("unknown");
      expect(tok?.plan_ratio).toBeNull();
    } finally {
      db.close();
    }

    // Found credential: ブロックと plan prompt の間に空行が入っていること
    const orgIdLineIdx = consoleLogs.findIndex((s) => s.includes("organizationId:"));
    expect(orgIdLineIdx).toBeGreaterThan(-1);
    expect(consoleLogs[orgIdLineIdx + 1]).toBe("");
    // 未知 / 未取得の rateLimitTier では rateLimitTier 行は出ない
    expect(consoleLogs.join("\n")).not.toContain("rateLimitTier:");
  });

  test("T3: source=1 (manual) で plan prompt に wrong-plan を入力するとエラー後に再入力で max-x5 が確定する (T349)", async () => {
    setArgv("add");
    setReadlineAnswers(
      "1", // T391: source = manual
      "tok-T3",
      "wrong-plan", // 不正値 → 再入力
      "max-x5",
      "personal",
      "any",
    );
    await withMockedFetch("org-T3", async () => {
      await cmdTokenAdd();
    });

    const db = initTokenDB();
    try {
      const tok = getTokenByHandle(db, "@pers");
      expect(tok).not.toBeNull();
      expect(tok?.plan).toBe("max-x5");
      expect(tok?.plan_ratio).toBe(5.0);
    } finally {
      db.close();
    }

    // エラーメッセージは plan の選択肢を含む（部分一致）
    expect(consoleErrors.join("\n")).toContain("pro / max-x5 / max-x20");
  });

  // T391: T4 / T6（旧 source=1 = cred 自動読み込みの rateLimitTier 由来 plan 解決）は
  // claude-credentials credential_source の廃止により無効化。promote の `[1]` 経路は
  // 残っているため rateLimitTier 由来の plan 解決は cmdTokenPromote で引き続きカバーされる。

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
// cmdTokenAdd --subscription / --from-claude-credentials (T391)
// ─────────────────────────────────────────────────────────────────────────────

describe("cmdTokenAdd --subscription (T391)", () => {
  test("--subscription <handle> --plan max-x20 --tags any で keychain に書かれず subscription source で登録される", async () => {
    setArgv("add", "--subscription", "@tayo", "--plan", "max-x20", "--tags", "any,oss");

    await cmdTokenAdd();

    const db = initTokenDB();
    try {
      const tok = getTokenByHandle(db, "@tayo");
      expect(tok).not.toBeNull();
      expect(tok?.handle).toBe("@tayo");
      expect(tok?.plan).toBe("max-x20");
      expect(tok?.plan_ratio).toBe(20.0);
      expect(tok?.tags).toEqual(["any", "oss"]);
      expect(tok?.credential_source).toBe("subscription");
      expect(tok?.auth_hash).toBeNull();
      expect(tok?.organization_id).toBeNull();
      expect(tok?.selectable).toBe(true);
    } finally {
      db.close();
    }

    // keychain に entry が無いこと（in-memory keychain から throw）
    let caught: KeychainNotFoundError | null = null;
    try {
      retrieveTokenFromKeychain("@tayo");
    } catch (e: any) {
      if (e instanceof KeychainNotFoundError) caught = e;
    }
    expect(caught).toBeInstanceOf(KeychainNotFoundError);
  });

  test("--subscription @ なし handle の場合 @ を自動で補正する", async () => {
    setArgv("add", "--subscription", "tayo");
    await cmdTokenAdd();

    const db = initTokenDB();
    try {
      const tok = getTokenByHandle(db, "@tayo");
      expect(tok).not.toBeNull();
      expect(tok?.credential_source).toBe("subscription");
    } finally {
      db.close();
    }
  });

  test("--subscription --plan / --tags 省略時は plan=unknown / tags=[any]", async () => {
    setArgv("add", "--subscription", "@def");
    await cmdTokenAdd();

    const db = initTokenDB();
    try {
      const tok = getTokenByHandle(db, "@def");
      expect(tok?.plan).toBe("unknown");
      expect(tok?.plan_ratio).toBeNull();
      expect(tok?.tags).toEqual(["any"]);
    } finally {
      db.close();
    }
  });

  test("--subscription --organization-id を指定すると DB に反映される", async () => {
    setArgv(
      "add",
      "--subscription",
      "@orgz",
      "--plan",
      "max-x5",
      "--organization-id",
      "org-explicit-1",
    );
    await cmdTokenAdd();

    const db = initTokenDB();
    try {
      const tok = getTokenByHandle(db, "@orgz");
      expect(tok?.organization_id).toBe("org-explicit-1");
      expect(tok?.plan).toBe("max-x5");
    } finally {
      db.close();
    }
  });

  test("--subscription handle 重複で exit 1", async () => {
    {
      const db = initTokenDB();
      try {
        insertToken(db, makeToken({ handle: "@dup", organization_id: "org-dup-existing" }));
      } finally {
        db.close();
      }
    }
    setArgv("add", "--subscription", "@dup");

    let caught: TestExitError | null = null;
    try {
      await cmdTokenAdd();
    } catch (e) {
      caught = e as TestExitError;
    }
    expect(caught).toBeInstanceOf(TestExitError);
    expect(caught?.code).toBe(1);
    expect(consoleErrors.join("\n")).toContain("@dup");
  });

  test("--subscription --plan に不正値を渡すと exit 1", async () => {
    setArgv("add", "--subscription", "@bad", "--plan", "max-x999");
    let caught: TestExitError | null = null;
    try {
      await cmdTokenAdd();
    } catch (e) {
      caught = e as TestExitError;
    }
    expect(caught).toBeInstanceOf(TestExitError);
    expect(caught?.code).toBe(1);
    expect(consoleErrors.join("\n")).toContain("max-x999");
  });

  test("--from-claude-credentials は v4.20.0 で削除されたエラーで exit 1", async () => {
    setArgv("add", "--from-claude-credentials", "@x");
    let caught: TestExitError | null = null;
    try {
      await cmdTokenAdd();
    } catch (e) {
      caught = e as TestExitError;
    }
    expect(caught).toBeInstanceOf(TestExitError);
    expect(caught?.code).toBe(1);
    const errs = consoleErrors.join("\n");
    expect(errs).toContain("--from-claude-credentials");
    expect(errs).toContain("v4.20.0");
    expect(errs).toContain("--subscription");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdTokenMigrateSubscription (T391)
// ─────────────────────────────────────────────────────────────────────────────

describe("cmdTokenMigrateSubscription (T391)", () => {
  test("0 件のときは案内のみで成功", async () => {
    setArgv("migrate-subscription");
    await cmdTokenMigrateSubscription();
    expect(consoleLogs.join("\n")).toContain("subscription source の token はありません");
  });

  test("subscription row の keychain entry を冪等に削除する", async () => {
    // arrange: subscription row を 2 件追加し、keychain に偽の entry を仕込む
    {
      const db = initTokenDB();
      try {
        insertToken(db, {
          handle: "@tayo",
          organization_id: null,
          auth_hash: null,
          plan: "max-x20",
          plan_ratio: 20.0,
          tags: ["any"],
          credential_source: "subscription",
          selectable: true,
        });
        insertToken(db, {
          handle: "@dear",
          organization_id: "org-dear",
          auth_hash: null,
          plan: "max-x20",
          plan_ratio: 20.0,
          tags: ["dear"],
          credential_source: "subscription",
          selectable: true,
        });
        // manual row は対象外であることを確認するためのコントロール
        insertToken(
          db,
          makeToken({
            handle: "@kept",
            organization_id: "org-kept",
            credential_source: "manual",
          }),
        );
      } finally {
        db.close();
      }
    }
    storeTokenInKeychain("@tayo", "stale-token-AAA");
    storeTokenInKeychain("@dear", "stale-token-BBB");
    storeTokenInKeychain("@kept", "manual-token-CCC");

    setArgv("migrate-subscription");
    await cmdTokenMigrateSubscription();

    // subscription row の keychain entry は削除済み
    expect(() => retrieveTokenFromKeychain("@tayo")).toThrow(KeychainNotFoundError);
    expect(() => retrieveTokenFromKeychain("@dear")).toThrow(KeychainNotFoundError);
    // manual row の keychain entry は維持
    expect(retrieveTokenFromKeychain("@kept")).toBe("manual-token-CCC");

    // 冪等性: 2 回目の実行も成功する
    await cmdTokenMigrateSubscription();
    expect(consoleErrors.join("\n")).not.toContain("Error:");
  });
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

  test("T390: reset 通過済み stale token は UTIL_5H 列が effUtil=0%、行末に * マーカー、フッタに凡例", async () => {
    {
      const db = initTokenDB();
      try {
        const t = insertToken(
          db,
          makeToken({
            handle: "@tayo",
            organization_id: "org-tayo-T390",
            plan: "max-x20",
            plan_ratio: 20.0,
            tags: ["any"],
          }),
        );
        upsertUsageSnapshot(db, {
          token_id: t.id,
          util_5h: 0.02,
          util_7d: 0.91,
          reset_5h_at: new Date(Date.now() - 60 * 1000).toISOString(),
          reset_7d_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          unified_status: null,
        });
        // T390: stale を作るため recorded_at を 35 分前に巻き戻す
        const STALE_RECORDED = new Date(Date.now() - 35 * 60 * 1000).toISOString();
        db.prepare("UPDATE usage_snapshots SET recorded_at = ? WHERE token_id = ?")
          .run(STALE_RECORDED, t.id);
      } finally {
        db.close();
      }
    }

    setArgv("list");
    await cmdTokenList();
    const out = consoleLogs.join("\n");
    expect(out).toContain("@tayo");
    const lines = out.split("\n");
    const tayoLine = lines.find((l) => l.startsWith("@tayo"));
    // UTIL_5H 列は effUtil=0% を表示（snap 0.02 ではなく救済された 0%）
    expect(tayoLine).toContain("0%");
    expect(tayoLine).toContain("91%");
    // 行末（NEXT_RESET の右）に独立した * マーカー
    expect(tayoLine?.trim().endsWith("*")).toBe(true);
    // フッタ凡例
    expect(out).toContain("(* = reset 通過済みで実質クリア)");
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
        // T391: makeToken は manual default で auth_hash を必ず string で渡すため non-null
        oldAuthHash = t.auth_hash!;
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

// ─────────────────────────────────────────────────────────────────────────────
// cmdTokenPromote (T341)
// ─────────────────────────────────────────────────────────────────────────────

describe("cmdTokenPromote (integration)", () => {
  function seedAutoDiscover(opts: {
    handle?: string;
    organization_id?: string;
    auth_hash?: string;
  } = {}): { id: number; organization_id: string } {
    const db = initTokenDB();
    try {
      const tok = insertToken(db, {
        handle: opts.handle ?? "@cd8d",
        organization_id: opts.organization_id ?? "cd8db5e8-aaaa-bbbb-cccc-000000000000",
        auth_hash: opts.auth_hash ?? "auto00000000",
        plan: "unknown",
        plan_ratio: null,
        tags: ["auto"],
        credential_source: "auto-discover",
        selectable: false,
      });
      // T391: seedAutoDiscover では organization_id を必ず string で渡しているため non-null
      return { id: tok.id, organization_id: tok.organization_id! };
    } finally {
      db.close();
    }
  }

  test("R-promote-1: 正常系 credential 経路で promote 成功 (T391: credential_source=manual)", async () => {
    const { id, organization_id } = seedAutoDiscover();
    writeClaudeCredentials({
      accessToken: "new-cred-token-XYZ",
      rateLimitTier: "default_claude_max_20x",
    });
    setArgv("promote", "@cd8d", "kddi");
    setReadlineAnswers(
      "1", // source = credential（promote では cred 経路は残る、ただし保存は manual として）
      "any", // tags
    );
    await withMockedFetch(organization_id, async () => {
      await cmdTokenPromote();
    });

    const db = initTokenDB();
    try {
      expect(getTokenByHandle(db, "@cd8d")).toBeNull();
      const tok = getTokenByHandle(db, "@kddi");
      expect(tok).not.toBeNull();
      expect(tok?.id).toBe(id);
      expect(tok?.plan).toBe("max-x20");
      expect(tok?.plan_ratio).toBe(20.0);
      expect(tok?.selectable).toBe(true);
      // T391: claude-credentials を廃止。promote の保存先は manual に統一
      expect(tok?.credential_source).toBe("manual");
      expect(tok?.tags).toEqual(["any"]);
      expect(retrieveTokenFromKeychain("@kddi")).toBe("new-cred-token-XYZ");
    } finally {
      db.close();
    }
  });

  test("R-promote-2: 正常系 manual 経路で promote 成功 (tags 入力あり)", async () => {
    const { organization_id } = seedAutoDiscover();
    setArgv("promote", "@cd8d", "kddi-dev");
    setReadlineAnswers(
      "2",                  // source = manual
      "manual-token-AAA",   // token
      "",                   // plan prompt = unknown (T349)
      "any,kddi",           // tags
    );
    await withMockedFetch(organization_id, async () => {
      await cmdTokenPromote();
    });

    const db = initTokenDB();
    try {
      const tok = getTokenByHandle(db, "@kddi");
      expect(tok).not.toBeNull();
      expect(tok?.credential_source).toBe("manual");
      expect(tok?.plan).toBe("unknown");
      expect(tok?.plan_ratio).toBeNull();
      expect(tok?.tags).toEqual(["any", "kddi"]);
      expect(tok?.selectable).toBe(true);
      expect(retrieveTokenFromKeychain("@kddi")).toBe("manual-token-AAA");
    } finally {
      db.close();
    }
  });

  test("R-promote-3: organization_id 不一致 → exit 1, DB 変更なし", async () => {
    const { id, organization_id } = seedAutoDiscover();
    setArgv("promote", "@cd8d", "kddi");
    setReadlineAnswers("2", "different-account-token", "any");

    let caught: TestExitError | null = null;
    try {
      await withMockedFetch("DIFFERENT-ORG-ID", async () => {
        await cmdTokenPromote();
      });
    } catch (e) {
      caught = e as TestExitError;
    }
    expect(caught).toBeInstanceOf(TestExitError);
    expect(caught?.code).toBe(1);
    expect(consoleErrors.join("\n")).toMatch(/別アカウント|別の/);

    const db = initTokenDB();
    try {
      expect(getTokenByHandle(db, "@kddi")).toBeNull();
      const orig = getTokenByHandle(db, "@cd8d");
      expect(orig?.id).toBe(id);
      expect(orig?.organization_id).toBe(organization_id);
      expect(orig?.credential_source).toBe("auto-discover");
      expect(orig?.selectable).toBe(false);
    } finally {
      db.close();
    }
  });

  test("R-promote-4: 旧 handle が存在しない → exit 1", async () => {
    setArgv("promote", "@missing", "foo");
    setReadlineAnswers("1", "any");
    let caught: TestExitError | null = null;
    try {
      await cmdTokenPromote();
    } catch (e) {
      caught = e as TestExitError;
    }
    expect(caught).toBeInstanceOf(TestExitError);
    expect(caught?.code).toBe(1);
    expect(consoleErrors.join("\n")).toContain("@missing");
  });

  test("R-promote-5: 新 handle が既存と衝突 → exit 1", async () => {
    seedAutoDiscover({ handle: "@cd8d", organization_id: "org-cd8d" });
    {
      const db = initTokenDB();
      try {
        insertToken(
          db,
          makeToken({ handle: "@kddi", organization_id: "org-kddi-existing" }),
        );
      } finally {
        db.close();
      }
    }

    setArgv("promote", "@cd8d", "kddi");
    setReadlineAnswers("2", "tok", "any");
    let caught: TestExitError | null = null;
    try {
      await withMockedFetch("org-cd8d", async () => {
        await cmdTokenPromote();
      });
    } catch (e) {
      caught = e as TestExitError;
    }
    expect(caught).toBeInstanceOf(TestExitError);
    expect(caught?.code).toBe(1);
    expect(consoleErrors.join("\n")).toContain("@kddi");
  });

  test("R-promote-6: 旧 handle が auto-discover ではない → exit 1", async () => {
    {
      const db = initTokenDB();
      try {
        insertToken(
          db,
          makeToken({
            handle: "@pers",
            organization_id: "org-pers-manual",
            credential_source: "manual",
            selectable: true,
          }),
        );
      } finally {
        db.close();
      }
    }
    setArgv("promote", "@pers", "personal-renamed");
    setReadlineAnswers("1", "any");
    let caught: TestExitError | null = null;
    try {
      await cmdTokenPromote();
    } catch (e) {
      caught = e as TestExitError;
    }
    expect(caught).toBeInstanceOf(TestExitError);
    expect(caught?.code).toBe(1);
    expect(consoleErrors.join("\n")).toContain("auto-discover");
  });

  test("R-promote-7: probe 失敗 → exit 1, DB / Keychain 変更なし", async () => {
    seedAutoDiscover();
    setArgv("promote", "@cd8d", "kddi");
    setReadlineAnswers("2", "tok-no-probe", "any");
    let caught: TestExitError | null = null;
    try {
      await withMockedFetch(null, async () => {
        await cmdTokenPromote();
      });
    } catch (e) {
      caught = e as TestExitError;
    }
    expect(caught).toBeInstanceOf(TestExitError);
    expect(caught?.code).toBe(1);

    const db = initTokenDB();
    try {
      expect(getTokenByHandle(db, "@kddi")).toBeNull();
      const orig = getTokenByHandle(db, "@cd8d");
      expect(orig).not.toBeNull();
      expect(orig?.credential_source).toBe("auto-discover");
      expect(orig?.selectable).toBe(false);
    } finally {
      db.close();
    }
  });

  test("R-promote-8: usage_snapshots は token_id 維持で壊れない", async () => {
    const { id, organization_id } = seedAutoDiscover();
    {
      const db = initTokenDB();
      try {
        upsertUsageSnapshot(db, {
          token_id: id,
          util_5h: 0.55,
          util_7d: 0.33,
          reset_5h_at: null,
          reset_7d_at: null,
          unified_status: null,
        });
      } finally {
        db.close();
      }
    }
    setArgv("promote", "@cd8d", "kddi");
    setReadlineAnswers("2", "manual-tok", "", "any"); // plan prompt = unknown (T349)
    await withMockedFetch(organization_id, async () => {
      await cmdTokenPromote();
    });

    const db = initTokenDB();
    try {
      const snap = getLatestUsageSnapshot(db, id);
      expect(snap).not.toBeNull();
      expect(snap?.util_5h).toBeCloseTo(0.55, 5);
      expect(snap?.util_7d).toBeCloseTo(0.33, 5);
    } finally {
      db.close();
    }
  });

  test("R-promote-9: newHandle === oldHandle のときは info ログを出して続行する", async () => {
    seedAutoDiscover({ handle: "@cd8d", organization_id: "org-same-handle" });
    setArgv("promote", "@cd8d", "cd8d-extra"); // slug → "cd8d" → @cd8d
    setReadlineAnswers("2", "tok-same", "", "any"); // plan prompt = unknown (T349)
    await withMockedFetch("org-same-handle", async () => {
      await cmdTokenPromote();
    });

    // info ログが出ていること
    const out = consoleLogs.join("\n");
    expect(out).toContain("@cd8d");
    expect(out).toMatch(/handle は変わりません|handle.*unchanged/);

    const db = initTokenDB();
    try {
      const tok = getTokenByHandle(db, "@cd8d");
      expect(tok).not.toBeNull();
      expect(tok?.credential_source).toBe("manual");
      expect(tok?.selectable).toBe(true);
    } finally {
      db.close();
    }
  });

  test("R-promote-10: plan='unknown' のとき set-plan ヒントを表示する (M2)", async () => {
    const { organization_id } = seedAutoDiscover();
    setArgv("promote", "@cd8d", "kddi");
    setReadlineAnswers("2", "manual-tok", "", "any"); // plan prompt = unknown (T349)
    await withMockedFetch(organization_id, async () => {
      await cmdTokenPromote();
    });

    const out = consoleLogs.join("\n");
    expect(out).toContain("set-plan");
    expect(out).toContain("@kddi");
  });

  test("T5a: promote の source=2 で plan prompt に max-x20 を入力すると plan 確定でヒントが出ない (T349)", async () => {
    const { organization_id } = seedAutoDiscover();
    setArgv("promote", "@cd8d", "kddi");
    setReadlineAnswers(
      "2",          // source = manual
      "tok-T5a",    // token
      "max-x20",    // plan prompt
      "any",        // tags
    );
    await withMockedFetch(organization_id, async () => {
      await cmdTokenPromote();
    });

    const db = initTokenDB();
    try {
      const tok = getTokenByHandle(db, "@kddi");
      expect(tok).not.toBeNull();
      expect(tok?.plan).toBe("max-x20");
      expect(tok?.plan_ratio).toBe(20.0);
    } finally {
      db.close();
    }

    const out = consoleLogs.join("\n");
    expect(out).not.toContain("set-plan");
    expect(out).not.toContain("Hint:");
  });

  test("R-promote-11: new display name が引数不足 → exit 1", async () => {
    seedAutoDiscover();
    setArgv("promote", "@cd8d");
    let caught: TestExitError | null = null;
    try {
      await cmdTokenPromote();
    } catch (e) {
      caught = e as TestExitError;
    }
    expect(caught).toBeInstanceOf(TestExitError);
    expect(caught?.code).toBe(1);
    expect(consoleErrors.join("\n")).toContain("Usage");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// readClaudeCredentials priority (T345)
//
// macOS Keychain (`Claude Code-credentials` / account=$USER) を優先して
// `~/.claude/.credentials.json` にフォールバックする優先順位ロジックを検証する。
// in-memory モード (`KEYCHAIN_TEST_MODE=1`) で `__setClaudeCodeKeychainForTest`
// により Keychain 値を仕込み、`spawnSync` 自体は mock しない。
// ─────────────────────────────────────────────────────────────────────────────

describe("readClaudeCredentials priority (T345)", () => {
  function makeKeychainJson(opts: {
    accessToken: string;
    rateLimitTier?: string;
  }): string {
    return JSON.stringify({
      claudeAiOauth: {
        accessToken: opts.accessToken,
        rateLimitTier: opts.rateLimitTier,
      },
    });
  }

  // T391: T1〜T5 は cmdTokenAdd の `[1] Claude Code credential` 自動読み込み経路を前提としていたが、
  // claude-credentials credential_source の廃止により cmdTokenAdd は manual のみに簡略化されたため
  // 以下の T1〜T5 は skip。`readClaudeCredentials` の優先順位ロジック自体は cmdTokenPromote の T7 以降で
  // 引き続き検証される（promote では cred 読み込みは残るが credential_source=manual で保存される）。
  test.skip("T1: macOS Keychain 成功 → Keychain 値が使われる (file 値は無視) [T391: cmdTokenAdd cred 経路廃止により skip]", async () => {
    __setClaudeCodeKeychainForTest(
      "testuser",
      makeKeychainJson({
        accessToken: "kc-AAA",
        rateLimitTier: "default_claude_max_5x",
      }),
    );
    writeClaudeCredentials({
      accessToken: "file-BBB",
      rateLimitTier: "default_claude_max_20x",
    });

    setArgv("add");
    setReadlineAnswers(
      "1", // source = credential
      "kchain", // display name → @kcha
      "any",
    );
    await withMockedFetch("org-kc-1", async () => {
      await cmdTokenAdd();
    });

    const db = initTokenDB();
    try {
      const tok = getTokenByHandle(db, "@kcha");
      expect(tok).not.toBeNull();
      expect(tok?.organization_id).toBe("org-kc-1");
      expect(tok?.plan).toBe("max-x5");
      expect(tok?.plan_ratio).toBe(5.0);
      expect(retrieveTokenFromKeychain("@kcha")).toBe("kc-AAA");
    } finally {
      db.close();
    }
  });

  test.skip("T2: Keychain 未登録 → ~/.claude/.credentials.json fallback [T391: skip]", async () => {
    // Keychain は空のまま
    writeClaudeCredentials({
      accessToken: "file-BBB",
      rateLimitTier: "default_claude_pro",
    });

    setArgv("add");
    setReadlineAnswers(
      "1",
      "filerel", // display name → @file
      "any",
    );
    await withMockedFetch("org-file-1", async () => {
      await cmdTokenAdd();
    });

    const db = initTokenDB();
    try {
      const tok = getTokenByHandle(db, "@file");
      expect(tok).not.toBeNull();
      expect(tok?.plan).toBe("pro");
      expect(retrieveTokenFromKeychain("@file")).toBe("file-BBB");
    } finally {
      db.close();
    }
  });

  test.skip("T3: 両方失敗 → exit 1 (新エラー文言) [T391: skip]", async () => {
    // Keychain 空、ファイルも書き出さない
    setArgv("add");
    setReadlineAnswers("1", "noavail", "any");
    let caught: TestExitError | null = null;
    try {
      await withMockedFetch("org-noop", async () => {
        await cmdTokenAdd();
      });
    } catch (e) {
      caught = e as TestExitError;
    }
    expect(caught).toBeInstanceOf(TestExitError);
    expect(caught?.code).toBe(1);
    const errs = consoleErrors.join("\n");
    expect(errs).toContain("Claude Code credential が見つかりません");
    expect(errs).toContain("macOS Keychain");
    expect(errs).toContain(".credentials.json");
  });

  test.skip("T4: Keychain JSON 破損 → file fallback [T391: skip]", async () => {
    __setClaudeCodeKeychainForTest("testuser", "this is not json");
    writeClaudeCredentials({
      accessToken: "file-CCC",
      rateLimitTier: "default_claude_max_20x",
    });

    setArgv("add");
    setReadlineAnswers("1", "broken", "any");
    await withMockedFetch("org-broken-1", async () => {
      await cmdTokenAdd();
    });

    const db = initTokenDB();
    try {
      const tok = getTokenByHandle(db, "@brok");
      expect(tok).not.toBeNull();
      expect(retrieveTokenFromKeychain("@brok")).toBe("file-CCC");
      expect(tok?.plan).toBe("max-x20");
    } finally {
      db.close();
    }
  });

  test.skip("T5: Keychain JSON は valid だが claudeAiOauth.accessToken 欠損 → file fallback [T391: skip]", async () => {
    __setClaudeCodeKeychainForTest(
      "testuser",
      JSON.stringify({ claudeAiOauth: {} }),
    );
    writeClaudeCredentials({
      accessToken: "file-DDD",
      rateLimitTier: "default_claude_max_5x",
    });

    setArgv("add");
    setReadlineAnswers("1", "missing", "any");
    await withMockedFetch("org-missing-1", async () => {
      await cmdTokenAdd();
    });

    const db = initTokenDB();
    try {
      const tok = getTokenByHandle(db, "@miss");
      expect(tok).not.toBeNull();
      expect(retrieveTokenFromKeychain("@miss")).toBe("file-DDD");
      expect(tok?.plan).toBe("max-x5");
    } finally {
      db.close();
    }
  });

  test("T7: promote 経路でも同じ優先順位 (Keychain 優先)", async () => {
    // 既存 auto-discover token を準備
    const existingOrgId = "promote-org-A";
    {
      const db = initTokenDB();
      try {
        insertToken(db, {
          handle: "@auto",
          organization_id: existingOrgId,
          auth_hash: "auto00000000",
          plan: "unknown",
          plan_ratio: null,
          tags: ["auto"],
          credential_source: "auto-discover",
          selectable: false,
        });
      } finally {
        db.close();
      }
    }

    __setClaudeCodeKeychainForTest(
      "testuser",
      makeKeychainJson({
        accessToken: "kc-promote-token",
        rateLimitTier: "default_claude_max_20x",
      }),
    );
    writeClaudeCredentials({
      accessToken: "file-promote-token",
      rateLimitTier: "default_claude_pro",
    });

    setArgv("promote", "@auto", "kddi");
    setReadlineAnswers(
      "1", // source = credential
      "any", // tags
    );
    await withMockedFetch(existingOrgId, async () => {
      await cmdTokenPromote();
    });

    const db = initTokenDB();
    try {
      const tok = getTokenByHandle(db, "@kddi");
      expect(tok).not.toBeNull();
      expect(tok?.plan).toBe("max-x20");
      expect(retrieveTokenFromKeychain("@kddi")).toBe("kc-promote-token");
    } finally {
      db.close();
    }
  });

  test("T8: rotate 経路でも同じ優先順位 (Keychain 優先で auth_hash 更新)", async () => {
    let oldAuthHash: string;
    {
      const db = initTokenDB();
      try {
        const t = insertToken(
          db,
          makeToken({ handle: "@rotk", organization_id: "rot-org" }),
        );
        // T391: makeToken は manual default で auth_hash を必ず string で渡すため non-null
        oldAuthHash = t.auth_hash!;
      } finally {
        db.close();
      }
      storeTokenInKeychain("@rotk", "old-token");
    }

    __setClaudeCodeKeychainForTest(
      "testuser",
      makeKeychainJson({
        accessToken: "kc-rotate-token",
        rateLimitTier: "default_claude_max_20x",
      }),
    );
    writeClaudeCredentials({
      accessToken: "file-rotate-token",
      rateLimitTier: "default_claude_max_5x",
    });

    setArgv("rotate", "@rotk");
    setReadlineAnswers("1");
    await cmdTokenRotate();

    const db = initTokenDB();
    try {
      const tok = getTokenByHandle(db, "@rotk");
      expect(tok).not.toBeNull();
      expect(tok?.auth_hash).not.toBe(oldAuthHash);
      // Keychain 由来 token の auth_hash であることを別計算で検証
      const { createHash } = await import("crypto");
      const expected = createHash("sha256")
        .update("Bearer kc-rotate-token")
        .digest("hex")
        .slice(0, 12);
      expect(tok?.auth_hash).toBe(expected);
      expect(retrieveTokenFromKeychain("@rotk")).toBe("kc-rotate-token");
    } finally {
      db.close();
    }
  });
});
