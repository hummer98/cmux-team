/**
 * reload.ts (T423 S1) — daemon reload helper のテスト
 *
 * 全 DI で外部副作用を捕えてシーケンスと spawn options を検証する。
 */
import { describe, test, expect } from "bun:test";
import type { ChildProcess } from "child_process";
import { performDaemonReload } from "./reload";

interface SpawnCall {
  cmd: string;
  args: readonly string[];
  options: Record<string, unknown>;
}

interface ReloadHarness {
  pidFilePath: string;
  latestMainTs: string;
  events: string[];
  spawnCalls: SpawnCall[];
  releaseCalls: string[];
  exitCalls: number[];
  logs: Array<{ event: string; detail: string }>;
  unrefCount: number;
}

type HarnessOverrides = {
  spawnPidUndefined?: boolean;
  releaseImpl?: (path: string) => Promise<void>;
};

const makeHarness = (
  overrides: HarnessOverrides = {},
): ReloadHarness & { run: () => Promise<void> } => {
  const harness: ReloadHarness & { run: () => Promise<void> } = {
    pidFilePath: "/tmp/test/.team/daemon.pid",
    latestMainTs: "/tmp/test/skills/cmux-team/manager/main.ts",
    events: [],
    spawnCalls: [],
    releaseCalls: [],
    exitCalls: [],
    logs: [],
    unrefCount: 0,
    run: async () => {},
  };

  harness.run = (): Promise<void> =>
    performDaemonReload({
      pidFilePath: harness.pidFilePath,
      latestMainTs: harness.latestMainTs,
      releaseImpl:
        overrides.releaseImpl ??
        (async (path) => {
          harness.releaseCalls.push(path);
          harness.events.push("release");
        }),
      spawnImpl: ((cmd: string, args: readonly string[], options: any) => {
        harness.spawnCalls.push({ cmd, args, options });
        harness.events.push("spawn");
        return {
          pid: overrides.spawnPidUndefined ? undefined : 99999,
          unref: () => {
            harness.unrefCount++;
            harness.events.push("unref");
          },
        } as unknown as ChildProcess;
      }) as any,
      exitImpl: (code) => {
        harness.exitCalls.push(code);
        harness.events.push(`exit:${code}`);
      },
      logImpl: async (event, detail) => {
        harness.logs.push({ event, detail });
        harness.events.push(`log:${event}`);
      },
    });

  return harness;
};

describe("performDaemonReload", () => {
  test("release → spawn → log → unref → exit(0) の順で実行される", async () => {
    const h = makeHarness();
    await h.run();
    expect(h.events).toEqual([
      "release",
      "spawn",
      "log:daemon_reload_spawned",
      "unref",
      "exit:0",
    ]);
  });

  test("release は pidFilePath で 1 回だけ呼ばれる", async () => {
    const h = makeHarness();
    await h.run();
    expect(h.releaseCalls).toEqual([h.pidFilePath]);
  });

  test("spawn の options が正しい (deep equal)", async () => {
    const h = makeHarness();
    await h.run();
    expect(h.spawnCalls.length).toBe(1);
    const call = h.spawnCalls[0]!;
    expect(call.cmd).toBe("bun");
    expect(call.args).toEqual(["run", h.latestMainTs, "start"]);
    expect(call.options).toEqual({
      stdio: "inherit",
      env: process.env,
      cwd: process.cwd(),
      detached: true,
    });
  });

  test("exit は code=0 で 1 回だけ呼ばれる", async () => {
    const h = makeHarness();
    await h.run();
    expect(h.exitCalls).toEqual([0]);
  });

  test("log には child_pid と latestMainTs が含まれる", async () => {
    const h = makeHarness();
    await h.run();
    const reloadLog = h.logs.find((l) => l.event === "daemon_reload_spawned");
    expect(reloadLog).toBeDefined();
    expect(reloadLog!.detail).toContain("child_pid=99999");
    expect(reloadLog!.detail).toContain(`latestMainTs=${h.latestMainTs}`);
  });

  test("child.pid が undefined でも log に NaN を入れず 'unknown' を出力する (defensive)", async () => {
    const h = makeHarness({ spawnPidUndefined: true });
    await h.run();
    const reloadLog = h.logs.find((l) => l.event === "daemon_reload_spawned");
    expect(reloadLog).toBeDefined();
    expect(reloadLog!.detail).toContain("child_pid=unknown");
    expect(reloadLog!.detail).not.toContain("NaN");
  });

  test("unref は spawn 後・exit 前にちょうど 1 回呼ばれる", async () => {
    const h = makeHarness();
    await h.run();
    expect(h.unrefCount).toBe(1);
    const unrefIdx = h.events.indexOf("unref");
    const spawnIdx = h.events.indexOf("spawn");
    const exitIdx = h.events.indexOf("exit:0");
    expect(spawnIdx).toBeLessThan(unrefIdx);
    expect(unrefIdx).toBeLessThan(exitIdx);
  });

  test("release が internal log を出すが throw しない契約に依存する (releasePidFile contract)", async () => {
    // releasePidFile は ENOENT を握り潰し、それ以外も await log(...) で吸収して return する設計のため
    // throw しない契約（pidfile.ts:141-148）。reload helper はこの invariant に依存しているので、
    // 「release が throw しても spawn と exit は呼ばれる」test は意図的に置いていない。
    // 代わりに、release が解決すれば spawn と exit が呼ばれることを assert する。
    const h = makeHarness({
      releaseImpl: async (path) => {
        // simulate releasePidFile with internal log but no throw
        h.releaseCalls.push(path);
        h.events.push("release");
      },
    });
    await h.run();
    expect(h.releaseCalls.length).toBe(1);
    expect(h.spawnCalls.length).toBe(1);
    expect(h.exitCalls).toEqual([0]);
  });

  test("latestMainTs が相対パスでも spawn には絶対パスを渡す (cwd 依存除去)", async () => {
    const h = makeHarness();
    await performDaemonReload({
      pidFilePath: h.pidFilePath,
      latestMainTs: "skills/cmux-team/manager/main.ts",
      releaseImpl: async (path) => {
        h.releaseCalls.push(path);
        h.events.push("release");
      },
      spawnImpl: ((cmd: string, args: readonly string[], options: any) => {
        h.spawnCalls.push({ cmd, args, options });
        h.events.push("spawn");
        return {
          pid: 1,
          unref: () => {
            h.unrefCount++;
            h.events.push("unref");
          },
        } as unknown as ChildProcess;
      }) as any,
      exitImpl: (code) => {
        h.exitCalls.push(code);
        h.events.push(`exit:${code}`);
      },
      logImpl: async (event, detail) => {
        h.logs.push({ event, detail });
        h.events.push(`log:${event}`);
      },
    });
    expect(h.spawnCalls.length).toBe(1);
    const passedPath = h.spawnCalls[0]!.args[1]!;
    // 絶対パス ("/" 始まり on POSIX) になっていること
    expect(passedPath.startsWith("/")).toBe(true);
  });
});
