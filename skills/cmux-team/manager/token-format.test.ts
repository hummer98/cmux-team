import { describe, test, expect } from "bun:test";
import {
  formatUtil,
  formatReset,
  formatSelectable,
  formatPerHandleUtilCell,
} from "./token-format";
import type { Token, UsageSnapshot } from "./token-store";

describe("formatUtil", () => {
  test("null は --", () => {
    expect(formatUtil(null)).toBe("--");
  });
  test("0 は 0%", () => {
    expect(formatUtil(0)).toBe("0%");
  });
  test("0.82 は 82%", () => {
    expect(formatUtil(0.82)).toBe("82%");
  });
  test("1.0 は 100%", () => {
    expect(formatUtil(1.0)).toBe("100%");
  });
});

describe("formatReset", () => {
  test("null は --", () => {
    expect(formatReset(null)).toBe("--");
  });
  test("無効な ISO は --", () => {
    expect(formatReset("not-a-date")).toBe("--");
  });
  test("過去時刻は now", () => {
    const past = new Date(Date.now() - 60 * 1000).toISOString();
    expect(formatReset(past)).toBe("now");
  });
  test("数時間先は Xh", () => {
    const future = new Date(Date.now() + 5 * 3600 * 1000).toISOString();
    expect(formatReset(future)).toMatch(/h$/);
  });
  test("1 日以上先は Xd", () => {
    const future = new Date(Date.now() + 3 * 86400 * 1000).toISOString();
    expect(formatReset(future)).toMatch(/d$/);
  });
});

