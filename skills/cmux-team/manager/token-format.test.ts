import { describe, test, expect } from "bun:test";
import { formatUtil, formatReset, formatSelectable } from "./token-format";
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
