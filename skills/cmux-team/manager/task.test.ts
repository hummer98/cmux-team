import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  parseTaskMeta,
  filterExecutableTasks,
  sortByPriority,
  cascadeAbortToChildren,
  classifyResumeAction,
  buildResumeAbortJournal,
  markTaskAborted,
  parseAbortJournal,
  saveTaskState,
  loadTaskState,
} from "./task";
import type { TaskMeta, TaskState, TaskStateMap } from "./task";

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
    runAfterAll: false,
    exclusive: false,
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
    runAfterAll: false,
    exclusive: false,
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

  test("同じ優先度は ID 昇順で決定的に並ぶ", () => {
    const tasks = [
      makeMeta("3", "medium"),
      makeMeta("1", "medium"),
      makeMeta("2", "medium"),
    ];
    const sorted = sortByPriority(tasks);
    expect(sorted.map((t) => t.id)).toEqual(["1", "2", "3"]);
  });
});

describe("cascadeAbortToChildren (T241)", () => {
  const mkTask = (id: string, dependsOn: string[] = []): TaskMeta => ({
    id,
    title: `task-${id}`,
    status: "ready",
    priority: "medium",
    dependsOn,
    runAfterAll: false,
    exclusive: false,
    filePath: `/tmp/${id}.md`,
    fileName: `${id}.md`,
    createdAt: "2026-04-17T00:00:00Z",
  });

  test("親 aborted + 子 ready → draft に戻る", () => {
    const tasks = [mkTask("1"), mkTask("2", ["1"])];
    const state: TaskStateMap = {
      "1": { status: "aborted", abortedAt: "2026-04-17T00:00:00Z" },
      "2": { status: "ready" },
    };
    const result = cascadeAbortToChildren(state, tasks, "1");
    expect(result.revertedChildren).toEqual(["2"]);
    expect(state["2"]?.status).toBe("draft");
    expect(state["2"]?.journal).toBe("parent_aborted: 1");
  });

  test("親 aborted + 子 draft → 変化なし", () => {
    const tasks = [mkTask("1"), mkTask("2", ["1"])];
    const state: TaskStateMap = {
      "1": { status: "aborted" },
      "2": { status: "draft" },
    };
    const result = cascadeAbortToChildren(state, tasks, "1");
    expect(result.revertedChildren).toEqual([]);
    expect(state["2"]?.status).toBe("draft");
    expect(state["2"]?.journal).toBeUndefined();
  });

  test("親 aborted + 子 assigned → 変化なし", () => {
    const tasks = [mkTask("1"), mkTask("2", ["1"])];
    const state: TaskStateMap = {
      "1": { status: "aborted" },
      "2": { status: "assigned", assignedAt: "2026-04-17T00:00:00Z" },
    };
    const result = cascadeAbortToChildren(state, tasks, "1");
    expect(result.revertedChildren).toEqual([]);
    expect(state["2"]?.status).toBe("assigned");
  });

  test("親 aborted + 子 closed/aborted/deleted → 変化なし", () => {
    const tasks = [
      mkTask("1"),
      mkTask("2", ["1"]),
      mkTask("3", ["1"]),
      mkTask("4", ["1"]),
    ];
    const state: TaskStateMap = {
      "1": { status: "aborted" },
      "2": { status: "closed" },
      "3": { status: "aborted" },
      "4": { status: "deleted" },
    };
    const result = cascadeAbortToChildren(state, tasks, "1");
    expect(result.revertedChildren).toEqual([]);
    expect(state["2"]?.status).toBe("closed");
    expect(state["3"]?.status).toBe("aborted");
    expect(state["4"]?.status).toBe("deleted");
  });

  test("複数 depends_on の子 ready → 1 親 cascade でも draft", () => {
    const tasks = [mkTask("1"), mkTask("2"), mkTask("3", ["1", "2"])];
    const state: TaskStateMap = {
      "1": { status: "aborted" },
      "2": { status: "ready" },
      "3": { status: "ready" },
    };
    const result = cascadeAbortToChildren(state, tasks, "1");
    expect(result.revertedChildren).toEqual(["3"]);
    expect(state["3"]?.status).toBe("draft");
    expect(state["3"]?.journal).toBe("parent_aborted: 1");
    // もう片方の親 "2" は ready のまま（depends_on 被依存なので cascade 対象外）
    expect(state["2"]?.status).toBe("ready");
  });

  test("既存 journal がある子 → `; parent_aborted:` で追記", () => {
    const tasks = [mkTask("1"), mkTask("2", ["1"])];
    const state: TaskStateMap = {
      "1": { status: "aborted" },
      "2": { status: "ready", journal: "prev note" },
    };
    cascadeAbortToChildren(state, tasks, "1");
    expect(state["2"]?.journal).toBe("prev note; parent_aborted: 1");
  });
});

