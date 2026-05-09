/**
 * cwd-mismatch integration test (task 446)
 *
 * process.chdir でペイン shell の cwd を project root から外した状態でも、
 * spawnMaster / launchConductor が `cd '<root>' && ...` 形式のコマンドを
 * 送信することを確認する。
 *
 * direnv 自体の再現は不要: cwd ずれが原因なので process.chdir で同等再現可能。
 */
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as cmux from "./cmux";
import { spawnMaster } from "./master";
import { launchConductor } from "./conductor";
import { createDummyProject, type DummyProject } from "./test-project";

let project: DummyProject;
let originalCwd: string;
let newSplitSpy: ReturnType<typeof spyOn>;
let sendSpy: ReturnType<typeof spyOn>;
let renameTabSpy: ReturnType<typeof spyOn>;

beforeEach(async () => {
  originalCwd = process.cwd();
  project = await createDummyProject({
    prefix: "cwd-mismatch-test-",
    subdirs: ["logs"],
  });

  newSplitSpy = spyOn(cmux, "newSplit").mockImplementation(async () => "surface:999");
  sendSpy = spyOn(cmux, "send").mockImplementation(async () => {});
  renameTabSpy = spyOn(cmux, "renameTab").mockImplementation(async () => {});
});

afterEach(async () => {
  // cwd を必ず元に戻す（他 test の汚染防止）
  process.chdir(originalCwd);
  newSplitSpy.mockRestore();
  sendSpy.mockRestore();
  renameTabSpy.mockRestore();
  await project.dispose();
});

describe("cwd が project root と異なる状態での spawn", () => {
  test("spawnMaster: ペイン shell の cwd が / でも projectRoot への cd prefix が付く", async () => {
    // cwd を / に変える（direnv で ~/git になるシナリオと同形）
    process.chdir("/tmp");

    const projectRoot = project.root;
    await spawnMaster(projectRoot);

    const launchCall = sendSpy.mock.calls[0]?.[1] as string;
    // cd '<projectRoot>' && cmux-team spawn-master\n の形式であること
    expect(launchCall).toMatch(/^cd '[^']+' && cmux-team spawn-master\n$/);
    expect(launchCall).toContain(`'${projectRoot}'`);
    // 現在の cwd (/tmp) が含まれていないこと
    expect(launchCall).not.toContain("/tmp");
  });

  test("launchConductor: ペイン shell の cwd が / でも projectRoot への cd prefix が付く", async () => {
    process.chdir("/tmp");

    const projectRoot = project.root;
    await launchConductor(projectRoot, "surface:100", { mainBranch: "main" });

    // cmux.send の 2 回目が launchCmd
    expect(sendSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    const launchCall = sendSpy.mock.calls[1]?.[1] as string;
    expect(launchCall).toMatch(/^cd '[^']+' && cmux-team spawn-conductor(\n|$)/);
    expect(launchCall).toContain(`'${projectRoot}'`);
    expect(launchCall).not.toContain("/tmp");
  });

  test("launchConductor resume 経路: --resume オプションも cd prefix 付きで送信される", async () => {
    process.chdir("/tmp");

    const projectRoot = project.root;
    const resumeSessionId = "test-session-abc";
    await launchConductor(projectRoot, "surface:100", {
      mainBranch: "main",
      resumeTaskId: "123",
      resumeSessionId,
    });

    const launchCall = sendSpy.mock.calls[1]?.[1] as string;
    expect(launchCall).toMatch(new RegExp(`^cd '${projectRoot.replace(/'/g, "'\\\\''")}' && cmux-team spawn-conductor --resume ${resumeSessionId}`));
  });
});
