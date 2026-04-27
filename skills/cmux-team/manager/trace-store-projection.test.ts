/**
 * T354: trace-store の projection 集計関数（getProjection5h / getProjection7d）と
 * normalizeRole / aggregateApiUsageByRole の SQL 正規化テスト。
 *
 * in-memory bun:sqlite を作って SCHEMA を流し込み、insertRateLimitSnapshot で
 * 時系列を仕込んだ上で projection の数値を assertion する。
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  insertRateLimitSnapshot,
  getProjection5h,
  getProjection7d,
  normalizeRole,
  aggregateApiUsageByRole,
  insertApiUsage,
} from "./trace-store";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rate_limit_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  unified_5h_utilization REAL,
  unified_5h_reset TEXT,
  unified_7d_utilization REAL,
  unified_7d_reset TEXT
);
CREATE INDEX IF NOT EXISTS idx_rate_limit_snapshots_ts ON rate_limit_snapshots(timestamp);
CREATE TABLE IF NOT EXISTS api_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  task_id TEXT,
  role TEXT,
  surface TEXT,
  conductor_id TEXT,
  model TEXT,
  request_id TEXT,
  status_code INTEGER,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_creation_input_tokens INTEGER,
  cache_read_input_tokens INTEGER,
  stop_reason TEXT,
  duration_ms INTEGER,
  ratelimit_tokens_remaining INTEGER,
  ratelimit_tokens_limit INTEGER,
  ratelimit_tokens_reset TEXT,
  ratelimit_input_tokens_remaining INTEGER,
  ratelimit_input_tokens_limit INTEGER,
  ratelimit_input_tokens_reset TEXT,
  ratelimit_output_tokens_remaining INTEGER,
  ratelimit_output_tokens_limit INTEGER,
  ratelimit_output_tokens_reset TEXT,
  ratelimit_requests_remaining INTEGER,
  ratelimit_requests_limit INTEGER,
  ratelimit_requests_reset TEXT,
  error TEXT
);
`;

function newDb(): Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  return db;
}

const FIVE_HOURS_MS = 5 * 3600 * 1000;
const SEVEN_DAYS_MS = 7 * 86_400 * 1000;

describe("normalizeRole (T354 F1)", () => {
  test("master / 汚染 master → master", () => {
    expect(normalizeRole("master")).toBe("master");
    expect(normalizeRole("master, x-cmux-surface: surface:300")).toBe("master");
  });
  test("conductor 系", () => {
    expect(normalizeRole("conductor")).toBe("conductor");
    expect(normalizeRole("conductor:auto-1234")).toBe("conductor");
  });
  test("agent 系", () => {
    expect(normalizeRole("agent")).toBe("agent");
    expect(normalizeRole("agent-impl-1234")).toBe("agent");
  });
  test("null / 空文字 / 不明 → unknown", () => {
    expect(normalizeRole(null)).toBe("unknown");
    expect(normalizeRole(undefined)).toBe("unknown");
    expect(normalizeRole("")).toBe("unknown");
    expect(normalizeRole("system")).toBe("unknown");
  });
});

describe("aggregateApiUsageByRole (T354 SQL CASE 正規化)", () => {
  let db: Database;
  beforeEach(() => {
    db = newDb();
  });

  test("汚染 role 'master, x-cmux-surface: surface:123' は 'master' に集約", () => {
    const since = "2026-04-24T00:00:00.000Z";
    const until = "2026-04-24T23:59:59.000Z";
    insertApiUsage(db, {
      timestamp: "2026-04-24T10:00:00.000Z",
      role: "master",
      input_tokens: 1000,
      output_tokens: 500,
    });
    insertApiUsage(db, {
      timestamp: "2026-04-24T10:01:00.000Z",
      role: "master, x-cmux-surface: surface:123",
      input_tokens: 2000,
      output_tokens: 1000,
    });
    insertApiUsage(db, {
      timestamp: "2026-04-24T10:02:00.000Z",
      role: "agent",
      input_tokens: 500,
      output_tokens: 200,
    });
    const rows = aggregateApiUsageByRole(db, {
      sinceIso: since,
      untilIso: until,
    });
    const masterRow = rows.find((r) => r.role === "master")!;
    expect(masterRow.requests).toBe(2);
    expect(masterRow.input).toBe(3000);
    expect(masterRow.output).toBe(1500);
    // unknown / 汚染が漏れて別行になっていないこと
    expect(rows.find((r) => r.role.includes("x-cmux"))).toBeUndefined();
  });

  test("ORDER BY が master → conductor → agent → unknown の固定順", () => {
    insertApiUsage(db, {
      timestamp: "2026-04-24T10:00:00.000Z",
      role: "agent",
      input_tokens: 1000,
      output_tokens: 1000,
    });
    insertApiUsage(db, {
      timestamp: "2026-04-24T10:00:00.000Z",
      role: "master",
      input_tokens: 1,
      output_tokens: 1,
    });
    insertApiUsage(db, {
      timestamp: "2026-04-24T10:00:00.000Z",
      role: "conductor",
      input_tokens: 1,
      output_tokens: 1,
    });
    insertApiUsage(db, {
      timestamp: "2026-04-24T10:00:00.000Z",
      role: null,
      input_tokens: 1,
      output_tokens: 1,
    });
    const rows = aggregateApiUsageByRole(db, {
      sinceIso: "2026-04-24T00:00:00.000Z",
      untilIso: "2026-04-24T23:59:59.000Z",
    });
    expect(rows.map((r) => r.role)).toEqual([
      "master",
      "conductor",
      "agent",
      "unknown",
    ]);
  });

  test("値域は master / conductor / agent / unknown のみ", () => {
    insertApiUsage(db, {
      timestamp: "2026-04-24T10:00:00.000Z",
      role: "system",
      input_tokens: 1,
      output_tokens: 1,
    });
    insertApiUsage(db, {
      timestamp: "2026-04-24T10:00:00.000Z",
      role: "weird",
      input_tokens: 1,
      output_tokens: 1,
    });
    const rows = aggregateApiUsageByRole(db, {
      sinceIso: "2026-04-24T00:00:00.000Z",
      untilIso: "2026-04-24T23:59:59.000Z",
    });
    expect(rows.length).toBe(1);
    expect(rows[0]!.role).toBe("unknown");
    expect(rows[0]!.requests).toBe(2);
  });
});

describe("getProjection5h", () => {
  let db: Database;
  beforeEach(() => {
    db = newDb();
  });

  test("snapshot ゼロ件 → null", () => {
    expect(getProjection5h(db, Date.now())).toBeNull();
  });

  test("snapshot 1 件のみ → recent は null、long-term は計算可能", () => {
    const now = Date.parse("2026-04-24T10:00:00.000Z");
    // 5h window: window_start = reset - 5h、reset を now+1h に設定
    const reset = new Date(now + 3600_000).toISOString();
    insertRateLimitSnapshot(db, {
      timestamp: new Date(now).toISOString(),
      unified_5h_utilization: 0.5,
      unified_5h_reset: reset,
      unified_7d_utilization: null,
      unified_7d_reset: null,
    });
    const proj = getProjection5h(db, now)!;
    expect(proj).not.toBeNull();
    expect(proj.utilization).toBe(0.5);
    expect(proj.recentProjectedSec).toBeNull();
    expect(proj.longTermProjectedSec).not.toBeNull();
    // util=0.5, elapsed = now - (reset - 5h) = 5h - 1h = 4h = 14400s
    // rate = 0.5 / 14400 ≈ 3.47e-5/sec
    // remaining = 0.5
    // projection = 0.5 / 3.47e-5 = 14400s
    expect(proj.longTermProjectedSec).toBeGreaterThan(14000);
    expect(proj.longTermProjectedSec).toBeLessThan(15000);
  });

  test("2 件の snapshot で recent 15m projection が計算される", () => {
    const now = Date.parse("2026-04-24T10:00:00.000Z");
    const reset = new Date(now + 3600_000).toISOString();
    // 10 分前: util 0.4
    insertRateLimitSnapshot(db, {
      timestamp: new Date(now - 10 * 60_000).toISOString(),
      unified_5h_utilization: 0.4,
      unified_5h_reset: reset,
    });
    // 直近: util 0.5（10 分で 0.1 増加）
    insertRateLimitSnapshot(db, {
      timestamp: new Date(now).toISOString(),
      unified_5h_utilization: 0.5,
      unified_5h_reset: reset,
    });
    const proj = getProjection5h(db, now)!;
    // rate = 0.1 / 600s = 0.000166/sec
    // remaining = 0.5
    // projection ≈ 3000s
    expect(proj.recentProjectedSec).not.toBeNull();
    expect(proj.recentProjectedSec!).toBeGreaterThan(2900);
    expect(proj.recentProjectedSec!).toBeLessThan(3100);
  });

  test("Δutil < 0 (reset 跨ぎ) → recent は null", () => {
    const now = Date.parse("2026-04-24T10:00:00.000Z");
    const reset = new Date(now + 3600_000).toISOString();
    // 5 分前: util 0.9（reset 直前の高値）
    insertRateLimitSnapshot(db, {
      timestamp: new Date(now - 5 * 60_000).toISOString(),
      unified_5h_utilization: 0.9,
      unified_5h_reset: new Date(now - 60_000).toISOString(), // 過去 reset
    });
    // 直近: util 0.05（reset 後）
    insertRateLimitSnapshot(db, {
      timestamp: new Date(now).toISOString(),
      unified_5h_utilization: 0.05,
      unified_5h_reset: reset,
    });
    const proj = getProjection5h(db, now)!;
    // 直近 reset 以降フィルタで起点 snapshot が取れず recent は null
    expect(proj.recentProjectedSec).toBeNull();
  });

  test("utilization >= 1 → projection 0s", () => {
    const now = Date.parse("2026-04-24T10:00:00.000Z");
    insertRateLimitSnapshot(db, {
      timestamp: new Date(now).toISOString(),
      unified_5h_utilization: 1.0,
      unified_5h_reset: new Date(now + 3600_000).toISOString(),
    });
    const proj = getProjection5h(db, now)!;
    expect(proj.longTermProjectedSec).toBe(0);
    expect(proj.recentProjectedSec).toBe(0);
  });

  test("getProjection7d も 7 日窓で動く", () => {
    const now = Date.parse("2026-04-24T10:00:00.000Z");
    const reset = new Date(now + 3600_000).toISOString();
    insertRateLimitSnapshot(db, {
      timestamp: new Date(now).toISOString(),
      unified_5h_utilization: null,
      unified_5h_reset: null,
      unified_7d_utilization: 0.3,
      unified_7d_reset: reset,
    });
    const proj = getProjection7d(db, now);
    expect(proj).not.toBeNull();
    expect(proj!.utilization).toBe(0.3);
    // 5h projection は null（util_5h IS NULL）
    expect(getProjection5h(db, now)).toBeNull();
  });
});
