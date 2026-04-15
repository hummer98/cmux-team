import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "child_process";
import {
  generateConductorSettings,
  generateAgentSettings,
  generateMasterSettings,
  ensureMasterHookScripts,
  buildMessageFromHookInput,
  normalizeSurfaceArg,
  validateSendAgentTarget,
  waitForAgentRegistered,
  resolveLayout,
  resolveAutoUpdateMode,
  ensureAskDetectorScript,
} from "./main";
import * as cmux from "./cmux";
import { normalizeAutoUpdate } from "./schema";

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "cmux-main-test-"));
});

afterEach(async () => {
  try { await rm(testDir, { recursive: true, force: true }); } catch {}
});

// --- §4.1 generateConductorSettings の PreToolUse hook 構成テスト ---

describe("generateConductorSettings - PreToolUse hook (§4.1)", () => {
  test("PreToolUse hook が Bash matcher で追加される", async () => {
    await mkdir(join(testDir, ".team/prompts"), { recursive: true });
    const settingsPath = generateConductorSettings(testDir);
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));

    expect(Array.isArray(settings.hooks.PreToolUse)).toBe(true);
    expect(settings.hooks.PreToolUse.length).toBe(1);
    const entry = settings.hooks.PreToolUse[0];
    expect(entry.matcher).toBe("Bash");
    expect(entry.hooks.length).toBe(1);
    expect(entry.hooks[0].type).toBe("command");
    expect(entry.hooks[0].timeout).toBe(3000);
  });

  test("hook の command に cmux, send, exit 2 と日本語エラー文が含まれる (R3)", async () => {
    const settingsPath = generateConductorSettings(testDir);
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    const cmd: string = settings.hooks.PreToolUse[0].hooks[0].command;
    expect(cmd).toContain("cmux");
    expect(cmd).toContain("send");
    expect(cmd).toContain("exit 2");
    expect(cmd).toContain("cmux send / cmux send-key は Conductor から使用禁止です。");
    // R3: 代替コマンド行
    expect(cmd).toContain("cmux-team send-agent --surface");
  });

  test("既存の SessionStart / Stop / SessionEnd hook が残存している (regression)", async () => {
    const settingsPath = generateConductorSettings(testDir);
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    expect(settings.hooks.SessionStart.length).toBe(1);
    expect(settings.hooks.Stop.length).toBe(1);
    expect(settings.hooks.SessionEnd.length).toBe(2);
  });
});

// --- §4.2 hook bash スクリプトの挙動テスト ---

async function runHook(
  script: string,
  toolInputJson: string,
): Promise<{ code: number; stderr: string }> {
  return await new Promise((resolve) => {
    const proc = spawn("bash", ["-c", script]);
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => resolve({ code: code ?? 0, stderr }));
    proc.stdin.write(toolInputJson);
    proc.stdin.end();
  });
}

function extractHookScript(settings: any): string {
  // 生成形式: `bash -c '<script>'`
  const cmd: string = settings.hooks.PreToolUse[0].hooks[0].command;
  const m = cmd.match(/^bash -c '([\s\S]*)'$/);
  if (!m) throw new Error(`unexpected hook command format: ${cmd}`);
  return m[1]!;
}

describe("PreToolUse hook 挙動 (§4.2)", () => {
  let script: string;

  beforeEach(async () => {
    const settingsPath = generateConductorSettings(testDir);
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    script = extractHookScript(settings);
  });

  const cases: Array<{
    label: string;
    payload: string;
    expectCode: number;
    expectBlocked: boolean;
  }> = [
    {
      label: "cmux send is blocked",
      payload: JSON.stringify({ tool_name: "Bash", tool_input: { command: "cmux send surface:382 hello" } }),
      expectCode: 2,
      expectBlocked: true,
    },
    {
      label: "cmux send with double space is blocked",
      payload: JSON.stringify({ tool_name: "Bash", tool_input: { command: "cmux  send surface:382 hi" } }),
      expectCode: 2,
      expectBlocked: true,
    },
    {
      label: "cmux send-key is blocked",
      payload: JSON.stringify({ tool_name: "Bash", tool_input: { command: "cmux send-key surface:382 return" } }),
      expectCode: 2,
      expectBlocked: true,
    },
    {
      label: "cmux-team spawn-agent passes",
      payload: JSON.stringify({ tool_name: "Bash", tool_input: { command: "cmux-team spawn-agent --role impl" } }),
      expectCode: 0,
      expectBlocked: false,
    },
    {
      label: "cmux-team send-agent passes",
      payload: JSON.stringify({ tool_name: "Bash", tool_input: { command: "cmux-team send-agent --surface surface:382 hi" } }),
      expectCode: 0,
      expectBlocked: false,
    },
    {
      label: "cmux-team send passes (subcommand of cmux-team)",
      payload: JSON.stringify({ tool_name: "Bash", tool_input: { command: "cmux-team send SESSION_STARTED" } }),
      expectCode: 0,
      expectBlocked: false,
    },
    {
      label: "cmux read-screen passes",
      payload: JSON.stringify({ tool_name: "Bash", tool_input: { command: "cmux read-screen --surface surface:382" } }),
      expectCode: 0,
      expectBlocked: false,
    },
    {
      label: "cmux tree passes",
      payload: JSON.stringify({ tool_name: "Bash", tool_input: { command: "cmux tree" } }),
      expectCode: 0,
      expectBlocked: false,
    },
    {
      label: "cmux close-surface passes",
      payload: JSON.stringify({ tool_name: "Bash", tool_input: { command: "cmux close-surface --surface surface:382" } }),
      expectCode: 0,
      expectBlocked: false,
    },
    {
      label: "generic shell command passes",
      payload: JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls -la && git status" } }),
      expectCode: 0,
      expectBlocked: false,
    },
    // R4: 変則ペイロード
    {
      label: "description に cmux send を含むが command は別物 — 通過すべき",
      payload: JSON.stringify({
        tool_name: "Bash",
        tool_input: {
          description: "run cmux send example",
          command: "ls",
        },
      }),
      expectCode: 0,
      expectBlocked: false,
    },
  ];

  for (const c of cases) {
    test(c.label, async () => {
      const { code, stderr } = await runHook(script, c.payload);
      expect(code).toBe(c.expectCode);
      if (c.expectBlocked) {
        expect(stderr).toContain("cmux send / cmux send-key は Conductor から使用禁止です。");
        expect(stderr).toContain("cmux-team send-agent --surface");
      } else {
        expect(stderr).toBe("");
      }
    });
  }
});

