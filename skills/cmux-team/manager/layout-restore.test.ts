/**
 * planLayoutRestore (T255) — pure function 単体テスト。
 *
 * マトリクス分類 (A〜E) と tree degrade、unmatched resume の集約を検証する。
 * 副作用検証 (cleanup / resume 起動 / state mutation) は daemon.test.ts 側の
 * initializeLayout 統合テスト (M6〜M16) でカバーする。
 */
import { describe, test, expect } from "bun:test";
import { planLayoutRestore } from "./layout-restore";
import type { ResumePlanItem } from "./conductor";

const ALL_ALIVE = (_pid: number) => true;
const ALL_DEAD = (_pid: number) => false;
const aliveOf = (...alivePids: number[]) => {
  const set = new Set(alivePids);
  return (pid: number) => set.has(pid);
};

const resume = (taskId: string, surfaceHint = ""): ResumePlanItem => ({
  taskId,
  taskRunId: `task-${taskId}-1700000000`,
  worktreePath: `/tmp/wt/${taskId}${surfaceHint}`,
  sessionId: `sess-${taskId}`,
  taskTitle: `t-${taskId}`,
});

describe("planLayoutRestore: マトリクス分類 (T255 §3.1)", () => {
  test("M1: A のみ — surface 実在 + pid alive 2 件", () => {
    const conductors = [
      { surface: "surface:100", pid: 1001 },
      { surface: "surface:101", pid: 1002 },
    ];
    const live = new Set(["surface:100", "surface:101"]);
    const plan = planLayoutRestore(conductors, live, aliveOf(1001, 1002), []);
    expect(plan.alive).toHaveLength(2);
    expect(plan.alive.every(e => e.decision === "keep-alive")).toBe(true);
    expect(plan.resumeExisting).toHaveLength(0);
    expect(plan.cleanup).toHaveLength(0);
    expect(plan.resumeNewSurface).toHaveLength(0);
    expect(plan.discarded).toHaveLength(0);
    expect(plan.unmatchedResumes).toHaveLength(0);
  });

  test("M2: A 1件 + C 1件 — alive 1 + pid_dead surface 残骸 + task なし", () => {
    const conductors = [
      { surface: "surface:100", pid: 1001 },
      { surface: "surface:101", pid: 1002 },
    ];
    const live = new Set(["surface:100", "surface:101"]);
    // surface:100 alive、surface:101 pid 死亡
    const plan = planLayoutRestore(conductors, live, aliveOf(1001), []);
    expect(plan.alive).toHaveLength(1);
    expect(plan.alive[0]!.raw.surface).toBe("surface:100");
    expect(plan.cleanup).toEqual(["surface:101"]);
    expect(plan.discarded).toHaveLength(1);
    expect(plan.discarded[0]!.reason).toBe("pid_dead_idle_cleanup");
    expect(plan.resumeExisting).toHaveLength(0);
    expect(plan.resumeNewSurface).toHaveLength(0);
  });

  test("M3: B 1件 — surface 実在 + pid_dead + running task", () => {
    const conductors = [
      { surface: "surface:200", pid: 2001, taskId: "042" },
    ];
    const live = new Set(["surface:200"]);
    const plan = planLayoutRestore(conductors, live, ALL_DEAD, [resume("042")]);
    expect(plan.resumeExisting).toHaveLength(1);
    expect(plan.resumeExisting[0]!.decision).toBe("resume-existing");
    expect(plan.resumeExisting[0]!.resume?.taskId).toBe("042");
    expect(plan.alive).toHaveLength(0);
    expect(plan.cleanup).toHaveLength(0);
    expect(plan.unmatchedResumes).toHaveLength(0);
  });

  test("M4: D 1件 — surface 消失 + running task", () => {
    const conductors = [
      { surface: "surface:300", pid: 3001, taskId: "077" },
    ];
    const live = new Set<string>(); // surface 消失
    const plan = planLayoutRestore(conductors, live, ALL_DEAD, [resume("077")]);
    expect(plan.resumeNewSurface).toHaveLength(1);
    expect(plan.resumeNewSurface[0]!.decision).toBe("resume-new-surface");
    expect(plan.resumeNewSurface[0]!.resume?.taskId).toBe("077");
    expect(plan.alive).toHaveLength(0);
    expect(plan.cleanup).toHaveLength(0);
    expect(plan.unmatchedResumes).toHaveLength(0);
  });

  test("M5: E 1件 — surface 消失 + task なし", () => {
    const conductors = [{ surface: "surface:400", pid: 4001 }];
    const live = new Set<string>();
    const plan = planLayoutRestore(conductors, live, ALL_DEAD, []);
    expect(plan.discarded).toHaveLength(1);
    expect(plan.discarded[0]!.surface).toBe("surface:400");
    expect(plan.discarded[0]!.reason).toBe("surface_missing_no_task");
    expect(plan.alive).toHaveLength(0);
    expect(plan.cleanup).toHaveLength(0);
  });

  test("M7: tree 失敗 (liveSurfaces=null) → pid_only に degrade", () => {
    const conductors = [
      { surface: "surface:500", pid: 5001 }, // pid alive → A
      { surface: "surface:501", pid: 5002 }, // pid dead + tree degrade → A 相当（cleanup しない）
      { surface: "surface:502", pid: 5003, taskId: "099" }, // pid dead + running task + tree degrade → B にしない
    ];
    const plan = planLayoutRestore(
      conductors,
      null, // tree degrade
      aliveOf(5001),
      [resume("099")],
    );
    // tree degrade では pid alive も pid dead も A に倒す
    expect(plan.alive).toHaveLength(3);
    expect(plan.cleanup).toHaveLength(0);
    expect(plan.resumeExisting).toHaveLength(0);
    expect(plan.resumeNewSurface).toHaveLength(0);
    expect(plan.discarded).toHaveLength(0);
    // running task は matched 扱いになるため unmatched 0 件
    expect(plan.unmatchedResumes).toHaveLength(0);
  });

  test("M12: team.json 空 + resumePlan 非空 → 全て unmatched", () => {
    const plan = planLayoutRestore(
      [],
      new Set<string>(),
      ALL_ALIVE,
      [resume("042"), resume("077")],
    );
    expect(plan.alive).toHaveLength(0);
    expect(plan.resumeExisting).toHaveLength(0);
    expect(plan.resumeNewSurface).toHaveLength(0);
    expect(plan.unmatchedResumes).toHaveLength(2);
    expect(plan.unmatchedResumes.map(r => r.taskId).sort()).toEqual(["042", "077"]);
  });

  test("再現バグ M6 のコア分類: pid_dead 2 件 + pid alive 1 件 + running task 1 件", () => {
    // 部分復元バグ — 旧コードは alive 1 件で early return してしまった。
    // pure 関数レベルでは「分類が正しく行われる」ことだけ確認し、
    // pane 補充の有無は initializeLayout 統合テストで検証する。
    const conductors = [
      { surface: "surface:600", pid: 6001 }, // alive
      { surface: "surface:601", pid: 6002, taskId: "111" }, // pid dead + running task → B
      { surface: "surface:602", pid: 6003 }, // pid dead + idle → C
    ];
    const live = new Set(["surface:600", "surface:601", "surface:602"]);
    const plan = planLayoutRestore(
      conductors,
      live,
      aliveOf(6001),
      [resume("111")],
    );
    expect(plan.alive).toHaveLength(1);
    expect(plan.alive[0]!.raw.surface).toBe("surface:600");
    expect(plan.resumeExisting).toHaveLength(1);
    expect(plan.resumeExisting[0]!.raw.surface).toBe("surface:601");
    expect(plan.cleanup).toEqual(["surface:602"]);
    expect(plan.discarded).toHaveLength(1);
    expect(plan.discarded[0]!.reason).toBe("pid_dead_idle_cleanup");
  });

  test("surface 無しの entry はスキップ", () => {
    const plan = planLayoutRestore(
      [{ pid: 1 } as any, null, undefined, { surface: "" }] as any[],
      new Set<string>(),
      ALL_DEAD,
      [],
    );
    expect(plan.alive).toHaveLength(0);
    expect(plan.discarded).toHaveLength(0);
    expect(plan.cleanup).toHaveLength(0);
  });

  test("pid フィールドが number でないなら pid dead 扱い", () => {
    const conductors = [{ surface: "surface:700", pid: null as any }];
    const live = new Set(["surface:700"]);
    const plan = planLayoutRestore(conductors, live, ALL_ALIVE, []);
    // pid null → pid dead → surface 実在 + idle → cleanup
    expect(plan.cleanup).toEqual(["surface:700"]);
  });
});
