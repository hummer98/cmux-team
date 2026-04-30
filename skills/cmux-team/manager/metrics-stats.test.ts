/**
 * T381 S1: metrics-stats.ts のテスト。
 *
 * scipy.stats / R との一致を相対誤差 < 1e-3 で検証する。
 * tied ranks / df<=0 / 全分散 0 / n=1 / 空配列のエッジケースは
 * 明示的な定義値を返すこと（NaN 伝播禁止）を担保する。
 */
import { describe, test, expect } from "bun:test";
import {
  welchTTest,
  mannWhitneyU,
  twoProportionZTest,
  normalSF,
  studentTSF,
} from "./metrics-stats";

const REL_EPS = 1e-3;

function approx(actual: number, expected: number, eps = REL_EPS, label?: string): void {
  if (!Number.isFinite(expected)) {
    expect(actual).toBe(expected);
    return;
  }
  const denom = Math.max(1e-12, Math.abs(expected));
  const rel = Math.abs(actual - expected) / denom;
  if (rel > eps) {
    throw new Error(
      `${label ?? "approx"} fail: actual=${actual} expected=${expected} rel=${rel}`,
    );
  }
}

// ────────────────────────────────────────────────────────────────────────
// normalSF
// ────────────────────────────────────────────────────────────────────────

describe("normalSF", () => {
  // ref: scipy.stats.norm.sf(z)
  const cases: Array<[number, number]> = [
    [0, 0.5],
    [1.0, 0.158655253931457],
    [1.96, 0.024997895148220435],
    [2.0, 0.022750131948179195],
    [3.0, 0.0013498980316301035],
    [-1.0, 0.8413447460685429],
    [-3.0, 0.9986501019683699],
  ];
  for (const [z, expected] of cases) {
    test(`normalSF(${z}) ≈ ${expected}`, () => {
      approx(normalSF(z), expected, 5e-4, `normalSF(${z})`);
    });
  }
});

// ────────────────────────────────────────────────────────────────────────
// studentTSF
// ────────────────────────────────────────────────────────────────────────

