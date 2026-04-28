/**
 * pool-status-header.test.ts (T374 / A024)
 *
 * 新仕様: 1 行 forecast スパークライン + next 候補表示。
 * 旧 (T323/T366) のボックス + capacity 二値テストは置換済み。
 */
import { describe, expect, test } from "bun:test";
import {
  buildPoolHeaderLines,
  mapBarToSparkline,
  pickSparklineColor,
  pickNextUtilColor,
  type PoolHeaderInput,
  type SparklineCell,
} from "./pool-status-header";

const FULL_FORECAST = {
  bars: [60, 70, 80, 90, 100, 110, 120],
  contributingTokens: 2,
};

const EMPTY_FORECAST = {
  bars: [0, 0, 0, 0, 0, 0, 0],
  contributingTokens: 0,
};

describe("buildPoolHeaderLines (T374)", () => {
  test("input が null なら空配列を返す", () => {
    expect(buildPoolHeaderLines(null)).toEqual([]);
  });

  test("有効入力 → spark + next を 1 行で返す", () => {
    const input: PoolHeaderInput = {
      forecast7d: FULL_FORECAST,
      nextCandidate: { handle: "@kddi", util_5h: 0.65, util_7d: 0.5 },
    };
    const lines = buildPoolHeaderLines(input);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("pool 7d  ");
    expect(lines[0]).toContain("next: @kddi 5h:65%");
  });

  test("nextCandidate=null + spark 有 → next: ⚠ no eligible account", () => {
    const lines = buildPoolHeaderLines({
      forecast7d: FULL_FORECAST,
      nextCandidate: null,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("pool 7d  ");
    expect(lines[0]).toContain("next: ⚠ no eligible account");
  });

  test("nextCandidate.util_5h=null + spark 有 → 5h:—", () => {
    const lines = buildPoolHeaderLines({
      forecast7d: FULL_FORECAST,
      nextCandidate: { handle: "@kddi", util_5h: null, util_7d: null },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("next: @kddi 5h:—");
  });

  test("contributingTokens=0 → spark 省略、next のみ", () => {
    const lines = buildPoolHeaderLines({
      forecast7d: EMPTY_FORECAST,
      nextCandidate: { handle: "@kddi", util_5h: 0.5, util_7d: 0.5 },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("pool 7d");
    expect(lines[0]).toContain("next: @kddi 5h:50%");
  });

  test("contributingTokens=0 + nextCandidate=null → next: ⚠ のみ", () => {
    const lines = buildPoolHeaderLines({
      forecast7d: EMPTY_FORECAST,
      nextCandidate: null,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("next: ⚠ no eligible account");
  });

  test("util_5h は四捨五入で表示（0.654 → 65%）", () => {
    const lines = buildPoolHeaderLines({
      forecast7d: FULL_FORECAST,
      nextCandidate: { handle: "@a", util_5h: 0.654, util_7d: null },
    });
    expect(lines[0]).toContain("5h:65%");
  });

  test("spark は 7 文字（forecast 全要素）", () => {
    const lines = buildPoolHeaderLines({
      forecast7d: { bars: [60, 70, 80, 90, 100, 110, 120], contributingTokens: 1 },
      nextCandidate: null,
    });
    // "pool 7d  XXXXXXX  next:..."
    const sparkMatch = lines[0]!.match(/pool 7d  (.{7})/u);
    expect(sparkMatch).toBeTruthy();
  });
});

describe("mapBarToSparkline (T374 / A024 §TUI 表示)", () => {
  test.each<[number, SparklineCell]>([
    [0, " "],
    [12.4999, " "],
    [12.5, "▁"],
    [25, "▂"],
    [37.5, "▃"],
    [50, "▄"],
    [62.5, "▅"],
    [75, "▆"],
    [87.5, "▇"],
    [99.9999, "▇"],
    [100, "█"],
    [150, "█"],
  ])("mapBarToSparkline(%f) === %p", (input, expected) => {
    expect(mapBarToSparkline(input)).toBe(expected);
  });

  test("負値は ' '（防御）", () => {
    expect(mapBarToSparkline(-1)).toBe(" ");
  });
});

describe("pickSparklineColor (T374 / A024 §TUI 表示)", () => {
  test("min >= 100 → green", () => {
    expect(pickSparklineColor([100, 110, 120, 100, 100, 100, 105])).toBe("green");
  });

  test("min >= 70 (and < 100) → yellow", () => {
    expect(pickSparklineColor([70, 100, 100, 100, 100, 100, 100])).toBe("yellow");
    expect(pickSparklineColor([99.9, 100, 100, 100, 100, 100, 100])).toBe("yellow");
  });

  test("min < 70 → red", () => {
    expect(pickSparklineColor([69.9, 100, 100, 100, 100, 100, 100])).toBe("red");
    expect(pickSparklineColor([0, 100, 100, 100, 100, 100, 100])).toBe("red");
  });

  test("空配列 → red（防御）", () => {
    expect(pickSparklineColor([])).toBe("red");
  });
});

describe("pickNextUtilColor (T374 / A024 §5h util の色)", () => {
  test("util_5h=null → gray", () => {
    expect(pickNextUtilColor(null)).toBe("gray");
  });

  test("util_5h > 0.95 → red", () => {
    expect(pickNextUtilColor(0.96)).toBe("red");
  });

  test("util_5h > 0.70 → yellow", () => {
    expect(pickNextUtilColor(0.71)).toBe("yellow");
  });

  test("util_5h <= 0.70 → green", () => {
    expect(pickNextUtilColor(0.70)).toBe("green");
    expect(pickNextUtilColor(0.0)).toBe("green");
  });

  test("境界: 0.95 ちょうど → yellow (>0.95 で red 切替)", () => {
    expect(pickNextUtilColor(0.95)).toBe("yellow");
  });
});
