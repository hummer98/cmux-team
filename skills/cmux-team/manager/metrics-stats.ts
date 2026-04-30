/**
 * T381 S1: 純粋統計関数群（外部依存なし）。
 *
 * - Welch's t-test（連続値の平均差）
 * - Mann-Whitney U（順序統計、tied ranks 補正あり、大標本近似）
 * - 2-proportion z-test（比率系 metric）
 *
 * すべてのエッジケースで NaN を伝播させず、明示的な定義値を返す:
 *   - n=1 同士 / 全分散 0 / 空配列      → { t: NaN, df: 0, p: 1 }
 *   - mannWhitney: 空配列 / 全値同値    → { u: n1*n2/2, z: 0, p: 1 }
 *   - 2-proportion: n=0 / p1=p2 で SE=0 → { z: 0, p: 1 }
 *
 * 数値近似:
 *   - normalSF: Abramowitz & Stegun 26.2.17 ベースの有理近似
 *   - studentTSF: regularized incomplete beta（Lentz の continued fraction）
 *
 * spec: T381 plan.md S1
 */

// ────────────────────────────────────────────────────────────────────────
// 標準正規 SF (1 - CDF)
// ────────────────────────────────────────────────────────────────────────

/**
 * 標準正規分布の survival function (P(Z > z))。
 * 誤差約 7.5e-8（A&S 26.2.17 の有理近似 with erf 関係式）。
 */
export function normalSF(z: number): number {
  // P(Z > z) = 0.5 * erfc(z / sqrt(2))
  return 0.5 * erfc(z / Math.SQRT2);
}

/** 補誤差関数 erfc(x) = 1 - erf(x)。Numerical Recipes Ch.6 の chebyshev 近似（精度 1.2e-7）。 */
function erfc(x: number): number {
  const t = 1.0 / (1.0 + 0.5 * Math.abs(x));
  const ans =
    t *
    Math.exp(
      -x * x -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t *
                          (0.27886807 +
                            t *
                              (-1.13520398 +
                                t *
                                  (1.48851587 +
                                    t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? ans : 2.0 - ans;
}

// ────────────────────────────────────────────────────────────────────────
// Student-t survival function
// ────────────────────────────────────────────────────────────────────────

/**
 * Student-t survival function P(T > t) for df > 0.
 * df<=0 で 0.5 を返す（NaN 伝播禁止）。
 *
 * 内部的には regularized incomplete beta function を使う:
 *   P(T > t) = 0.5 * I_x(df/2, 0.5)   where x = df / (df + t^2)
 *   for t >= 0; t<0 は 1 - SF(-t)。
 */
export function studentTSF(t: number, df: number): number {
  if (df <= 0 || !Number.isFinite(df)) return 0.5;
  if (!Number.isFinite(t)) return t > 0 ? 0 : 1;
  if (t === 0) return 0.5;

  const x = df / (df + t * t);
  const ib = regularizedIncompleteBeta(x, df / 2, 0.5);
  const sf = 0.5 * ib;
  return t > 0 ? sf : 1 - sf;
}

/** ln Gamma function via Lanczos approximation (g=7). */
function lnGamma(z: number): number {
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) {
    // Reflection: Γ(z)Γ(1-z) = π / sin(π z)
    return (
      Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z)
    );
  }
  z -= 1;
  let x = c[0]!;
  for (let i = 1; i < g + 2; i++) x += c[i]! / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

/** Regularized incomplete beta I_x(a, b). Numerical Recipes Ch.6 の continued fraction（Lentz）。 */
function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  const lbeta = lnGamma(a + b) - lnGamma(a) - lnGamma(b);
  const front = Math.exp(lbeta + a * Math.log(x) + b * Math.log(1 - x));

  // Use the symmetry I_x(a,b) = 1 - I_{1-x}(b,a) when x > (a+1)/(a+b+2)
  if (x > (a + 1) / (a + b + 2)) {
    return 1 - regularizedIncompleteBeta(1 - x, b, a);
  }

  // Lentz's continued fraction for I_x(a,b)
  const fpmin = 1e-30;
  const maxIter = 200;
  const eps = 3e-15;

  let qab = a + b;
  let qap = a + 1;
  let qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < fpmin) d = fpmin;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= maxIter; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpmin) d = fpmin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpmin) c = fpmin;
    d = 1 / d;
    h *= d * c;

    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpmin) d = fpmin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpmin) c = fpmin;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < eps) break;
  }
  return (front * h) / a;
}

// ────────────────────────────────────────────────────────────────────────
// Welch's t-test
// ────────────────────────────────────────────────────────────────────────

export interface WelchResult {
  t: number;
  df: number;
  /** 両側 p-value */
  p: number;
}