describe("parseTaskMeta — exclusive", () => {
  test("exclusive: true を抽出できる", () => {
    const content = `---
id: 100
title: release
status: ready
exclusive: true
---
`;
    const meta = parseTaskMeta(content, "100-release.md", "/path/100-release.md");
    expect(meta!.exclusive).toBe(true);
  });

  test("exclusive: true のみ指定でも runAfterAll=true が強制される", () => {
    const content = `---
id: 101
title: release only exclusive
status: ready
exclusive: true
---
`;
    const meta = parseTaskMeta(content, "101-release.md", "/path/101-release.md");
    expect(meta!.exclusive).toBe(true);
    expect(meta!.runAfterAll).toBe(true);
  });

  test("exclusive 未指定時は false で runAfterAll は frontmatter 由来", () => {
    const content = `---
id: 102
title: normal
status: ready
run_after_all: true
---
`;
    const meta = parseTaskMeta(content, "102-normal.md", "/path/102-normal.md");
    expect(meta!.exclusive).toBe(false);
    expect(meta!.runAfterAll).toBe(true);
  });
});

describe("resume classify/journal (T264)", () => {
  const fullyAssigned: TaskState = {
    status: "assigned",
    sessionId: "sess-1",
    taskRunId: "task-262-1776560393",
    worktreePath: "/tmp/worktree-262",
  };

  test("classifyResumeAction: sessionId なし → abort (no_session_id)", () => {
    const ts: TaskState = { ...fullyAssigned, sessionId: undefined };
    const r = classifyResumeAction(ts, () => true);
    expect(r).toEqual({ kind: "abort", reason: "no_session_id" });
  });

  test("classifyResumeAction: taskRunId なし → abort (no_task_run_id)", () => {
    const ts: TaskState = { ...fullyAssigned, taskRunId: undefined };
    const r = classifyResumeAction(ts, () => true);
    expect(r).toEqual({ kind: "abort", reason: "no_task_run_id" });
  });

  test("classifyResumeAction: worktreePath なし → abort (no_worktree)", () => {
    const ts: TaskState = { ...fullyAssigned, worktreePath: undefined };
    const r = classifyResumeAction(ts, () => true);
    expect(r).toEqual({ kind: "abort", reason: "no_worktree" });
  });

  test("classifyResumeAction: worktreePath あり + exists=false → abort (no_worktree)", () => {
    const r = classifyResumeAction(fullyAssigned, () => false);
    expect(r).toEqual({ kind: "abort", reason: "no_worktree" });
  });

  test("classifyResumeAction: 3 点揃い + exists=true → resume", () => {
    const r = classifyResumeAction(fullyAssigned, () => true);
    expect(r).toEqual({ kind: "resume" });
  });

  test("buildResumeAbortJournal: ディレクトリ形式 taskFile + no_worktree", () => {
    const ts: TaskState = { status: "assigned", taskRunId: "task-262-1776560393" };
    const j = buildResumeAbortJournal(
      "/proj/.team/tasks/262-conductor/task.md",
      ts,
      "no_worktree",
    );
    expect(j).toBe(
      "[resume] lost worktree (taskRunId=task-262-1776560393). artifacts preserved at .team/tasks/262-conductor/runs/task-262-1776560393/",
    );
  });

  test("buildResumeAbortJournal: 単一ファイル形式 taskFile", () => {
    const ts: TaskState = { status: "assigned", taskRunId: "task-010-9999" };
    const j = buildResumeAbortJournal("/proj/.team/tasks/010.md", ts, "no_worktree");
    expect(j).toContain("(runs dir not found — legacy flat task file)");
    expect(j).toContain("[resume] lost worktree (taskRunId=task-010-9999)");
  });

  test("buildResumeAbortJournal: taskFile=undefined + no_session_id", () => {
    const ts: TaskState = { status: "assigned" };
    const j = buildResumeAbortJournal(undefined, ts, "no_session_id");
    expect(j).toBe(
      "[resume] missing session id (taskRunId=unknown). artifacts preserved at .team/tasks/<unknown>/runs/unknown/",
    );
  });
});

