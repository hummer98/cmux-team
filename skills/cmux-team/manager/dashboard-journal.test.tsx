/**
 * T353: Journal parser / row builder の回帰テスト。
 *
 * - parseJournalEntries: daemon ライフサイクル / resume 失敗 4 ブランチ + 既存 5 イベント
 * - buildJournalRows: daemon sentinel taskId は T### 列をスキップして描画
 * - dashboard-conductor.test.tsx と同じ JSON.stringify + toContain 方式で検証する
 */
import { describe, test, expect } from "bun:test";
import {
  parseJournalEntries,
  buildJournalRows,
  formatUptimeSec,
  DAEMON_SENTINEL_TASK_ID,
  type JournalEntry,
} from "./dashboard";
import { rgb } from "@rezi-ui/core";

const GREEN = rgb(0, 160, 0);
const YELLOW = rgb(200, 160, 0);
const RED = rgb(180, 40, 40);
const CYAN = rgb(0, 180, 180);

function stringifyRows(rows: any): string {
  return JSON.stringify(rows);
}

describe("parseJournalEntries: boot_completed", () => {
  test("resumed 2 conductors / 1 open task を集約表示", () => {
    const line =
      "[2026-05-01T06:11:48Z] boot_completed version=v3.45.0 restored_conductors=2 open_tasks=1";
    const entries = parseJournalEntries([line]);
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.taskId).toBe(DAEMON_SENTINEL_TASK_ID);
    expect(entry.iconColor).toBe(CYAN);
    expect(entry.message).toContain("v3.45.0");
    expect(entry.message).toContain("resumed 2 conductors");
    expect(entry.message).toContain("1 open task");
    // 単数形であることを確認
    expect(entry.message).not.toContain("1 open tasks");
  });

  test("restored_conductors=0 のとき fresh start", () => {
    const line =
      "[2026-05-01T06:11:48Z] boot_completed version=v3.45.0 restored_conductors=0 open_tasks=0";
    const [entry] = parseJournalEntries([line]);
    expect(entry!.message).toContain("fresh start");
    expect(entry!.message).toContain("v3.45.0");
  });

  test("単数形: 1 conductor / 1 open task", () => {
    const line =
      "[2026-05-01T06:11:48Z] boot_completed version=v3.45.0 restored_conductors=1 open_tasks=1";
    const [entry] = parseJournalEntries([line]);
    expect(entry!.message).toContain("1 conductor / 1 open task");
    expect(entry!.message).not.toContain("1 conductors");
  });

  test("複数形: 2 conductors / 2 open tasks", () => {
    const line =
      "[2026-05-01T06:11:48Z] boot_completed version=v3.45.0 restored_conductors=2 open_tasks=2";
    const [entry] = parseJournalEntries([line]);
    expect(entry!.message).toContain("2 conductors / 2 open tasks");
  });

  test("拡張前の空 detail でも parser が落ちず fresh start に fallback", () => {
    const line = "[2026-05-01T06:11:48Z] boot_completed";
    const entries = parseJournalEntries([line]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.message).toContain("fresh start");
    // version が空でも壊れない
    expect(entries[0]!.taskId).toBe(DAEMON_SENTINEL_TASK_ID);
  });
});

describe("parseJournalEntries: daemon_stopped", () => {
  test("uptime_sec=12180 を 3h 23m に整形", () => {
    const line = "[2026-05-01T06:11:48Z] daemon_stopped uptime_sec=12180";
    const [entry] = parseJournalEntries([line]);
    expect(entry!.message).toBe("daemon stopped (uptime 3h 23m)");
    expect(entry!.dim).toBe(true);
    expect(entry!.taskId).toBe(DAEMON_SENTINEL_TASK_ID);
    expect(entry!.iconColor).toBe(CYAN);
  });

  test("uptime_sec=0 (即時 SIGINT) は 0s 表示", () => {
    const line = "[2026-05-01T06:11:48Z] daemon_stopped uptime_sec=0";
    const [entry] = parseJournalEntries([line]);
    expect(entry!.message).toBe("daemon stopped (uptime 0s)");
  });

  test("detail 欠落 (uptime_sec なし) でも 0s フォールバック", () => {
    const line = "[2026-05-01T06:11:48Z] daemon_stopped";
    const [entry] = parseJournalEntries([line]);
    expect(entry!.message).toContain("0s");
    expect(entry!.dim).toBe(true);
  });
});

describe("parseJournalEntries: resume failure events", () => {
  test("conductor_resume_launch_failed: ✕ + reason 抽出", () => {
    const line =
      "[2026-05-01T06:11:48Z] conductor_resume_launch_failed task_id=350 C[121] git fetch failed: connection refused";
    const [entry] = parseJournalEntries([line]);
    expect(entry!.taskId).toBe("350");
    expect(entry!.surface).toBe("surface:121");
    expect(entry!.message).toContain(
      "launch_error: git fetch failed: connection refused",
    );
    expect(entry!.iconColor).toBe(RED);
    expect(entry!.level).toBe("error");
  });

  test("conductor_resume_launch_failed: 空 message で unknown フォールバック", () => {
    const line =
      "[2026-05-01T06:11:48Z] conductor_resume_launch_failed task_id=350 C[121]";
    const [entry] = parseJournalEntries([line]);
    expect(entry!.message).toContain("launch_error: unknown");
  });

  test("conductor_resume_launch_failed: task_id 欠落は skip", () => {
    const line =
      "[2026-05-01T06:11:48Z] conductor_resume_launch_failed C[121] something";
    const entries = parseJournalEntries([line]);
    expect(entries).toHaveLength(0);
  });

  test("resume_worktree_missing_late: ✕ + worktree_missing", () => {
    const line =
      "[2026-05-01T06:11:48Z] resume_worktree_missing_late task_id=350 C[121] worktree=/tmp/foo";
    const [entry] = parseJournalEntries([line]);
    expect(entry!.taskId).toBe("350");
    expect(entry!.surface).toBe("surface:121");
    expect(entry!.message).toContain("worktree_missing");
    expect(entry!.iconColor).toBe(RED);
    expect(entry!.level).toBe("error");
  });
});

