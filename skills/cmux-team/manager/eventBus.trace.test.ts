import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

let savedTrace: string | undefined;
let savedProjectRoot: string | undefined;
let tmpRoot: string;

beforeAll(async () => {
  savedTrace = process.env.CMUX_TEAM_TRACE_EVENTS;
  savedProjectRoot = process.env.PROJECT_ROOT;
  tmpRoot = await mkdtemp(join(tmpdir(), "cmux-eventbus-trace-"));
  process.env.CMUX_TEAM_TRACE_EVENTS = "1";
  process.env.PROJECT_ROOT = tmpRoot;
});

afterAll(async () => {
  if (savedTrace !== undefined) {
    process.env.CMUX_TEAM_TRACE_EVENTS = savedTrace;
  } else {
    delete process.env.CMUX_TEAM_TRACE_EVENTS;
  }
  if (savedProjectRoot !== undefined) {
    process.env.PROJECT_ROOT = savedProjectRoot;
  } else {
    delete process.env.PROJECT_ROOT;
  }
  await rm(tmpRoot, { recursive: true, force: true });
});

describe("eventBus TRACE", () => {
  test("CMUX_TEAM_TRACE_EVENTS=1 なら notify 時に event_emit が manager.log に書かれる", async () => {
    const mod = await import(`./eventBus?trace=${Date.now()}`);
    mod.__resetBusForTest();
    const source = `trace-test:${Math.random().toString(36).slice(2)}`;
    mod.notifyStateChanged(source);

    // fire-and-forget の log() が書き終わるまで少し待つ
    await new Promise((r) => setTimeout(r, 100));

    const logPath = join(tmpRoot, ".team/logs/manager.log");
    const content = await readFile(logPath, "utf-8");
    expect(content).toContain("event_emit");
    expect(content).toContain("event=state-changed");
    expect(content).toContain(`source=${source}`);
  });
});
