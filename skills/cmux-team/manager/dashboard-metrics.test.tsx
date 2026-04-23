/**
 * T307: dashboard-metrics.ts の純粋関数群のユニットテスト。
 *
 * `dashboard-issues.test.tsx` と同じ「行オブジェクトを JSON stringify → toContain」
 * パターンで rendering 層を検証する。
 *
 * Rec #2 対応: computeProjectedToLimit / computeRiskLevel の 0 除算・null 入力
 * ケースを明示的に個別 test で列挙する。
 * Rec #5 対応: rate limit セクション先頭の "from: <role>/<surface>" キャプション。
 * Rec #6 対応: getLatestApiUsageRow の timestamp が now-60s より古ければ
 * "proxy idle? last seen Ns ago" fallback 表示。
 */
import { describe, test, expect } from "bun:test";
import {
  buildMetricsRows,
  buildProgressBar,
  formatBurnRate,
  computeProjectedToLimit,
  computeRiskLevel,
  type MetricsData,
} from "./dashboard-metrics";

function stringifyRows(rows: any[]): string {
  return JSON.stringify(rows);
}

function makeData(overrides: Partial<MetricsData> = {}): MetricsData {
  const now = Date.parse("2026-04-24T10:00:00.000Z");
  return {
    nowMs: now,
    tokensRemaining: 800_000,
    tokensLimit: 1_000_000,
    tokensResetIso: "2026-04-24T10:01:00.000Z",
    requestsRemaining: 4_000,
    requestsLimit: 5_000,
    requestsResetIso: "2026-04-24T10:01:00.000Z",
    burnTokPerSec: 1_000,
    roleRows: [],
    taskRows: [],
    unifiedFive: 0.4,
    unifiedSeven: 0.2,
    latestRowRole: "agent",
    latestRowSurface: "surface:300",
    latestRowTimestampMs: now - 5_000,
    ...overrides,
  };
}

describe("buildProgressBar", () => {
  test("0/100 → 全 dim", () => {
    expect(buildProgressBar(0, 100, 8)).toBe("░░░░░░░░");
  });
  test("50/100, width=8 → 4 filled + 4 dim", () => {
    expect(buildProgressBar(50, 100, 8)).toBe("████░░░░");
  });
  test("100/100 → 全 filled", () => {
    expect(buildProgressBar(100, 100, 8)).toBe("████████");
  });
  test("limit=0 → 全 dim（0 除算回避）", () => {
    expect(buildProgressBar(0, 0, 8)).toBe("░░░░░░░░");
  });
});

describe("formatBurnRate", () => {
  test("1240 → '1,240 tok/s'", () => {
    expect(formatBurnRate(1_240)).toBe("1,240 tok/s");
  });
  test("0 → '0 tok/s'", () => {
    expect(formatBurnRate(0)).toBe("0 tok/s");
  });
  test("小数は整数に丸める", () => {
    expect(formatBurnRate(123.7)).toBe("124 tok/s");
  });
});

describe("computeProjectedToLimit (Rec #2)", () => {
  test("remaining=null → null", () => {
    expect(computeProjectedToLimit(null, 100)).toBeNull();
  });
  test("burnTokPerSec=0 → null（0 除算回避）", () => {
    expect(computeProjectedToLimit(100_000, 0)).toBeNull();
  });
  test("正常ケース: remaining=60000, burn=1000 → 60 秒", () => {
    expect(computeProjectedToLimit(60_000, 1_000)).toBe(60);
  });
  test("負の burn（理論上ありえないが） → null", () => {
    expect(computeProjectedToLimit(1000, -1)).toBeNull();
  });
});

describe("computeRiskLevel (Rec #2)", () => {
  test("(null, null) → 'gray'", () => {
    expect(computeRiskLevel(null, null)).toBe("gray");
  });
  test("(null, 60) → 'gray'", () => {
    expect(computeRiskLevel(null, 60)).toBe("gray");
  });
  test("(60, null) → 'gray'", () => {
    expect(computeRiskLevel(60, null)).toBe("gray");
  });
  test("projected < reset → 'red'（リセット前にリミット到達）", () => {
    expect(computeRiskLevel(30, 60)).toBe("red");
  });
  test("reset <= projected < 2*reset → 'yellow'", () => {
    expect(computeRiskLevel(90, 60)).toBe("yellow");
  });
  test("projected >= 2*reset → 'green'", () => {
    expect(computeRiskLevel(200, 60)).toBe("green");
  });
});

