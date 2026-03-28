import { describe, test, expect } from "bun:test";
import { parseTaskMeta, filterExecutableTasks, sortByPriority } from "./task";
import type { TaskMeta } from "./task";

describe("parseTaskMeta", () => {
  test("基本的なタスクをパースできる", () => {
    const content = `---
id: 035
title: バグ修正
priority: high
status: ready
created_at: 2026-03-27T10:00:00Z
---

## タスク
バグを修正する
`;
    const meta = parseTaskMeta(content, "035-fix-bug.md", "/path/035-fix-bug.md");
    expect(meta).not.toBeNull();
    expect(meta!.id).toBe("035");
    expect(meta!.title).toBe("バグ修正");
    expect(meta!.priority).toBe("high");
    expect(meta!.status).toBe("ready");
    expect(meta!.dependsOn).toEqual([]);
    expect(meta!.createdAt).toBe("2026-03-27T10:00:00Z");
  });

  test("created_at がないタスクは空文字として扱う", () => {
    const content = `---
id: 036
title: no date
status: ready
---
`;
    const meta = parseTaskMeta(content, "036-no-date.md", "/path/036-no-date.md");
    expect(meta!.createdAt).toBe("");
  });

  test("depends_on（配列）をパースできる", () => {
    const content = `---
id: 037
title: レポート統合
status: ready
depends_on: [035, 036]
---
`;
    const meta = parseTaskMeta(content, "037-report.md", "/path/037-report.md");
    expect(meta!.dependsOn).toEqual(["035", "036"]);
  });

  test("depends_on（単一値）をパースできる", () => {
    const content = `---
id: 036
title: 実装
status: ready
depends_on: 035
---
`;
    const meta = parseTaskMeta(content, "036-impl.md", "/path/036-impl.md");
    expect(meta!.dependsOn).toEqual(["035"]);
  });

  test("depends_on がゼロパディングされていてもそのまま保持される", () => {
    const content = `---
id: 037
title: test
status: ready
depends_on: [035, 036]
---
`;
    const meta = parseTaskMeta(content, "037-test.md", "/path/037-test.md");
    expect(meta!.dependsOn).toEqual(["035", "036"]);
  });

  test("status がない場合は ready として扱う", () => {
    const content = `---
id: 001
title: legacy task
---
`;
    const meta = parseTaskMeta(content, "001-legacy.md", "/path/001-legacy.md");
    expect(meta!.status).toBe("ready");
  });

  test("frontmatter がないファイルは null を返す", () => {
    const content = "# ただの Markdown\n\nテキスト";
    const meta = parseTaskMeta(content, "bad.md", "/path/bad.md");
    expect(meta).toBeNull();
  });

  test("ファイル名から ID を抽出する（frontmatter に id がない場合）", () => {
    const content = `---
title: no id field
status: ready
---
`;
    const meta = parseTaskMeta(content, "042-no-id.md", "/path/042-no-id.md");
    expect(meta!.id).toBe("042");
  });
});