// --- §4.3 send-agent 検証ロジックテスト ---

const sampleTeamJson = {
  conductors: [
    {
      surface: "surface:100",
      taskId: "169",
      agents: [
        { surface: "surface:382", role: "impl" },
      ],
    },
    {
      surface: "surface:200",
      taskId: "170",
      agents: [
        { surface: "surface:420", role: "impl" },
      ],
    },
  ],
};

describe("validateSendAgentTarget (§4.3)", () => {
  test("caller が Conductor、target が caller.agents にある → ok", () => {
    const r = validateSendAgentTarget(sampleTeamJson, "surface:100", "surface:382");
    expect(r).toEqual({ ok: true });
  });

  test("target が caller.agents にない → reject agent_not_found", () => {
    const r = validateSendAgentTarget(sampleTeamJson, "surface:100", "surface:999");
    expect(r).toEqual({ ok: false, reason: "agent_not_found" });
  });

  test("target が他の Conductor の surface → reject agent_not_found", () => {
    const r = validateSendAgentTarget(sampleTeamJson, "surface:100", "surface:200");
    expect(r).toEqual({ ok: false, reason: "agent_not_found" });
  });

  test("target が他の Conductor の Agent → reject agent_not_found", () => {
    const r = validateSendAgentTarget(sampleTeamJson, "surface:100", "surface:420");
    expect(r).toEqual({ ok: false, reason: "agent_not_found" });
  });

  test("自己送信 → reject self_send", () => {
    const r = validateSendAgentTarget(sampleTeamJson, "surface:100", "surface:100");
    expect(r).toEqual({ ok: false, reason: "self_send" });
  });

  test("caller が teamJson.conductors にない → reject not_a_conductor", () => {
    const r = validateSendAgentTarget(sampleTeamJson, "surface:999", "surface:382");
    expect(r).toEqual({ ok: false, reason: "not_a_conductor" });
  });
});

describe("resolveLayout (T176)", () => {
  test("default: config なし・CLI なし → wide", () => {
    expect(resolveLayout({}, undefined)).toBe("wide");
  });

  test("config.layout=16x9, CLI なし → 16x9", () => {
    expect(resolveLayout({ layout: "16x9" }, undefined)).toBe("16x9");
  });

  test("config.layout=16x9, CLI=wide → wide（CLI 優先）", () => {
    expect(resolveLayout({ layout: "16x9" }, "wide")).toBe("wide");
  });

  test("config なし, CLI=16x9 → 16x9", () => {
    expect(resolveLayout({}, "16x9")).toBe("16x9");
  });

  test("不正値 (CLI) → throw", () => {
    expect(() => resolveLayout({}, "invalid")).toThrow(/Unknown layout/);
  });

  test("不正値 (config) → throw", () => {
    expect(() => resolveLayout({ layout: "foo" as any }, undefined)).toThrow(/Unknown layout/);
  });
});

