/**
 * T354 (F2): computeMetricsVisibleLines / RESERVED_LINES の純粋関数テスト。
 *
 * dashboard.tsx の Metrics タブスクロール正常化 (S11) の中核。
 * stdoutRows / envOverride を引数で受けるため、process.stdout や env を
 * モックせず直接 input/output を比較できる。
 */
import { describe, test, expect } from "bun:test";
import {
  computeMetricsVisibleLines,
  RESERVED_LINES,
} from "./dashboard";

describe("computeMetricsVisibleLines (T354 F2)", () => {
  test("RESERVED_LINES が export されている（テスト参照可能）", () => {
    expect(typeof RESERVED_LINES).toBe("number");
    expect(RESERVED_LINES).toBeGreaterThan(0);
  });

  test("env 上書きが最優先（範囲内）", () => {
    expect(computeMetricsVisibleLines(50, "20")).toBe(20);
  });

  test("env 上書き値も [8, 80] で clamp", () => {
    expect(computeMetricsVisibleLines(50, "5")).toBe(8);
    expect(computeMetricsVisibleLines(50, "200")).toBe(80);
  });

  test("env が NaN / 0 / 負 → 通常パスへフォールバック", () => {
    // stdoutRows=50, RESERVED=14 → 36
    const expected = 50 - RESERVED_LINES;
    expect(computeMetricsVisibleLines(50, "abc")).toBe(expected);
    expect(computeMetricsVisibleLines(50, "0")).toBe(expected);
    expect(computeMetricsVisibleLines(50, "-5")).toBe(expected);
  });

  test("通常パス: 50 行 - RESERVED → clamp 範囲内", () => {
    const v = computeMetricsVisibleLines(50, undefined);
    expect(v).toBe(Math.max(8, Math.min(80, 50 - RESERVED_LINES)));
  });

  test("過小ターミナル (8 行) → 8 で下限 clamp", () => {
    expect(computeMetricsVisibleLines(8, undefined)).toBe(8);
  });

  test("過大ターミナル (200 行) → 80 で上限 clamp", () => {
    expect(computeMetricsVisibleLines(200, undefined)).toBe(80);
  });

  test("stdoutRows=undefined → デフォルト想定で計算（30 + RESERVED）", () => {
    const v = computeMetricsVisibleLines(undefined, undefined);
    expect(v).toBeGreaterThanOrEqual(8);
    expect(v).toBeLessThanOrEqual(80);
  });
});