describe("parseJournalEntries: 既存 5 イベント regression", () => {
  test("task_received / conductor_started / task_completed / task_aborted / task_deleted は従来通り", () => {
    const fixtures = [
      "[2026-05-01T06:00:00Z] task_received task_id=350 title=Foo",
      "[2026-05-01T06:01:00Z] conductor_started task_id=350 conductor_id=1 surface=surface:121 title=Foo",
      "[2026-05-01T06:02:00Z] task_completed task_id=350 title=Foo journal_summary=完了",
      "[2026-05-01T06:03:00Z] task_aborted task_id=350 title=Foo",
      "[2026-05-01T06:04:00Z] task_deleted task_id=350 title=Foo",
    ];
    const entries = parseJournalEntries(fixtures);
    expect(entries).toHaveLength(5);
    expect(entries[0]!.iconColor).toBe(CYAN);
    expect(entries[1]!.iconColor).toBe(YELLOW);
    expect(entries[2]!.iconColor).toBe(GREEN);
    expect(entries[3]!.iconColor).toBe(RED);
    expect(entries[4]!.iconColor).toBe(YELLOW);
    // taskId はすべて "350"
    for (const e of entries) {
      expect(e.taskId).toBe("350");
    }
  });
});

describe("parseJournalEntries: 非表示イベント", () => {
  test("daemon_reload は Journal entry を生成しない (log タブ専用に降格)", () => {
    const line = "[2026-05-01T06:11:48Z] daemon_reload";
    const entries = parseJournalEntries([line]);
    expect(entries).toHaveLength(0);
  });

  test("daemon_started は Journal entry を生成しない (boot_completed が代替)", () => {
    const line =
      "[2026-05-01T06:11:48Z] daemon_started v3.45.0 pid=12345 poll=2000ms max_conductors=2 layout=16x9 sleep_prevention=true";
    const entries = parseJournalEntries([line]);
    expect(entries).toHaveLength(0);
  });
});

describe("buildJournalRows: sentinel + dim 描画", () => {
  test("daemon sentinel taskId は filter を通過し T### 列を出さない", () => {
    const entries: JournalEntry[] = [
      {
        time: "06:11:48",
        icon: "▲",
        taskId: DAEMON_SENTINEL_TASK_ID,
        message: "daemon started v3.45.0 — fresh start",
        level: "info",
        iconColor: CYAN,
      },
    ];
    const rows = buildJournalRows(entries, null);
    const json = stringifyRows(rows);
    expect(json).toContain("daemon started");
    // T___ 列 (T + 数字 3 桁) を含まないことを確認
    expect(json).not.toMatch(/T\d{3}/);
  });

  test("dim=true の daemon_stopped は dim style で描画される", () => {
    const entries: JournalEntry[] = [
      {
        time: "06:11:48",
        icon: "▼",
        taskId: DAEMON_SENTINEL_TASK_ID,
        message: "daemon stopped (uptime 1h)",
        level: "info",
        iconColor: CYAN,
        dim: true,
      },
    ];
    const rows = buildJournalRows(entries, null);
    const json = stringifyRows(rows);
    expect(json).toContain('"dim":true');
  });

  test("通常のタスクエントリは T### 列が描画される (regression)", () => {
    const entries: JournalEntry[] = [
      {
        time: "06:11:48",
        icon: "+",
        taskId: "350",
        message: "Foo task received",
        level: "info",
        iconColor: CYAN,
      },
    ];
    const rows = buildJournalRows(entries, null);
    const json = stringifyRows(rows);
    expect(json).toContain("T350");
  });

  test("空エントリは 'no journal entries' プレースホルダ", () => {
    const rows = buildJournalRows([], null);
    const json = stringifyRows(rows);
    expect(json).toContain("no journal entries");
  });
});

describe("formatUptimeSec", () => {
  test("60 秒未満は Xs", () => {
    expect(formatUptimeSec(0)).toBe("0s");
    expect(formatUptimeSec(45)).toBe("45s");
  });

  test("3600 秒未満は Xm Ys", () => {
    expect(formatUptimeSec(60)).toBe("1m 0s");
    expect(formatUptimeSec(125)).toBe("2m 5s");
  });

  test("3600 秒以上で m が 0 のときは Xh のみ", () => {
    expect(formatUptimeSec(3600)).toBe("1h");
    expect(formatUptimeSec(7200)).toBe("2h");
  });

  test("3600 秒以上で m > 0 のときは Xh Ym", () => {
    expect(formatUptimeSec(12180)).toBe("3h 23m");
    expect(formatUptimeSec(3660)).toBe("1h 1m");
  });
});