describe("resolveAutoUpdateMode (T187)", () => {
  test("env=1 → task, source=env（config を上書き）", () => {
    expect(resolveAutoUpdateMode({ autoUpdate: true }, { CMUX_TEAM_AUTO_UPDATE: "1" }))
      .toEqual({ mode: "task", source: "env" });
  });

  test("env=true → task, source=env", () => {
    expect(resolveAutoUpdateMode({}, { CMUX_TEAM_AUTO_UPDATE: "true" }))
      .toEqual({ mode: "task", source: "env" });
  });

  test("env=task → task, source=env", () => {
    expect(resolveAutoUpdateMode({}, { CMUX_TEAM_AUTO_UPDATE: "task" }))
      .toEqual({ mode: "task", source: "env" });
  });

  test("env=notify → notify, source=env", () => {
    expect(resolveAutoUpdateMode({}, { CMUX_TEAM_AUTO_UPDATE: "notify" }))
      .toEqual({ mode: "notify", source: "env" });
  });

  test("env=0 → off, source=env（config=true を上書き）", () => {
    expect(resolveAutoUpdateMode({ autoUpdate: true }, { CMUX_TEAM_AUTO_UPDATE: "0" }))
      .toEqual({ mode: "off", source: "env" });
  });

  test("env=false → off, source=env（config=true を上書き）", () => {
    expect(resolveAutoUpdateMode({ autoUpdate: true }, { CMUX_TEAM_AUTO_UPDATE: "false" }))
      .toEqual({ mode: "off", source: "env" });
  });

  test("env=off → off, source=env", () => {
    expect(resolveAutoUpdateMode({ autoUpdate: true }, { CMUX_TEAM_AUTO_UPDATE: "off" }))
      .toEqual({ mode: "off", source: "env" });
  });

  test("env 空文字は未設定扱い → config にフォールバック（後方互換 true→task）", () => {
    expect(resolveAutoUpdateMode({ autoUpdate: true }, { CMUX_TEAM_AUTO_UPDATE: "" }))
      .toEqual({ mode: "task", source: "config" });
  });

  test("env 未設定 + config=true → task, source=config（後方互換）", () => {
    expect(resolveAutoUpdateMode({ autoUpdate: true }, {}))
      .toEqual({ mode: "task", source: "config" });
  });

  test("env 未設定 + config=false → off, source=config（後方互換）", () => {
    expect(resolveAutoUpdateMode({ autoUpdate: false }, {}))
      .toEqual({ mode: "off", source: "config" });
  });

  test("env 未設定 + config=\"notify\" → notify, source=config", () => {
    expect(resolveAutoUpdateMode({ autoUpdate: "notify" }, {}))
      .toEqual({ mode: "notify", source: "config" });
  });

  test("env 未設定 + config 未設定 → off, source=default", () => {
    expect(resolveAutoUpdateMode({}, {}))
      .toEqual({ mode: "off", source: "default" });
  });

  test("不正な env 値は throw", () => {
    expect(() => resolveAutoUpdateMode({}, { CMUX_TEAM_AUTO_UPDATE: "task-now" }))
      .toThrow(/unknown CMUX_TEAM_AUTO_UPDATE/);
  });

  test("不正な config 値は throw（normalizeAutoUpdate 内）", () => {
    expect(() => resolveAutoUpdateMode({ autoUpdate: "task-now" as any }, {}))
      .toThrow(/unknown autoUpdate/);
  });
});

describe("normalizeAutoUpdate (T187)", () => {
  test("true → task", () => {
    expect(normalizeAutoUpdate(true)).toBe("task");
  });

  test("false → off", () => {
    expect(normalizeAutoUpdate(false)).toBe("off");
  });

  test("undefined → off", () => {
    expect(normalizeAutoUpdate(undefined)).toBe("off");
  });

  test("null → off", () => {
    expect(normalizeAutoUpdate(null)).toBe("off");
  });

  test("\"off\" → off", () => {
    expect(normalizeAutoUpdate("off")).toBe("off");
  });

  test("\"notify\" → notify", () => {
    expect(normalizeAutoUpdate("notify")).toBe("notify");
  });

  test("\"task\" → task", () => {
    expect(normalizeAutoUpdate("task")).toBe("task");
  });

  test("大文字小文字混在も許容", () => {
    expect(normalizeAutoUpdate("OFF")).toBe("off");
    expect(normalizeAutoUpdate("Notify")).toBe("notify");
    expect(normalizeAutoUpdate("TASK")).toBe("task");
  });

  test("不正な文字列は throw", () => {
    expect(() => normalizeAutoUpdate("task-now")).toThrow(/unknown autoUpdate/);
    expect(() => normalizeAutoUpdate("yes")).toThrow(/unknown autoUpdate/);
  });

  test("不正な型は throw", () => {
    expect(() => normalizeAutoUpdate(123 as any)).toThrow(/unknown autoUpdate/);
  });
});

describe("waitForAgentRegistered retry ループ (R2)", () => {
  test("最初から登録済みなら即 ok", async () => {
    const teamJsonPath = join(testDir, "team.json");
    await writeFile(teamJsonPath, JSON.stringify(sampleTeamJson));
    const r = await waitForAgentRegistered(teamJsonPath, "surface:100", "surface:382", {
      maxRetries: 3,
      intervalMs: 10,
    });
    expect(r).toEqual({ ok: true });
  });

  test("agent_not_found のときだけリトライし、登録されたら ok", async () => {
    const teamJsonPath = join(testDir, "team.json");
    // 初期は agents なし
    await writeFile(teamJsonPath, JSON.stringify({
      conductors: [{ surface: "surface:100", taskId: "169", agents: [] }],
    }));
    // 50ms 後に agents を追加
    setTimeout(() => {
      writeFile(teamJsonPath, JSON.stringify(sampleTeamJson));
    }, 50);
    const r = await waitForAgentRegistered(teamJsonPath, "surface:100", "surface:382", {
      maxRetries: 10,
      intervalMs: 30,
    });
    expect(r).toEqual({ ok: true });
  });

  test("self_send はリトライせず即 reject", async () => {
    const teamJsonPath = join(testDir, "team.json");
    await writeFile(teamJsonPath, JSON.stringify(sampleTeamJson));
    const start = Date.now();
    const r = await waitForAgentRegistered(teamJsonPath, "surface:100", "surface:100", {
      maxRetries: 5,
      intervalMs: 100,
    });
    const elapsed = Date.now() - start;
    expect(r).toEqual({ ok: false, reason: "self_send" });
    // 100ms 以内に終わる（リトライしていない）
    expect(elapsed).toBeLessThan(100);
  });

  test("not_a_conductor はリトライせず即 reject", async () => {
    const teamJsonPath = join(testDir, "team.json");
    await writeFile(teamJsonPath, JSON.stringify(sampleTeamJson));
    const start = Date.now();
    const r = await waitForAgentRegistered(teamJsonPath, "surface:999", "surface:382", {
      maxRetries: 5,
      intervalMs: 100,
    });
    const elapsed = Date.now() - start;
    expect(r).toEqual({ ok: false, reason: "not_a_conductor" });
    expect(elapsed).toBeLessThan(100);
  });

  test("最終的に agent_not_found が確定する", async () => {
    const teamJsonPath = join(testDir, "team.json");
    await writeFile(teamJsonPath, JSON.stringify(sampleTeamJson));
    const r = await waitForAgentRegistered(teamJsonPath, "surface:100", "surface:999", {
      maxRetries: 3,
      intervalMs: 10,
    });
    expect(r).toEqual({ ok: false, reason: "agent_not_found" });
  });
});

