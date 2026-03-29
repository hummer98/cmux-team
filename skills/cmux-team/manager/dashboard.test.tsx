import { describe, test, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import stringWidth from "string-width";
import stripAnsi from "strip-ansi";
import {
  TasksSection,
  ConductorsSection,
  JournalSection,
  LogSection,
  truncate,
  formatLogLine,
} from "./dashboard";
import type { JournalEntry } from "./dashboard";
import type { DaemonState, TaskSummary } from "./daemon";
import type { ConductorState, AgentState } from "./schema";

// --- ヘルパー ---

/** レンダリング結果の全行が cols 以内であることを検証 */
function assertAllLinesWithinCols(output: string, cols: number) {
  const clean = stripAnsi(output);
  const lines = clean.split("\n");
  for (const line of lines) {
    const width = stringWidth(line);
    expect(width).toBeLessThanOrEqual(cols);
  }
}

function createMockState(overrides?: Partial<DaemonState>): DaemonState {
  return {
    running: true,
    masterSurface: "surface:1",
    conductors: new Map(),
    projectRoot: "/tmp/test",
    pollInterval: 30000,
    maxConductors: 3,
    lastUpdate: new Date(),
    pendingTasks: 0,
    openTasks: 0,
    taskList: [],
    sourceMtimes: new Map(),
    restartRequested: false,
    ...overrides,
  };
}

function createConductor(overrides?: Partial<ConductorState>): ConductorState {
  return {
    conductorId: "conductor-1",
    surface: "surface:2",
    startedAt: new Date().toISOString(),
    status: "idle",
    agents: [],
    doneCandidate: false,
    ...overrides,
  };
}

function createTask(overrides?: Partial<TaskSummary>): TaskSummary {
  return {
    id: "1",
    title: "Test task",
    status: "ready",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ===== truncate =====

describe("truncate", () => {
  test("英語テキスト: 切り詰め不要", () => {
    expect(truncate("hello", 10)).toBe("hello");
  });

  test("英語テキスト: 切り詰め必要", () => {
    const result = truncate("hello world", 8);
    expect(stringWidth(result)).toBeLessThanOrEqual(8);
    expect(result).toEndWith("…");
  });

  test("日本語テキスト: 切り詰め不要", () => {
    expect(truncate("日本語", 10)).toBe("日本語");
  });

  test("日本語テキスト: 切り詰め必要", () => {
    const result = truncate("日本語タスクタイトルのテスト", 10);
    expect(stringWidth(result)).toBeLessThanOrEqual(10);
    expect(result).toEndWith("…");
  });

  test("maxLen=0 は空文字を返す", () => {
    expect(truncate("test", 0)).toBe("");
  });

  test("maxLen=1 は省略記号のみ", () => {
    expect(truncate("test", 1)).toBe("…");
  });

  test("ちょうど maxLen の場合はそのまま返す", () => {
    expect(truncate("abc", 3)).toBe("abc");
  });

  test("日本語テキストの表示幅境界", () => {
    // "日本" = 幅4, "語" = 幅2 → 全体幅6
    // maxLen=5 だと "日本" + "…" = 幅5
    const result = truncate("日本語", 5);
    expect(stringWidth(result)).toBeLessThanOrEqual(5);
    expect(result).toEndWith("…");
  });
});

// ===== TasksSection =====

describe("TasksSection", () => {
  test("空のタスクリスト", () => {
    const state = createMockState({ taskList: [] });
    const { lastFrame } = render(<TasksSection state={state} cols={80} />);
    expect(lastFrame()).toContain("no tasks");
  });

  test("英語タスクのみ", () => {
    const state = createMockState({
      taskList: [
        createTask({ id: "1", title: "Implement feature", status: "ready" }),
        createTask({ id: "2", title: "Fix bug", status: "closed", closedAt: new Date().toISOString() }),
      ],
    });
    const { lastFrame } = render(<TasksSection state={state} cols={80} />);
    const output = lastFrame();
    expect(output).toContain("001");
    expect(output).toContain("002");
    assertAllLinesWithinCols(output, 80);
  });

  test("日本語タイトルを含むタスク (cols=80)", () => {
    const state = createMockState({
      taskList: [
        createTask({ id: "1", title: "日本語タスクタイトルのテスト", status: "ready" }),
        createTask({ id: "2", title: "データベース移行の実装", status: "running" }),
      ],
    });
    const { lastFrame } = render(<TasksSection state={state} cols={80} />);
    assertAllLinesWithinCols(lastFrame(), 80);
  });

  test("日本語タイトルを含むタスク (cols=40)", () => {
    const state = createMockState({
      taskList: [
        createTask({ id: "1", title: "日本語タスクタイトルのテスト", status: "ready" }),
        createTask({ id: "2", title: "データベース移行の実装についての長い説明文がここに入る", status: "ready" }),
      ],
    });
    const { lastFrame } = render(<TasksSection state={state} cols={40} />);
    assertAllLinesWithinCols(lastFrame(), 40);
  });

  test("running/ready/closed/draft 全ステータス", () => {
    const conductors = new Map<string, ConductorState>();
    conductors.set("c1", createConductor({ conductorId: "c1", taskId: "1", status: "running" }));

    const state = createMockState({
      conductors,
      taskList: [
        createTask({ id: "1", title: "Running task", status: "ready" }), // assigned → running 表示
        createTask({ id: "2", title: "Ready task", status: "ready" }),
        createTask({ id: "3", title: "Closed task", status: "closed", closedAt: new Date().toISOString() }),
        createTask({ id: "4", title: "Draft task", status: "draft" }),
      ],
    });
    const { lastFrame } = render(<TasksSection state={state} cols={80} />);
    const output = lastFrame();
    expect(output).toContain("running");
    expect(output).toContain("ready");
    expect(output).toContain("closed");
    expect(output).toContain("draft");
    assertAllLinesWithinCols(output, 80);
  });
});

// ===== ConductorsSection =====

describe("ConductorsSection", () => {
  test("Conductor なし（idle 表示）", () => {
    const state = createMockState({ conductors: new Map() });
    const { lastFrame } = render(<ConductorsSection state={state} cols={80} />);
    expect(lastFrame()).toContain("idle");
  });

  test("idle Conductor", () => {
    const conductors = new Map<string, ConductorState>();
    conductors.set("c1", createConductor({ conductorId: "c1", status: "idle" }));
    const state = createMockState({ conductors });
    const { lastFrame } = render(<ConductorsSection state={state} cols={80} />);
    const output = lastFrame();
    expect(output).toContain("idle");
    assertAllLinesWithinCols(output, 80);
  });

  test("running Conductor + 日本語タスクタイトル (cols=80)", () => {
    const conductors = new Map<string, ConductorState>();
    conductors.set("c1", createConductor({
      conductorId: "c1",
      status: "running",
      taskId: "5",
      taskTitle: "データベース移行の実装",
    }));
    const state = createMockState({ conductors });
    const { lastFrame } = render(<ConductorsSection state={state} cols={80} />);
    assertAllLinesWithinCols(lastFrame(), 80);
  });

  test("running Conductor + 日本語タスクタイトル (cols=40)", () => {
    const conductors = new Map<string, ConductorState>();
    conductors.set("c1", createConductor({
      conductorId: "c1",
      status: "running",
      taskId: "5",
      taskTitle: "日本語タスクタイトルのテストで長い文字列がここに入る場合",
    }));
    const state = createMockState({ conductors });
    const { lastFrame } = render(<ConductorsSection state={state} cols={40} />);
    assertAllLinesWithinCols(lastFrame(), 40);
  });

  test("done Conductor", () => {
    const conductors = new Map<string, ConductorState>();
    conductors.set("c1", createConductor({
      conductorId: "c1",
      status: "done",
      taskId: "3",
      taskTitle: "Completed task",
    }));
    const state = createMockState({ conductors });
    const { lastFrame } = render(<ConductorsSection state={state} cols={80} />);
    assertAllLinesWithinCols(lastFrame(), 80);
  });

  test("Agent（子プロセス）付き Conductor", () => {
    const agents: AgentState[] = [
      { surface: "surface:10", role: "impl", taskTitle: "実装タスク", spawnedAt: new Date().toISOString() },
      { surface: "surface:11", role: "tester", taskTitle: "テスト実行", spawnedAt: new Date().toISOString() },
    ];
    const conductors = new Map<string, ConductorState>();
    conductors.set("c1", createConductor({
      conductorId: "c1",
      status: "running",
      taskId: "7",
      taskTitle: "Feature implementation",
      agents,
    }));
    const state = createMockState({ conductors });
    const { lastFrame } = render(<ConductorsSection state={state} cols={80} />);
    const output = lastFrame();
    expect(output).toContain("10");
    expect(output).toContain("11");
    assertAllLinesWithinCols(output, 80);
  });
});

// ===== JournalSection =====

describe("JournalSection", () => {
  test("空エントリ", () => {
    const { lastFrame } = render(<JournalSection entries={[]} cols={80} />);
    expect(lastFrame()).toContain("no journal entries");
  });

  test("日本語メッセージを含むエントリ (cols=80)", () => {
    const entries: JournalEntry[] = [
      { time: "14:30:00", icon: "[+]", taskId: "1", message: "日本語タスクタイトルのテスト", color: "cyan" },
      { time: "14:35:00", icon: "[▶]", taskId: "2", message: "データベース移行の実装を開始", color: "yellow" },
      { time: "14:40:00", icon: "[✓]", taskId: "1", message: "タスク完了: リサーチ結果をまとめました", color: "green" },
    ];
    const { lastFrame } = render(<JournalSection entries={entries} cols={80} />);
    assertAllLinesWithinCols(lastFrame(), 80);
  });

  test("日本語メッセージを含むエントリ (cols=40)", () => {
    const entries: JournalEntry[] = [
      { time: "14:30:00", icon: "[+]", taskId: "1", message: "日本語タスクタイトルのテストで非常に長いメッセージがここに入る場合の処理", color: "cyan" },
      { time: "14:35:00", icon: "[▶]", taskId: "2", message: "データベース移行の実装を開始した詳細な説明", color: "yellow" },
    ];
    const { lastFrame } = render(<JournalSection entries={entries} cols={40} />);
    assertAllLinesWithinCols(lastFrame(), 40);
  });
});

// ===== LogSection =====

describe("LogSection", () => {
  test("空ログ", () => {
    const { lastFrame } = render(<LogSection lines={[]} cols={80} />);
    expect(lastFrame()).toContain("no log entries");
  });

  test("日本語 detail を含むログ行 (cols=80)", () => {
    const now = new Date().toISOString();
    const lines = [
      `[${now}] task_received task_id=1 title=日本語タスクタイトルのテスト`,
      `[${now}] conductor_started task_id=1 title=データベース移行の実装 conductor_id=c1`,
      `[${now}] task_completed task_id=1 title=完了したタスクの説明`,
    ];
    const { lastFrame } = render(<LogSection lines={lines} cols={80} />);
    assertAllLinesWithinCols(lastFrame(), 80);
  });

  test("日本語 detail を含むログ行 (cols=40)", () => {
    const now = new Date().toISOString();
    const lines = [
      `[${now}] task_received task_id=1 title=日本語タスクタイトルのテストで非常に長い文字列`,
      `[${now}] error データベース接続に失敗しました。リトライ中...`,
    ];
    const { lastFrame } = render(<LogSection lines={lines} cols={40} />);
    assertAllLinesWithinCols(lastFrame(), 40);
  });
});

// ===== formatLogLine =====

describe("formatLogLine", () => {
  test("正常なログ行をパースする", () => {
    const now = new Date().toISOString();
    const result = formatLogLine(`[${now}] task_completed task_id=1`, 80);
    expect(result.event).toBe("task_completed");
    expect(result.color).toBe("green");
  });

  test("error イベントは赤色", () => {
    const now = new Date().toISOString();
    const result = formatLogLine(`[${now}] error something failed`, 80);
    expect(result.event).toBe("error");
    expect(result.color).toBe("red");
  });

  test("パース不能な行はそのまま返す", () => {
    const result = formatLogLine("some random text", 80);
    expect(result.time).toBe("");
    expect(result.event).toBe("");
  });

  test("日本語 detail が cols に収まる", () => {
    const now = new Date().toISOString();
    const result = formatLogLine(`[${now}] task_received task_id=1 title=日本語タスクタイトルのテストで非常に長い文字列が含まれている`, 40);
    const totalWidth = 1 + stringWidth(`${result.time} ${result.event} ${result.detail}`);
    expect(totalWidth).toBeLessThanOrEqual(40);
  });
});
