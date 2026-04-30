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
    roleRows: [],
    taskRows: [],
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

describe("buildMetricsRows: role / task aggregations (T354 S9 桁揃え)", () => {
  test("ロール行が表示され、数値列が padStart(12) で揃う", () => {
    const data = makeData({
      roleRows: [
        {
          role: "master",
          requests: 5,
          input: 2000,
          output: 800,
          cache: 0,
          cache_read: 0,
        },
        {
          role: "agent",
          requests: 10,
          input: 5000,
          output: 2000,
          cache: 1000,
          cache_read: 500,
        },
      ],
      taskRows: [
        { task_id: "T001", requests: 3, input: 1000, output: 500, cache: 200 },
      ],
    });
    const rows = buildMetricsRows(data, null);
    const s = stringifyRows(rows);
    expect(s).toContain("master");
    expect(s).toContain("agent");
    expect(s).toContain("T001");
    // 数値が padStart(12) で 12 桁右寄せになっている
    // "5" は 11 スペース + "5"
    expect(s).toContain("           5");
    // "5,000" は 7 スペース + "5,000"
    expect(s).toContain("       5,000");
  });

  test("空 roleRows / 空 taskRows → empty メッセージ", () => {
    const rows = buildMetricsRows(makeData({ roleRows: [], taskRows: [] }), null);
    const s = stringifyRows(rows).toLowerCase();
    expect(
      s.includes("no ") ||
        s.includes("(none)") ||
        s.includes("—") ||
        s.includes("なし"),
    ).toBe(true);
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