// --- TASK_UPDATED postMessage 統合テスト (T183) ---
//
// update-task / delete-task / close-task / abort-task (no-conductor 早期 return パス) の
// 各コマンドで TUI 即時反映用の TASK_UPDATED が daemon の HTTP API に POST されることを検証する。
// mock HTTP サーバーでメッセージを捕捉し、CLI を subprocess で呼び出して検証する。

import { createServer } from "http";
import type { Server } from "http";

describe("TASK_UPDATED postMessage (T183)", () => {
  let server: Server;
  let receivedMessages: any[];
  let port: number;
  const MAIN_TS = join(import.meta.dir, "main.ts");

  // テスト用の簡易 .team 構造を用意する
  async function setupTeamDir(taskId: string, title: string, status: string): Promise<string> {
    const { mkdir: mk, writeFile: wf } = await import("fs/promises");
    await mk(join(testDir, ".team/tasks", `${taskId}-example`), { recursive: true });
    const taskFile = join(testDir, ".team/tasks", `${taskId}-example`, "task.md");
    await wf(
      taskFile,
      `---\nid: ${taskId}\ntitle: ${title}\n---\n\nbody text\n`,
    );
    const taskState: Record<string, any> = {};
    taskState[taskId] = { status };
    await wf(join(testDir, ".team/task-state.json"), JSON.stringify(taskState, null, 2));
    await wf(join(testDir, ".team/proxy-port"), String(port));
    return taskFile;
  }

  async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return await new Promise((resolve) => {
      const proc = spawn("bun", ["run", MAIN_TS, ...args], {
        cwd: testDir,
        env: { ...process.env, PROJECT_ROOT: testDir },
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d) => { stdout += d.toString(); });
      proc.stderr.on("data", (d) => { stderr += d.toString(); });
      proc.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    });
  }

  beforeEach(async () => {
    receivedMessages = [];
    server = createServer((req, res) => {
      if (req.url === "/api/messages" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => { body += chunk.toString(); });
        req.on("end", () => {
          try {
            receivedMessages.push(JSON.parse(body));
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
          } catch {
            res.writeHead(400);
            res.end();
          }
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, () => resolve()));
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("update-task: --title のみで TASK_UPDATED が送信される（TASK_CREATED は送らない）", async () => {
    await setupTeamDir("500", "orig-title", "draft");
    const r = await runCli(["update-task", "--task-id", "500", "--title", "new-title"]);
    expect(r.code).toBe(0);
    expect(receivedMessages.map((m) => m.type)).toEqual(["TASK_UPDATED"]);
    expect(receivedMessages[0].taskId).toBe("500");
  });

  test("update-task: status=ready では TASK_CREATED のみ（TASK_UPDATED は送らない）", async () => {
    await setupTeamDir("501", "t1", "draft");
    const r = await runCli(["update-task", "--task-id", "501", "--status", "ready"]);
    expect(r.code).toBe(0);
    const types = receivedMessages.map((m) => m.type);
    expect(types).toEqual(["TASK_CREATED"]);
  });

  test("update-task: status=draft への変更で TASK_UPDATED が送信される", async () => {
    await setupTeamDir("502", "t2", "ready");
    const r = await runCli(["update-task", "--task-id", "502", "--status", "draft"]);
    expect(r.code).toBe(0);
    expect(receivedMessages.map((m) => m.type)).toEqual(["TASK_UPDATED"]);
  });

  test("delete-task: TASK_UPDATED が送信される", async () => {
    await setupTeamDir("503", "t3", "draft");
    const r = await runCli(["delete-task", "--task-id", "503"]);
    expect(r.code).toBe(0);
    expect(receivedMessages.map((m) => m.type)).toEqual(["TASK_UPDATED"]);
    expect(receivedMessages[0].taskId).toBe("503");
  });

  test("close-task: conductor 不在時に TASK_UPDATED が送信される", async () => {
    await setupTeamDir("504", "t4", "draft");
    // team.json を置かない（または conductors なし） → conductor 不在パス
    const r = await runCli(["close-task", "--task-id", "504"]);
    expect(r.code).toBe(0);
    expect(receivedMessages.map((m) => m.type)).toEqual(["TASK_UPDATED"]);
  });

  test("abort-task: no-conductor 早期 return パスで TASK_UPDATED が送信される", async () => {
    const taskFile = await setupTeamDir("505", "t5", "assigned");
    // team.json に空の conductors を書いて「見つからない」状態を作る
    const { writeFile: wf } = await import("fs/promises");
    await wf(join(testDir, ".team/team.json"), JSON.stringify({ conductors: [] }));
    const r = await runCli(["abort-task", "--task-id", "505"]);
    expect(r.code).toBe(0);
    expect(receivedMessages.map((m) => m.type)).toEqual(["TASK_UPDATED"]);
    expect(receivedMessages[0].taskFile).toBe(taskFile);
  });

  test("後方互換: proxy が TASK_UPDATED を 400 で返しても CLI は成功する", async () => {
    // server を閉じて新しく 400 だけ返すサーバーに差し替える
    await new Promise<void>((resolve) => server.close(() => resolve()));
    receivedMessages = [];
    server = createServer((req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unknown type" }));
    });
    await new Promise<void>((resolve) => server.listen(port, () => resolve()));

    await setupTeamDir("506", "t6", "draft");
    const r = await runCli(["update-task", "--task-id", "506", "--title", "renamed"]);
    // CLI は成功扱い（postMessage は fetch 失敗/4xx を握りつぶす）
    expect(r.code).toBe(0);
  });
});

// --- T181 §12.1: cmdAwaitAgent race 検証 ---

describe("cmdAwaitAgent — done marker race (T181 §12.1)", () => {
  const MAIN_TS = join(import.meta.dir, "main.ts");
  const AGENT_SURFACE = "surface:900";
  const CONDUCTOR_SURFACE = "surface:100";

  async function setupForAwait(): Promise<{ doneDir: string; doneFile: string }> {
    const { mkdir: mk, writeFile: wf } = await import("fs/promises");
    await mk(join(testDir, ".team/conductors/surface_100/agent-done"), { recursive: true });
    await wf(
      join(testDir, ".team/team.json"),
      JSON.stringify({
        conductors: [{ surface: CONDUCTOR_SURFACE, agents: [{ surface: AGENT_SURFACE }] }],
      }),
    );
    return {
      doneDir: join(testDir, ".team/conductors/surface_100/agent-done"),
      doneFile: join(testDir, ".team/conductors/surface_100/agent-done/surface_900.done"),
    };
  }

  function spawnAwait(timeoutSec = 5): ReturnType<typeof spawn> & {
    done: Promise<{ code: number; stdout: string; stderr: string }>;
  } {
    const proc = spawn("bun", [
      "run", MAIN_TS,
      "await-agent",
      "--surface", AGENT_SURFACE,
      "--timeout", String(timeoutSec),
    ], {
      cwd: testDir,
      env: { ...process.env, PROJECT_ROOT: testDir },
    }) as any;
    let stdout = "";
    let stderr = "";
    proc.stdout!.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.done = new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      proc.on("close", (code: number | null) => resolve({ code: code ?? 0, stdout, stderr }));
    });
    return proc;
  }

  test("watcher 起動より前に done が書かれていても検出される (existsSync フォールバック)", async () => {
    const { doneFile } = await setupForAwait();
    // watcher 起動前に done を置く。タイムスタンプは await-agent 起動予定より少し未来にして
    // 「await-agent.startedAt 直後に書かれた done が watcher 起動前に反映された」状況を再現する。
    // （existsSync フォールバックが fs.watch の race で必要になる実運用ケース）
    const ts = Date.now() + 3_000;
    await writeFile(
      doneFile,
      `status=completed\ntimestamp_ms=${ts}\ntimestamp=${new Date(ts).toISOString()}\n`,
    );
    const proc = spawnAwait(10);
    const r = await proc.done;
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("STATUS=completed");
  }, 15000);

  test("watcher 起動後に done が書かれた場合に検出される (fs.watch イベント)", async () => {
    const { doneFile } = await setupForAwait();
    const proc = spawnAwait(10);
    // watcher 起動 + 初回 existsSync が終わる時間を待ってから書く
    await new Promise((r) => setTimeout(r, 800));
    const ts = Date.now();
    await writeFile(
      doneFile,
      `status=ask\ntimestamp_ms=${ts}\ntimestamp=${new Date(ts).toISOString()}\nquestion=really?\n`,
    );
    const r = await proc.done;
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("STATUS=ask");
    expect(r.stdout).toContain("QUESTION=really?");
  }, 15000);

  test("startedAt より古い timestamp_ms の done は skip され unlink される", async () => {
    const { doneFile } = await setupForAwait();
    // 10 秒以上前の古い done（「前回の残骸」）を仕込む
    const oldTs = Date.now() - 10_000;
    await writeFile(
      doneFile,
      `status=completed\ntimestamp_ms=${oldTs}\ntimestamp=${new Date(oldTs).toISOString()}\n`,
    );
    // short timeout で timeout パスに入ることを確認
    const proc = spawnAwait(2);
    const r = await proc.done;
    expect(r.code).toBe(2);
    expect(r.stdout).toContain("STATUS=timeout");
    // 古い done は削除されている
    const { existsSync: ex } = await import("fs");
    expect(ex(doneFile)).toBe(false);
  }, 15000);
});

// --- T203: buildMessageFromHookInput 単体テスト ---

describe("buildMessageFromHookInput (T203)", () => {
  const opts = {
    surface: "surface:100",
    pid: 12345,
    now: "2026-04-15T10:00:00.000Z",
  };

  test("正常: SESSION_STARTED + source=startup の hook JSON を変換", () => {
    const raw = JSON.stringify({
      session_id: "uuid-1",
      source: "startup",
      hook_event_name: "SessionStart",
      cwd: "/tmp/x",
      transcript_path: "/tmp/y.jsonl",
    });
    const msg = buildMessageFromHookInput("SESSION_STARTED", raw, opts);
    expect(msg).toEqual({
      type: "SESSION_STARTED",
      surface: "surface:100",
      pid: 12345,
      sessionId: "uuid-1",
      source: "startup",
      timestamp: "2026-04-15T10:00:00.000Z",
    });
  });

  test("正常: source=clear も pass される", () => {
    const raw = JSON.stringify({ session_id: "uuid-2", source: "clear" });
    const msg = buildMessageFromHookInput("SESSION_STARTED", raw, opts);
    expect(msg.type).toBe("SESSION_STARTED");
    if (msg.type === "SESSION_STARTED") {
      expect(msg.sessionId).toBe("uuid-2");
      expect(msg.source).toBe("clear");
    }
  });

  test("正常: session_id 無しでも sessionId: undefined で通る（後方互換）", () => {
    const raw = JSON.stringify({ source: "startup" });
    const msg = buildMessageFromHookInput("SESSION_STARTED", raw, opts);
    if (msg.type === "SESSION_STARTED") {
      expect(msg.sessionId).toBeUndefined();
      expect(msg.source).toBe("startup");
    }
  });

  test("m3: 余分なフィールドは無視される", () => {
    const raw = JSON.stringify({
      session_id: "uuid-3",
      source: "resume",
      foo: "bar",
      conductor_id: "C1",  // 余分
      pid: 99999,           // hook 入力側の余分なキー（CLI 引数の pid を優先）
    });
    const msg = buildMessageFromHookInput("SESSION_STARTED", raw, opts);
    if (msg.type === "SESSION_STARTED") {
      expect(msg.sessionId).toBe("uuid-3");
      expect(msg.source).toBe("resume");
      expect(msg.pid).toBe(12345);
      expect(msg.surface).toBe("surface:100");
      expect((msg as any).foo).toBeUndefined();
      expect((msg as any).conductor_id).toBeUndefined();
    }
  });

  test("source は startup/resume/clear/compact 全て pass する", () => {
    for (const s of ["startup", "resume", "clear", "compact"] as const) {
      const raw = JSON.stringify({ session_id: "u", source: s });
      const msg = buildMessageFromHookInput("SESSION_STARTED", raw, opts);
      if (msg.type === "SESSION_STARTED") {
        expect(msg.source).toBe(s);
      }
    }
  });

  test("異常: 無効 JSON で throw", () => {
    expect(() =>
      buildMessageFromHookInput("SESSION_STARTED", "{not json", opts),
    ).toThrow(/invalid hook JSON/);
  });

  test("異常: object でない JSON で throw", () => {
    expect(() =>
      buildMessageFromHookInput("SESSION_STARTED", "42", opts),
    ).toThrow(/must be an object/);
  });

  test("異常: 未対応 type で throw", () => {
    expect(() =>
      buildMessageFromHookInput("SESSION_ENDED", JSON.stringify({}), opts),
    ).toThrow(/unsupported hook message type/);
  });
});

// --- T203: cmdSend --from-stdin discriminator 回帰 (C2) ---
//
// T189 SESSION_STOP forwarder は `cmux-team send --from-stdin`（type 引数なし）で起動する。
// args[1] === "--from-stdin" になる場合に新パスへ誤って入らず、旧 QueueMessageSchema パスで処理される
// ことを CLI subprocess 経由で検証する。

describe("cmdSend --from-stdin discriminator (C2 / T203)", () => {
  let server: Server;
  let receivedMessages: any[];
  let port: number;
  const MAIN_TS = join(import.meta.dir, "main.ts");

  beforeEach(async () => {
    receivedMessages = [];
    server = createServer((req, res) => {
      if (req.url === "/api/messages" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => { body += chunk.toString(); });
        req.on("end", () => {
          try {
            receivedMessages.push(JSON.parse(body));
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
          } catch {
            res.writeHead(400);
            res.end();
          }
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, () => resolve()));
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
    await mkdir(join(testDir, ".team"), { recursive: true });
    await writeFile(join(testDir, ".team/proxy-port"), String(port));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function runSendStdin(
    stdinJson: string,
    cliArgs: string[],
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    return await new Promise((resolve) => {
      const proc = spawn("bun", ["run", MAIN_TS, ...cliArgs], {
        cwd: testDir,
        env: { ...process.env, PROJECT_ROOT: testDir },
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d) => { stdout += d.toString(); });
      proc.stderr.on("data", (d) => { stderr += d.toString(); });
      proc.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
      proc.stdin.write(stdinJson);
      proc.stdin.end();
    });
  }

  test("send --from-stdin（type 引数なし）は旧 QueueMessageSchema パスへ落ちる（T189 forwarder 互換）", async () => {
    const stop = {
      type: "SESSION_STOP",
      surface: "surface:100",
      pid: 1234,
      timestamp: "2026-04-15T10:00:00.000Z",
      payload: { transcript_path: "/tmp/x.jsonl" },
    };
    const r = await runSendStdin(JSON.stringify(stop), ["send", "--from-stdin"]);
    expect(r.code).toBe(0);
    expect(receivedMessages.length).toBe(1);
    expect(receivedMessages[0].type).toBe("SESSION_STOP");
    expect(receivedMessages[0].surface).toBe("surface:100");
    expect(receivedMessages[0].pid).toBe(1234);
  }, 15000);

  test("send SESSION_STARTED --from-stdin --surface ... は新 hook 解釈パスへ入る", async () => {
    const hookJson = {
      session_id: "uuid-real",
      source: "clear",
      hook_event_name: "SessionStart",
    };
    const r = await runSendStdin(JSON.stringify(hookJson), [
      "send",
      "SESSION_STARTED",
      "--from-stdin",
      "--surface",
      "surface:300",
      "--pid",
      "9999",
    ]);
    expect(r.code).toBe(0);
    expect(receivedMessages.length).toBe(1);
    expect(receivedMessages[0].type).toBe("SESSION_STARTED");
    expect(receivedMessages[0].surface).toBe("surface:300");
    expect(receivedMessages[0].pid).toBe(9999);
    expect(receivedMessages[0].sessionId).toBe("uuid-real");
    expect(receivedMessages[0].source).toBe("clear");
  }, 15000);
});

// --- T203: SessionStart hook の matcher / command 回帰 ---

describe("SessionStart hook generation (T203)", () => {
  test("Agent: matcher === '' で stdin pipe 方式の command を生成", async () => {
    await mkdir(join(testDir, ".team/prompts"), { recursive: true });
    const settingsPath = generateAgentSettings(testDir, "surface:100");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    expect(settings.hooks.SessionStart.length).toBe(1);
    const entry = settings.hooks.SessionStart[0];
    expect(entry.matcher).toBe("");
    const cmd: string = entry.hooks[0].command;
    expect(cmd).toContain("--from-stdin");
    expect(cmd).toContain("--surface");
    expect(cmd).toContain("SESSION_STARTED");
  });

  test("Conductor: matcher === '' で stdin pipe 方式の command を生成、--conductor-id を含まない (m2)", async () => {
    await mkdir(join(testDir, ".team/prompts"), { recursive: true });
    const settingsPath = generateConductorSettings(testDir);
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    expect(settings.hooks.SessionStart.length).toBe(1);
    const entry = settings.hooks.SessionStart[0];
    expect(entry.matcher).toBe("");
    const cmd: string = entry.hooks[0].command;
    expect(cmd).toContain("--from-stdin");
    expect(cmd).toContain("--surface");
    expect(cmd).toContain("SESSION_STARTED");
    expect(cmd).not.toContain("--conductor-id");
  });

  test("T210: Conductor SessionEnd(clear) hook は --conductor-id を含まない", async () => {
    await mkdir(join(testDir, ".team/prompts"), { recursive: true });
    const settingsPath = generateConductorSettings(testDir);
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    const clearHook = settings.hooks.SessionEnd.find(
      (h: any) => h.matcher === "clear",
    );
    expect(clearHook).toBeDefined();
    const cmd: string = clearHook.hooks[0].command;
    expect(cmd).not.toContain("--conductor-id");
    expect(cmd).not.toContain("$CONDUCTOR_ID");
  });

  test("T210: Conductor SessionEnd(logout|prompt_input_exit) hook は --conductor-id を含まない", async () => {
    await mkdir(join(testDir, ".team/prompts"), { recursive: true });
    const settingsPath = generateConductorSettings(testDir);
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    const logoutHook = settings.hooks.SessionEnd.find(
      (h: any) => h.matcher === "logout|prompt_input_exit",
    );
    expect(logoutHook).toBeDefined();
    const cmd: string = logoutHook.hooks[0].command;
    expect(cmd).not.toContain("--conductor-id");
    expect(cmd).not.toContain("$CONDUCTOR_ID");
  });

  test("T210: detect-ask.sh（DETECT_ASK_SCRIPT）は CONDUCTOR_ID を参照しない", async () => {
    await mkdir(join(testDir, ".team/prompts"), { recursive: true });
    const scriptPath = ensureAskDetectorScript(testDir);
    const content = await readFile(scriptPath, "utf-8");
    expect(content).not.toContain("CONDUCTOR_ID");
    expect(content).not.toContain("conductorId");
  });
});

// --- T211: generateMasterSettings ---

describe("generateMasterSettings (T211)", () => {
  test("settings.json に UserPromptSubmit / Stop hook が含まれる", async () => {
    const settingsPath = generateMasterSettings(testDir);
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));

    expect(Array.isArray(settings.hooks.UserPromptSubmit)).toBe(true);
    expect(settings.hooks.UserPromptSubmit.length).toBe(1);
    expect(settings.hooks.UserPromptSubmit[0].matcher).toBe("");
    const busyCmd: string = settings.hooks.UserPromptSubmit[0].hooks[0].command;
    expect(busyCmd).toContain("python3");
    expect(busyCmd).toContain("master-hook-busy.py");
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].timeout).toBe(5000);

    expect(Array.isArray(settings.hooks.Stop)).toBe(true);
    expect(settings.hooks.Stop.length).toBe(1);
    expect(settings.hooks.Stop[0].matcher).toBe("");
    const stopCmd: string = settings.hooks.Stop[0].hooks[0].command;
    expect(stopCmd).toContain("python3");
    expect(stopCmd).toContain("master-hook-stop.py");
    expect(settings.hooks.Stop[0].hooks[0].timeout).toBe(5000);
  });

  test("Python hook スクリプトが生成され、実行可能な形式である", async () => {
    const { busy, stop } = ensureMasterHookScripts(testDir);
    expect(busy).toContain(".team/prompts/master-hook-busy.py");
    expect(stop).toContain(".team/prompts/master-hook-stop.py");

    const busyContent = await readFile(busy, "utf-8");
    expect(busyContent.startsWith("#!/usr/bin/env python3")).toBe(true);
    expect(busyContent).toContain('"status": "busy"');
    expect(busyContent).toContain("/master-state");
    // T211: Master 専用 settings に移設したため CONDUCTOR_ID guard は不要
    expect(busyContent).not.toContain("CONDUCTOR_ID");

    const stopContent = await readFile(stop, "utf-8");
    expect(stopContent.startsWith("#!/usr/bin/env python3")).toBe(true);
    expect(stopContent).toContain('"status": "idle"');
    expect(stopContent).toContain("/master-state");
    expect(stopContent).not.toContain("CONDUCTOR_ID");
  });

  test("冪等: 複数回呼び出しても settings が上書きされるだけ", async () => {
    const path1 = generateMasterSettings(testDir);
    const path2 = generateMasterSettings(testDir);
    expect(path1).toBe(path2);
    const content = await readFile(path2, "utf-8");
    JSON.parse(content); // parse error にならなければ OK
  });
});

// --- T211 Phase 4: CMUX_ROLE 削除 regression ---

describe("T211 Phase 4: CMUX_ROLE 完全削除 regression", () => {
  test("main.ts 内に `CMUX_ROLE` 参照が残っていない", async () => {
    const mainPath = join(import.meta.dir, "main.ts");
    const src = await readFile(mainPath, "utf-8");
    expect(src).not.toContain("CMUX_ROLE");
  });
});

// --- T206 normalizeSurfaceArg ---

describe("normalizeSurfaceArg (T206)", () => {
  // tree mock 用に毎回 spy を貼り、後始末する
  let lastArgs: { workspace?: string; opts?: any } | undefined;

  afterEach(() => {
    cmux.__setTreeImpl(null);
    lastArgs = undefined;
  });

  test("ref 形式はそのまま返す（cmux.tree を呼ばない）", async () => {
    let calls = 0;
    cmux.__setTreeImpl(async () => {
      calls++;
      return "{}";
    });
    expect(await normalizeSurfaceArg("surface:42")).toBe("surface:42");
    expect(await normalizeSurfaceArg("surface:9999")).toBe("surface:9999");
    expect(calls).toBe(0);
  });

  test("UUID 形式 → tree から逆引きして ref を返す（大文字小文字無視）", async () => {
    cmux.__setTreeImpl(async (workspace?: string, opts?: any) => {
      lastArgs = { workspace, opts };
      return JSON.stringify({
        windows: [{
          workspaces: [{
            panes: [{
              surfaces: [
                { id: "A5AC4F23-70D9-4B81-8958-168CD68CF8DF", ref: "surface:44" },
                { id: "11111111-2222-3333-4444-555555555555", ref: "surface:99" },
              ],
            }],
          }],
        }],
      });
    });
    // lowercase 入力でも一致する
    expect(await normalizeSurfaceArg("a5ac4f23-70d9-4b81-8958-168cd68cf8df"))
      .toBe("surface:44");
    // uppercase 入力でも一致する
    expect(await normalizeSurfaceArg("11111111-2222-3333-4444-555555555555"))
      .toBe("surface:99");
    // C1: tree 呼び出しは json + idFormat="both" で実施される
    expect(lastArgs?.opts).toEqual({ json: true, idFormat: "both" });
  });

  test("UUID が tree に存在しない場合は throw", async () => {
    cmux.__setTreeImpl(async () => JSON.stringify({
      windows: [{
        workspaces: [{
          panes: [{
            surfaces: [
              { id: "A5AC4F23-70D9-4B81-8958-168CD68CF8DF", ref: "surface:44" },
            ],
          }],
        }],
      }],
    }));
    await expect(
      normalizeSurfaceArg("ffffffff-ffff-ffff-ffff-ffffffffffff")
    ).rejects.toThrow(/not found in cmux tree/);
  });

  test("不正形式は throw（cmux.tree を呼ばない）", async () => {
    let called = false;
    cmux.__setTreeImpl(async () => {
      called = true;
      return "{}";
    });
    await expect(normalizeSurfaceArg("")).rejects.toThrow(/Invalid --surface/);
    await expect(normalizeSurfaceArg("surface:abc")).rejects.toThrow(/Invalid --surface/);
    await expect(normalizeSurfaceArg("foo")).rejects.toThrow(/Invalid --surface/);
    await expect(normalizeSurfaceArg(" surface:42")).rejects.toThrow(/Invalid --surface/);
    expect(called).toBe(false);
  });

  test("tree が JSON parse 不能な文字列を返した場合は throw", async () => {
    cmux.__setTreeImpl(async () => "not json");
    await expect(
      normalizeSurfaceArg("a5ac4f23-70d9-4b81-8958-168cd68cf8df")
    ).rejects.toThrow(/Failed to parse cmux tree JSON/);
  });

  test("空の windows でも throw（surface 未存在として扱う）", async () => {
    cmux.__setTreeImpl(async () => JSON.stringify({ windows: [] }));
    await expect(
      normalizeSurfaceArg("a5ac4f23-70d9-4b81-8958-168cd68cf8df")
    ).rejects.toThrow(/not found in cmux tree/);
  });
});