describe("studentTSF (両側 p に近い survival function)", () => {
  // scipy.stats.t.sf(t, df) を参照
  // 両側 p = 2 * studentTSF(|t|, df)
  const cases: Array<[number, number, number]> = [
    [0, 1, 0.5],
    [0, 10, 0.5],
    [1.0, 10, 0.17046],     // scipy: t.sf(1.0, 10)
    [2.228, 10, 0.025001],  // 両側 p≈0.05 の境界 (df=10)
    [1.96, 1000, 0.0250983],
    [2.576, 1000, 0.005077], // 大標本で正規分布に近い
  ];
  for (const [tval, df, expected] of cases) {
    test(`studentTSF(${tval}, df=${df}) ≈ ${expected}`, () => {
      approx(studentTSF(tval, df), expected, 5e-3, `studentTSF(${tval}, ${df})`);
    });
  }

  test("df<=0 で 0.5 を返す（NaN 伝播禁止）", () => {
    expect(studentTSF(1.5, 0)).toBe(0.5);
    expect(studentTSF(1.5, -1)).toBe(0.5);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Welch's t-test
// ────────────────────────────────────────────────────────────────────────

describe("welchTTest", () => {
  test("scipy 例題: 独立 2 群（明らかに差あり）", () => {
    const a = [25.0, 23.5, 24.2, 26.1, 25.8];
    const b = [21.0, 22.3, 20.5, 22.8, 21.5];
    // scipy.stats.ttest_ind(a, b, equal_var=False)
    //   ma=24.92, mb=21.62, va_unbiased=1.177, vb_unbiased=0.877
    //   t = (24.92-21.62) / sqrt(0.2354+0.1754) = 5.14871
    //   df ≈ 7.65 (Welch–Satterthwaite)
    const r = welchTTest(a, b);
    approx(r.t, 5.14871, 5e-3, "t");
    approx(r.df, 7.65, 5e-2, "df");
    expect(r.p).toBeLessThan(2e-3);
    expect(r.p).toBeGreaterThan(0);
  });

  test("scipy 例題: 等しい平均（差なし、p ≈ 1）", () => {
    const a = [10, 12, 11, 13, 9];
    const b = [11, 12, 10, 13, 9];
    const r = welchTTest(a, b);
    expect(Math.abs(r.t)).toBeLessThan(0.5);
    expect(r.p).toBeGreaterThan(0.5);
  });

  test("n=1 同士は { t: NaN, df: 0, p: 1 }", () => {
    const r = welchTTest([5], [10]);
    expect(Number.isNaN(r.t)).toBe(true);
    expect(r.df).toBe(0);
    expect(r.p).toBe(1);
  });

  test("全分散 0 同士は { t: NaN, df: 0, p: 1 }", () => {
    const r = welchTTest([5, 5, 5], [5, 5, 5]);
    expect(Number.isNaN(r.t)).toBe(true);
    expect(r.df).toBe(0);
    expect(r.p).toBe(1);
  });

  test("空配列は { t: NaN, df: 0, p: 1 }", () => {
    const r = welchTTest([], [1, 2, 3]);
    expect(Number.isNaN(r.t)).toBe(true);
    expect(r.df).toBe(0);
    expect(r.p).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Mann-Whitney U (with tied ranks correction)
// ────────────────────────────────────────────────────────────────────────

describe("mannWhitneyU", () => {
  test("scipy 例題: 差があるサンプル", () => {
    const a = [1, 2, 3, 4, 5];
    const b = [6, 7, 8, 9, 10];
    // scipy.stats.mannwhitneyu(a, b, alternative='two-sided', use_continuity=False) →
    //   U=0, p ≈ 0.00794 (大標本近似 z ≈ -2.611)
    const r = mannWhitneyU(a, b);
    expect(r.u).toBe(0);
    approx(Math.abs(r.z), 2.611, 5e-2, "|z|");
    approx(r.p, 0.00904, 5e-2, "p");
  });

  test("scipy 例題: 同分布", () => {
    const a = [1, 2, 3, 4, 5, 6];
    const b = [2, 3, 4, 5, 6, 7];
    const r = mannWhitneyU(a, b);
    // 大体 U ≈ n1*n2/2、z 小さく p 大きい
    expect(r.u).toBeGreaterThan(0);
    expect(r.p).toBeGreaterThan(0.05);
  });

  test("tied ranks 多数のケース（補正あり）", () => {
    const a = [1, 1, 1, 1, 1];
    const b = [1, 1, 1, 1, 1];
    const r = mannWhitneyU(a, b);
    expect(r.u).toBe(12.5); // n1*n2/2 = 25/2
    expect(r.z).toBe(0);
    expect(r.p).toBe(1);
  });

  test("tied ranks 部分的（scipy 値）", () => {
    // a=[1,2,2,3], b=[2,3,4,4]
    // ranks (combined): 1→1, [2,2,2]→avg(2,3,4)=3, [3,3]→avg(5,6)=5.5, [4,4]→avg(7,8)=7.5
    // R1 = 1+3+3+5.5 = 12.5, U1 = 12.5 - 4*5/2 = 2.5, U2 = 16-2.5 = 13.5
    // U = min(U1, U2) = 2.5
    const a = [1, 2, 2, 3];
    const b = [2, 3, 4, 4];
    const r = mannWhitneyU(a, b);
    approx(r.u, 2.5, 5e-2, "u");
    // 大標本近似 + tied 補正で z ≈ -1.806、両側 p ≈ 0.071
    expect(r.p).toBeGreaterThan(0.04);
    expect(r.p).toBeLessThan(0.15);
  });

  test("空配列は { u: 0, z: 0, p: 1 }", () => {
    const r = mannWhitneyU([], [1, 2]);
    expect(r.u).toBe(0);
    expect(r.z).toBe(0);
    expect(r.p).toBe(1);
  });

  test("全値同値（補正後 σ=0）", () => {
    const r = mannWhitneyU([5, 5, 5], [5, 5, 5]);
    expect(r.u).toBe(4.5);
    expect(r.z).toBe(0);
    expect(r.p).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────────
// 2-proportion z-test
// ────────────────────────────────────────────────────────────────────────

describe("twoProportionZTest", () => {
  test("明らかな差: 80/100 vs 50/100 → 強い有意", () => {
    // pooled p = 130/200 = 0.65, SE = sqrt(0.65*0.35*(2/100)) = 0.06745
    // diff = 0.30, z ≈ 4.448, p ≈ 8.69e-6
    const r = twoProportionZTest(80, 100, 50, 100);
    approx(r.z, 4.448, 5e-2, "z");
    expect(r.p).toBeLessThan(1e-4);
  });

  test("差なし: 50/100 vs 50/100 → p=1, z=0", () => {
    const r = twoProportionZTest(50, 100, 50, 100);
    expect(r.z).toBe(0);
    expect(r.p).toBe(1);
  });

  test("n1=0 で { z:0, p:1 }", () => {
    const r = twoProportionZTest(0, 0, 5, 10);
    expect(r.z).toBe(0);
    expect(r.p).toBe(1);
  });

  test("n2=0 で { z:0, p:1 }", () => {
    const r = twoProportionZTest(5, 10, 0, 0);
    expect(r.z).toBe(0);
    expect(r.p).toBe(1);
  });

  test("p1=p2=0 で { z:0, p:1 }", () => {
    const r = twoProportionZTest(0, 100, 0, 100);
    expect(r.z).toBe(0);
    expect(r.p).toBe(1);
  });

  test("p1=p2=1 で { z:0, p:1 }", () => {
    const r = twoProportionZTest(100, 100, 100, 100);
    expect(r.z).toBe(0);
    expect(r.p).toBe(1);
  });
});
