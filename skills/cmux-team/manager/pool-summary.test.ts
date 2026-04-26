/**
 * pool-summary.test.ts (T351)
 *
 * `buildPoolSummary` / `loadPoolSummary` の純関数テスト。
 *
 * - case A: 単一 token, util_5h=util_7d=0.5, plan_ratio=20 → cap_pct ≒ 50%
 *   - `remaining_5h = Math.max(0, 1 - util_5h) = 0.5`（minor 1 反映: token-store.ts:745）
 * - case B: 2 token を case A と同条件で → capacity_pct ≒ 100%（合算）
 * - case C: 全 token plan_ratio=null → capacity_pct=0、perHandle は全 token (capPct=null)
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
  test("case A: 単一 token util_5h=util_7d=0.5, plan_ratio=20 → cap_pct ≒ 50", () => {
    // remaining_5h = Math.max(0, 1 - 0.5) = 0.5
    // remaining_7d = Math.max(0, 1 - 0.5) = 0.5
    // flow_5h = 0.5 * 20 / 5 = 2.0
    // flow_7d = 0.5 * 20 / 168 ≒ 0.0595
    // flow = min(2.0, 0.0595) = 0.0595
    // cap_pct = 0.0595 / (20/168) * 100 = 50%
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
    expect(summary.header.capacityPct).toBeGreaterThan(49.9);
    expect(summary.header.capacityPct).toBeLessThan(50.1);

    const perHandle = summary.perHandle.get("@kddi");
    expect(perHandle).toBeDefined();
    expect(perHandle?.util5h).toBe(0.5);
    expect(perHandle?.util7d).toBe(0.5);
    expect(perHandle?.capPct).toBeGreaterThan(49.9);
    expect(perHandle?.capPct).toBeLessThan(50.1);
  });

  test("case B: 2 token を case A と同条件 → capacity_pct ≒ 100% (合算)", () => {
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
    expect(summary.header.capacityPct).toBeGreaterThan(99.9);
    expect(summary.header.capacityPct).toBeLessThan(100.1);
    expect(summary.perHandle.size).toBe(2);
    expect(summary.perHandle.get("@kddi")?.capPct).toBeGreaterThan(49.9);
    expect(summary.perHandle.get("@tayo")?.capPct).toBeGreaterThan(49.9);
  });

  test("case C: 全 token plan_ratio=null → capacity_pct=0, perHandle 全 token (capPct=null)", () => {
    // 現行 main.ts:1444-1483 の in-line 実装と等価:
    //   poolHandleData は listTokens 全 handle を含み、capByHandle.get(handle) ?? null で capPct を埋める
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
    expect(summary.header.capacityPct).toBe(0);
    expect(summary.perHandle.size).toBe(2);
    expect(summary.perHandle.get("@a")?.capPct).toBeNull();
    expect(summary.perHandle.get("@b")?.capPct).toBeNull();
    expect(summary.perHandle.get("@a")?.util5h).toBe(0.1);
    expect(summary.perHandle.get("@b")?.util7d).toBe(0.2);
  });

  test("case D: selectable=0 の token は nextReset 入力対象には残るが capacity 計算には影響しない", () => {
    // 現行 main.ts:1444-1483 の in-line 実装と等価:
    //   computeNextReset の入力に `selectable: t.selectable` を渡す
    //   computePoolCapacity 側は plan_ratio == null のみで除外（selectable は見ない）
    const t1 = insertToken(db, makeToken({
      handle: "@active",
      organization_id: "00000000-0000-0000-0000-000000000001",
    }));
    const t2 = insertToken(db, makeToken({
      handle: "@frozen",
      organization_id: "00000000-0000-0000-0000-000000000002",
    }));
    // t2 を selectable=0 にする
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
    // selectable=0 でも plan_ratio が non-null なら capacity に含まれる（案 / 現行実装と等価）
    expect(summary.header.capacityPct).toBeGreaterThan(99.9);
    expect(summary.header.capacityPct).toBeLessThan(100.1);
    // perHandle にも両方含まれる（listTokens 全 handle）
    expect(summary.perHandle.size).toBe(2);
    expect(summary.perHandle.get("@active")).toBeDefined();
    expect(summary.perHandle.get("@frozen")).toBeDefined();
    // nextReset は selectable=true の @active からのみ取られる（computeNextReset の filter）
    expect(summary.header.nextReset?.handle).toBe("@active");
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
});
