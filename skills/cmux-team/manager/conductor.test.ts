/**
 * conductor.ts の assignTask エラー分類を検証する単体テスト。
 *
 * task kind のケース（タスクファイル不在 / git worktree add 失敗）は
 * cmux.send などのモック不要で再現できるため、ここに注力する。
 * conductor kind のケースはコードレビューで確認する方針。
 */
import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { writeFile } from "fs/promises";
import { join } from "path";
import { assignTask, AssignTaskError, createConductorPanes, resetConductor } from "./conductor";
import type { ConductorState } from "./schema";
import * as cmux from "./cmux";
import { createDummyProject, type DummyProject } from "./test-project";

let project: DummyProject;
let testDir: string;

beforeEach(async () => {
  project = await createDummyProject({
    prefix: "cmux-conductor-test-",
    subdirs: ["logs", "tasks"],
  });
  testDir = project.root;
});

afterEach(async () => {
  await project.dispose();
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
      await assignTask(conductor, "999", testDir, "main");
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
      await assignTask(conductor, "42", testDir, "main");
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
      await assignTask(conductor, "999", testDir, "main");
    } catch {
      // 期待通り throw
    }
    // .worktrees ディレクトリは作られていない
    const { existsSync } = await import("fs");
    expect(existsSync(join(testDir, ".worktrees"))).toBe(false);
  });
});

// --- T253: assignTask / launchConductor は mainBranch 空文字で throw する ---

