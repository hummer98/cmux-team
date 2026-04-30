/**
 * T359: `cmux-team events` サブコマンドのテスト。
 *
 * plan.md §3.2 のテストケース 11 + follow 系 2 ケース（rotate 跨ぎ含む）を実装する。
 * fixture は `.team/logs/events.jsonl` を直接書き、`runEventsCli({ ... })` を
 * in-process で呼んで stdout / stderr / exit code を assert する。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rename, rm, writeFile, appendFile } from "fs/promises";
import { dirname, join } from "path";
import { runEventsCli } from "./events-cli";
import { EVENTS_SCHEMA_VERSION } from "./events-writer";
import { createDummyProject, type DummyProject } from "./test-project";

let project: DummyProject;

beforeEach(async () => {
  project = await createDummyProject({ prefix: "cmux-events-cli-test-" });
});

afterEach(async () => {
  await project.dispose();
});

interface CapturedStreams {
  out: string[];
  err: string[];
  stdout: { write(s: string): boolean };
  stderr: { write(s: string): boolean };
  outText(): string;
  errText(): string;
}

function captureStreams(): CapturedStreams {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: { write: (s: string) => { out.push(s); return true; } },
    stderr: { write: (s: string) => { err.push(s); return true; } },
    outText: () => out.join(""),
    errText: () => err.join(""),
  };
}

function eventsPath(root: string): string {
  return join(root, ".team/logs/events.jsonl");
}

/** 1 行 1 record の JSONL を直接書く。各 obj は schema_version / ts を含む完成形。 */
async function writeFixture(
  root: string,
  records: Array<Record<string, unknown>>,
): Promise<void> {
  const path = eventsPath(root);
  await mkdir(dirname(path), { recursive: true });
  const content = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await writeFile(path, content);
}

