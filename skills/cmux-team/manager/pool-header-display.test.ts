/**
 * pool-header-display.test.ts (T374 / A024)
 *
 * dashboard ヘッダー右側用の pool 表示 parts 純粋関数 unit test。
 * 旧 (T363/T366) capacity_5h/7d_pct の二値表示テストは置換済み。
 *
 * - pool 機能 OFF (`summary=null`) → parts=[]
 * - 有効入力 → spark part + next part の 2 要素
 * - 色閾値（spark / next 5h util）
 * - cross-validate: `buildPoolHeaderLines` (CLI 用) と同じ文字列を含む
 */
import { describe, expect, test } from "bun:test";
import { buildPoolHeaderDisplay } from "./pool-header-display";
import type { PoolSummary } from "./pool-summary";
import { buildPoolHeaderLines } from "./pool-status-header";
import type { Pool7dForecast } from "./forecast";
import type { PeekedToken } from "./token-store";

function makeSummary(args: {
  forecast?: Pool7dForecast;
  next?: PeekedToken | null;
}): PoolSummary {
  return {
    forecast7d: args.forecast ?? { bars: [0, 0, 0, 0, 0, 0, 0], contributingTokens: 0 },
    nextCandidate: args.next ?? null,
    perHandle: new Map(),
  };
}

describe("buildPoolHeaderDisplay (T374)", () => {
  test("summary=null → { parts: [] }", () => {
    expect(buildPoolHeaderDisplay(null)).toEqual({ parts: [] });
  });

  test("有効入力 → spark part + next part を含む", () => {
    const out = buildPoolHeaderDisplay(
      makeSummary({
        forecast: { bars: [108, 108, 71, 71, 71, 100, 100], contributingTokens: 2 },
        next: { handle: "@kddi", util_5h: 0.65, util_7d: 0.5 },
      }),
    );
    expect(out.parts).toHaveLength(2);
    expect(out.parts[0]?.text).toContain("pool 7d  ");
    expect(out.parts[0]?.group).toBe(true);
    expect(out.parts[1]?.text).toBe("next: @kddi 5h:65%");
    expect(out.parts[1]?.group).toBe(true);
  });

  test("contributingTokens=0 → spark part 省略、next part のみ", () => {
    const out = buildPoolHeaderDisplay(
      makeSummary({
        forecast: { bars: [0, 0, 0, 0, 0, 0, 0], contributingTokens: 0 },
        next: { handle: "@kddi", util_5h: 0.5, util_7d: 0.5 },
      }),
    );
    expect(out.parts).toHaveLength(1);
    expect(out.parts[0]?.text).toBe("next: @kddi 5h:50%");
  });

  test("nextCandidate=null → next: ⚠ no eligible account（yellow）", () => {
    const out = buildPoolHeaderDisplay(
      makeSummary({
        forecast: { bars: [100, 100, 100, 100, 100, 100, 100], contributingTokens: 1 },
        next: null,
      }),
    );
    expect(out.parts).toHaveLength(2);
    expect(out.parts[1]?.text).toBe("next: ⚠ no eligible account");
    expect(out.parts[1]?.color).toBe("yellow");
  });

  test("nextCandidate.util_5h=null → next: @handle 5h:— (gray)", () => {
    const out = buildPoolHeaderDisplay(
      makeSummary({
        forecast: { bars: [100, 100, 100, 100, 100, 100, 100], contributingTokens: 1 },
        next: { handle: "@kddi", util_5h: null, util_7d: null },
      }),
    );
    expect(out.parts[1]?.text).toBe("next: @kddi 5h:—");
    expect(out.parts[1]?.color).toBe("gray");
  });

  describe("色閾値（spark min ベース、A024 §TUI 表示）", () => {
    test("min >= 100 → green", () => {
      const out = buildPoolHeaderDisplay(
        makeSummary({
          forecast: { bars: [100, 110, 120, 100, 100, 100, 100], contributingTokens: 1 },
          next: { handle: "@a", util_5h: 0.1, util_7d: 0.1 },
        }),
      );
      expect(out.parts[0]?.color).toBe("green");
    });

    test("70 <= min < 100 → yellow", () => {
      const out = buildPoolHeaderDisplay(
        makeSummary({
          forecast: { bars: [70, 100, 100, 100, 100, 100, 100], contributingTokens: 1 },
          next: { handle: "@a", util_5h: 0.1, util_7d: 0.1 },
        }),
      );
      expect(out.parts[0]?.color).toBe("yellow");
    });

    test("min < 70 → red", () => {
      const out = buildPoolHeaderDisplay(
        makeSummary({
          forecast: { bars: [60, 100, 100, 100, 100, 100, 100], contributingTokens: 1 },
          next: { handle: "@a", util_5h: 0.1, util_7d: 0.1 },
        }),
      );
      expect(out.parts[0]?.color).toBe("red");
    });
  });

  describe("next 5h util の色（A024 §5h util の色）", () => {
    test("util_5h > 0.95 → red", () => {
      const out = buildPoolHeaderDisplay(
        makeSummary({
          forecast: { bars: [100, 100, 100, 100, 100, 100, 100], contributingTokens: 1 },
          next: { handle: "@a", util_5h: 0.96, util_7d: 0.1 },
        }),
      );
      expect(out.parts[1]?.color).toBe("red");
    });

    test("util_5h > 0.70 → yellow", () => {
      const out = buildPoolHeaderDisplay(
        makeSummary({
          forecast: { bars: [100, 100, 100, 100, 100, 100, 100], contributingTokens: 1 },
          next: { handle: "@a", util_5h: 0.71, util_7d: 0.1 },
        }),
      );
      expect(out.parts[1]?.color).toBe("yellow");
    });

    test("util_5h <= 0.70 → green", () => {
      const out = buildPoolHeaderDisplay(
        makeSummary({
          forecast: { bars: [100, 100, 100, 100, 100, 100, 100], contributingTokens: 1 },
          next: { handle: "@a", util_5h: 0.65, util_7d: 0.1 },
        }),
      );
      expect(out.parts[1]?.color).toBe("green");
    });
  });

  describe("CLI / dashboard cross-validate (T374)", () => {
    test("buildPoolHeaderLines と buildPoolHeaderDisplay は同じ文言を出す", () => {
      const summary = makeSummary({
        forecast: { bars: [108, 108, 71, 71, 71, 100, 100], contributingTokens: 2 },
        next: { handle: "@kddi", util_5h: 0.65, util_7d: 0.5 },
      });
      const cliLines = buildPoolHeaderLines({
        forecast7d: summary.forecast7d,
        nextCandidate: summary.nextCandidate,
      });
      const tui = buildPoolHeaderDisplay(summary);

      // CLI は 1 行に "spark + 2 spaces + next"、TUI は 2 parts
      expect(cliLines).toHaveLength(1);
      expect(tui.parts).toHaveLength(2);
      expect(cliLines[0]).toContain(tui.parts[0]!.text);
      expect(cliLines[0]).toContain(tui.parts[1]!.text);
    });

    test("contributingTokens=0 でも CLI / TUI で next 行が一致", () => {
      const summary = makeSummary({
        forecast: { bars: [0, 0, 0, 0, 0, 0, 0], contributingTokens: 0 },
        next: { handle: "@kddi", util_5h: 0.5, util_7d: 0.5 },
      });
      const cliLines = buildPoolHeaderLines({
        forecast7d: summary.forecast7d,
        nextCandidate: summary.nextCandidate,
      });
      const tui = buildPoolHeaderDisplay(summary);
      expect(cliLines[0]).toBe(tui.parts[0]!.text);
    });
  });
});
