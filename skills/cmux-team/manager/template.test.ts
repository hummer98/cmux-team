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
import { generateConductorRolePrompt, generateMasterPrompt } from "./template";
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
