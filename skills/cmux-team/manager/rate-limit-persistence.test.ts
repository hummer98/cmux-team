import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { RateLimitInfo } from "./schema";
import { persistRateLimit, loadRateLimit, isStale } from "./rate-limit-persistence";

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

describe("isStale", () => {
  const now = 1_700_000_000_000; // 固定時刻（ms）
  const nowSec = Math.floor(now / 1000);
  const future = String(nowSec + 3600);
  const past = String(nowSec - 3600);

  test("両方 null → stale", () => {
    const rl = makeInfo({ unified5hReset: null, unified7dReset: null });
    expect(isStale(rl, now)).toBe(true);
  });

  test("5h reset 未来 / 7d null → non-stale（OR 判定）", () => {
    const rl = makeInfo({ unified5hReset: future, unified7dReset: null });
    expect(isStale(rl, now)).toBe(false);
  });

  test("7d reset 未来 / 5h null → non-stale（OR 判定）", () => {
    const rl = makeInfo({ unified5hReset: null, unified7dReset: future });
    expect(isStale(rl, now)).toBe(false);
  });

  test("5h reset 過去 / 7d null → stale（片方過去 + 片方 null）", () => {
    const rl = makeInfo({ unified5hReset: past, unified7dReset: null });
    expect(isStale(rl, now)).toBe(true);
  });

  test("5h null / 7d reset 過去 → stale（片方過去 + 片方 null）", () => {
    const rl = makeInfo({ unified5hReset: null, unified7dReset: past });
    expect(isStale(rl, now)).toBe(true);
  });

  test("両方過去 → stale", () => {
    const rl = makeInfo({ unified5hReset: past, unified7dReset: past });
    expect(isStale(rl, now)).toBe(true);
  });

  test("両方未来 → non-stale", () => {
    const rl = makeInfo({ unified5hReset: future, unified7dReset: future });
    expect(isStale(rl, now)).toBe(false);
  });

  test("片方過去・片方未来 → non-stale（OR 判定で少なくとも1つ有効）", () => {
    const rl = makeInfo({ unified5hReset: past, unified7dReset: future });
    expect(isStale(rl, now)).toBe(false);
  });

  test("null 引数 → stale", () => {
    expect(isStale(null, now)).toBe(true);
  });

  test("unifiedStatus は isStale の直接判定に影響しない", () => {
    const rl = makeInfo({
      unified5hReset: future,
      unified7dReset: future,
      unifiedStatus: "rate_limited",
    });
    expect(isStale(rl, now)).toBe(false);
  });
});
