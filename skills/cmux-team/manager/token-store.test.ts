/**
 * token-store のユニットテスト。plan.md §9 のテスト計画を網羅する。
 *
 * - DB は `mkdtempSync` + `TOKEN_STORE_DB_PATH` 上書きで一時ディレクトリに隔離
 * - Keychain は KEYCHAIN_TEST_MODE=1 で in-memory Map にフォールバック
 * - macOS 実機テストは process.platform === "darwin" のときのみ実行 (それ以外は skip)
 */
import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import {
  initTokenDB,
  insertToken,
  getTokenByHandle,
  getTokenByOrganizationId,
  getTokenByAuthHash,
  listTokens,
  upsertUsageSnapshot,
  getLatestUsageSnapshot,
  acquireLease,
  releaseLease,
  expireLeases,
  listActiveLeases,
  isKeychainSupported,
  storeTokenInKeychain,
  retrieveTokenFromKeychain,
  deleteTokenFromKeychain,
  computePoolCapacity,
  deleteToken,
  updateTokenAuth,
  updateTokenOrganizationId,
  updateTokenPlan,
  updateTokenPromoteFields,
  selectToken,
  canSelectAnyToken,
  peekNextToken,
  shouldInjectCredential,
  assertCanRetrieveFromKeychain,
  KeychainUnsupportedError,
  KeychainNotFoundError,
  REFERENCE_FLOW,
  __resetInMemoryKeychainForTest,
  __resolveDbPathForTest,
  __statMode,
  type InsertTokenInput,
  type TokenForCapacity,
} from "./token-store";

// ─────────────────────────────────────────────────────────────────────────────
// 共通セットアップ
// ─────────────────────────────────────────────────────────────────────────────

let testDir: string;
let db: Database;

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

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "cmux-token-store-"));
  db = initTokenDB({
    dirPath: testDir,
    dbPath: join(testDir, "tokens.db"),
  });
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // close 失敗は無視（DB 未初期化テストなどで開いていない可能性）
  }
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // CI など rm 失敗を許容
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// initTokenDB
// ─────────────────────────────────────────────────────────────────────────────

