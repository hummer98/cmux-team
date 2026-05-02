import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFile } from "fs/promises";
import { join } from "path";
import { existsSync } from "fs";

import {
  AGENT_INSTRUCTIONS_DIR_REL,
  AGENT_INSTRUCTIONS_MAX_BYTES,
  agentInstructionsPath,
  readProjectInstructions,
  writeProjectInstructions,
  deleteProjectInstructions,
  listProjectInstructions,
  formatProjectInstructionsBlock,
  formatProjectCommonInstructionsBlock,
} from "./agent-instructions";
import {
  AGENT_ROLES,
  OVERLAY_ROLES,
  OverlayRole,
  normalizeAgentRole,
  normalizeOverlayRole,
} from "./schema";
import { expandProjectInstructions } from "./template";
import { createDummyProject, type DummyProject } from "./test-project";

let project: DummyProject;
let projectRoot: string;

beforeEach(async () => {
  project = await createDummyProject({
    prefix: "cmux-agent-inst-",
    subdirs: [],
    setProjectRootEnv: false,
  });
  projectRoot = project.root;
});

afterEach(async () => {
  await project.dispose();
});

// --- §7.1 test 1-2: formatProjectInstructionsBlock (null / empty) ---

describe("formatProjectInstructionsBlock", () => {
  test("(1) null body → empty string (ja)", () => {
    expect(formatProjectInstructionsBlock(null, "ja")).toBe("");
  });

  test("(2) empty body → empty string (en)", () => {
    expect(formatProjectInstructionsBlock("", "en")).toBe("");
  });

  test("(3) ja locale → block contains ja heading", () => {
    const out = formatProjectInstructionsBlock("foo bar", "ja");
    expect(out).toContain("## プロジェクト固有の追加指示");
    expect(out).toContain("foo bar");
  });

  test("(4) en locale → block contains en heading (M1)", () => {
    const out = formatProjectInstructionsBlock("foo bar", "en");
    expect(out).toContain("## Project-Specific Instructions");
    expect(out).toContain("foo bar");
  });

  test("block format is `\\n<heading>\\n\\n<body>\\n` (case A)", () => {
    const out = formatProjectInstructionsBlock("hello", "en");
    expect(out).toBe("\n## Project-Specific Instructions\n\nhello\n");
  });

  test("body trailing whitespace is trimmed (trimEnd)", () => {
    const out = formatProjectInstructionsBlock("hello\n\n\n", "en");
    expect(out).toBe("\n## Project-Specific Instructions\n\nhello\n");
  });
});

// --- §7.1 test 5-8: round-trip / size / delete / list ---

