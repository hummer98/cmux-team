/**
 * sleep-prevention の正規化と解決ロジックのテスト（T419）。
 *
 * - schema.ts: normalizeSleepPrevention（生値 → SleepPreventionMode）
 * - config.ts: resolveSleepPrevention（CLI / config 優先順位）
 *
 * boolean 後方互換とエラー fail-fast を中心にカバーする。
 */
import { describe, test, expect } from "bun:test";
import { normalizeSleepPrevention, SleepPreventionMode } from "./schema";
import { resolveSleepPrevention } from "./config";
import type { TeamConfig } from "./config";

// ─────────────────────────────────────────────────────────────────────────────
// SleepPreventionMode (zod enum)
// ─────────────────────────────────────────────────────────────────────────────

describe("SleepPreventionMode", () => {
  test("3 値のみ受理する", () => {
    expect(SleepPreventionMode.safeParse("off").success).toBe(true);
    expect(SleepPreventionMode.safeParse("idle").success).toBe(true);
    expect(SleepPreventionMode.safeParse("aggressive").success).toBe(true);
  });

  test("未知の値は reject", () => {
    expect(SleepPreventionMode.safeParse("on").success).toBe(false);
    expect(SleepPreventionMode.safeParse("dis").success).toBe(false);
    expect(SleepPreventionMode.safeParse("").success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// normalizeSleepPrevention
// ─────────────────────────────────────────────────────────────────────────────

describe("normalizeSleepPrevention", () => {
  test("undefined → \"aggressive\"（デフォルト）", () => {
    expect(normalizeSleepPrevention(undefined)).toBe("aggressive");
  });

  test("null → \"aggressive\"（デフォルト）", () => {
    expect(normalizeSleepPrevention(null)).toBe("aggressive");
  });

  test("boolean true → \"aggressive\"（後方互換）", () => {
    expect(normalizeSleepPrevention(true)).toBe("aggressive");
  });

  test("boolean false → \"off\"（後方互換）", () => {
    expect(normalizeSleepPrevention(false)).toBe("off");
  });

  test("string \"off\" / \"idle\" / \"aggressive\" を受理", () => {
    expect(normalizeSleepPrevention("off")).toBe("off");
    expect(normalizeSleepPrevention("idle")).toBe("idle");
    expect(normalizeSleepPrevention("aggressive")).toBe("aggressive");
  });

  test("大小文字差・前後 whitespace は許容（trim + lowercase）", () => {
    expect(normalizeSleepPrevention(" Idle ")).toBe("idle");
    expect(normalizeSleepPrevention("AGGRESSIVE")).toBe("aggressive");
    expect(normalizeSleepPrevention("Off")).toBe("off");
  });

  test("未知の string は throw", () => {
    expect(() => normalizeSleepPrevention("on")).toThrow();
    expect(() => normalizeSleepPrevention("dis")).toThrow();
    expect(() => normalizeSleepPrevention("")).toThrow();
  });

  test("number / object など他型は throw", () => {
    expect(() => normalizeSleepPrevention(123)).toThrow();
    expect(() => normalizeSleepPrevention({})).toThrow();
    expect(() => normalizeSleepPrevention([])).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveSleepPrevention
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveSleepPrevention", () => {
  test("--no-sleep-prevention は最優先で \"off\"（config / cli mode を上書き）", () => {
    expect(
      resolveSleepPrevention(
        { sleepPrevention: "aggressive" },
        { noSleepPrevention: true, sleepPrevention: "idle" },
      ),
    ).toBe("off");
  });

  test("--sleep-prevention <mode> は config より優先", () => {
    expect(
      resolveSleepPrevention(
        { sleepPrevention: "aggressive" },
        { noSleepPrevention: false, sleepPrevention: "idle" },
      ),
    ).toBe("idle");
  });

  test("CLI 未指定時は config.sleepPrevention を使う", () => {
    expect(
      resolveSleepPrevention(
        { sleepPrevention: "idle" },
        { noSleepPrevention: false },
      ),
    ).toBe("idle");
  });

  test("config も未指定なら \"aggressive\"（デフォルト）", () => {
    expect(
      resolveSleepPrevention({}, { noSleepPrevention: false }),
    ).toBe("aggressive");
  });

  test("boolean 後方互換: config.sleepPrevention === false → \"off\"", () => {
    const cfg: TeamConfig = { sleepPrevention: false };
    expect(
      resolveSleepPrevention(cfg, { noSleepPrevention: false }),
    ).toBe("off");
  });

  test("boolean 後方互換: config.sleepPrevention === true → \"aggressive\"", () => {
    const cfg: TeamConfig = { sleepPrevention: true };
    expect(
      resolveSleepPrevention(cfg, { noSleepPrevention: false }),
    ).toBe("aggressive");
  });

  test("CLI mode が不正値なら throw（fail-fast）", () => {
    expect(() =>
      resolveSleepPrevention({}, { noSleepPrevention: false, sleepPrevention: "wat" }),
    ).toThrow();
  });

  test("config の不正値も throw（fail-fast）", () => {
    const cfg = { sleepPrevention: "wat" as unknown } as TeamConfig;
    expect(() =>
      resolveSleepPrevention(cfg, { noSleepPrevention: false }),
    ).toThrow();
  });
});
