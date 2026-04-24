import { describe, test, expect } from "bun:test";
import { buildRateLimitStatusLines } from "./rate-limit-status";
import type { RateLimitInfo } from "./schema";

// 固定 now（2026-04-24T10:00:00 JST = 2026-04-24T01:00:00 UTC）
const NOW = new Date("2026-04-24T01:00:00.000Z").getTime();

function isoAt(offsetSec: number): string {
  return new Date(NOW + offsetSec * 1000).toISOString();
}

function unixSecAt(offsetSec: number): string {
  return String(Math.floor((NOW + offsetSec * 1000) / 1000));
}

function mkInfo(partial: Partial<RateLimitInfo>): RateLimitInfo {
  return {
    tokensRemaining: 0,
    tokensLimit: 0,
    tokensReset: "",
    inputTokensRemaining: 0,
    outputTokensRemaining: 0,
    unified5hUtilization: null,
    unified7dUtilization: null,
    unified5hReset: null,
    unified7dReset: null,
    unifiedStatus: null,
    updatedAt: isoAt(-10),
    ...partial,
  };
}

describe("buildRateLimitStatusLines", () => {
  test("1. rl=null のとき proxy 未起動案内行を返す", () => {
    const lines = buildRateLimitStatusLines(null, NOW);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("no rate limit data");
    expect(lines[0]).toContain("proxy not running");
  });

  test("2. 通常表示（5h 55%, 7d 38%, 両軸 future reset, updatedAt=now-10s, allowed）", () => {
    const rl = mkInfo({
      unified5hUtilization: 0.55,
      unified7dUtilization: 0.38,
      unified5hReset: unixSecAt(3600 + 23 * 60), // 1h23m 後
      unified7dReset: unixSecAt(22 * 3600), // 22h 後
      unifiedStatus: "allowed",
      updatedAt: isoAt(-10),
    });
    const lines = buildRateLimitStatusLines(rl, NOW);
    const text = lines.join("\n");
    expect(text).toContain("5h:");
    expect(text).toContain("55%");
    expect(text).toContain("7d:");
    expect(text).toContain("38%");
    // バー文字（`█` と `░`）が含まれる
    expect(text).toMatch(/█+░+/);
    expect(text).toContain("reset in 1h23m");
    expect(text).toContain("reset in 22h");
    expect(text).toContain("status: allowed");
    expect(text).toContain("updated 10s ago");
    // stale は付かない
    expect(text).not.toContain("(stale");
  });

  test("3. 5h axis stale（unified5hReset が過去 unix 秒 string）→ 5h 行に (stale)", () => {
    const rl = mkInfo({
      unified5hUtilization: 0.55,
      unified7dUtilization: 0.38,
      unified5hReset: unixSecAt(-3600), // 1h 前（past）
      unified7dReset: unixSecAt(22 * 3600),
      unifiedStatus: "allowed",
      updatedAt: isoAt(-10),
    });
    const lines = buildRateLimitStatusLines(rl, NOW);
    const h5 = lines.find((l) => l.includes("5h:"));
    const d7 = lines.find((l) => l.includes("7d:"));
    expect(h5).toBeDefined();
    expect(h5).toContain("(stale)");
    expect(d7).toBeDefined();
    expect(d7).not.toContain("(stale)");
  });

  test("4. 7d axis stale（unified7dReset が過去 ISO）→ 7d 行のみ (stale)", () => {
    const rl = mkInfo({
      unified5hUtilization: 0.55,
      unified7dUtilization: 0.38,
      unified5hReset: unixSecAt(3600),
      unified7dReset: isoAt(-3600), // 過去 ISO
      unifiedStatus: "allowed",
      updatedAt: isoAt(-10),
    });
    const lines = buildRateLimitStatusLines(rl, NOW);
    const h5 = lines.find((l) => l.includes("5h:"));
    const d7 = lines.find((l) => l.includes("7d:"));
    expect(h5).not.toContain("(stale)");
    expect(d7).toContain("(stale)");
  });

  test("5. 両軸 stale → 両行に (stale)", () => {
    const rl = mkInfo({
      unified5hUtilization: 0.1,
      unified7dUtilization: 0.1,
      unified5hReset: unixSecAt(-100),
      unified7dReset: unixSecAt(-100),
      unifiedStatus: "allowed",
      updatedAt: isoAt(-10),
    });
    const lines = buildRateLimitStatusLines(rl, NOW);
    const h5 = lines.find((l) => l.includes("5h:"))!;
    const d7 = lines.find((l) => l.includes("7d:"))!;
    expect(h5).toContain("(stale)");
    expect(d7).toContain("(stale)");
  });

  test("6. unifiedStatus = rate_limited → status 行に ⚠", () => {
    const rl = mkInfo({
      unified5hUtilization: 0.95,
      unified7dUtilization: 0.5,
      unified5hReset: unixSecAt(600),
      unified7dReset: unixSecAt(3600),
      unifiedStatus: "rate_limited",
      updatedAt: isoAt(-5),
    });
    const lines = buildRateLimitStatusLines(rl, NOW);
    const statusLine = lines.find((l) => l.includes("status:"))!;
    expect(statusLine).toContain("⚠");
    expect(statusLine).toContain("rate_limited");
  });

  test("7. unifiedStatus = null → status: unknown", () => {
    const rl = mkInfo({
      unified5hUtilization: 0.2,
      unified7dUtilization: 0.2,
      unified5hReset: unixSecAt(60),
      unified7dReset: unixSecAt(600),
      unifiedStatus: null,
      updatedAt: isoAt(-10),
    });
    const lines = buildRateLimitStatusLines(rl, NOW);
    const statusLine = lines.find((l) => l.includes("status:"))!;
    expect(statusLine).toContain("unknown");
  });

  test("8. updatedAt が 5 分前 → (stale, updated 5m ago)", () => {
    const rl = mkInfo({
      unified5hUtilization: 0.2,
      unified7dUtilization: 0.2,
      unified5hReset: unixSecAt(3600),
      unified7dReset: unixSecAt(86400),
      unifiedStatus: "allowed",
      updatedAt: isoAt(-5 * 60),
    });
    const lines = buildRateLimitStatusLines(rl, NOW);
    const statusLine = lines.find((l) => l.includes("status:"))!;
    expect(statusLine).toContain("stale");
    expect(statusLine).toContain("updated 5m ago");
  });

  test("9. 相対時刻エッジ: <1m / 90m -> 1h30m / 25h -> 1d1h / 過去 -> expired", () => {
    // <1m
    {
      const rl = mkInfo({
        unified5hUtilization: 0.5,
        unified5hReset: unixSecAt(30),
        updatedAt: isoAt(0),
      });
      const lines = buildRateLimitStatusLines(rl, NOW);
      expect(lines.join("\n")).toContain("reset in <1m");
    }
    // 90m -> 1h30m
    {
      const rl = mkInfo({
        unified5hUtilization: 0.5,
        unified5hReset: unixSecAt(90 * 60),
        updatedAt: isoAt(0),
      });
      const lines = buildRateLimitStatusLines(rl, NOW);
      expect(lines.join("\n")).toContain("reset in 1h30m");
    }
    // 25h -> 1d1h
    {
      const rl = mkInfo({
        unified5hUtilization: 0.5,
        unified5hReset: unixSecAt(25 * 3600),
        updatedAt: isoAt(0),
      });
      const lines = buildRateLimitStatusLines(rl, NOW);
      expect(lines.join("\n")).toContain("reset in 1d1h");
    }
    // 過去 -> expired（stale 判定にも乗るので、軸行自体に expired が出ることを確認）
    {
      const rl = mkInfo({
        unified5hUtilization: 0.5,
        unified5hReset: unixSecAt(-60),
        updatedAt: isoAt(0),
      });
      const lines = buildRateLimitStatusLines(rl, NOW);
      const h5 = lines.find((l) => l.includes("5h:"))!;
      expect(h5).toContain("expired");
    }
  });

  test("10. unified5hUtilization = null → 5h 行は出さず 7d 行だけ出す", () => {
    const rl = mkInfo({
      unified5hUtilization: null,
      unified7dUtilization: 0.25,
      unified5hReset: null,
      unified7dReset: unixSecAt(3600),
      unifiedStatus: "allowed",
      updatedAt: isoAt(-10),
    });
    const lines = buildRateLimitStatusLines(rl, NOW);
    const hasH5 = lines.some((l) => l.includes("5h:"));
    const hasD7 = lines.some((l) => l.includes("7d:"));
    expect(hasH5).toBe(false);
    expect(hasD7).toBe(true);
  });

  test("11. updatedAt が未来（時計ズレ）→ updated 0s ago にクランプ", () => {
    const rl = mkInfo({
      unified5hUtilization: 0.3,
      unified5hReset: unixSecAt(3600),
      updatedAt: isoAt(+30), // 30s 未来
    });
    const lines = buildRateLimitStatusLines(rl, NOW);
    const statusLine = lines.find((l) => l.includes("status:"))!;
    expect(statusLine).toContain("updated 0s ago");
    expect(statusLine).not.toContain("stale");
  });
});
