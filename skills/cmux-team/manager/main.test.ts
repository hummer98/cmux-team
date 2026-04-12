import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "child_process";
import {
  generateConductorSettings,
  validateSendAgentTarget,
  waitForAgentRegistered,
} from "./main";

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
