import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
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
} from "./agent-instructions";
import { AGENT_ROLES, normalizeAgentRole } from "./schema";
import { expandProjectInstructions } from "./template";

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), "cmux-agent-inst-"));
});

afterEach(async () => {
  try { await rm(projectRoot, { recursive: true, force: true }); } catch {}
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

  test("(8) list returns all AGENT_ROLES in order", async () => {
    const items = await listProjectInstructions(projectRoot);
    expect(items.length).toBe(AGENT_ROLES.length);
    items.forEach((it, i) => {
      expect(it.role).toBe(AGENT_ROLES[i]!);
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
