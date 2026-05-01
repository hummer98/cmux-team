import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "fs/promises";
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
  ensureAskDetectorScript,
  applyResumeTransitions,
  resolveCanonicalTaskId,
  parseCloseTaskArgs,
  decideAutoPullAction,
  formatAutoPullOutcome,
  generateSessionId,
  buildConductorClaudeArgs,
  buildAgentClaudeFlags,
  buildMasterClaudeArgs,
} from "./main";
import type { TaskMeta, TaskState } from "./task";
import {
  resolveLayout,
  resolveAutoUpdateMode,
  resolveTokenPoolEnabled,
  isTokenPoolEnabled,
} from "./config";
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
  // T379: matcher: "Bash" の Bash deny ブロック以外に matcher: "" の PRE_TOOL_USE 観察 hook が
  // 追加されたため、index アクセスではなく matcher で filter して取り出す。
  function findBashDenyBlock(settings: any): any {
    const blocks = settings.hooks.PreToolUse as any[];
    return blocks.find((b) => b.matcher === "Bash");
  }

  test("PreToolUse hook が Bash matcher で追加される", async () => {
    await mkdir(join(testDir, ".team/prompts"), { recursive: true });
    const settingsPath = generateConductorSettings(testDir, "surface:200");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));

    expect(Array.isArray(settings.hooks.PreToolUse)).toBe(true);
    const entry = findBashDenyBlock(settings);
    expect(entry).toBeTruthy();
    expect(entry.matcher).toBe("Bash");
    expect(entry.hooks.length).toBe(1);
    expect(entry.hooks[0].type).toBe("command");
    expect(entry.hooks[0].timeout).toBe(3000);
  });

  test("hook の command に cmux, send, exit 2 と日本語エラー文が含まれる (R3)", async () => {
    const settingsPath = generateConductorSettings(testDir, "surface:200");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    const cmd: string = findBashDenyBlock(settings).hooks[0].command;
    expect(cmd).toContain("cmux");
    expect(cmd).toContain("send");
    expect(cmd).toContain("exit 2");
    expect(cmd).toContain("cmux send / cmux send-key は Conductor から使用禁止です。");
    // R3: 代替コマンド行
    expect(cmd).toContain("cmux-team send-agent --surface");
  });

  // T379: deny 直前に PRE_TOOL_USE_DENIED 送信が入っていること
  test("T379: hook の command に cmux-team send PRE_TOOL_USE_DENIED が含まれる", async () => {
    const settingsPath = generateConductorSettings(testDir, "surface:200");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    const cmd: string = findBashDenyBlock(settings).hooks[0].command;
    expect(cmd).toContain("cmux-team send PRE_TOOL_USE_DENIED");
    // exit 2 の前に送信していること（順序保証）
    const denyIdx = cmd.indexOf("cmux-team send PRE_TOOL_USE_DENIED");
    const exitIdx = cmd.indexOf("exit 2");
    expect(denyIdx).toBeGreaterThan(0);
    expect(exitIdx).toBeGreaterThan(denyIdx);
  });

  test("既存の SessionStart / Stop / SessionEnd hook が残存している (regression)", async () => {
    const settingsPath = generateConductorSettings(testDir, "surface:200");
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
  // T379: matcher で Bash deny ブロックを取り出す（index アクセスは PRE_TOOL_USE 観察 hook 追加で破壊された）
  const block = (settings.hooks.PreToolUse as any[]).find((b) => b.matcher === "Bash");
  if (!block) throw new Error("Bash deny block not found");
  const cmd: string = block.hooks[0].command;
  const m = cmd.match(/^bash -c '([\s\S]*)'$/);
  if (!m) throw new Error(`unexpected hook command format: ${cmd}`);
  return m[1]!;
}

describe("PreToolUse hook 挙動 (§4.2)", () => {
  let script: string;

  beforeEach(async () => {
    const settingsPath = generateConductorSettings(testDir, "surface:200");
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
  test("default: config なし・CLI なし → 16x9", () => {
    expect(resolveLayout({}, undefined)).toBe("16x9");
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

describe("resolveTokenPoolEnabled (T322)", () => {
  // 優先順位: env > project > global > default(false)
  // env キー: CMUX_TEAM_TOKEN_POOL
  // - "0" / "false" / "off" → false (source=env)
  // - "1" / "true" / "on"   → true  (source=env)
  // - 未定義 / 空文字       → 次の層
  // - それ以外              → throw

  test("#1 env=0 で env を優先 (project=true, global=true でも false)", () => {
    expect(
      resolveTokenPoolEnabled(
        { tokenPool: { enabled: true } },
        { tokenPool: { enabled: true } },
        { CMUX_TEAM_TOKEN_POOL: "0" },
      ),
    ).toEqual({ enabled: false, source: "env" });
  });

  test("#2 env=false で env を優先", () => {
    expect(
      resolveTokenPoolEnabled(
        { tokenPool: { enabled: true } },
        { tokenPool: { enabled: true } },
        { CMUX_TEAM_TOKEN_POOL: "false" },
      ),
    ).toEqual({ enabled: false, source: "env" });
  });

  test("#3 env=off で env を優先", () => {
    expect(
      resolveTokenPoolEnabled(
        { tokenPool: { enabled: true } },
        { tokenPool: { enabled: true } },
        { CMUX_TEAM_TOKEN_POOL: "off" },
      ),
    ).toEqual({ enabled: false, source: "env" });
  });

  test("#4 env=1 で env を優先 (project=false, global=false でも true)", () => {
    expect(
      resolveTokenPoolEnabled(
        { tokenPool: { enabled: false } },
        { tokenPool: { enabled: false } },
        { CMUX_TEAM_TOKEN_POOL: "1" },
      ),
    ).toEqual({ enabled: true, source: "env" });
  });

  test("#5 env=true で env を優先", () => {
    expect(
      resolveTokenPoolEnabled(
        { tokenPool: { enabled: false } },
        { tokenPool: { enabled: false } },
        { CMUX_TEAM_TOKEN_POOL: "true" },
      ),
    ).toEqual({ enabled: true, source: "env" });
  });

  test("#6 env=on で env を優先", () => {
    expect(
      resolveTokenPoolEnabled(
        { tokenPool: { enabled: false } },
        { tokenPool: { enabled: false } },
        { CMUX_TEAM_TOKEN_POOL: "on" },
      ),
    ).toEqual({ enabled: true, source: "env" });
  });

  test("#7 env 未指定 + project=false → false (source=project) / global=true は無視", () => {
    expect(
      resolveTokenPoolEnabled(
        { tokenPool: { enabled: false } },
        { tokenPool: { enabled: true } },
        {},
      ),
    ).toEqual({ enabled: false, source: "project" });
  });

  test("#8 env 未指定 + project=true → true (source=project) / global=false は無視", () => {
    expect(
      resolveTokenPoolEnabled(
        { tokenPool: { enabled: true } },
        { tokenPool: { enabled: false } },
        {},
      ),
    ).toEqual({ enabled: true, source: "project" });
  });

  test("#9 env 空文字は未指定扱い → project にフォールバック", () => {
    expect(
      resolveTokenPoolEnabled(
        { tokenPool: { enabled: false } },
        { tokenPool: { enabled: true } },
        { CMUX_TEAM_TOKEN_POOL: "" },
      ),
    ).toEqual({ enabled: false, source: "project" });
  });

  test("#10 env 未指定 + project 未指定 + global=true → true (source=global)", () => {
    expect(
      resolveTokenPoolEnabled({}, { tokenPool: { enabled: true } }, {}),
    ).toEqual({ enabled: true, source: "global" });
  });

  test("#11 env 未指定 + project 未指定 + global=false → false (source=global)", () => {
    expect(
      resolveTokenPoolEnabled({}, { tokenPool: { enabled: false } }, {}),
    ).toEqual({ enabled: false, source: "global" });
  });

  test("#12 全て未指定 → false (source=default)", () => {
    expect(resolveTokenPoolEnabled({}, {}, {})).toEqual({
      enabled: false,
      source: "default",
    });
  });

  test("#13 env 未指定 + project=null + global=null → false (source=default)", () => {
    expect(resolveTokenPoolEnabled({}, null, {})).toEqual({
      enabled: false,
      source: "default",
    });
  });

  test("#14 env=yes → throw", () => {
    expect(() =>
      resolveTokenPoolEnabled({}, null, { CMUX_TEAM_TOKEN_POOL: "yes" }),
    ).toThrow(/unknown CMUX_TEAM_TOKEN_POOL/);
  });

  test("#15 env=2 → throw", () => {
    expect(() =>
      resolveTokenPoolEnabled({}, null, { CMUX_TEAM_TOKEN_POOL: "2" }),
    ).toThrow(/unknown CMUX_TEAM_TOKEN_POOL/);
  });

  test("project の tokenPool.enabled が boolean 以外 → 未指定扱い", () => {
    expect(
      resolveTokenPoolEnabled(
        { tokenPool: { enabled: "true" as any } },
        { tokenPool: { enabled: true } },
        {},
      ),
    ).toEqual({ enabled: true, source: "global" });
  });
});

describe("isTokenPoolEnabled (T322) smoke", () => {
  // mkdtemp で project root と HOME を作って 3 階層解決をエンドツーエンドで確認する。
  // env > project > global の優先順位は純粋関数側で十分カバーしているので、
  // ここでは I/O 層（loadConfig + loadGlobalConfig）の合流のみ確認する。

  let originalHome: string | undefined;
  let originalEnvFlag: string | undefined;
  let fakeHomes: string[] = [];

  beforeEach(() => {
    originalHome = process.env.HOME;
    originalEnvFlag = process.env.CMUX_TEAM_TOKEN_POOL;
    delete process.env.CMUX_TEAM_TOKEN_POOL;
    fakeHomes = [];
  });

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalEnvFlag === undefined) delete process.env.CMUX_TEAM_TOKEN_POOL;
    else process.env.CMUX_TEAM_TOKEN_POOL = originalEnvFlag;
    for (const h of fakeHomes) {
      await rm(h, { recursive: true, force: true });
    }
  });

  test("project=true (.team/config.json) で enabled=true / source=project", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "cmux-home-"));
    fakeHomes.push(fakeHome);
    process.env.HOME = fakeHome;
    await mkdir(join(testDir, ".team"), { recursive: true });
    await writeFile(
      join(testDir, ".team/config.json"),
      JSON.stringify({ tokenPool: { enabled: true } }),
      "utf-8",
    );
    const r = await isTokenPoolEnabled(testDir);
    expect(r).toEqual({ enabled: true, source: "project" });
  });

  test("project 未指定 + global yaml(token_pool.enabled=true) → enabled=true / source=global", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "cmux-home-"));
    fakeHomes.push(fakeHome);
    process.env.HOME = fakeHome;
    await mkdir(join(fakeHome, ".cmux-team"), { recursive: true });
    await writeFile(
      join(fakeHome, ".cmux-team/config.yaml"),
      "token_pool:\n  enabled: true\n",
      "utf-8",
    );
    const r = await isTokenPoolEnabled(testDir);
    expect(r).toEqual({ enabled: true, source: "global" });
  });

  test("全層未指定 → enabled=false / source=default", async () => {
    const fakeHome = await mkdtemp(join(tmpdir(), "cmux-home-"));
    fakeHomes.push(fakeHome);
    process.env.HOME = fakeHome;
    const r = await isTokenPoolEnabled(testDir);
    expect(r).toEqual({ enabled: false, source: "default" });
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

  // T333: delete-task --force 統合テスト
  test("delete-task: closed タスクは --force なしで reject される", async () => {
    await setupTeamDir("570", "t-closed", "closed");
    const r = await runCli(["delete-task", "--task-id", "570"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("already closed");
    expect(r.stderr).toContain("--force");
    const state = JSON.parse(
      await readFile(join(testDir, ".team/task-state.json"), "utf-8"),
    );
    expect(state["570"].status).toBe("closed");
  });

  test("delete-task --force: closed タスクが deleted に遷移する", async () => {
    await setupTeamDir("571", "t-closed-force", "closed");
    const r = await runCli(["delete-task", "--task-id", "571", "--force"]);
    expect(r.code).toBe(0);
    const state = JSON.parse(
      await readFile(join(testDir, ".team/task-state.json"), "utf-8"),
    );
    expect(state["571"].status).toBe("deleted");
    expect(receivedMessages.map((m) => m.type)).toEqual(["TASK_UPDATED"]);
  });

  test("delete-task --force: aborted タスクが deleted に遷移する", async () => {
    await setupTeamDir("572", "t-aborted-force", "aborted");
    const r = await runCli(["delete-task", "--task-id", "572", "--force"]);
    expect(r.code).toBe(0);
    const state = JSON.parse(
      await readFile(join(testDir, ".team/task-state.json"), "utf-8"),
    );
    expect(state["572"].status).toBe("deleted");
  });

  test("delete-task --force: assigned タスクは依然 reject される", async () => {
    await setupTeamDir("573", "t-assigned", "assigned");
    const r = await runCli(["delete-task", "--task-id", "573", "--force"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("is assigned");
    expect(r.stderr).not.toContain("Use --force");
    const state = JSON.parse(
      await readFile(join(testDir, ".team/task-state.json"), "utf-8"),
    );
    expect(state["573"].status).toBe("assigned");
  });

  test("delete-task --force: deleted タスクは依然 reject される", async () => {
    await setupTeamDir("574", "t-deleted", "deleted");
    const r = await runCli(["delete-task", "--task-id", "574", "--force"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("already deleted");
    expect(r.stderr).not.toContain("Use --force");
  });

  test("close-task: conductor 不在時に TASK_UPDATED が送信される", async () => {
    await setupTeamDir("504", "t4", "draft");
    // team.json を置かない（または conductors なし） → conductor 不在パス
    // T295: --deliverable-kind を必須化
    const r = await runCli(["close-task", "--task-id", "504", "--deliverable-kind", "none"]);
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

  // --- T394 後続: update-task --no-exclusive で frontmatter から
  // exclusive: true / run_after_all: true を除去できることを検証 ---

  async function setupExclusiveTaskDir(taskId: string): Promise<string> {
    const { mkdir: mk, writeFile: wf } = await import("fs/promises");
    await mk(join(testDir, ".team/tasks", `${taskId}-excl`), { recursive: true });
    const taskFile = join(testDir, ".team/tasks", `${taskId}-excl`, "task.md");
    await wf(
      taskFile,
      `---\nid: ${taskId}\ntitle: excl-task\npriority: high\nstatus: ready\nrun_after_all: true\nexclusive: true\n---\n\nbody\n`,
    );
    const taskState: Record<string, any> = {};
    taskState[taskId] = { status: "ready" };
    await wf(join(testDir, ".team/task-state.json"), JSON.stringify(taskState, null, 2));
    await wf(join(testDir, ".team/proxy-port"), String(port));
    return taskFile;
  }

  test("update-task --no-exclusive: frontmatter から exclusive と run_after_all を除去する", async () => {
    const taskFile = await setupExclusiveTaskDir("580");
    const r = await runCli(["update-task", "--task-id", "580", "--no-exclusive"]);
    expect(r.code).toBe(0);
    const content = await readFile(taskFile, "utf-8");
    expect(content).not.toMatch(/^exclusive:\s*true$/m);
    expect(content).not.toMatch(/^run_after_all:\s*true$/m);
    // 他の frontmatter は保持されること
    expect(content).toMatch(/^id:\s*580$/m);
    expect(content).toMatch(/^title:\s*excl-task$/m);
    expect(receivedMessages.map((m) => m.type)).toEqual(["TASK_UPDATED"]);
  });

  test("update-task --no-exclusive: 既に exclusive でないタスクでも no-op で成功する", async () => {
    const { mkdir: mk, writeFile: wf } = await import("fs/promises");
    await mk(join(testDir, ".team/tasks", "581-plain"), { recursive: true });
    const taskFile = join(testDir, ".team/tasks", "581-plain", "task.md");
    await wf(taskFile, `---\nid: 581\ntitle: plain\nstatus: ready\n---\n\nbody\n`);
    await wf(
      join(testDir, ".team/task-state.json"),
      JSON.stringify({ "581": { status: "ready" } }, null, 2),
    );
    await wf(join(testDir, ".team/proxy-port"), String(port));
    const r = await runCli(["update-task", "--task-id", "581", "--no-exclusive"]);
    expect(r.code).toBe(0);
    const content = await readFile(taskFile, "utf-8");
    expect(content).not.toMatch(/^exclusive:\s*true$/m);
    expect(content).not.toMatch(/^run_after_all:\s*true$/m);
  });

  test("update-task --no-exclusive のみで他フラグなしでも valid（status/title/body/depends-on 必須エラーにならない）", async () => {
    await setupExclusiveTaskDir("582");
    const r = await runCli(["update-task", "--task-id", "582", "--no-exclusive"]);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("at least one of");
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
    // T295: --deliverable-kind を必須化
    const r = await runCli(["close-task", "--task-id", "551-example", "--deliverable-kind", "none"]);
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
    // T295: --deliverable-kind を必須化（assigned + force で閉じる）
    const r = await runCli(["close-task", "--task-id", "552-example", "--deliverable-kind", "none", "--force"]);
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

    // T295: --deliverable-kind を付けても task-id 不正チェックは走る（先にチェックされる）
    const r = await runCli(["close-task", "--task-id", "999-bogus", "--deliverable-kind", "none"]);
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

  // --- T295: close-task --deliverable-kind 必須化 ---

  test("close-task (T295): --deliverable-kind 未指定で exit 1", async () => {
    await setupTeamDir("560", "t-560", "draft");
    const r = await runCli(["close-task", "--task-id", "560"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--deliverable-kind");
  });

  test("close-task (T295): kind=files で --deliverable ゼロ件なら exit 1", async () => {
    await setupTeamDir("561", "t-561", "draft");
    const r = await runCli([
      "close-task", "--task-id", "561",
      "--deliverable-kind", "files",
    ]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--deliverable");
  });

  test("close-task (T295): kind=merged で --merged-into 欠落なら exit 1", async () => {
    await setupTeamDir("562", "t-562", "draft");
    const r = await runCli([
      "close-task", "--task-id", "562",
      "--deliverable-kind", "merged",
      "--merge-sha", "abc1234",
    ]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--merged-into");
  });

  test("close-task (T295): kind=pr で --pr-url 欠落なら exit 1", async () => {
    await setupTeamDir("563", "t-563", "draft");
    const r = await runCli([
      "close-task", "--task-id", "563",
      "--deliverable-kind", "pr",
    ]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--pr-url");
  });

  test("close-task (T295): kind=none + 他 kind 用フラグ併記で exit 1（exclusive 検証）", async () => {
    await setupTeamDir("564", "t-564", "draft");
    const r = await runCli([
      "close-task", "--task-id", "564",
      "--deliverable-kind", "none",
      "--pr-url", "https://example.com/pull/1",
    ]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("does not accept");
  });

  test("close-task (T295): kind=files で --deliverable 複数指定が配列として記録される", async () => {
    await setupTeamDir("565", "t-565", "draft");
    const r = await runCli([
      "close-task", "--task-id", "565",
      "--deliverable-kind", "files",
      "--deliverable", "docs/spec/a.md",
      "--deliverable", ".team/artifacts/A042.md",
    ]);
    expect(r.code).toBe(0);
    const state = JSON.parse(
      await readFile(join(testDir, ".team/task-state.json"), "utf-8"),
    );
    expect(state["565"].deliverable).toEqual({
      kind: "files",
      files: ["docs/spec/a.md", ".team/artifacts/A042.md"],
    });
  });

  test("close-task (T295): kind=merged で branch + sha が記録される", async () => {
    await setupTeamDir("566", "t-566", "draft");
    const r = await runCli([
      "close-task", "--task-id", "566",
      "--deliverable-kind", "merged",
      "--merged-into", "task-566/task",
      "--merge-sha", "deadbeef01234567",
    ]);
    expect(r.code).toBe(0);
    const state = JSON.parse(
      await readFile(join(testDir, ".team/task-state.json"), "utf-8"),
    );
    expect(state["566"].deliverable).toEqual({
      kind: "merged",
      branch: "task-566/task",
      sha: "deadbeef01234567",
    });
  });

  test("close-task (T295): kind=pr で --pr-url が記録される", async () => {
    await setupTeamDir("567", "t-567", "draft");
    const r = await runCli([
      "close-task", "--task-id", "567",
      "--deliverable-kind", "pr",
      "--pr-url", "https://github.com/owner/repo/pull/42",
    ]);
    expect(r.code).toBe(0);
    const state = JSON.parse(
      await readFile(join(testDir, ".team/task-state.json"), "utf-8"),
    );
    expect(state["567"].deliverable).toEqual({
      kind: "pr",
      prUrl: "https://github.com/owner/repo/pull/42",
    });
  });

  test("close-task (T295): assigned + kind 指定のみ (journal なし) で close するには --force が必要", async () => {
    // F1/Rec1: 「kind で意図が明示されたら assigned guard は通す」方針だが、
    // L3049 の実装は `!force` を ガード条件に残しているため --force が依然必須。
    // ここではその仕様をロックする。
    await setupTeamDir("568", "t-568", "assigned");
    const { writeFile: wf } = await import("fs/promises");
    await wf(join(testDir, ".team/team.json"), JSON.stringify({ conductors: [] }));

    const r1 = await runCli([
      "close-task", "--task-id", "568",
      "--deliverable-kind", "none",
    ]);
    expect(r1.code).toBe(1);
    expect(r1.stderr).toContain("assigned");

    const r2 = await runCli([
      "close-task", "--task-id", "568",
      "--deliverable-kind", "none", "--force",
    ]);
    expect(r2.code).toBe(0);
    const state = JSON.parse(
      await readFile(join(testDir, ".team/task-state.json"), "utf-8"),
    );
    expect(state["568"].status).toBe("closed");
    expect(state["568"].deliverable).toEqual({ kind: "none" });
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

  // T392: api_error → exit 11 + STATUS=api_error / KIND=<kind>
  test("T392: status=api_error の done で exit 11 / STATUS=api_error / KIND= が出る", async () => {
    const { doneFile } = await setupForAwait();
    const ts = Date.now() + 3_000;
    await writeFile(
      doneFile,
      `status=api_error\ntimestamp_ms=${ts}\ntimestamp=${new Date(ts).toISOString()}\nkind=rate_limit\nmessage=API Error: limit\n`,
    );
    const proc = spawnAwait(10);
    const r = await proc.done;
    expect(r.code).toBe(11);
    expect(r.stdout).toContain("STATUS=api_error");
    expect(r.stdout).toContain("KIND=rate_limit");
    expect(r.stdout).toContain("MESSAGE=API Error: limit");
  }, 15000);

  test("T392: --help に Exit codes 表に 11 api_error が含まれる", async () => {
    const proc = spawn("bun", [
      "run", MAIN_TS,
      "await-agent",
      "--help",
    ], {
      cwd: testDir,
      env: { ...process.env, PROJECT_ROOT: testDir },
    }) as any;
    let stdout = "";
    proc.stdout!.on("data", (d: Buffer) => { stdout += d.toString(); });
    await new Promise<void>((resolve) => proc.on("close", () => resolve()));
    expect(stdout).toContain("11");
    expect(stdout).toContain("api_error");
  }, 10000);
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

  // T410: SESSION_STARTED に loadedPlugins / loadedSkills を opts 経由で注入できる
  test("T410: SESSION_STARTED — loadedPlugins / loadedSkills を opts で渡すと message に格納される", () => {
    const raw = JSON.stringify({ session_id: "u", source: "startup" });
    const msg = buildMessageFromHookInput("SESSION_STARTED", raw, {
      ...opts,
      loadedPlugins: ["cmux-team@hummer98-cmux-team"],
      loadedSkills: ["plugin:cmux-team", "user:nano-banana"],
    });
    if (msg.type === "SESSION_STARTED") {
      expect(msg.loadedPlugins).toEqual(["cmux-team@hummer98-cmux-team"]);
      expect(msg.loadedSkills).toEqual(["plugin:cmux-team", "user:nano-banana"]);
    }
  });

  test("T410: SESSION_STARTED — loadedPlugins / loadedSkills が null (取得失敗) でも保持される", () => {
    const raw = JSON.stringify({ session_id: "u", source: "startup" });
    const msg = buildMessageFromHookInput("SESSION_STARTED", raw, {
      ...opts,
      loadedPlugins: null,
      loadedSkills: null,
    });
    if (msg.type === "SESSION_STARTED") {
      expect(msg.loadedPlugins).toBeNull();
      expect(msg.loadedSkills).toBeNull();
    }
  });

  test("T410: SESSION_STARTED — opts に loadedPlugins / loadedSkills 無しの場合は undefined（旧パス互換）", () => {
    const raw = JSON.stringify({ session_id: "u", source: "startup" });
    const msg = buildMessageFromHookInput("SESSION_STARTED", raw, opts);
    if (msg.type === "SESSION_STARTED") {
      expect(msg.loadedPlugins).toBeUndefined();
      expect(msg.loadedSkills).toBeUndefined();
    }
  });

  test("T410: SESSION_STARTED — loadedPlugins が空配列 (loaded 0 件) でも保持される", () => {
    const raw = JSON.stringify({ session_id: "u", source: "startup" });
    const msg = buildMessageFromHookInput("SESSION_STARTED", raw, {
      ...opts,
      loadedPlugins: [],
      loadedSkills: [],
    });
    if (msg.type === "SESSION_STARTED") {
      expect(msg.loadedPlugins).toEqual([]);
      expect(msg.loadedSkills).toEqual([]);
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

  // --- T392: STOP_FAILURE branch ---

  test("T392: STOP_FAILURE — happy path で error / payload / role が反映される", () => {
    const raw = JSON.stringify({
      hook_event_name: "StopFailure",
      session_id: "fake-uuid",
      transcript_path: "/tmp/t.jsonl",
      error: "rate_limit",
      last_assistant_message: "API Error: Server is temporarily limiting requests...",
    });
    const msg = buildMessageFromHookInput("STOP_FAILURE", raw, {
      ...opts,
      role: "agent",
    });
    expect(msg.type).toBe("STOP_FAILURE");
    if (msg.type === "STOP_FAILURE") {
      expect(msg.surface).toBe("surface:100");
      expect(msg.pid).toBe(12345);
      expect(msg.role).toBe("agent");
      expect(msg.payload.error).toBe("rate_limit");
      expect(msg.payload.session_id).toBe("fake-uuid");
      expect(msg.payload.transcript_path).toBe("/tmp/t.jsonl");
      expect(msg.payload.last_assistant_message).toBe(
        "API Error: Server is temporarily limiting requests...",
      );
    }
  });

  test("T392: STOP_FAILURE — role flag が無くても通る (fallback)", () => {
    const raw = JSON.stringify({ error: "server_error" });
    const msg = buildMessageFromHookInput("STOP_FAILURE", raw, opts);
    if (msg.type === "STOP_FAILURE") {
      expect(msg.role).toBeUndefined();
      expect(msg.payload.error).toBe("server_error");
    }
  });

  test("T392: STOP_FAILURE — error フィールド欠落は zod throw", () => {
    const raw = JSON.stringify({ session_id: "x" });
    expect(() =>
      buildMessageFromHookInput("STOP_FAILURE", raw, opts),
    ).toThrow();
  });

  test("T392: STOP_FAILURE — role enum 範囲外は schema で throw", () => {
    const raw = JSON.stringify({ error: "rate_limit" });
    expect(() =>
      buildMessageFromHookInput("STOP_FAILURE", raw, { ...opts, role: "hacker" }),
    ).toThrow();
  });

  // --- T379: PRE_TOOL_USE / POST_TOOL_USE branch ---

  test("T379: PRE_TOOL_USE — tool_name / session_id を抽出し payload を畳み込む", () => {
    const raw = JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: "sess-pre",
      cwd: "/tmp",
      tool_name: "Edit",
      tool_input: { file_path: "/tmp/x.ts", old_string: "a", new_string: "b" },
    });
    const msg = buildMessageFromHookInput("PRE_TOOL_USE", raw, {
      ...opts,
      role: "agent",
    });
    expect(msg.type).toBe("PRE_TOOL_USE");
    if (msg.type === "PRE_TOOL_USE") {
      expect(msg.surface).toBe("surface:100");
      expect(msg.pid).toBe(12345);
      expect(msg.role).toBe("agent");
      expect(msg.sessionId).toBe("sess-pre");
      expect(msg.toolName).toBe("Edit");
      expect(msg.payload?.tool_input).toEqual({
        file_path: "/tmp/x.ts",
        old_string: "a",
        new_string: "b",
      });
    }
  });

  test("T379: POST_TOOL_USE — tool_response を含む payload で通る", () => {
    const raw = JSON.stringify({
      hook_event_name: "PostToolUse",
      session_id: "sess-post",
      tool_name: "Read",
      tool_input: { file_path: "/tmp/r.ts" },
      tool_response: { success: true, content: "abc" },
    });
    const msg = buildMessageFromHookInput("POST_TOOL_USE", raw, {
      ...opts,
      role: "agent",
    });
    if (msg.type === "POST_TOOL_USE") {
      expect(msg.toolName).toBe("Read");
      expect(msg.sessionId).toBe("sess-post");
      expect(msg.payload?.tool_response).toEqual({ success: true, content: "abc" });
    }
  });

  test("T379: POST_TOOL_USE — tool_response.content 8KB 超は 1KB に切り詰められる", () => {
    const big = "x".repeat(8192);
    const raw = JSON.stringify({
      session_id: "sess-big",
      tool_name: "Read",
      tool_input: { file_path: "/tmp/big.txt" },
      tool_response: { success: true, content: big },
    });
    const msg = buildMessageFromHookInput("POST_TOOL_USE", raw, {
      ...opts,
      role: "agent",
    });
    if (msg.type === "POST_TOOL_USE") {
      const content = (msg.payload?.tool_response as any)?.content;
      expect(typeof content).toBe("string");
      expect(content.length).toBeLessThanOrEqual(1024);
      // 切り詰めても success フラグは保持される
      expect((msg.payload?.tool_response as any)?.success).toBe(true);
    }
  });

  test("T379: PRE_TOOL_USE — tool_name 欠落は throw", () => {
    const raw = JSON.stringify({ session_id: "sess-x", tool_input: {} });
    expect(() =>
      buildMessageFromHookInput("PRE_TOOL_USE", raw, { ...opts, role: "agent" }),
    ).toThrow();
  });

  test("T379: PRE_TOOL_USE — session_id 無しでも sessionId: undefined で通る", () => {
    const raw = JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" } });
    const msg = buildMessageFromHookInput("PRE_TOOL_USE", raw, {
      ...opts,
      role: "conductor",
    });
    if (msg.type === "PRE_TOOL_USE") {
      expect(msg.sessionId).toBeUndefined();
      expect(msg.toolName).toBe("Bash");
    }
  });

  test("T379: PRE_TOOL_USE — role 不正値は zod で throw", () => {
    const raw = JSON.stringify({ tool_name: "Edit" });
    expect(() =>
      buildMessageFromHookInput("PRE_TOOL_USE", raw, { ...opts, role: "hacker" }),
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
    const settingsPath = generateConductorSettings(testDir, "surface:200");
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
    const settingsPath = generateConductorSettings(testDir, "surface:200");
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
    const settingsPath = generateConductorSettings(testDir, "surface:200");
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
    const settingsPath = generateConductorSettings(testDir, "surface:200");
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
    const settingsPath = generateConductorSettings(testDir, "surface:200");
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

  // T392: StopFailure hook (Conductor / Agent)
  test("T392: Conductor settings に StopFailure hook があり role=conductor で送信する", async () => {
    await mkdir(join(testDir, ".team/prompts"), { recursive: true });
    const settingsPath = generateConductorSettings(testDir, "surface:200");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));

    expect(Array.isArray(settings.hooks.StopFailure)).toBe(true);
    expect(settings.hooks.StopFailure.length).toBe(1);
    expect(settings.hooks.StopFailure[0].matcher).toBe("");
    const cmd: string = settings.hooks.StopFailure[0].hooks[0].command;
    expect(cmd).toContain("cmux-team send STOP_FAILURE");
    expect(cmd).toContain("--from-stdin");
    expect(cmd).toContain("${CMUX_SURFACE}");
    expect(cmd).toContain("$PPID");
    expect(cmd).toContain("--role conductor");
    expect(settings.hooks.StopFailure[0].hooks[0].timeout).toBe(5000);
  });

  test("T392: Agent settings に StopFailure hook があり role=agent で送信する", async () => {
    await mkdir(join(testDir, ".team/prompts"), { recursive: true });
    const settingsPath = generateAgentSettings(testDir, "surface:100");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));

    expect(Array.isArray(settings.hooks.StopFailure)).toBe(true);
    expect(settings.hooks.StopFailure.length).toBe(1);
    expect(settings.hooks.StopFailure[0].matcher).toBe("");
    const cmd: string = settings.hooks.StopFailure[0].hooks[0].command;
    expect(cmd).toContain("cmux-team send STOP_FAILURE");
    expect(cmd).toContain("--from-stdin");
    expect(cmd).toContain('--surface "surface:100"');
    expect(cmd).toContain("$PPID");
    expect(cmd).toContain("--role agent");
    expect(settings.hooks.StopFailure[0].hooks[0].timeout).toBe(5000);
  });
});

// --- T211: generateMasterSettings ---

describe("generateMasterSettings (T211)", () => {
  test("settings.json に UserPromptSubmit / Stop hook が含まれる", async () => {
    const settingsPath = generateMasterSettings(testDir, "surface:100");
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
    const path1 = generateMasterSettings(testDir, "surface:100");
    const path2 = generateMasterSettings(testDir, "surface:100");
    expect(path1).toBe(path2);
    const content = await readFile(path2, "utf-8");
    JSON.parse(content); // parse error にならなければ OK
  });

  // T175: Master の稼働中ステータスを TUI に反映するため、
  // Conductor と同じ SessionStart / SessionEnd hook を Master にも適用する。
  // これにより daemon は SESSION_STARTED で masterPid を確立し、
  // spawnMasterPidWatcher を起動できるようになる。
  test("T175: settings.hooks.SessionStart が cmux-team send SESSION_STARTED --from-stdin を呼ぶ", async () => {
    const settingsPath = generateMasterSettings(testDir, "surface:100");
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
    const settingsPath = generateMasterSettings(testDir, "surface:100");
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
    const settingsPath = generateMasterSettings(testDir, "surface:100");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    const matchers: string[] = (settings.hooks.SessionEnd ?? []).map(
      (h: any) => h.matcher,
    );
    expect(matchers.some((m) => m === "clear")).toBe(false);
    expect(matchers.some((m) => m.includes("clear"))).toBe(false);
  });

  test("T175: UserPromptSubmit / Stop hook は既存のまま残る（regression guard）", async () => {
    const settingsPath = generateMasterSettings(testDir, "surface:100");
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
    const settingsPath = generateMasterSettings(testDir, "surface:100");
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

  // T392: StopFailure hook
  test("T392: settings.hooks.StopFailure が cmux-team send STOP_FAILURE --from-stdin を呼ぶ (role=master)", async () => {
    const settingsPath = generateMasterSettings(testDir, "surface:100");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));

    expect(Array.isArray(settings.hooks.StopFailure)).toBe(true);
    expect(settings.hooks.StopFailure.length).toBe(1);
    expect(settings.hooks.StopFailure[0].matcher).toBe("");
    const cmd: string = settings.hooks.StopFailure[0].hooks[0].command;
    expect(cmd).toContain("cmux-team send STOP_FAILURE");
    expect(cmd).toContain("--from-stdin");
    expect(cmd).toContain("${CMUX_SURFACE}");
    expect(cmd).toContain("$PPID");
    expect(cmd).toContain("--role master");
    expect(settings.hooks.StopFailure[0].hooks[0].timeout).toBe(5000);
  });

  // T379: Master settings に PreToolUse / PostToolUse の matcher: "" 観察 hook が追加される
  test("T379: Master settings.hooks.PreToolUse に matcher: \"\" 観察 hook が追加される (role=master)", async () => {
    const settingsPath = generateMasterSettings(testDir, "surface:100");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));

    expect(Array.isArray(settings.hooks.PreToolUse)).toBe(true);
    const observerBlock = (settings.hooks.PreToolUse as any[]).find(
      (b) => b.matcher === "",
    );
    expect(observerBlock).toBeTruthy();
    const cmd: string = observerBlock.hooks[0].command;
    expect(cmd).toContain("cmux-team send PRE_TOOL_USE");
    expect(cmd).toContain("--from-stdin");
    expect(cmd).toContain("--role master");
    expect(cmd).toContain("$PPID");
    expect(observerBlock.hooks[0].timeout).toBe(3000);
  });

  test("T379: Master settings.hooks.PostToolUse が cmux-team send POST_TOOL_USE を呼ぶ (role=master)", async () => {
    const settingsPath = generateMasterSettings(testDir, "surface:100");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));

    expect(Array.isArray(settings.hooks.PostToolUse)).toBe(true);
    expect(settings.hooks.PostToolUse.length).toBe(1);
    expect(settings.hooks.PostToolUse[0].matcher).toBe("");
    const cmd: string = settings.hooks.PostToolUse[0].hooks[0].command;
    expect(cmd).toContain("cmux-team send POST_TOOL_USE");
    expect(cmd).toContain("--from-stdin");
    expect(cmd).toContain("--role master");
    expect(settings.hooks.PostToolUse[0].hooks[0].timeout).toBe(3000);
  });
});

// --- T379: Conductor / Agent settings の PreToolUse / PostToolUse 観察 hook ---

describe("T379: Conductor settings の PreToolUse / PostToolUse 観察 hook", () => {
  test("Conductor settings.hooks.PreToolUse に Bash deny + matcher: \"\" 観察 hook の 2 ブロックが含まれる", async () => {
    const settingsPath = generateConductorSettings(testDir, "surface:200");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    const blocks = settings.hooks.PreToolUse as any[];
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    const bashBlock = blocks.find((b) => b.matcher === "Bash");
    const observerBlock = blocks.find((b) => b.matcher === "");
    expect(bashBlock).toBeTruthy();
    expect(observerBlock).toBeTruthy();
  });

  test("Conductor PreToolUse 観察 hook の command に --role conductor が含まれる", async () => {
    const settingsPath = generateConductorSettings(testDir, "surface:200");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    const observerBlock = (settings.hooks.PreToolUse as any[]).find(
      (b) => b.matcher === "",
    );
    const cmd: string = observerBlock.hooks[0].command;
    expect(cmd).toContain("cmux-team send PRE_TOOL_USE");
    expect(cmd).toContain("--from-stdin");
    expect(cmd).toContain("--role conductor");
  });

  test("Conductor settings.hooks.PostToolUse が cmux-team send POST_TOOL_USE を呼ぶ (role=conductor)", async () => {
    const settingsPath = generateConductorSettings(testDir, "surface:200");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    expect(Array.isArray(settings.hooks.PostToolUse)).toBe(true);
    const observerBlock = (settings.hooks.PostToolUse as any[]).find(
      (b) => b.matcher === "",
    );
    expect(observerBlock).toBeTruthy();
    const cmd: string = observerBlock.hooks[0].command;
    expect(cmd).toContain("cmux-team send POST_TOOL_USE");
    expect(cmd).toContain("--from-stdin");
    expect(cmd).toContain("--role conductor");
  });
});

describe("T379: Agent settings の PreToolUse / PostToolUse 観察 hook", () => {
  test("Agent settings.hooks.PreToolUse の command に --role agent が含まれる", async () => {
    const settingsPath = generateAgentSettings(testDir, "surface:300");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    expect(Array.isArray(settings.hooks.PreToolUse)).toBe(true);
    const observerBlock = (settings.hooks.PreToolUse as any[]).find(
      (b) => b.matcher === "",
    );
    expect(observerBlock).toBeTruthy();
    const cmd: string = observerBlock.hooks[0].command;
    expect(cmd).toContain("cmux-team send PRE_TOOL_USE");
    expect(cmd).toContain("--from-stdin");
    expect(cmd).toContain("--role agent");
  });

  test("Agent settings.hooks.PostToolUse の command に --role agent が含まれる", async () => {
    const settingsPath = generateAgentSettings(testDir, "surface:300");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    expect(Array.isArray(settings.hooks.PostToolUse)).toBe(true);
    const observerBlock = (settings.hooks.PostToolUse as any[]).find(
      (b) => b.matcher === "",
    );
    expect(observerBlock).toBeTruthy();
    const cmd: string = observerBlock.hooks[0].command;
    expect(cmd).toContain("cmux-team send POST_TOOL_USE");
    expect(cmd).toContain("--from-stdin");
    expect(cmd).toContain("--role agent");
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

// --- T304: x-cmux-role header injection via settings.env ---

describe("generateMasterSettings (T304: x-cmux-role / T323: x-cmux-surface / T355: 改行区切り)", () => {
  test("settings.env.ANTHROPIC_CUSTOM_HEADERS に x-cmux-role と x-cmux-surface を改行区切りで注入する", async () => {
    const settingsPath = generateMasterSettings(testDir, "surface:100");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    expect(settings.env).toBeDefined();
    expect(settings.env.ANTHROPIC_CUSTOM_HEADERS).toBe(
      "x-cmux-role: master\nx-cmux-surface: surface:100",
    );
  });

  test("T323: settings.json は per-surface パスに保存される", () => {
    const settingsPath = generateMasterSettings(testDir, "surface:100");
    expect(settingsPath).toContain("surface:100-master-settings.json");
  });
});

describe("generateConductorSettings (T304: x-cmux-role / T323: x-cmux-surface / T355: 改行区切り)", () => {
  test("settings.env.ANTHROPIC_CUSTOM_HEADERS に x-cmux-role と x-cmux-surface を改行区切りで注入する", async () => {
    const settingsPath = generateConductorSettings(testDir, "surface:200");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    expect(settings.env).toBeDefined();
    expect(settings.env.ANTHROPIC_CUSTOM_HEADERS).toBe(
      "x-cmux-role: conductor\nx-cmux-surface: surface:200",
    );
  });

  test("T323: settings.json は per-surface パスに保存される", () => {
    const settingsPath = generateConductorSettings(testDir, "surface:200");
    expect(settingsPath).toContain("surface:200-conductor-settings.json");
  });
});

describe("generateAgentSettings (T304: x-cmux-role / T403: x-cmux-surface + x-cmux-task-id)", () => {
  test("taskId 未指定時は x-cmux-role と x-cmux-surface のみを改行区切りで注入する（x-cmux-task-id 行なし）", async () => {
    const settingsPath = generateAgentSettings(testDir, "surface:100");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    expect(settings.env).toBeDefined();
    expect(settings.env.ANTHROPIC_CUSTOM_HEADERS).toBe(
      "x-cmux-role: agent\nx-cmux-surface: surface:100",
    );
    // taskId 未指定時は x-cmux-task-id 行を含めない（壊れた値で書き込まないため）
    expect(settings.env.ANTHROPIC_CUSTOM_HEADERS).not.toContain("x-cmux-task-id");
  });

  test("T403: taskId 指定時は x-cmux-role / x-cmux-surface / x-cmux-task-id の 3 行を改行区切りで注入する", async () => {
    const settingsPath = generateAgentSettings(testDir, "surface:100", "T403");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    expect(settings.env.ANTHROPIC_CUSTOM_HEADERS).toBe(
      "x-cmux-role: agent\nx-cmux-surface: surface:100\nx-cmux-task-id: T403",
    );
  });

  test("T403: taskId 指定時の ANTHROPIC_CUSTOM_HEADERS にカンマ区切り (T355 regression) が混入しない", async () => {
    const settingsPath = generateAgentSettings(testDir, "surface:100", "T403");
    const settings = JSON.parse(await readFile(settingsPath, "utf-8"));
    const headers: string = settings.env.ANTHROPIC_CUSTOM_HEADERS;
    // T355: ANTHROPIC_CUSTOM_HEADERS は改行区切り（カンマ区切りは SDK が 1 ヘッダー値として送ってしまう）
    expect(headers).toContain("\n");
    expect(headers).not.toContain(", x-cmux-surface");
    expect(headers).not.toContain(", x-cmux-task-id");
  });
});

// T355 regression: ANTHROPIC_CUSTOM_HEADERS にカンマ区切りが混入していないこと（公式仕様は改行区切り）。
// カンマ区切りで連結すると Claude Code SDK が全体を 1 ヘッダー値として送信し、
// proxy 側の `req.headers.get("x-cmux-role")` が "master, x-cmux-surface: surface:N"
// のような汚染値を拾うため、api_usage.role 列が壊れる。
describe("T355: ANTHROPIC_CUSTOM_HEADERS は改行区切り（カンマ混入禁止）", () => {
  test("master / conductor の ANTHROPIC_CUSTOM_HEADERS にカンマ区切りが含まれない", async () => {
    const masterPath = generateMasterSettings(testDir, "surface:100");
    const conductorPath = generateConductorSettings(testDir, "surface:200");
    const master = JSON.parse(await readFile(masterPath, "utf-8"));
    const conductor = JSON.parse(await readFile(conductorPath, "utf-8"));
    expect(master.env.ANTHROPIC_CUSTOM_HEADERS).not.toContain(", x-cmux-surface");
    expect(conductor.env.ANTHROPIC_CUSTOM_HEADERS).not.toContain(", x-cmux-surface");
    expect(master.env.ANTHROPIC_CUSTOM_HEADERS).toContain("\n");
    expect(conductor.env.ANTHROPIC_CUSTOM_HEADERS).toContain("\n");
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

// --- T342: agent-instructions CLI が overlay ロール (master/conductor) をサポート ---

describe("agent-instructions CLI overlay roles (T342)", () => {
  const MAIN_TS = join(import.meta.dir, "main.ts");

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
      proc.stdin.end();
    });
  }

  test("set/get/delete-agent-instructions --role master", async () => {
    const setRes = await runCli([
      "set-agent-instructions", "--role", "master", "--body", "MASTER_X",
    ]);
    expect(setRes.code).toBe(0);
    const file = join(testDir, ".team/agent-instructions/master.md");
    const raw = await readFile(file, "utf-8");
    expect(raw).toBe("MASTER_X\n");

    const getRes = await runCli(["get-agent-instructions", "--role", "master"]);
    expect(getRes.code).toBe(0);
    expect(getRes.stdout).toBe("MASTER_X\n");

    const delRes = await runCli(["delete-agent-instructions", "--role", "master"]);
    expect(delRes.code).toBe(0);
    expect(delRes.stdout).toContain("DELETED=true");
  }, 20000);

  test("set-agent-instructions --role conductor", async () => {
    const setRes = await runCli([
      "set-agent-instructions", "--role", "conductor", "--body", "CONDUCTOR_X",
    ]);
    expect(setRes.code).toBe(0);
    const raw = await readFile(
      join(testDir, ".team/agent-instructions/conductor.md"),
      "utf-8",
    );
    expect(raw).toBe("CONDUCTOR_X\n");
  }, 15000);

  test("list-agent-instructions includes master / conductor lines", async () => {
    const r = await runCli(["list-agent-instructions"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^master /m);
    expect(r.stdout).toMatch(/^conductor /m);
  }, 15000);
});

// --- T342: spawn-agent の role バリデーション ---

describe("cmdSpawnAgent role validation (T342)", () => {
  const MAIN_TS = join(import.meta.dir, "main.ts");

  async function runSpawn(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
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

  test("--role master は exit 1 + stderr に reserved", async () => {
    const r = await runSpawn([
      "spawn-agent",
      "--conductor-surface", "surface:1",
      "--role", "master",
      "--prompt", "x",
    ]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("reserved");
    expect(r.stderr).toContain("master");
  }, 15000);

  test("--role conductor は exit 1 + stderr に reserved", async () => {
    const r = await runSpawn([
      "spawn-agent",
      "--conductor-surface", "surface:1",
      "--role", "conductor",
      "--prompt", "x",
    ]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("reserved");
    expect(r.stderr).toContain("conductor");
  }, 15000);

  test("--role unknown-foo は exit 1 + stderr に unknown role", async () => {
    const r = await runSpawn([
      "spawn-agent",
      "--conductor-surface", "surface:1",
      "--role", "unknown-foo",
      "--prompt", "x",
    ]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("unknown role");
    expect(r.stderr).toContain("unknown-foo");
  }, 15000);
});

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

// --- T295: parseCloseTaskArgs pure 関数 unit テスト ---

describe("parseCloseTaskArgs (T295)", () => {
  test("kind 未指定なら error", () => {
    const r = parseCloseTaskArgs(["--task-id", "1"]);
    expect("error" in r).toBe(true);
    if ("error" in r) {
      expect(r.error).toContain("--deliverable-kind");
    }
  });

  test("kind=files で --deliverable 無しなら error", () => {
    const r = parseCloseTaskArgs([
      "--task-id", "1", "--deliverable-kind", "files",
    ]);
    expect("error" in r).toBe(true);
  });

  test("kind=files で --deliverable 複数指定が配列化される", () => {
    const r = parseCloseTaskArgs([
      "--task-id", "1", "--deliverable-kind", "files",
      "--deliverable", "a.md", "--deliverable", "b.md",
    ]);
    expect("deliverable" in r).toBe(true);
    if ("deliverable" in r) {
      expect(r.deliverable).toEqual({ kind: "files", files: ["a.md", "b.md"] });
    }
  });

  test("kind=merged で --merged-into + --merge-sha が両方あれば success", () => {
    const r = parseCloseTaskArgs([
      "--task-id", "1", "--deliverable-kind", "merged",
      "--merged-into", "task-1/task", "--merge-sha", "abc1234",
    ]);
    expect("deliverable" in r).toBe(true);
    if ("deliverable" in r) {
      expect(r.deliverable).toEqual({ kind: "merged", branch: "task-1/task", sha: "abc1234" });
    }
  });

  test("kind=merged で --merge-sha 欠落は error", () => {
    const r = parseCloseTaskArgs([
      "--task-id", "1", "--deliverable-kind", "merged",
      "--merged-into", "b",
    ]);
    expect("error" in r).toBe(true);
  });

  test("kind=pr で --pr-url が記録される", () => {
    const r = parseCloseTaskArgs([
      "--task-id", "1", "--deliverable-kind", "pr",
      "--pr-url", "https://example.com/pull/9",
    ]);
    expect("deliverable" in r).toBe(true);
    if ("deliverable" in r) {
      expect(r.deliverable).toEqual({ kind: "pr", prUrl: "https://example.com/pull/9" });
    }
  });

  test("kind=none で success（付随フラグ無し）", () => {
    const r = parseCloseTaskArgs([
      "--task-id", "1", "--deliverable-kind", "none",
    ]);
    expect("deliverable" in r).toBe(true);
    if ("deliverable" in r) {
      expect(r.deliverable).toEqual({ kind: "none" });
    }
  });

  test("kind=none に他 kind 用フラグが混入したら error（exclusive 検証）", () => {
    const r = parseCloseTaskArgs([
      "--task-id", "1", "--deliverable-kind", "none",
      "--pr-url", "https://x",
    ]);
    expect("error" in r).toBe(true);
    if ("error" in r) {
      expect(r.error).toContain("does not accept");
    }
  });

  test("不明な kind は error", () => {
    const r = parseCloseTaskArgs([
      "--task-id", "1", "--deliverable-kind", "invalid-kind",
    ]);
    expect("error" in r).toBe(true);
  });

  test("--journal と --force は deliverable と独立に通る", () => {
    const r = parseCloseTaskArgs([
      "--task-id", "1", "--deliverable-kind", "none",
      "--journal", "done", "--force",
    ]);
    expect("deliverable" in r).toBe(true);
    if ("deliverable" in r) {
      expect(r.journal).toBe("done");
      expect(r.force).toBe(true);
    }
  });
});

// --- T339: runSyncCheckOrExit の auto-pull 分岐 (M2) ---

describe("decideAutoPullAction (T339)", () => {
  const verdict = {
    kind: "auto-pull" as const,
    mainBranch: "main",
    message:
      "info: local main is behind-ff origin/main; auto-pulling with --ff-only.\n" +
      "  Recommended (manual): git pull --ff-only origin main",
  };

  test("noAutoPull=true → skip-warn + verdict.message と --no-auto-pull の警告を含む", () => {
    const d = decideAutoPullAction(verdict, { noAutoPull: true });
    expect(d.kind).toBe("skip-warn");
    if (d.kind === "skip-warn") {
      expect(d.warnMessages.length).toBe(2);
      // verdict.message（推奨コマンド込み）が含まれる (M1)
      expect(d.warnMessages[0]).toContain("git pull --ff-only origin main");
      expect(d.warnMessages[1]).toMatch(/--no-auto-pull/);
    }
  });

  test("noAutoPull=false → perform + mainBranch 引き継ぎ + 事前メッセージ", () => {
    const d = decideAutoPullAction(verdict, { noAutoPull: false });
    expect(d.kind).toBe("perform");
    if (d.kind === "perform") {
      expect(d.mainBranch).toBe("main");
      expect(d.preMessage).toContain("auto-pulling with --ff-only");
    }
  });

  test("mainBranch=develop の verdict は perform.mainBranch=develop", () => {
    const v = { ...verdict, mainBranch: "develop" };
    const d = decideAutoPullAction(v, { noAutoPull: false });
    if (d.kind === "perform") {
      expect(d.mainBranch).toBe("develop");
    } else {
      throw new Error("expected perform");
    }
  });
});

describe("formatAutoPullOutcome (T339)", () => {
  test("ok=true → ok + summary + logMessage に origin/<main> + summary 含む", () => {
    const o = formatAutoPullOutcome(
      { ok: true, stdout: "Fast-forward...", stderr: "", summary: "fast-forward" },
      "main",
    );
    expect(o.kind).toBe("ok");
    if (o.kind === "ok") {
      expect(o.summary).toBe("fast-forward");
      expect(o.logMessage).toContain("origin/main");
      expect(o.logMessage).toContain("fast-forward");
    }
  });

  test("ok=false → fail + errorMessage に Bypass: と diverged ヒント (M1, m3)", () => {
    const o = formatAutoPullOutcome(
      {
        ok: false,
        stdout: "",
        stderr: "fatal: refusing to merge unrelated histories",
        summary: "unknown",
      },
      "main",
    );
    expect(o.kind).toBe("fail");
    if (o.kind === "fail") {
      expect(o.errorMessage).toMatch(/Bypass:/);
      expect(o.errorMessage).toMatch(/--no-auto-pull/);
      expect(o.errorMessage).toMatch(/--force/);
      expect(o.errorMessage).toMatch(/diverged/);
      expect(o.errorMessage).toContain("git pull --rebase origin main");
      expect(o.errorMessage).toContain("fatal: refusing to merge");
      // stderrSummary は改行を空白に潰す
      expect(o.stderrSummary).not.toMatch(/\n/);
    }
  });

  test("ok=false + 改行混じり stderr → stderrSummary は単一行", () => {
    const o = formatAutoPullOutcome(
      {
        ok: false,
        stdout: "",
        stderr: "line1\nline2\n  line3",
        summary: "unknown",
      },
      "develop",
    );
    if (o.kind === "fail") {
      expect(o.stderrSummary).toBe("line1 line2 line3");
      expect(o.errorMessage).toContain("origin develop");
    } else {
      throw new Error("expected fail");
    }
  });
});

// --- T407: UUID pre-inject for cmdConductor / cmdSpawnAgent ---

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("generateSessionId (T407)", () => {
  test("(T-11) UUID v4 形式を返す", () => {
    const id = generateSessionId();
    expect(id).toMatch(UUID_V4_RE);
  });

  test("複数回呼び出すと異なる UUID を返す（衝突しない）", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) ids.add(generateSessionId());
    expect(ids.size).toBe(100);
  });
});

describe("buildConductorClaudeArgs (T407)", () => {
  test("(T-2) `--session-id <UUID>` を含む", () => {
    const args = buildConductorClaudeArgs({
      conductorSettingsPath: "/p/conductor-settings.json",
      model: "claude-sonnet-4-6",
      rolePromptFile: "/p/role.md",
      sessionId: "11111111-2222-4333-8444-555555555555",
    });
    const idx = args.indexOf("--session-id");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("11111111-2222-4333-8444-555555555555");
  });

  test("--session-id は単独の arg として渡る（値と分離）", () => {
    const args = buildConductorClaudeArgs({
      conductorSettingsPath: "/p/conductor-settings.json",
      model: "claude-sonnet-4-6",
      rolePromptFile: "/p/role.md",
      sessionId: "abcdabcd-1234-4abc-89ab-abcdabcdabcd",
    });
    // shell escape を避けるため、claude binary に直接渡す形式（execFileSync）の args 配列。
    // フラグと値が並んでいる順序で含まれる。
    expect(args).toContain("--session-id");
    expect(args).toContain("abcdabcd-1234-4abc-89ab-abcdabcdabcd");
  });

  test("--dangerously-skip-permissions / --settings / --model / --append-system-prompt-file が含まれる（既存挙動維持）", () => {
    const args = buildConductorClaudeArgs({
      conductorSettingsPath: "/p/conductor-settings.json",
      model: "claude-sonnet-4-6",
      rolePromptFile: "/p/role.md",
      sessionId: "11111111-2222-4333-8444-555555555555",
    });
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--settings");
    expect(args).toContain("/p/conductor-settings.json");
    expect(args).toContain("--model");
    expect(args).toContain("claude-sonnet-4-6");
    expect(args).toContain("--append-system-prompt-file");
    expect(args).toContain("/p/role.md");
  });

  test("taskPromptFile を渡すと末尾に「読んで指示に従って...」が追加される", () => {
    const args = buildConductorClaudeArgs({
      conductorSettingsPath: "/p/conductor-settings.json",
      model: "claude-sonnet-4-6",
      rolePromptFile: "/p/role.md",
      sessionId: "11111111-2222-4333-8444-555555555555",
      taskPromptFile: "/p/task.md",
    });
    expect(args[args.length - 1]).toBe("/p/task.md を読んで指示に従って作業してください。");
  });

  test("taskPromptFile 未指定なら末尾に「読んで指示に従って...」は無い", () => {
    const args = buildConductorClaudeArgs({
      conductorSettingsPath: "/p/conductor-settings.json",
      model: "claude-sonnet-4-6",
      rolePromptFile: "/p/role.md",
      sessionId: "11111111-2222-4333-8444-555555555555",
    });
    expect(args.find((a) => a.includes("読んで指示に従って"))).toBeUndefined();
  });
});

describe("buildAgentClaudeFlags (T407)", () => {
  test("(T-1) `--session-id <UUID>` を含む（join 後の文字列に出現）", () => {
    const flags = buildAgentClaudeFlags({
      agentSettingsFlag: "--settings '/p/agent-settings.json'",
      model: "claude-sonnet-4-6",
      sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    });
    // claudeFlags は `cmux.send` 経由で `claudeFlags.join(" ")` され shell に投入される。
    // join 後の文字列に `--session-id <UUID>` が含まれることを確認。
    const joined = flags.join(" ");
    expect(joined).toContain("--session-id aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  });

  test("(R5) tokenInjected の有無に関わらず `--session-id` は claudeFlags に必ず入る", () => {
    // R5: `tokenInjected=true` (inline env prefix あり) と `tokenInjected=false` (prefix なし) の
    //   2 fixture でいずれも `--session-id` が claude binary 引数として正しく付与されることを確認。
    //   token prefix は claudeFlags の外側（`CLAUDE_CODE_OAUTH_TOKEN="$CMUX_CLAUDE_TOKEN" claude ...`）に
    //   配置されるため、claudeFlags 自体には影響しない。
    const flags = buildAgentClaudeFlags({
      agentSettingsFlag: "--settings '/p/agent-settings.json'",
      model: "claude-sonnet-4-6",
      sessionId: "11111111-2222-4333-8444-555555555555",
    });
    const joined = flags.join(" ");
    expect(joined).toContain("--session-id 11111111-2222-4333-8444-555555555555");

    // tokenInjected=false の経路でも同じ claudeFlags が組み立てられる（外側 prefix のみ差分）
    const flagsNoToken = buildAgentClaudeFlags({
      agentSettingsFlag: "--settings '/p/agent-settings.json'",
      model: "claude-sonnet-4-6",
      sessionId: "11111111-2222-4333-8444-555555555555",
    });
    expect(flagsNoToken.join(" ")).toContain("--session-id 11111111-2222-4333-8444-555555555555");
  });

  test("(T-11) sessionId が UUID v4 形式であることをそのまま保持する", () => {
    const id = generateSessionId();
    expect(id).toMatch(UUID_V4_RE);
    const flags = buildAgentClaudeFlags({
      agentSettingsFlag: "--settings '/p/agent-settings.json'",
      model: "claude-sonnet-4-6",
      sessionId: id,
    });
    expect(flags.join(" ")).toContain(`--session-id ${id}`);
  });

  test("agentSettingsFlag 未指定なら --settings は claudeFlags に出ない", () => {
    const flags = buildAgentClaudeFlags({
      agentSettingsFlag: undefined,
      model: "claude-sonnet-4-6",
      sessionId: "11111111-2222-4333-8444-555555555555",
    });
    expect(flags.join(" ")).not.toContain("--settings");
  });
});

// --- T408: buildMasterClaudeArgs (Conductor 版と対称) ---

describe("buildMasterClaudeArgs (T408)", () => {
  test("(T-2 対称) `--session-id <UUID>` を含む", () => {
    const args = buildMasterClaudeArgs({
      masterSettingsPath: "/p/master-settings.json",
      model: "claude-opus-4-7",
      rolePromptFile: "/p/master.md",
      sessionId: "cccccccc-dddd-4eee-8fff-000000000010",
    });
    const idx = args.indexOf("--session-id");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("cccccccc-dddd-4eee-8fff-000000000010");
  });

  test("--session-id は単独の arg として渡る（値と分離）", () => {
    const args = buildMasterClaudeArgs({
      masterSettingsPath: "/p/master-settings.json",
      model: "claude-opus-4-7",
      rolePromptFile: "/p/master.md",
      sessionId: "abcdabcd-1234-4abc-89ab-abcdabcdabcd",
    });
    expect(args).toContain("--session-id");
    expect(args).toContain("abcdabcd-1234-4abc-89ab-abcdabcdabcd");
  });

  test("--dangerously-skip-permissions / --settings / --model / --append-system-prompt-file が含まれる（既存挙動維持）", () => {
    const args = buildMasterClaudeArgs({
      masterSettingsPath: "/p/master-settings.json",
      model: "claude-opus-4-7",
      rolePromptFile: "/p/master.md",
      sessionId: "cccccccc-dddd-4eee-8fff-000000000011",
    });
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--settings");
    expect(args).toContain("/p/master-settings.json");
    expect(args).toContain("--model");
    expect(args).toContain("claude-opus-4-7");
    expect(args).toContain("--append-system-prompt-file");
    expect(args).toContain("/p/master.md");
  });

  test("Master では taskPromptFile に相当する末尾引数は付与されない（Conductor 版との差分）", () => {
    const args = buildMasterClaudeArgs({
      masterSettingsPath: "/p/master-settings.json",
      model: "claude-opus-4-7",
      rolePromptFile: "/p/master.md",
      sessionId: "cccccccc-dddd-4eee-8fff-000000000012",
    });
    expect(args.find((a) => a.includes("読んで指示に従って"))).toBeUndefined();
  });

  test("(T-11) generateSessionId の UUID をそのまま保持する", () => {
    const id = generateSessionId();
    expect(id).toMatch(UUID_V4_RE);
    const args = buildMasterClaudeArgs({
      masterSettingsPath: "/p/master-settings.json",
      model: "claude-opus-4-7",
      rolePromptFile: "/p/master.md",
      sessionId: id,
    });
    const idx = args.indexOf("--session-id");
    expect(args[idx + 1]).toBe(id);
  });
});