describe("mainBranch required 化 (T253)", () => {
  test("assignTask は mainBranch が空文字なら throw する", async () => {
    const conductor = fakeConductor();
    await expect(
      assignTask(conductor, "999", testDir, ""),
    ).rejects.toThrow(/mainBranch must be a non-empty string/);
  });

  test("assignTask は mainBranch が空白のみなら throw する", async () => {
    const conductor = fakeConductor();
    await expect(
      assignTask(conductor, "999", testDir, "  \n"),
    ).rejects.toThrow(/mainBranch must be a non-empty string/);
  });

  test("launchConductor は opts.mainBranch が空文字なら throw する", async () => {
    const { launchConductor } = await import("./conductor");
    await expect(
      launchConductor(testDir, "surface:100", { mainBranch: "" }),
    ).rejects.toThrow(/mainBranch must be a non-empty string/);
  });

  test("launchConductor は opts.mainBranch が空白のみなら throw する", async () => {
    const { launchConductor } = await import("./conductor");
    await expect(
      launchConductor(testDir, "surface:100", { mainBranch: "  \n" }),
    ).rejects.toThrow(/mainBranch must be a non-empty string/);
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
    // NOTE (T343): ClaudeCodeBackend.reset() は cmux.send(raw) → cmux.sendKey(return) に分離。
    // /clear は \n 末尾を付けず raw text のみ送り、enter は send-key return が担う。
    expect(sendSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(sendSpy.mock.calls[0]?.[1]).toBe("/clear");
    // /clear の直後に return が send-key で送られていることを確認
    expect(sendKeySpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(sendKeySpy.mock.calls[0]?.[1]).toBe("return");
  }, 30000);
});

// --- T242: worktree base 解決 ---

describe("assignTask worktree base 解決 (T242)", () => {
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

  test("base_branch: 未指定 + local main 存在 → worktree が main 基点で作成される", async () => {
    const { execFile: execFileCb } = await import("child_process");
    const { promisify } = await import("util");
    const execFile = promisify(execFileCb);

    // git init + main に 2 commits、dev branch に 1 commit 進める
    await execFile("git", ["init", "-q", "-b", "main"], { cwd: testDir });
    const gitEnv = ["-c", "user.email=t@t", "-c", "user.name=t"];
    await execFile("git", [...gitEnv, "commit", "--allow-empty", "-q", "-m", "main-1"], { cwd: testDir });
    await execFile("git", [...gitEnv, "commit", "--allow-empty", "-q", "-m", "main-2"], { cwd: testDir });
    const { stdout: mainHead } = await execFile("git", ["rev-parse", "HEAD"], { cwd: testDir });
    // 別ブランチ dev を作成し HEAD を進める（検出時は main と異なる）
    await execFile("git", ["checkout", "-q", "-b", "dev"], { cwd: testDir });
    await execFile("git", [...gitEnv, "commit", "--allow-empty", "-q", "-m", "dev-1"], { cwd: testDir });

    await writeTaskFile("242", "wt-base-test");

    const conductor = fakeConductor();
    // mainBranch="main" を渡すが、base_branch: は task.md で未指定
    const updated = await assignTask(conductor, "242", testDir, "main");

    // worktree の HEAD が main と一致することを確認
    const worktreePath = updated.worktreePath!;
    const { stdout: wtHead } = await execFile("git", ["rev-parse", "HEAD"], { cwd: worktreePath });
    expect(wtHead.trim()).toBe(mainHead.trim());
  }, 30000);
});

// --- T243: assignTask が base_branch/base_sha/base_source を trace DB に書き込む ---

describe("assignTask: base_* persistence (T243)", () => {
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

  test("local main 経由で worktree を作ると base_branch=main / base_source=config-local / base_sha=40hex が記録される", async () => {
    const { execFile: execFileCb } = await import("child_process");
    const { promisify } = await import("util");
    const execFile = promisify(execFileCb);

    // git init + main 1 commit（origin remote なし → config-local パスに倒れる）
    await execFile("git", ["init", "-q", "-b", "main"], { cwd: testDir });
    const gitEnv = ["-c", "user.email=t@t", "-c", "user.name=t"];
    await execFile("git", [...gitEnv, "commit", "--allow-empty", "-q", "-m", "init"], { cwd: testDir });
    const { stdout: mainHead } = await execFile("git", ["rev-parse", "HEAD"], { cwd: testDir });
    const expectedSha = mainHead.trim();

    await writeTaskFile("243", "base-persistence-test");

    const conductor = fakeConductor();
    const updated = await assignTask(conductor, "243", testDir, "main");

    // trace DB から assigned 行を読み出す
    const { Database } = await import("bun:sqlite");
    const db = new Database(join(testDir, ".team/traces/traces.db"));
    try {
      const row = db
        .prepare(
          `SELECT base_branch, base_sha, base_source, task_run_id
           FROM task_sessions WHERE task_id = ? AND event = 'assigned'`,
        )
        .get("243") as {
          base_branch: string | null;
          base_sha: string | null;
          base_source: string | null;
          task_run_id: string | null;
        };
      expect(row).toBeTruthy();
      expect(row.task_run_id).toBe(updated.taskRunId!);
      expect(row.base_branch).toBe("main");
      expect(row.base_source).toBe("config-local");
      expect(row.base_sha).toMatch(/^[0-9a-f]{40}$/);
      expect(row.base_sha).toBe(expectedSha);
    } finally {
      db.close();
    }
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

// --- T250: resetConductor opts テスト ---
describe("resetConductor targetStatus オプション (T250)", () => {
  // cmux 外部コマンドをモックする（listSiblingSurfaces は空配列を返し、closeSurface は何もしない）
  let listSiblingsSpy: ReturnType<typeof spyOn>;
  let closeSurfaceSpy: ReturnType<typeof spyOn>;
  // T251: resetConductor 冒頭で getPaneForSurface を呼ぶため「surface 存在」をモックする
  let getPaneForSurfaceSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    listSiblingsSpy = spyOn(cmux, "listSiblingSurfaces").mockResolvedValue([]);
    closeSurfaceSpy = spyOn(cmux, "closeSurface").mockResolvedValue(undefined as any);
    getPaneForSurfaceSpy = spyOn(cmux, "getPaneForSurface").mockResolvedValue("pane:1");
  });

  afterEach(() => {
    listSiblingsSpy.mockRestore();
    closeSurfaceSpy.mockRestore();
    getPaneForSurfaceSpy.mockRestore();
  });

  test("opts 未指定ならデフォルトで idle に戻し disconnectedAt をクリアする", async () => {
    const conductor: ConductorState = {
      surface: "surface:reset-default",
      startedAt: new Date().toISOString(),
      disconnectedAt: "2026-04-18T10:00:00.000Z",
      taskRunId: "task-010-xxx",
      taskId: "10",
      taskTitle: "x",
      agents: [],
      status: "disconnected",
    };

    await resetConductor(conductor, testDir);

    expect(conductor.status).toBe("idle");
    expect(conductor.disconnectedAt).toBeUndefined();
    expect(conductor.taskRunId).toBeUndefined();
    expect(conductor.taskId).toBeUndefined();
    expect(conductor.agents).toEqual([]);
  });

  test("opts.targetStatus='broken' なら broken に遷移し disconnectedAt を保持する", async () => {
    const preservedDisconnectedAt = "2026-04-18T10:00:00.000Z";
    const conductor: ConductorState = {
      surface: "surface:reset-broken",
      startedAt: new Date().toISOString(),
      disconnectedAt: preservedDisconnectedAt,
      taskRunId: "task-020-xxx",
      taskId: "20",
      taskTitle: "y",
      agents: [],
      status: "disconnected",
    };

    await resetConductor(conductor, testDir, undefined, {
      targetStatus: "broken",
      reason: "disconnect_timeout",
    });

    expect(conductor.status).toBe("broken");
    // broken は UI 経過時間表示のため disconnectedAt を保持する
    expect(conductor.disconnectedAt).toBe(preservedDisconnectedAt);
    // それ以外のフィールドは cleanup される
    expect(conductor.taskRunId).toBeUndefined();
    expect(conductor.taskId).toBeUndefined();
    expect(conductor.agents).toEqual([]);
  });

  test("opts.targetStatus='idle' 明示指定でも disconnectedAt がクリアされる", async () => {
    const conductor: ConductorState = {
      surface: "surface:reset-idle-explicit",
      startedAt: new Date().toISOString(),
      disconnectedAt: "2026-04-18T10:00:00.000Z",
      taskRunId: "task-030-xxx",
      taskId: "30",
      agents: [],
      status: "broken",
    };

    await resetConductor(conductor, testDir, undefined, {
      targetStatus: "idle",
      reason: "cleared",
    });

    expect(conductor.status).toBe("idle");
    expect(conductor.disconnectedAt).toBeUndefined();
    expect(conductor.taskRunId).toBeUndefined();
  });

  // T265: assigningSetAt も T261 系 runtime-only snapshot フィールドと同様に
  // resetConductor で必ず undefined に戻す。stale 値で次の割当サイクルの判定を汚染しない。
  test("resetConductor → conductor.assigningSetAt が undefined にクリアされる", async () => {
    const conductor: ConductorState = {
      surface: "surface:265r",
      startedAt: "2026-04-19T09:00:00.000Z",
      agents: [],
      status: "running",
      taskRunId: "task-265-r",
      taskId: "265r",
      assigningSetAt: "2026-04-19T10:00:00.000Z",
    };

    await resetConductor(conductor, testDir, undefined, { targetStatus: "idle" });

    expect(conductor.assigningSetAt).toBeUndefined();
  });
});

// --- T251: resetConductor surface 実在確認 ---
describe("resetConductor surface 実在確認 (T251)", () => {
  // surface 実在確認 (getPaneForSurface) の返り値をケース毎に切り替える。
  // listSiblingSurfaces / closeSurface は副作用を抑制するため空配列 / no-op でモックする。
  let listSiblingsSpy: ReturnType<typeof spyOn>;
  let closeSurfaceSpy: ReturnType<typeof spyOn>;
  let getPaneForSurfaceSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    listSiblingsSpy = spyOn(cmux, "listSiblingSurfaces").mockResolvedValue([]);
    closeSurfaceSpy = spyOn(cmux, "closeSurface").mockResolvedValue(undefined as any);
    // デフォルトで surface 不在 (undefined) — 各テストが必要に応じて上書きする
    getPaneForSurfaceSpy = spyOn(cmux, "getPaneForSurface").mockResolvedValue(undefined);
  });

  afterEach(() => {
    listSiblingsSpy.mockRestore();
    closeSurfaceSpy.mockRestore();
    getPaneForSurfaceSpy.mockRestore();
  });

  test("surface 不在 + targetStatus 省略 (idle 要求) なら broken に倒す", async () => {
    const conductor: ConductorState = {
      surface: "surface:ghost-1",
      startedAt: new Date().toISOString(),
      taskRunId: "task-100-xxx",
      taskId: "100",
      agents: [],
      status: "idle",
    };

    await resetConductor(conductor, testDir);

    // surface が tree に存在しない → idle 要求でも broken に倒れる
    expect(conductor.status).toBe("broken");
    // cleanup 自体は実行されるため taskRunId 等はクリアされる
    expect(conductor.taskRunId).toBeUndefined();
    expect(conductor.taskId).toBeUndefined();
  });

  test("surface 不在 + targetStatus='broken' 明示指定なら broken のまま disconnectedAt を保持", async () => {
    const preservedDisconnectedAt = "2026-04-18T10:00:00.000Z";
    const conductor: ConductorState = {
      surface: "surface:ghost-2",
      startedAt: new Date().toISOString(),
      disconnectedAt: preservedDisconnectedAt,
      taskRunId: "task-200-xxx",
      taskId: "200",
      agents: [],
      status: "disconnected",
    };

    await resetConductor(conductor, testDir, undefined, {
      targetStatus: "broken",
      reason: "disconnect_timeout",
    });

    expect(conductor.status).toBe("broken");
    // broken 経路では disconnectedAt を保持する既存ロジックに従う
    expect(conductor.disconnectedAt).toBe(preservedDisconnectedAt);
    expect(conductor.taskRunId).toBeUndefined();
  });

  test("surface 存在 + targetStatus 省略なら従来通り idle に戻り disconnectedAt がクリアされる", async () => {
    // surface が pane に存在するケース
    getPaneForSurfaceSpy.mockResolvedValue("pane:42");

    const conductor: ConductorState = {
      surface: "surface:alive-1",
      startedAt: new Date().toISOString(),
      disconnectedAt: "2026-04-18T10:00:00.000Z",
      taskRunId: "task-300-xxx",
      taskId: "300",
      agents: [],
      status: "disconnected",
    };

    await resetConductor(conductor, testDir);

    // surface が存在するので従来通り idle 経路
    expect(conductor.status).toBe("idle");
    expect(conductor.disconnectedAt).toBeUndefined();
    expect(conductor.taskRunId).toBeUndefined();
  });
});

// --- T260: conductor_broken pid/alive 併記 ---
describe("T260: conductor_broken ログに pid/alive を併記する", () => {
  let listSiblingsSpy: ReturnType<typeof spyOn>;
  let closeSurfaceSpy: ReturnType<typeof spyOn>;
  let isAliveSpy: ReturnType<typeof spyOn>;
  let getPaneForSurfaceSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    listSiblingsSpy = spyOn(cmux, "listSiblingSurfaces").mockResolvedValue([]);
    closeSurfaceSpy = spyOn(cmux, "closeSurface").mockResolvedValue(undefined as any);
    isAliveSpy = spyOn(cmux, "isAlive");
    // デフォルトで surface 存在扱い — broken テストは targetStatus 明示なので影響なし
    getPaneForSurfaceSpy = spyOn(cmux, "getPaneForSurface").mockResolvedValue("pane:42" as any);
  });

  afterEach(() => {
    listSiblingsSpy.mockRestore();
    closeSurfaceSpy.mockRestore();
    isAliveSpy.mockRestore();
    getPaneForSurfaceSpy.mockRestore();
  });

  test("broken 化時は pid=X alive=<bool> が出力される", async () => {
    isAliveSpy.mockReturnValue(true);
    const conductor: ConductorState = {
      surface: "surface:broken-alive",
      startedAt: new Date().toISOString(),
      agents: [],
      status: "disconnected",
      disconnectedAt: "2026-04-18T10:00:00.000Z",
      pid: 98765,
    };
    await resetConductor(conductor, testDir, undefined, {
      targetStatus: "broken",
      reason: "disconnect_timeout",
    });
    const { readFile } = await import("fs/promises");
    const log = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
    expect(log).toMatch(/conductor_broken C\[broken-alive\] reason=disconnect_timeout pid=98765 alive=true/);
  });

  test("pid 未定義の broken 化では pid=null alive=unknown を明示出力する", async () => {
    const conductor: ConductorState = {
      surface: "surface:broken-no-pid",
      startedAt: new Date().toISOString(),
      agents: [],
      status: "disconnected",
      disconnectedAt: "2026-04-18T10:00:00.000Z",
    };
    await resetConductor(conductor, testDir, undefined, {
      targetStatus: "broken",
      reason: "disconnect_timeout",
    });
    const { readFile } = await import("fs/promises");
    const log = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
    expect(log).toMatch(/conductor_broken C\[broken-no-pid\] reason=disconnect_timeout pid=null alive=unknown/);
  });

  test("idle reset 経路では pid=/alive= を出さない（negative test）", async () => {
    isAliveSpy.mockReturnValue(true);
    const conductor: ConductorState = {
      surface: "surface:reset-idle-no-pid-log",
      startedAt: new Date().toISOString(),
      disconnectedAt: "2026-04-18T10:00:00.000Z",
      agents: [],
      status: "disconnected",
      pid: 11111,
    };
    await resetConductor(conductor, testDir, undefined, { targetStatus: "idle" });
    const { readFile } = await import("fs/promises");
    const log = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
    const resetLine = log.split("\n").find((l) => l.includes("conductor_reset"));
    expect(resetLine).toBeDefined();
    expect(resetLine).not.toMatch(/pid=/);
    expect(resetLine).not.toMatch(/alive=/);
  });
});

