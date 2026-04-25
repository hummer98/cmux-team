import { describe, test, expect } from "bun:test";
import { formatSurfaceRow, type SurfaceRowInput } from "./pool-surface-row";

describe("formatSurfaceRow", () => {
  test("handle あり / 通常レンジ", () => {
    const out = formatSurfaceRow({
      surface: "surface:123",
      handle: "@pers",
      util5h: 0.10,
      util7d: 0.30,
      capPct: 100,
    });
    expect(out).toContain("[123]");
    expect(out).toContain("@pers");
    expect(out).toContain("<5h:10%/7d:30%>");
    expect(out).toContain("cap:100%");
    expect(out).not.toContain("⚠");
  });

  test("handle が undefined → (no token) 表記、util/cap セクションは省略", () => {
    const out = formatSurfaceRow({
      surface: "surface:124",
      handle: undefined,
      util5h: null,
      util7d: null,
      capPct: null,
    });
    expect(out).toContain("[124]");
    expect(out).toContain("(no token)");
    expect(out).not.toContain("<5h:");
    expect(out).not.toContain("cap:");
    expect(out).not.toContain("⚠");
  });

  test("util_5h > 80% で警告マーク付与", () => {
    const out = formatSurfaceRow({
      surface: "surface:200",
      handle: "@kddi",
      util5h: 0.82,
      util7d: 0.60,
      capPct: 40,
    });
    expect(out).toContain("⚠");
  });

  test("util_7d > 90% で警告マーク付与", () => {
    const out = formatSurfaceRow({
      surface: "surface:200",
      handle: "@kddi",
      util5h: 0.50,
      util7d: 0.95,
      capPct: 100,
    });
    expect(out).toContain("⚠");
  });

  test("cap_pct < 20% で警告マーク付与", () => {
    const out = formatSurfaceRow({
      surface: "surface:300",
      handle: "@kddi",
      util5h: 0.50,
      util7d: 0.50,
      capPct: 15,
    });
    expect(out).toContain("⚠");
  });

  test("util が null の場合 -- 表示", () => {
    const out = formatSurfaceRow({
      surface: "surface:400",
      handle: "@kddi",
      util5h: null,
      util7d: null,
      capPct: null,
    });
    expect(out).toContain("[400]");
    expect(out).toContain("@kddi");
    expect(out).toContain("<5h:--/7d:--%>");
    expect(out).not.toContain("⚠");
  });

  test("ちょうど閾値（80%）では警告なし（> 比較）", () => {
    const out = formatSurfaceRow({
      surface: "surface:1",
      handle: "@a",
      util5h: 0.80,
      util7d: 0.60,
      capPct: 100,
    });
    expect(out).not.toContain("⚠");
  });

  test("surface 文字列に prefix がない場合はそのまま [<raw>] にする", () => {
    const out = formatSurfaceRow({
      surface: "abc",
      handle: "@x",
      util5h: 0.1,
      util7d: 0.1,
      capPct: 100,
    });
    expect(out).toContain("[abc]");
  });
});