/** 簡易レコードを生成。ts は ISO 8601 で UTC。 */
function rec(
  event: string,
  fields: Record<string, unknown>,
  opts: { ts?: string; schemaVersion?: number } = {},
): Record<string, unknown> {
  return {
    ts: opts.ts ?? new Date().toISOString(),
    schema_version: opts.schemaVersion ?? EVENTS_SCHEMA_VERSION,
    event,
    ...fields,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// #1 events.jsonl 不在
// ──────────────────────────────────────────────────────────────────────────
describe("#1 events.jsonl 不在", () => {
  test("exit 1 / stderr に not found を含む", async () => {
    const { stdout, stderr, errText, outText } = captureStreams();
    const ac = new AbortController();
    const code = await runEventsCli({
      args: [],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
    });
    expect(code).toBe(1);
    expect(errText()).toMatch(/not found/i);
    expect(outText()).toBe("");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// #2 全件読み取り（filter なし、format=json）
// ──────────────────────────────────────────────────────────────────────────
describe("#2 全件読み取り", () => {
  test("fixture の raw 行が順序保持で stdout に出る", async () => {
    const records = [
      rec("task_created", { task_id: "T1", title: "First" }, { ts: "2026-04-27T10:00:00.000Z" }),
      rec("task_ready", { task_id: "T1" }, { ts: "2026-04-27T10:01:00.000Z" }),
      rec("task_assigned", {
        task_id: "T1",
        conductor_surface: "surface:5",
        task_run_id: "task-1-1700000000",
      }, { ts: "2026-04-27T10:02:00.000Z" }),
    ];
    await writeFixture(project.root, records);

    const { stdout, stderr, outText, errText } = captureStreams();
    const ac = new AbortController();
    const code = await runEventsCli({
      args: [],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
    });
    expect(code).toBe(0);
    const lines = outText().split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(3);
    // raw 行 (= JSON.stringify(records[i])) と一致
    for (let i = 0; i < records.length; i++) {
      expect(lines[i]).toBe(JSON.stringify(records[i]));
    }
    // warn は無し
    expect(errText()).toBe("");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// #3 --types task_completed,task_aborted
// ──────────────────────────────────────────────────────────────────────────
describe("#3 --types filter", () => {
  test("複数 type を csv で受け取り exact match のみ通す", async () => {
    const records = [
      rec("task_created", { task_id: "T1", title: "x" }),
      rec("task_completed", {
        task_id: "T1",
        conductor_surface: "surface:5",
        worktree_path: "/tmp/wt",
        journal_summary: "done",
      }),
      rec("task_aborted", { task_id: "T2", reason: "user_clear", journal_summary: "" }),
      rec("task_ready", { task_id: "T3" }),
    ];
    await writeFixture(project.root, records);

    const { stdout, stderr, outText } = captureStreams();
    const ac = new AbortController();
    const code = await runEventsCli({
      args: ["--types", "task_completed,task_aborted"],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
    });
    expect(code).toBe(0);
    const lines = outText().split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).event).toBe("task_completed");
    expect(JSON.parse(lines[1]!).event).toBe("task_aborted");
  });

  test("1 つの type のみでも csv 解釈される", async () => {
    await writeFixture(project.root, [
      rec("task_created", { task_id: "T1", title: "x" }),
      rec("task_ready", { task_id: "T1" }),
    ]);
    const { stdout, stderr, outText } = captureStreams();
    const ac = new AbortController();
    const code = await runEventsCli({
      args: ["--types", "task_ready"],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
    });
    expect(code).toBe(0);
    const lines = outText().split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).event).toBe("task_ready");
  });

  test("--types 空（'' / ', ,'）は exit 1", async () => {
    await writeFixture(project.root, [rec("task_ready", { task_id: "T1" })]);
    for (const empty of ["", ", ,", "  ,  "]) {
      const { stdout, stderr, errText } = captureStreams();
      const ac = new AbortController();
      const code = await runEventsCli({
        args: ["--types", empty],
        projectRoot: project.root,
        stdout,
        stderr,
        abortSignal: ac.signal,
      });
      expect(code).toBe(1);
      expect(errText()).toMatch(/--types/);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// #4 --since duration
// ──────────────────────────────────────────────────────────────────────────
describe("#4 --since duration", () => {
  test("5m: 5 分以内の record のみ出力", async () => {
    const now = Date.now();
    const records = [
      rec("task_ready", { task_id: "T_old" }, { ts: new Date(now - 10 * 60_000).toISOString() }),
      rec("task_ready", { task_id: "T_recent" }, { ts: new Date(now - 60_000).toISOString() }),
      rec("task_ready", { task_id: "T_now" }, { ts: new Date(now).toISOString() }),
    ];
    await writeFixture(project.root, records);

    const { stdout, stderr, outText } = captureStreams();
    const ac = new AbortController();
    const code = await runEventsCli({
      args: ["--since", "5m"],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
    });
    expect(code).toBe(0);
    const lines = outText().split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).task_id).toBe("T_recent");
    expect(JSON.parse(lines[1]!).task_id).toBe("T_now");
  });

  test("1h / 2d も解釈できる", async () => {
    const now = Date.now();
    const records = [
      rec("task_ready", { task_id: "T_3d" }, { ts: new Date(now - 3 * 86400_000).toISOString() }),
      rec("task_ready", { task_id: "T_1d" }, { ts: new Date(now - 86400_000).toISOString() }),
    ];
    await writeFixture(project.root, records);
    const { stdout, stderr, outText } = captureStreams();
    const ac = new AbortController();
    const code = await runEventsCli({
      args: ["--since", "2d"],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
    });
    expect(code).toBe(0);
    const lines = outText().split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).task_id).toBe("T_1d");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// #5 --since ISO 8601
// ──────────────────────────────────────────────────────────────────────────
describe("#5 --since ISO 8601", () => {
  test("指定時刻以降のみ出力", async () => {
    await writeFixture(project.root, [
      rec("task_ready", { task_id: "T_before" }, { ts: "2026-04-27T11:59:59.000Z" }),
      rec("task_ready", { task_id: "T_at" }, { ts: "2026-04-27T12:00:00.000Z" }),
      rec("task_ready", { task_id: "T_after" }, { ts: "2026-04-27T12:00:01.000Z" }),
    ]);
    const { stdout, stderr, outText } = captureStreams();
    const ac = new AbortController();
    const code = await runEventsCli({
      args: ["--since", "2026-04-27T12:00:00Z"],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
    });
    expect(code).toBe(0);
    const lines = outText().split("\n").filter((l) => l.length > 0);
    // since 以降 →境界含む（>= since.getTime() ではなく ts < since 排除なので at は通る）
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).task_id).toBe("T_at");
    expect(JSON.parse(lines[1]!).task_id).toBe("T_after");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// #6 --since 引数エラー
// ──────────────────────────────────────────────────────────────────────────
describe("#6 --since 引数エラー", () => {
  test("abc / 3w / 5 はエラー", async () => {
    await writeFixture(project.root, [rec("task_ready", { task_id: "T1" })]);
    for (const bad of ["abc", "3w", "5"]) {
      const { stdout, stderr, errText } = captureStreams();
      const ac = new AbortController();
      const code = await runEventsCli({
        args: ["--since", bad],
        projectRoot: project.root,
        stdout,
        stderr,
        abortSignal: ac.signal,
      });
      expect(code).toBe(1);
      expect(errText()).toMatch(/--since/);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────────
// #7 --format text の 17 event すべての mapping
// ──────────────────────────────────────────────────────────────────────────
describe("#7 --format text", () => {
  test("17 event 全てが <ts> <event> key=value... 形式で出る", async () => {
    const ts = "2026-04-27T12:34:56.789Z";
    const records: Array<Record<string, unknown>> = [
      rec("task_created", { task_id: "T1", title: "Add login" }, { ts }),
      rec("task_ready", { task_id: "T1" }, { ts }),
      rec("task_assigned", {
        task_id: "T1",
        conductor_surface: "surface:5",
        task_run_id: "task-1-1700000000",
      }, { ts }),
      rec("task_completed", {
        task_id: "T1",
        conductor_surface: "surface:5",
        worktree_path: "/tmp/wt-1",
        journal_summary: "done",
      }, { ts }),
      rec("task_completed_state_mismatch", {
        task_id: "T1",
        conductor_surface: "surface:5",
        reason: "missing_close_task",
        worktree_path: "/tmp/wt with space",
        journal_summary: "long\ntext",
      }, { ts }),
      rec("task_aborted", {
        task_id: "T1",
        reason: "user_clear",
        journal_summary: "",
      }, { ts }),
      rec("task_sync_guard_rejected", {
        task_id: "T1",
        kind: "diverged",
        main_branch: "main",
        detail: "ahead=2 behind=1",
      }, { ts }),
      rec("task_reverted_to_ready", { task_id: "T1", reason: "worktree_missing" }, { ts }),
      rec("conductor_running", { conductor_surface: "surface:5", task_id: "T1" }, { ts }),
      rec("conductor_recovered", { conductor_surface: "surface:5", new_status: "idle" }, { ts }),
      rec("conductor_disconnected", {
        conductor_surface: "surface:5",
        reason: "session_ended",
        task_id: "T1",
      }, { ts }),
      rec("conductor_asking", {
        conductor_surface: "surface:5",
        question: 'Why did you do "X"?',
      }, { ts }),
      rec("conductor_done_unresolved", {
        task_id: "T1",
        conductor_surface: "surface:5",
        worktree_path: "/tmp/wt",
        journal_summary: "summary",
      }, { ts }),
      rec("conductor_start_timeout", {
        conductor_surface: "surface:5",
        elapsed_ms: 5000,
      }, { ts }),
      rec("conductor_assign_timeout", {
        conductor_surface: "surface:5",
        task_run_id: "task-1-1700000000",
        elapsed_ms: 30000,
      }, { ts }),
      rec("conductor_disconnect_timeout", {
        conductor_surface: "surface:5",
        elapsed_ms: 60000,
        task_id: "T1",
      }, { ts }),
      rec("api_error_received", {
        surface: "surface:42",
        role: "agent",
        kind: "rate_limit",
        message: "Server is temporarily limiting requests",
      }, { ts }),
    ];
    await writeFixture(project.root, records);

    const { stdout, stderr, outText, errText } = captureStreams();
    const ac = new AbortController();
    const code = await runEventsCli({
      args: ["--format", "text"],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
    });
    expect(code).toBe(0);
    expect(errText()).toBe("");

    const lines = outText().split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(17);

    // 各行は <ts> <event> ... で始まる
    expect(lines[0]).toBe(`${ts} task_created task_id=T1 title="Add login"`);
    expect(lines[1]).toBe(`${ts} task_ready task_id=T1`);
    expect(lines[2]).toBe(
      `${ts} task_assigned task_id=T1 conductor_surface=surface:5 task_run_id=task-1-1700000000`,
    );
    expect(lines[3]).toBe(
      `${ts} task_completed task_id=T1 conductor_surface=surface:5 worktree_path=/tmp/wt-1`,
    );
    // worktree_path にスペース → quote
    expect(lines[4]).toBe(
      `${ts} task_completed_state_mismatch task_id=T1 conductor_surface=surface:5 reason=missing_close_task worktree_path="/tmp/wt with space"`,
    );
    expect(lines[5]).toBe(`${ts} task_aborted task_id=T1 reason=user_clear`);
    // detail にスペース → quote
    expect(lines[6]).toBe(
      `${ts} task_sync_guard_rejected task_id=T1 kind=diverged main_branch=main detail="ahead=2 behind=1"`,
    );
    expect(lines[7]).toBe(`${ts} task_reverted_to_ready task_id=T1 reason=worktree_missing`);
    expect(lines[8]).toBe(`${ts} conductor_running conductor_surface=surface:5 task_id=T1`);
    expect(lines[9]).toBe(
      `${ts} conductor_recovered conductor_surface=surface:5 new_status=idle`,
    );
    expect(lines[10]).toBe(
      `${ts} conductor_disconnected conductor_surface=surface:5 reason=session_ended task_id=T1`,
    );
    // question に " と スペース → quote (JSON.stringify エスケープ)
    expect(lines[11]).toBe(
      `${ts} conductor_asking conductor_surface=surface:5 question=${JSON.stringify('Why did you do "X"?')}`,
    );
    // journal_summary は省略される
    expect(lines[12]).toBe(
      `${ts} conductor_done_unresolved task_id=T1 conductor_surface=surface:5 worktree_path=/tmp/wt`,
    );
    expect(lines[12]).not.toMatch(/journal_summary/);

    expect(lines[13]).toBe(
      `${ts} conductor_start_timeout conductor_surface=surface:5 elapsed_ms=5000`,
    );
    expect(lines[14]).toBe(
      `${ts} conductor_assign_timeout conductor_surface=surface:5 task_run_id=task-1-1700000000 elapsed_ms=30000`,
    );
    expect(lines[15]).toBe(
      `${ts} conductor_disconnect_timeout conductor_surface=surface:5 elapsed_ms=60000 task_id=T1`,
    );
    expect(lines[16]).toBe(
      `${ts} api_error_received surface=surface:42 role=agent kind=rate_limit message="Server is temporarily limiting requests"`,
    );
  });

  test("conductor_disconnected の optional task_id 省略", async () => {
    const ts = "2026-04-27T12:34:56.789Z";
    await writeFixture(project.root, [
      rec("conductor_disconnected", {
        conductor_surface: "surface:5",
        reason: "pid_dead",
      }, { ts }),
    ]);
    const { stdout, stderr, outText } = captureStreams();
    const ac = new AbortController();
    const code = await runEventsCli({
      args: ["--format", "text"],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
    });
    expect(code).toBe(0);
    const lines = outText().split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(`${ts} conductor_disconnected conductor_surface=surface:5 reason=pid_dead`);
    expect(lines[0]).not.toMatch(/task_id/);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// #8 不正 JSON 行 skip + warning
// ──────────────────────────────────────────────────────────────────────────
describe("#8 不正 JSON 行", () => {
  test("不正行は skip + stderr に warn、後続 valid 行は出る", async () => {
    const path = eventsPath(project.root);
    await mkdir(dirname(path), { recursive: true });
    const valid = rec("task_ready", { task_id: "T1" }, { ts: "2026-04-27T10:00:00.000Z" });
    const valid2 = rec("task_ready", { task_id: "T2" }, { ts: "2026-04-27T10:01:00.000Z" });
    const content =
      JSON.stringify(valid) + "\n" +
      "{not json}\n" +
      JSON.stringify(valid2) + "\n";
    await writeFile(path, content);

    const { stdout, stderr, outText, errText } = captureStreams();
    const ac = new AbortController();
    const code = await runEventsCli({
      args: [],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
    });
    expect(code).toBe(0);
    const outLines = outText().split("\n").filter((l) => l.length > 0);
    expect(outLines).toHaveLength(2);
    expect(JSON.parse(outLines[0]!).task_id).toBe("T1");
    expect(JSON.parse(outLines[1]!).task_id).toBe("T2");
    expect(errText()).toMatch(/invalid JSON/i);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// #9 schema_version=3 を skip + warn
// ──────────────────────────────────────────────────────────────────────────
describe("#9 schema_version 範囲外", () => {
  test("v3 は skip + warn (exit 0)", async () => {
    await writeFixture(project.root, [
      rec("task_ready", { task_id: "T1" }, { schemaVersion: 2 }),
      rec("task_ready", { task_id: "T2" }, { schemaVersion: 3 }),
      rec("task_ready", { task_id: "T3" }, { schemaVersion: 1 }),
    ]);
    const { stdout, stderr, outText, errText } = captureStreams();
    const ac = new AbortController();
    const code = await runEventsCli({
      args: [],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
    });
    expect(code).toBe(0);
    const outLines = outText().split("\n").filter((l) => l.length > 0);
    expect(outLines).toHaveLength(1);
    expect(JSON.parse(outLines[0]!).task_id).toBe("T1");
    // v3 / v1 ともに warn が出る
    expect(errText()).toMatch(/schema_version=3/);
    expect(errText()).toMatch(/schema_version=1/);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// #10 未知 event=foo を skip + warn
// ──────────────────────────────────────────────────────────────────────────
describe("#10 未知 event", () => {
  test("event=foo は skip + warn", async () => {
    await writeFixture(project.root, [
      rec("task_ready", { task_id: "T1" }),
      rec("foo_event_unknown", { whatever: 1 }),
      rec("task_ready", { task_id: "T2" }),
    ]);
    const { stdout, stderr, outText, errText } = captureStreams();
    const ac = new AbortController();
    const code = await runEventsCli({
      args: [],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
    });
    expect(code).toBe(0);
    const outLines = outText().split("\n").filter((l) => l.length > 0);
    expect(outLines).toHaveLength(2);
    expect(JSON.parse(outLines[0]!).task_id).toBe("T1");
    expect(JSON.parse(outLines[1]!).task_id).toBe("T2");
    expect(errText()).toMatch(/unknown event=foo_event_unknown/);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// #11 引数エラー
// ──────────────────────────────────────────────────────────────────────────
describe("#11 引数エラー", () => {
  test("--format yaml は exit 1", async () => {
    await writeFixture(project.root, [rec("task_ready", { task_id: "T1" })]);
    const { stdout, stderr, errText } = captureStreams();
    const ac = new AbortController();
    const code = await runEventsCli({
      args: ["--format", "yaml"],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
    });
    expect(code).toBe(1);
    expect(errText()).toMatch(/--format/);
  });

  test("未知 flag --bogus は exit 1", async () => {
    await writeFixture(project.root, [rec("task_ready", { task_id: "T1" })]);
    const { stdout, stderr, errText } = captureStreams();
    const ac = new AbortController();
    const code = await runEventsCli({
      args: ["--bogus", "x"],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
    });
    expect(code).toBe(1);
    expect(errText()).toMatch(/--bogus|unknown/i);
  });

  test("--types に値なしは exit 1", async () => {
    await writeFixture(project.root, [rec("task_ready", { task_id: "T1" })]);
    const { stdout, stderr, errText } = captureStreams();
    const ac = new AbortController();
    const code = await runEventsCli({
      args: ["--types"],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
    });
    expect(code).toBe(1);
    expect(errText()).toMatch(/--types/);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// #12 follow + 後発 append
// ──────────────────────────────────────────────────────────────────────────
describe("#12 --follow append", () => {
  test("起動後の append を順次拾う、abort で exit 0", async () => {
    const initial = [rec("task_ready", { task_id: "T1" }, { ts: "2026-04-27T10:00:00.000Z" })];
    await writeFixture(project.root, initial);

    const { stdout, stderr, outText } = captureStreams();
    const ac = new AbortController();
    const promise = runEventsCli({
      args: ["--follow"],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
      pollIntervalMs: 20,
    });

    // 初期 1 件が出力されるまで待つ
    await waitUntil(() => outText().split("\n").filter(Boolean).length >= 1, 2000);

    // 追加 append
    const path = eventsPath(project.root);
    const next = rec("task_ready", { task_id: "T2" }, { ts: "2026-04-27T10:01:00.000Z" });
    await appendFile(path, JSON.stringify(next) + "\n");

    // 2 件目が出るまで待つ
    await waitUntil(() => outText().split("\n").filter(Boolean).length >= 2, 2000);

    ac.abort();
    const code = await promise;
    expect(code).toBe(0);
    const lines = outText().split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(lines[0]!).task_id).toBe("T1");
    expect(JSON.parse(lines[1]!).task_id).toBe("T2");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// #13 follow + rotate
// ──────────────────────────────────────────────────────────────────────────
describe("#13 --follow rotate", () => {
  test("inode 変化を検知して新ファイルを先頭から読む（重複出力許容）", async () => {
    const ts1 = "2026-04-27T10:00:00.000Z";
    const ts2 = "2026-04-27T10:00:01.000Z";
    await writeFixture(project.root, [
      rec("task_ready", { task_id: "T_old1" }, { ts: ts1 }),
      rec("task_ready", { task_id: "T_old2" }, { ts: ts2 }),
    ]);

    const { stdout, stderr, outText } = captureStreams();
    const ac = new AbortController();
    const promise = runEventsCli({
      args: ["--follow"],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
      pollIntervalMs: 20,
    });

    // 旧ファイルの 2 件を捌くまで待つ
    await waitUntil(() => outText().split("\n").filter(Boolean).length >= 2, 2000);

    // rotate（rename + 新ファイル作成）
    const path = eventsPath(project.root);
    await rename(path, path + ".1");
    const newRec = rec("task_ready", { task_id: "T_new" }, { ts: "2026-04-27T11:00:00.000Z" });
    await writeFile(path, JSON.stringify(newRec) + "\n");

    // 新ファイルの 1 件が拾われるまで待つ
    await waitUntil(() => {
      const lines = outText().split("\n").filter(Boolean);
      return lines.some((l) => {
        try {
          return JSON.parse(l).task_id === "T_new";
        } catch {
          return false;
        }
      });
    }, 2000);

    ac.abort();
    const code = await promise;
    expect(code).toBe(0);
    const lines = outText().split("\n").filter((l) => l.length > 0);
    const ids = lines.map((l) => JSON.parse(l).task_id);
    expect(ids).toContain("T_old1");
    expect(ids).toContain("T_old2");
    expect(ids).toContain("T_new");
  });
});

async function waitUntil(
  pred: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitUntil timeout after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}