// --- T261: assignTask が clear/prompt 送信時刻と bytes を記録 ---

describe("assignTask snapshot フィールド記録 (T261)", () => {
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

  async function gitInitWithMain(): Promise<void> {
    const { execFile: execFileCb } = await import("child_process");
    const { promisify } = await import("util");
    const execFile = promisify(execFileCb);
    await execFile("git", ["init", "-q", "-b", "main"], { cwd: testDir });
    await execFile(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "init"],
      { cwd: testDir },
    );
  }

  test("assignTask 成功 → clear_sent + assigning_window_open + assign_prompt_sent が順序通りログされる", async () => {
    await gitInitWithMain();
    await writeTaskFile("261", "snap-order");

    const conductor = fakeConductor();
    await assignTask(conductor, "261", testDir, "main");

    const { readFile } = await import("fs/promises");
    const log = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
    const lines = log.split("\n");
    const clearSentIdx = lines.findIndex((l) => l.includes("clear_sent ") && l.includes("source=daemon_assign"));
    const openIdx = lines.findIndex((l) => l.includes("assigning_window_open "));
    const promptSentIdx = lines.findIndex((l) => l.includes("assign_prompt_sent "));

    expect(clearSentIdx).toBeGreaterThanOrEqual(0);
    expect(openIdx).toBeGreaterThanOrEqual(0);
    expect(promptSentIdx).toBeGreaterThanOrEqual(0);

    // 順序: clear_sent → assigning_window_open → assign_prompt_sent
    expect(clearSentIdx).toBeLessThan(openIdx);
    expect(openIdx).toBeLessThan(promptSentIdx);

    expect(lines[clearSentIdx]).toMatch(/taskRunId=task-261-\d+/);
    expect(lines[promptSentIdx]).toMatch(/task_id=261/);
    expect(lines[promptSentIdx]).toMatch(/bytes=\d+/);
    expect(lines[promptSentIdx]).toMatch(/prompt_file=/);
  }, 30000);

  test("assignTask 成功 → conductor.clearSentAt / promptSentAt / promptBytes が set される", async () => {
    await gitInitWithMain();
    await writeTaskFile("262", "snap-fields");

    const conductor = fakeConductor();
    await assignTask(conductor, "262", testDir, "main");

    expect(conductor.clearSentAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(conductor.promptSentAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof conductor.promptBytes).toBe("number");
    expect(conductor.promptBytes ?? 0).toBeGreaterThan(0);

    // clearSentAt <= promptSentAt (順序性)
    expect(new Date(conductor.clearSentAt!).getTime()).toBeLessThanOrEqual(
      new Date(conductor.promptSentAt!).getTime(),
    );
  }, 30000);

  // T265: assigningSetAt は assignTask が status="assigning" にセットした時刻を記録する。
  // formatUserClearDecision の assigning_set_at が参照する値で、startedAt（プロセス起動時刻）
  // とは別物。
  test("assignTask 成功 → conductor.assigningSetAt が set され clearSentAt より前", async () => {
    await gitInitWithMain();
    await writeTaskFile("265", "assigning-set-at");

    const conductor = fakeConductor();
    await assignTask(conductor, "265", testDir, "main");

    expect(conductor.assigningSetAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(new Date(conductor.assigningSetAt!).getTime()).toBeLessThanOrEqual(
      new Date(conductor.clearSentAt!).getTime(),
    );
  }, 30000);
});

// --- T263: resetConductor preserveWorktree オプション ---
//
// CONDUCTOR_DONE --success=false 経路で rebase 衝突など「人間判断待ち」状態を
// 表現するため、worktree/branch を温存しつつ ConductorState はリセットする。
//
// 検証戦略: 実 git repo + worktree を作って fs 上で残存/削除を観察する。
// `execFile` の spy は promisify 済みで技術的に困難なため、observable な
// fs 副作用（worktree dir / branch 存在）で検証する（Design Review Finding 5 の
// 意図「既存 listSiblingsSpy / closeSurfaceSpy パターンと整合的」に沿う範囲で）。
describe("resetConductor preserveWorktree オプション (T263)", () => {
  let listSiblingsSpy: ReturnType<typeof spyOn>;
  let closeSurfaceSpy: ReturnType<typeof spyOn>;
  let getPaneForSurfaceSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    listSiblingsSpy = spyOn(cmux, "listSiblingSurfaces").mockResolvedValue([]);
    closeSurfaceSpy = spyOn(cmux, "closeSurface").mockResolvedValue(undefined as any);
    getPaneForSurfaceSpy = spyOn(cmux, "getPaneForSurface").mockResolvedValue("pane:1");
  });

  afterEach(() => {
    listSiblingsSpy.mockRestore();
    closeSurfaceSpy.mockRestore();
    getPaneForSurfaceSpy.mockRestore();
  });

  // 実 git repo をセットアップし worktree を作る共通ヘルパー
  async function setupGitWithWorktree(taskRunId: string): Promise<{ worktreePath: string; branch: string }> {
    const { execFile: execFileCb } = await import("child_process");
    const { promisify } = await import("util");
    const execFile = promisify(execFileCb);
    await execFile("git", ["init", "-q", "-b", "main"], { cwd: testDir });
    await execFile("git", ["config", "user.email", "test@test.local"], { cwd: testDir });
    await execFile("git", ["config", "user.name", "Test"], { cwd: testDir });
    await writeFile(join(testDir, "README.md"), "test");
    await execFile("git", ["add", "."], { cwd: testDir });
    await execFile("git", ["commit", "-q", "-m", "init"], { cwd: testDir });
    const worktreePath = join(testDir, ".worktrees", taskRunId);
    const branch = `${taskRunId}/task`;
    await execFile("git", ["worktree", "add", worktreePath, "-b", branch], { cwd: testDir });
    return { worktreePath, branch };
  }

  async function branchExists(branch: string): Promise<boolean> {
    const { execFile: execFileCb } = await import("child_process");
    const { promisify } = await import("util");
    const execFile = promisify(execFileCb);
    try {
      await execFile("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: testDir });
      return true;
    } catch {
      return false;
    }
  }

  test("Case A: preserveWorktree=true → worktree/branch が残り ConductorState はリセットされる", async () => {
    const taskRunId = "task-263a-1700000000";
    const { worktreePath, branch } = await setupGitWithWorktree(taskRunId);

    const conductor: ConductorState = {
      surface: "surface:t263-a",
      startedAt: new Date().toISOString(),
      taskRunId,
      taskId: "263",
      taskTitle: "preserve test A",
      worktreePath,
      agents: [],
      status: "running",
    };

    await resetConductor(conductor, testDir, undefined, { preserveWorktree: true });

    // worktree dir は残っている
    const { existsSync } = await import("fs");
    expect(existsSync(worktreePath)).toBe(true);
    // branch も残っている
    expect(await branchExists(branch)).toBe(true);
    // ConductorState は完全リセット
    expect(conductor.status).toBe("idle");
    expect(conductor.taskRunId).toBeUndefined();
    expect(conductor.taskId).toBeUndefined();
    expect(conductor.taskTitle).toBeUndefined();
    expect(conductor.worktreePath).toBeUndefined();
    expect(conductor.agents).toEqual([]);
    // ログに worktree_preserved=true suffix
    const { readFile } = await import("fs/promises");
    const log = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
    const resetLine = log.split("\n").find((l) => l.includes("conductor_reset"));
    expect(resetLine).toBeDefined();
    expect(resetLine).toContain("worktree_preserved=true");
  }, 30000);

  test("Case B: preserveWorktree=false 明示 → worktree/branch が削除される", async () => {
    const taskRunId = "task-263b-1700000001";
    const { worktreePath, branch } = await setupGitWithWorktree(taskRunId);

    const conductor: ConductorState = {
      surface: "surface:t263-b",
      startedAt: new Date().toISOString(),
      taskRunId,
      taskId: "263",
      worktreePath,
      agents: [],
      status: "running",
    };

    await resetConductor(conductor, testDir, undefined, { preserveWorktree: false });

    const { existsSync } = await import("fs");
    expect(existsSync(worktreePath)).toBe(false);
    expect(await branchExists(branch)).toBe(false);
    expect(conductor.status).toBe("idle");
    expect(conductor.taskRunId).toBeUndefined();
    // ログに worktree_preserved=true は含まれない
    const { readFile } = await import("fs/promises");
    const log = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
    const resetLine = log.split("\n").find((l) => l.includes("conductor_reset"));
    expect(resetLine).toBeDefined();
    expect(resetLine).not.toContain("worktree_preserved=true");
  }, 30000);

  test("Case C: preserveWorktree 未指定 → 従来通り worktree/branch 削除（後方互換）", async () => {
    const taskRunId = "task-263c-1700000002";
    const { worktreePath, branch } = await setupGitWithWorktree(taskRunId);

    const conductor: ConductorState = {
      surface: "surface:t263-c",
      startedAt: new Date().toISOString(),
      taskRunId,
      taskId: "263",
      worktreePath,
      agents: [],
      status: "running",
    };

    // opts なしで呼ぶ（後方互換経路）
    await resetConductor(conductor, testDir);

    const { existsSync } = await import("fs");
    expect(existsSync(worktreePath)).toBe(false);
    expect(await branchExists(branch)).toBe(false);
    expect(conductor.status).toBe("idle");
    // ログに worktree_preserved=true は含まれない
    const { readFile } = await import("fs/promises");
    const log = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
    const resetLine = log.split("\n").find((l) => l.includes("conductor_reset"));
    expect(resetLine).toBeDefined();
    expect(resetLine).not.toContain("worktree_preserved=true");
  }, 30000);

  test("Case D: preserveWorktree=true && targetStatus='broken' → worktree 残り broken 状態", async () => {
    const taskRunId = "task-263d-1700000003";
    const { worktreePath, branch } = await setupGitWithWorktree(taskRunId);

    const conductor: ConductorState = {
      surface: "surface:t263-d",
      startedAt: new Date().toISOString(),
      disconnectedAt: "2026-04-18T10:00:00.000Z",
      taskRunId,
      taskId: "263",
      worktreePath,
      agents: [],
      status: "disconnected",
      pid: 99999,
    };

    await resetConductor(conductor, testDir, undefined, {
      preserveWorktree: true,
      targetStatus: "broken",
      reason: "manual_preserve",
    });

    // worktree/branch は残る
    const { existsSync } = await import("fs");
    expect(existsSync(worktreePath)).toBe(true);
    expect(await branchExists(branch)).toBe(true);
    // state は broken（disconnectedAt 保持）
    expect(conductor.status).toBe("broken");
    expect(conductor.disconnectedAt).toBe("2026-04-18T10:00:00.000Z");
    expect(conductor.taskRunId).toBeUndefined();
    // ログは conductor_broken かつ worktree_preserved=true を含む
    const { readFile } = await import("fs/promises");
    const log = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
    const brokenLine = log.split("\n").find((l) => l.includes("conductor_broken"));
    expect(brokenLine).toBeDefined();
    expect(brokenLine).toContain("worktree_preserved=true");
    expect(brokenLine).toContain("reason=manual_preserve");
  }, 30000);
});
