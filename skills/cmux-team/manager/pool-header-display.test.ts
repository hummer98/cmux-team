/**
 * pool-header-display.test.ts (T363)
 *
 * dashboard ヘッダー右側用の pool capacity parts を組み立てる純粋関数 unit test。
 *
 * - case 1-7: capacityPct と色閾値（>= 100 green / >= 40 yellow / < 40 red）
 * - case 8-10: nextReset の整形（remainingMs / deltaPct 符号 / <1m）
 * - case 11: parts[0]?.group === true（rate-limit-display と整合）
 */
import { describe, test, expect } from "bun:test";
import { buildPoolHeaderDisplay } from "./pool-header-display";
import type { PoolSummary } from "./pool-summary";
import type { PoolHeaderNextReset } from "./pool-status-header";

function makeSummary(
  capacityPct: number,
  nextReset: PoolHeaderNextReset | null = null,
): PoolSummary {
  return {
    header: { capacityPct, nextReset },
    perHandle: new Map(),
  };
}

describe("buildPoolHeaderDisplay (T363)", () => {
  test("case 1: summary=null → { parts: [] }", () => {
    expect(buildPoolHeaderDisplay(null)).toEqual({ parts: [] });
  });

  test("case 2: capacityPct=173, nextReset=null → green", () => {
    const out = buildPoolHeaderDisplay(makeSummary(173));
    expect(out.parts).toHaveLength(1);
    expect(out.parts[0]?.text).toContain("pool capacity: 173%");
    expect(out.parts[0]?.color).toBe("green");
  });

  test("case 3: capacityPct=60 → yellow", () => {
    const out = buildPoolHeaderDisplay(makeSummary(60));
    expect(out.parts[0]?.color).toBe("yellow");
  });

  test("case 4: capacityPct=30 → red", () => {
    const out = buildPoolHeaderDisplay(makeSummary(30));
    expect(out.parts[0]?.color).toBe("red");
  });

  test("case 5: capacityPct=100 境界 → green (>= 100%)", () => {
    const out = buildPoolHeaderDisplay(makeSummary(100));
    expect(out.parts[0]?.color).toBe("green");
  });

  test("case 6: capacityPct=40 境界 → yellow (40-100%)", () => {
    const out = buildPoolHeaderDisplay(makeSummary(40));
    expect(out.parts[0]?.color).toBe("yellow");
  });

  test("case 7: capacityPct=39.9 → red (< 40%)", () => {
    const out = buildPoolHeaderDisplay(makeSummary(39.9));
    expect(out.parts[0]?.color).toBe("red");
  });

  test("case 8: nextReset 有 → next reset part が追加される (gray)", () => {
    const summary = makeSummary(80, {
      handle: "@kddi",
      window: "5h",
      remainingMs: 30 * 60 * 1000, // 30m
      deltaPct: 20,
    });
    const out = buildPoolHeaderDisplay(summary);
    expect(out.parts).toHaveLength(2);
    expect(out.parts[1]?.text).toContain("next reset:");
    expect(out.parts[1]?.text).toContain("@kddi");
    expect(out.parts[1]?.text).toContain("5h");
    expect(out.parts[1]?.text).toContain("in 30m");
    expect(out.parts[1]?.text).toContain("(+20 pts)");
    expect(out.parts[1]?.color).toBe("gray");
  });

  test("case 9: deltaPct < 0 → '(-N pts)', deltaPct === 0 → '(+0 pts)'", () => {
    const negative = buildPoolHeaderDisplay(
      makeSummary(80, {
        handle: "@kddi",
        window: "5h",
        remainingMs: 30 * 60 * 1000,
        deltaPct: -5,
      }),
    );
    expect(negative.parts[1]?.text).toContain("(-5 pts)");

    const zero = buildPoolHeaderDisplay(
      makeSummary(80, {
        handle: "@kddi",
        window: "7d",
        remainingMs: 30 * 60 * 1000,
        deltaPct: 0,
      }),
    );
    expect(zero.parts[1]?.text).toContain("(+0 pts)");
  });

  test("case 10: remainingMs < 60_000 → '<1m'", () => {
    const out = buildPoolHeaderDisplay(
      makeSummary(80, {
        handle: "@kddi",
        window: "5h",
        remainingMs: 30 * 1000,
        deltaPct: 10,
      }),
    );
    expect(out.parts[1]?.text).toContain("in <1m");
  });

  test("case 11: parts[0]?.group === true (dashboard 側の間隔挿入が rate-limit と整合)", () => {
    const out = buildPoolHeaderDisplay(makeSummary(50));
    expect(out.parts[0]?.group).toBe(true);
  });

  // 追加: formatRelativeDuration の cross-validate（pool-status-header.ts と等価）
  test("formatRelativeDuration: 2h30m / 3d2h / 2h / 3d", () => {
    const cases: Array<[number, string]> = [
      [2 * 3600 * 1000 + 30 * 60 * 1000, "2h30m"],
      [3 * 86400 * 1000 + 2 * 3600 * 1000, "3d2h"],
      [2 * 3600 * 1000, "2h"],
      [3 * 86400 * 1000, "3d"],
    ];
    for (const [ms, expected] of cases) {
      const out = buildPoolHeaderDisplay(
        makeSummary(80, {
          handle: "@kddi",
          window: "5h",
          remainingMs: ms,
          deltaPct: 0,
        }),
      );
      expect(out.parts[1]?.text).toContain(`in ${expected}`);
    }
  });
});
