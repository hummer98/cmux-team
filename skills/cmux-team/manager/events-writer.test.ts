import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFile, stat, writeFile, chmod } from "fs/promises";
import { join } from "path";
import {
  emitEvent,
  mapAbortReason,
  EVENTS_SCHEMA_VERSION,
  type EventStreamRecord,
  type SpecAbortReason,
} from "./events-writer";
import type { AbortReason } from "./task";
import { createDummyProject, type DummyProject } from "./test-project";

let project: DummyProject;

beforeEach(async () => {
  project = await createDummyProject({ prefix: "cmux-events-writer-test-" });
});

afterEach(async () => {
  await project.dispose();
});

async function readJsonl(): Promise<unknown[]> {
  const filePath = join(project.root, ".team/logs/events.jsonl");
  const content = await readFile(filePath, "utf-8");
  return content
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

describe("emitEvent: schema 適合", () => {
  test("schema_version=2 / ts / event を必ず付与する", async () => {
    await emitEvent({
      event: "task_ready",
      task_id: "T100",
    });

    const lines = await readJsonl();
    expect(lines).toHaveLength(1);
    const rec = lines[0] as Record<string, unknown>;
    expect(rec.event).toBe("task_ready");
    expect(rec.schema_version).toBe(EVENTS_SCHEMA_VERSION);
    expect(typeof rec.ts).toBe("string");
    expect(rec.ts as string).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(rec.task_id).toBe("T100");
  });

  test("1 行 1 record（trailing \\n + JSON 内に改行を含まない）", async () => {
    await emitEvent({ event: "task_ready", task_id: "T1" });
    await emitEvent({ event: "task_ready", task_id: "T2" });

    const filePath = join(project.root, ".team/logs/events.jsonl");
    const content = await readFile(filePath, "utf-8");
    expect(content.endsWith("\n")).toBe(true);
    // trailing \n 以外の \n は record 区切りのみ
    const lines = content.split("\n");
    expect(lines[lines.length - 1]).toBe("");
    for (let i = 0; i < lines.length - 1; i++) {
      expect(lines[i]?.includes("\n")).toBe(false);
    }
  });
});

describe("emitEvent: append-only", () => {
  test("連続 N=10 emit で行数 N、過去行が破壊されない", async () => {
    for (let i = 0; i < 10; i++) {
      await emitEvent({ event: "task_ready", task_id: `T${i}` });
    }
    const lines = await readJsonl();
    expect(lines).toHaveLength(10);
    for (let i = 0; i < 10; i++) {
      expect((lines[i] as Record<string, unknown>).task_id).toBe(`T${i}`);
    }
  });

  test("retention: 100 record emit 後も全部残る (truncate されない、rotate されない)", async () => {
    for (let i = 0; i < 100; i++) {
      await emitEvent({ event: "task_ready", task_id: `T${i}` });
    }
    const lines = await readJsonl();
    expect(lines).toHaveLength(100);

    const filePath = join(project.root, ".team/logs/events.jsonl");
    const before = (await stat(filePath)).size;
    // 1 record 追加 → ファイル末尾が伸びるだけで縮まない
    await emitEvent({ event: "task_ready", task_id: "T_extra" });
    const after = (await stat(filePath)).size;
    expect(after).toBeGreaterThan(before);
    const lines2 = await readJsonl();
    expect(lines2).toHaveLength(101);
    // 旧 record が消えていない
    expect((lines2[0] as Record<string, unknown>).task_id).toBe("T0");
  });
});

describe("emitEvent: mkdir 自動", () => {
  test(".team/logs/ が無くても作られる", async () => {
    // createDummyProject 既定では logs/ も作られるので、別の subdirs で作り直す
    await project.dispose();
    project = await createDummyProject({
      prefix: "cmux-events-writer-mkdir-",
      subdirs: [],
    });
    await emitEvent({ event: "task_ready", task_id: "T1" });
    const lines = await readJsonl();
    expect(lines).toHaveLength(1);
  });
});

describe("emitEvent: 書き込みエラー耐性", () => {
  test("appendFile が失敗しても throw しない（manager.log に events_writer_error を残す）", async () => {
    // events.jsonl をディレクトリとして作って appendFile を強制失敗させる
    const filePath = join(project.root, ".team/logs/events.jsonl");
    // ディレクトリ化しておくと appendFile は EISDIR で失敗する
    const { mkdir } = await import("fs/promises");
    await mkdir(filePath, { recursive: true });

    let threw = false;
    try {
      await emitEvent({ event: "task_ready", task_id: "T_err" });
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);

    const managerLog = await readFile(
      join(project.root, ".team/logs/manager.log"),
      "utf-8",
    );
    expect(managerLog).toContain("events_writer_error");
    expect(managerLog).toContain("event=task_ready");
    // error.message が detail に含まれていること
    expect(managerLog).toMatch(/message=/);
  });
});

describe("emitEvent: 並行耐性", () => {
  test("Promise.all で 100 件並行 emit → 全行 JSON.parse 成功", async () => {
    const tasks: Promise<void>[] = [];
    for (let i = 0; i < 100; i++) {
      tasks.push(emitEvent({ event: "task_ready", task_id: `T${i}` }));
    }
    await Promise.all(tasks);

    const filePath = join(project.root, ".team/logs/events.jsonl");
    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(100);
    // 全行 JSON.parse 成功（torn-write が起きていない）
    const ids = new Set<string>();
    for (const line of lines) {
      const rec = JSON.parse(line) as Record<string, unknown>;
      expect(rec.event).toBe("task_ready");
      ids.add(rec.task_id as string);
    }
    expect(ids.size).toBe(100);
  });
});

describe("emitEvent: payload type 動作", () => {
  test("task_assigned: conductor_surface / task_run_id を含む", async () => {
    await emitEvent({
      event: "task_assigned",
      task_id: "T42",
      conductor_surface: "surface:5",
      task_run_id: "task-42-1700000000",
    });
    const [rec] = (await readJsonl()) as [Record<string, unknown>];
    expect(rec.event).toBe("task_assigned");
    expect(rec.task_id).toBe("T42");
    expect(rec.conductor_surface).toBe("surface:5");
    expect(rec.task_run_id).toBe("task-42-1700000000");
  });

  test("task_completed_state_mismatch: reason=missing_close_task", async () => {
    await emitEvent({
      event: "task_completed_state_mismatch",
      task_id: "T42",
      conductor_surface: "surface:5",
      reason: "missing_close_task",
      worktree_path: "/tmp/wt",
      journal_summary: "",
    });
    const [rec] = (await readJsonl()) as [Record<string, unknown>];
    expect(rec.reason).toBe("missing_close_task");
    expect(rec.journal_summary).toBe("");
  });

  test("conductor_disconnected: optional task_id を省略してもよい", async () => {
    await emitEvent({
      event: "conductor_disconnected",
      conductor_surface: "surface:5",
      reason: "session_ended",
    });
    const [rec] = (await readJsonl()) as [Record<string, unknown>];
    expect(rec.reason).toBe("session_ended");
    expect("task_id" in rec).toBe(false);
  });

  // T392: api_error_received
  test("T392: api_error_received は role/surface/kind/message を含む", async () => {
    await emitEvent({
      event: "api_error_received",
      role: "agent",
      surface: "surface:42",
      kind: "rate_limit",
      message: "API Error: Server is temporarily limiting requests",
    });
    const [rec] = (await readJsonl()) as [Record<string, unknown>];
    expect(rec.event).toBe("api_error_received");
    expect(rec.role).toBe("agent");
    expect(rec.surface).toBe("surface:42");
    expect(rec.kind).toBe("rate_limit");
    expect(rec.message).toBe("API Error: Server is temporarily limiting requests");
  });
});

describe("mapAbortReason: 8 値 → 6 値マップ全網羅", () => {
  const cases: Array<[AbortReason, SpecAbortReason]> = [
    ["user_clear", "user_clear"],
    ["judgment_pending", "judgment_pending"],
    ["assign_failed", "assign_failed"],
    ["disconnect_timeout", "disconnect_timeout"],
    ["abort_task", "other"],
    ["resume_no_session_id", "resume_marked_aborted"],
    ["resume_no_task_run_id", "resume_marked_aborted"],
    ["resume_no_worktree", "resume_marked_aborted"],
  ];

  for (const [input, expected] of cases) {
    test(`${input} → ${expected}`, () => {
      expect(mapAbortReason(input)).toBe(expected);
    });
  }
});