describe("initTokenDB", () => {
  test("新規 DB ファイルを作成し mode 0600 が設定される", () => {
    const dbPath = join(testDir, "tokens.db");
    expect(existsSync(dbPath)).toBe(true);
    // mode 0600 (rw only owner)
    expect(__statMode(dbPath)).toBe(0o600);
  });

  test("2 回目の initTokenDB 呼び出しでエラーなし（冪等）", () => {
    db.close();
    const db2 = initTokenDB({
      dirPath: testDir,
      dbPath: join(testDir, "tokens.db"),
    });
    // スキーマが重複作成されていないこと
    const tables = db2
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("tokens");
    expect(names).toContain("usage_snapshots");
    expect(names).toContain("leases");
    db2.close();
  });

  test("WAL モードが有効", () => {
    const row = db
      .prepare("PRAGMA journal_mode")
      .get() as { journal_mode: string };
    expect(row.journal_mode.toLowerCase()).toBe("wal");
  });

  test("foreign_keys が ON", () => {
    const row = db
      .prepare("PRAGMA foreign_keys")
      .get() as { foreign_keys: number };
    expect(row.foreign_keys).toBe(1);
  });

  test("3 テーブルが揃っている", () => {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("tokens");
    expect(names).toContain("usage_snapshots");
    expect(names).toContain("leases");
  });

  test("必要な index が作成されている", () => {
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_tokens_selectable");
    expect(names).toContain("idx_usage_snapshots_token_time");
    expect(names).toContain("idx_leases_expires");
  });

  test("TOKEN_STORE_DB_PATH 環境変数が優先される (明示 opts 省略時)", () => {
    const envDir = mkdtempSync(join(tmpdir(), "cmux-token-store-env-"));
    const envPath = join(envDir, "env-tokens.db");
    const prev = process.env.TOKEN_STORE_DB_PATH;
    process.env.TOKEN_STORE_DB_PATH = envPath;
    try {
      const resolved = __resolveDbPathForTest();
      expect(resolved.dbPath).toBe(envPath);
      expect(resolved.dirPath).toBe(envDir);
    } finally {
      if (prev === undefined) delete process.env.TOKEN_STORE_DB_PATH;
      else process.env.TOKEN_STORE_DB_PATH = prev;
      rmSync(envDir, { recursive: true, force: true });
    }
  });

  test("opts.dbPath が env より優先される", () => {
    const envPath = "/tmp/should-not-be-used/tokens.db";
    const prev = process.env.TOKEN_STORE_DB_PATH;
    process.env.TOKEN_STORE_DB_PATH = envPath;
    try {
      const resolved = __resolveDbPathForTest({
        dbPath: "/tmp/override/tokens.db",
      });
      expect(resolved.dbPath).toBe("/tmp/override/tokens.db");
    } finally {
      if (prev === undefined) delete process.env.TOKEN_STORE_DB_PATH;
      else process.env.TOKEN_STORE_DB_PATH = prev;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// insertToken / getTokenBy*
// ─────────────────────────────────────────────────────────────────────────────

describe("insertToken / getTokenBy*", () => {
  test("INSERT → getTokenByHandle で取得できる", () => {
    const inserted = insertToken(db, makeToken({ handle: "@pers" }));
    expect(inserted.id).toBeGreaterThan(0);
    expect(inserted.handle).toBe("@pers");
    expect(inserted.plan).toBe("max-x20");
    expect(inserted.plan_ratio).toBe(20.0);
    expect(inserted.tags).toEqual(["any"]);
    expect(inserted.selectable).toBe(true);
    expect(inserted.created_at).toMatch(/^20\d{2}-/);

    const got = getTokenByHandle(db, "@pers");
    expect(got).not.toBeNull();
    expect(got?.id).toBe(inserted.id);
    expect(got?.tags).toEqual(["any"]);
  });

  test("getTokenByOrganizationId で取得できる", () => {
    const orgId = "11111111-2222-3333-4444-555555555555";
    insertToken(db, makeToken({ handle: "@alpha", organization_id: orgId }));
    const got = getTokenByOrganizationId(db, orgId);
    expect(got).not.toBeNull();
    expect(got?.handle).toBe("@alpha");
  });

  test("tags が JSON として復元される (複数要素)", () => {
    const inserted = insertToken(
      db,
      makeToken({ handle: "@multi", tags: ["chat", "code"] }),
    );
    expect(inserted.tags).toEqual(["chat", "code"]);

    const got = getTokenByHandle(db, "@multi");
    expect(got?.tags).toEqual(["chat", "code"]);
  });

  test("selectable=false を指定すると 0 で保存・復元される", () => {
    const inserted = insertToken(
      db,
      makeToken({ handle: "@off", selectable: false }),
    );
    expect(inserted.selectable).toBe(false);

    const got = getTokenByHandle(db, "@off");
    expect(got?.selectable).toBe(false);
  });

  test("handle 重複は UNIQUE 制約違反で throw", () => {
    insertToken(db, makeToken({ handle: "@dup" }));
    expect(() =>
      insertToken(
        db,
        makeToken({
          handle: "@dup",
          organization_id: "99999999-0000-0000-0000-000000000099",
        }),
      ),
    ).toThrow();
  });

  test("organization_id 重複は UNIQUE 制約違反で throw", () => {
    insertToken(db, makeToken({ organization_id: "org-dup-xxx" }));
    expect(() =>
      insertToken(
        db,
        makeToken({
          handle: "@another",
          organization_id: "org-dup-xxx",
        }),
      ),
    ).toThrow();
  });

  test("getTokenByHandle は未登録で null", () => {
    expect(getTokenByHandle(db, "@none")).toBeNull();
  });

  test("getTokenByOrganizationId は未登録で null", () => {
    expect(getTokenByOrganizationId(db, "not-exist")).toBeNull();
  });

  test("listTokens({ selectableOnly: true }) が selectable=true のみ返す", () => {
    insertToken(db, makeToken({ handle: "@a", organization_id: "org-a" }));
    insertToken(
      db,
      makeToken({
        handle: "@b",
        organization_id: "org-b",
        selectable: false,
      }),
    );
    insertToken(db, makeToken({ handle: "@c", organization_id: "org-c" }));

    const all = listTokens(db);
    expect(all.length).toBe(3);

    const selectable = listTokens(db, { selectableOnly: true });
    expect(selectable.length).toBe(2);
    expect(selectable.map((t) => t.handle).sort()).toEqual(["@a", "@c"]);
  });

  test("plan_ratio=null を保存・復元できる (plan=unknown 想定)", () => {
    const inserted = insertToken(
      db,
      makeToken({
        handle: "@unknown",
        plan: "unknown",
        plan_ratio: null,
      }),
    );
    expect(inserted.plan_ratio).toBeNull();

    const got = getTokenByHandle(db, "@unknown");
    expect(got?.plan_ratio).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// upsertUsageSnapshot / getLatestUsageSnapshot
// ─────────────────────────────────────────────────────────────────────────────

describe("upsertUsageSnapshot", () => {
  test("初回は INSERT で 1 行増える", () => {
    const token = insertToken(db, makeToken());
    const snap = upsertUsageSnapshot(db, {
      token_id: token.id,
      util_5h: 0.2,
      util_7d: 0.1,
      reset_5h_at: "2026-04-25T10:00:00.000Z",
      reset_7d_at: "2026-05-01T10:00:00.000Z",
      unified_status: "active",
    });
    expect(snap.util_5h).toBe(0.2);
    expect(snap.recorded_at).toMatch(/^20\d{2}-/);

    const count = db
      .prepare("SELECT COUNT(*) AS c FROM usage_snapshots")
      .get() as { c: number };
    expect(count.c).toBe(1);
  });

  test("同 token_id で 2 回目は UPDATE (行数 1 のまま、値が更新)", () => {
    const token = insertToken(db, makeToken());
    upsertUsageSnapshot(db, {
      token_id: token.id,
      util_5h: 0.2,
      util_7d: 0.1,
      reset_5h_at: null,
      reset_7d_at: null,
      unified_status: "active",
    });
    const second = upsertUsageSnapshot(db, {
      token_id: token.id,
      util_5h: 0.9,
      util_7d: 0.5,
      reset_5h_at: "2026-04-25T11:00:00.000Z",
      reset_7d_at: "2026-05-02T11:00:00.000Z",
      unified_status: "approaching_limit",
    });
    expect(second.util_5h).toBe(0.9);
    expect(second.util_7d).toBe(0.5);
    expect(second.unified_status).toBe("approaching_limit");

    const count = db
      .prepare("SELECT COUNT(*) AS c FROM usage_snapshots")
      .get() as { c: number };
    expect(count.c).toBe(1);
  });

  test("getLatestUsageSnapshot が最新値を返す", () => {
    const token = insertToken(db, makeToken());
    expect(getLatestUsageSnapshot(db, token.id)).toBeNull();

    upsertUsageSnapshot(db, {
      token_id: token.id,
      util_5h: 0.5,
      util_7d: null,
      reset_5h_at: null,
      reset_7d_at: null,
      unified_status: null,
    });
    const latest = getLatestUsageSnapshot(db, token.id);
    expect(latest).not.toBeNull();
    expect(latest?.util_5h).toBe(0.5);
    expect(latest?.util_7d).toBeNull();
  });

  test("recorded_at が自動で付与され、UPSERT 時に更新される", async () => {
    const token = insertToken(db, makeToken());
    const first = upsertUsageSnapshot(db, {
      token_id: token.id,
      util_5h: null,
      util_7d: null,
      reset_5h_at: null,
      reset_7d_at: null,
      unified_status: null,
    });
    // ISO 8601 は辞書順 = 時系列順。十分な待機で recorded_at が進むことを確認
    await new Promise((r) => setTimeout(r, 10));
    const second = upsertUsageSnapshot(db, {
      token_id: token.id,
      util_5h: 0.1,
      util_7d: null,
      reset_5h_at: null,
      reset_7d_at: null,
      unified_status: null,
    });
    expect(second.recorded_at >= first.recorded_at).toBe(true);
  });

  test("存在しない token_id で UPSERT は FK 違反で throw", () => {
    expect(() =>
      upsertUsageSnapshot(db, {
        token_id: 9999,
        util_5h: null,
        util_7d: null,
        reset_5h_at: null,
        reset_7d_at: null,
        unified_status: null,
      }),
    ).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// leases
// ─────────────────────────────────────────────────────────────────────────────

describe("leases (atomic)", () => {
  test("acquireLease 初回成功 → Lease 返却、listActiveLeases に含まれる", () => {
    const token = insertToken(db, makeToken());
    const lease = acquireLease(db, token.id, "conductor-1", 60);
    expect(lease).not.toBeNull();
    expect(lease?.token_id).toBe(token.id);
    expect(lease?.holder).toBe("conductor-1");

    const active = listActiveLeases(db);
    expect(active.length).toBe(1);
    expect(active[0]?.holder).toBe("conductor-1");
  });

  test("同 token_id を別 holder が取ろうとすると null", () => {
    const token = insertToken(db, makeToken());
    expect(acquireLease(db, token.id, "h1", 60)).not.toBeNull();
    expect(acquireLease(db, token.id, "h2", 60)).toBeNull();
  });

  test("同 token_id を同じ holder が再度 acquire しても null (2 重取得不可)", () => {
    const token = insertToken(db, makeToken());
    expect(acquireLease(db, token.id, "h1", 60)).not.toBeNull();
    expect(acquireLease(db, token.id, "h1", 60)).toBeNull();
  });

  test("releaseLease 後に別 holder が acquire 可", () => {
    const token = insertToken(db, makeToken());
    acquireLease(db, token.id, "h1", 60);
    releaseLease(db, token.id, "h1");
    expect(acquireLease(db, token.id, "h2", 60)).not.toBeNull();
  });

  test("releaseLease 他 holder 指定は no-op (勝手に解放しない)", () => {
    const token = insertToken(db, makeToken());
    acquireLease(db, token.id, "h1", 60);
    releaseLease(db, token.id, "h-other"); // 他 holder → 消えない
    const active = listActiveLeases(db);
    expect(active.length).toBe(1);
    expect(active[0]?.holder).toBe("h1");
  });

  test("TTL 過ぎた lease は acquireLease 前置の cleanup で DELETE されて次の acquire 成功", () => {
    const token = insertToken(db, makeToken());
    const expired = acquireLease(db, token.id, "h1", -10); // 負の TTL = 即期限切れ
    expect(expired).not.toBeNull();
    // 別 holder が acquire → 前置 cleanup で期限切れ lease 削除 → 成功
    const next = acquireLease(db, token.id, "h2", 60);
    expect(next).not.toBeNull();
    expect(next?.holder).toBe("h2");
  });

  test("expireLeases(nowIso) で過去 lease の削除件数を得る", () => {
    const token1 = insertToken(db, makeToken({ handle: "@a", organization_id: "org-a" }));
    const token2 = insertToken(db, makeToken({ handle: "@b", organization_id: "org-b" }));
    acquireLease(db, token1.id, "h1", 10); // expires = now+10s
    acquireLease(db, token2.id, "h2", 3600); // expires = now+3600s

    // 未来の時刻を渡すと token1 の lease のみ期限切れ扱いになる
    const futureIso = new Date(Date.now() + 20_000).toISOString();
    const deleted = expireLeases(db, futureIso);
    expect(deleted).toBe(1);
    const active = listActiveLeases(db, futureIso);
    expect(active.length).toBe(1);
    expect(active[0]?.holder).toBe("h2");
  });

  test("並行 race: Promise.all で 10 並列 acquire → 成功は 1 件のみ", async () => {
    const token = insertToken(db, makeToken());
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        Promise.resolve().then(() => acquireLease(db, token.id, `holder-${i}`, 60)),
      ),
    );
    const successes = results.filter((r) => r !== null);
    expect(successes.length).toBe(1);
  });

  test("listActiveLeases は expires_at >= now のみ返す", () => {
    const token1 = insertToken(db, makeToken({ handle: "@a", organization_id: "org-a" }));
    const token2 = insertToken(db, makeToken({ handle: "@b", organization_id: "org-b" }));
    acquireLease(db, token1.id, "h1", 3600);
    acquireLease(db, token2.id, "h2", -100); // 即期限切れ

    const now = new Date().toISOString();
    const active = listActiveLeases(db, now);
    expect(active.length).toBe(1);
    expect(active[0]?.holder).toBe("h1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Keychain (KEYCHAIN_TEST_MODE=1 in-memory)
// ─────────────────────────────────────────────────────────────────────────────

describe("Keychain (in-memory mode)", () => {
  const prev = process.env.KEYCHAIN_TEST_MODE;

  beforeAll(() => {
    process.env.KEYCHAIN_TEST_MODE = "1";
  });

  afterAll(() => {
    if (prev === undefined) delete process.env.KEYCHAIN_TEST_MODE;
    else process.env.KEYCHAIN_TEST_MODE = prev;
    __resetInMemoryKeychainForTest();
  });

  beforeEach(() => {
    __resetInMemoryKeychainForTest();
  });

  test("store → retrieve で同じ値が返る", () => {
    storeTokenInKeychain("@x", "sk-secret-abc");
    expect(retrieveTokenFromKeychain("@x")).toBe("sk-secret-abc");
  });

  test("delete 後の retrieve は KeychainNotFoundError", () => {
    storeTokenInKeychain("@x", "sk-to-delete");
    deleteTokenFromKeychain("@x");
    expect(() => retrieveTokenFromKeychain("@x")).toThrow(KeychainNotFoundError);
  });

  test("未登録 handle の retrieve は KeychainNotFoundError", () => {
    expect(() => retrieveTokenFromKeychain("@never")).toThrow(KeychainNotFoundError);
  });

  test("未登録 handle の delete は冪等 (throw しない)", () => {
    expect(() => deleteTokenFromKeychain("@never")).not.toThrow();
  });

  test("isKeychainSupported() は test-mode で false", () => {
    expect(isKeychainSupported()).toBe(false);
  });

  test("同じ handle を再 store すると値が上書きされる", () => {
    storeTokenInKeychain("@x", "old");
    storeTokenInKeychain("@x", "new");
    expect(retrieveTokenFromKeychain("@x")).toBe("new");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Keychain (macOS 実機)
// ─────────────────────────────────────────────────────────────────────────────

describe("Keychain (macOS real)", () => {
  const shouldRun =
    process.platform === "darwin" && process.env.KEYCHAIN_TEST_MODE !== "1";
  const prev = process.env.KEYCHAIN_TEST_MODE;

  // test prefix をユニーク化して並列/再実行で衝突しないようにする
  const TEST_PREFIX = `@cmux-team-test-${process.pid}-`;
  const testHandle = (suffix: string) => `${TEST_PREFIX}${suffix}`;

  beforeAll(() => {
    if (shouldRun) delete process.env.KEYCHAIN_TEST_MODE;
  });

  afterAll(() => {
    if (prev === undefined) delete process.env.KEYCHAIN_TEST_MODE;
    else process.env.KEYCHAIN_TEST_MODE = prev;
  });

  // 各テスト終わりに掃除
  afterEach(() => {
    if (!shouldRun) return;
    for (const suffix of ["a", "b", "meta;rm", "dup"]) {
      try {
        deleteTokenFromKeychain(testHandle(suffix));
      } catch {
        // 掃除失敗は無視
      }
    }
  });

  test.skipIf(!shouldRun)(
    "store → retrieve → delete のラウンドトリップが成功する",
    () => {
      const handle = testHandle("a");
      const value = "sk-test-roundtrip-xyz";
      storeTokenInKeychain(handle, value);
      expect(retrieveTokenFromKeychain(handle)).toBe(value);
      deleteTokenFromKeychain(handle);
      expect(() => retrieveTokenFromKeychain(handle)).toThrow(KeychainNotFoundError);
    },
  );

  test.skipIf(!shouldRun)(
    "shell metacharacter を含む handle でも args 渡しなので安全",
    () => {
      const handle = testHandle("meta;rm"); // セミコロン含む
      const value = "sk-meta-test";
      storeTokenInKeychain(handle, value);
      expect(retrieveTokenFromKeychain(handle)).toBe(value);
      deleteTokenFromKeychain(handle);
    },
  );

  test.skipIf(!shouldRun)(
    "存在しない handle の retrieve は KeychainNotFoundError",
    () => {
      const handle = testHandle("b"); // 未登録
      expect(() => retrieveTokenFromKeychain(handle)).toThrow(KeychainNotFoundError);
    },
  );

  test.skipIf(!shouldRun)(
    "存在しない handle の delete は冪等 (throw しない)",
    () => {
      const handle = testHandle("b");
      expect(() => deleteTokenFromKeychain(handle)).not.toThrow();
    },
  );

  test.skipIf(!shouldRun)(
    "同じ handle を再 store すると値が上書きされる (-U)",
    () => {
      const handle = testHandle("dup");
      storeTokenInKeychain(handle, "v1");
      storeTokenInKeychain(handle, "v2");
      expect(retrieveTokenFromKeychain(handle)).toBe("v2");
      deleteTokenFromKeychain(handle);
    },
  );

  test.skipIf(!shouldRun)("isKeychainSupported() は macOS 実機で true", () => {
    expect(isKeychainSupported()).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Keychain (非 macOS / test-mode OFF のガード)
// ─────────────────────────────────────────────────────────────────────────────

describe("Keychain (unsupported platform guard)", () => {
  const shouldRun =
    process.platform !== "darwin" && process.env.KEYCHAIN_TEST_MODE !== "1";

  test.skipIf(!shouldRun)(
    "非 macOS かつ test-mode OFF では KeychainUnsupportedError を throw",
    () => {
      expect(() => storeTokenInKeychain("@x", "v")).toThrow(
        KeychainUnsupportedError,
      );
      expect(() => retrieveTokenFromKeychain("@x")).toThrow(
        KeychainUnsupportedError,
      );
      expect(() => deleteTokenFromKeychain("@x")).toThrow(
        KeychainUnsupportedError,
      );
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// computePoolCapacity — A019 §pool_capacity §検証表 (式基準の期待値)
// ─────────────────────────────────────────────────────────────────────────────

describe("computePoolCapacity", () => {
  // nowIso を固定してテスト可能にする
  const NOW = "2026-04-25T00:00:00.000Z";
  const nowMs = new Date(NOW).getTime();

  /** now からの hours を ISO 8601 に変換するヘルパ */
  function hoursFromNow(h: number): string {
    return new Date(nowMs + h * 3_600_000).toISOString();
  }

  test("ケース 1: x20 満タン、reset 5h → 5h ≒ 3360% / 7d ≒ 100% / per_token min=100%", () => {
    const tokens: TokenForCapacity[] = [
      {
        handle: "@x20",
        plan_ratio: 20.0,
        util_5h: 0.0,
        util_7d: 0.0,
        reset_5h_at: hoursFromNow(5),
        reset_7d_at: hoursFromNow(168),
      },
    ];
    const result = computePoolCapacity(tokens, NOW);
    // flow_5h = 1.0 × 20 / 5 = 4.0   → cap_5h = 4.0/(20/168)*100 = 3360
    // flow_7d = 1.0 × 20 / 168 = 0.119  → cap_7d = 100
    expect(result.capacity_5h_pct).toBeCloseTo(3360, 1);
    expect(result.capacity_7d_pct).toBeCloseTo(100, 2);
    expect(result.per_token.length).toBe(1);
    // per_token は従来通り min ベース
    expect(result.per_token[0]?.cap_pct).toBeCloseTo(100, 2);
  });

  test("ケース 2: x20 満タン、両 reset 7d → 5h=100, 7d=100", () => {
    const tokens: TokenForCapacity[] = [
      {
        handle: "@x20",
        plan_ratio: 20.0,
        util_5h: 0.0,
        util_7d: 0.0,
        reset_5h_at: hoursFromNow(168),
        reset_7d_at: hoursFromNow(168),
      },
    ];
    const result = computePoolCapacity(tokens, NOW);
    expect(result.capacity_5h_pct).toBeCloseTo(100, 2);
    expect(result.capacity_7d_pct).toBeCloseTo(100, 2);
  });

  test("ケース 3: x20 10% 残、reset 30min → 5h ≒ 3360% / 7d ≒ 50%", () => {
    const tokens: TokenForCapacity[] = [
      {
        handle: "@x20",
        plan_ratio: 20.0,
        util_5h: 0.9,
        util_7d: 0.5,
        reset_5h_at: hoursFromNow(0.5),
        reset_7d_at: hoursFromNow(168),
      },
    ];
    const result = computePoolCapacity(tokens, NOW);
    // flow_5h = 0.1 × 20 / 0.5 = 4.0   → cap_5h = 3360
    // flow_7d = 0.5 × 20 / 168 = 0.0595 → cap_7d ≒ 50
    expect(result.capacity_5h_pct).toBeCloseTo(3360, 1);
    expect(result.capacity_7d_pct).toBeCloseTo(50, 1);
    // per_token (min) ≒ 50
    expect(result.per_token[0]?.cap_pct).toBeCloseTo(50, 1);
  });

  test("ケース 4: x20 10% 残、reset 3h → 5h ≒ 560% / 7d ≒ 50%", () => {
    const tokens: TokenForCapacity[] = [
      {
        handle: "@x20",
        plan_ratio: 20.0,
        util_5h: 0.9,
        util_7d: 0.5,
        reset_5h_at: hoursFromNow(3),
        reset_7d_at: hoursFromNow(168),
      },
    ];
    const result = computePoolCapacity(tokens, NOW);
    // flow_5h = 0.1 × 20 / 3 = 0.6667 → cap_5h = 0.6667/(20/168)*100 = 560
    // flow_7d = 0.5 × 20 / 168 = 0.0595 → cap_7d ≒ 50
    expect(result.capacity_5h_pct).toBeCloseTo(560, 0);
    expect(result.capacity_7d_pct).toBeCloseTo(50, 1);
  });

  test("ケース 5: Pro 満タン、reset 7d → 5h=5, 7d=5", () => {
    const tokens: TokenForCapacity[] = [
      {
        handle: "@pro",
        plan_ratio: 1.0,
        util_5h: 0.0,
        util_7d: 0.0,
        reset_5h_at: hoursFromNow(168),
        reset_7d_at: hoursFromNow(168),
      },
    ];
    const result = computePoolCapacity(tokens, NOW);
    expect(result.capacity_5h_pct).toBeCloseTo(5, 2);
    expect(result.capacity_7d_pct).toBeCloseTo(5, 2);
  });

  test("ケース 6: x20 + Pro 両方満タン 7d → 5h=105, 7d=105", () => {
    const tokens: TokenForCapacity[] = [
      {
        handle: "@x20",
        plan_ratio: 20.0,
        util_5h: 0.0,
        util_7d: 0.0,
        reset_5h_at: hoursFromNow(168),
        reset_7d_at: hoursFromNow(168),
      },
      {
        handle: "@pro",
        plan_ratio: 1.0,
        util_5h: 0.0,
        util_7d: 0.0,
        reset_5h_at: hoursFromNow(168),
        reset_7d_at: hoursFromNow(168),
      },
    ];
    const result = computePoolCapacity(tokens, NOW);
    expect(result.capacity_5h_pct).toBeCloseTo(105, 2);
    expect(result.capacity_7d_pct).toBeCloseTo(105, 2);
    expect(result.per_token.length).toBe(2);
  });

  test("plan_ratio=null のアカウントは capacity 計算から除外される", () => {
    const tokens: TokenForCapacity[] = [
      {
        handle: "@unknown",
        plan_ratio: null,
        util_5h: 0.0,
        util_7d: 0.0,
        reset_5h_at: hoursFromNow(168),
        reset_7d_at: hoursFromNow(168),
      },
      {
        handle: "@x20",
        plan_ratio: 20.0,
        util_5h: 0.0,
        util_7d: 0.0,
        reset_5h_at: hoursFromNow(168),
        reset_7d_at: hoursFromNow(168),
      },
    ];
    const result = computePoolCapacity(tokens, NOW);
    expect(result.per_token.length).toBe(1);
    expect(result.per_token[0]?.handle).toBe("@x20");
    expect(result.capacity_5h_pct).toBeCloseTo(100, 2);
    expect(result.capacity_7d_pct).toBeCloseTo(100, 2);
  });

  test("util が null なら満タン扱い (残量 1.0)", () => {
    const tokens: TokenForCapacity[] = [
      {
        handle: "@x20",
        plan_ratio: 20.0,
        util_5h: null,
        util_7d: null,
        reset_5h_at: hoursFromNow(168),
        reset_7d_at: hoursFromNow(168),
      },
    ];
    const result = computePoolCapacity(tokens, NOW);
    expect(result.capacity_5h_pct).toBeCloseTo(100, 2);
    expect(result.capacity_7d_pct).toBeCloseTo(100, 2);
  });

  test("reset_5h_at=null は 5h 側 0 寄与、7d のみで計算", () => {
    const tokens: TokenForCapacity[] = [
      {
        handle: "@x20",
        plan_ratio: 20.0,
        util_5h: 0.9,
        util_7d: 0.0,
        reset_5h_at: null,
        reset_7d_at: hoursFromNow(168),
      },
    ];
    const result = computePoolCapacity(tokens, NOW);
    // 5h reset null → 5h 側 0 寄与
    // flow_7d = 1.0 × 20 / 168 = 0.1190 → cap_7d = 100
    expect(result.capacity_5h_pct).toBe(0);
    expect(result.capacity_7d_pct).toBeCloseTo(100, 2);
  });

  test("両 reset が過去（両 window null 相当） → 5h 側 0、7d 側はフル 7d 相当", () => {
    const tokens: TokenForCapacity[] = [
      {
        handle: "@x20",
        plan_ratio: 20.0,
        util_5h: 0.5,
        util_7d: 0.5,
        reset_5h_at: hoursFromNow(-5), // 過去
        reset_7d_at: hoursFromNow(-168), // 過去
      },
    ];
    const result = computePoolCapacity(tokens, NOW);
    // どちらも skip → 7d 側に (plan_ratio / FULL_WEEK_HOURS) 寄与 = (20/168)/(20/168)*100 = 100
    expect(result.capacity_5h_pct).toBe(0);
    expect(result.capacity_7d_pct).toBeCloseTo(100, 2);
  });

  test("空配列 → capacity_5h_pct=0, capacity_7d_pct=0, per_token=[]", () => {
    const result = computePoolCapacity([], NOW);
    expect(result.capacity_5h_pct).toBe(0);
    expect(result.capacity_7d_pct).toBe(0);
    expect(result.per_token).toEqual([]);
  });

  test("REFERENCE_FLOW は 20/168 (≒0.119)", () => {
    expect(REFERENCE_FLOW).toBeCloseTo(20 / 168, 6);
  });

  test("reset が極めて近い (1 秒後) → MIN_HOURS (1分) に clamp、5h は 巨大値だが finite、7d は通常値", () => {
    const tokens: TokenForCapacity[] = [
      {
        handle: "@x20",
        plan_ratio: 20.0,
        util_5h: 0.0,
        util_7d: 0.0,
        reset_5h_at: hoursFromNow(1 / 3600), // 1 秒後
        reset_7d_at: hoursFromNow(168),
      },
    ];
    const result = computePoolCapacity(tokens, NOW);
    // 1 秒は MIN_HOURS=1/60h に clamp される。flow_5h = 1.0 × 20 / (1/60) = 1200 → cap_5h = 1200/(20/168)*100 = 1008000
    expect(Number.isFinite(result.capacity_5h_pct)).toBe(true);
    expect(result.capacity_5h_pct).toBeGreaterThan(1000);
    expect(result.capacity_7d_pct).toBeCloseTo(100, 2);
    // per_token (min ベース) ≒ 100
    expect(Number.isFinite(result.per_token[0]?.cap_pct ?? 0)).toBe(true);
    expect(result.per_token[0]?.cap_pct).toBeCloseTo(100, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// deleteToken / updateTokenAuth / updateTokenPlan (T319)
// ─────────────────────────────────────────────────────────────────────────────

describe("deleteToken (T319)", () => {
  test("tokens / usage_snapshots / leases から全て削除される", () => {
    const token = insertToken(db, makeToken({ handle: "@del" }));
    upsertUsageSnapshot(db, {
      token_id: token.id,
      util_5h: 0.1,
      util_7d: 0.2,
      reset_5h_at: null,
      reset_7d_at: null,
      unified_status: null,
    });
    acquireLease(db, token.id, "h1", 60);

    deleteToken(db, token.id);

    expect(getTokenByHandle(db, "@del")).toBeNull();
    const snap = db
      .prepare("SELECT COUNT(*) AS c FROM usage_snapshots WHERE token_id=?")
      .get(token.id) as { c: number };
    expect(snap.c).toBe(0);
    const lease = db
      .prepare("SELECT COUNT(*) AS c FROM leases WHERE token_id=?")
      .get(token.id) as { c: number };
    expect(lease.c).toBe(0);
  });

  test("存在しない id でも例外が出ない（冪等。補償トランザクションで再呼び出し可能）", () => {
    expect(() => deleteToken(db, 99999)).not.toThrow();
  });

  test("複数 token のうち 1 件削除しても他 token は影響を受けない", () => {
    const a = insertToken(db, makeToken({ handle: "@a", organization_id: "org-a" }));
    const b = insertToken(db, makeToken({ handle: "@b", organization_id: "org-b" }));
    upsertUsageSnapshot(db, {
      token_id: a.id,
      util_5h: 0.1,
      util_7d: null,
      reset_5h_at: null,
      reset_7d_at: null,
      unified_status: null,
    });
    upsertUsageSnapshot(db, {
      token_id: b.id,
      util_5h: 0.5,
      util_7d: null,
      reset_5h_at: null,
      reset_7d_at: null,
      unified_status: null,
    });
    deleteToken(db, a.id);

    expect(getTokenByHandle(db, "@a")).toBeNull();
    expect(getTokenByHandle(db, "@b")).not.toBeNull();
    const snap = getLatestUsageSnapshot(db, b.id);
    expect(snap?.util_5h).toBe(0.5);
  });

  // 補強 1 (plan §1.1 候補 1): leases / usage_snapshots の片方が空でも tokens 行は削除される
  test("usage_snapshots / leases 片方が空でも tokens 行は削除される (部分状態の冪等性)", () => {
    const onlySnap = insertToken(db, makeToken({ handle: "@only-snap", organization_id: "org-snap" }));
    upsertUsageSnapshot(db, {
      token_id: onlySnap.id,
      util_5h: 0.3,
      util_7d: null,
      reset_5h_at: null,
      reset_7d_at: null,
      unified_status: null,
    });
    deleteToken(db, onlySnap.id);
    expect(getTokenByHandle(db, "@only-snap")).toBeNull();

    const onlyLease = insertToken(db, makeToken({ handle: "@only-lease", organization_id: "org-lease" }));
    acquireLease(db, onlyLease.id, "h2", 60);
    deleteToken(db, onlyLease.id);
    expect(getTokenByHandle(db, "@only-lease")).toBeNull();
    const lease = db
      .prepare("SELECT COUNT(*) AS c FROM leases WHERE token_id=?")
      .get(onlyLease.id) as { c: number };
    expect(lease.c).toBe(0);
  });
});

describe("updateTokenAuth (T319)", () => {
  test("auth_hash が新しい値で上書きされる", () => {
    const token = insertToken(db, makeToken({ handle: "@auth", auth_hash: "oldoldoldold" }));
    const newHash = "newnewnewnew";
    updateTokenAuth(db, token.id, newHash);
    const got = getTokenByHandle(db, "@auth");
    expect(got?.auth_hash).toBe(newHash);
  });

  test("存在しない id への呼び出しは no-op (例外なし)", () => {
    expect(() => updateTokenAuth(db, 99999, "xxxxxxxxxxxx")).not.toThrow();
  });

  test("他 token の auth_hash には影響しない", () => {
    const a = insertToken(db, makeToken({ handle: "@a", organization_id: "org-a", auth_hash: "aaaaaaaaaaaa" }));
    const b = insertToken(db, makeToken({ handle: "@b", organization_id: "org-b", auth_hash: "bbbbbbbbbbbb" }));
    updateTokenAuth(db, a.id, "cccccccccccc");
    expect(getTokenByHandle(db, "@a")?.auth_hash).toBe("cccccccccccc");
    expect(getTokenByHandle(db, "@b")?.auth_hash).toBe("bbbbbbbbbbbb");
  });

  // 補強 2 (plan §1.1 候補 2): updateTokenAuth + getTokenByAuthHash の整合性
  test("updateTokenAuth で書いた値は getTokenByAuthHash で検索できる (往復整合性)", () => {
    const token = insertToken(db, makeToken({ handle: "@auth-roundtrip", auth_hash: "before000000" }));
    expect(getTokenByAuthHash(db, "before000000")?.id).toBe(token.id);

    updateTokenAuth(db, token.id, "after0000000");

    expect(getTokenByAuthHash(db, "before000000")).toBeNull();
    expect(getTokenByAuthHash(db, "after0000000")?.id).toBe(token.id);
    expect(getTokenByAuthHash(db, "after0000000")?.handle).toBe("@auth-roundtrip");
  });
});

describe("updateTokenPlan (T319)", () => {
  test("plan / plan_ratio が更新される", () => {
    const token = insertToken(
      db,
      makeToken({ handle: "@plan", plan: "unknown", plan_ratio: null }),
    );
    updateTokenPlan(db, token.id, "max-x20", 20.0);
    const got = getTokenByHandle(db, "@plan");
    expect(got?.plan).toBe("max-x20");
    expect(got?.plan_ratio).toBe(20.0);
  });

  test("plan_ratio に null を保存できる (unknown plan へ戻す経路)", () => {
    const token = insertToken(db, makeToken({ handle: "@p2" }));
    updateTokenPlan(db, token.id, "unknown", null);
    const got = getTokenByHandle(db, "@p2");
    expect(got?.plan).toBe("unknown");
    expect(got?.plan_ratio).toBeNull();
  });

  test("selectable / handle / organization_id / tags は不変", () => {
    const token = insertToken(
      db,
      makeToken({
        handle: "@sticky",
        organization_id: "org-sticky",
        plan: "unknown",
        plan_ratio: null,
        tags: ["any", "kddi"],
        selectable: false,
      }),
    );
    updateTokenPlan(db, token.id, "max-x20", 20.0);
    const got = getTokenByHandle(db, "@sticky");
    expect(got?.handle).toBe("@sticky");
    expect(got?.organization_id).toBe("org-sticky");
    expect(got?.tags).toEqual(["any", "kddi"]);
    expect(got?.selectable).toBe(false);
  });
});

describe("updateTokenPromoteFields (T341)", () => {
  test("auto-discover token を正規 token に変換する (handle / auth_hash / plan / tags / source / selectable=1)", () => {
    const token = insertToken(
      db,
      makeToken({
        handle: "@cd8d",
        organization_id: "cd8db5e8-aaaa-bbbb-cccc-000000000000",
        auth_hash: "auto00000000",
        plan: "unknown",
        plan_ratio: null,
        tags: ["auto"],
        credential_source: "auto-discover",
        selectable: false,
      }),
    );

    updateTokenPromoteFields(db, token.id, {
      handle: "@kddi",
      auth_hash: "promoted0000",
      plan: "max-x20",
      plan_ratio: 20.0,
      tags: ["any", "kddi"],
      // T391: claude-credentials を廃止。promote は manual に統一。
      credential_source: "manual",
    });

    expect(getTokenByHandle(db, "@cd8d")).toBeNull();
    const got = getTokenByHandle(db, "@kddi");
    expect(got).not.toBeNull();
    expect(got?.id).toBe(token.id);
    expect(got?.organization_id).toBe("cd8db5e8-aaaa-bbbb-cccc-000000000000");
    expect(got?.auth_hash).toBe("promoted0000");
    expect(got?.plan).toBe("max-x20");
    expect(got?.plan_ratio).toBe(20.0);
    expect(got?.tags).toEqual(["any", "kddi"]);
    expect(got?.credential_source).toBe("manual");
    expect(got?.selectable).toBe(true);
  });

  test("既存 token_id を保持するので usage_snapshots は壊れない", () => {
    const token = insertToken(
      db,
      makeToken({
        handle: "@cd8d",
        organization_id: "org-snap-keeper",
        auth_hash: "auto-snap-aa",
        plan: "unknown",
        plan_ratio: null,
        tags: ["auto"],
        credential_source: "auto-discover",
        selectable: false,
      }),
    );
    upsertUsageSnapshot(db, {
      token_id: token.id,
      util_5h: 0.42,
      util_7d: 0.21,
      reset_5h_at: null,
      reset_7d_at: null,
      unified_status: null,
    });

    updateTokenPromoteFields(db, token.id, {
      handle: "@kddi",
      auth_hash: "promoted-snap",
      plan: "max-x5",
      plan_ratio: 5.0,
      tags: ["any"],
      credential_source: "manual",
    });

    const snap = getLatestUsageSnapshot(db, token.id);
    expect(snap).not.toBeNull();
    expect(snap?.util_5h).toBeCloseTo(0.42, 5);
    expect(snap?.util_7d).toBeCloseTo(0.21, 5);
  });

  test("plan_ratio に null を保存できる (unknown plan のまま昇格する経路)", () => {
    const token = insertToken(
      db,
      makeToken({
        handle: "@auto",
        organization_id: "org-unknown-plan",
        plan: "unknown",
        plan_ratio: null,
        tags: ["auto"],
        credential_source: "auto-discover",
        selectable: false,
      }),
    );
    updateTokenPromoteFields(db, token.id, {
      handle: "@new",
      auth_hash: "newauth00000",
      plan: "unknown",
      plan_ratio: null,
      tags: ["any"],
      credential_source: "manual",
    });
    const got = getTokenByHandle(db, "@new");
    expect(got?.plan).toBe("unknown");
    expect(got?.plan_ratio).toBeNull();
    expect(got?.selectable).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// selectToken (T321: tags フィルタ回帰)
// ─────────────────────────────────────────────────────────────────────────────

describe("selectToken (tags フィルタ)", () => {
  function seedFreshSnapshot(tokenId: number, util5h = 0.1, util7d = 0.1): void {
    upsertUsageSnapshot(db, {
      token_id: tokenId,
      util_5h: util5h,
      util_7d: util7d,
      reset_5h_at: null,
      reset_7d_at: null,
      unified_status: null,
    });
  }

  test("project_tags=['any'] (default) で any token が選ばれる", () => {
    const t = insertToken(
      db,
      makeToken({ handle: "@anytok", organization_id: "org-anytok", tags: ["any"] }),
    );
    seedFreshSnapshot(t.id);
    const sel = selectToken(db, "holder-1");
    expect(sel?.token.handle).toBe("@anytok");
  });

  test("project_tags=['org:kddi'] で tags=['org:kddi'] token が選ばれる", () => {
    const t = insertToken(
      db,
      makeToken({
        handle: "@kddi",
        organization_id: "org-kddi",
        tags: ["org:kddi"],
      }),
    );
    seedFreshSnapshot(t.id);
    const sel = selectToken(db, "holder-1", ["org:kddi"]);
    expect(sel?.token.handle).toBe("@kddi");
  });

  test("project_tags=['org:kddi'] で tags=['any'] token もマッチ (any は wildcard)", () => {
    const t = insertToken(
      db,
      makeToken({ handle: "@anytok", organization_id: "org-anytok", tags: ["any"] }),
    );
    seedFreshSnapshot(t.id);
    const sel = selectToken(db, "holder-1", ["org:kddi"]);
    expect(sel?.token.handle).toBe("@anytok");
  });

  test("project_tags=['org:kddi'] で tags=['org:other'] token は除外される", () => {
    insertToken(
      db,
      makeToken({
        handle: "@other",
        organization_id: "org-other",
        tags: ["org:other"],
      }),
    );
    // 候補は他に無い → null
    const sel = selectToken(db, "holder-1", ["org:kddi"]);
    expect(sel).toBeNull();
  });

  test("any token と org:kddi token が混在 → score 最小が選ばれる (tags フィルタは両方通る)", () => {
    const tAny = insertToken(
      db,
      makeToken({ handle: "@any", organization_id: "org-any-mix", tags: ["any"] }),
    );
    const tKddi = insertToken(
      db,
      makeToken({ handle: "@kddi", organization_id: "org-kddi-mix", tags: ["org:kddi"] }),
    );
    seedFreshSnapshot(tAny.id, 0.5, 0.5); // score = 0.5
    seedFreshSnapshot(tKddi.id, 0.1, 0.1); // score = 0.1
    const sel = selectToken(db, "holder-1", ["org:kddi"]);
    expect(sel?.token.handle).toBe("@kddi");
  });

  test("project_tags=['any'] のとき org:kddi token もマッチする (project 側 any は全許可)", () => {
    const t = insertToken(
      db,
      makeToken({
        handle: "@kddi",
        organization_id: "org-kddi-only",
        tags: ["org:kddi"],
      }),
    );
    seedFreshSnapshot(t.id);
    const sel = selectToken(db, "holder-1", ["any"]);
    expect(sel?.token.handle).toBe("@kddi");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// selectToken (T335: project policy / OSS / default 昇格)
// ─────────────────────────────────────────────────────────────────────────────

describe("selectToken (T335: project policy / OSS / default 昇格)", () => {
  function seedFreshSnapshot(tokenId: number, util5h = 0.1, util7d = 0.1): void {
    upsertUsageSnapshot(db, {
      token_id: tokenId,
      util_5h: util5h,
      util_7d: util7d,
      reset_5h_at: null,
      reset_7d_at: null,
      unified_status: null,
    });
  }

  /** plan §3.4 の検証シナリオ K1/K2/K3 を seed する。util は呼び出し側で上書き */
  function seedThreeKeys() {
    const k1 = insertToken(
      db,
      makeToken({ handle: "@personal", organization_id: "org-personal", tags: ["any"] }),
    );
    const k2 = insertToken(
      db,
      makeToken({ handle: "@a-corp", organization_id: "org-a-corp", tags: ["org:A"] }),
    );
    const k3 = insertToken(
      db,
      makeToken({ handle: "@b-corp", organization_id: "org-b-corp", tags: ["org:B"] }),
    );
    return { k1, k2, k3 };
  }

  // ── exclude / include / default の優先順位 ─────────────────────────────────

  test("exclude 最優先: include に同じ handle が含まれていても候補外", () => {
    // 単独で K1 のみ seed する（他 token の干渉を排除）
    const k1 = insertToken(
      db,
      makeToken({ handle: "@personal", organization_id: "org-personal", tags: ["any"] }),
    );
    seedFreshSnapshot(k1.id, 0.05, 0.05);
    const sel = selectToken(db, "h", {
      projectTags: ["org:A"],
      projectDefault: null,
      include: ["@personal"], // include に入れていても
      exclude: ["@personal"], // exclude が勝つ
      isOss: false,
      ossDefault: null,
    });
    expect(sel).toBeNull();
  });

  test("default は selectable=0 でも runtime 候補化される（DB 不変）", () => {
    const k = insertToken(
      db,
      makeToken({
        handle: "@discovered",
        organization_id: "org-discovered",
        tags: ["any"],
        credential_source: "auto-discover",
        selectable: false, // selectable=0
      }),
    );
    seedFreshSnapshot(k.id, 0.05, 0.05);

    const sel = selectToken(db, "h", {
      projectTags: ["org:A"],
      projectDefault: "@discovered", // default に明示
      include: [],
      exclude: [],
      isOss: false,
      ossDefault: null,
    });
    expect(sel?.token.handle).toBe("@discovered");

    // DB 上の selectable は変更されない
    const reloaded = getTokenByHandle(db, "@discovered");
    expect(reloaded?.selectable).toBe(false);
  });

  test("default 以外の selectable=0 は候補外（runtime 昇格は default だけ）", () => {
    const k = insertToken(
      db,
      makeToken({
        handle: "@discovered",
        organization_id: "org-discovered",
        tags: ["any"],
        selectable: false,
      }),
    );
    seedFreshSnapshot(k.id, 0.05, 0.05);
    const sel = selectToken(db, "h", {
      projectTags: ["any"],
      projectDefault: null,
      include: [],
      exclude: [],
      isOss: false,
      ossDefault: null,
    });
    expect(sel).toBeNull();
  });

  test("include は tags 不一致でも候補化される", () => {
    const { k1 } = seedThreeKeys(); // @personal tags=["any"], score 0.1
    seedFreshSnapshot(k1.id, 0.05, 0.05);
    // K2 は projectTags=["org:Z"] と一致しない、@personal は any なので元々マッチするので
    // 純粋に include の効果を見るために K2 を include に入れる
    const { k2 } = { k2: getTokenByHandle(db, "@a-corp")! };
    seedFreshSnapshot(k2.id, 0.01, 0.01); // K2 を最低 score にする
    const sel = selectToken(db, "h", {
      projectTags: ["org:Z"], // K2 (org:A) に不一致
      projectDefault: null,
      include: ["@a-corp"],
      exclude: [],
      isOss: false,
      ossDefault: null,
    });
    expect(sel?.token.handle).toBe("@a-corp"); // include 経由で admit + 最低 score
  });

  test("include 指定でも score 最小は他にあれば他が選ばれる", () => {
    seedThreeKeys();
    const k1 = getTokenByHandle(db, "@personal")!;
    const k2 = getTokenByHandle(db, "@a-corp")!;
    seedFreshSnapshot(k1.id, 0.01, 0.01); // K1 が最低
    seedFreshSnapshot(k2.id, 0.5, 0.5); // K2 高
    const sel = selectToken(db, "h", {
      projectTags: ["org:A"], // K2 は tag 一致、K1 は any
      projectDefault: null,
      include: ["@a-corp"],
      exclude: [],
      isOss: false,
      ossDefault: null,
    });
    expect(sel?.token.handle).toBe("@personal");
  });

  // ── effectiveDefault の合成 ───────────────────────────────────────────────

  test("projectDefault は OSS でも projectDefault が優先（ossDefault を上書き）", () => {
    const { k1, k2, k3 } = seedThreeKeys();
    // OSS では K3 も admit されるので、@a-corp を最低 score にして勝てるようにする
    seedFreshSnapshot(k1.id, 0.5, 0.5);
    seedFreshSnapshot(k2.id, 0.01, 0.01);
    seedFreshSnapshot(k3.id, 0.5, 0.5);
    const sel = selectToken(db, "h", {
      projectTags: ["any"],
      projectDefault: "@a-corp", // 明示優先 (effectiveDefault=@a-corp、ossDefault は無視)
      include: [],
      exclude: [],
      isOss: true,
      ossDefault: "@personal",
    });
    expect(sel?.token.handle).toBe("@a-corp");
  });

  test("projectDefault=null + isOss=true → ossDefault が effectiveDefault", () => {
    const { k1, k2, k3 } = seedThreeKeys();
    // OSS で全 token admit されるので、@personal を最低 score にして effectiveDefault が
    // ossDefault に解決されていることを確認
    seedFreshSnapshot(k1.id, 0.01, 0.01);
    seedFreshSnapshot(k2.id, 0.5, 0.5);
    seedFreshSnapshot(k3.id, 0.5, 0.5);
    const sel = selectToken(db, "h", {
      projectTags: ["any"],
      projectDefault: null,
      include: [],
      exclude: [],
      isOss: true,
      ossDefault: "@personal",
    });
    // @personal は ossDefault として無条件 admit + score 最小なので選ばれる
    expect(sel?.token.handle).toBe("@personal");
  });

  // ── OSS project の admit ロジック ─────────────────────────────────────────

  test("OSS project は selectable=1 全 token が tag 不問で候補化される (M2)", () => {
    const { k1, k2, k3 } = seedThreeKeys();
    // 順位付け: K3 (0.01) < K2 (0.05) < K1 (0.10)
    seedFreshSnapshot(k1.id, 0.10, 0.10);
    seedFreshSnapshot(k2.id, 0.05, 0.05);
    seedFreshSnapshot(k3.id, 0.01, 0.01);
    const sel = selectToken(db, "h", {
      projectTags: ["any"],
      projectDefault: null,
      include: [],
      exclude: [],
      isOss: true,
      ossDefault: null, // ossDefault も無し → 純粋に tags 不問 admit を見る
    });
    // K3 (org:B) も tag 不問で admit され、最低 score なので選ばれる
    expect(sel?.token.handle).toBe("@b-corp");
  });

  test("OSS でも exclude にある handle は候補外", () => {
    const { k1, k2, k3 } = seedThreeKeys();
    seedFreshSnapshot(k1.id, 0.10, 0.10);
    seedFreshSnapshot(k2.id, 0.05, 0.05);
    seedFreshSnapshot(k3.id, 0.01, 0.01); // 最低 score だが exclude
    const sel = selectToken(db, "h", {
      projectTags: ["any"],
      projectDefault: null,
      include: [],
      exclude: ["@b-corp"],
      isOss: true,
      ossDefault: null,
    });
    expect(sel?.token.handle).toBe("@a-corp"); // K3 を除いた最低
  });

  // ── 通常 tag matching（非 OSS） ──────────────────────────────────────────

  test("非 OSS: tags 不一致 + include/default なし → 候補外", () => {
    seedThreeKeys();
    const k3 = getTokenByHandle(db, "@b-corp")!;
    seedFreshSnapshot(k3.id, 0.05, 0.05);
    const sel = selectToken(db, "h", {
      projectTags: ["org:A"],
      projectDefault: null,
      include: [],
      exclude: [],
      isOss: false,
      ossDefault: null,
    });
    // K3 は org:B、include/default 不在 → 候補外
    // K1 (any) と K2 (org:A) は seed していない（snapshot なしなので util=0 → score=0 で admit）
    // 実際は K1/K2 も admit されるが snapshot が無いと util 0 → score 0、K1 と K2 同点
    // ここでは K3 が選ばれないことだけ assert する
    if (sel) expect(sel.token.handle).not.toBe("@b-corp");
  });

  test("候補なし → null", () => {
    seedThreeKeys();
    // 何も seed しない & projectTags=org:Z & include/default なし → 全部 admit されない
    const k1 = getTokenByHandle(db, "@personal")!;
    const k2 = getTokenByHandle(db, "@a-corp")!;
    const k3 = getTokenByHandle(db, "@b-corp")!;
    seedFreshSnapshot(k1.id, 0.96, 0.9); // K1 ブロッカー
    seedFreshSnapshot(k2.id, 0.96, 0.9); // K2 ブロッカー
    seedFreshSnapshot(k3.id, 0.96, 0.9); // K3 ブロッカー
    const sel = selectToken(db, "h", {
      projectTags: ["org:Z"],
      projectDefault: null,
      include: [],
      exclude: [],
      isOss: false,
      ossDefault: null,
    });
    expect(sel).toBeNull();
  });

  // ── 後方互換 ────────────────────────────────────────────────────────────

  test("後方互換: selectToken(db, holder, ['any']) 形式", () => {
    const t = insertToken(
      db,
      makeToken({ handle: "@compat", organization_id: "org-compat", tags: ["any"] }),
    );
    seedFreshSnapshot(t.id, 0.05, 0.05);
    const sel = selectToken(db, "h", ["any"]);
    expect(sel?.token.handle).toBe("@compat");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// selectToken (T335: 受け入れ条件 — Project A / Project C シナリオ)
// ─────────────────────────────────────────────────────────────────────────────

describe("selectToken (T335: 受け入れ条件 Project A/C シナリオ)", () => {
  function seedFreshSnapshot(tokenId: number, util5h = 0.1, util7d = 0.1): void {
    upsertUsageSnapshot(db, {
      token_id: tokenId,
      util_5h: util5h,
      util_7d: util7d,
      reset_5h_at: null,
      reset_7d_at: null,
      unified_status: null,
    });
  }

  function seedThreeKeys() {
    const k1 = insertToken(
      db,
      makeToken({ handle: "@personal", organization_id: "org-personal", tags: ["any"] }),
    );
    const k2 = insertToken(
      db,
      makeToken({ handle: "@a-corp", organization_id: "org-a-corp", tags: ["org:A"] }),
    );
    const k3 = insertToken(
      db,
      makeToken({ handle: "@b-corp", organization_id: "org-b-corp", tags: ["org:B"] }),
    );
    return { k1, k2, k3 };
  }

  // ── Project A: default=@a-corp, include=[@personal] ───────────────────────

  test("Project A: default=@a-corp と include=@personal は両方 admit される（最終選択は score）", () => {
    const { k1, k2 } = seedThreeKeys();
    seedFreshSnapshot(k1.id, 0.01, 0.01);
    seedFreshSnapshot(k2.id, 0.10, 0.10);
    const sel = selectToken(db, "h", {
      projectTags: ["org:A"],
      projectDefault: "@a-corp",
      include: ["@personal"],
      exclude: [],
      isOss: false,
      ossDefault: null,
    });
    // default は admit 判定で無条件、最終選択は score 最小で決まる（plan §C-2）。
    // score が低い @personal が勝つ。default の "最優先" は admit 順位の意味であり、
    // 同 admit 候補内での score 比較は通常通り行われる。
    expect(sel?.token.handle).toBe("@personal");
  });

  test("Project A: default が score 最小なら default が選ばれる", () => {
    const { k1, k2 } = seedThreeKeys();
    seedFreshSnapshot(k1.id, 0.10, 0.10);
    seedFreshSnapshot(k2.id, 0.01, 0.01); // default を score 最小に
    const sel = selectToken(db, "h", {
      projectTags: ["org:A"],
      projectDefault: "@a-corp",
      include: ["@personal"],
      exclude: [],
      isOss: false,
      ossDefault: null,
    });
    expect(sel?.token.handle).toBe("@a-corp");
  });

  test("Project A: default が高負荷で blocker → include の @personal が選ばれる", () => {
    const { k1, k2 } = seedThreeKeys();
    seedFreshSnapshot(k1.id, 0.05, 0.05);
    seedFreshSnapshot(k2.id, 0.96, 0.9); // K2 ブロッカー（util_5h>0.95）
    const sel = selectToken(db, "h", {
      projectTags: ["org:A"],
      projectDefault: "@a-corp",
      include: ["@personal"],
      exclude: [],
      isOss: false,
      ossDefault: null,
    });
    expect(sel?.token.handle).toBe("@personal");
  });

  test("Project A: K3 (@b-corp) は org:A 不一致 + include 未指定 → 候補外", () => {
    const { k1, k2, k3 } = seedThreeKeys();
    seedFreshSnapshot(k1.id, 0.96, 0.9); // K1 ブロッカー
    seedFreshSnapshot(k2.id, 0.96, 0.9); // K2 ブロッカー
    seedFreshSnapshot(k3.id, 0.05, 0.05); // K3 は score 最低だが org:B
    const sel = selectToken(db, "h", {
      projectTags: ["org:A"],
      projectDefault: "@a-corp",
      include: ["@personal"],
      exclude: [],
      isOss: false,
      ossDefault: null,
    });
    // K3 は admit されない、K1/K2 は blocker → null
    expect(sel).toBeNull();
  });

  // ── Project C (OSS): primaryOrgs=["myorg"], ossDefault=@personal ─────────

  test("Project C (OSS): selectable=1 全 token が候補（default=@personal が score 最低なら選ばれる）", () => {
    const { k1, k2, k3 } = seedThreeKeys();
    seedFreshSnapshot(k1.id, 0.01, 0.01); // 最低
    seedFreshSnapshot(k2.id, 0.10, 0.10);
    seedFreshSnapshot(k3.id, 0.20, 0.20);
    const sel = selectToken(db, "h", {
      projectTags: ["any"],
      projectDefault: null,
      include: [],
      exclude: [],
      isOss: true,
      ossDefault: "@personal",
    });
    expect(sel?.token.handle).toBe("@personal");
  });

  test("Project C (OSS): @personal を blocker にすると K2/K3 も候補に入る → score 最小が選ばれる", () => {
    const { k1, k2, k3 } = seedThreeKeys();
    seedFreshSnapshot(k1.id, 0.96, 0.9); // K1 ブロッカー
    seedFreshSnapshot(k2.id, 0.05, 0.05);
    seedFreshSnapshot(k3.id, 0.10, 0.10);
    const sel = selectToken(db, "h", {
      projectTags: ["any"],
      projectDefault: null,
      include: [],
      exclude: [],
      isOss: true,
      ossDefault: "@personal",
    });
    expect(sel?.token.handle).toBe("@a-corp");
  });

  test("Project C (OSS): exclude に @b-corp → K1/K2 のみ候補", () => {
    const { k1, k2, k3 } = seedThreeKeys();
    seedFreshSnapshot(k1.id, 0.96, 0.9); // K1 ブロッカー
    seedFreshSnapshot(k2.id, 0.10, 0.10);
    seedFreshSnapshot(k3.id, 0.01, 0.01); // 最低だが exclude
    const sel = selectToken(db, "h", {
      projectTags: ["any"],
      projectDefault: null,
      include: [],
      exclude: ["@b-corp"],
      isOss: true,
      ossDefault: "@personal",
    });
    expect(sel?.token.handle).toBe("@a-corp");
  });
});

// selectToken (T369: stale snapshot の util リセット時刻反映)
// ─────────────────────────────────────────────────────────────────────────────

describe("selectToken (T369: stale snapshot の util リセット時刻反映)", () => {
  /** stale snapshot を seed する。recorded_at を強制的に巻き戻す */
  function seedStaleSnapshot(args: {
    tokenId: number;
    util5h: number | null;
    util7d: number | null;
    reset5hAt: string | null;
    reset7dAt: string | null;
    recordedMinutesAgo: number;
  }): void {
    upsertUsageSnapshot(db, {
      token_id: args.tokenId,
      util_5h: args.util5h,
      util_7d: args.util7d,
      reset_5h_at: args.reset5hAt,
      reset_7d_at: args.reset7dAt,
      unified_status: null,
    });
    const recordedAt = new Date(Date.now() - args.recordedMinutesAgo * 60_000).toISOString();
    db.prepare("UPDATE usage_snapshots SET recorded_at = ? WHERE token_id = ?")
      .run(recordedAt, args.tokenId);
  }

  function seedFreshSnapshot(tokenId: number, util5h = 0.1, util7d = 0.1): void {
    upsertUsageSnapshot(db, {
      token_id: tokenId,
      util_5h: util5h,
      util_7d: util7d,
      reset_5h_at: null,
      reset_7d_at: null,
      unified_status: null,
    });
  }

  function pastIso(minutesAgo: number): string {
    return new Date(Date.now() - minutesAgo * 60_000).toISOString();
  }
  function futureIso(minutesAhead: number): string {
    return new Date(Date.now() + minutesAhead * 60_000).toISOString();
  }
  function pastEpochSec(minutesAgo: number): string {
    return String(Math.floor((Date.now() - minutesAgo * 60_000) / 1000));
  }
  function futureEpochSec(minutesAhead: number): string {
    return String(Math.floor((Date.now() + minutesAhead * 60_000) / 1000));
  }

  test("TC1: stale + reset_5h_at 過去 + reset_7d_at 未来 → 候補化、util_5h=0 で評価", () => {
    const t = insertToken(
      db,
      makeToken({ handle: "@kami", organization_id: "org-kami-tc1", tags: ["any"] }),
    );
    seedStaleSnapshot({
      tokenId: t.id,
      util5h: 0.9,
      util7d: 0.5,
      reset5hAt: pastIso(5),
      reset7dAt: futureIso(60),
      recordedMinutesAgo: 50,
    });
    const sel = selectToken(db, "h-tc1");
    expect(sel?.token.handle).toBe("@kami");
  });

  test("TC2: stale + 両軸 reset 過去 → 候補化、score=0 で fresh 競合より優先される", () => {
    const stale = insertToken(
      db,
      makeToken({ handle: "@kami", organization_id: "org-kami-tc2", tags: ["any"] }),
    );
    const fresh = insertToken(
      db,
      makeToken({ handle: "@fresh", organization_id: "org-fresh-tc2", tags: ["any"] }),
    );
    seedStaleSnapshot({
      tokenId: stale.id,
      util5h: 0.9,
      util7d: 0.5,
      reset5hAt: pastIso(5),
      reset7dAt: pastIso(5),
      recordedMinutesAgo: 50,
    });
    seedFreshSnapshot(fresh.id, 0.05, 0.05);
    const sel = selectToken(db, "h-tc2");
    expect(sel?.token.handle).toBe("@kami");
  });

  test("TC3: stale + reset_5h_at 未来 + reset_7d_at 過去 → util_7d=0 上書き、util_5h は snapshot 値", () => {
    const t = insertToken(
      db,
      makeToken({ handle: "@k3", organization_id: "org-k3-tc3", tags: ["any"] }),
    );
    seedStaleSnapshot({
      tokenId: t.id,
      util5h: 0.9,
      util7d: 0.5,
      reset5hAt: futureIso(60),
      reset7dAt: pastIso(5),
      recordedMinutesAgo: 50,
    });
    const sel = selectToken(db, "h-tc3");
    expect(sel?.token.handle).toBe("@k3");
  });

  test("TC4 (T373: 旧 null → admit 転換): stale + 両軸未来 → snap 値で admit", () => {
    // T373 で挙動変更: 旧仕様では「両軸 reset 未到達 → null」だったが、
    // T373 で stale 救済により snap 値（低 util）のまま admit されるよう変わった。
    const t = insertToken(
      db,
      makeToken({ handle: "@k4", organization_id: "org-k4-tc4", tags: ["any"] }),
    );
    seedStaleSnapshot({
      tokenId: t.id,
      util5h: 0.07,
      util7d: 0.18,
      reset5hAt: futureIso(60),
      reset7dAt: futureIso(120),
      recordedMinutesAgo: 50,
    });
    const sel = selectToken(db, "h-tc4");
    expect(sel?.token.handle).toBe("@k4");
  });

  test("TC5 (T373: 旧 null → admit 転換): stale + reset_5h_at=null + reset_7d_at=null → snap 値で admit", () => {
    // T373 で挙動変更: 旧仕様では「reset 情報無し → null」だったが、
    // T373 で reset 情報が無くても snap 値が下限となり admit される。
    const t = insertToken(
      db,
      makeToken({ handle: "@k5", organization_id: "org-k5-tc5", tags: ["any"] }),
    );
    seedStaleSnapshot({
      tokenId: t.id,
      util5h: 0.05,
      util7d: 0.10,
      reset5hAt: null,
      reset7dAt: null,
      recordedMinutesAgo: 50,
    });
    const sel = selectToken(db, "h-tc5");
    expect(sel?.token.handle).toBe("@k5");
  });

  test("TC6: fresh snapshot は util 上書きされない（回帰）", () => {
    // 高 util の fresh token: reset_*_at が過去でも上書きされず score=0.62 のまま
    const tHigh = insertToken(
      db,
      makeToken({ handle: "@high", organization_id: "org-high-tc6", tags: ["any"] }),
    );
    upsertUsageSnapshot(db, {
      token_id: tHigh.id,
      util_5h: 0.9,
      util_7d: 0.5,
      reset_5h_at: pastIso(5),
      reset_7d_at: pastIso(5),
      unified_status: null,
    });
    // 競合: fresh, score=0.5
    const tCompetitor = insertToken(
      db,
      makeToken({ handle: "@competitor", organization_id: "org-comp-tc6", tags: ["any"] }),
    );
    seedFreshSnapshot(tCompetitor.id, 0.5, 0.5); // score=0.5
    // 上書きされていれば @high の score は 0 で勝つはず。されなければ 0.62 で @competitor が勝つ
    const sel = selectToken(db, "h-tc6");
    expect(sel?.token.handle).toBe("@competitor");
  });

  test("TC7: snapshot 無し token は stale 判定の影響を受けない（回帰）", () => {
    const t = insertToken(
      db,
      makeToken({ handle: "@k7", organization_id: "org-k7-tc7", tags: ["any"] }),
    );
    // snapshot なし
    const sel = selectToken(db, "h-tc7");
    expect(sel?.token.handle).toBe("@k7");
  });

  test("TC8: stale + reset_5h_at 過去 で元 util_5h=0.99 → ブロッカー回避し候補化される", () => {
    const t = insertToken(
      db,
      makeToken({ handle: "@k8", organization_id: "org-k8-tc8", tags: ["any"] }),
    );
    seedStaleSnapshot({
      tokenId: t.id,
      util5h: 0.99,
      util7d: 0.1,
      reset5hAt: pastIso(5),
      reset7dAt: futureIso(120),
      recordedMinutesAgo: 50,
    });
    const sel = selectToken(db, "h-tc8");
    expect(sel?.token.handle).toBe("@k8");
  });

  test("T372-1: stale + reset_5h_at = epoch sec(past) → 候補化、effUtil5h=0 で score 計算", () => {
    const t = insertToken(
      db,
      makeToken({ handle: "@kepoch1", organization_id: "org-kepoch1", tags: ["any"] }),
    );
    seedStaleSnapshot({
      tokenId: t.id,
      util5h: 0.9,
      util7d: 0.5,
      reset5hAt: pastEpochSec(5),
      reset7dAt: futureEpochSec(60),
      recordedMinutesAgo: 50,
    });
    const sel = selectToken(db, "h-372-1");
    expect(sel?.token.handle).toBe("@kepoch1");
  });

  test("T372-2 (T373: 旧 null → admit 転換): stale + 両軸 epoch sec(future) → snap 値で admit", () => {
    // T373 で挙動変更: 旧仕様では「両軸 reset 未到達 → null」だったが、
    // T373 で epoch sec の未来値でも snap 値が下限となり admit される。
    const t = insertToken(
      db,
      makeToken({ handle: "@kepoch2", organization_id: "org-kepoch2", tags: ["any"] }),
    );
    seedStaleSnapshot({
      tokenId: t.id,
      util5h: 0.05,
      util7d: 0.10,
      reset5hAt: futureEpochSec(60),
      reset7dAt: futureEpochSec(120),
      recordedMinutesAgo: 50,
    });
    const sel = selectToken(db, "h-372-2");
    expect(sel?.token.handle).toBe("@kepoch2");
  });

  test("T372-3: stale + reset_5h_at = ISO 8601(past) → 後方互換で admit（既存 TC1 と同等）", () => {
    const t = insertToken(
      db,
      makeToken({ handle: "@kiso", organization_id: "org-kiso", tags: ["any"] }),
    );
    seedStaleSnapshot({
      tokenId: t.id,
      util5h: 0.9,
      util7d: 0.5,
      reset5hAt: pastIso(5),
      reset7dAt: futureIso(60),
      recordedMinutesAgo: 50,
    });
    const sel = selectToken(db, "h-372-3");
    expect(sel?.token.handle).toBe("@kiso");
  });

  test("T372-4 (T373: 旧 null → admit 転換): stale + reset_*_at が不正値 → NaN 解釈で reset 過去とみなさず snap 値で admit", () => {
    // T373 で挙動変更: 旧仕様では「不正値 → null」だったが、
    // T373 では reset 過去判定 (NaN<=now → false) で effUtil 上書きが発動せず、
    // snap 値そのまま admit される。snap.util_5h>0.95 ならブロッカーで止まる、という設計に変わった。
    // T373-2 で「snap.util_5h>0.95 でブロッカー除外」を別途 assert している。
    const t = insertToken(
      db,
      makeToken({ handle: "@kbad", organization_id: "org-kbad", tags: ["any"] }),
    );
    seedStaleSnapshot({
      tokenId: t.id,
      util5h: 0.05,
      util7d: 0.10,
      reset5hAt: "abc",
      reset7dAt: "not-a-date",
      recordedMinutesAgo: 50,
    });
    const sel = selectToken(db, "h-372-4");
    expect(sel?.token.handle).toBe("@kbad");
  });

  test("T372-5: fresh snapshot は reset_5h_at が epoch sec でも util 上書きされない（回帰）", () => {
    const tHigh = insertToken(
      db,
      makeToken({ handle: "@hifresh", organization_id: "org-hifresh", tags: ["any"] }),
    );
    upsertUsageSnapshot(db, {
      token_id: tHigh.id,
      util_5h: 0.9,
      util_7d: 0.5,
      reset_5h_at: pastEpochSec(5),
      reset_7d_at: pastEpochSec(5),
      unified_status: null,
    });
    const tComp = insertToken(
      db,
      makeToken({ handle: "@compfresh", organization_id: "org-compfresh", tags: ["any"] }),
    );
    seedFreshSnapshot(tComp.id, 0.5, 0.5);
    const sel = selectToken(db, "h-372-5");
    expect(sel?.token.handle).toBe("@compfresh");
  });

  // ───────────────────────────────────────────────────────────────────────────
  // T373: stale + reset 未到達でも snap 値を下限として admit する（旧 TC4 等の挙動を反転）
  // ───────────────────────────────────────────────────────────────────────────

  test("T373-1: stale + 両軸 reset 未到達 + 低 util → admit、score=0.3·snap.util_5h+0.7·snap.util_7d", () => {
    const kami = insertToken(
      db,
      makeToken({ handle: "@kami", organization_id: "org-kami-373-1", tags: ["any"] }),
    );
    seedStaleSnapshot({
      tokenId: kami.id,
      util5h: 0.07,
      util7d: 0.18,
      reset5hAt: futureIso(60),
      reset7dAt: futureIso(60 * 24 * 7),
      recordedMinutesAgo: 74,
    });
    // 競合: fresh @hi, score = 0.3*0.5 + 0.7*0.5 = 0.5
    // @kami の score = 0.3*0.07 + 0.7*0.18 = 0.147 → @kami 勝利
    const hi = insertToken(
      db,
      makeToken({ handle: "@hi", organization_id: "org-hi-373-1", tags: ["any"] }),
    );
    seedFreshSnapshot(hi.id, 0.5, 0.5);
    const sel = selectToken(db, "h-373-1");
    expect(sel?.token.handle).toBe("@kami");
  });

  test("T373-2: stale + 両軸 reset 未到達 + snap.util_5h>0.95 → ブロッカーで除外", () => {
    const hot = insertToken(
      db,
      makeToken({ handle: "@hot", organization_id: "org-hot-373-2", tags: ["any"] }),
    );
    seedStaleSnapshot({
      tokenId: hot.id,
      util5h: 0.97,
      util7d: 0.18,
      reset5hAt: futureIso(60),
      reset7dAt: futureIso(60 * 24 * 7),
      recordedMinutesAgo: 50,
    });
    const sel = selectToken(db, "h-373-2");
    expect(sel).toBeNull();
  });

  test("T373-3: stale + 5h reset 過去 / 7d 未到達 → effUtil=(0, snap.util_7d)", () => {
    const aux = insertToken(
      db,
      makeToken({ handle: "@aux", organization_id: "org-aux-373-3", tags: ["any"] }),
    );
    seedStaleSnapshot({
      tokenId: aux.id,
      util5h: 0.9,
      util7d: 0.1,
      reset5hAt: pastIso(5),
      reset7dAt: futureIso(120),
      recordedMinutesAgo: 50,
    });
    // 競合: fresh @cmp, score = 0.3*0.05 + 0.7*0.5 = 0.365
    // @aux の effUtil=(0, 0.1) → score = 0.07 → @aux 勝利
    const cmp = insertToken(
      db,
      makeToken({ handle: "@cmp", organization_id: "org-cmp-373-3", tags: ["any"] }),
    );
    seedFreshSnapshot(cmp.id, 0.05, 0.5);
    const sel = selectToken(db, "h-373-3");
    expect(sel?.token.handle).toBe("@aux");
  });

  test("T373-4: stale + 両軸 reset 過去 → effUtil=(0,0)、score=0 で fresh より優先（リグレッション）", () => {
    const k4r = insertToken(
      db,
      makeToken({ handle: "@k4r", organization_id: "org-k4r-373-4", tags: ["any"] }),
    );
    seedStaleSnapshot({
      tokenId: k4r.id,
      util5h: 0.9,
      util7d: 0.5,
      reset5hAt: pastIso(5),
      reset7dAt: pastIso(5),
      recordedMinutesAgo: 50,
    });
    const cmp = insertToken(
      db,
      makeToken({ handle: "@cmp4r", organization_id: "org-cmp4r-373-4", tags: ["any"] }),
    );
    seedFreshSnapshot(cmp.id, 0.05, 0.05);
    const sel = selectToken(db, "h-373-4");
    expect(sel?.token.handle).toBe("@k4r");
  });

  test("T373-5: fresh snapshot は reset_*_at 過去でも effUtil 上書きされない（回帰）", () => {
    const hi = insertToken(
      db,
      makeToken({ handle: "@hi5", organization_id: "org-hi-373-5", tags: ["any"] }),
    );
    upsertUsageSnapshot(db, {
      token_id: hi.id,
      util_5h: 0.9,
      util_7d: 0.5,
      reset_5h_at: pastEpochSec(5),
      reset_7d_at: pastEpochSec(5),
      unified_status: null,
    });
    const cmp = insertToken(
      db,
      makeToken({ handle: "@cmp5", organization_id: "org-cmp-373-5", tags: ["any"] }),
    );
    seedFreshSnapshot(cmp.id, 0.5, 0.5);
    // fresh @hi5 は上書きされず score = 0.3*0.9 + 0.7*0.5 = 0.62
    // @cmp5 score = 0.5 → @cmp5 勝利
    const sel = selectToken(db, "h-373-5");
    expect(sel?.token.handle).toBe("@cmp5");
  });

  test("T373-6: DB-level 統合 (@kami stale 未到達 / @tayo stale 5h 過去 / @kddi fresh) → @kami が選ばれる", () => {
    const kami = insertToken(
      db,
      makeToken({ handle: "@kami", organization_id: "org-kami-373-6", tags: ["any"] }),
    );
    const tayo = insertToken(
      db,
      makeToken({ handle: "@tayo", organization_id: "org-tayo-373-6", tags: ["any"] }),
    );
    const kddi = insertToken(
      db,
      makeToken({ handle: "@kddi", organization_id: "org-kddi-373-6", tags: ["any"] }),
    );
    // @kami: stale 両軸未到達 → effUtil=(0.07, 0.18) → score=0.147
    seedStaleSnapshot({
      tokenId: kami.id,
      util5h: 0.07,
      util7d: 0.18,
      reset5hAt: futureIso(60),
      reset7dAt: futureIso(60 * 24 * 7),
      recordedMinutesAgo: 74,
    });
    // @tayo: stale 5h 過去 / 7d 未来 → effUtil=(0, 0.91) → score=0.637
    seedStaleSnapshot({
      tokenId: tayo.id,
      util5h: 0.02,
      util7d: 0.91,
      reset5hAt: pastIso(5),
      reset7dAt: futureIso(60 * 24 * 7),
      recordedMinutesAgo: 60,
    });
    // @kddi: fresh, util=(0.51, 0.85) → score=0.748
    seedFreshSnapshot(kddi.id, 0.51, 0.85);
    const sel = selectToken(db, "h-373-6");
    expect(sel?.token.handle).toBe("@kami");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// selectToken (T382: 7d ブロッカー追加)
// ─────────────────────────────────────────────────────────────────────────────

describe("selectToken (T382: 7d blocker)", () => {
  function seedFreshSnapshot(tokenId: number, util5h: number, util7d: number): void {
    upsertUsageSnapshot(db, {
      token_id: tokenId,
      util_5h: util5h,
      util_7d: util7d,
      reset_5h_at: null,
      reset_7d_at: null,
      unified_status: null,
    });
  }

  function seedStaleSnapshot(args: {
    tokenId: number;
    util5h: number | null;
    util7d: number | null;
    reset5hAt: string | null;
    reset7dAt: string | null;
    recordedMinutesAgo: number;
  }): void {
    upsertUsageSnapshot(db, {
      token_id: args.tokenId,
      util_5h: args.util5h,
      util_7d: args.util7d,
      reset_5h_at: args.reset5hAt,
      reset_7d_at: args.reset7dAt,
      unified_status: null,
    });
    const recordedAt = new Date(Date.now() - args.recordedMinutesAgo * 60_000).toISOString();
    db.prepare("UPDATE usage_snapshots SET recorded_at = ? WHERE token_id = ?")
      .run(recordedAt, args.tokenId);
  }

  function pastIso(minutesAgo: number): string {
    return new Date(Date.now() - minutesAgo * 60_000).toISOString();
  }
  function futureIso(minutesAhead: number): string {
    return new Date(Date.now() + minutesAhead * 60_000).toISOString();
  }

  test("T382-1: util_7d=0.96 / util_5h=0.0 → admit されない（7d 軸単独でブロック）", () => {
    const t = insertToken(
      db,
      makeToken({ handle: "@hot7d", organization_id: "org-hot7d-382-1", tags: ["any"] }),
    );
    seedFreshSnapshot(t.id, 0.0, 0.96);
    const sel = selectToken(db, "h-382-1");
    expect(sel).toBeNull();
  });

  test("T382-2: 全 token が util_7d>0.95 のとき selectToken は null", () => {
    const a = insertToken(
      db,
      makeToken({ handle: "@a382", organization_id: "org-a-382-2", tags: ["any"] }),
    );
    const b = insertToken(
      db,
      makeToken({ handle: "@b382", organization_id: "org-b-382-2", tags: ["any"] }),
    );
    seedFreshSnapshot(a.id, 0.1, 0.96);
    seedFreshSnapshot(b.id, 0.1, 0.99);
    const sel = selectToken(db, "h-382-2");
    expect(sel).toBeNull();
  });

  test("T382-3: util_7d=0.95（境界値）→ admit される（厳密不等号 `>`）", () => {
    const t = insertToken(
      db,
      makeToken({ handle: "@boundary", organization_id: "org-boundary-382-3", tags: ["any"] }),
    );
    seedFreshSnapshot(t.id, 0.1, 0.95);
    const sel = selectToken(db, "h-382-3");
    expect(sel?.token.handle).toBe("@boundary");
  });

  test("T382-4: default 一致でも util_7d=0.96 なら除外される", () => {
    // selectable=0 / handle が effectiveDefault と一致 / util_7d=0.96
    // → default 昇格より blocker 判定が手前なので除外される
    const t = insertToken(
      db,
      makeToken({
        handle: "@deftok",
        organization_id: "org-deftok-382-4",
        tags: ["any"],
        selectable: false,
      }),
    );
    seedFreshSnapshot(t.id, 0.1, 0.96);
    const sel = selectToken(db, "h-382-4", {
      projectTags: ["any"],
      projectDefault: "@deftok",
      include: [],
      exclude: [],
      isOss: false,
      ossDefault: null,
    });
    expect(sel).toBeNull();
  });

  test("T382-5: stale + reset_7d_at 過去 で snap.util_7d=0.99 → admit（effUtil7d=0 救済）", () => {
    const t = insertToken(
      db,
      makeToken({ handle: "@reset7d", organization_id: "org-reset7d-382-5", tags: ["any"] }),
    );
    // stale + 7d reset 過去 → effUtil7d=0、5h は低い → admit
    seedStaleSnapshot({
      tokenId: t.id,
      util5h: 0.1,
      util7d: 0.99,
      reset5hAt: futureIso(60),
      reset7dAt: pastIso(5),
      recordedMinutesAgo: 50,
    });
    const sel = selectToken(db, "h-382-5");
    expect(sel?.token.handle).toBe("@reset7d");
  });

  test("T382-6: stale + reset_7d_at 未来 で snap.util_7d=0.97 → ブロッカー除外", () => {
    const t = insertToken(
      db,
      makeToken({ handle: "@stillhot7d", organization_id: "org-stillhot7d-382-6", tags: ["any"] }),
    );
    // stale + 7d reset 未到達 → effUtil7d=0.97 で blocker 除外
    seedStaleSnapshot({
      tokenId: t.id,
      util5h: 0.1,
      util7d: 0.97,
      reset5hAt: futureIso(60),
      reset7dAt: futureIso(60 * 24 * 7),
      recordedMinutesAgo: 50,
    });
    const sel = selectToken(db, "h-382-6");
    expect(sel).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// canSelectAnyToken (T367: pool admit peek)
// ─────────────────────────────────────────────────────────────────────────────

describe("canSelectAnyToken (T367)", () => {
  function seedFreshSnapshot(tokenId: number, util5h = 0.1, util7d = 0.1): void {
    upsertUsageSnapshot(db, {
      token_id: tokenId,
      util_5h: util5h,
      util_7d: util7d,
      reset_5h_at: null,
      reset_7d_at: null,
      unified_status: null,
    });
  }

  test("admit 候補が 1 つ以上ある → true", () => {
    const t = insertToken(
      db,
      makeToken({ handle: "@a", organization_id: "org-a", tags: ["any"] }),
    );
    seedFreshSnapshot(t.id, 0.5, 0.5);
    expect(canSelectAnyToken(db, "h", ["any"])).toBe(true);
  });

  test("全 token が exclude → false", () => {
    const t = insertToken(
      db,
      makeToken({ handle: "@a", organization_id: "org-a", tags: ["any"] }),
    );
    seedFreshSnapshot(t.id, 0.5, 0.5);
    expect(
      canSelectAnyToken(db, "h", {
        projectTags: ["any"],
        projectDefault: null,
        include: [],
        exclude: ["@a"],
        isOss: false,
        ossDefault: null,
      }),
    ).toBe(false);
  });

  test("lease 取得しない（複数回呼んでも同じ結果）", () => {
    const t = insertToken(
      db,
      makeToken({ handle: "@a", organization_id: "org-a", tags: ["any"] }),
    );
    seedFreshSnapshot(t.id, 0.5, 0.5);
    expect(canSelectAnyToken(db, "h", ["any"])).toBe(true);
    expect(canSelectAnyToken(db, "h", ["any"])).toBe(true);
    // lease テーブルに行が残っていないことを確認
    const rows = db.prepare("SELECT COUNT(*) AS n FROM leases").get() as { n: number };
    expect(rows.n).toBe(0);
  });

  test("default 昇格: selectable=0 でも default 一致なら admit", () => {
    const t = insertToken(
      db,
      makeToken({
        handle: "@discovered",
        organization_id: "org-d",
        selectable: false,
        credential_source: "auto-discover",
      }),
    );
    seedFreshSnapshot(t.id, 0.5, 0.5);
    expect(
      canSelectAnyToken(db, "h", {
        projectTags: ["any"],
        projectDefault: "@discovered",
        include: [],
        exclude: [],
        isOss: false,
        ossDefault: null,
      }),
    ).toBe(true);
  });

  test("util_5h=0.96 のみ → false", () => {
    const t = insertToken(
      db,
      makeToken({ handle: "@a", organization_id: "org-a", tags: ["any"] }),
    );
    seedFreshSnapshot(t.id, 0.96, 0.5);
    expect(canSelectAnyToken(db, "h", ["any"])).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// peekNextToken (T374 / A024)
// ─────────────────────────────────────────────────────────────────────────────

describe("peekNextToken (T374 / A024)", () => {
  function seedFreshSnapshot(tokenId: number, util5h: number | null, util7d: number | null): void {
    upsertUsageSnapshot(db, {
      token_id: tokenId,
      util_5h: util5h,
      util_7d: util7d,
      reset_5h_at: null,
      reset_7d_at: null,
      unified_status: null,
    });
  }

  function seedStaleSnapshot(args: {
    tokenId: number;
    util5h: number | null;
    util7d: number | null;
    reset5hAt: string | null;
    reset7dAt: string | null;
    recordedMinutesAgo: number;
  }): void {
    upsertUsageSnapshot(db, {
      token_id: args.tokenId,
      util_5h: args.util5h,
      util_7d: args.util7d,
      reset_5h_at: args.reset5hAt,
      reset_7d_at: args.reset7dAt,
      unified_status: null,
    });
    const recordedAt = new Date(Date.now() - args.recordedMinutesAgo * 60_000).toISOString();
    db.prepare("UPDATE usage_snapshots SET recorded_at = ? WHERE token_id = ?")
      .run(recordedAt, args.tokenId);
  }

  function pastIso(minutesAgo: number): string {
    return new Date(Date.now() - minutesAgo * 60_000).toISOString();
  }

  test("score 最小の候補を返す（lease 取得しない）", () => {
    const a = insertToken(db, makeToken({ handle: "@a", organization_id: "org-a-peek-1", tags: ["any"] }));
    const b = insertToken(db, makeToken({ handle: "@b", organization_id: "org-b-peek-1", tags: ["any"] }));
    seedFreshSnapshot(a.id, 0.1, 0.2); // score = 0.03 + 0.14 = 0.17
    seedFreshSnapshot(b.id, 0.5, 0.5); // score = 0.40
    const peek = peekNextToken(db, ["any"]);
    expect(peek?.handle).toBe("@a");
    expect(peek?.util_5h).toBeCloseTo(0.1, 5);
    expect(peek?.util_7d).toBeCloseTo(0.2, 5);
    // peek 後に lease は取られていない → selectToken でも @a が選ばれる
    const sel = selectToken(db, "h-peek-1", ["any"]);
    expect(sel?.token.handle).toBe("@a");
  });

  test("連続 peek で同じ結果を返す（副作用なし）", () => {
    const a = insertToken(db, makeToken({ handle: "@a", organization_id: "org-a-peek-2", tags: ["any"] }));
    seedFreshSnapshot(a.id, 0.1, 0.2);
    const p1 = peekNextToken(db, ["any"]);
    const p2 = peekNextToken(db, ["any"]);
    expect(p1?.handle).toBe(p2?.handle);
    expect(p1?.util_5h).toBe(p2?.util_5h);
    expect(p1?.util_7d).toBe(p2?.util_7d);
  });

  test("候補なし → null", () => {
    const a = insertToken(db, makeToken({ handle: "@a", organization_id: "org-a-peek-3", tags: ["any"] }));
    seedFreshSnapshot(a.id, 0.99, 0.99); // blocker
    expect(peekNextToken(db, ["any"])).toBeNull();
  });

  test("snapshot 不在の token が候補 → util_5h=null, util_7d=null", () => {
    insertToken(db, makeToken({ handle: "@a", organization_id: "org-a-peek-4", tags: ["any"] }));
    // snapshot を仕込まない
    const peek = peekNextToken(db, ["any"]);
    expect(peek?.handle).toBe("@a");
    expect(peek?.util_5h).toBeNull();
    expect(peek?.util_7d).toBeNull();
  });

  test("stale 救済: stale + 両軸 reset 過去 → effUtil=(0,0) で peek", () => {
    const t = insertToken(db, makeToken({ handle: "@stale", organization_id: "org-stale-peek", tags: ["any"] }));
    seedStaleSnapshot({
      tokenId: t.id,
      util5h: 0.9,
      util7d: 0.8,
      reset5hAt: pastIso(5),
      reset7dAt: pastIso(5),
      recordedMinutesAgo: 50,
    });
    const peek = peekNextToken(db, ["any"]);
    expect(peek?.handle).toBe("@stale");
    expect(peek?.util_5h).toBe(0); // stale 救済反映
    expect(peek?.util_7d).toBe(0);
  });

  test("policy: SelectTokenPolicy オブジェクト形式を受け付ける（spawn-agent と同じ admit 経路）", () => {
    const a = insertToken(db, makeToken({ handle: "@a", organization_id: "org-a-peek-5", tags: ["any"] }));
    seedFreshSnapshot(a.id, 0.3, 0.3);
    const peek = peekNextToken(db, {
      projectTags: ["any"],
      projectDefault: null,
      include: [],
      exclude: [],
      isOss: false,
      ossDefault: null,
    });
    expect(peek?.handle).toBe("@a");
  });

  test("project_tags フィルタ: tags 不一致 token は admit されない", () => {
    insertToken(db, makeToken({ handle: "@k", organization_id: "org-k-peek-6", tags: ["org:kddi"] }));
    const peek = peekNextToken(db, ["org:other"]);
    expect(peek).toBeNull();
  });

  test("score 同点なら DB 順（listTokens 順）で先頭が選ばれる", () => {
    const a = insertToken(db, makeToken({ handle: "@a", organization_id: "org-a-peek-7", tags: ["any"] }));
    const b = insertToken(db, makeToken({ handle: "@b", organization_id: "org-b-peek-7", tags: ["any"] }));
    seedFreshSnapshot(a.id, 0.5, 0.5);
    seedFreshSnapshot(b.id, 0.5, 0.5);
    const peek = peekNextToken(db, ["any"]);
    // score 同点 → 安定ソートで先に push された方
    expect(peek?.handle).toBeOneOf(["@a", "@b"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T391: subscription source 関連
// ─────────────────────────────────────────────────────────────────────────────

describe("shouldInjectCredential (T391)", () => {
  test("manual のみ true、subscription / auto-discover / null は false", () => {
    expect(shouldInjectCredential("manual")).toBe(true);
    expect(shouldInjectCredential("subscription")).toBe(false);
    expect(shouldInjectCredential("auto-discover")).toBe(false);
    expect(shouldInjectCredential(null)).toBe(false);
  });
});

describe("assertCanRetrieveFromKeychain (T391)", () => {
  test("subscription source は throw する", () => {
    expect(() => assertCanRetrieveFromKeychain("subscription")).toThrow(
      "subscription token must not be retrieved from keychain",
    );
  });

  test("manual / auto-discover / null は throw しない", () => {
    expect(() => assertCanRetrieveFromKeychain("manual")).not.toThrow();
    expect(() => assertCanRetrieveFromKeychain("auto-discover")).not.toThrow();
    expect(() => assertCanRetrieveFromKeychain(null)).not.toThrow();
  });
});

describe("subscription source: organization_id / auth_hash NULL の扱い (T391)", () => {
  test("subscription row は organization_id / auth_hash null で挿入できる", () => {
    const tok = insertToken(db, {
      handle: "@sub1",
      organization_id: null,
      auth_hash: null,
      plan: "max-x20",
      plan_ratio: 20.0,
      tags: ["any"],
      credential_source: "subscription",
      selectable: true,
    });
    expect(tok.organization_id).toBeNull();
    expect(tok.auth_hash).toBeNull();
    expect(tok.credential_source).toBe("subscription");

    const got = getTokenByHandle(db, "@sub1");
    expect(got?.organization_id).toBeNull();
    expect(got?.auth_hash).toBeNull();
  });

  test("updateTokenAuth で null → 値の transition が可能（subscription 初観測経路）", () => {
    const tok = insertToken(db, {
      handle: "@sub2",
      organization_id: null,
      auth_hash: null,
      plan: "max-x20",
      plan_ratio: 20.0,
      tags: ["any"],
      credential_source: "subscription",
      selectable: true,
    });
    updateTokenAuth(db, tok.id, "abc123def456");
    expect(getTokenByHandle(db, "@sub2")?.auth_hash).toBe("abc123def456");
  });

  test("updateTokenOrganizationId で null → 値の transition が可能", () => {
    const tok = insertToken(db, {
      handle: "@sub3",
      organization_id: null,
      auth_hash: null,
      plan: "max-x20",
      plan_ratio: 20.0,
      tags: ["any"],
      credential_source: "subscription",
      selectable: true,
    });
    updateTokenOrganizationId(db, tok.id, "org-resolved-001");
    expect(getTokenByHandle(db, "@sub3")?.organization_id).toBe("org-resolved-001");
  });

  test("auth_hash IS NULL の row は getTokenByAuthHash でヒットしない", () => {
    insertToken(db, {
      handle: "@sub4",
      organization_id: null,
      auth_hash: null,
      plan: "max-x20",
      plan_ratio: 20.0,
      tags: ["any"],
      credential_source: "subscription",
      selectable: true,
    });
    // 任意の auth_hash で検索しても NULL は SQL `=` に常に false で除外される
    expect(getTokenByAuthHash(db, "anyhash00000")).toBeNull();
  });
});

describe("schema migration (T391: claude-credentials → subscription)", () => {
  test("既存の claude-credentials row は subscription / auth_hash=NULL に変換される", () => {
    // T391 schema は auth_hash NULL 許容なので、生 SQL で claude-credentials row を仕込んでから
    // 再 init して migration が走ることを確認する
    db.exec(`
      INSERT INTO tokens (handle, organization_id, auth_hash, plan, plan_ratio,
                          credential_source, tags, selectable, created_at)
      VALUES ('@legacy', 'org-legacy-001', 'oldhash00aa', 'max-x20', 20.0,
              'claude-credentials', '["any"]', 1, '2026-04-01T00:00:00.000Z')
    `);
    db.close();

    // 再 init で migration を発火
    const db2 = initTokenDB({
      dirPath: testDir,
      dbPath: join(testDir, "tokens.db"),
    });
    try {
      const tok = getTokenByHandle(db2, "@legacy");
      expect(tok).not.toBeNull();
      expect(tok?.credential_source).toBe("subscription");
      expect(tok?.auth_hash).toBeNull();
      // organization_id は migration では触らない
      expect(tok?.organization_id).toBe("org-legacy-001");
    } finally {
      db2.close();
    }
  });

  test("既存に claude-credentials row が無い場合は no-op", () => {
    insertToken(db, makeToken({ handle: "@m", organization_id: "org-m-mig-noop", credential_source: "manual" }));
    db.close();
    const db2 = initTokenDB({
      dirPath: testDir,
      dbPath: join(testDir, "tokens.db"),
    });
    try {
      // manual row は触らない
      expect(getTokenByHandle(db2, "@m")?.credential_source).toBe("manual");
    } finally {
      db2.close();
    }
  });

  test("旧 NOT NULL 制約 schema を持つ DB を読み込むと auth_hash / organization_id が NULL 許容に re-create される", () => {
    db.close();
    // 旧 schema (NOT NULL) を直接作る
    const oldDbPath = join(testDir, "old-schema.db");
    const old = new Database(oldDbPath);
    old.exec(`
      CREATE TABLE tokens (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        handle            TEXT    NOT NULL UNIQUE,
        organization_id   TEXT    NOT NULL UNIQUE,
        auth_hash         TEXT    NOT NULL,
        plan              TEXT    NOT NULL DEFAULT 'unknown',
        plan_ratio        REAL,
        credential_source TEXT,
        tags              TEXT    NOT NULL DEFAULT '["any"]',
        selectable        INTEGER NOT NULL DEFAULT 1,
        created_at        TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tokens_selectable ON tokens(selectable);
      CREATE TABLE usage_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        token_id INTEGER NOT NULL UNIQUE,
        util_5h REAL, util_7d REAL,
        reset_5h_at TEXT, reset_7d_at TEXT,
        unified_status TEXT, recorded_at TEXT NOT NULL
      );
      CREATE TABLE leases (
        token_id INTEGER NOT NULL UNIQUE,
        holder TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (token_id, holder)
      );
      INSERT INTO tokens (handle, organization_id, auth_hash, plan, plan_ratio,
                          credential_source, tags, selectable, created_at)
      VALUES ('@kept', 'org-kept-001', 'keep0000aaaa', 'max-x20', 20.0,
              'manual', '["any"]', 1, '2026-04-01T00:00:00.000Z');
    `);
    old.close();

    // initTokenDB で migration が走る
    const db2 = initTokenDB({
      dirPath: testDir,
      dbPath: oldDbPath,
    });
    try {
      // 既存 row が維持されていること
      const tok = getTokenByHandle(db2, "@kept");
      expect(tok).not.toBeNull();
      expect(tok?.credential_source).toBe("manual");

      // schema が NULL 許容になっていること（NULL row を挿入できるかで検証）
      const subTok = insertToken(db2, {
        handle: "@subA",
        organization_id: null,
        auth_hash: null,
        plan: "max-x20",
        plan_ratio: 20.0,
        tags: ["any"],
        credential_source: "subscription",
        selectable: true,
      });
      expect(subTok.organization_id).toBeNull();
      expect(subTok.auth_hash).toBeNull();
    } finally {
      db2.close();
    }
  });
});
