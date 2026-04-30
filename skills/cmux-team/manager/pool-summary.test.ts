/**
 * pool-summary.test.ts (T351 / T366)
 *
 * `buildPoolSummary` / `loadPoolSummary` の純関数テスト。
 *
 * T366: capacity を 5h / 7d 別合計に変更したため、各 case で
 *       `capacity_5h_pct` / `capacity_7d_pct` の両方を assert する。
 *
 * - case A: 単一 token, util_5h=util_7d=0.5, plan_ratio=20
 *   - flow_5h = 0.5 × 20 / 5 = 2.0   → cap_5h ≒ 1680%
 *   - flow_7d = 0.5 × 20 / 168 ≒ 0.0595 → cap_7d ≒ 50%
 *   - per_token cap (min ベース) ≒ 50%
 * - case B: 2 token を case A と同条件で合算
 *   - cap_5h ≒ 3360% / cap_7d ≒ 100%
 * - case C: 全 token plan_ratio=null → cap_5h_pct=0, cap_7d_pct=0、perHandle は全 token (capPct=null)
 * - case D: selectable=0 を含む fixture で nextReset の入力対象として selectable=0 が残ること
 *           （現行 main.ts:1444-1483 の in-line 実装と等価。`computeNextReset` は内部で
 *           `selectable && plan_ratio != null` でフィルタするため、selectable=0 は実質除外される）
 * - case E: perHandle のキー集合が listTokens 全 handle と一致（plan_ratio の有無に関わらず全 token を含む。
 *           現行 main.ts:1444-1483 の in-line 実装と等価）
 * - case F: loadPoolSummary は pool 機能 OFF プロジェクトで null
 *
 * 上記 case C/D/E は plan revision 2 §5 の主張「現行 main.ts:1444-1483 の in-line 実装と等価」を
 * test レベルで保障する（minor 3 反映）。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import {
  initTokenDB,
  insertToken,
  upsertUsageSnapshot,
  listTokens,
  type InsertTokenInput,
} from "./token-store";
import { buildPoolSummary, loadPoolSummary } from "./pool-summary";
import type { SelectTokenPolicy } from "./token-store";

const ANY_POLICY: SelectTokenPolicy = {
  projectTags: ["any"],
  projectDefault: null,
  include: [],
  exclude: [],
  isOss: false,
  ossDefault: null,
};

const NOW_ISO = "2026-04-25T10:00:00.000Z";
const NOW_MS = new Date(NOW_ISO).getTime();
const isoIn = (ms: number) => new Date(NOW_MS + ms).toISOString();

let testDir: string;
let db: Database;

function makeToken(partial: Partial<InsertTokenInput> & { handle: string; organization_id: string }): InsertTokenInput {
  return {
    handle: partial.handle,
    organization_id: partial.organization_id,
    auth_hash: partial.auth_hash ?? `hash-${partial.handle}`,
    plan: partial.plan ?? "max-x20",
    // null を default で上書きしないように "plan_ratio" in partial で分岐
    plan_ratio: "plan_ratio" in partial ? partial.plan_ratio ?? null : 20.0,
    tags: partial.tags ?? ["any"],
    credential_source: partial.credential_source ?? "manual",
  };
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "cmux-pool-summary-"));
  db = initTokenDB({
    dirPath: testDir,
    dbPath: join(testDir, "tokens.db"),
  });
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // ignore
  }
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("buildPoolSummary", () => {
  test("case A: 単一 token util_5h=util_7d=0.5 → perHandle.capPct ≒ 50%、forecast7d は寄与 1 token", () => {
    // T374: 旧 header.capacity_*_pct は撤去。per_token cap (min ベース) は perHandle.capPct に残る
    const t = insertToken(db, makeToken({
      handle: "@kddi",
      organization_id: "00000000-0000-0000-0000-000000000001",
    }));
    upsertUsageSnapshot(db, {
      token_id: t.id,
      util_5h: 0.5,
      util_7d: 0.5,
      reset_5h_at: isoIn(5 * 3600 * 1000),
      reset_7d_at: isoIn(168 * 3600 * 1000),
      unified_status: null,
    });

    const summary = buildPoolSummary(db, NOW_ISO);
    const perHandle = summary.perHandle.get("@kddi");
    expect(perHandle).toBeDefined();
    expect(perHandle?.util5h).toBe(0.5);
    expect(perHandle?.util7d).toBe(0.5);
    expect(perHandle?.capPct).toBeGreaterThan(49.9);
    expect(perHandle?.capPct).toBeLessThan(50.1);
    // forecast7d: 単一 selectable + plan_ratio + util_7d + reset_7d_at が non-null → contributingTokens=1
    expect(summary.forecast7d.contributingTokens).toBe(1);
    expect(summary.forecast7d.bars).toHaveLength(7);
  });

  test("case B: 2 token を case A と同条件 → perHandle.size=2、forecast7d 寄与 2", () => {
    const t1 = insertToken(db, makeToken({
      handle: "@kddi",
      organization_id: "00000000-0000-0000-0000-000000000001",
    }));
    const t2 = insertToken(db, makeToken({
      handle: "@tayo",
      organization_id: "00000000-0000-0000-0000-000000000002",
    }));
    for (const t of [t1, t2]) {
      upsertUsageSnapshot(db, {
        token_id: t.id,
        util_5h: 0.5,
        util_7d: 0.5,
        reset_5h_at: isoIn(5 * 3600 * 1000),
        reset_7d_at: isoIn(168 * 3600 * 1000),
        unified_status: null,
      });
    }

    const summary = buildPoolSummary(db, NOW_ISO);
    expect(summary.perHandle.size).toBe(2);
    expect(summary.perHandle.get("@kddi")?.capPct).toBeGreaterThan(49.9);
    expect(summary.perHandle.get("@tayo")?.capPct).toBeGreaterThan(49.9);
    expect(summary.forecast7d.contributingTokens).toBe(2);
  });

  test("case C: 全 token plan_ratio=null → forecast contributing=0、perHandle 全 token (capPct=null)", () => {
    const t1 = insertToken(db, makeToken({
      handle: "@a",
      organization_id: "00000000-0000-0000-0000-000000000001",
      plan: "unknown",
      plan_ratio: null,
    }));
    const t2 = insertToken(db, makeToken({
      handle: "@b",
      organization_id: "00000000-0000-0000-0000-000000000002",
      plan: "unknown",
      plan_ratio: null,
    }));
    for (const t of [t1, t2]) {
      upsertUsageSnapshot(db, {
        token_id: t.id,
        util_5h: 0.1,
        util_7d: 0.2,
        reset_5h_at: isoIn(5 * 3600 * 1000),
        reset_7d_at: isoIn(168 * 3600 * 1000),
        unified_status: null,
      });
    }

    const summary = buildPoolSummary(db, NOW_ISO);
    expect(summary.forecast7d.contributingTokens).toBe(0);
    expect(summary.forecast7d.bars).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(summary.perHandle.size).toBe(2);
    expect(summary.perHandle.get("@a")?.capPct).toBeNull();
    expect(summary.perHandle.get("@b")?.capPct).toBeNull();
    expect(summary.perHandle.get("@a")?.util5h).toBe(0.1);
    expect(summary.perHandle.get("@b")?.util7d).toBe(0.2);
  });

  test("case D: selectable=0 の token は forecast に寄与しないが perHandle には残る (T374)", () => {
    // 旧仕様: nextReset の入力対象として selectable=0 が残るが capacity 計算には影響しない
    // 新仕様 (T374): forecast は A024 §エッジケース「selectable=false は denom にも入れない」に従う
    const t1 = insertToken(db, makeToken({
      handle: "@active",
      organization_id: "00000000-0000-0000-0000-000000000001",
    }));
    const t2 = insertToken(db, makeToken({
      handle: "@frozen",
      organization_id: "00000000-0000-0000-0000-000000000002",
    }));
    db.prepare("UPDATE tokens SET selectable = 0 WHERE id = ?").run(t2.id);
    for (const t of [t1, t2]) {
      upsertUsageSnapshot(db, {
        token_id: t.id,
        util_5h: 0.5,
        util_7d: 0.5,
        reset_5h_at: isoIn(5 * 3600 * 1000),
        reset_7d_at: isoIn(168 * 3600 * 1000),
        unified_status: null,
      });
    }

    const summary = buildPoolSummary(db, NOW_ISO);
    // forecast: @active のみ寄与
    expect(summary.forecast7d.contributingTokens).toBe(1);
    // perHandle にも両方含まれる（listTokens 全 handle）
    expect(summary.perHandle.size).toBe(2);
    expect(summary.perHandle.get("@active")).toBeDefined();
    expect(summary.perHandle.get("@frozen")).toBeDefined();
    // T367: perHandle.selectable が listTokens の selectable と一致する
    expect(summary.perHandle.get("@active")?.selectable).toBe(true);
    expect(summary.perHandle.get("@frozen")?.selectable).toBe(false);
  });

  test("case E: perHandle のキー集合 = listTokens 全 handle 集合", () => {
    // 現行 main.ts:1444-1483 の in-line 実装と等価:
    //   poolHandleData = new Map(); for (const t of tokens) { poolHandleData.set(t.handle, ...) }
    const t1 = insertToken(db, makeToken({
      handle: "@x",
      organization_id: "00000000-0000-0000-0000-000000000001",
      plan_ratio: 20,
    }));
    const t2 = insertToken(db, makeToken({
      handle: "@y",
      organization_id: "00000000-0000-0000-0000-000000000002",
      plan: "unknown",
      plan_ratio: null,
    }));
    const t3 = insertToken(db, makeToken({
      handle: "@z",
      organization_id: "00000000-0000-0000-0000-000000000003",
      plan_ratio: 5,
    }));
    for (const t of [t1, t2, t3]) {
      upsertUsageSnapshot(db, {
        token_id: t.id,
        util_5h: 0.1,
        util_7d: 0.1,
        reset_5h_at: isoIn(5 * 3600 * 1000),
        reset_7d_at: isoIn(168 * 3600 * 1000),
        unified_status: null,
      });
    }

    const summary = buildPoolSummary(db, NOW_ISO);
    const summaryHandles = [...summary.perHandle.keys()].sort();
    const tokenHandles = listTokens(db).map((t) => t.handle).sort();
    expect(summaryHandles).toEqual(tokenHandles);
    // plan_ratio=null の @y は capPct=null
    expect(summary.perHandle.get("@y")?.capPct).toBeNull();
    // plan_ratio あり token は capPct が non-null
    expect(summary.perHandle.get("@x")?.capPct).not.toBeNull();
    expect(summary.perHandle.get("@z")?.capPct).not.toBeNull();
  });

  test("case: usage snapshot がない token は util/cap が null だが perHandle には含まれる", () => {
    insertToken(db, makeToken({
      handle: "@orphan",
      organization_id: "00000000-0000-0000-0000-000000000001",
    }));

    const summary = buildPoolSummary(db, NOW_ISO);
    expect(summary.perHandle.size).toBe(1);
    expect(summary.perHandle.get("@orphan")?.util5h).toBeNull();
    expect(summary.perHandle.get("@orphan")?.util7d).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // T374: forecast7d / nextCandidate
  // ─────────────────────────────────────────────────────────────────────────────

  test("T374: forecast7d.bars.length === 7 かつ contributingTokens が一致する", () => {
    const t1 = insertToken(db, makeToken({
      handle: "@a",
      organization_id: "00000000-0000-0000-0000-000000000001",
    }));
    const t2 = insertToken(db, makeToken({
      handle: "@b",
      organization_id: "00000000-0000-0000-0000-000000000002",
    }));
    for (const t of [t1, t2]) {
      upsertUsageSnapshot(db, {
        token_id: t.id,
        util_5h: 0.3,
        util_7d: 0.5,
        reset_5h_at: isoIn(5 * 3600 * 1000),
        reset_7d_at: isoIn(168 * 3600 * 1000),
        unified_status: null,
      });
    }
    const summary = buildPoolSummary(db, NOW_ISO);
    expect(summary.forecast7d.bars).toHaveLength(7);
    expect(summary.forecast7d.contributingTokens).toBe(2);
    expect(summary.forecast7d.bars.every((b) => Number.isFinite(b))).toBe(true);
  });

  test("T374: util_7d/reset_7d_at が null の token は forecast 寄与なし", () => {
    insertToken(db, makeToken({
      handle: "@orphan",
      organization_id: "00000000-0000-0000-0000-000000000001",
    }));
    const summary = buildPoolSummary(db, NOW_ISO);
    expect(summary.forecast7d.contributingTokens).toBe(0);
    expect(summary.forecast7d.bars).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  test("T374: policy が null（default）なら nextCandidate=null", () => {
    const t = insertToken(db, makeToken({
      handle: "@a",
      organization_id: "00000000-0000-0000-0000-000000000001",
    }));
    upsertUsageSnapshot(db, {
      token_id: t.id,
      util_5h: 0.1,
      util_7d: 0.2,
      reset_5h_at: isoIn(5 * 3600 * 1000),
      reset_7d_at: isoIn(168 * 3600 * 1000),
      unified_status: null,
    });
    const summary = buildPoolSummary(db, NOW_ISO);
    expect(summary.nextCandidate).toBeNull();
  });

  test("T374: policy 渡し → nextCandidate が peek 結果と一致", () => {
    const a = insertToken(db, makeToken({
      handle: "@a",
      organization_id: "00000000-0000-0000-0000-000000000001",
    }));
    const b = insertToken(db, makeToken({
      handle: "@b",
      organization_id: "00000000-0000-0000-0000-000000000002",
    }));
    upsertUsageSnapshot(db, {
      token_id: a.id,
      util_5h: 0.1,
      util_7d: 0.2,
      reset_5h_at: isoIn(5 * 3600 * 1000),
      reset_7d_at: isoIn(168 * 3600 * 1000),
      unified_status: null,
    });
    upsertUsageSnapshot(db, {
      token_id: b.id,
      util_5h: 0.5,
      util_7d: 0.5,
      reset_5h_at: isoIn(5 * 3600 * 1000),
      reset_7d_at: isoIn(168 * 3600 * 1000),
      unified_status: null,
    });
    const summary = buildPoolSummary(db, NOW_ISO, ANY_POLICY);
    expect(summary.nextCandidate?.handle).toBe("@a");
    expect(summary.nextCandidate?.util_5h).toBeCloseTo(0.1, 5);
    expect(summary.nextCandidate?.util_7d).toBeCloseTo(0.2, 5);
  });

  test("T374: 全 blocker → nextCandidate=null", () => {
    const t = insertToken(db, makeToken({
      handle: "@a",
      organization_id: "00000000-0000-0000-0000-000000000001",
    }));
    upsertUsageSnapshot(db, {
      token_id: t.id,
      util_5h: 0.99,
      util_7d: 0.99,
      reset_5h_at: isoIn(5 * 3600 * 1000),
      reset_7d_at: isoIn(168 * 3600 * 1000),
      unified_status: null,
    });
    const summary = buildPoolSummary(db, NOW_ISO, ANY_POLICY);
    expect(summary.nextCandidate).toBeNull();
  });
});

describe("loadPoolSummary (CLI 用 wrapper)", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "cmux-pool-summary-proj-"));
  });

  afterEach(() => {
    try {
      rmSync(projectRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test("case F: pool 機能 OFF プロジェクトで null を返す", async () => {
    // .team/config.json で tokenPool.enabled=false を明示し、global / env の影響を排除
    mkdirSync(join(projectRoot, ".team"), { recursive: true });
    writeFileSync(
      join(projectRoot, ".team/config.json"),
      JSON.stringify({ tokenPool: { enabled: false } }),
    );
    // env で OFF を強制（global config の干渉を防ぐ）
    const prev = process.env.CMUX_TEAM_TOKEN_POOL;
    process.env.CMUX_TEAM_TOKEN_POOL = "0";
    try {
      const r = await loadPoolSummary(projectRoot, NOW_ISO);
      expect(r).toBeNull();
    } finally {
      if (prev === undefined) {
        delete process.env.CMUX_TEAM_TOKEN_POOL;
      } else {
        process.env.CMUX_TEAM_TOKEN_POOL = prev;
      }
    }
  });

  // T356: loadPoolSummary 失敗時の CLI ログ復元
  // case G/H は実 DB 経路で破損を再現する（D5 / mock 禁止）。tokens.db を非 SQLite
  // ゴミバイトで上書きし、TOKEN_STORE_DB_PATH でその path を指す → initTokenDB → query
  // 段階で SQLite が throw する。SQLite open は遅延評価なので exec が走った時点で fail。
  test("case G: tokens.db 破損 → onError が呼ばれて null を返す", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "cmux-pool-corrupted-"));
    const dbPath = join(dbDir, "tokens.db");
    // 非 SQLite なゴミバイトで上書き（実 DB 経路で reproducible に throw させる）
    writeFileSync(dbPath, "not a sqlite file" + "\x00".repeat(100));

    const prevPool = process.env.CMUX_TEAM_TOKEN_POOL;
    const prevDb = process.env.TOKEN_STORE_DB_PATH;
    process.env.CMUX_TEAM_TOKEN_POOL = "1"; // gate 強制 ON
    process.env.TOKEN_STORE_DB_PATH = dbPath;
    try {
      const captured: Error[] = [];
      const r = await loadPoolSummary(projectRoot, NOW_ISO, {
        onError: (e) => captured.push(e),
      });
      expect(r).toBeNull();
      expect(captured).toHaveLength(1);
      expect(captured[0]).toBeInstanceOf(Error);
    } finally {
      if (prevPool === undefined) delete process.env.CMUX_TEAM_TOKEN_POOL;
      else process.env.CMUX_TEAM_TOKEN_POOL = prevPool;
      if (prevDb === undefined) delete process.env.TOKEN_STORE_DB_PATH;
      else process.env.TOKEN_STORE_DB_PATH = prevDb;
      try {
        rmSync(dbDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  test("case H: onError 未指定でも throw せず null を返す（後方互換）", async () => {
    const dbDir = mkdtempSync(join(tmpdir(), "cmux-pool-corrupted-"));
    const dbPath = join(dbDir, "tokens.db");
    writeFileSync(dbPath, "not a sqlite file" + "\x00".repeat(100));

    const prevPool = process.env.CMUX_TEAM_TOKEN_POOL;
    const prevDb = process.env.TOKEN_STORE_DB_PATH;
    process.env.CMUX_TEAM_TOKEN_POOL = "1";
    process.env.TOKEN_STORE_DB_PATH = dbPath;
    try {
      const r = await loadPoolSummary(projectRoot, NOW_ISO);
      expect(r).toBeNull();
    } finally {
      if (prevPool === undefined) delete process.env.CMUX_TEAM_TOKEN_POOL;
      else process.env.CMUX_TEAM_TOKEN_POOL = prevPool;
      if (prevDb === undefined) delete process.env.TOKEN_STORE_DB_PATH;
      else process.env.TOKEN_STORE_DB_PATH = prevDb;
      try {
        rmSync(dbDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  test("case I: gate OFF では onError を呼ばない（gate と build の挙動分離保証）", async () => {
    mkdirSync(join(projectRoot, ".team"), { recursive: true });
    writeFileSync(
      join(projectRoot, ".team/config.json"),
      JSON.stringify({ tokenPool: { enabled: false } }),
    );
    const prev = process.env.CMUX_TEAM_TOKEN_POOL;
    process.env.CMUX_TEAM_TOKEN_POOL = "0";
    try {
      const captured: Error[] = [];
      const r = await loadPoolSummary(projectRoot, NOW_ISO, {
        onError: (e) => captured.push(e),
      });
      expect(r).toBeNull();
      expect(captured).toHaveLength(0);
    } finally {
      if (prev === undefined) delete process.env.CMUX_TEAM_TOKEN_POOL;
      else process.env.CMUX_TEAM_TOKEN_POOL = prev;
    }
  });
});
