import { describe, test, expect } from "bun:test";
import { buildTasksSectionLines } from "./tasks-status";
import type { TaskMeta } from "./task";

// 最小 TaskMeta インスタンスを生成する（表示ロジックは status のみを見るため、
// 他のフィールドはダミー値で埋めれば十分）
function mkTask(id: string, status: string): TaskMeta {
  return {
    id,
    title: `task-${id}`,
    status,
    priority: "medium",
    dependsOn: [],
    runAfterAll: false,
    exclusive: false,
    filePath: `/dummy/${id}.md`,
    fileName: `${id}.md`,
    createdAt: "2026-04-25T00:00:00.000Z",
  };
}

describe("buildTasksSectionLines", () => {
  test("通常（aborted=0）: draft/ready/assigned×3, closed×5 → `  open: 3  closed: 5`", () => {
    const tasks: TaskMeta[] = [
      mkTask("001", "draft"),
      mkTask("002", "ready"),
      mkTask("003", "assigned"),
      mkTask("004", "closed"),
      mkTask("005", "closed"),
      mkTask("006", "closed"),
      mkTask("007", "closed"),
      mkTask("008", "closed"),
    ];
    expect(buildTasksSectionLines(tasks)).toEqual(["  open: 3  closed: 5"]);
  });

  test("aborted が正の値: ready×2, closed×10, aborted×7 → aborted セグメント付き", () => {
    const tasks: TaskMeta[] = [
      ...Array.from({ length: 2 }, (_, i) => mkTask(`r${i}`, "ready")),
      ...Array.from({ length: 10 }, (_, i) => mkTask(`c${i}`, "closed")),
      ...Array.from({ length: 7 }, (_, i) => mkTask(`a${i}`, "aborted")),
    ];
    expect(buildTasksSectionLines(tasks)).toEqual([
      "  open: 2  closed: 10  aborted: 7",
    ]);
  });

  test("全 0 件: [] → `  open: 0  closed: 0`（aborted セグメント無し）", () => {
    expect(buildTasksSectionLines([])).toEqual(["  open: 0  closed: 0"]);
  });

  test("deleted は open/closed/aborted いずれにも加算しない（closed×3, deleted×2）", () => {
    const tasks: TaskMeta[] = [
      mkTask("001", "closed"),
      mkTask("002", "closed"),
      mkTask("003", "closed"),
      mkTask("004", "deleted"),
      mkTask("005", "deleted"),
    ];
    expect(buildTasksSectionLines(tasks)).toEqual(["  open: 0  closed: 3"]);
  });

  test("aborted のみ存在（エッジ）: aborted×1 → `  open: 0  closed: 0  aborted: 1`", () => {
    const tasks: TaskMeta[] = [mkTask("001", "aborted")];
    expect(buildTasksSectionLines(tasks)).toEqual([
      "  open: 0  closed: 0  aborted: 1",
    ]);
  });

  test("想定外ステータスは静かに無視: unknown×1, closed×2 → `  open: 0  closed: 2`", () => {
    const tasks: TaskMeta[] = [
      mkTask("001", "unknown"),
      mkTask("002", "closed"),
      mkTask("003", "closed"),
    ];
    expect(buildTasksSectionLines(tasks)).toEqual(["  open: 0  closed: 2"]);
  });
});
