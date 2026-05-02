/**
 * T307 / T354: dashboard-metrics.ts の純粋関数群のユニットテスト。
 *
 * 「行オブジェクトを JSON stringify → toContain」パターンで rendering 層を検証する。
 *
 * T354 で旧 burn rate / TPM/RPM 系テストを削除し、新 Rate Limit Projection /
 * Pool Tokens / role 正規化 / 桁揃えのテストに置き換える。
 */
import { describe, test, expect } from "bun:test";
import {
  buildMetricsRows,
  buildPoolTokenRowFromSnapshot,
  computeRiskLevel,
  type MetricsData,
  type PoolTokenRow,
} from "./dashboard-metrics";
import type { ProjectionResult } from "./trace-store";
import type { UsageSnapshot } from "./token-store";
import { formatPerHandleUtilCell, formatUtil } from "./token-format";

function stringifyRows(rows: any[]): string {
  return JSON.stringify(rows);
}

const FIXED_NOW = Date.parse("2026-04-24T10:00:00.000Z");

function makeProjection(overrides: Partial<ProjectionResult> = {}): ProjectionResult {
  return {
    utilization: 0.5,
    resetIso: new Date(FIXED_NOW + 60_000).toISOString(),
    longTermProjectedSec: 120,
    recentProjectedSec: 60,
    ...overrides,
  };
}

function makeData(overrides: Partial<MetricsData> = {}): MetricsData {
  return {
    nowMs: FIXED_NOW,
    projection5h: makeProjection(),
    projection7d: makeProjection({ utilization: 0.2, longTermProjectedSec: 600 }),
    poolTokens: null,
    dashboardServerUrl: null,
    latestRowRole: "agent",
    latestRowSurface: "surface:300",
    latestRowTimestampMs: FIXED_NOW - 5_000,
    ...overrides,
  };
}

