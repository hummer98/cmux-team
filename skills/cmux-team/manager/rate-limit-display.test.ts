import { describe, test, expect } from "bun:test";
import type { RateLimitInfo } from "./schema";
import { buildRateLimitDisplay } from "./rate-limit-display";

const NOW = 1_700_000_000_000; // 固定時刻（ms）
const NOW_SEC = Math.floor(NOW / 1000);
const FUTURE_5H = String(NOW_SEC + 5 * 3600);
const FUTURE_7D = String(NOW_SEC + 7 * 86400);
const PAST_5H = String(NOW_SEC - 3600);
const PAST_7D = String(NOW_SEC - 86400);

function makeInfo(overrides: Partial<RateLimitInfo> = {}): RateLimitInfo {
  return {
    tokensRemaining: 100,
    tokensLimit: 1000,
    tokensReset: "2026-04-17T01:00:00Z",
    inputTokensRemaining: 50,
    outputTokensRemaining: 50,
    unified5hUtilization: 0.42,
    unified7dUtilization: 0.17,
    unified5hReset: FUTURE_5H,
    unified7dReset: FUTURE_7D,
    unifiedStatus: "allowed",
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

describe("buildRateLimitDisplay", () => {
  test("rateLimit=null は Rate: -- を GRAY で返す", () => {
    const { parts } = buildRateLimitDisplay(null, NOW);
    expect(parts).toEqual([{ text: "Rate: --", color: "gray" }]);
  });

  test("unified データあり / non-stale / 通常値 → GREEN（<70%）", () => {
    const rl = makeInfo({ unified5hUtilization: 0.42, unified7dUtilization: 0.17 });
    const { parts } = buildRateLimitDisplay(rl, NOW);
    expect(parts.some((p) => p.text.includes("5h:") && p.color === "green")).toBe(true);
    expect(parts.some((p) => p.text.includes("7d:") && p.color === "green")).toBe(true);
    expect(parts.every((p) => p.color !== "gray" || !p.text.includes("(stale)"))).toBe(true);
  });

  test("unified データあり / non-stale / 70-89% → YELLOW", () => {
    const rl = makeInfo({ unified5hUtilization: 0.75 });
    const { parts } = buildRateLimitDisplay(rl, NOW);
    const bar5h = parts.find((p) => p.text.includes("5h:"));
    expect(bar5h?.color).toBe("yellow");
  });

  test("unified データあり / non-stale / >=90% → RED", () => {
    const rl = makeInfo({ unified5hUtilization: 0.95 });
    const { parts } = buildRateLimitDisplay(rl, NOW);
    const bar5h = parts.find((p) => p.text.includes("5h:"));
    expect(bar5h?.color).toBe("red");
  });

  test("non-stale かつ unifiedStatus=rate_limited → 全バーを RED にする", () => {
    const rl = makeInfo({
      unified5hUtilization: 0.1,
      unified7dUtilization: 0.1,
      unifiedStatus: "rate_limited",
    });
    const { parts } = buildRateLimitDisplay(rl, NOW);
    const bars = parts.filter((p) => p.text.includes(":") && !p.text.includes("(stale)") && p.color !== "gray");
    for (const p of bars) {
      expect(p.color).toBe("red");
    }
  });

  test("stale（両方過去）→ (stale) サフィックスを付け全パーツ GRAY", () => {
    const rl = makeInfo({ unified5hReset: PAST_5H, unified7dReset: PAST_7D });
    const { parts } = buildRateLimitDisplay(rl, NOW);
    expect(parts.some((p) => p.text.includes("(stale)"))).toBe(true);
    for (const p of parts) {
      expect(p.color).toBe("gray");
    }
  });

  test("stale かつ unifiedStatus=rate_limited でも赤にしない（stale 優先）", () => {
    const rl = makeInfo({
      unified5hReset: PAST_5H,
      unified7dReset: null,
      unifiedStatus: "rate_limited",
      unified5hUtilization: 0.95,
    });
    const { parts } = buildRateLimitDisplay(rl, NOW);
    for (const p of parts) {
      expect(p.color).toBe("gray");
    }
  });

  test("unified データなし + tokensLimit=0 → Rate: -- を返す", () => {
    const rl = makeInfo({
      unified5hUtilization: null,
      unified7dUtilization: null,
      tokensLimit: 0,
    });
    const { parts } = buildRateLimitDisplay(rl, NOW);
    expect(parts).toEqual([{ text: "Rate: --", color: "gray" }]);
  });

  test("TPM フォールバック: 残り >=50% → GREEN", () => {
    const rl = makeInfo({
      unified5hUtilization: null,
      unified7dUtilization: null,
      unified5hReset: null,
      unified7dReset: null,
      tokensRemaining: 800,
      tokensLimit: 1000,
    });
    const { parts } = buildRateLimitDisplay(rl, NOW);
    expect(parts.length).toBe(1);
    expect(parts[0]?.text).toContain("TPM:");
    expect(parts[0]?.color).toBe("green");
  });
});
