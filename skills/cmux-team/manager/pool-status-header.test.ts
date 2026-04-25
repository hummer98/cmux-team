import { describe, test, expect } from "bun:test";
import { buildPoolHeaderLines, type PoolHeaderInput } from "./pool-status-header";

describe("buildPoolHeaderLines", () => {
  test("input が null なら空配列を返す", () => {
    expect(buildPoolHeaderLines(null)).toEqual([]);
  });

  test("capacity のみ（next reset null）", () => {
    const input: PoolHeaderInput = {
      capacityPct: 173,
      nextReset: null,
    };
    const lines = buildPoolHeaderLines(input);
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain("┌");
    expect(lines[0]).toContain("token pool");
    expect(lines[1]).toContain("pool capacity: 173%");
    // next reset が null なら capacity 行のみで next reset 行は出さない
    expect(lines[1]).not.toContain("next reset");
    expect(lines[2]).toContain("└");
  });

  test("capacity + next reset 構成（4 行）", () => {
    const input: PoolHeaderInput = {
      capacityPct: 173,
      nextReset: {
        handle: "@kddi",
        window: "5h",
        remainingMs: 30 * 60 * 1000,
        deltaPct: 20,
      },
    };
    const lines = buildPoolHeaderLines(input);
    expect(lines.length).toBe(4);
    expect(lines[1]).toContain("pool capacity: 173%");
    expect(lines[2]).toContain("next reset");
    expect(lines[2]).toContain("@kddi");
    expect(lines[2]).toContain("5h");
    expect(lines[2]).toContain("30m");
    expect(lines[2]).toContain("(+20 pts)");
    expect(lines[3]).toContain("└");
  });

  test("deltaPct < 0 は符号付きで表示", () => {
    const input: PoolHeaderInput = {
      capacityPct: 100,
      nextReset: {
        handle: "@kddi",
        window: "7d",
        remainingMs: 86400 * 1000 * 3,
        deltaPct: -5,
      },
    };
    const lines = buildPoolHeaderLines(input);
    expect(lines[2]).toContain("(-5 pts)");
  });

  test("deltaPct === 0 でも表示する（D4: MVP は 0 でも表示）", () => {
    const input: PoolHeaderInput = {
      capacityPct: 100,
      nextReset: {
        handle: "@kddi",
        window: "5h",
        remainingMs: 60 * 1000,
        deltaPct: 0,
      },
    };
    const lines = buildPoolHeaderLines(input);
    expect(lines[2]).toContain("(+0 pts)");
  });

  test("罫線は固定幅 60 文字（D10）", () => {
    const lines = buildPoolHeaderLines({
      capacityPct: 100,
      nextReset: null,
    });
    // 上下の罫線は visible 幅 60。罫線行 (┌─...┐ / └─...┘) は ASCII幅 60
    const first = lines[0];
    expect(first).toBeDefined();
    expect(first!.length).toBe(60);
    const last = lines[lines.length - 1];
    expect(last).toBeDefined();
    expect(last!.length).toBe(60);
  });

  test("remainingMs < 60s は <1m 表記", () => {
    const lines = buildPoolHeaderLines({
      capacityPct: 100,
      nextReset: {
        handle: "@a",
        window: "5h",
        remainingMs: 30 * 1000,
        deltaPct: 5,
      },
    });
    expect(lines[2]).toContain("<1m");
  });
});
