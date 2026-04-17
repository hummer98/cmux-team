/**
 * conductor.ts の assignTask エラー分類を検証する単体テスト。
 *
 * task kind のケース（タスクファイル不在 / git worktree add 失敗）は
 * cmux.send などのモック不要で再現できるため、ここに注力する。
 * conductor kind のケースはコードレビューで確認する方針。
 */
import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { assignTask, AssignTaskError, createConductorPanes } from "./conductor";
import type { ConductorState } from "./schema";
import * as cmux from "./cmux";

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

// --- T232: assignTask 成功パスで status が "assigning" になること ---

describe("assignTask 状態遷移 (T232)", () => {
  let sendSpy: ReturnType<typeof spyOn>;
  let sendKeySpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    sendSpy = spyOn(cmux, "send").mockImplementation(async () => {});
    sendKeySpy = spyOn(cmux, "sendKey").mockImplementation(async () => {});
  });

  afterEach(() => {
    sendSpy.mockRestore();
    sendKeySpy.mockRestore();
  });

  test("assignTask 成功後に conductor.status === 'assigning'（running ではない）", async () => {
    // git init + 初期コミットでワーキングツリーを作る（worktree add が通るため）
    const { execFile: execFileCb } = await import("child_process");
    const { promisify } = await import("util");
    const execFile = promisify(execFileCb);
    await execFile("git", ["init", "-q", "-b", "main"], { cwd: testDir });
    await execFile("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "init"], { cwd: testDir });

    await writeTaskFile("232", "assigning-test");

    const conductor = fakeConductor();
    const updated = await assignTask(conductor, "232", testDir, "main");

    // Decision Log D5: running への即時遷移は削除され、assigning のまま
    expect(updated.status).toBe("assigning");
    expect(conductor.status).toBe("assigning");

    // タスク情報は埋まっている（SESSION_STARTED で running に遷移する前提）
    expect(updated.taskId).toBe("232");
    expect(updated.taskRunId).toMatch(/^task-232-/);
    expect(updated.worktreePath).toContain(".worktrees");

    // cmux.send が /clear と新プロンプト送信の 2 回呼ばれたこと
    expect(sendSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(sendSpy.mock.calls[0]?.[1]).toBe("/clear");
  }, 30000);
});

// --- T176: createConductorPanes layout 分岐 ---

describe("createConductorPanes layout 分岐 (T176)", () => {
  // cmux.newSplit を spyOn で差し替える。
  // test.concurrent は副作用を引き起こすため使用しない。
  //
  // T207: createConductorPanes は内部で cmux.tree を呼ばなくなったため
  // treeSpy は不要になった。戻り値型も `string[]` に変更された。
  let newSplitSpy: ReturnType<typeof spyOn>;
  let surfaceCounter: number;

  beforeEach(() => {
    surfaceCounter = 100;
    newSplitSpy = spyOn(cmux, "newSplit").mockImplementation(
      async (_direction: any, _opts?: any) => {
        return `surface:${++surfaceCounter}`;
      },
    );
  });

  afterEach(() => {
    newSplitSpy.mockRestore();
  });

  test("layout=wide, count=3 → newSplit の呼び出し順は (right, daemon) → (down, daemon) → (down, c1)", async () => {
    const panes = await createConductorPanes(3, "surface:1", "wide");
    expect(panes).toHaveLength(3);
    expect(newSplitSpy.mock.calls.length).toBe(3);

    const [c1Dir, c1Opts] = newSplitSpy.mock.calls[0];
    expect(c1Dir).toBe("right");
    expect(c1Opts).toEqual({ surface: "surface:1" });

    const [c2Dir, c2Opts] = newSplitSpy.mock.calls[1];
    expect(c2Dir).toBe("down");
    expect(c2Opts).toEqual({ surface: "surface:1" });

    const [c3Dir, c3Opts] = newSplitSpy.mock.calls[2];
    expect(c3Dir).toBe("down");
    // c1 pane を split（= 最初に作った surface を引数に取る）
    expect((c3Opts as { surface: string }).surface).toBe(panes[0]!);
  });

  test("layout=16x9, count=2 → newSplit の呼び出し順は (down, daemon) → (right, c1)", async () => {
    const panes = await createConductorPanes(2, "surface:1", "16x9");
    expect(panes).toHaveLength(2);
    expect(newSplitSpy.mock.calls.length).toBe(2);

    const [c1Dir, c1Opts] = newSplitSpy.mock.calls[0];
    expect(c1Dir).toBe("down");
    expect(c1Opts).toEqual({ surface: "surface:1" });

    const [c2Dir, c2Opts] = newSplitSpy.mock.calls[1];
    expect(c2Dir).toBe("right");
    // C1 pane を split（最初に作った surface）
    expect((c2Opts as { surface: string }).surface).toBe(panes[0]!);
  });

  test("layout=16x9, count=1 → 下段は 1 個のみ（right split なし）", async () => {
    const panes = await createConductorPanes(1, "surface:1", "16x9");
    expect(panes).toHaveLength(1);
    expect(newSplitSpy.mock.calls.length).toBe(1);
    expect(newSplitSpy.mock.calls[0][0]).toBe("down");
  });

  test("layout=16x9, count=3 は 2 に clamp される（R1 ガード）", async () => {
    const panes = await createConductorPanes(3, "surface:1", "16x9");
    // 3 つ目の pane は作られない
    expect(panes).toHaveLength(2);
    expect(newSplitSpy.mock.calls.length).toBe(2);
  });

  test("layout 省略時は wide と同じ挙動（後方互換）", async () => {
    const panes = await createConductorPanes(3, "surface:1");
    expect(panes).toHaveLength(3);
    expect(newSplitSpy.mock.calls[0][0]).toBe("right");
    expect(newSplitSpy.mock.calls[1][0]).toBe("down");
    expect(newSplitSpy.mock.calls[2][0]).toBe("down");
  });
});
