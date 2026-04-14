import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "child_process";
import {
  generateConductorSettings,
  validateSendAgentTarget,
  waitForAgentRegistered,
  resolveLayout,
  resolveAutoUpdateMode,
} from "./main";
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
    const settingsPath = generateConductorSettings(testDir, "surface:100");
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
    const settingsPath = generateConductorSettings(testDir, "surface:100");
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
    const settingsPath = generateConductorSettings(testDir, "surface:100");
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
  return m[1];
}

describe("PreToolUse hook 挙動 (§4.2)", () => {
  let script: string;

  beforeEach(async () => {
    const settingsPath = generateConductorSettings(testDir, "surface:100");
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
