import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFile } from "fs/promises";
import { join } from "path";
import { createDummyProject, type DummyProject } from "./test-project";
import { installDashboardConsoleRedirect } from "./dashboard-console-redirect";

let project: DummyProject;
let restore: () => void = () => {};
let origWarn: typeof console.warn;
let origError: typeof console.error;

beforeEach(async () => {
  project = await createDummyProject({ prefix: "cmux-console-redirect-" });

  // 原 console.warn / error を保存（テスト内で別 stub に差し替えるケースの後始末用）
  origWarn = console.warn;
  origError = console.error;
});

afterEach(async () => {
  restore();
  restore = () => {};
  console.warn = origWarn;
  console.error = origError;
  await project.dispose();
});

async function readManagerLog(): Promise<string> {
  try {
    return await readFile(join(project.root, ".team/logs/manager.log"), "utf-8");
  } catch {
    return "";
  }
}

// fire-and-forget な void logWarn(...) が完了するのを待つ helper。
// append は mkdir + appendFile の連鎖なので microtask だけでは足りない。
// 50ms 待ち + setImmediate flush で fs 完了を待つ。
async function flushAsyncLog(): Promise<void> {
  await new Promise((r) => setTimeout(r, 50));
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setImmediate(r));
  }
}

describe("dashboard-console-redirect", () => {
  test("console.warn 後 manager.log に [warn] 行が追記される", async () => {
    ({ restore } = installDashboardConsoleRedirect());

    console.warn("test warning message");
    await flushAsyncLog();

    const content = await readManagerLog();
    expect(content).toMatch(/\[warn\] console_warn test warning message/);
  });

  test("redirect 中は原 console.warn / error が呼ばれない（残骸防止の主要検証）", async () => {
    let warnCalls = 0;
    let errorCalls = 0;
    console.warn = () => { warnCalls++; };
    console.error = () => { errorCalls++; };

    ({ restore } = installDashboardConsoleRedirect());

    console.warn("warn 残骸");
    console.error("error 残骸");
    await flushAsyncLog();

    // すり替え時は原 console.warn / error が呼ばれないため count は 0
    expect(warnCalls).toBe(0);
    expect(errorCalls).toBe(0);

    // 一方 manager.log には流れている
    const content = await readManagerLog();
    expect(content).toMatch(/\[warn\] console_warn warn 残骸/);
    expect(content).toMatch(/\[error\] console_error error 残骸/);
  });

  test("restore() で原 console.warn / error が復元される", async () => {
    let warnCalls = 0;
    console.warn = (msg: string) => { warnCalls++; };

    const { restore: doRestore } = installDashboardConsoleRedirect();
    doRestore();

    // restore 後は元の stub が再び呼ばれる
    console.warn("after restore");
    expect(warnCalls).toBe(1);
  });
});