describe("buildMetricsRows", () => {
  test("data=null, error=null → loading 表示", () => {
    const rows = buildMetricsRows(null, null);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const s = stringifyRows(rows);
    // 英日どちらでも "loading" / "読み込み" / "no data" 類のワードを含むこと
    expect(
      s.toLowerCase().includes("loading") ||
        s.includes("読み込み") ||
        s.toLowerCase().includes("no data")
    ).toBe(true);
  });

  test("error 付き → 最終行にエラー文言", () => {
    const rows = buildMetricsRows(null, "database locked");
    const s = stringifyRows(rows);
    expect(s).toContain("database locked");
  });

  test("通常データ → 上段 rate limit + 中段 role + 下段 task の各行が含まれる", () => {
    const data = makeData({
      roleRows: [
        {
          role: "agent",
          requests: 10,
          input: 5000,
          output: 2000,
          cache: 1000,
          cache_read: 500,
        },
        {
          role: "master",
          requests: 5,
          input: 2000,
          output: 800,
          cache: 0,
          cache_read: 0,
        },
      ],
      taskRows: [
        { task_id: "T001", requests: 3, input: 1000, output: 500, cache: 200 },
        { task_id: "T002", requests: 2, input: 800, output: 400, cache: 100 },
      ],
    });
    const rows = buildMetricsRows(data, null);
    const s = stringifyRows(rows);
    // 上段: rate limit tokens + requests
    expect(s).toContain("tok"); // "tok/s" や "tokens"
    // ロール行
    expect(s).toContain("agent");
    expect(s).toContain("master");
    // タスク行
    expect(s).toContain("T001");
    expect(s).toContain("T002");
    // プログレスバー
    expect(s).toContain("█");
  });

  test("RISK 判定（projected < reset）で 'RISK' / 'red' マーク が含まれる", () => {
    // remaining=1000, burn=1000 → projected=1s
    // reset=60s 先 → projected < reset → RED
    const data = makeData({
      tokensRemaining: 1_000,
      tokensLimit: 1_000_000,
      tokensResetIso: new Date(Date.parse("2026-04-24T10:00:00.000Z") + 60_000).toISOString(),
      burnTokPerSec: 1_000,
    });
    const rows = buildMetricsRows(data, null);
    const s = stringifyRows(rows);
    // RISK 表示 or red 色のラベルが含まれること
    expect(s.toLowerCase()).toContain("risk");
  });

  test("空 roleRows / 空 taskRows → empty メッセージ", () => {
    const data = makeData({ roleRows: [], taskRows: [] });
    const rows = buildMetricsRows(data, null);
    const s = stringifyRows(rows);
    // 英日どちらでも "no " or "(none)" or "—" or "なし"
    expect(
      s.toLowerCase().includes("no ") ||
        s.includes("(none)") ||
        s.includes("—") ||
        s.includes("なし")
    ).toBe(true);
  });

  test("Rec #5: rate limit セクション上段に取得元 caption を表示", () => {
    const data = makeData({
      latestRowRole: "agent",
      latestRowSurface: "surface:300",
      latestRowTimestampMs: Date.parse("2026-04-24T10:00:00.000Z") - 5_000,
    });
    const rows = buildMetricsRows(data, null);
    const s = stringifyRows(rows);
    // "from: agent/surface:300 (5s ago)" のような形式
    expect(s).toContain("from:");
    expect(s).toContain("agent");
    expect(s).toContain("surface:300");
  });

  test("Rec #6: getLatestApiUsageRow の timestamp が now-60s より古ければ proxy idle 表示", () => {
    const now = Date.parse("2026-04-24T10:00:00.000Z");
    const data = makeData({
      nowMs: now,
      latestRowTimestampMs: now - 120_000, // 2 分前
      burnTokPerSec: 0,
    });
    const rows = buildMetricsRows(data, null);
    const s = stringifyRows(rows);
    // "proxy idle" / "last seen Ns ago" 類のメッセージが含まれる
    expect(s.toLowerCase()).toContain("proxy idle");
    expect(s).toContain("last seen");
  });

  test("Rec #6: timestamp が now-60s 以内なら proxy idle 表示は出ない", () => {
    const now = Date.parse("2026-04-24T10:00:00.000Z");
    const data = makeData({
      nowMs: now,
      latestRowTimestampMs: now - 10_000, // 10s 前
      burnTokPerSec: 0,
    });
    const rows = buildMetricsRows(data, null);
    const s = stringifyRows(rows);
    expect(s.toLowerCase()).not.toContain("proxy idle");
  });

  test("latestRowTimestampMs=null（proxy 未稼働）→ no data 表示", () => {
    const data = makeData({
      latestRowTimestampMs: null,
      tokensRemaining: null,
      tokensLimit: null,
      burnTokPerSec: 0,
    });
    const rows = buildMetricsRows(data, null);
    const s = stringifyRows(rows);
    expect(
      s.toLowerCase().includes("no data") || s.includes("データなし")
    ).toBe(true);
  });
});
