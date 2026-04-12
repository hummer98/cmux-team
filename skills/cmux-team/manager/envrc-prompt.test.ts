import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ensureEnvrcHookPrompt, appendExportLine, type Answer } from "./envrc-prompt";

let testDir: string;
let savedNoPrompt: string | undefined;
let savedProjectRoot: string | undefined;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "cmux-envrc-test-"));
  savedNoPrompt = process.env.CMUX_TEAM_NO_PROMPT;
  delete process.env.CMUX_TEAM_NO_PROMPT;
  savedProjectRoot = process.env.PROJECT_ROOT;
  process.env.PROJECT_ROOT = testDir;
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
  if (savedNoPrompt !== undefined) {
    process.env.CMUX_TEAM_NO_PROMPT = savedNoPrompt;
  } else {
    delete process.env.CMUX_TEAM_NO_PROMPT;
  }
  if (savedProjectRoot !== undefined) {
    process.env.PROJECT_ROOT = savedProjectRoot;
  } else {
    delete process.env.PROJECT_ROOT;
  }
});

const ttyAsk = (answer: Answer) => async () => answer;
const baseOpts = {
  isTTY: true,
  direnvPath: null as string | null,
  runDirenvAllow: async () => {},
};

describe("ensureEnvrcHookPrompt - gating", () => {
  test(".envrc が存在しなければ noop_no_envrc", async () => {
    const r = await ensureEnvrcHookPrompt(testDir, { ...baseOpts, ask: ttyAsk("Y") });
    expect(r.action).toBe("noop_no_envrc");
  });

  test(".envrc に CMUX_CLAUDE_HOOKS_DISABLED が既存なら noop_already_set", async () => {
    await writeFile(join(testDir, ".envrc"), "export CMUX_CLAUDE_HOOKS_DISABLED=1\n");
    const r = await ensureEnvrcHookPrompt(testDir, { ...baseOpts, ask: ttyAsk("Y") });
    expect(r.action).toBe("noop_already_set");
  });

  test("config.envrcHookPromptSkipped=true なら noop_user_silenced", async () => {
    await writeFile(join(testDir, ".envrc"), "source_up\n");
    await mkdir(join(testDir, ".team"), { recursive: true });
    await writeFile(
      join(testDir, ".team/config.json"),
      JSON.stringify({ envrcHookPromptSkipped: true }, null, 2) + "\n"
    );
    const r = await ensureEnvrcHookPrompt(testDir, { ...baseOpts, ask: ttyAsk("Y") });
    expect(r.action).toBe("noop_user_silenced");
  });

  test("CMUX_TEAM_NO_PROMPT=1 なら noop_env_silenced", async () => {
    await writeFile(join(testDir, ".envrc"), "source_up\n");
    const r = await ensureEnvrcHookPrompt(testDir, {
      ...baseOpts,
      envOverride: { CMUX_TEAM_NO_PROMPT: "1" },
      ask: ttyAsk("Y"),
    });
    expect(r.action).toBe("noop_env_silenced");
  });

  test("非 TTY なら noop_no_tty", async () => {
    await writeFile(join(testDir, ".envrc"), "source_up\n");
    const r = await ensureEnvrcHookPrompt(testDir, {
      ...baseOpts,
      isTTY: false,
      ask: ttyAsk("Y"),
    });
    expect(r.action).toBe("noop_no_tty");
  });
});

