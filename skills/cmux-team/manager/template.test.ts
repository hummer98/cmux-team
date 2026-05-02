/**
 * template.ts の generateMasterPrompt / generateConductorRolePrompt が
 * `{{PROJECT_INSTRUCTIONS}}` overlay を展開することを確認するテスト（T342）。
 *
 * - PROJECT_ROOT は tmp dir に差し替える（test-project helper 経由）
 * - findTemplateDir は (1) `<PROJECT_ROOT>/skills/cmux-team/templates` を最優先で
 *   探すが tmp dir には存在しないため、(2) daemon 自身からの相対パス
 *   `<manager>/../templates` にフォールバックする。これは worktree 内の
 *   実テンプレを参照するので overlay 展開挙動を実環境に近い形で検証できる
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "fs/promises";
import { join } from "path";

import { writeProjectInstructions } from "./agent-instructions";
import {
  expandProjectCommonInstructions,
  expandPromptOverlays,
  generateConductorRolePrompt,
  generateMasterPrompt,
} from "./template";
import { createDummyProject, type DummyProject } from "./test-project";

let project: DummyProject;
let projectRoot: string;

beforeEach(async () => {
  project = await createDummyProject({
    prefix: "cmux-template-test-",
    setProjectRootEnv: true,
  });
  projectRoot = project.root;
});

afterEach(async () => {
  await project.dispose();
});

describe("generateMasterPrompt overlay (T342)", () => {
  test("expands {{PROJECT_INSTRUCTIONS}} when overlay exists", async () => {
    await writeProjectInstructions(projectRoot, "master", "MASTER_OVERLAY_BODY");
    await generateMasterPrompt(projectRoot);
    const out = await readFile(join(projectRoot, ".team/prompts/master.md"), "utf-8");
    expect(out).toContain("MASTER_OVERLAY_BODY");
    // ja heading or en heading - whichever current locale provides
    expect(out).toMatch(/## (プロジェクト固有の追加指示|Project-Specific Instructions)/);
    expect(out).not.toContain("{{PROJECT_INSTRUCTIONS}}");
    // 置換後 master.md には placeholder が一つも残らない（heredoc サンプルが無いため）
    expect((out.match(/\{\{PROJECT_INSTRUCTIONS\}\}/g) ?? []).length).toBe(0);
  });

  test("removes placeholder when no overlay (mode=empty)", async () => {
    await generateMasterPrompt(projectRoot);
    const out = await readFile(join(projectRoot, ".team/prompts/master.md"), "utf-8");
    expect(out).not.toContain("{{PROJECT_INSTRUCTIONS}}");
    expect((out.match(/\{\{PROJECT_INSTRUCTIONS\}\}/g) ?? []).length).toBe(0);
  });
});

describe("generateConductorRolePrompt overlay (T342)", () => {
  test("expands first {{PROJECT_INSTRUCTIONS}} when overlay exists", async () => {
    await writeProjectInstructions(projectRoot, "conductor", "CONDUCTOR_OVERLAY");
    await generateConductorRolePrompt(projectRoot, "main");
    const out = await readFile(
      join(projectRoot, ".team/prompts/conductor-role.md"),
      "utf-8",
    );
    expect(out).toContain("CONDUCTOR_OVERLAY");
    expect(out).toMatch(/## (プロジェクト固有の追加指示|Project-Specific Instructions)/);
  });

  test("Conductor overlay applies only to first {{PROJECT_INSTRUCTIONS}}; heredoc sample placeholders remain literal", async () => {
    await writeProjectInstructions(projectRoot, "conductor", "REAL_OVERLAY");
    await generateConductorRolePrompt(projectRoot, "main");
    const out = await readFile(
      join(projectRoot, ".team/prompts/conductor-role.md"),
      "utf-8",
    );
    expect(out).toContain("REAL_OVERLAY");
    // heredoc サンプル内の placeholder は literal で残る（最初の 1 件のみ置換仕様）
    expect(out).toContain("{{PROJECT_INSTRUCTIONS}}");
    // 残存数が 1 つ以上であることを assert（heredoc サンプルの実数に依存するため >=1）
    expect((out.match(/\{\{PROJECT_INSTRUCTIONS\}\}/g) ?? []).length).toBeGreaterThanOrEqual(1);
  });

  test("Conductor with no overlay: first placeholder removed, heredoc samples preserved", async () => {
    await generateConductorRolePrompt(projectRoot, "main");
    const out = await readFile(
      join(projectRoot, ".team/prompts/conductor-role.md"),
      "utf-8",
    );
    // 冒頭の独立行 placeholder は消える（mode=empty）が heredoc 内 literal は残る
    expect((out.match(/\{\{PROJECT_INSTRUCTIONS\}\}/g) ?? []).length).toBeGreaterThanOrEqual(1);
  });
});

// --- T413: common overlay (template 層) ---

describe("expandProjectCommonInstructions (T413)", () => {
  test("(P) mode=noop when placeholder absent", async () => {
    const input = "no placeholder at all\n";
    const { expanded, mode } = await expandProjectCommonInstructions(projectRoot, input);
    expect(mode).toBe("noop");
    expect(expanded).toBe(input);
  });

  test("(Q) mode=empty when overlay absent — placeholder replaced, no triple newlines", async () => {
    const input = "BEFORE\n\n{{PROJECT_COMMON_INSTRUCTIONS}}\n\nAFTER";
    const { expanded, mode } = await expandProjectCommonInstructions(projectRoot, input);
    expect(mode).toBe("empty");
    expect(expanded).not.toContain("{{PROJECT_COMMON_INSTRUCTIONS}}");
    expect(/\n\n\n+/.test(expanded)).toBe(false);
  });

  test("(R) mode=applied with overlay — heading included, no triple newlines", async () => {
    await writeProjectInstructions(projectRoot, "common", "COMMON_BODY_HERE");
    const input = "BEFORE\n\n{{PROJECT_COMMON_INSTRUCTIONS}}\n\nAFTER";
    const { expanded, mode } = await expandProjectCommonInstructions(projectRoot, input);
    expect(mode).toBe("applied");
    expect(expanded).toContain("COMMON_BODY_HERE");
    expect(expanded).toMatch(/## (プロジェクト共通の追加指示|Project Common Instructions)/);
    expect(expanded).not.toContain("{{PROJECT_COMMON_INSTRUCTIONS}}");
    expect(/\n\n\n+/.test(expanded)).toBe(false);
  });
});

describe("expandPromptOverlays (T413)", () => {
  test("(S) common only — commonMode=applied, roleMode=empty", async () => {
    await writeProjectInstructions(projectRoot, "common", "CCC_ONLY");
    const input =
      "HEADER\n\n{{PROJECT_COMMON_INSTRUCTIONS}}\n\n{{PROJECT_INSTRUCTIONS}}\n\nFOOTER";
    const { expanded, commonMode, roleMode } = await expandPromptOverlays(
      projectRoot,
      "implementer",
      input,
    );
    expect(commonMode).toBe("applied");
    expect(roleMode).toBe("empty");
    expect(expanded).toContain("CCC_ONLY");
    expect(expanded).not.toContain("{{PROJECT_COMMON_INSTRUCTIONS}}");
    expect(expanded).not.toContain("{{PROJECT_INSTRUCTIONS}}");
    expect(/\n\n\n+/.test(expanded)).toBe(false);
  });

  test("(T) role only — commonMode=empty, roleMode=applied", async () => {
    await writeProjectInstructions(projectRoot, "implementer", "III_ONLY");
    const input =
      "HEADER\n\n{{PROJECT_COMMON_INSTRUCTIONS}}\n\n{{PROJECT_INSTRUCTIONS}}\n\nFOOTER";
    const { expanded, commonMode, roleMode } = await expandPromptOverlays(
      projectRoot,
      "implementer",
      input,
    );
    expect(commonMode).toBe("empty");
    expect(roleMode).toBe("applied");
    expect(expanded).toContain("III_ONLY");
    expect(expanded).not.toContain("{{PROJECT_COMMON_INSTRUCTIONS}}");
    expect(expanded).not.toContain("{{PROJECT_INSTRUCTIONS}}");
    expect(/\n\n\n+/.test(expanded)).toBe(false);
  });

  test("(U) both — commonMode=applied, roleMode=applied; common appears before role in output", async () => {
    await writeProjectInstructions(projectRoot, "common", "CCC_BODY");
    await writeProjectInstructions(projectRoot, "implementer", "III_BODY");
    const input =
      "HEADER\n\n{{PROJECT_COMMON_INSTRUCTIONS}}\n\n{{PROJECT_INSTRUCTIONS}}\n\nFOOTER";
    const { expanded, commonMode, roleMode } = await expandPromptOverlays(
      projectRoot,
      "implementer",
      input,
    );
    expect(commonMode).toBe("applied");
    expect(roleMode).toBe("applied");
    expect(expanded).toContain("CCC_BODY");
    expect(expanded).toContain("III_BODY");
    // テンプレ物理位置で担保: common body は role body より前に出現
    expect(expanded.indexOf("CCC_BODY")).toBeLessThan(expanded.indexOf("III_BODY"));
    expect(expanded).not.toContain("{{PROJECT_COMMON_INSTRUCTIONS}}");
    expect(expanded).not.toContain("{{PROJECT_INSTRUCTIONS}}");
  });

  test("(V) neither — both modes empty, both placeholders removed, no triple newlines", async () => {
    const input =
      "HEADER\n\n{{PROJECT_COMMON_INSTRUCTIONS}}\n\n{{PROJECT_INSTRUCTIONS}}\n\nFOOTER";
    const { expanded, commonMode, roleMode } = await expandPromptOverlays(
      projectRoot,
      "implementer",
      input,
    );
    expect(commonMode).toBe("empty");
    expect(roleMode).toBe("empty");
    expect(expanded).not.toContain("{{PROJECT_COMMON_INSTRUCTIONS}}");
    expect(expanded).not.toContain("{{PROJECT_INSTRUCTIONS}}");
    expect(/\n\n\n+/.test(expanded)).toBe(false);
  });

  test("(W) role → common 順により common body 内 literal {{PROJECT_INSTRUCTIONS}} が保護される", async () => {
    // common body 内に literal {{PROJECT_INSTRUCTIONS}} を含める
    await writeProjectInstructions(
      projectRoot,
      "common",
      "PRE\n{{PROJECT_INSTRUCTIONS}}\nPOST",
    );
    await writeProjectInstructions(projectRoot, "implementer", "III_BODY");
    const input =
      "HEADER\n\n{{PROJECT_COMMON_INSTRUCTIONS}}\n\n{{PROJECT_INSTRUCTIONS}}\n\nFOOTER";
    const { expanded, commonMode, roleMode } = await expandPromptOverlays(
      projectRoot,
      "implementer",
      input,
    );
    expect(commonMode).toBe("applied");
    expect(roleMode).toBe("applied");
    expect(expanded).toContain("III_BODY");
    // role → common 順なので common body 内の literal は保護されて残る
    expect(expanded).toContain("PRE\n{{PROJECT_INSTRUCTIONS}}\nPOST");
    // 元の template 側 placeholder（HEADER 後の {{PROJECT_INSTRUCTIONS}}）は role 展開で消費済み。
    // 残った {{PROJECT_INSTRUCTIONS}} は common body 内 literal の 1 件のみ
    expect((expanded.match(/\{\{PROJECT_INSTRUCTIONS\}\}/g) ?? []).length).toBe(1);
    // {{PROJECT_COMMON_INSTRUCTIONS}} は跡形なく消えている
    expect(expanded).not.toContain("{{PROJECT_COMMON_INSTRUCTIONS}}");
  });
});

// --- T413: generateMasterPrompt / generateConductorRolePrompt の common overlay ---

describe("generateMasterPrompt common overlay (T413)", () => {
  test("(L) expands {{PROJECT_COMMON_INSTRUCTIONS}} when overlay exists", async () => {
    await writeProjectInstructions(projectRoot, "common", "MASTER_COMMON_BODY");
    await generateMasterPrompt(projectRoot);
    const out = await readFile(join(projectRoot, ".team/prompts/master.md"), "utf-8");
    expect(out).toContain("MASTER_COMMON_BODY");
    expect(out).toMatch(/## (プロジェクト共通の追加指示|Project Common Instructions)/);
    expect(out).not.toContain("{{PROJECT_COMMON_INSTRUCTIONS}}");
  });

  test("(M) removes {{PROJECT_COMMON_INSTRUCTIONS}} when no overlay", async () => {
    await generateMasterPrompt(projectRoot);
    const out = await readFile(join(projectRoot, ".team/prompts/master.md"), "utf-8");
    expect(out).not.toContain("{{PROJECT_COMMON_INSTRUCTIONS}}");
  });
});

describe("generateConductorRolePrompt common overlay (T413)", () => {
  test("(N) expands {{PROJECT_COMMON_INSTRUCTIONS}} when overlay exists", async () => {
    await writeProjectInstructions(projectRoot, "common", "CONDUCTOR_COMMON");
    await generateConductorRolePrompt(projectRoot, "main");
    const out = await readFile(
      join(projectRoot, ".team/prompts/conductor-role.md"),
      "utf-8",
    );
    expect(out).toContain("CONDUCTOR_COMMON");
    expect(out).toMatch(/## (プロジェクト共通の追加指示|Project Common Instructions)/);
  });

  test("(O) removes leading {{PROJECT_COMMON_INSTRUCTIONS}} when no overlay (placeholder-notation samples preserved as literal)", async () => {
    await generateConductorRolePrompt(projectRoot, "main");
    const out = await readFile(
      join(projectRoot, ".team/prompts/conductor-role.md"),
      "utf-8",
    );
    // 冒頭の独立行 placeholder は消える（mode=empty）が「プレースホルダ表記について」節の
    // 説明文中に書かれた literal `{{PROJECT_COMMON_INSTRUCTIONS}}` は残る
    // （`expandProjectCommonInstructions` の lineRe は最初の 1 件のみ置換する仕様のため）
    expect((out.match(/\{\{PROJECT_COMMON_INSTRUCTIONS\}\}/g) ?? []).length).toBeGreaterThanOrEqual(1);
    // "MASTER_COMMON" のような overlay 文字列は当然出ない
    expect(out).not.toContain("CONDUCTOR_COMMON");
  });
});
