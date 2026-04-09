/**
 * conductor.ts の assignTask エラー分類を検証する単体テスト。
 *
 * task kind のケース（タスクファイル不在 / git worktree add 失敗）は
 * cmux.send などのモック不要で再現できるため、ここに注力する。
 * conductor kind のケースはコードレビューで確認する方針。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { assignTask, AssignTaskError } from "./conductor";
import type { ConductorState } from "./schema";

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), "cmux-conductor-test-"));
  // .team/tasks は assignTask が readdir するので作っておく
  await mkdir(join(testDir, ".team/tasks"), { recursive: true });
  await mkdir(join(testDir, ".team/logs"), { recursive: true });
  process.env.PROJECT_ROOT = testDir;
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
  delete process.env.PROJECT_ROOT;
});

function fakeConductor(): ConductorState {
  return {
    surface: "surface:fake-test",
    startedAt: new Date().toISOString(),
    agents: [],
    status: "idle",
  };
}

async function writeTaskFile(id: string, title: string): Promise<void> {
  const content = `---
id: ${id}
title: ${title}
status: ready
priority: medium
created_at: ${new Date().toISOString()}
---

## タスク
テスト用タスク
`;
  await writeFile(
    join(testDir, `.team/tasks/${id.padStart(3, "0")}-${title}.md`),
    content
  );
}

describe("assignTask エラー分類", () => {
  test("タスクファイル不在は task kind でエラーを throw する", async () => {
    const conductor = fakeConductor();
    try {
      await assignTask(conductor, "999", testDir);
      throw new Error("expected assignTask to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AssignTaskError);
      expect((e as AssignTaskError).kind).toBe("task");
      expect((e as AssignTaskError).reason).toContain("task file not found");
    }
    // Conductor の status は変更されない
    expect(conductor.status).toBe("idle");
    expect(conductor.taskId).toBeUndefined();
  });

  test("git 未初期化 (worktree add 失敗) は task kind でエラーを throw する", async () => {
    // testDir は git init していない → git worktree add が失敗する
    await writeTaskFile("42", "sample");

    const conductor = fakeConductor();
    try {
      await assignTask(conductor, "42", testDir);
      throw new Error("expected assignTask to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(AssignTaskError);
      expect((e as AssignTaskError).kind).toBe("task");
      expect((e as AssignTaskError).reason).toContain("git worktree add");
    }
    // Conductor の status は変更されない (idle のまま維持される)
    expect(conductor.status).toBe("idle");
    expect(conductor.taskId).toBeUndefined();
  });

  test("タスクファイル不在ケースでは worktree を作成しない", async () => {
    const conductor = fakeConductor();
    try {
      await assignTask(conductor, "999", testDir);
    } catch {
      // 期待通り throw
    }
    // .worktrees ディレクトリは作られていない
    const { existsSync } = await import("fs");
    expect(existsSync(join(testDir, ".worktrees"))).toBe(false);
  });
});
