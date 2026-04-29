/**
 * pool-throttle.test.ts (T367)
 *
 * `isThrottled5h` / `countPoolTokens` / `hasPoolHeadroomFromSummary` のユニットテスト。
 *
 * - DB は `mkdtempSync` + `initTokenDB({ dbPath })` で一時ディレクトリに隔離
 * - usage_snapshots を SQL UPDATE で操作して stale / fresh を作る
 *
 * テスト計画は plan.md §4.1 を参照。T1-T5 / B1-B6 / B5' / T8-T14 を網羅する。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import {
  initTokenDB,
  insertToken,
  upsertUsageSnapshot,
  acquireLease,
  type InsertTokenInput,
  type SelectTokenPolicy,
} from "./token-store";
import {
  isThrottled5h,
  countPoolTokens,
  hasPoolHeadroomFromSummary,
} from "./pool-throttle";
import type { PerHandleSummary } from "./pool-summary";
import type { RateLimitInfo } from "./schema";

const NOW_ISO = "2026-04-25T10:00:00.000Z";
const NOW_MS = new Date(NOW_ISO).getTime();

let testDir: string;
let db: Database;

function makeToken(partial: Partial<InsertTokenInput> & { handle: string; organization_id: string }): InsertTokenInput {
  return {
    handle: partial.handle,
    organization_id: partial.organization_id,
    auth_hash: partial.auth_hash ?? `hash-${partial.handle}`,
    plan: partial.plan ?? "max-x20",
    plan_ratio: "plan_ratio" in partial ? partial.plan_ratio ?? null : 20.0,
    tags: partial.tags ?? ["any"],
    credential_source: partial.credential_source ?? "manual",
    selectable: partial.selectable,
  };
}

function defaultPolicy(overrides: Partial<SelectTokenPolicy> = {}): SelectTokenPolicy {
  return {
    projectTags: ["any"],
    projectDefault: null,
    include: [],
    exclude: [],
    isOss: false,
    ossDefault: null,
    ...overrides,
  };
}

function seedSnapshot(
  tokenId: number,
  util5h: number | null,
  util7d: number | null,
  recordedAt: string = NOW_ISO,
): void {
  upsertUsageSnapshot(db, {
    token_id: tokenId,
    util_5h: util5h,
    util_7d: util7d,
    reset_5h_at: null,
    reset_7d_at: null,
    unified_status: null,
  });
  // upsertUsageSnapshot は recorded_at を Date.now() で上書きする。
  // テスト用に明示時刻が欲しいときは UPDATE で書き戻す。
  db.prepare("UPDATE usage_snapshots SET recorded_at = ? WHERE token_id = ?").run(recordedAt, tokenId);
}

function staleRecordedAt(): string {
  // 30 分閾値より古い：35 分前
  return new Date(NOW_MS - 35 * 60 * 1000).toISOString();
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "cmux-pool-throttle-"));
  db = initTokenDB({ dirPath: testDir, dbPath: join(testDir, "tokens.db") });
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // ignore
  }
  rmSync(testDir, { recursive: true, force: true });
});

const DEFAULT_OPTS = { running: true, bootReady: true } as const;

describe("isThrottled5h: pool 有効経路", () => {
  test("T1: selectable=2 件、両方 util_5h=0.5 → throttled=false", () => {
    const a = insertToken(db, makeToken({ handle: "@a", organization_id: "org-a" }));
    const b = insertToken(db, makeToken({ handle: "@b", organization_id: "org-b" }));
    seedSnapshot(a.id, 0.5, 0.5);
    seedSnapshot(b.id, 0.5, 0.5);
    const result = isThrottled5h(db, null, { ...DEFAULT_OPTS, policy: defaultPolicy() }, NOW_ISO);
    expect(result).toBe(false);
  });

  test("T2: selectable=2 件、片方 0.5 / 片方 0.96 → throttled=false", () => {
    const a = insertToken(db, makeToken({ handle: "@a", organization_id: "org-a" }));
    const b = insertToken(db, makeToken({ handle: "@b", organization_id: "org-b" }));
    seedSnapshot(a.id, 0.5, 0.5);
    seedSnapshot(b.id, 0.96, 0.5);
    const result = isThrottled5h(db, null, { ...DEFAULT_OPTS, policy: defaultPolicy() }, NOW_ISO);
    expect(result).toBe(false);
  });

  test("T3: selectable=2 件、両方 util_5h=0.96 → throttled=true", () => {
    const a = insertToken(db, makeToken({ handle: "@a", organization_id: "org-a" }));
    const b = insertToken(db, makeToken({ handle: "@b", organization_id: "org-b" }));
    seedSnapshot(a.id, 0.96, 0.5);
    seedSnapshot(b.id, 0.96, 0.5);
    const result = isThrottled5h(db, null, { ...DEFAULT_OPTS, policy: defaultPolicy() }, NOW_ISO);
    expect(result).toBe(true);
  });

  test("T4 (T373: 旧 true → false 転換): 両方 stale (35 分前) + reset 情報なし → throttled=false (snap 値で admit)", () => {
    // T373 で挙動変更: stale 救済により reset 情報が無くても snap 値（低 util）が下限となり admit される。
    const a = insertToken(db, makeToken({ handle: "@a", organization_id: "org-a" }));
    const b = insertToken(db, makeToken({ handle: "@b", organization_id: "org-b" }));
    seedSnapshot(a.id, 0.1, 0.1, staleRecordedAt());
    seedSnapshot(b.id, 0.1, 0.1, staleRecordedAt());
    const result = isThrottled5h(db, null, { ...DEFAULT_OPTS, policy: defaultPolicy() }, NOW_ISO);
    expect(result).toBe(false);
  });

  test("T4-blocker (T373): 両方 stale + util_5h>0.95 → throttled=true (ブロッカー除外で残らない)", () => {
    // T373: stale でも snap.util_5h が blocker 閾値 (0.95) 超なら除外される。
    const a = insertToken(db, makeToken({ handle: "@a", organization_id: "org-a" }));
    const b = insertToken(db, makeToken({ handle: "@b", organization_id: "org-b" }));
    seedSnapshot(a.id, 0.97, 0.5, staleRecordedAt());
    seedSnapshot(b.id, 0.97, 0.5, staleRecordedAt());
    const result = isThrottled5h(db, null, { ...DEFAULT_OPTS, policy: defaultPolicy() }, NOW_ISO);
    expect(result).toBe(true);
  });

  test("T5: selectable=1 件 (snapshot なし) → throttled=false (未使用 = admit)", () => {
    insertToken(db, makeToken({ handle: "@a", organization_id: "org-a" }));
    const result = isThrottled5h(db, null, { ...DEFAULT_OPTS, policy: defaultPolicy() }, NOW_ISO);
    expect(result).toBe(false);
  });

  test("B1: selectable=0 の唯一 token が effectiveDefault と一致 + util=0.5 → throttled=false (default 昇格)", () => {
    const a = insertToken(
      db,
      makeToken({ handle: "@discovered", organization_id: "org-d", selectable: false }),
    );
    seedSnapshot(a.id, 0.5, 0.5);
    const result = isThrottled5h(
      db,
      null,
      {
        ...DEFAULT_OPTS,
        policy: defaultPolicy({ projectDefault: "@discovered" }),
      },
      NOW_ISO,
    );
    expect(result).toBe(false);
  });

  test("B2: 唯一の selectable token が policy.exclude で外れる + util=0.5 → throttled=true", () => {
    const a = insertToken(db, makeToken({ handle: "@a", organization_id: "org-a" }));
    seedSnapshot(a.id, 0.5, 0.5);
    const result = isThrottled5h(
      db,
      null,
      {
        ...DEFAULT_OPTS,
        policy: defaultPolicy({ exclude: ["@a"] }),
      },
      NOW_ISO,
    );
    expect(result).toBe(true);
  });

  test("B3: 唯一の selectable token が lease 中 → throttled=true", () => {
    const a = insertToken(db, makeToken({ handle: "@a", organization_id: "org-a" }));
    seedSnapshot(a.id, 0.5, 0.5);
    // 120 秒 lease を別ホルダーが取る
    const lease = acquireLease(db, a.id, "other-holder", 120);
    expect(lease).not.toBeNull();
    const result = isThrottled5h(db, null, { ...DEFAULT_OPTS, policy: defaultPolicy() }, NOW_ISO);
    expect(result).toBe(true);
  });

  test("B4: 唯一の selectable token が util_5h=0.92 → throttled=false (90% は OK / 95% で初めて NG)", () => {
    const a = insertToken(db, makeToken({ handle: "@a", organization_id: "org-a" }));
    seedSnapshot(a.id, 0.92, 0.5);
    const result = isThrottled5h(db, null, { ...DEFAULT_OPTS, policy: defaultPolicy() }, NOW_ISO);
    expect(result).toBe(false);
  });

  test("B5: pool 有効 + bootReady=false → throttled=false (boot ガード)", () => {
    const a = insertToken(db, makeToken({ handle: "@a", organization_id: "org-a" }));
    seedSnapshot(a.id, 0.96, 0.5); // pool 全枯渇でも boot ガードで素通り
    const result = isThrottled5h(db, null, { running: true, bootReady: false, policy: defaultPolicy() }, NOW_ISO);
    expect(result).toBe(false);
  });

  test("B5': pool 有効 + running=false → throttled=false", () => {
    const a = insertToken(db, makeToken({ handle: "@a", organization_id: "org-a" }));
    seedSnapshot(a.id, 0.96, 0.5);
    const result = isThrottled5h(db, null, { running: false, bootReady: true, policy: defaultPolicy() }, NOW_ISO);
    expect(result).toBe(false);
  });

  test("T382-T1: 全 token util_5h=0.5 / util_7d=0.96 → throttled=true (7d blocker)", () => {
    const a = insertToken(db, makeToken({ handle: "@a", organization_id: "org-a" }));
    const b = insertToken(db, makeToken({ handle: "@b", organization_id: "org-b" }));
    seedSnapshot(a.id, 0.5, 0.96);
    seedSnapshot(b.id, 0.5, 0.96);
    const result = isThrottled5h(db, null, { ...DEFAULT_OPTS, policy: defaultPolicy() }, NOW_ISO);
    expect(result).toBe(true);
  });

  test("T382-T2: 1 件 5h=0.5/7d=0.5、1 件 5h=0.5/7d=0.96 → throttled=false (片方残れば false)", () => {
    const a = insertToken(db, makeToken({ handle: "@a", organization_id: "org-a" }));
    const b = insertToken(db, makeToken({ handle: "@b", organization_id: "org-b" }));
    seedSnapshot(a.id, 0.5, 0.5);
    seedSnapshot(b.id, 0.5, 0.96);
    const result = isThrottled5h(db, null, { ...DEFAULT_OPTS, policy: defaultPolicy() }, NOW_ISO);
    expect(result).toBe(false);
  });
});

describe("isThrottled5h: pool 無効経路 (db=null)", () => {
  function makeRl(util: number | null, resetIso: string | null = "2030-01-01T00:00:00Z"): RateLimitInfo {
    return {
      tokensRemaining: 0,
      tokensLimit: 0,
      tokensReset: NOW_ISO,
      inputTokensRemaining: 0,
      outputTokensRemaining: 0,
      unified5hUtilization: util,
      unified7dUtilization: null,
      unified5hReset: resetIso,
      unified7dReset: null,
      unifiedStatus: null,
      updatedAt: NOW_ISO,
    };
  }

  test("T8: db=null + unified5hUtilization=0.95 → throttled=true", () => {
    const result = isThrottled5h(null, makeRl(0.95), DEFAULT_OPTS, NOW_ISO);
    expect(result).toBe(true);
  });

  test("T9: db=null + unified5hUtilization=0.5 → throttled=false", () => {
    const result = isThrottled5h(null, makeRl(0.5), DEFAULT_OPTS, NOW_ISO);
    expect(result).toBe(false);
  });

  test("T10: db=null + stale rateLimit (reset 過去) → throttled=false (既存 stale ガード保持)", () => {
    const result = isThrottled5h(null, makeRl(0.99, "2000-01-01T00:00:00Z"), DEFAULT_OPTS, NOW_ISO);
    expect(result).toBe(false);
  });

  test("T11: db=null + rateLimit=null → throttled=false", () => {
    const result = isThrottled5h(null, null, DEFAULT_OPTS, NOW_ISO);
    expect(result).toBe(false);
  });

  test("pool 無効経路でも boot ガードが効く", () => {
    const result = isThrottled5h(null, makeRl(0.99), { running: true, bootReady: false }, NOW_ISO);
    expect(result).toBe(false);
  });
});

describe("countPoolTokens", () => {
  test("T12 (T373: stale も snap 値で admit): 3 件 (0.5 / 0.96 / stale 0.1) → available:2, stale:1", () => {
    // T373 で挙動変更: stale token (util=0.1) も snap 値で blocker 通らず admit されるため
    // available は 2 (a の 0.5 と c の 0.1)。stale=1 は変わらず。
    const a = insertToken(db, makeToken({ handle: "@a", organization_id: "org-a" }));
    const b = insertToken(db, makeToken({ handle: "@b", organization_id: "org-b" }));
    const c = insertToken(db, makeToken({ handle: "@c", organization_id: "org-c" }));
    seedSnapshot(a.id, 0.5, 0.5);
    seedSnapshot(b.id, 0.96, 0.5);
    seedSnapshot(c.id, 0.1, 0.1, staleRecordedAt());

    const r = countPoolTokens(db, defaultPolicy(), NOW_ISO);
    expect(r.enabled).toBe(true);
    expect(r.total).toBe(3);
    expect(r.selectable).toBe(3);
    expect(r.available).toBe(2);
    expect(r.stale).toBe(1);
  });

  test("default 昇格込みの total と selectable を別々に返す", () => {
    insertToken(db, makeToken({ handle: "@d", organization_id: "org-d", selectable: false }));
    const e = insertToken(db, makeToken({ handle: "@e", organization_id: "org-e" }));
    seedSnapshot(e.id, 0.5, 0.5);

    const r = countPoolTokens(db, defaultPolicy(), NOW_ISO);
    expect(r.total).toBe(2);
    expect(r.selectable).toBe(1);
  });

  test("T382-C1: 3 件 (5h=0.5/7d=0.5, 5h=0.5/7d=0.96, 5h=0.96/7d=0.5) → available=1", () => {
    const a = insertToken(db, makeToken({ handle: "@a", organization_id: "org-a" }));
    const b = insertToken(db, makeToken({ handle: "@b", organization_id: "org-b" }));
    const c = insertToken(db, makeToken({ handle: "@c", organization_id: "org-c" }));
    seedSnapshot(a.id, 0.5, 0.5);
    seedSnapshot(b.id, 0.5, 0.96);
    seedSnapshot(c.id, 0.96, 0.5);

    const r = countPoolTokens(db, defaultPolicy(), NOW_ISO);
    expect(r.total).toBe(3);
    expect(r.selectable).toBe(3);
    expect(r.available).toBe(1);
  });

  test("T382-C2: stale + reset_7d_at 過去 + util_7d=0.99 → available にカウントされる（7d 救済）", () => {
    const a = insertToken(db, makeToken({ handle: "@a", organization_id: "org-a" }));
    // stale snapshot: util_7d=0.99 だが reset_7d_at=過去 → effUtil7d=0 で admit
    const past = new Date(NOW_MS - 5 * 60 * 1000).toISOString();
    const future = new Date(NOW_MS + 60 * 60 * 1000).toISOString();
    upsertUsageSnapshot(db, {
      token_id: a.id,
      util_5h: 0.1,
      util_7d: 0.99,
      reset_5h_at: future,
      reset_7d_at: past,
      unified_status: null,
    });
    db.prepare("UPDATE usage_snapshots SET recorded_at = ? WHERE token_id = ?")
      .run(staleRecordedAt(), a.id);

    const r = countPoolTokens(db, defaultPolicy(), NOW_ISO);
    expect(r.total).toBe(1);
    expect(r.available).toBe(1);
    expect(r.stale).toBe(1);
  });
});

describe("hasPoolHeadroomFromSummary", () => {
  function ph(partial: Partial<PerHandleSummary>): PerHandleSummary {
    return {
      util5h: partial.util5h ?? null,
      util7d: partial.util7d ?? null,
      capPct: partial.capPct ?? null,
      selectable: partial.selectable ?? true,
    };
  }

  test("T13: selectable=true && util5h=0.5 が 1 件 → true", () => {
    expect(hasPoolHeadroomFromSummary([ph({ util5h: 0.5, selectable: true })])).toBe(true);
  });

  test("T14: 全件 selectable=false → false", () => {
    expect(
      hasPoolHeadroomFromSummary([
        ph({ util5h: 0.1, selectable: false }),
        ph({ util5h: null, selectable: false }),
      ]),
    ).toBe(false);
  });

  test("util5h=null は未使用扱いで headroom あり", () => {
    expect(hasPoolHeadroomFromSummary([ph({ util5h: null, selectable: true })])).toBe(true);
  });

  test("util5h=0.96 は headroom なし", () => {
    expect(hasPoolHeadroomFromSummary([ph({ util5h: 0.96, selectable: true })])).toBe(false);
  });

  test("複数 token: 1 つでも < 0.95 で headroom あり", () => {
    expect(
      hasPoolHeadroomFromSummary([
        ph({ util5h: 0.96, selectable: true }),
        ph({ util5h: 0.5, selectable: true }),
      ]),
    ).toBe(true);
  });

  test("空配列 → false", () => {
    expect(hasPoolHeadroomFromSummary([])).toBe(false);
  });

  test("T382-H1: util5h=0.1 / util7d=0.96 → false (7d blocked を正しく拾う)", () => {
    expect(
      hasPoolHeadroomFromSummary([ph({ util5h: 0.1, util7d: 0.96, selectable: true })]),
    ).toBe(false);
  });

  test("T382-H2: util5h=0.1 / util7d=null → true (util7d 不明時は 5h で判定)", () => {
    expect(
      hasPoolHeadroomFromSummary([ph({ util5h: 0.1, util7d: null, selectable: true })]),
    ).toBe(true);
  });
});
