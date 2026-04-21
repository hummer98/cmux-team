import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFile } from "fs/promises";
import { join } from "path";
import { createDummyProject, type DummyProject } from "./test-project";

let savedTrace: string | undefined;
let project: DummyProject;
let tmpRoot: string;

beforeAll(async () => {
  savedTrace = process.env.CMUX_TEAM_TRACE_EVENTS;
  project = await createDummyProject({
    prefix: "cmux-eventbus-trace-",
    subdirs: ["logs"],
  });
  tmpRoot = project.root;
  process.env.CMUX_TEAM_TRACE_EVENTS = "1";
});

afterAll(async () => {
  if (savedTrace !== undefined) {
    process.env.CMUX_TEAM_TRACE_EVENTS = savedTrace;
  } else {
    delete process.env.CMUX_TEAM_TRACE_EVENTS;
  }
  await project.dispose();
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