describe("ensureEnvrcHookPrompt - 対話", () => {
  test("Y 入力で .envrc に追記される / config は不変", async () => {
    await writeFile(join(testDir, ".envrc"), "source_up\n");
    const r = await ensureEnvrcHookPrompt(testDir, { ...baseOpts, ask: ttyAsk("Y") });
    expect(r.action).toBe("added");
    const content = await readFile(join(testDir, ".envrc"), "utf-8");
    expect(content).toContain("export CMUX_CLAUDE_HOOKS_DISABLED=1");
    expect(existsSync(join(testDir, ".team/config.json"))).toBe(false);
  });

  test("n 入力で .envrc も config も不変", async () => {
    await writeFile(join(testDir, ".envrc"), "source_up\n");
    const r = await ensureEnvrcHookPrompt(testDir, { ...baseOpts, ask: ttyAsk("n") });
    expect(r.action).toBe("skipped_once");
    const content = await readFile(join(testDir, ".envrc"), "utf-8");
    expect(content).toBe("source_up\n");
    expect(existsSync(join(testDir, ".team/config.json"))).toBe(false);
  });

  test("N 入力で .envrc 不変 / config に envrcHookPromptSkipped=true", async () => {
    await writeFile(join(testDir, ".envrc"), "source_up\n");
    await mkdir(join(testDir, ".team"), { recursive: true });
    const r = await ensureEnvrcHookPrompt(testDir, { ...baseOpts, ask: ttyAsk("N") });
    expect(r.action).toBe("silenced");
    const envrc = await readFile(join(testDir, ".envrc"), "utf-8");
    expect(envrc).toBe("source_up\n");
    const config = JSON.parse(await readFile(join(testDir, ".team/config.json"), "utf-8"));
    expect(config.envrcHookPromptSkipped).toBe(true);
  });

  test("Y 入力 + direnv なし で warnings に direnv 警告", async () => {
    await writeFile(join(testDir, ".envrc"), "source_up\n");
    const r = await ensureEnvrcHookPrompt(testDir, {
      ...baseOpts,
      direnvPath: null,
      ask: ttyAsk("Y"),
    });
    expect(r.action).toBe("added");
    expect(r.warnings.some((w) => w.includes("direnv"))).toBe(true);
  });

  test("Y 入力 + direnv あり で direnv allow が呼ばれる", async () => {
    await writeFile(join(testDir, ".envrc"), "source_up\n");
    let calledWith: string | undefined;
    const r = await ensureEnvrcHookPrompt(testDir, {
      ...baseOpts,
      direnvPath: "/usr/bin/direnv",
      runDirenvAllow: async (cwd: string) => {
        calledWith = cwd;
      },
      ask: ttyAsk("Y"),
    });
    expect(r.action).toBe("added");
    expect(calledWith).toBe(testDir);
    expect(r.warnings.length).toBe(0);
  });

  test("既存 config に他のフィールドがあっても merge される", async () => {
    await writeFile(join(testDir, ".envrc"), "source_up\n");
    await mkdir(join(testDir, ".team"), { recursive: true });
    await writeFile(
      join(testDir, ".team/config.json"),
      JSON.stringify({ models: { master: "opus" } }, null, 2) + "\n"
    );
    const r = await ensureEnvrcHookPrompt(testDir, { ...baseOpts, ask: ttyAsk("N") });
    expect(r.action).toBe("silenced");
    const config = JSON.parse(await readFile(join(testDir, ".team/config.json"), "utf-8"));
    expect(config.envrcHookPromptSkipped).toBe(true);
    expect(config.models.master).toBe("opus");
  });
});

describe("appendExportLine", () => {
  test(".envrc が末尾改行なしでも改行を補ってから append", async () => {
    const envrcPath = join(testDir, ".envrc");
    await writeFile(envrcPath, "source_up");
    await appendExportLine(envrcPath);
    const content = await readFile(envrcPath, "utf-8");
    expect(content).toBe("source_up\nexport CMUX_CLAUDE_HOOKS_DISABLED=1\n");
  });

  test(".envrc が末尾改行ありなら追加改行は不要", async () => {
    const envrcPath = join(testDir, ".envrc");
    await writeFile(envrcPath, "source_up\n");
    await appendExportLine(envrcPath);
    const content = await readFile(envrcPath, "utf-8");
    expect(content).toBe("source_up\nexport CMUX_CLAUDE_HOOKS_DISABLED=1\n");
  });

  test("ensureEnvrcHookPrompt 経由でも末尾改行なしを正しく扱う", async () => {
    await writeFile(join(testDir, ".envrc"), "source_up");
    const r = await ensureEnvrcHookPrompt(testDir, { ...baseOpts, ask: ttyAsk("Y") });
    expect(r.action).toBe("added");
    const content = await readFile(join(testDir, ".envrc"), "utf-8");
    expect(content).toBe("source_up\nexport CMUX_CLAUDE_HOOKS_DISABLED=1\n");
  });
});
