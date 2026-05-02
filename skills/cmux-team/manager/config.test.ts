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
  resolveMetricsRefreshIntervalMs,
  resolveGcConfig,
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

// ─────────────────────────────────────────────────────────────────────────────
// resolveMetricsRefreshIntervalMs (T354)
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveMetricsRefreshIntervalMs (T354)", () => {
  test("未指定 → default 10_000", () => {
    expect(resolveMetricsRefreshIntervalMs({})).toBe(10_000);
  });
  test("undefined 明示 → default", () => {
    expect(
      resolveMetricsRefreshIntervalMs({ metricsRefreshIntervalMs: undefined }),
    ).toBe(10_000);
  });
  test("正常値 5_000 → そのまま", () => {
    expect(
      resolveMetricsRefreshIntervalMs({ metricsRefreshIntervalMs: 5_000 }),
    ).toBe(5_000);
  });
  test("正常値 600_000 (上限) → そのまま", () => {
    expect(
      resolveMetricsRefreshIntervalMs({ metricsRefreshIntervalMs: 600_000 }),
    ).toBe(600_000);
  });
  test("下限 1_000 → そのまま", () => {
    expect(
      resolveMetricsRefreshIntervalMs({ metricsRefreshIntervalMs: 1_000 }),
    ).toBe(1_000);
  });
  test("下限未満 999 → default にフォールバック", () => {
    expect(
      resolveMetricsRefreshIntervalMs({ metricsRefreshIntervalMs: 999 }),
    ).toBe(10_000);
  });
  test("上限超 600_001 → default", () => {
    expect(
      resolveMetricsRefreshIntervalMs({ metricsRefreshIntervalMs: 600_001 }),
    ).toBe(10_000);
  });
  test("0 / 負 → default", () => {
    expect(
      resolveMetricsRefreshIntervalMs({ metricsRefreshIntervalMs: 0 }),
    ).toBe(10_000);
    expect(
      resolveMetricsRefreshIntervalMs({ metricsRefreshIntervalMs: -1 }),
    ).toBe(10_000);
  });
  test("NaN / Infinity → default", () => {
    expect(
      resolveMetricsRefreshIntervalMs({ metricsRefreshIntervalMs: NaN }),
    ).toBe(10_000);
    expect(
      resolveMetricsRefreshIntervalMs({ metricsRefreshIntervalMs: Infinity }),
    ).toBe(10_000);
  });
  test("型違反（string）→ default", () => {
    // @ts-expect-error: 意図的に型違反
    expect(resolveMetricsRefreshIntervalMs({ metricsRefreshIntervalMs: "5000" })).toBe(10_000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveGcConfig (T416)
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveGcConfig (T416)", () => {
  test("gc 未指定 → 全 default", () => {
    const r = resolveGcConfig({});
    expect(r.runOnStart).toBe(true);
    expect(r.periodic).toBe(true);
    expect(r.intervalMs).toBe(86_400_000);
    expect(r.dryRun).toBe(false);
    expect(r.retention.bodiesDays).toBe(14);
    expect(r.retention.promptsDays).toBe(14);
    expect(r.retention.queueProcessedDays).toBe(7);
    expect(r.retention.outputDays).toBe(14);
    expect(r.retention.conductorsDays).toBe(14);
    expect(r.retention.e2eResultsDays).toBe(7);
    expect(r.retention.dbDays).toBe(30);
    expect(r.rotation.sizeBytes).toBe(10_485_760);
    expect(r.rotation.keep).toBe(5);
  });

  test("e2eResultsDays 未指定 default は 7", () => {
    const r = resolveGcConfig({ gc: { retention: {} } });
    expect(r.retention.e2eResultsDays).toBe(7);
  });

  test("intervalMs 範囲内（2h）はそのまま返る", () => {
    const r = resolveGcConfig({ gc: { intervalMs: 7_200_000 } });
    expect(r.intervalMs).toBe(7_200_000);
  });

  test("intervalMs 範囲外（30 分）→ default", () => {
    const r = resolveGcConfig({ gc: { intervalMs: 1_800_000 } });
    expect(r.intervalMs).toBe(86_400_000);
  });

  test("intervalMs 範囲外（10 day）→ default", () => {
    const r = resolveGcConfig({ gc: { intervalMs: 864_000_000 } });
    expect(r.intervalMs).toBe(86_400_000);
  });

  test("intervalMs 不正値（-1）→ default", () => {
    const r = resolveGcConfig({ gc: { intervalMs: -1 } });
    expect(r.intervalMs).toBe(86_400_000);
  });

  test("intervalMs NaN / Infinity → default", () => {
    expect(resolveGcConfig({ gc: { intervalMs: NaN } }).intervalMs).toBe(86_400_000);
    expect(resolveGcConfig({ gc: { intervalMs: Infinity } }).intervalMs).toBe(86_400_000);
  });

  test("型違反 boolean（string）→ default", () => {
    // @ts-expect-error: 意図的に型違反
    const r = resolveGcConfig({ gc: { runOnStart: "true", periodic: 1 } });
    expect(r.runOnStart).toBe(true);
    expect(r.periodic).toBe(true);
  });

  test("retention.*Days = 0 は受理する（active 保護 race 警告は呼び出し側）", () => {
    const r = resolveGcConfig({
      gc: { retention: { bodiesDays: 0, promptsDays: 0 } },
    });
    expect(r.retention.bodiesDays).toBe(0);
    expect(r.retention.promptsDays).toBe(0);
  });

  test("retention.*Days < 0 → default", () => {
    const r = resolveGcConfig({ gc: { retention: { bodiesDays: -1 } } });
    expect(r.retention.bodiesDays).toBe(14);
  });

  test("retention.*Days NaN / Infinity → default", () => {
    const r = resolveGcConfig({
      gc: { retention: { dbDays: NaN, e2eResultsDays: Infinity } },
    });
    expect(r.retention.dbDays).toBe(30);
    expect(r.retention.e2eResultsDays).toBe(7);
  });

  test("rotation.sizeBytes 1MB 未満 → default", () => {
    const r = resolveGcConfig({ gc: { rotation: { sizeBytes: 1024 } } });
    expect(r.rotation.sizeBytes).toBe(10_485_760);
  });

  test("rotation.sizeBytes 範囲内（5MB）はそのまま", () => {
    const r = resolveGcConfig({ gc: { rotation: { sizeBytes: 5 * 1024 * 1024 } } });
    expect(r.rotation.sizeBytes).toBe(5 * 1024 * 1024);
  });

  test("rotation.keep 範囲外（0 / 51）→ default", () => {
    expect(resolveGcConfig({ gc: { rotation: { keep: 0 } } }).rotation.keep).toBe(5);
    expect(resolveGcConfig({ gc: { rotation: { keep: 51 } } }).rotation.keep).toBe(5);
  });

  test("rotation.keep 範囲内（3）はそのまま", () => {
    expect(resolveGcConfig({ gc: { rotation: { keep: 3 } } }).rotation.keep).toBe(3);
  });

  test("retention の一部だけ指定すると残りは default で埋まる", () => {
    const r = resolveGcConfig({ gc: { retention: { dbDays: 7 } } });
    expect(r.retention.dbDays).toBe(7);
    expect(r.retention.bodiesDays).toBe(14);
    expect(r.retention.e2eResultsDays).toBe(7);
  });
});
