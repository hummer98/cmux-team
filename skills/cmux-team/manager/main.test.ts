import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFile, writeFile, mkdir } from "fs/promises";
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
  ensureAskDetectorScript,
  applyResumeTransitions,
  resolveCanonicalTaskId,
} from "./main";
import type { TaskMeta, TaskState } from "./task";
import { resolveLayout, resolveAutoUpdateMode } from "./config";
import * as cmux from "./cmux";
import { normalizeAutoUpdate } from "./schema";
import { createDummyProject, type DummyProject } from "./test-project";

let project: DummyProject;
let testDir: string;

beforeEach(async () => {
  project = await createDummyProject({
    prefix: "cmux-main-test-",
    subdirs: [],
  });
  testDir = project.root;
});

afterEach(async () => {
  await project.dispose();
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

describe("resolveAutoUpdateMode (T187/T294)", () => {
  // T294: v4.5.0 で autoUpdate の `task` モードと boolean 後方互換を削除した。
  // 以下 3 ケースは reject される（破壊的変更）。

  test("env=1 → throw（T294 で削除）", () => {
    expect(() => resolveAutoUpdateMode({}, { CMUX_TEAM_AUTO_UPDATE: "1" }))
      .toThrow(/unknown CMUX_TEAM_AUTO_UPDATE/);
  });

  test("env=true → throw（T294 で削除）", () => {
    expect(() => resolveAutoUpdateMode({}, { CMUX_TEAM_AUTO_UPDATE: "true" }))
      .toThrow(/unknown CMUX_TEAM_AUTO_UPDATE/);
  });

  test("env=task → throw（T294 で削除）", () => {
    expect(() => resolveAutoUpdateMode({}, { CMUX_TEAM_AUTO_UPDATE: "task" }))
      .toThrow(/unknown CMUX_TEAM_AUTO_UPDATE/);
  });

  test("env=notify → notify, source=env", () => {
    expect(resolveAutoUpdateMode({}, { CMUX_TEAM_AUTO_UPDATE: "notify" }))
      .toEqual({ mode: "notify", source: "env" });
  });

  test("env=0 → off, source=env（config=\"notify\" を上書き）", () => {
    expect(resolveAutoUpdateMode({ autoUpdate: "notify" }, { CMUX_TEAM_AUTO_UPDATE: "0" }))
      .toEqual({ mode: "off", source: "env" });
  });

  test("env=false → off, source=env（config=\"notify\" を上書き）", () => {
    expect(resolveAutoUpdateMode({ autoUpdate: "notify" }, { CMUX_TEAM_AUTO_UPDATE: "false" }))
      .toEqual({ mode: "off", source: "env" });
  });

  test("env=off → off, source=env", () => {
    expect(resolveAutoUpdateMode({ autoUpdate: "notify" }, { CMUX_TEAM_AUTO_UPDATE: "off" }))
      .toEqual({ mode: "off", source: "env" });
  });

  test("env 空文字は未設定扱い → config にフォールバック", () => {
    expect(resolveAutoUpdateMode({ autoUpdate: "notify" }, { CMUX_TEAM_AUTO_UPDATE: "" }))
      .toEqual({ mode: "notify", source: "config" });
  });

  test("env 未設定 + config=true → throw（T294 で boolean を削除）", () => {
    expect(() => resolveAutoUpdateMode({ autoUpdate: true as any }, {}))
      .toThrow(/unknown autoUpdate/);
  });

  test("env 未設定 + config=false → throw（T294 で boolean を削除）", () => {
    expect(() => resolveAutoUpdateMode({ autoUpdate: false as any }, {}))
      .toThrow(/unknown autoUpdate/);
  });

  test("env 未設定 + config=\"task\" → throw（T294 で task モードを削除）", () => {
    expect(() => resolveAutoUpdateMode({ autoUpdate: "task" as any }, {}))
      .toThrow(/unknown autoUpdate/);
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

describe("normalizeAutoUpdate (T187/T294)", () => {
  // T294: v4.5.0 で boolean 後方互換および `"task"` 受理を削除

  test("true → throw（T294 で削除）", () => {
    expect(() => normalizeAutoUpdate(true)).toThrow(/unknown autoUpdate/);
  });

  test("false → throw（T294 で削除）", () => {
    expect(() => normalizeAutoUpdate(false)).toThrow(/unknown autoUpdate/);
  });

  test("\"task\" → throw（T294 で削除）", () => {
    expect(() => normalizeAutoUpdate("task")).toThrow(/unknown autoUpdate/);
  });

  test("\"TASK\" → throw（大文字でも throw）", () => {
    expect(() => normalizeAutoUpdate("TASK")).toThrow(/unknown autoUpdate/);
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

  test("大文字小文字混在も許容（off/notify のみ）", () => {
    expect(normalizeAutoUpdate("OFF")).toBe("off");
    expect(normalizeAutoUpdate("Notify")).toBe("notify");
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

  // --- T291: slug 渡し canonical 化テスト ---
  //
  // update-task / close-task / delete-task / abort-task / restart-task が --task-id に
  // slug やディレクトリ名全体を渡されたときも frontmatter `id:` を canonical key として
  // taskState を更新し、孤児 entry を作らないことを検証する。

  test("update-task (T291): slug 渡しで canonical key の taskState が更新される", async () => {
    // setupTeamDir は .team/tasks/550-example/task.md を frontmatter id:550 で作る
    await setupTeamDir("550", "orig", "draft");
    const r = await runCli(["update-task", "--task-id", "550-example", "--title", "renamed"]);
    expect(r.code).toBe(0);
    // 孤児エントリが作られないこと（"550-example" キーは存在しない）
    const state = JSON.parse(
      await readFile(join(testDir, ".team/task-state.json"), "utf-8"),
    );
    expect(state["550"]).toBeDefined();
    expect(state["550-example"]).toBeUndefined();
    // TASK_UPDATED が送られ taskId は canonical id
    expect(receivedMessages.map((m) => m.type)).toEqual(["TASK_UPDATED"]);
    expect(receivedMessages[0].taskId).toBe("550");
  });

  test("close-task (T291): slug 渡しで canonical key の taskState が closed に遷移", async () => {
    await setupTeamDir("551", "t", "draft");
    const r = await runCli(["close-task", "--task-id", "551-example"]);
    expect(r.code).toBe(0);
    const state = JSON.parse(
      await readFile(join(testDir, ".team/task-state.json"), "utf-8"),
    );
    expect(state["551"].status).toBe("closed");
    expect(state["551-example"]).toBeUndefined();
  });

  test("close-task (T291): slug 渡しで team.json.conductors[].taskId マッチが成功し CONDUCTOR_DONE が送られる", async () => {
    await setupTeamDir("552", "t", "assigned");
    const { writeFile: wf } = await import("fs/promises");
    // team.json の conductor は canonical taskId "552" で登録されている前提
    await wf(
      join(testDir, ".team/team.json"),
      JSON.stringify({
        conductors: [
          { surface: "surface:100", taskId: "552", taskRunId: "task-552-1111" },
        ],
      }),
    );
    // CLI 側は slug 渡し
    const r = await runCli(["close-task", "--task-id", "552-example", "--force"]);
    expect(r.code).toBe(0);
    // CONDUCTOR_DONE が送られていること
    const types = receivedMessages.map((m) => m.type);
    expect(types).toContain("CONDUCTOR_DONE");
    const done = receivedMessages.find((m) => m.type === "CONDUCTOR_DONE");
    expect(done.surface).toBe("surface:100");
    expect(done.taskRunId).toBe("task-552-1111");
    expect(done.success).toBe(true);
  });

  test("delete-task (T291): slug 渡しで canonical key が deleted に遷移", async () => {
    await setupTeamDir("553", "t", "draft");
    const r = await runCli(["delete-task", "--task-id", "553-example"]);
    expect(r.code).toBe(0);
    const state = JSON.parse(
      await readFile(join(testDir, ".team/task-state.json"), "utf-8"),
    );
    expect(state["553"].status).toBe("deleted");
    expect(state["553-example"]).toBeUndefined();
  });

  test("abort-task (T291): slug 渡しで no-conductor 早期 return 経路でも canonical key が aborted に遷移", async () => {
    await setupTeamDir("554", "t", "assigned");
    const { writeFile: wf } = await import("fs/promises");
    await wf(join(testDir, ".team/team.json"), JSON.stringify({ conductors: [] }));
    const r = await runCli(["abort-task", "--task-id", "554-example"]);
    expect(r.code).toBe(0);
    const state = JSON.parse(
      await readFile(join(testDir, ".team/task-state.json"), "utf-8"),
    );
    expect(state["554"].status).toBe("aborted");
    expect(state["554-example"]).toBeUndefined();
  });

  test("close-task (T291): 存在しない task-id で元の入力値がエラーメッセージに表示される", async () => {
    // .team/tasks は空にしておく（存在しないケースの再現）
    const { mkdir: mk, writeFile: wf } = await import("fs/promises");
    await mk(join(testDir, ".team/tasks"), { recursive: true });
    await wf(join(testDir, ".team/task-state.json"), "{}");
    await wf(join(testDir, ".team/proxy-port"), String(port));

    const r = await runCli(["close-task", "--task-id", "999-bogus"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("task 999-bogus not found");
  });

  test("update-task (T291): 存在しない task-id で元の入力値がエラーメッセージに表示される", async () => {
    const { mkdir: mk, writeFile: wf } = await import("fs/promises");
    await mk(join(testDir, ".team/tasks"), { recursive: true });
    await wf(join(testDir, ".team/task-state.json"), "{}");
    await wf(join(testDir, ".team/proxy-port"), String(port));

    const r = await runCli(["update-task", "--task-id", "999-bogus", "--title", "x"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("task 999-bogus not found");
  });
});

// --- T291: resolveCanonicalTaskId ユニットテスト ---
//
// PROJECT_ROOT は main.ts モジュール読み込み時に固定されるため、
// bun subprocess でテスト毎に env PROJECT_ROOT=testDir を差し替えて呼び出す。

describe("resolveCanonicalTaskId (T291)", () => {
  const MAIN_TS = join(import.meta.dir, "main.ts");

  // import 経路の compile-time 型検査のため参照（ランタイムでは subprocess 経由で呼ぶ）
  expect(typeof resolveCanonicalTaskId).toBe("function");

  async function writeTask(dirName: string, frontmatter: string): Promise<void> {
    const { mkdir: mk, writeFile: wf } = await import("fs/promises");
    await mk(join(testDir, ".team/tasks", dirName), { recursive: true });
    await wf(
      join(testDir, ".team/tasks", dirName, "task.md"),
      `---\n${frontmatter}\n---\n\nbody\n`,
    );
  }

  async function callResolve(inputId: string): Promise<string | null> {
    const script =
      `import(${JSON.stringify(MAIN_TS)}).then(async (m) => {` +
      `  const r = await m.resolveCanonicalTaskId(${JSON.stringify(inputId)});` +
      `  process.stdout.write(JSON.stringify({ result: r === undefined ? null : r }));` +
      `}).catch((e) => { process.stderr.write(String(e && e.stack || e)); process.exit(1); });`;
    return await new Promise((resolve) => {
      const proc = spawn("bun", ["-e", script], {
        cwd: testDir,
        env: { ...process.env, PROJECT_ROOT: testDir },
      });
      let stdout = "";
      let stderr = "";
      proc.stdout?.on("data", (d) => { stdout += d.toString(); });
      proc.stderr?.on("data", (d) => { stderr += d.toString(); });
      proc.on("close", (code) => {
        if (code !== 0) {
          resolve(null);
          return;
        }
        try {
          const { result } = JSON.parse(stdout);
          resolve(result);
        } catch {
          resolve(null);
        }
      });
    });
  }

  test("数値 id 完全一致（frontmatter id と一致）→ canonical id を返す", async () => {
    await writeTask("291-close-task-foo", "id: 291\ntitle: t");
    expect(await callResolve("291")).toBe("291");
  });

  test("slug 先頭マッチ（dir 名の途中まで）→ canonical id を返す", async () => {
    await writeTask("291-close-task-foo", "id: 291\ntitle: t");
    expect(await callResolve("291-close-task")).toBe("291");
  });

  test("ディレクトリ名全体渡し → canonical id を返す", async () => {
    await writeTask("291-close-task-foo", "id: 291\ntitle: t");
    expect(await callResolve("291-close-task-foo")).toBe("291");
  });

  test("該当タスク不在 → undefined", async () => {
    const { mkdir: mk } = await import("fs/promises");
    await mk(join(testDir, ".team/tasks"), { recursive: true });
    expect(await callResolve("999")).toBeNull();
  });

  test("frontmatter に id 行なし → undefined", async () => {
    await writeTask("400-no-id", "title: no-id-task");
    expect(await callResolve("400")).toBeNull();
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
      buildMessageFromHookInput("TASK_CREATED", JSON.stringify({}), opts),
    ).toThrow(/unsupported hook message type/);
  });

  // T216: SESSION_ENDED hook branch — reason を stdin JSON から抽出する
  test("T216: SESSION_ENDED — reason=logout を stdin から抽出", () => {
    const raw = JSON.stringify({ reason: "logout" });
    const msg = buildMessageFromHookInput("SESSION_ENDED", raw, opts);
    expect(msg.type).toBe("SESSION_ENDED");
    if (msg.type === "SESSION_ENDED") {
      expect(msg.reason).toBe("logout");
      expect(msg.surface).toBe("surface:100");
      expect(msg.pid).toBe(12345);
      expect(msg.timestamp).toBe(opts.now);
    }
  });

  test("T216: SESSION_ENDED — reason=other を stdin から抽出", () => {
    const raw = JSON.stringify({ reason: "other" });
    const msg = buildMessageFromHookInput("SESSION_ENDED", raw, opts);
    if (msg.type === "SESSION_ENDED") {
      expect(msg.reason).toBe("other");
    }
  });

  test("T216: SESSION_ENDED — reason 無し JSON は undefined のまま通す", () => {
    const raw = JSON.stringify({});
    const msg = buildMessageFromHookInput("SESSION_ENDED", raw, opts);
    if (msg.type === "SESSION_ENDED") {
      expect(msg.reason).toBeUndefined();
    }
  });

  // T266: NOTIFICATION branch
  test("T266: NOTIFICATION — payload 全体を畳み込み、surfaceUuid/workspaceUuid/role を opts から取り込む", () => {
    const raw = JSON.stringify({
      message: "hello",
      notification_type: "idle_prompt",
      hook_event_name: "Notification",
      transcript_path: "/tmp/foo.jsonl",
    });
    const msg = buildMessageFromHookInput("NOTIFICATION", raw, {
      ...opts,
      surfaceUuid: "abcdef12-3456-7890-abcd-ef0122d8f9",
      workspaceUuid: "11111111-2222-3333-4444-555555555555",
      role: "conductor",
    });
    expect(msg.type).toBe("NOTIFICATION");
    if (msg.type === "NOTIFICATION") {
      expect(msg.surface).toBe("surface:100");
      expect(msg.pid).toBe(12345);
      expect(msg.surfaceUuid).toBe("abcdef12-3456-7890-abcd-ef0122d8f9");
      expect(msg.workspaceUuid).toBe("11111111-2222-3333-4444-555555555555");
      expect(msg.role).toBe("conductor");
      expect(msg.payload).toEqual({
        message: "hello",
        notification_type: "idle_prompt",
        hook_event_name: "Notification",
        transcript_path: "/tmp/foo.jsonl",
      });
    }
  });

  test("T266: NOTIFICATION — 空文字 surfaceUuid/workspaceUuid/role は undefined に正規化される (D9 Case B)", () => {
    const raw = JSON.stringify({ message: "x" });
    const msg = buildMessageFromHookInput("NOTIFICATION", raw, {
      ...opts,
      surfaceUuid: "",
      workspaceUuid: "",
      role: "",
    });
    if (msg.type === "NOTIFICATION") {
      expect(msg.surfaceUuid).toBeUndefined();
      expect(msg.workspaceUuid).toBeUndefined();
      expect(msg.role).toBeUndefined();
    }
  });

  test("T266: NOTIFICATION — opts に surfaceUuid/workspaceUuid/role なしでも OK", () => {
    const raw = JSON.stringify({ message: "x" });
    const msg = buildMessageFromHookInput("NOTIFICATION", raw, opts);
    if (msg.type === "NOTIFICATION") {
      expect(msg.surfaceUuid).toBeUndefined();
      expect(msg.workspaceUuid).toBeUndefined();
      expect(msg.role).toBeUndefined();
      expect(msg.payload?.message).toBe("x");
    }
  });

  test("T266: NOTIFICATION — role 不正値は schema の enum で throw", () => {
    const raw = JSON.stringify({ message: "x" });
    expect(() =>
      buildMessageFromHookInput("NOTIFICATION", raw, { ...opts, role: "hacker" }),
    ).toThrow();
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

  test("T210: Conductor SessionEnd(logout|prompt_input_exit|other) hook は --conductor-id を含まない", async () => {
    await mkdir(join(testDir, ".team/prompts"), { recursive: true });
    const settingsPath = generateConductorSettings(testDir);
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    const logoutHook = settings.hooks.SessionEnd.find(
      (h: any) => h.matcher === "logout|prompt_input_exit|other",
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

  test("T216: Conductor SessionEnd(logout|prompt_input_exit|other) hook は --from-stdin 方式で reason ハードコードを含まない", async () => {
    await mkdir(join(testDir, ".team/prompts"), { recursive: true });
    const settingsPath = generateConductorSettings(testDir);
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));

    const otherHook = settings.hooks.SessionEnd.find(
      (h: any) => h.matcher === "logout|prompt_input_exit|other",
    );
    expect(otherHook).toBeDefined();
    const cmd: string = otherHook.hooks[0].command;
    expect(cmd).toContain("--from-stdin");
    expect(cmd).toContain("cmux-team send SESSION_ENDED");
    expect(cmd).not.toContain("--reason");
    expect(cmd).not.toContain('"session_end"');

    // regression: "clear" matcher は残っていること
    const clearHook = settings.hooks.SessionEnd.find(
      (h: any) => h.matcher === "clear",
    );
    expect(clearHook).toBeDefined();
  });

  test("T216: Agent SessionEnd(logout|prompt_input_exit|other) hook は --from-stdin 方式で reason ハードコードを含まない", async () => {
    await mkdir(join(testDir, ".team/prompts"), { recursive: true });
    const settingsPath = generateAgentSettings(testDir, "surface:100");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    const hook = settings.hooks.SessionEnd.find(
      (h: any) => h.matcher === "logout|prompt_input_exit|other",
    );
    expect(hook).toBeDefined();
    const cmd: string = hook.hooks[0].command;
    expect(cmd).toContain("--from-stdin");
    expect(cmd).toContain("cmux-team send SESSION_ENDED");
    expect(cmd).not.toContain("--reason");
    expect(cmd).not.toContain('"session_end"');
  });

  // T266: Notification hook の generator テスト
  test("T266: Conductor settings に Notification hook があり role=conductor で送信する", async () => {
    await mkdir(join(testDir, ".team/prompts"), { recursive: true });
    const settingsPath = generateConductorSettings(testDir);
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));

    expect(Array.isArray(settings.hooks.Notification)).toBe(true);
    expect(settings.hooks.Notification.length).toBe(1);
    expect(settings.hooks.Notification[0].matcher).toBe("");
    const cmd: string = settings.hooks.Notification[0].hooks[0].command;
    expect(cmd).toContain("cmux-team send NOTIFICATION");
    expect(cmd).toContain("--from-stdin");
    expect(cmd).toContain("${CMUX_SURFACE}");
    expect(cmd).toContain("$PPID");
    expect(cmd).toContain("--surface-uuid");
    expect(cmd).toContain("${CMUX_SURFACE_UUID:-}");
    expect(cmd).toContain("--workspace-uuid");
    expect(cmd).toContain("${CMUX_WORKSPACE_UUID:-}");
    expect(cmd).toContain("--role conductor");
    expect(settings.hooks.Notification[0].hooks[0].timeout).toBe(5000);
  });

  test("T266: Agent settings に Notification hook があり role=agent で送信する", async () => {
    await mkdir(join(testDir, ".team/prompts"), { recursive: true });
    const settingsPath = generateAgentSettings(testDir, "surface:100");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));

    expect(Array.isArray(settings.hooks.Notification)).toBe(true);
    expect(settings.hooks.Notification.length).toBe(1);
    expect(settings.hooks.Notification[0].matcher).toBe("");
    const cmd: string = settings.hooks.Notification[0].hooks[0].command;
    expect(cmd).toContain("cmux-team send NOTIFICATION");
    expect(cmd).toContain("--from-stdin");
    // Agent は ${surface} リテラル置換のため展開後の値を確認
    expect(cmd).toContain('--surface "surface:100"');
    expect(cmd).toContain("$PPID");
    expect(cmd).toContain("--surface-uuid");
    expect(cmd).toContain("${CMUX_SURFACE_UUID:-}");
    expect(cmd).toContain("--workspace-uuid");
    expect(cmd).toContain("${CMUX_WORKSPACE_UUID:-}");
    expect(cmd).toContain("--role agent");
    expect(settings.hooks.Notification[0].hooks[0].timeout).toBe(5000);
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

  // T175: Master の稼働中ステータスを TUI に反映するため、
  // Conductor と同じ SessionStart / SessionEnd hook を Master にも適用する。
  // これにより daemon は SESSION_STARTED で masterPid を確立し、
  // spawnMasterPidWatcher を起動できるようになる。
  test("T175: settings.hooks.SessionStart が cmux-team send SESSION_STARTED --from-stdin を呼ぶ", async () => {
    const settingsPath = generateMasterSettings(testDir);
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));

    expect(Array.isArray(settings.hooks.SessionStart)).toBe(true);
    expect(settings.hooks.SessionStart.length).toBe(1);
    expect(settings.hooks.SessionStart[0].matcher).toBe("");
    const cmd: string = settings.hooks.SessionStart[0].hooks[0].command;
    expect(cmd).toContain("cmux-team send SESSION_STARTED");
    expect(cmd).toContain("--from-stdin");
    expect(cmd).toContain("${CMUX_SURFACE}");
    expect(cmd).toContain("$PPID");
    expect(settings.hooks.SessionStart[0].hooks[0].timeout).toBe(5000);
  });

  test("T175: settings.hooks.SessionEnd が logout|prompt_input_exit|other matcher で SESSION_ENDED を送る", async () => {
    const settingsPath = generateMasterSettings(testDir);
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));

    expect(Array.isArray(settings.hooks.SessionEnd)).toBe(true);
    expect(settings.hooks.SessionEnd.length).toBe(1);
    expect(settings.hooks.SessionEnd[0].matcher).toBe("logout|prompt_input_exit|other");
    const cmd: string = settings.hooks.SessionEnd[0].hooks[0].command;
    expect(cmd).toContain("cmux-team send SESSION_ENDED");
    expect(cmd).toContain("--from-stdin");
    expect(cmd).toContain("${CMUX_SURFACE}");
    expect(cmd).toContain("$PPID");
    expect(cmd).not.toContain("--reason");
    expect(settings.hooks.SessionEnd[0].hooks[0].timeout).toBe(5000);
  });

  test("T175: Master は /clear でセッション継続するため SessionEnd matcher に clear を含めない", async () => {
    // Conductor は clear matcher を持つが Master は持たない (D2)
    const settingsPath = generateMasterSettings(testDir);
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    const matchers: string[] = (settings.hooks.SessionEnd ?? []).map(
      (h: any) => h.matcher,
    );
    expect(matchers.some((m) => m === "clear")).toBe(false);
    expect(matchers.some((m) => m.includes("clear"))).toBe(false);
  });

  test("T175: UserPromptSubmit / Stop hook は既存のまま残る（regression guard）", async () => {
    const settingsPath = generateMasterSettings(testDir);
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));

    expect(Array.isArray(settings.hooks.UserPromptSubmit)).toBe(true);
    expect(settings.hooks.UserPromptSubmit.length).toBe(1);
    const busyCmd: string = settings.hooks.UserPromptSubmit[0].hooks[0].command;
    expect(busyCmd).toContain("master-hook-busy.py");

    expect(Array.isArray(settings.hooks.Stop)).toBe(true);
    expect(settings.hooks.Stop.length).toBe(1);
    const stopCmd: string = settings.hooks.Stop[0].hooks[0].command;
    expect(stopCmd).toContain("master-hook-stop.py");
  });

  // T266: Notification hook を daemon に集約・DB 記録する
  test("T266: settings.hooks.Notification が cmux-team send NOTIFICATION --from-stdin を呼ぶ (role=master)", async () => {
    const settingsPath = generateMasterSettings(testDir);
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));

    expect(Array.isArray(settings.hooks.Notification)).toBe(true);
    expect(settings.hooks.Notification.length).toBe(1);
    expect(settings.hooks.Notification[0].matcher).toBe("");
    const cmd: string = settings.hooks.Notification[0].hooks[0].command;
    expect(cmd).toContain("cmux-team send NOTIFICATION");
    expect(cmd).toContain("--from-stdin");
    expect(cmd).toContain("${CMUX_SURFACE}");
    expect(cmd).toContain("$PPID");
    expect(cmd).toContain("--surface-uuid");
    expect(cmd).toContain("${CMUX_SURFACE_UUID:-}");
    expect(cmd).toContain("--workspace-uuid");
    expect(cmd).toContain("${CMUX_WORKSPACE_UUID:-}");
    expect(cmd).toContain("--role master");
    expect(settings.hooks.Notification[0].hooks[0].timeout).toBe(5000);
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

describe("T264 (T290 改): applyResumeTransitions (cmdStart resume)", () => {
  /** テスト用 TaskMeta ファクトリ（Finding 1 対応） */
  const makeMeta = (id: string, dependsOn: string[] = []): TaskMeta => ({
    id,
    title: `task-${id}`,
    status: "ready",
    priority: "medium",
    dependsOn,
    runAfterAll: false,
    exclusive: false,
    filePath: `/p/.team/tasks/${id}/task.md`,
    fileName: `${id}`,
    createdAt: "2026-04-19T00:00:00Z",
  });

  const fixedNow = () => "2026-04-19T12:00:00Z";

  test("(a) assigned + worktree 生存 → resume", async () => {
    const taskState: Record<string, TaskState> = {
      "1": {
        status: "assigned",
        sessionId: "s",
        taskRunId: "task-1-111",
        worktreePath: "/tmp/exists",
      },
    };
    const result = await applyResumeTransitions(taskState, [makeMeta("1")], {
      findTaskFile: async () => undefined,
      exists: () => true,
      now: fixedNow,
    });
    expect(result.resumePlan).toHaveLength(1);
    expect(result.resumePlan[0]).toEqual({
      taskId: "1",
      taskRunId: "task-1-111",
      worktreePath: "/tmp/exists",
      sessionId: "s",
    });
    expect(result.abortTargets).toEqual([]);
    // T290: applyResumeTransitions は taskState を mutate しない
    expect(taskState["1"]!.status).toBe("assigned");
  });

  test("(b) assigned + worktree 不在 → abortTargets に no_worktree + detail", async () => {
    const taskState: Record<string, TaskState> = {
      "1": {
        status: "assigned",
        sessionId: "s",
        taskRunId: "task-1-123",
        worktreePath: "/tmp/gone",
      },
    };
    const result = await applyResumeTransitions(taskState, [makeMeta("1")], {
      findTaskFile: async () => "/p/.team/tasks/1-foo/task.md",
      exists: () => false,
      now: fixedNow,
    });
    expect(result.abortTargets).toHaveLength(1);
    const target = result.abortTargets[0]!;
    expect(target.taskId).toBe("1");
    expect(target.classifyReason).toBe("no_worktree");
    expect(target.reason).toBe("resume_no_worktree");
    expect(target.detail).toContain(".team/tasks/1-foo/runs/task-1-123/");
    expect(target.detail).toContain("[resume] lost worktree");
    // T290: taskState は mutate されない — aborted 化は呼び出し側 markTaskAborted の責務
    expect(taskState["1"]!.status).toBe("assigned");
    expect(taskState["1"]!.abortedAt).toBeUndefined();
    expect(taskState["1"]!.journal).toBeUndefined();
    expect(result.resumePlan).toEqual([]);
  });

  test("(c) 親 assigned + worktree 不在 → abortTargets + cascade は呼び出し側", async () => {
    // T290 破壊的変更: applyResumeTransitions は cascade を行わない。
    //   markTaskAborted 側で cascade を行う設計のため、本関数の責務は
    //   「abort 対象を列挙する」ことだけ。
    const taskState: Record<string, TaskState> = {
      "1": {
        status: "assigned",
        sessionId: "s",
        taskRunId: "t1",
        worktreePath: "/tmp/gone",
      },
      "2": { status: "ready" },
    };
    const allTasks = [makeMeta("1"), makeMeta("2", ["1"])];
    const result = await applyResumeTransitions(taskState, allTasks, {
      findTaskFile: async () => undefined,
      exists: () => false,
      now: fixedNow,
    });
    expect(result.abortTargets.map((t) => t.taskId)).toEqual(["1"]);
    expect(result.abortTargets[0]!.reason).toBe("resume_no_worktree");
    // taskState は mutate されない
    expect(taskState["1"]!.status).toBe("assigned");
    expect(taskState["2"]!.status).toBe("ready");
  });

  test("(d) ready タスクは無影響", async () => {
    const taskState: Record<string, TaskState> = {
      "5": { status: "ready" },
    };
    const result = await applyResumeTransitions(taskState, [makeMeta("5")], {
      findTaskFile: async () => undefined,
      exists: () => true,
      now: fixedNow,
    });
    expect(result.resumePlan).toEqual([]);
    expect(result.abortTargets).toEqual([]);
    expect(taskState["5"]!.status).toBe("ready");
  });
});

// --- T286 S4/S5: `cmux-team stop` 廃止 ---

describe("cmdStop 廃止 (T286)", () => {
  const MAIN_TS = join(import.meta.dir, "main.ts");

  async function runStop(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
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
      proc.stdin.end();
    });
  }

  test("`cmux-team stop` は Unknown command で exit 1", async () => {
    const r = await runStop(["stop"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Unknown command: stop");
  }, 15000);

  test("冪等性: 2 回連続で呼んでも常に Unknown command + exit 1（副作用なし）", async () => {
    const r1 = await runStop(["stop"]);
    const r2 = await runStop(["stop"]);
    expect(r1.code).toBe(1);
    expect(r2.code).toBe(1);
    expect(r1.stderr).toContain("Unknown command: stop");
    expect(r2.stderr).toContain("Unknown command: stop");
  }, 20000);
});
