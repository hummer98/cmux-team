/**
 * config.ts のユニットテスト（T335 で追加）。
 *
 * resolveProjectTokenPool / resolveGlobalTokenPool の policy 整形ロジック、
 * loadGlobalConfig の yaml 詰め替え（snake_case → camelCase）、
 * resolveTokenPoolEnabled の既存挙動の非回帰を検証する。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  resolveProjectTokenPool,
  resolveGlobalTokenPool,
  resolveTokenPoolEnabled,
  loadGlobalConfig,
  type TeamConfig,
  type GlobalConfig,
} from "./config";

// ─────────────────────────────────────────────────────────────────────────────
// resolveProjectTokenPool
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveProjectTokenPool", () => {
  test("tokenPool 未指定 → 空 policy", () => {
    const cfg: TeamConfig = {};
    const p = resolveProjectTokenPool(cfg);
    expect(p.default).toBeNull();
    expect(p.include).toEqual([]);
    expect(p.exclude).toEqual([]);
  });

  test("default のみ指定", () => {
    const cfg: TeamConfig = { tokenPool: { default: "@a-corp" } };
    const p = resolveProjectTokenPool(cfg);
    expect(p.default).toBe("@a-corp");
    expect(p.include).toEqual([]);
    expect(p.exclude).toEqual([]);
  });

  test("include / exclude が string[] として読まれる", () => {
    const cfg: TeamConfig = {
      tokenPool: { include: ["@x", "@y"], exclude: ["@z"] },
    };
    const p = resolveProjectTokenPool(cfg);
    expect(p.include).toEqual(["@x", "@y"]);
    expect(p.exclude).toEqual(["@z"]);
  });

  test("default ∩ include → include 側を黙って dedup（warn なし）", () => {
    const warnSpy: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => warnSpy.push(args.join(" "));
    try {
      const cfg: TeamConfig = {
        tokenPool: { default: "@a-corp", include: ["@a-corp", "@personal"] },
      };
      const p = resolveProjectTokenPool(cfg);
      expect(p.default).toBe("@a-corp");
      expect(p.include).toEqual(["@personal"]);
      // dedup は静かに行う（plan §4 の決定方針）
      expect(warnSpy.find((m) => m.includes("a-corp"))).toBeUndefined();
    } finally {
      console.warn = orig;
    }
  });

  test("default ∩ exclude → warn + exclude 側から default を除外", () => {
    const warnSpy: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => warnSpy.push(args.join(" "));
    try {
      const cfg: TeamConfig = {
        tokenPool: { default: "@a-corp", exclude: ["@a-corp", "@b"] },
      };
      const p = resolveProjectTokenPool(cfg);
      expect(p.default).toBe("@a-corp");
      expect(p.exclude).toEqual(["@b"]);
      expect(warnSpy.some((m) => m.includes("@a-corp") && m.includes("exclude"))).toBe(true);
    } finally {
      console.warn = orig;
    }
  });

  test("include / exclude に文字列以外が混入 → warn + 該当要素を捨てる", () => {
    const warnSpy: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => warnSpy.push(args.join(" "));
    try {
      const cfg: TeamConfig = {
        tokenPool: {
          include: ["@x", 42 as unknown as string, "@y"],
          exclude: [null as unknown as string, "@z"],
        },
      };
      const p = resolveProjectTokenPool(cfg);
      expect(p.include).toEqual(["@x", "@y"]);
      expect(p.exclude).toEqual(["@z"]);
      expect(warnSpy.length).toBeGreaterThan(0);
    } finally {
      console.warn = orig;
    }
  });

  test("include / exclude が array でない → 空配列扱い", () => {
    const cfg: TeamConfig = {
      tokenPool: {
        include: "not-array" as unknown as string[],
        exclude: { foo: 1 } as unknown as string[],
      },
    };
    const p = resolveProjectTokenPool(cfg);
    expect(p.include).toEqual([]);
    expect(p.exclude).toEqual([]);
  });

  test("default が string でない → null 扱い", () => {
    const cfg: TeamConfig = {
      tokenPool: { default: 123 as unknown as string },
    };
    const p = resolveProjectTokenPool(cfg);
    expect(p.default).toBeNull();
  });

  test("大文字を含む handle は warn のみ（reject も lowercase 化もしない）", () => {
    const warnSpy: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => warnSpy.push(args.join(" "));
    try {
      const cfg: TeamConfig = {
        tokenPool: {
          default: "@A-Corp",
          include: ["@personal", "@OtherUpper"],
          exclude: ["@Excl-Upper"],
        },
      };
      const p = resolveProjectTokenPool(cfg);
      // 値はそのまま保持
      expect(p.default).toBe("@A-Corp");
      expect(p.include).toEqual(["@personal", "@OtherUpper"]);
      expect(p.exclude).toEqual(["@Excl-Upper"]);
      // warn が出る
      expect(warnSpy.some((m) => m.includes("@A-Corp") && m.toLowerCase().includes("uppercase"))).toBe(true);
      expect(warnSpy.some((m) => m.includes("@OtherUpper"))).toBe(true);
      expect(warnSpy.some((m) => m.includes("@Excl-Upper"))).toBe(true);
      // 小文字 only handle は warn を出さない
      expect(warnSpy.some((m) => m.includes("@personal") && m.toLowerCase().includes("uppercase"))).toBe(false);
    } finally {
      console.warn = orig;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveGlobalTokenPool
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveGlobalTokenPool", () => {
  test("null global → 空 policy", () => {
    const p = resolveGlobalTokenPool(null);
    expect(p.ossDefault).toBeNull();
    expect(p.primaryOrgs).toEqual([]);
  });

  test("tokenPool 未指定 → 空 policy", () => {
    const p = resolveGlobalTokenPool({});
    expect(p.ossDefault).toBeNull();
    expect(p.primaryOrgs).toEqual([]);
  });

  test("ossDefault / primaryOrgs が string[] として読まれる", () => {
    const cfg: GlobalConfig = {
      tokenPool: { ossDefault: "@personal", primaryOrgs: ["myorg", "yourorg"] },
    };
    const p = resolveGlobalTokenPool(cfg);
    expect(p.ossDefault).toBe("@personal");
    expect(p.primaryOrgs).toEqual(["myorg", "yourorg"]);
  });

  test("primaryOrgs に文字列以外混入 → 捨てる", () => {
    const cfg: GlobalConfig = {
      tokenPool: { primaryOrgs: ["myorg", 42 as unknown as string] },
    };
    const p = resolveGlobalTokenPool(cfg);
    expect(p.primaryOrgs).toEqual(["myorg"]);
  });

  test("ossDefault が string でない → null", () => {
    const cfg: GlobalConfig = {
      tokenPool: { ossDefault: true as unknown as string },
    };
    const p = resolveGlobalTokenPool(cfg);
    expect(p.ossDefault).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loadGlobalConfig (yaml 詰め替え)
// ─────────────────────────────────────────────────────────────────────────────

describe("loadGlobalConfig (T335: yaml の oss_default / primary_orgs 詰め替え)", () => {
  let tmpHome: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "cmux-team-globalcfg-"));
    mkdirSync(join(tmpHome, ".cmux-team"), { recursive: true });
    prevHome = process.env.HOME;
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    if (prevHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = prevHome;
    }
    try {
      rmSync(tmpHome, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  test("token_pool.enabled の既存挙動を維持", async () => {
    writeFileSync(
      join(tmpHome, ".cmux-team/config.yaml"),
      "token_pool:\n  enabled: true\n",
    );
    const g = await loadGlobalConfig();
    expect(g?.tokenPool?.enabled).toBe(true);
  });

  test("token_pool.oss_default → tokenPool.ossDefault に詰め替え", async () => {
    writeFileSync(
      join(tmpHome, ".cmux-team/config.yaml"),
      "token_pool:\n  oss_default: '@personal'\n",
    );
    const g = await loadGlobalConfig();
    expect(g?.tokenPool?.ossDefault).toBe("@personal");
  });

  test("token_pool.primary_orgs → tokenPool.primaryOrgs に詰め替え", async () => {
    writeFileSync(
      join(tmpHome, ".cmux-team/config.yaml"),
      "token_pool:\n  primary_orgs:\n    - myorg\n    - yourorg\n",
    );
    const g = await loadGlobalConfig();
    expect(g?.tokenPool?.primaryOrgs).toEqual(["myorg", "yourorg"]);
  });

  test("enabled / oss_default / primary_orgs が同居", async () => {
    writeFileSync(
      join(tmpHome, ".cmux-team/config.yaml"),
      "token_pool:\n  enabled: true\n  oss_default: '@personal'\n  primary_orgs: [myorg]\n",
    );
    const g = await loadGlobalConfig();
    expect(g?.tokenPool?.enabled).toBe(true);
    expect(g?.tokenPool?.ossDefault).toBe("@personal");
    expect(g?.tokenPool?.primaryOrgs).toEqual(["myorg"]);
  });

  test("oss_pool_tags は廃止 — yaml に書いてあっても無視（warn 想定）", async () => {
    const warnSpy: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => warnSpy.push(args.join(" "));
    try {
      writeFileSync(
        join(tmpHome, ".cmux-team/config.yaml"),
        "token_pool:\n  enabled: true\n  oss_pool_tags: [any]\n",
      );
      const g = await loadGlobalConfig();
      expect(g?.tokenPool?.enabled).toBe(true);
      // tokenPool には oss_pool_tags 由来のフィールドは存在しない
      expect((g?.tokenPool as Record<string, unknown> | undefined)?.ossPoolTags).toBeUndefined();
      // warn が出る（廃止アナウンス）
      expect(warnSpy.some((m) => m.includes("oss_pool_tags"))).toBe(true);
    } finally {
      console.warn = orig;
    }
  });

  test("primary_orgs に文字列以外混入 → 捨てる + warn", async () => {
    const warnSpy: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => warnSpy.push(args.join(" "));
    try {
      writeFileSync(
        join(tmpHome, ".cmux-team/config.yaml"),
        "token_pool:\n  primary_orgs: [myorg, 42, yourorg]\n",
      );
      const g = await loadGlobalConfig();
      expect(g?.tokenPool?.primaryOrgs).toEqual(["myorg", "yourorg"]);
      expect(warnSpy.length).toBeGreaterThan(0);
    } finally {
      console.warn = orig;
    }
  });

  test("config.yaml なし → null", async () => {
    const g = await loadGlobalConfig();
    expect(g).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveTokenPoolEnabled 既存挙動の非回帰
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveTokenPoolEnabled (既存挙動の非回帰)", () => {
  test("env CMUX_TEAM_TOKEN_POOL=1 → enabled (source=env)", () => {
    const r = resolveTokenPoolEnabled({}, null, { CMUX_TEAM_TOKEN_POOL: "1" });
    expect(r).toEqual({ enabled: true, source: "env" });
  });

  test("project tokenPool.enabled=false → false (source=project)", () => {
    const r = resolveTokenPoolEnabled({ tokenPool: { enabled: false } }, null, {});
    expect(r).toEqual({ enabled: false, source: "project" });
  });

  test("global tokenPool.enabled=true → true (source=global)", () => {
    const r = resolveTokenPoolEnabled({}, { tokenPool: { enabled: true } }, {});
    expect(r).toEqual({ enabled: true, source: "global" });
  });

  test("全部未指定 → false (source=default)", () => {
    const r = resolveTokenPoolEnabled({}, null, {});
    expect(r).toEqual({ enabled: false, source: "default" });
  });

  test("project tokenPool に default/include/exclude のみあって enabled 未指定 → next layer", () => {
    // TeamConfig.tokenPool に default/include/exclude を入れても enabled 解決には影響しない
    const r = resolveTokenPoolEnabled(
      { tokenPool: { default: "@a", include: ["@b"], exclude: ["@c"] } },
      { tokenPool: { enabled: true } },
      {},
    );
    expect(r).toEqual({ enabled: true, source: "global" });
  });
});