function meanOf(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function sampleVariance(xs: number[], m: number): number {
  // 不偏分散（n-1 で割る）
  let s = 0;
  for (const x of xs) {
    const d = x - m;
    s += d * d;
  }
  return s / (xs.length - 1);
}

/**
 * Welch's t-test (independent two-sample, unequal variance)。
 * 戻り値の p は両側。
 *
 * エッジケース:
 *  - 各群の n < 2、または両群とも分散 0、あるいは df<=0 → { t: NaN, df: 0, p: 1 }
 */
export function welchTTest(a: number[], b: number[]): WelchResult {
  if (a.length < 2 || b.length < 2) {
    return { t: NaN, df: 0, p: 1 };
  }
  const ma = meanOf(a);
  const mb = meanOf(b);
  const va = sampleVariance(a, ma);
  const vb = sampleVariance(b, mb);
  const na = a.length;
  const nb = b.length;
  const sea = va / na;
  const seb = vb / nb;
  const seSum = sea + seb;
  if (seSum === 0) {
    return { t: NaN, df: 0, p: 1 };
  }
  const t = (ma - mb) / Math.sqrt(seSum);
  // Welch–Satterthwaite df
  const dfDen =
    (sea * sea) / (na - 1) + (seb * seb) / (nb - 1);
  const df = dfDen === 0 ? 0 : (seSum * seSum) / dfDen;
  if (df <= 0 || !Number.isFinite(t)) {
    return { t: NaN, df: 0, p: 1 };
  }
  const p = 2 * studentTSF(Math.abs(t), df);
  return { t, df, p: Math.min(1, Math.max(0, p)) };
}

// ────────────────────────────────────────────────────────────────────────
// Mann-Whitney U
// ────────────────────────────────────────────────────────────────────────

export interface MannWhitneyResult {
  u: number;
  z: number;
  /** 両側 p-value（大標本近似） */
  p: number;
}

/**
 * Mann-Whitney U (Wilcoxon rank-sum)、tied ranks 補正あり、大標本近似で p を出す。
 *
 * エッジケース:
 *  - 空配列        → { u: 0, z: 0, p: 1 }
 *  - 全値同値      → { u: n1*n2/2, z: 0, p: 1 } (補正後 σ=0 で z 不能)
 */
export function mannWhitneyU(a: number[], b: number[]): MannWhitneyResult {
  const n1 = a.length;
  const n2 = b.length;
  if (n1 === 0 || n2 === 0) return { u: 0, z: 0, p: 1 };

  // 結合してランク付与
  type Tagged = { v: number; group: 0 | 1 };
  const merged: Tagged[] = [];
  for (const v of a) merged.push({ v, group: 0 });
  for (const v of b) merged.push({ v, group: 1 });
  merged.sort((x, y) => x.v - y.v);

  // tied ranks: 同値の連続区間に対して平均ランクを与える
  const ranks = new Array<number>(merged.length);
  const tieGroups: number[] = []; // 各 tie の長さ t_j
  let i = 0;
  while (i < merged.length) {
    let j = i;
    while (j + 1 < merged.length && merged[j + 1]!.v === merged[i]!.v) j++;
    const avg = (i + j) / 2 + 1; // 1-based のランク平均
    for (let k = i; k <= j; k++) ranks[k] = avg;
    tieGroups.push(j - i + 1);
    i = j + 1;
  }

  let r1 = 0;
  for (let k = 0; k < merged.length; k++) {
    if (merged[k]!.group === 0) r1 += ranks[k]!;
  }
  const u1 = r1 - (n1 * (n1 + 1)) / 2;
  const u2 = n1 * n2 - u1;
  const u = Math.min(u1, u2);

  const N = n1 + n2;
  const meanU = (n1 * n2) / 2;

  // 同値補正項: ΣT_j / (N(N-1)) ; T_j = t_j^3 - t_j
  let tieSum = 0;
  for (const t of tieGroups) tieSum += t * t * t - t;

  const variance =
    N <= 1
      ? 0
      : ((n1 * n2) / 12) * (N + 1 - tieSum / (N * (N - 1)));

  if (variance <= 0) {
    return { u: meanU, z: 0, p: 1 };
  }
  const sigma = Math.sqrt(variance);
  // 連続性補正なしの z（scipy の use_continuity=False と同じ）
  const z = (u1 - meanU) / sigma;
  const p = 2 * normalSF(Math.abs(z));
  return { u, z, p: Math.min(1, Math.max(0, p)) };
}

// ────────────────────────────────────────────────────────────────────────
// 2-proportion z-test
// ────────────────────────────────────────────────────────────────────────

export interface TwoProportionResult {
  z: number;
  /** 両側 p-value */
  p: number;
}

/**
 * 2-proportion z-test (pooled variance)。比率系 metric の差を検定する。
 *
 * エッジケース:
 *  - n1=0 / n2=0           → { z: 0, p: 1 }
 *  - p1==p2 (差ゼロ)       → { z: 0, p: 1 } （pooled SE=0 のケース含む）
 */
export function twoProportionZTest(
  x1: number,
  n1: number,
  x2: number,
  n2: number,
): TwoProportionResult {
  if (n1 <= 0 || n2 <= 0) return { z: 0, p: 1 };
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  if (p1 === p2) return { z: 0, p: 1 };
  const pPool = (x1 + x2) / (n1 + n2);
  const seSq = pPool * (1 - pPool) * (1 / n1 + 1 / n2);
  if (seSq <= 0) return { z: 0, p: 1 };
  const z = (p1 - p2) / Math.sqrt(seSq);
  const p = 2 * normalSF(Math.abs(z));
  return { z, p: Math.min(1, Math.max(0, p)) };
}
