import { describe, test, expect } from "bun:test";
import { computeNextReset } from "./pool-next-reset";

describe("computeNextReset", () => {
  const NOW_ISO = "2026-04-25T10:00:00.000Z";
  const NOW_MS = new Date(NOW_ISO).getTime();
  const isoIn = (ms: number) => new Date(NOW_MS + ms).toISOString();

  test("候補が空なら null を返す", () => {
    const r = computeNextReset({ tokens: [], nowIso: NOW_ISO });
    expect(r).toBeNull();
  });

  test("selectable=false のトークンは候補から除外される", () => {
    const r = computeNextReset({
      tokens: [
        {
          handle: "@auto",
          plan_ratio: null,
          util_5h: 0.5,
          util_7d: 0.5,
          reset_5h_at: isoIn(60 * 60 * 1000),
          reset_7d_at: null,
          selectable: false,
        },
      ],
      nowIso: NOW_ISO,
    });
    expect(r).toBeNull();
  });

  test("plan_ratio が null のトークンは pool capacity 計算から除外（candidate 自体は持てる）", () => {
    // plan_ratio が null で reset 自体は持つトークンは next reset 候補にならない
    // （capacity 寄与しないので reset しても deltaPct=0 にしかならない）
    const r = computeNextReset({
      tokens: [
        {
          handle: "@unknown",
          plan_ratio: null,
          util_5h: 0.5,
          util_7d: 0.5,
          reset_5h_at: isoIn(60 * 60 * 1000),
          reset_7d_at: null,
          selectable: true,
        },
      ],
      nowIso: NOW_ISO,
    });
    expect(r).toBeNull();
  });

  test("単一トークン 5h/7d 両方候補があれば早い方を選ぶ", () => {
    // 5h は 30 分後、7d は 24 時間後 → 5h の方が早い
    const r = computeNextReset({
      tokens: [
        {
          handle: "@kddi",
          plan_ratio: 1.0,
          util_5h: 0.8,
          util_7d: 0.5,
          reset_5h_at: isoIn(30 * 60 * 1000),
          reset_7d_at: isoIn(24 * 3600 * 1000),
          selectable: true,
        },
      ],
      nowIso: NOW_ISO,
    });
    expect(r).not.toBeNull();
    expect(r!.handle).toBe("@kddi");
    expect(r!.window).toBe("5h");
    expect(r!.remainingMs).toBe(30 * 60 * 1000);
  });

  test("複数トークン中で最も早い reset を持つトークンを選ぶ", () => {
    const r = computeNextReset({
      tokens: [
        {
          handle: "@a",
          plan_ratio: 1.0,
          util_5h: 0.5,
          util_7d: 0.5,
          reset_5h_at: isoIn(2 * 3600 * 1000),
          reset_7d_at: isoIn(24 * 3600 * 1000),
          selectable: true,
        },
        {
          handle: "@b",
          plan_ratio: 1.0,
          util_5h: 0.5,
          util_7d: 0.5,
          reset_5h_at: isoIn(30 * 60 * 1000),
          reset_7d_at: isoIn(48 * 3600 * 1000),
          selectable: true,
        },
      ],
      nowIso: NOW_ISO,
    });
    expect(r!.handle).toBe("@b");
    expect(r!.window).toBe("5h");
  });

  test("reset 過去の値は候補から除外される", () => {
    const r = computeNextReset({
      tokens: [
        {
          handle: "@a",
          plan_ratio: 1.0,
          util_5h: 0.5,
          util_7d: 0.5,
          reset_5h_at: isoIn(-60 * 60 * 1000), // 1 時間前
          reset_7d_at: isoIn(24 * 3600 * 1000),
          selectable: true,
        },
      ],
      nowIso: NOW_ISO,
    });
    expect(r!.window).toBe("7d");
  });

  test("deltaPct = 該当 reset 後の capacity 増分（7d 律速ケース）", () => {
    // A019 検証ケースで支配的な「7d 律速」: util_7d=0.95 で 7d reset すると capacity が大きく増える。
    // 5h は遠い時点（24h 後）なので 5h reset を選ばず 7d reset が next となる。
    const r = computeNextReset({
      tokens: [
        {
          handle: "@kddi",
          plan_ratio: 1.0,
          util_5h: 0.5,
          util_7d: 0.95,
          reset_5h_at: isoIn(48 * 3600 * 1000),
          reset_7d_at: isoIn(24 * 3600 * 1000),
          selectable: true,
        },
      ],
      nowIso: NOW_ISO,
    });
    expect(r!.window).toBe("7d");
    expect(r!.deltaPct).toBeGreaterThan(0);
  });

  test("両 reset とも null なら null を返す", () => {
    const r = computeNextReset({
      tokens: [
        {
          handle: "@a",
          plan_ratio: 1.0,
          util_5h: 0.5,
          util_7d: 0.5,
          reset_5h_at: null,
          reset_7d_at: null,
          selectable: true,
        },
      ],
      nowIso: NOW_ISO,
    });
    expect(r).toBeNull();
  });
});
