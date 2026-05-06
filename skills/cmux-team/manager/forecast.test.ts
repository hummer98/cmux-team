/**
 * forecast.test.ts (T374 / A024)
 *
 * `computePool7dForecast` の純関数テスト。
 * - A024 §検証ケース 1 / 2 を回帰テストに落とし込む（許容誤差 ±1%）
 * - エッジケース（plan_ratio/null, util_7d/null, reset 過去 / >7d 先, selectable=false 等）
 * - スパークライン境界 reset の off-by-one（reset_7d_at が bin 境界に一致）
 * - DST safety (R3): America/New_York 春シフト相当日でも bars.length === 7 + finite
 */

import { describe, expect, it, test } from "bun:test";
import {
  computePool7dForecast,
  FORECAST_DAYS,
  type ForecastTokenInput,
} from "./forecast";

describe("computePool7dForecast", () => {
  describe("Case 1: 単純例（now = 00:00 UTC、Day 0 = 24h フル）", () => {
    const NOW_ISO = "2026-04-28T00:00:00.000Z";
    const TZ = "UTC";
    const tokens: ForecastTokenInput[] = [
      // A: util=0.5, hours_to_reset=48h → reset = NOW + 48h（境界 reset 値: Day 1 binEnd と一致）
      {
        handle: "@a",
        plan_ratio: 1,
        util_7d: 0.5,
        reset_7d_at: "2026-04-30T00:00:00.000Z",
        selectable: true,
      },
      // B: util=0.7, hours_to_reset=120h
      {
        handle: "@b",
        plan_ratio: 1,
        util_7d: 0.7,
        reset_7d_at: "2026-05-03T00:00:00.000Z",
        selectable: true,
      },
    ];
    // T444: BLOCKER_7D=0.95 反映後の expected 値（旧: [108, 108, 71, 71, 71, 100, 100]）
    const expected = [96, 96, 65, 65, 65, 95, 95];

    it("returns 7-element bars within ±1% of expected", () => {
      const f = computePool7dForecast(tokens, NOW_ISO, TZ);
      expect(f.bars).toHaveLength(FORECAST_DAYS);
      for (let i = 0; i < FORECAST_DAYS; i++) {
        expect(Math.abs(f.bars[i]! - expected[i]!)).toBeLessThanOrEqual(1);
      }
      expect(f.contributingTokens).toBe(2);
    });

    it("境界 reset (reset_7d_at が Day 1 binEnd=48h と一致) で off-by-one が起きない", () => {
      // R5 / m6: token A は reset がちょうど bin 境界に一致するケース
      // integrateBin の case 1 (binEnd <= reset) と case 2 (binStart >= reset) の等号包含を検証
      const f = computePool7dForecast(tokens, NOW_ISO, TZ);
      expect(Math.abs(f.bars[1]! - 96)).toBeLessThanOrEqual(1); // Day 1: pre-reset 全幅
      expect(Math.abs(f.bars[2]! - 65)).toBeLessThanOrEqual(1); // Day 2: post-reset 全幅
    });
  });

  describe("Case 2: bin straddle（now = 18:00 UTC、Day 0 = 6h）", () => {
    const NOW_ISO = "2026-04-28T18:00:00.000Z";
    const TZ = "UTC";
    const tokens: ForecastTokenInput[] = [
      // A: util=0.5, hours_to_reset=40h → reset = NOW + 40h
      {
        handle: "@a",
        plan_ratio: 1,
        util_7d: 0.5,
        reset_7d_at: "2026-04-30T10:00:00.000Z",
        selectable: true,
      },
      // B: util=0.7, hours_to_reset=120h
      {
        handle: "@b",
        plan_ratio: 1,
        util_7d: 0.7,
        reset_7d_at: "2026-05-03T18:00:00.000Z",
        selectable: true,
      },
    ];
    // T444: BLOCKER_7D=0.95 反映後の expected 値（旧: [126, 126, 94, 71, 71, 78, 100]）
    const expected = [112, 112, 85, 65, 65, 72, 95];

    it("returns 7-element bars within ±1% of expected", () => {
      const f = computePool7dForecast(tokens, NOW_ISO, TZ);
      expect(f.bars).toHaveLength(FORECAST_DAYS);
      for (let i = 0; i < FORECAST_DAYS; i++) {
        expect(Math.abs(f.bars[i]! - expected[i]!)).toBeLessThanOrEqual(1);
      }
    });
  });

  describe("エッジケース", () => {
    const NOW_ISO = "2026-04-28T00:00:00.000Z";
    const TZ = "UTC";

    it("util_7d == null は除外（denom にも入らない）", () => {
      const tokens: ForecastTokenInput[] = [
        {
          handle: "@a",
          plan_ratio: 1,
          util_7d: 0.5,
          reset_7d_at: "2026-04-30T00:00:00.000Z",
          selectable: true,
        },
        {
          handle: "@b",
          plan_ratio: 1,
          util_7d: null,
          reset_7d_at: "2026-05-03T00:00:00.000Z",
          selectable: true,
        },
      ];
      const f = computePool7dForecast(tokens, NOW_ISO, TZ);
      expect(f.contributingTokens).toBe(1);
      // T444: 単独 A: pre_rate = (0.95 - 0.5)/48 = 0.009375
      // Day 0 alloc = 24 * 0.009375 = 0.225, denom = 24/168 * 1 = 0.143, bar ≈ 158%
      // （B が denom に入らない、旧 175% → 新 158%）
      expect(f.bars[0]).toBeGreaterThan(150);
    });

    it("reset_7d_at == null は除外", () => {
      const tokens: ForecastTokenInput[] = [
        {
          handle: "@a",
          plan_ratio: 1,
          util_7d: 0.5,
          reset_7d_at: null,
          selectable: true,
        },
      ];
      const f = computePool7dForecast(tokens, NOW_ISO, TZ);
      expect(f.contributingTokens).toBe(0);
      expect(f.bars).toEqual([0, 0, 0, 0, 0, 0, 0]);
    });

    it("selectable=false は除外", () => {
      const tokens: ForecastTokenInput[] = [
        {
          handle: "@a",
          plan_ratio: 1,
          util_7d: 0.5,
          reset_7d_at: "2026-04-30T00:00:00.000Z",
          selectable: false,
        },
      ];
      const f = computePool7dForecast(tokens, NOW_ISO, TZ);
      expect(f.contributingTokens).toBe(0);
      expect(f.bars).toEqual([0, 0, 0, 0, 0, 0, 0]);
    });

    it("reset が過去なら post-reset rate (BLOCKER_7D/168) を全 bin に適用", () => {
      const tokens: ForecastTokenInput[] = [
        {
          handle: "@a",
          plan_ratio: 1,
          util_7d: 0.99, // 関係ない（post rate のみ使う）
          reset_7d_at: "2026-04-20T00:00:00.000Z", // 過去
          selectable: true,
        },
      ];
      const f = computePool7dForecast(tokens, NOW_ISO, TZ);
      expect(f.contributingTokens).toBe(1);
      // T444: post rate 全適用 → bar = ((bin_h * BLOCKER_7D/168) * 1) / ((bin_h/168) * 1) = BLOCKER_7D = 0.95 → 95%
      for (let i = 0; i < FORECAST_DAYS; i++) {
        expect(f.bars[i]).toBeCloseTo(95, 0);
      }
    });

    it("reset が >7d 先なら全 bin が pre-reset rate", () => {
      const tokens: ForecastTokenInput[] = [
        {
          handle: "@a",
          plan_ratio: 1,
          util_7d: 0.5,
          reset_7d_at: "2026-05-15T00:00:00.000Z", // 17 日後
          selectable: true,
        },
      ];
      const f = computePool7dForecast(tokens, NOW_ISO, TZ);
      expect(f.contributingTokens).toBe(1);
      // T444: pre rate = (0.95 - 0.5) / (17 * 24) = 0.45 / 408 = 0.001103
      // alloc per Day = 24 * 0.001103 = 0.02647
      // denom = 24/168 = 0.143
      // bar ≈ 18.5%（旧: 20.6%）
      for (let i = 0; i < FORECAST_DAYS; i++) {
        expect(f.bars[i]).toBeLessThan(25);
        expect(f.bars[i]).toBeGreaterThan(15);
      }
    });

    it("token 0 件 → bars=[0,0,0,0,0,0,0], contributingTokens=0", () => {
      const f = computePool7dForecast([], NOW_ISO, TZ);
      expect(f.contributingTokens).toBe(0);
      expect(f.bars).toEqual([0, 0, 0, 0, 0, 0, 0]);
    });

    it("plan_ratio == null は除外", () => {
      const tokens: ForecastTokenInput[] = [
        {
          handle: "@a",
          plan_ratio: null,
          util_7d: 0.5,
          reset_7d_at: "2026-04-30T00:00:00.000Z",
          selectable: true,
        },
      ];
      const f = computePool7dForecast(tokens, NOW_ISO, TZ);
      expect(f.contributingTokens).toBe(0);
      expect(f.bars).toEqual([0, 0, 0, 0, 0, 0, 0]);
    });

    it("bars 全要素が >100 でも数値超過を維持（UI 側で cap 表示）", () => {
      const tokens: ForecastTokenInput[] = [
        {
          handle: "@a",
          plan_ratio: 1,
          util_7d: 0.0, // 余裕たっぷり
          reset_7d_at: "2026-04-30T00:00:00.000Z",
          selectable: true,
        },
      ];
      const f = computePool7dForecast(tokens, NOW_ISO, TZ);
      // T444: pre rate = 0.95/48 = 0.01979/h, Day 0 alloc = 24 * 0.01979 = 0.475
      // denom = 24/168 = 0.143, bar ≈ 332.5%（旧: 350%）
      expect(f.bars[0]).toBeGreaterThan(300);
    });

    it("epoch sec 文字列の reset_7d_at を解釈できる（T372 と整合）", () => {
      // 2026-04-30T00:00:00Z = epoch 1777507200
      const tokens: ForecastTokenInput[] = [
        {
          handle: "@a",
          plan_ratio: 1,
          util_7d: 0.5,
          reset_7d_at: "1777507200",
          selectable: true,
        },
        {
          handle: "@b",
          plan_ratio: 1,
          util_7d: 0.7,
          reset_7d_at: "2026-05-03T00:00:00.000Z",
          selectable: true,
        },
      ];
      const f = computePool7dForecast(tokens, NOW_ISO, TZ);
      // Case 1 と同じ結果になるはず（T444: BLOCKER_7D 反映後）
      const expected = [96, 96, 65, 65, 65, 95, 95];
      for (let i = 0; i < FORECAST_DAYS; i++) {
        expect(Math.abs(f.bars[i]! - expected[i]!)).toBeLessThanOrEqual(1);
      }
    });

    it("reset_7d_at が解釈不能な文字列なら除外", () => {
      const tokens: ForecastTokenInput[] = [
        {
          handle: "@a",
          plan_ratio: 1,
          util_7d: 0.5,
          reset_7d_at: "garbage",
          selectable: true,
        },
      ];
      const f = computePool7dForecast(tokens, NOW_ISO, TZ);
      expect(f.contributingTokens).toBe(0);
    });
  });

  describe("DST safety (R3)", () => {
    it("America/New_York の DST 春シフト相当日でも bars.length === 7 かつ全 cell 有限", () => {
      // 2026-03-08 02:00 EST → 03:00 EDT に飛ぶ日。Day 0 はその日の残り時間
      const f = computePool7dForecast(
        [
          {
            handle: "@a",
            plan_ratio: 1,
            util_7d: 0.5,
            reset_7d_at: "2026-03-15T00:00:00.000Z",
            selectable: true,
          },
        ],
        "2026-03-08T05:00:00.000Z", // local = 00:00 EST、DST 切替前
        "America/New_York",
      );
      expect(f.bars).toHaveLength(FORECAST_DAYS);
      expect(f.bars.every((b) => Number.isFinite(b))).toBe(true);
    });

    it("America/New_York の DST 秋シフト相当日でも bars.length === 7", () => {
      // 2026-11-01 02:00 EDT → 01:00 EST。Day 0 が 25h 相当になる日
      const f = computePool7dForecast(
        [
          {
            handle: "@a",
            plan_ratio: 1,
            util_7d: 0.5,
            reset_7d_at: "2026-11-08T00:00:00.000Z",
            selectable: true,
          },
        ],
        "2026-11-01T04:00:00.000Z", // local = 00:00 EDT
        "America/New_York",
      );
      expect(f.bars).toHaveLength(FORECAST_DAYS);
      expect(f.bars.every((b) => Number.isFinite(b))).toBe(true);
    });
  });

  describe("plan_ratio 加重", () => {
    it("plan_ratio が異なる token を加重平均する", () => {
      const NOW_ISO = "2026-04-28T00:00:00.000Z";
      const TZ = "UTC";
      const tokens: ForecastTokenInput[] = [
        // A: plan_ratio=1, util=0.5, reset 48h → pre rate = 0.5/48
        {
          handle: "@a",
          plan_ratio: 1,
          util_7d: 0.5,
          reset_7d_at: "2026-04-30T00:00:00.000Z",
          selectable: true,
        },
        // B: plan_ratio=4, util=0.5, reset 48h → 同じ rate だが weight 4 倍
        {
          handle: "@b",
          plan_ratio: 4,
          util_7d: 0.5,
          reset_7d_at: "2026-04-30T00:00:00.000Z",
          selectable: true,
        },
      ];
      const f = computePool7dForecast(tokens, NOW_ISO, TZ);
      // T444: A と B は同じ rate なので、weighted average も同じ rate を反映する
      // pre_rate = (0.95 - 0.5) / 48 = 0.009375
      // alloc_a = 24 * 0.009375 = 0.225, alloc_b = 同じ = 0.225
      // pool = 0.225 * 1 + 0.225 * 4 = 1.125
      // denom = 24/168 * (1+4) = 0.714
      // bar = 1.125 / 0.714 ≈ 158%（旧: 175%）
      expect(f.bars[0]).toBeCloseTo(158, 0);
    });
  });

  describe("T444: BLOCKER_7D 反映", () => {
    const NOW_ISO = "2026-04-28T00:00:00.000Z";
    const TZ = "UTC";

    it("util_7d=0 のとき pre_rate = BLOCKER_7D / hoursToReset", () => {
      // A: util=0, reset=48h → pre_rate = 0.95 / 48 = 0.01979
      // Day 0 alloc = 24 × 0.01979 = 0.475, denom = 24/168 = 0.143
      // bar ≈ 332.5%
      const f = computePool7dForecast(
        [
          {
            handle: "@a",
            plan_ratio: 1,
            util_7d: 0,
            reset_7d_at: "2026-04-30T00:00:00.000Z",
            selectable: true,
          },
        ],
        NOW_ISO,
        TZ,
      );
      expect(f.bars[0]!).toBeGreaterThan(330);
      expect(f.bars[0]!).toBeLessThan(335);
    });

    it("util_7d > BLOCKER_7D のとき remaining=0 にクランプ（pre-reset alloc=0）", () => {
      // A: util=0.97 (>0.95), reset=48h → remaining=0 → pre alloc=0
      // Day 0/1: pre 全幅 → bar=0
      // Day 2 以降: post_rate × 24 / (24/168) = 0.95 × 100 = 95%
      const f = computePool7dForecast(
        [
          {
            handle: "@a",
            plan_ratio: 1,
            util_7d: 0.97,
            reset_7d_at: "2026-04-30T00:00:00.000Z",
            selectable: true,
          },
        ],
        NOW_ISO,
        TZ,
      );
      expect(f.bars[0]!).toBeCloseTo(0, 1);
      expect(f.bars[1]!).toBeCloseTo(0, 1);
      expect(f.bars[2]!).toBeCloseTo(95, 0);
      expect(f.bars[6]!).toBeCloseTo(95, 0);
    });

    it("全 token util_7d=0 で reset 過去 → bar=BLOCKER_7D×100=95% (Day 0..6)", () => {
      // post_rate 全 bin → bar = BLOCKER_7D × 100
      const f = computePool7dForecast(
        [
          {
            handle: "@a",
            plan_ratio: 1,
            util_7d: 0,
            reset_7d_at: "2026-04-20T00:00:00.000Z",
            selectable: true,
          },
        ],
        NOW_ISO,
        TZ,
      );
      for (let i = 0; i < FORECAST_DAYS; i++) {
        expect(f.bars[i]!).toBeCloseTo(95, 0);
      }
    });

    it("sustainable rate post-reset が BLOCKER_7D / 168", () => {
      // util=0.99 reset 過去（pre 経路に入らない）→ post_rate のみで全 bin が 95%
      const f = computePool7dForecast(
        [
          {
            handle: "@a",
            plan_ratio: 1,
            util_7d: 0.99,
            reset_7d_at: "2026-04-20T00:00:00.000Z",
            selectable: true,
          },
        ],
        NOW_ISO,
        TZ,
      );
      for (let i = 0; i < FORECAST_DAYS; i++) {
        expect(f.bars[i]!).toBeCloseTo(95, 0); // BLOCKER_7D × 100
      }
    });
  });
});
