import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { log } from "./logger";

const SENTINEL = `regression_sentinel_${Date.now()}_${Math.random().toString(36).slice(2)}`;
const cwdLogFile = join(process.cwd(), ".team/logs/manager.log");

async function countSentinelInCwdLog(): Promise<number> {
  try {
    const content = await readFile(cwdLogFile, "utf-8");
    const matches = content.match(new RegExp(SENTINEL, "g"));
    return matches ? matches.length : 0;
  } catch {
    return 0;
  }
}

let baselineSentinelCount = 0;

beforeAll(async () => {
  baselineSentinelCount = await countSentinelInCwdLog();
});

afterAll(async () => {
  const after = await countSentinelInCwdLog();
  expect(after).toBe(baselineSentinelCount);
});

let tmpdirA: string;
let tmpdirB: string;
let savedProjectRoot: string | undefined;

beforeEach(async () => {
  savedProjectRoot = process.env.PROJECT_ROOT;
  tmpdirA = await mkdtemp(join(tmpdir(), "cmux-logger-test-a-"));
  tmpdirB = await mkdtemp(join(tmpdir(), "cmux-logger-test-b-"));
});

afterEach(async () => {
  if (savedProjectRoot !== undefined) {
    process.env.PROJECT_ROOT = savedProjectRoot;
  } else {
    delete process.env.PROJECT_ROOT;
  }
  await rm(tmpdirA, { recursive: true, force: true });
  await rm(tmpdirB, { recursive: true, force: true });
});

describe("logger - PROJECT_ROOT 遅延評価", () => {
  test("log() 呼び出し時に PROJECT_ROOT を都度評価する", async () => {
    process.env.PROJECT_ROOT = tmpdirA;
    const event = `${SENTINEL}_case1`;
    await log(event, "detail=1");

    const logPath = join(tmpdirA, ".team/logs/manager.log");
    const content = await readFile(logPath, "utf-8");
    expect(content).toContain(event);
    expect(content).toContain("detail=1");
  });

  test("同一プロセス内で PROJECT_ROOT を切り替えると書き込み先も切り替わる", async () => {
    const eventA = `${SENTINEL}_event_A`;
    const eventB = `${SENTINEL}_event_B`;

    process.env.PROJECT_ROOT = tmpdirA;
    await log(eventA, "from=A");

    process.env.PROJECT_ROOT = tmpdirB;
    await log(eventB, "from=B");

    const logA = await readFile(join(tmpdirA, ".team/logs/manager.log"), "utf-8");
    const logB = await readFile(join(tmpdirB, ".team/logs/manager.log"), "utf-8");

    expect(logA).toContain(eventA);
    expect(logA).not.toContain(eventB);
    expect(logB).toContain(eventB);
    expect(logB).not.toContain(eventA);
  });

  test("PROJECT_ROOT を tmpdir に向けた log() 呼び出しが cwd の manager.log を汚染しない", async () => {
    const before = await countSentinelInCwdLog();

    process.env.PROJECT_ROOT = tmpdirA;
    await log(`${SENTINEL}_case3`, "detail=3");

    const after = await countSentinelInCwdLog();
    expect(after).toBe(before);
  });
});