describe("filterExecutableTasks", () => {
  const makeMeta = (
    id: string,
    status: string,
    dependsOn: string[] = [],
    priority: string = "medium"
  ): TaskMeta => ({
    id,
    title: `task-${id}`,
    status,
    priority,
    dependsOn,
    filePath: `/path/${id}.md`,
    fileName: `${id}.md`,
    createdAt: "",
  });

  test("ready かつ依存なしのタスクは実行可能", () => {
    const tasks = [makeMeta("1", "ready"), makeMeta("2", "ready")];
    const result = filterExecutableTasks(tasks, new Set(), new Set());
    expect(result).toHaveLength(2);
  });

  test("draft タスクはフィルタされる", () => {
    const tasks = [makeMeta("1", "draft"), makeMeta("2", "ready")];
    const result = filterExecutableTasks(tasks, new Set(), new Set());
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("2");
  });

  test("依存タスクが全て closed なら実行可能", () => {
    const tasks = [makeMeta("003", "ready", ["001", "002"])];
    const closed = new Set(["001", "002"]);
    const result = filterExecutableTasks(tasks, closed, new Set());
    expect(result).toHaveLength(1);
  });

  test("依存タスクが一部未完了なら実行不可", () => {
    const tasks = [makeMeta("003", "ready", ["001", "002"])];
    const closed = new Set(["001"]); // 002 がまだ
    const result = filterExecutableTasks(tasks, closed, new Set());
    expect(result).toHaveLength(0);
  });

  test("既にアサイン済みのタスクはフィルタされる", () => {
    const tasks = [makeMeta("1", "ready"), makeMeta("2", "ready")];
    const assigned = new Set(["1"]);
    const result = filterExecutableTasks(tasks, new Set(), assigned);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("2");
  });

  // ユースケース 1: issue → task → 順序付き実行
  test("UC1: 連鎖的な依存 A→B→C が正しく解決される", () => {
    const taskA = makeMeta("1", "ready");
    const taskB = makeMeta("2", "ready", ["1"]);
    const taskC = makeMeta("3", "ready", ["2"]);

    // 初期状態: A のみ実行可能
    let result = filterExecutableTasks([taskA, taskB, taskC], new Set(), new Set());
    expect(result.map((t) => t.id)).toEqual(["1"]);

    // A 完了後（A は closed に移動 → open から消える）: B のみ実行可能
    result = filterExecutableTasks([taskB, taskC], new Set(["1"]), new Set());
    expect(result.map((t) => t.id)).toEqual(["2"]);

    // A,B 完了後: C が実行可能
    result = filterExecutableTasks([taskC], new Set(["1", "2"]), new Set());
    expect(result.map((t) => t.id)).toEqual(["3"]);
  });

  // ユースケース 2: 並列調査 → 統合
  test("UC2: 並列タスク → 統合タスクのパターン", () => {
    const researchA = makeMeta("10", "ready");
    const researchB = makeMeta("11", "ready");
    const researchC = makeMeta("12", "ready");
    const consolidate = makeMeta("13", "ready", ["10", "11", "12"]);

    // 初期状態: 調査 A,B,C が並列実行可能、統合は不可
    let result = filterExecutableTasks(
      [researchA, researchB, researchC, consolidate],
      new Set(),
      new Set()
    );
    expect(result.map((t) => t.id)).toEqual(["10", "11", "12"]);

    // 調査 A,B 完了、C はまだ実行中: 統合は不可、A,B は closed で open にない
    result = filterExecutableTasks(
      [researchC, consolidate],  // A,B は closed に移動済み
      new Set(["10", "11"]),
      new Set(["12"])  // C はアサイン済み（実行中）
    );
    expect(result.map((t) => t.id)).toEqual([]);

    // 全調査完了: 統合が実行可能
    result = filterExecutableTasks(
      [consolidate],
      new Set(["10", "11", "12"]),
      new Set()
    );
    expect(result.map((t) => t.id)).toEqual(["13"]);
  });

  // ユースケース 3: 実装中の割り込み新規タスク
  test("UC3: 実装 Conductor 稼働中に新規タスクが追加される", () => {
    const implTask = makeMeta("20", "ready");
    const newTask = makeMeta("99999", "ready");

    // 実装タスクがアサイン済み、新規タスクは未アサイン
    const result = filterExecutableTasks(
      [implTask, newTask],
      new Set(),
      new Set(["20"]) // 実装はアサイン済み
    );
    expect(result.map((t) => t.id)).toEqual(["99999"]); // 新規のみ実行可能
  });
});

describe("sortByPriority", () => {
  const makeMeta = (id: string, priority: string): TaskMeta => ({
    id,
    title: `task-${id}`,
    status: "ready",
    priority,
    dependsOn: [],
    filePath: "",
    fileName: "",
    createdAt: "",
  });

  test("high > medium > low の順でソートされる", () => {
    const tasks = [
      makeMeta("1", "low"),
      makeMeta("2", "high"),
      makeMeta("3", "medium"),
    ];
    const sorted = sortByPriority(tasks);
    expect(sorted.map((t) => t.id)).toEqual(["2", "3", "1"]);
  });

  test("同じ優先度は元の順序を維持する", () => {
    const tasks = [
      makeMeta("1", "medium"),
      makeMeta("2", "medium"),
      makeMeta("3", "medium"),
    ];
    const sorted = sortByPriority(tasks);
    expect(sorted.map((t) => t.id)).toEqual(["1", "2", "3"]);
  });
});
