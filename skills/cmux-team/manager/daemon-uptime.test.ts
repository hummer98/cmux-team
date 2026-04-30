/**
 * T353: formatUptimeFromStartedAt の境界ケーステスト。
 *
 * - 通常: ISO 起動時刻と現在時刻から経過秒数を返す
 * - 巻き戻り: 時刻が過去に巻き戻った場合 Math.max(0, ...) で 0 にフロアする
 * - 起動直後: now == startedAt なら 0
 */
import { describe, test, expect } from "bun:test";
import { formatUptimeFromStartedAt } from "./main";

describe("formatUptimeFromStartedAt", () => {
  test("通常ケース: 3h 23m を秒で返す", () => {
    const start = "2026-05-01T00:00:00.000Z";
    const now = new Date("2026-05-01T03:23:00.000Z").getTime();
    expect(formatUptimeFromStartedAt(start, now)).toBe(3 * 3600 + 23 * 60);
  });

  test("時刻巻き戻りで負になっても Math.max(0, ...) で 0 にフロア", () => {
    const start = "2026-05-01T00:00:10.000Z";
    const now = new Date("2026-05-01T00:00:00.000Z").getTime();
    expect(formatUptimeFromStartedAt(start, now)).toBe(0);
  });

  test("起動直後 (now == startedAt) は 0s", () => {
    const start = "2026-05-01T00:00:00.000Z";
    const now = new Date(start).getTime();
    expect(formatUptimeFromStartedAt(start, now)).toBe(0);
  });

  test("ミリ秒は floor で切り捨て: 1500ms -> 1s", () => {
    const start = "2026-05-01T00:00:00.000Z";
    const now = new Date("2026-05-01T00:00:01.500Z").getTime();
    expect(formatUptimeFromStartedAt(start, now)).toBe(1);
  });
});