describe("read/write/delete/listProjectInstructions", () => {
  test("(5) write → read round-trip preserves content", async () => {
    const body = "TEST_MARKER_xyz\nline2\n";
    await writeProjectInstructions(projectRoot, "implementer", body);
    const got = await readProjectInstructions(projectRoot, "implementer");
    expect(got).toBe(body);
  });

  test("(6) write > 100KB throws", async () => {
    const huge = "x".repeat(AGENT_INSTRUCTIONS_MAX_BYTES + 1);
    await expect(
      writeProjectInstructions(projectRoot, "implementer", huge),
    ).rejects.toThrow(/exceeds/);
  });

  test("(7) delete returns false when file does not exist (no-op)", async () => {
    const r = await deleteProjectInstructions(projectRoot, "implementer");
    expect(r).toBe(false);
  });

  test("(7b) delete returns true after write", async () => {
    await writeProjectInstructions(projectRoot, "implementer", "hi");
    const r = await deleteProjectInstructions(projectRoot, "implementer");
    expect(r).toBe(true);
    expect(existsSync(agentInstructionsPath(projectRoot, "implementer"))).toBe(false);
  });

  test("(8) list returns all OVERLAY_ROLES in order (T342)", async () => {
    const items = await listProjectInstructions(projectRoot);
    expect(items.length).toBe(OVERLAY_ROLES.length);
    items.forEach((it, i) => {
      expect(it.role).toBe(OVERLAY_ROLES[i]!);
      expect(it.exists).toBe(false);
      expect(it.size).toBe(0);
    });
  });

  test("list reports exists=true and size>0 after write", async () => {
    await writeProjectInstructions(projectRoot, "implementer", "hello world");
    const items = await listProjectInstructions(projectRoot);
    const impl = items.find((x) => x.role === "implementer");
    expect(impl).toBeDefined();
    expect(impl!.exists).toBe(true);
    expect(impl!.size).toBeGreaterThan(0);
  });

  test("write ensures trailing newline", async () => {
    await writeProjectInstructions(projectRoot, "implementer", "no-newline");
    const raw = await readFile(agentInstructionsPath(projectRoot, "implementer"), "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
  });

  test("agentInstructionsPath builds correct relative path", () => {
    const p = agentInstructionsPath(projectRoot, "researcher");
    expect(p).toBe(join(projectRoot, AGENT_INSTRUCTIONS_DIR_REL, "researcher.md"));
  });
});

// --- §7.1 test 9-10: normalizeAgentRole ---

describe("normalizeAgentRole", () => {
  test("(9) impl → implementer", () => {
    expect(normalizeAgentRole("impl")).toBe("implementer");
  });

  test("reviewer → design-reviewer", () => {
    expect(normalizeAgentRole("reviewer")).toBe("design-reviewer");
  });

  test("canonical role name passes through", () => {
    expect(normalizeAgentRole("planner")).toBe("planner");
    expect(normalizeAgentRole("implementer")).toBe("implementer");
  });

  test("(10) unknown role → undefined", () => {
    expect(normalizeAgentRole("foobar")).toBeUndefined();
  });
});

// --- §7.1 test 11-14: expandProjectInstructions ---

describe("expandProjectInstructions (T247 / R1)", () => {
  test("(11) mode=empty when no overlay — placeholder replaced, no triple newlines", async () => {
    const input = "BEFORE\n\n{{PROJECT_INSTRUCTIONS}}\n\nAFTER";
    const { expanded, mode } = await expandProjectInstructions(projectRoot, "implementer", input);
    expect(mode).toBe("empty");
    expect(expanded).not.toContain("{{PROJECT_INSTRUCTIONS}}");
    // R1 verification: no run of 3+ consecutive newlines anywhere in output
    expect(/\n\n\n+/.test(expanded)).toBe(false);
  });

  test("(11b) mode=empty for unknown role — also no triple newlines", async () => {
    const input = "BEFORE\n\n{{PROJECT_INSTRUCTIONS}}\n\nAFTER";
    const { expanded, mode } = await expandProjectInstructions(projectRoot, "not-a-role", input);
    expect(mode).toBe("unknown-role");
    expect(expanded).not.toContain("{{PROJECT_INSTRUCTIONS}}");
    expect(/\n\n\n+/.test(expanded)).toBe(false);
  });

  test("(12) mode=applied replaces placeholder with overlay block (no triple newlines)", async () => {
    await writeProjectInstructions(projectRoot, "implementer", "OVERLAY_BODY_HERE");
    const input = "BEFORE\n\n{{PROJECT_INSTRUCTIONS}}\n\nAFTER";
    const { expanded, mode } = await expandProjectInstructions(projectRoot, "implementer", input);
    expect(mode).toBe("applied");
    expect(expanded).toContain("OVERLAY_BODY_HERE");
    // heading is picked from current process locale; both ja/en should carry the prefix `## `
    expect(expanded).toMatch(/^.*## .+/s);
    expect(expanded).not.toContain("{{PROJECT_INSTRUCTIONS}}");
    // R1 verification: no triple newline
    expect(/\n\n\n+/.test(expanded)).toBe(false);
  });

  test("(13) mode=noop when placeholder absent — content unchanged", async () => {
    const input = "no placeholder here\nat all";
    const { expanded, mode } = await expandProjectInstructions(projectRoot, "implementer", input);
    expect(mode).toBe("noop");
    expect(expanded).toBe(input);
  });

  test("(14) mode=unknown-role when role is not in AgentRole enum", async () => {
    const input = "X\n\n{{PROJECT_INSTRUCTIONS}}\n\nY";
    const { expanded, mode } = await expandProjectInstructions(projectRoot, "does-not-exist", input);
    expect(mode).toBe("unknown-role");
    expect(expanded).not.toContain("{{PROJECT_INSTRUCTIONS}}");
  });

  test("impl alias is accepted", async () => {
    await writeProjectInstructions(projectRoot, "implementer", "ALIAS_OVERLAY");
    const input = "A\n\n{{PROJECT_INSTRUCTIONS}}\n\nB";
    const { expanded, mode } = await expandProjectInstructions(projectRoot, "impl", input);
    expect(mode).toBe("applied");
    expect(expanded).toContain("ALIAS_OVERLAY");
  });
});

// --- T342: master/conductor overlay support ---

describe("master/conductor overlay (T342)", () => {
  test("(15) write/read round-trip for master overlay", async () => {
    const body = "MASTER_OVERLAY_BODY\nline2\n";
    await writeProjectInstructions(projectRoot, "master", body);
    const got = await readProjectInstructions(projectRoot, "master");
    expect(got).toBe(body);
  });

  test("(16) write/read round-trip for conductor overlay", async () => {
    const body = "CONDUCTOR_OVERLAY_BODY\n";
    await writeProjectInstructions(projectRoot, "conductor", body);
    const got = await readProjectInstructions(projectRoot, "conductor");
    expect(got).toBe(body);
  });

  test("(17) deleteProjectInstructions(\"master\") works", async () => {
    await writeProjectInstructions(projectRoot, "master", "to be deleted\n");
    const deleted = await deleteProjectInstructions(projectRoot, "master");
    expect(deleted).toBe(true);
    expect(existsSync(agentInstructionsPath(projectRoot, "master"))).toBe(false);
  });

  test("(18) listProjectInstructions includes master, conductor, common at the end (T413)", async () => {
    const items = await listProjectInstructions(projectRoot);
    const roles = items.map((it) => it.role);
    // T413: 末尾は agent 8 → master → conductor → common の順
    expect(roles[roles.length - 3]).toBe("master");
    expect(roles[roles.length - 2]).toBe("conductor");
    expect(roles[roles.length - 1]).toBe("common");
  });

  test("agentInstructionsPath builds correct relative path for master", () => {
    const p = agentInstructionsPath(projectRoot, "master");
    expect(p).toBe(join(projectRoot, AGENT_INSTRUCTIONS_DIR_REL, "master.md"));
  });

  test("agentInstructionsPath builds correct relative path for conductor", () => {
    const p = agentInstructionsPath(projectRoot, "conductor");
    expect(p).toBe(join(projectRoot, AGENT_INSTRUCTIONS_DIR_REL, "conductor.md"));
  });

  // --- T342 §Step 3: expandProjectInstructions for master/conductor ---

  test("(19) expandProjectInstructions(role=\"master\") with overlay → mode=applied", async () => {
    await writeProjectInstructions(projectRoot, "master", "MASTER_BODY");
    const input = "BEFORE\n\n{{PROJECT_INSTRUCTIONS}}\n\nAFTER";
    const { expanded, mode } = await expandProjectInstructions(projectRoot, "master", input);
    expect(mode).toBe("applied");
    expect(expanded).toContain("MASTER_BODY");
    expect(expanded).not.toContain("{{PROJECT_INSTRUCTIONS}}");
    expect(/\n\n\n+/.test(expanded)).toBe(false);
  });

  test("(20) expandProjectInstructions(role=\"conductor\") with overlay → mode=applied", async () => {
    await writeProjectInstructions(projectRoot, "conductor", "CONDUCTOR_BODY");
    const input = "BEFORE\n\n{{PROJECT_INSTRUCTIONS}}\n\nAFTER";
    const { expanded, mode } = await expandProjectInstructions(projectRoot, "conductor", input);
    expect(mode).toBe("applied");
    expect(expanded).toContain("CONDUCTOR_BODY");
    expect(expanded).not.toContain("{{PROJECT_INSTRUCTIONS}}");
    expect(/\n\n\n+/.test(expanded)).toBe(false);
  });

  test("(21) expandProjectInstructions(role=\"master\") without overlay → mode=empty", async () => {
    const input = "BEFORE\n\n{{PROJECT_INSTRUCTIONS}}\n\nAFTER";
    const { expanded, mode } = await expandProjectInstructions(projectRoot, "master", input);
    expect(mode).toBe("empty");
    expect(expanded).not.toContain("{{PROJECT_INSTRUCTIONS}}");
    expect(/\n\n\n+/.test(expanded)).toBe(false);
  });

  test("expandProjectInstructions(role=\"conductor\") without overlay → mode=empty", async () => {
    const input = "BEFORE\n\n{{PROJECT_INSTRUCTIONS}}\n\nAFTER";
    const { expanded, mode } = await expandProjectInstructions(projectRoot, "conductor", input);
    expect(mode).toBe("empty");
    expect(expanded).not.toContain("{{PROJECT_INSTRUCTIONS}}");
    expect(/\n\n\n+/.test(expanded)).toBe(false);
  });
});

// --- T413: common overlay (agent-instructions 層) ---

describe("common overlay (T413)", () => {
  test("(A) OverlayRole has \"common\" + OVERLAY_ROLES.length === 11 + last is common", () => {
    expect(OverlayRole.options).toContain("common" as OverlayRole);
    expect(OVERLAY_ROLES.length).toBe(11);
    expect(OVERLAY_ROLES[OVERLAY_ROLES.length - 1]).toBe("common" as OverlayRole);
  });

  test("normalizeOverlayRole(\"common\") returns \"common\"", () => {
    expect(normalizeOverlayRole("common")).toBe("common" as OverlayRole);
  });

  test("(B) agentInstructionsPath(\"common\") maps to _common.md", () => {
    const p = agentInstructionsPath(projectRoot, "common");
    expect(p).toBe(join(projectRoot, AGENT_INSTRUCTIONS_DIR_REL, "_common.md"));
  });

  test("(C) agentInstructionsPath(\"implementer\") still maps to implementer.md", () => {
    const p = agentInstructionsPath(projectRoot, "implementer");
    expect(p).toBe(join(projectRoot, AGENT_INSTRUCTIONS_DIR_REL, "implementer.md"));
  });

  test("(D) write/read round-trip for common overlay → _common.md", async () => {
    const body = "COMMON_BODY\nline2\n";
    await writeProjectInstructions(projectRoot, "common", body);
    const got = await readProjectInstructions(projectRoot, "common");
    expect(got).toBe(body);
    // 物理的に _common.md に書かれていることを確認
    const raw = await readFile(
      join(projectRoot, AGENT_INSTRUCTIONS_DIR_REL, "_common.md"),
      "utf-8",
    );
    expect(raw).toBe(body);
  });

  test("(E) deleteProjectInstructions(\"common\") true/false", async () => {
    expect(await deleteProjectInstructions(projectRoot, "common")).toBe(false);
    await writeProjectInstructions(projectRoot, "common", "to be deleted\n");
    expect(await deleteProjectInstructions(projectRoot, "common")).toBe(true);
    expect(existsSync(agentInstructionsPath(projectRoot, "common"))).toBe(false);
  });

  test("(F) listProjectInstructions includes common at the end", async () => {
    await writeProjectInstructions(projectRoot, "common", "BODY");
    const items = await listProjectInstructions(projectRoot);
    expect(items.length).toBe(11);
    const common = items.find((x) => x.role === "common");
    expect(common).toBeDefined();
    expect(common!.exists).toBe(true);
    expect(common!.size).toBeGreaterThan(0);
    expect(items[items.length - 1]!.role).toBe("common" as OverlayRole);
  });

  test("(G) formatProjectCommonInstructionsBlock(null, \"ja\") → empty", () => {
    expect(formatProjectCommonInstructionsBlock(null, "ja")).toBe("");
  });

  test("formatProjectCommonInstructionsBlock(\"\", \"en\") → empty", () => {
    expect(formatProjectCommonInstructionsBlock("", "en")).toBe("");
  });

  test("(H) formatProjectCommonInstructionsBlock body (ja) contains ja heading", () => {
    const out = formatProjectCommonInstructionsBlock("hi", "ja");
    expect(out).toContain("## プロジェクト共通の追加指示");
    expect(out).toContain("hi");
  });

  test("(I) formatProjectCommonInstructionsBlock body (en) contains en heading", () => {
    const out = formatProjectCommonInstructionsBlock("hi", "en");
    expect(out).toContain("## Project Common Instructions");
    expect(out).toContain("hi");
  });

  test("formatProjectCommonInstructionsBlock format `\\n<heading>\\n\\n<body>\\n`", () => {
    const out = formatProjectCommonInstructionsBlock("hello", "en");
    expect(out).toBe("\n## Project Common Instructions\n\nhello\n");
  });
});