describe("computeRiskLevel", () => {
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

describe("buildMetricsRows: loading / error", () => {
  test("data=null → loading 表示", () => {
    const rows = buildMetricsRows(null, null);
    const s = stringifyRows(rows).toLowerCase();
    expect(
      s.includes("loading") ||
        s.includes("読み込み") ||
        s.includes("no data"),
    ).toBe(true);
  });

  test("error 付き → 最終行にエラー文言", () => {
    const rows = buildMetricsRows(null, "database locked");
    const s = stringifyRows(rows);
    expect(s).toContain("database locked");
  });
});

describe("buildMetricsRows: caption (T354 F1 normalize role)", () => {
  test("汚染 role 'master, x-cmux-surface: surface:300' は 'master' に丸めて表示", () => {
    const data = makeData({
      latestRowRole: "master, x-cmux-surface: surface:300",
      latestRowSurface: "surface:300",
      latestRowTimestampMs: FIXED_NOW - 1_000,
    });
    const rows = buildMetricsRows(data, null);
    const s = stringifyRows(rows);
    // 汚染部分は出ない
    expect(s).not.toContain("x-cmux-surface");
    // master / surface:300 は表示される
    expect(s).toContain("from:");
    expect(s).toContain("master");
    expect(s).toContain("surface:300");
  });

  test("conductor:auto-... → 'conductor'", () => {
    const data = makeData({ latestRowRole: "conductor:auto-1234" });
    const rows = buildMetricsRows(data, null);
    const s = stringifyRows(rows);
    expect(s).toContain("conductor");
    expect(s).not.toContain("conductor:auto");
  });

  test("null / 不明 role → 'unknown'", () => {
    const data = makeData({ latestRowRole: null });
    const rows = buildMetricsRows(data, null);
    expect(stringifyRows(rows)).toContain("unknown");
  });

  test("proxy idle: now-2min なら proxy idle 表示", () => {
    const data = makeData({ latestRowTimestampMs: FIXED_NOW - 120_000 });
    const rows = buildMetricsRows(data, null);
    const s = stringifyRows(rows).toLowerCase();
    expect(s).toContain("proxy idle");
  });

  test("proxy 未稼働 (latestRowTimestampMs=null) → no data 表示", () => {
    const data = makeData({ latestRowTimestampMs: null });
    const rows = buildMetricsRows(data, null);
    const s = stringifyRows(rows).toLowerCase();
    expect(s.includes("no data") || s.includes("データなし")).toBe(true);
  });
});

describe("buildMetricsRows: Rate Limit Projection (T354)", () => {
  test("通常データ → 5h / 7d ラベルと long-term / recent 15m 行が含まれる", () => {
    const rows = buildMetricsRows(makeData(), null);
    const s = stringifyRows(rows);
    // セクション見出し（英 "Projection" / 日 "枯渇予測"）
    expect(
      s.toLowerCase().includes("projection") || s.includes("枯渇予測"),
    ).toBe(true);
    // 軸ラベル（buildUtilizationBar から）
    expect(s).toContain("5h");
    expect(s).toContain("7d");
    // long-term / recent 15m 行
    expect(s).toContain("long-term");
    expect(s).toContain("recent 15m");
    // プログレスバー文字
    expect(s).toContain("█");
  });

  test("projection5h=null → no data 行", () => {
    const data = makeData({ projection5h: null });
    const rows = buildMetricsRows(data, null);
    const s = stringifyRows(rows).toLowerCase();
    expect(s.includes("no data") || s.includes("データなし")).toBe(true);
  });

  test("utilization 100% で longTermProjectedSec=0 → '0s' 表示", () => {
    const data = makeData({
      projection5h: makeProjection({
        utilization: 1.0,
        longTermProjectedSec: 0,
        recentProjectedSec: 0,
      }),
    });
    const rows = buildMetricsRows(data, null);
    const s = stringifyRows(rows);
    expect(s).toContain("0s");
  });

  test("recentProjectedSec=null → '—' 表示", () => {
    const data = makeData({
      projection5h: makeProjection({ recentProjectedSec: null }),
    });
    const rows = buildMetricsRows(data, null);
    const s = stringifyRows(rows);
    // formatDurationShort(null) === '—'
    expect(s).toContain("—");
  });

  test("% 桁が padStart(3) で揃う（buildUtilizationBar 経由）", () => {
    const data = makeData({
      projection5h: makeProjection({ utilization: 0.01 }),
    });
    const rows = buildMetricsRows(data, null);
    const s = stringifyRows(rows);
    // 1% は padStart(3) で "  1%" と前 2 スペースになる
    expect(s).toContain("  1%");
  });

  test("poolTokens !== null（Pool key モード）→ Projection セクションは非表示", () => {
    const tokens: PoolTokenRow[] = [
      {
        handle: "@personal",
        util5h: 0.42,
        reset5hIso: new Date(FIXED_NOW + 60_000).toISOString(),
        util7d: 0.1,
        reset7dIso: new Date(FIXED_NOW + 86_400_000).toISOString(),
        hasSnapshot: true,
        reset5hPassed: false,
        reset7dPassed: false,
      },
    ];
    const rows = buildMetricsRows(makeData({ poolTokens: tokens }), null);
    const s = stringifyRows(rows);
    // 枯渇予測セクション見出し / 内部行が出ない
    expect(s).not.toContain("Rate Limit Projection");
    expect(s).not.toContain("枯渇予測");
    expect(s).not.toContain("long-term");
    expect(s).not.toContain("recent 15m");
  });

  test("poolTokens === [] でも（pool 有効）Projection セクションは非表示", () => {
    const rows = buildMetricsRows(makeData({ poolTokens: [] }), null);
    const s = stringifyRows(rows);
    expect(s).not.toContain("Rate Limit Projection");
    expect(s).not.toContain("枯渇予測");
  });
});

describe("buildMetricsRows: Pool Tokens section (T354 S8)", () => {
  test("poolTokens=null → セクション自体が表示されない", () => {
    const rows = buildMetricsRows(makeData({ poolTokens: null }), null);
    const s = stringifyRows(rows).toLowerCase();
    expect(s).not.toContain("pool tokens");
  });

  test("空配列 → '(no selectable tokens)' 表示", () => {
    const rows = buildMetricsRows(makeData({ poolTokens: [] }), null);
    const s = stringifyRows(rows).toLowerCase();
    expect(s).toContain("pool tokens");
    expect(s.includes("no selectable") || s.includes("selectable な")).toBe(
      true,
    );
  });

  test("非空 → handle と 5h/7d util 行が含まれる", () => {
    const tokens: PoolTokenRow[] = [
      {
        handle: "@personal",
        util5h: 0.42,
        reset5hIso: new Date(FIXED_NOW + 60_000).toISOString(),
        util7d: 0.1,
        reset7dIso: new Date(FIXED_NOW + 86_400_000).toISOString(),
        hasSnapshot: true,
        reset5hPassed: false,
        reset7dPassed: false,
      },
    ];
    const rows = buildMetricsRows(makeData({ poolTokens: tokens }), null);
    const s = stringifyRows(rows);
    expect(s).toContain("@personal");
    expect(s).toContain("42%");
  });

  test("hasSnapshot=false → 'no data' 表示", () => {
    const tokens: PoolTokenRow[] = [
      {
        handle: "@stale",
        util5h: null,
        reset5hIso: null,
        util7d: null,
        reset7dIso: null,
        hasSnapshot: false,
        reset5hPassed: false,
        reset7dPassed: false,
      },
    ];
    const rows = buildMetricsRows(makeData({ poolTokens: tokens }), null);
    const s = stringifyRows(rows).toLowerCase();
    expect(s).toContain("@stale");
    expect(s.includes("no data") || s.includes("データなし")).toBe(true);
  });

  test("F3: util_5h DESC で並ぶ（100% / 78% / 32% の順）", () => {
    const tokens: PoolTokenRow[] = [
      {
        handle: "@a",
        util5h: 0.78,
        reset5hIso: null,
        util7d: null,
        reset7dIso: null,
        hasSnapshot: true,
        reset5hPassed: false,
        reset7dPassed: false,
      },
      {
        handle: "@b",
        util5h: 0.32,
        reset5hIso: null,
        util7d: null,
        reset7dIso: null,
        hasSnapshot: true,
        reset5hPassed: false,
        reset7dPassed: false,
      },
      {
        handle: "@c",
        util5h: 1.0,
        reset5hIso: null,
        util7d: null,
        reset7dIso: null,
        hasSnapshot: true,
        reset5hPassed: false,
        reset7dPassed: false,
      },
    ];
    // 注: dashboard.tsx の buildPoolTokenRows がソート責務。本テストはソート済み入力で
    // buildMetricsRows が順序通り出すことを確認する。
    const sorted = [...tokens].sort((a, b) => (b.util5h ?? -1) - (a.util5h ?? -1));
    const rows = buildMetricsRows(makeData({ poolTokens: sorted }), null);
    const s = stringifyRows(rows);
    const idxC = s.indexOf("@c");
    const idxA = s.indexOf("@a");
    const idxB = s.indexOf("@b");
    expect(idxC).toBeGreaterThanOrEqual(0);
    expect(idxC).toBeLessThan(idxA);
    expect(idxA).toBeLessThan(idxB);
  });

  test("F3: 同 util の場合は handle 昇順（dashboard.tsx 側ソートを確認）", () => {
    // 入力ソートが正しければ表示順に保たれる
    const tokens: PoolTokenRow[] = [
      {
        handle: "@aaa",
        util5h: 0.5,
        reset5hIso: null,
        util7d: null,
        reset7dIso: null,
        hasSnapshot: true,
        reset5hPassed: false,
        reset7dPassed: false,
      },
      {
        handle: "@bbb",
        util5h: 0.5,
        reset5hIso: null,
        util7d: null,
        reset7dIso: null,
        hasSnapshot: true,
        reset5hPassed: false,
        reset7dPassed: false,
      },
    ];
    const rows = buildMetricsRows(makeData({ poolTokens: tokens }), null);
    const s = stringifyRows(rows);
    expect(s.indexOf("@aaa")).toBeLessThan(s.indexOf("@bbb"));
  });
});

describe("buildMetricsRows: Pool Tokens reset alignment (T377)", () => {
  test("複数 token で 5h reset 桁が異なる場合 → 5h 列が padStart で揃う", () => {
    const tokens: PoolTokenRow[] = [
      {
        handle: "@a",
        util5h: 0.42,
        // 5min → "5m"
        reset5hIso: new Date(FIXED_NOW + 5 * 60 * 1000).toISOString(),
        util7d: null,
        reset7dIso: null,
        hasSnapshot: true,
        reset5hPassed: false,
        reset7dPassed: false,
      },
      {
        handle: "@b",
        util5h: 0.1,
        // 1h30m → "1h30m"
        reset5hIso: new Date(FIXED_NOW + 90 * 60 * 1000).toISOString(),
        util7d: null,
        reset7dIso: null,
        hasSnapshot: true,
        reset5hPassed: false,
        reset7dPassed: false,
      },
    ];
    const rows = buildMetricsRows(makeData({ poolTokens: tokens }), null);
    const s = stringifyRows(rows);
    // "5m" は最大幅 5 ("1h30m") に padStart されて "   5m" になる
    expect(s).toContain("   5m");
    // 最大幅側はそのまま
    expect(s).toContain("1h30m");
  });

  test("複数 token で 7d 列も padStart で揃う", () => {
    const tokens: PoolTokenRow[] = [
      {
        handle: "@a",
        util5h: null,
        reset5hIso: null,
        util7d: 0.42,
        // 12h → "12h"
        reset7dIso: new Date(FIXED_NOW + 12 * 3600 * 1000).toISOString(),
        hasSnapshot: true,
        reset5hPassed: false,
        reset7dPassed: false,
      },
      {
        handle: "@b",
        util5h: null,
        reset5hIso: null,
        util7d: 0.1,
        // 1d → "1d"
        reset7dIso: new Date(FIXED_NOW + 86_400 * 1000).toISOString(),
        hasSnapshot: true,
        reset5hPassed: false,
        reset7dPassed: false,
      },
    ];
    const rows = buildMetricsRows(makeData({ poolTokens: tokens }), null);
    const s = stringifyRows(rows);
    // "1d" は最大幅 3 ("12h") に padStart されて " 1d" になる
    expect(s).toContain(" 1d");
    expect(s).toContain("12h");
  });

  test("hasSnapshot=false 混在時、snapshot 有り行の時刻列が揃う", () => {
    const tokens: PoolTokenRow[] = [
      {
        handle: "@stale",
        util5h: null,
        reset5hIso: null,
        util7d: null,
        reset7dIso: null,
        hasSnapshot: false,
        reset5hPassed: false,
        reset7dPassed: false,
      },
      {
        handle: "@a",
        util5h: 0.42,
        reset5hIso: new Date(FIXED_NOW + 5 * 60 * 1000).toISOString(),
        util7d: null,
        reset7dIso: null,
        hasSnapshot: true,
        reset5hPassed: false,
        reset7dPassed: false,
      },
      {
        handle: "@b",
        util5h: 0.1,
        reset5hIso: new Date(FIXED_NOW + 90 * 60 * 1000).toISOString(),
        util7d: null,
        reset7dIso: null,
        hasSnapshot: true,
        reset5hPassed: false,
        reset7dPassed: false,
      },
    ];
    const rows = buildMetricsRows(makeData({ poolTokens: tokens }), null);
    const s = stringifyRows(rows);
    // hasSnapshot=false の行はパディング計算から除外され、snapshot 有り行は揃う
    expect(s).toContain("   5m");
    expect(s).toContain("1h30m");
  });

  test("1 token のみでパディング 0（従来挙動）", () => {
    const tokens: PoolTokenRow[] = [
      {
        handle: "@only",
        util5h: 0.42,
        reset5hIso: new Date(FIXED_NOW + 5 * 60 * 1000).toISOString(),
        util7d: null,
        reset7dIso: null,
        hasSnapshot: true,
        reset5hPassed: false,
        reset7dPassed: false,
      },
    ];
    const rows = buildMetricsRows(makeData({ poolTokens: tokens }), null);
    const s = stringifyRows(rows);
    // 単独 token は padStart(2) = no-op で "5m" のまま（前置スペース無し）
    expect(s).toContain('"5m"');
    expect(s).not.toContain("   5m");
  });
});

// T415: role / task aggregations セクションは Web ダッシュボードに移管されたため削除。
// MetricsData.roleRows / taskRows も型から消えており、buildMetricsRows は集計を出さない。

describe("buildMetricsRows: T415 (Web 移管後)", () => {
  test("'By role' / 'By task' セクションが含まれない", () => {
    const rows = buildMetricsRows(makeData(), null);
    const s = stringifyRows(rows);
    expect(s).not.toContain("By role");
    expect(s).not.toContain("By task");
    expect(s).not.toContain("ロール別");
    expect(s).not.toContain("タスク別");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T415: Web ダッシュボード URL 行
// ─────────────────────────────────────────────────────────────────────────────

describe("buildMetricsRows: Web URL row (T415)", () => {
  test("dashboardServerUrl 設定あり → 'Open dashboard' と URL が含まれる", () => {
    const data = makeData({ dashboardServerUrl: "http://127.0.0.1:54321" });
    const rows = buildMetricsRows(data, null);
    const s = stringifyRows(rows);
    expect(s.includes("Open dashboard") || s.includes("Web ダッシュボード")).toBe(
      true,
    );
    expect(s).toContain("http://127.0.0.1:54321");
  });

  test("dashboardServerUrl=null → 'not running' / '未起動' 表示", () => {
    const data = makeData({ dashboardServerUrl: null });
    const rows = buildMetricsRows(data, null);
    const s = stringifyRows(rows);
    expect(
      s.toLowerCase().includes("not running") || s.includes("未起動"),
    ).toBe(true);
  });

  test("URL 行は Pool Tokens セクションより前に出る", () => {
    const tokens: PoolTokenRow[] = [
      {
        handle: "@personal",
        util5h: 0.42,
        reset5hIso: new Date(FIXED_NOW + 60_000).toISOString(),
        util7d: 0.1,
        reset7dIso: new Date(FIXED_NOW + 86_400_000).toISOString(),
        hasSnapshot: true,
        reset5hPassed: false,
        reset7dPassed: false,
      },
    ];
    const data = makeData({
      poolTokens: tokens,
      dashboardServerUrl: "http://127.0.0.1:54321",
    });
    const rows = buildMetricsRows(data, null);
    const s = stringifyRows(rows);
    const idxUrl = Math.max(
      s.indexOf("Open dashboard"),
      s.indexOf("Web ダッシュボード"),
    );
    const idxPool = s.indexOf("Pool Tokens");
    expect(idxUrl).toBeGreaterThanOrEqual(0);
    expect(idxPool).toBeGreaterThanOrEqual(0);
    expect(idxUrl).toBeLessThan(idxPool);
  });

  test("URL 行は Rate Limit Projection セクションより前に出る", () => {
    const data = makeData({
      poolTokens: null,
      dashboardServerUrl: "http://127.0.0.1:54321",
    });
    const rows = buildMetricsRows(data, null);
    const s = stringifyRows(rows);
    const idxUrl = s.indexOf("Open dashboard");
    const idxProj = s.indexOf("Rate Limit Projection");
    // 日本語 locale でも片方が必ず取れる
    if (idxProj >= 0) {
      expect(idxUrl).toBeGreaterThanOrEqual(0);
      expect(idxUrl).toBeLessThan(idxProj);
    } else {
      const idxJa = s.indexOf("枯渇予測");
      const idxUrlJa = s.indexOf("Web ダッシュボード");
      expect(idxJa).toBeGreaterThanOrEqual(0);
      expect(idxUrlJa).toBeGreaterThanOrEqual(0);
      expect(idxUrlJa).toBeLessThan(idxJa);
    }
  });

  test("URL 行は proxy 未稼働 (latestRowTimestampMs=null) でも常に表示", () => {
    const data = makeData({
      latestRowTimestampMs: null,
      dashboardServerUrl: "http://127.0.0.1:9999",
    });
    const rows = buildMetricsRows(data, null);
    const s = stringifyRows(rows);
    expect(s).toContain("http://127.0.0.1:9999");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T415: status message 表示（O キー押下時の no-op / open 失敗通知）
// ─────────────────────────────────────────────────────────────────────────────

describe("buildMetricsRows: status message (T415)", () => {
  test("statusMessage 単独でも末尾に表示される", () => {
    const rows = buildMetricsRows(makeData(), null, "open failed: foo");
    const s = stringifyRows(rows);
    expect(s).toContain("open failed: foo");
  });

  test("error と statusMessage の双方が指定されたら error を優先", () => {
    const rows = buildMetricsRows(
      makeData(),
      "database locked",
      "open failed: foo",
    );
    const s = stringifyRows(rows);
    expect(s).toContain("database locked");
    // statusMessage は出さない（error 優先）
    expect(s).not.toContain("open failed: foo");
  });

  test("data=null + statusMessage のみでも末尾に表示", () => {
    const rows = buildMetricsRows(null, null, "open failed: foo");
    const s = stringifyRows(rows);
    expect(s).toContain("open failed: foo");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T401: buildPoolTokenRowFromSnapshot — CLI (formatPerHandleUtilCell) との等価性
// ─────────────────────────────────────────────────────────────────────────────

describe("buildPoolTokenRowFromSnapshot (CLI consistency)", () => {
  // token-format.test.ts と同じ固定 now / fixture パターンを採用
  const NOW_MS = new Date("2026-04-25T10:00:00.000Z").getTime();
  const STALE_RECORDED = new Date(NOW_MS - 35 * 60 * 1000).toISOString();
  const FRESH_RECORDED = new Date(NOW_MS).toISOString();

  function snap(partial: Partial<UsageSnapshot>): UsageSnapshot {
    return {
      id: 1,
      token_id: 1,
      util_5h: 0,
      util_7d: 0,
      reset_5h_at: null,
      reset_7d_at: null,
      unified_status: null,
      recorded_at: FRESH_RECORDED,
      ...partial,
    };
  }

  test("(a) snap=null → util/reset 全 null、hasSnapshot=false、reset*Passed=false", () => {
    const r = buildPoolTokenRowFromSnapshot("@x", null, NOW_MS);
    expect(r).toEqual({
      handle: "@x",
      util5h: null,
      reset5hIso: null,
      util7d: null,
      reset7dIso: null,
      hasSnapshot: false,
      reset5hPassed: false,
      reset7dPassed: false,
    });
  });

  test("(b) fresh snap → effUtil = snapshot 生値、reset*Passed=false", () => {
    const r = buildPoolTokenRowFromSnapshot(
      "@fresh",
      snap({
        util_5h: 0.5,
        util_7d: 0.3,
        reset_5h_at: new Date(NOW_MS + 60 * 60 * 1000).toISOString(),
        reset_7d_at: new Date(NOW_MS + 24 * 60 * 60 * 1000).toISOString(),
        recorded_at: FRESH_RECORDED,
      }),
      NOW_MS,
    );
    expect(r.handle).toBe("@fresh");
    expect(r.util5h).toBe(0.5);
    expect(r.util7d).toBe(0.3);
    expect(r.hasSnapshot).toBe(true);
    expect(r.reset5hPassed).toBe(false);
    expect(r.reset7dPassed).toBe(false);
  });

  test("(c) T401 reset_7d 通過例 (stale + reset_5h 未到達 + reset_7d 通過 + util_7d=0.97)", () => {
    // 今回バグ報告された @kddi の挙動: util_7d=0.97 のまま reset_7d_at を通過 → effUtil7d=0
    const r = buildPoolTokenRowFromSnapshot(
      "@example",
      snap({
        util_5h: 0.02,
        util_7d: 0.97,
        reset_5h_at: new Date(NOW_MS + 30 * 60 * 1000).toISOString(),
        reset_7d_at: new Date(NOW_MS - 60 * 1000).toISOString(),
        recorded_at: STALE_RECORDED,
      }),
      NOW_MS,
    );
    expect(r.util5h).toBe(0.02);
    expect(r.util7d).toBe(0);
    expect(r.reset5hPassed).toBe(false);
    expect(r.reset7dPassed).toBe(true);
    expect(r.hasSnapshot).toBe(true);
  });

  test("(d) CLI 等価性: token-format.test.ts と同 fixture で formatUtil 経由の値が一致 (5h reset 通過)", () => {
    // token-format.test.ts:132 "@tayo 想定" と同じ fixture: 5h reset 通過済み stale
    const fixture = snap({
      util_5h: 0.02,
      util_7d: 0.91,
      reset_5h_at: new Date(NOW_MS - 60 * 1000).toISOString(),
      reset_7d_at: new Date(NOW_MS + 60 * 60 * 1000).toISOString(),
      recorded_at: STALE_RECORDED,
    });
    const cli = formatPerHandleUtilCell(fixture, NOW_MS);
    const metrics = buildPoolTokenRowFromSnapshot("@tayo", fixture, NOW_MS);

    // CLI 側: display5h="0%", display7d="91%", marker="*"
    expect(cli).toEqual({ display5h: "0%", display7d: "91%", marker: "*" });
    // Metrics 側: 数値 + フラグレベル
    expect(metrics.util5h).toBe(0);
    expect(metrics.util7d).toBe(0.91);
    expect(metrics.reset5hPassed).toBe(true);
    expect(metrics.reset7dPassed).toBe(false);

    // formatUtil 経由で文字列レベルでも CLI と一致 (R2)
    expect(formatUtil(metrics.util5h)).toBe(cli.display5h);
    expect(formatUtil(metrics.util7d)).toBe(cli.display7d);
    expect(metrics.reset5hPassed || metrics.reset7dPassed ? "*" : "").toBe(
      cli.marker,
    );
  });

  // T402: snap exists で軸 util=null（未観測）と reset 通過 0 を区別する
  test("(g) snap exists + util_5h=null + util_7d=数値 + 両 reset 未通過 → util5h は null、util7d は数値", () => {
    const r = buildPoolTokenRowFromSnapshot(
      "@partial",
      snap({
        util_5h: null,
        util_7d: 0.5,
        reset_5h_at: new Date(NOW_MS + 60 * 60 * 1000).toISOString(),
        reset_7d_at: new Date(NOW_MS + 60 * 60 * 1000).toISOString(),
        recorded_at: FRESH_RECORDED,
      }),
      NOW_MS,
    );
    expect(r).toEqual({
      handle: "@partial",
      util5h: null,
      reset5hIso: new Date(NOW_MS + 60 * 60 * 1000).toISOString(),
      util7d: 0.5,
      reset7dIso: new Date(NOW_MS + 60 * 60 * 1000).toISOString(),
      hasSnapshot: true,
      reset5hPassed: false,
      reset7dPassed: false,
    });
  });

  test("(h) snap exists + 両軸 null + reset 未通過 → 両軸 null、hasSnapshot=false (no data 扱い)", () => {
    const r = buildPoolTokenRowFromSnapshot(
      "@all-null",
      snap({
        util_5h: null,
        util_7d: null,
        reset_5h_at: new Date(NOW_MS + 60 * 60 * 1000).toISOString(),
        reset_7d_at: new Date(NOW_MS + 60 * 60 * 1000).toISOString(),
        recorded_at: FRESH_RECORDED,
      }),
      NOW_MS,
    );
    expect(r.util5h).toBeNull();
    expect(r.util7d).toBeNull();
    expect(r.hasSnapshot).toBe(false);
    expect(r.reset5hPassed).toBe(false);
    expect(r.reset7dPassed).toBe(false);
  });

  test("(i) snap exists + 両軸 null + 5h reset 通過 stale → util5h=0 確定、util7d=null、hasSnapshot=true", () => {
    const r = buildPoolTokenRowFromSnapshot(
      "@reset-only",
      snap({
        util_5h: null,
        util_7d: null,
        reset_5h_at: new Date(NOW_MS - 60 * 1000).toISOString(),
        reset_7d_at: new Date(NOW_MS + 60 * 60 * 1000).toISOString(),
        recorded_at: STALE_RECORDED,
      }),
      NOW_MS,
    );
    expect(r.util5h).toBe(0);
    expect(r.util7d).toBeNull();
    expect(r.hasSnapshot).toBe(true);
    expect(r.reset5hPassed).toBe(true);
    expect(r.reset7dPassed).toBe(false);
  });

  test("(T402 CLI 等価性) snap exists + util_5h=null fixture を CLI/Metrics 双方で同期", () => {
    // token-format.test.ts (t1) と同 fixture を共有する: 5h null + 7d 数値 + reset 未通過
    const fixture = snap({
      util_5h: null,
      util_7d: 0.5,
      reset_5h_at: new Date(NOW_MS + 60 * 60 * 1000).toISOString(),
      reset_7d_at: new Date(NOW_MS + 60 * 60 * 1000).toISOString(),
      recorded_at: FRESH_RECORDED,
    });
    const cli = formatPerHandleUtilCell(fixture, NOW_MS);
    const metrics = buildPoolTokenRowFromSnapshot("@partial", fixture, NOW_MS);

    expect(cli).toEqual({ display5h: "--", display7d: "50%", marker: "" });
    expect(metrics.util5h).toBeNull();
    expect(metrics.util7d).toBe(0.5);
    // formatUtil(null) === "--" で CLI と一致
    expect(formatUtil(metrics.util5h)).toBe(cli.display5h);
    expect(formatUtil(metrics.util7d)).toBe(cli.display7d);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T401: buildMetricsRows — pool tokens marker + フッタ凡例
// ─────────────────────────────────────────────────────────────────────────────

describe("buildMetricsRows: pool tokens marker (T401)", () => {
  test("(e) 1 行でも reset5hPassed=true なら '*' マーカー + 凡例が出る", () => {
    const tokens: PoolTokenRow[] = [
      {
        handle: "@hot",
        util5h: 0,
        reset5hIso: new Date(FIXED_NOW - 60 * 1000).toISOString(),
        util7d: 0.5,
        reset7dIso: new Date(FIXED_NOW + 60 * 60 * 1000).toISOString(),
        hasSnapshot: true,
        reset5hPassed: true,
        reset7dPassed: false,
      },
    ];
    const rows = buildMetricsRows(makeData({ poolTokens: tokens }), null);
    const s = stringifyRows(rows);
    expect(s).toContain("*");
    // 凡例 (en or ja)
    expect(
      s.includes("reset passed") || s.includes("reset 通過済み"),
    ).toBe(true);
  });

  test("(e2) reset7dPassed=true でも '*' マーカー + 凡例が出る", () => {
    const tokens: PoolTokenRow[] = [
      {
        handle: "@kddi-like",
        util5h: 0.02,
        reset5hIso: new Date(FIXED_NOW + 30 * 60 * 1000).toISOString(),
        util7d: 0,
        reset7dIso: new Date(FIXED_NOW - 60 * 1000).toISOString(),
        hasSnapshot: true,
        reset5hPassed: false,
        reset7dPassed: true,
      },
    ];
    const rows = buildMetricsRows(makeData({ poolTokens: tokens }), null);
    const s = stringifyRows(rows);
    expect(s).toContain("*");
    expect(
      s.includes("reset passed") || s.includes("reset 通過済み"),
    ).toBe(true);
  });

  test("(f) 全行 reset*Passed=false なら '*' / 凡例とも出ない", () => {
    const tokens: PoolTokenRow[] = [
      {
        handle: "@a",
        util5h: 0.42,
        reset5hIso: new Date(FIXED_NOW + 60 * 60 * 1000).toISOString(),
        util7d: 0.1,
        reset7dIso: new Date(FIXED_NOW + 24 * 60 * 60 * 1000).toISOString(),
        hasSnapshot: true,
        reset5hPassed: false,
        reset7dPassed: false,
      },
      {
        handle: "@b",
        util5h: 0.78,
        reset5hIso: new Date(FIXED_NOW + 90 * 60 * 1000).toISOString(),
        util7d: 0.2,
        reset7dIso: new Date(FIXED_NOW + 24 * 60 * 60 * 1000).toISOString(),
        hasSnapshot: true,
        reset5hPassed: false,
        reset7dPassed: false,
      },
    ];
    const rows = buildMetricsRows(makeData({ poolTokens: tokens }), null);
    const s = stringifyRows(rows);
    expect(s).not.toContain("*");
    expect(s).not.toContain("reset passed");
    expect(s).not.toContain("reset 通過済み");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// T402: buildMetricsRows — 軸単位 null placeholder ("5h:  --" / "7d:  --")
// ─────────────────────────────────────────────────────────────────────────────

describe("buildMetricsRows: util_5h null axis placeholder (T402)", () => {
  test("(j) util5h=null + util7d=数値 + hasSnapshot=true → '5h:  --' placeholder + 7d bar、'*' なし", () => {
    const tokens: PoolTokenRow[] = [
      {
        handle: "@partial",
        util5h: null,
        reset5hIso: new Date(FIXED_NOW + 60 * 60 * 1000).toISOString(),
        util7d: 0.5,
        reset7dIso: new Date(FIXED_NOW + 60 * 60 * 1000).toISOString(),
        hasSnapshot: true,
        reset5hPassed: false,
        reset7dPassed: false,
      },
    ];
    const rows = buildMetricsRows(makeData({ poolTokens: tokens }), null);
    const s = stringifyRows(rows);
    // 5h 軸の placeholder (label + ":" + " " + " --" = 7 文字)
    expect(s).toContain("5h:  --");
    // 7d 側は bar が出る (50%)
    expect(s).toContain("50%");
    // reset 通過していないので '*' は出ない
    expect(s).not.toContain('"*"');
  });

  test("(k) util5h=0 + util7d=null + reset5hPassed=true + reset7dPassed=false → 5h '0%' bar + '*' と 7d '7d:  --' placeholder が同一行内に共存", () => {
    const tokens: PoolTokenRow[] = [
      {
        handle: "@reset-only",
        util5h: 0,
        reset5hIso: new Date(FIXED_NOW - 60 * 1000).toISOString(),
        util7d: null,
        reset7dIso: new Date(FIXED_NOW + 60 * 60 * 1000).toISOString(),
        hasSnapshot: true,
        reset5hPassed: true,
        reset7dPassed: false,
      },
    ];
    const rows = buildMetricsRows(makeData({ poolTokens: tokens }), null);
    const s = stringifyRows(rows);
    // 5h 側: "0%" bar + "*" マーカー
    expect(s).toContain("0%");
    expect(s).toContain('"*"');
    // 7d 側: placeholder
    expect(s).toContain("7d:  --");
    // 受け入れ条件 ②: 「値がない」と「reset 通過で 0」が同一行内で共存しても視覚的に区別される
  });
});
