import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { RateLimitInfo } from "./schema";
import {
  persistRateLimit,
  loadRateLimit,
  isStale5h,
  isStale7d,
} from "./rate-limit-persistence";

let testDir: string;
let savedProjectRoot: string | undefined;

function makeInfo(overrides: Partial<RateLimitInfo> = {}): RateLimitInfo {
  return {
    tokensRemaining: 100,
    tokensLimit: 1000,
    tokensReset: "2026-04-17T01:00:00Z",
    inputTokensRemaining: 50,
    outputTokensRemaining: 50,
    unified5hUtilization: 0.42,
    unified7dUtilization: 0.17,
    unified5hReset: String(Math.floor(Date.now() / 1000) + 3600),
    unified7dReset: String(Math.floor(Date.now() / 1000) + 86400),
    unifiedStatus: "allowed",
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "cmux-rate-limit-persistence-test-"));
  savedProjectRoot = process.env.PROJECT_ROOT;
  process.env.PROJECT_ROOT = testDir;
  await mkdir(join(testDir, ".team"), { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
  if (savedProjectRoot !== undefined) {
    process.env.PROJECT_ROOT = savedProjectRoot;
  } else {
    delete process.env.PROJECT_ROOT;
  }
});

describe("persistRateLimit / loadRateLimit", () => {
  test("round-trip: 書き込んだ値を読み戻すと同一", async () => {
    const info = makeInfo({ unified5hUtilization: 0.5, unifiedStatus: "rate_limited" });
    await persistRateLimit(testDir, info);
    const loaded = await loadRateLimit(testDir);
    expect(loaded).toEqual(info);
  });

  test("ファイルが存在しない場合は null", async () => {
    const loaded = await loadRateLimit(testDir);
    expect(loaded).toBeNull();
  });

  test("破損した JSON の場合は null", async () => {
    await writeFile(join(testDir, ".team/rate-limit.json"), "{ broken");
    const loaded = await loadRateLimit(testDir);
    expect(loaded).toBeNull();
  });

  test("フィールド型不一致（文字列 vs number）の場合は null", async () => {
    const bad = {
      ...makeInfo(),
      unified5hUtilization: "0.5",
    } as unknown as RateLimitInfo;
    await writeFile(
      join(testDir, ".team/rate-limit.json"),
      JSON.stringify(bad),
    );
    const loaded = await loadRateLimit(testDir);
    expect(loaded).toBeNull();
  });

  test("必須フィールドが欠落した JSON は null", async () => {
    await writeFile(join(testDir, ".team/rate-limit.json"), "{}");
    const loaded = await loadRateLimit(testDir);
    expect(loaded).toBeNull();
  });

  test("atomic write: .tmp ファイルは残らない", async () => {
    const info = makeInfo();
    await persistRateLimit(testDir, info);
    expect(existsSync(join(testDir, ".team/rate-limit.json"))).toBe(true);
    expect(existsSync(join(testDir, ".team/rate-limit.json.tmp"))).toBe(false);
  });

  test("上書き書き込みでも整合性が保たれる", async () => {
    await persistRateLimit(testDir, makeInfo({ unified5hUtilization: 0.3 }));
    await persistRateLimit(testDir, makeInfo({ unified5hUtilization: 0.6 }));
    const loaded = await loadRateLimit(testDir);
    expect(loaded?.unified5hUtilization).toBe(0.6);
  });
});

describe("isStale5h", () => {
  const now = 1_700_000_000_000; // 固定時刻（ms）
  const nowSec = Math.floor(now / 1000);
  const future = String(nowSec + 3600);
  const past = String(nowSec - 3600);

  test("rl=null → stale", () => {
    expect(isStale5h(null, now)).toBe(true);
  });

  test("rl=undefined → stale", () => {
    expect(isStale5h(undefined, now)).toBe(true);
  });

  test("unified5hReset=null → stale（7d が未来でも影響しない）", () => {
    const rl = makeInfo({ unified5hReset: null, unified7dReset: future });
    expect(isStale5h(rl, now)).toBe(true);
  });

  test("unified5hReset 過去 → stale", () => {
    const rl = makeInfo({ unified5hReset: past, unified7dReset: future });
    expect(isStale5h(rl, now)).toBe(true);
  });

  test("unified5hReset 未来 → non-stale（7d が過去でも影響しない）", () => {
    const rl = makeInfo({ unified5hReset: future, unified7dReset: past });
    expect(isStale5h(rl, now)).toBe(false);
  });

  test("T281 リグレッション: 5h 過去 / 7d 未来 → 5h は stale", () => {
    const rl = makeInfo({ unified5hReset: past, unified7dReset: future });
    expect(isStale5h(rl, now)).toBe(true);
  });

  test("解釈不能な reset 文字列 → stale", () => {
    const rl = makeInfo({ unified5hReset: "not-a-date" });
    expect(isStale5h(rl, now)).toBe(true);
  });

  test("unifiedStatus は isStale5h の直接判定に影響しない", () => {
    const rl = makeInfo({
      unified5hReset: future,
      unified7dReset: future,
      unifiedStatus: "rate_limited",
    });
    expect(isStale5h(rl, now)).toBe(false);
  });
});

describe("isStale7d", () => {
  const now = 1_700_000_000_000;
  const nowSec = Math.floor(now / 1000);
  const future = String(nowSec + 86400);
  const past = String(nowSec - 86400);

  test("rl=null → stale", () => {
    expect(isStale7d(null, now)).toBe(true);
  });

  test("rl=undefined → stale", () => {
    expect(isStale7d(undefined, now)).toBe(true);
  });

  test("unified7dReset=null → stale（5h が未来でも影響しない）", () => {
    const rl = makeInfo({ unified5hReset: future, unified7dReset: null });
    expect(isStale7d(rl, now)).toBe(true);
  });

  test("unified7dReset 過去 → stale", () => {
    const rl = makeInfo({ unified5hReset: future, unified7dReset: past });
    expect(isStale7d(rl, now)).toBe(true);
  });

  test("unified7dReset 未来 → non-stale（5h が過去でも影響しない）", () => {
    const rl = makeInfo({ unified5hReset: past, unified7dReset: future });
    expect(isStale7d(rl, now)).toBe(false);
  });

  test("解釈不能な reset 文字列 → stale", () => {
    const rl = makeInfo({ unified7dReset: "bogus" });
    expect(isStale7d(rl, now)).toBe(true);
  });
});