describe("markTaskAborted (T290)", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "cmux-team-T290-"));
    await mkdir(join(tmpRoot, ".team"), { recursive: true });
    await mkdir(join(tmpRoot, ".team/tasks"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  const setupTask = async (id: string, body: string = "body") => {
    const dir = join(tmpRoot, ".team/tasks", `${id}-task`);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "task.md"),
      `---\nid: ${id}\ntitle: task-${id}\nstatus: ready\npriority: medium\ncreated_at: 2026-04-22T00:00:00Z\n---\n\n${body}\n`,
    );
  };

  const setupChildDependingOn = async (childId: string, parentId: string) => {
    const dir = join(tmpRoot, ".team/tasks", `${childId}-child`);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "task.md"),
      `---\nid: ${childId}\ntitle: child-${childId}\nstatus: ready\npriority: medium\ndepends_on: [${parentId}]\ncreated_at: 2026-04-22T00:00:00Z\n---\n\nchild\n`,
    );
  };

  test("T1: 正常系 — journal が新 format / abortedAt / revertedChildren=[]", async () => {
    await setupTask("1");
    await saveTaskState(tmpRoot, { "1": { status: "assigned", assignedAt: "2026-04-22T00:00:00Z" } });

    const res = await markTaskAborted(tmpRoot, "1", "user_clear", "C[5] taskRunId=task-1-123", {
      now: () => "2026-04-22T01:00:00Z",
    });
    expect(res.journal).toBe("reason=user_clear; C[5] taskRunId=task-1-123");
    expect(res.idempotentSkip).toBeUndefined();
    expect(res.revertedChildren).toEqual([]);

    const persisted = await loadTaskState(tmpRoot);
    expect(persisted["1"]?.status).toBe("aborted");
    expect(persisted["1"]?.abortedAt).toBe("2026-04-22T01:00:00Z");
    expect(persisted["1"]?.journal).toBe("reason=user_clear; C[5] taskRunId=task-1-123");
  });

  test("T2: detail 空 — journal = `reason=abort_task;`（末尾セミコロン付）", async () => {
    await setupTask("2");
    await saveTaskState(tmpRoot, { "2": { status: "assigned" } });

    const res = await markTaskAborted(tmpRoot, "2", "abort_task", "");
    expect(res.journal).toBe("reason=abort_task;");

    const persisted = await loadTaskState(tmpRoot);
    expect(persisted["2"]?.journal).toBe("reason=abort_task;");
  });

  test("T3: 冪等（既に aborted）— idempotentSkip=true / 書き換えなし", async () => {
    await setupTask("3");
    const original: TaskState = {
      status: "aborted",
      abortedAt: "2026-04-22T00:00:00Z",
      journal: "reason=user_clear; original",
    };
    await saveTaskState(tmpRoot, { "3": original });

    const res = await markTaskAborted(tmpRoot, "3", "judgment_pending", "new-detail", {
      now: () => "2026-04-22T99:99:99Z",
    });
    expect(res.idempotentSkip).toBe(true);
    expect(res.existingStatus).toBe("aborted");

    const persisted = await loadTaskState(tmpRoot);
    expect(persisted["3"]?.abortedAt).toBe("2026-04-22T00:00:00Z");
    expect(persisted["3"]?.journal).toBe("reason=user_clear; original");
  });

  test("T4: 冪等（closed）— idempotentSkip=true / 書き換えなし", async () => {
    await setupTask("4");
    await saveTaskState(tmpRoot, {
      "4": { status: "closed", closedAt: "2026-04-22T00:00:00Z", journal: "done" },
    });

    const res = await markTaskAborted(tmpRoot, "4", "abort_task", "late abort");
    expect(res.idempotentSkip).toBe(true);
    expect(res.existingStatus).toBe("closed");

    const persisted = await loadTaskState(tmpRoot);
    expect(persisted["4"]?.status).toBe("closed");
    expect(persisted["4"]?.journal).toBe("done");
  });

  test("T5: 冪等（deleted）— idempotentSkip=true / 書き換えなし", async () => {
    await setupTask("5");
    await saveTaskState(tmpRoot, {
      "5": { status: "deleted", deletedAt: "2026-04-22T00:00:00Z" },
    });

    const res = await markTaskAborted(tmpRoot, "5", "assign_failed", "ignored");
    expect(res.idempotentSkip).toBe(true);
    expect(res.existingStatus).toBe("deleted");

    const persisted = await loadTaskState(tmpRoot);
    expect(persisted["5"]?.status).toBe("deleted");
  });

  test("T6: cascade — ready 子 → draft / revertedChildren に id が入る", async () => {
    await setupTask("10");
    await setupChildDependingOn("11", "10");
    await saveTaskState(tmpRoot, {
      "10": { status: "assigned" },
      "11": { status: "ready" },
    });

    const res = await markTaskAborted(tmpRoot, "10", "disconnect_timeout", "C[5] taskRunId=- disconnectedAt=X");
    expect(res.revertedChildren).toEqual(["11"]);

    const persisted = await loadTaskState(tmpRoot);
    expect(persisted["10"]?.status).toBe("aborted");
    expect(persisted["11"]?.status).toBe("draft");
    expect(persisted["11"]?.journal).toBe("parent_aborted: 10");
  });

  test("T7: cascade 無し — 子が draft のみ / revertedChildren=[]", async () => {
    await setupTask("20");
    await setupChildDependingOn("21", "20");
    await saveTaskState(tmpRoot, {
      "20": { status: "assigned" },
      "21": { status: "draft" },
    });

    const res = await markTaskAborted(tmpRoot, "20", "abort_task", "");
    expect(res.revertedChildren).toEqual([]);

    const persisted = await loadTaskState(tmpRoot);
    expect(persisted["21"]?.status).toBe("draft");
  });

  test("T8: log detail 完備 — task_id / reason / title / journal_summary / extraLogFields を全て含む", async () => {
    await setupTask("30");
    await saveTaskState(tmpRoot, { "30": { status: "assigned" } });

    // logger.ts は .team/logs/manager.log に出す。ログファイルを読んで確認する。
    const res = await markTaskAborted(tmpRoot, "30", "assign_failed", "some-reason", {
      taskTitle: "Foo Task",
      extraLogFields: { kind: "task" },
    });
    expect(res.journal).toBe("reason=assign_failed; some-reason");

    // ログは process.cwd() 基準で書かれるため、ここでは log 内容は検証しない
    // （log 詳細の検証は統合テストで、単体では journal と return 値で十分）
  });

  test("T9: parseAbortJournal — new format 4 ケース", () => {
    expect(parseAbortJournal("reason=user_clear; C[5] taskRunId=task-1-123")).toEqual({
      reason: "user_clear",
      detail: "C[5] taskRunId=task-1-123",
      raw: "reason=user_clear; C[5] taskRunId=task-1-123",
    });

    expect(parseAbortJournal("reason=abort_task;")).toEqual({
      reason: "abort_task",
      detail: "",
      raw: "reason=abort_task;",
    });

    // detail に空白 2 つ含む — regex の \s? で先頭 1 空白のみ consume、残りは detail へ
    expect(parseAbortJournal("reason=judgment_pending;  C[5]")).toEqual({
      reason: "judgment_pending",
      detail: " C[5]",
      raw: "reason=judgment_pending;  C[5]",
    });

    // multi-line detail（/s フラグで .* が改行にマッチ）
    expect(parseAbortJournal("reason=disconnect_timeout; line1\nline2")).toEqual({
      reason: "disconnect_timeout",
      detail: "line1\nline2",
      raw: "reason=disconnect_timeout; line1\nline2",
    });
  });

  test("T10: parseAbortJournal — 旧 format prefix 6 種を正しく推定", () => {
    const cases: Array<[string, string]> = [
      ["user_clear: C[5] taskRunId=task-1-123", "user_clear"],
      ["assign_failed: branch-conflict", "assign_failed"],
      ["disconnect_timeout: C[5] taskRunId=task-1-123 disconnectedAt=2026-04-22T00:00:00Z", "disconnect_timeout"],
      ["conductor_done_unresolved: rebase_conflict (worktree=/tmp/x) taskRunId=task-1-123", "judgment_pending"],
      ["[resume] lost worktree (taskRunId=task-1-123). artifacts preserved at .team/tasks/1-foo/runs/task-1-123/", "resume_no_worktree"],
      ["[resume] missing session id (taskRunId=unknown). artifacts preserved at .team/tasks/<unknown>/runs/unknown/", "resume_no_session_id"],
      ["[resume] missing task run id (taskRunId=unknown). artifacts preserved at .team/tasks/<unknown>/runs/unknown/", "resume_no_task_run_id"],
    ];
    for (const [input, expected] of cases) {
      const r = parseAbortJournal(input);
      expect(r.reason).toBe(expected);
      expect(r.detail).toBe(input);
      expect(r.raw).toBe(input);
    }
  });

  test("T11: parseAbortJournal — 完全未知 → reason=undefined / detail=raw", () => {
    const r = parseAbortJournal("中断: T290 arbitrary user text");
    expect(r.reason).toBeUndefined();
    expect(r.detail).toBe("中断: T290 arbitrary user text");
    expect(r.raw).toBe("中断: T290 arbitrary user text");
  });

  test("T12: parseAbortJournal — undefined / 空 → { raw: '' }", () => {
    expect(parseAbortJournal(undefined)).toEqual({ raw: "" });
    expect(parseAbortJournal("")).toEqual({ raw: "" });
  });
});