describe("formatSelectable", () => {
  const baseToken: Token = {
    id: 1,
    handle: "@a",
    organization_id: "org",
    auth_hash: "abc",
    plan: "max-x20",
    plan_ratio: 1.0,
    credential_source: "manual",
    tags: ["any"],
    selectable: true,
    created_at: new Date().toISOString(),
  };

  test("selectable=false → no", () => {
    const t: Token = { ...baseToken, selectable: false };
    expect(formatSelectable(t, null)).toBe("no");
  });
  test("util_5h > 95% → blocked", () => {
    const snap: UsageSnapshot = {
      id: 1,
      token_id: 1,
      util_5h: 0.96,
      util_7d: 0.5,
      reset_5h_at: null,
      reset_7d_at: null,
      unified_status: null,
      recorded_at: new Date().toISOString(),
    };
    expect(formatSelectable(baseToken, snap)).toBe("blocked");
  });
  test("util_5h null + selectable=true → yes", () => {
    expect(formatSelectable(baseToken, null)).toBe("yes");
  });
  test("util_5h <= 95% → yes", () => {
    const snap: UsageSnapshot = {
      id: 1,
      token_id: 1,
      util_5h: 0.50,
      util_7d: 0.50,
      reset_5h_at: null,
      reset_7d_at: null,
      unified_status: null,
      recorded_at: new Date().toISOString(),
    };
    expect(formatSelectable(baseToken, snap)).toBe("yes");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// formatPerHandleUtilCell (T390) — per-handle 行は effUtil 表示 + 救済マーカー
// ─────────────────────────────────────────────────────────────────────────────

describe("formatPerHandleUtilCell (T390)", () => {
  // 固定 now で動かす（pool-throttle.test.ts 系と同パターン）
  const NOW_MS = new Date("2026-04-25T10:00:00.000Z").getTime();
  const STALE_RECORDED = new Date(NOW_MS - 35 * 60 * 1000).toISOString();
  const FRESH_RECORDED = new Date(NOW_MS).toISOString();

  function snap(partial: Partial<UsageSnapshot>): UsageSnapshot {
    return {
      id: 1,
      token_id: 1,
      util_5h: 0,
      util_7d: 0,
      reset_5h_at: null,
      reset_7d_at: null,
      unified_status: null,
      recorded_at: FRESH_RECORDED,
      ...partial,
    };
  }

  test("snap=null → display=--、marker なし", () => {
    const r = formatPerHandleUtilCell(null, NOW_MS);
    expect(r).toEqual({ display5h: "--", display7d: "--", marker: "" });
  });

  test("fresh + マーカーなし", () => {
    const r = formatPerHandleUtilCell(
      snap({ util_5h: 0.5, util_7d: 0.5, recorded_at: FRESH_RECORDED }),
      NOW_MS,
    );
    expect(r).toEqual({ display5h: "50%", display7d: "50%", marker: "" });
  });

  test("@tayo 想定: 5h reset 通過済み stale → 5H=0%, marker=*", () => {
    const r = formatPerHandleUtilCell(
      snap({
        util_5h: 0.02,
        util_7d: 0.91,
        reset_5h_at: new Date(NOW_MS - 60 * 1000).toISOString(),
        reset_7d_at: new Date(NOW_MS + 60 * 60 * 1000).toISOString(),
        recorded_at: STALE_RECORDED,
      }),
      NOW_MS,
    );
    expect(r).toEqual({ display5h: "0%", display7d: "91%", marker: "*" });
  });

  test("@kddi 想定: stale + reset 両軸未到達 → 乖離なし、marker なし", () => {
    const r = formatPerHandleUtilCell(
      snap({
        util_5h: 0.02,
        util_7d: 0.97,
        reset_5h_at: new Date(NOW_MS + 30 * 60 * 1000).toISOString(),
        reset_7d_at: new Date(NOW_MS + 60 * 60 * 1000).toISOString(),
        recorded_at: STALE_RECORDED,
      }),
      NOW_MS,
    );
    expect(r).toEqual({ display5h: "2%", display7d: "97%", marker: "" });
  });

  test("7d reset 通過済み stale → 7D=0%, marker=*", () => {
    const r = formatPerHandleUtilCell(
      snap({
        util_5h: 0.5,
        util_7d: 0.99,
        reset_5h_at: new Date(NOW_MS + 60 * 60 * 1000).toISOString(),
        reset_7d_at: new Date(NOW_MS - 60 * 1000).toISOString(),
        recorded_at: STALE_RECORDED,
      }),
      NOW_MS,
    );
    expect(r).toEqual({ display5h: "50%", display7d: "0%", marker: "*" });
  });

  test("高 util stale だが reset 未到達 → snap のまま、marker なし", () => {
    const r = formatPerHandleUtilCell(
      snap({
        util_5h: 0.97,
        util_7d: 0.5,
        reset_5h_at: new Date(NOW_MS + 60 * 60 * 1000).toISOString(),
        reset_7d_at: new Date(NOW_MS + 60 * 60 * 1000).toISOString(),
        recorded_at: STALE_RECORDED,
      }),
      NOW_MS,
    );
    expect(r).toEqual({ display5h: "97%", display7d: "50%", marker: "" });
  });

  test("stale だが reset 情報なし → 救済も乖離も発生しない", () => {
    const r = formatPerHandleUtilCell(
      snap({
        util_5h: 0.5,
        util_7d: 0.5,
        reset_5h_at: null,
        reset_7d_at: null,
        recorded_at: STALE_RECORDED,
      }),
      NOW_MS,
    );
    expect(r).toEqual({ display5h: "50%", display7d: "50%", marker: "" });
  });

  // T402: snap exists で軸 util=null（未観測）と reset 通過 0 を視覚的に区別する
  test("T402 (t1): snap exists + util_5h=null + util_7d=数値 + reset 未通過 → 5h は --", () => {
    const r = formatPerHandleUtilCell(
      snap({
        util_5h: null,
        util_7d: 0.5,
        reset_5h_at: new Date(NOW_MS + 60 * 60 * 1000).toISOString(),
        reset_7d_at: new Date(NOW_MS + 60 * 60 * 1000).toISOString(),
        recorded_at: FRESH_RECORDED,
      }),
      NOW_MS,
    );
    expect(r).toEqual({ display5h: "--", display7d: "50%", marker: "" });
  });

  test("T402 (t2): snap exists + util_5h=null + util_7d=null + 両 reset 未通過 → 両軸 --", () => {
    const r = formatPerHandleUtilCell(
      snap({
        util_5h: null,
        util_7d: null,
        reset_5h_at: new Date(NOW_MS + 60 * 60 * 1000).toISOString(),
        reset_7d_at: new Date(NOW_MS + 60 * 60 * 1000).toISOString(),
        recorded_at: FRESH_RECORDED,
      }),
      NOW_MS,
    );
    expect(r).toEqual({ display5h: "--", display7d: "--", marker: "" });
  });

  test("T402 (t3): snap exists + util_5h=null + util_7d=null + 5h reset 通過 → 5h は 0% + *、7d は --", () => {
    const r = formatPerHandleUtilCell(
      snap({
        util_5h: null,
        util_7d: null,
        reset_5h_at: new Date(NOW_MS - 60 * 1000).toISOString(),
        reset_7d_at: new Date(NOW_MS + 60 * 60 * 1000).toISOString(),
        recorded_at: STALE_RECORDED,
      }),
      NOW_MS,
    );
    expect(r).toEqual({ display5h: "0%", display7d: "--", marker: "*" });
  });
});
