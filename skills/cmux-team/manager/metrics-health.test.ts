/**
 * T381 S7: metrics-health のテスト。
 * - findSnapshotGaps 純関数
 * - runMetricsHealthCli (引数 parse / path traversal / exit code)
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { createDummyProject, type DummyProject } from "./test-project";
import { findSnapshotGaps, runMetricsHealthCli } from "./metrics-health";

let project: DummyProject;

beforeEach(async () => {
  project = await createDummyProject({ prefix: "cmux-metrics-health-test-" });
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

async function seedSnapshots(root: string, dates: string[]): Promise<string> {
  const dir = join(root, ".team/metrics/snapshots");
  await mkdir(dir, { recursive: true });
  for (const d of dates) {
    await writeFile(join(dir, `${d}.json`), JSON.stringify({ schema_version: 1, snapshot_date: d }));
  }
  return dir;
}

describe("findSnapshotGaps (S7 純関数)", () => {
  test("today=2026-05-01, days=3 → [2026-04-29, 04-30, 05-01] のうち 1 件欠損で 1 件返す", async () => {
    const dir = await seedSnapshots(project.root, ["2026-04-29", "2026-05-01"]);
    const gaps = await findSnapshotGaps(dir, new Date("2026-05-01T00:00:00.000Z"), 3);
    expect(gaps).toEqual(["2026-04-30"]);
  });

  test("欠損ゼロで [] 返す", async () => {
    const dir = await seedSnapshots(project.root, ["2026-04-29", "2026-04-30", "2026-05-01"]);
    const gaps = await findSnapshotGaps(dir, new Date("2026-05-01T00:00:00.000Z"), 3);
    expect(gaps).toEqual([]);
  });

  test("dir が存在しなければ全日欠損扱い", async () => {
    const dir = join(project.root, "no-such-dir");
    const gaps = await findSnapshotGaps(dir, new Date("2026-05-01T00:00:00.000Z"), 2);
    expect(gaps).toEqual(["2026-04-30", "2026-05-01"]);
  });

  test("days <= 0 で throw", async () => {
    const dir = await seedSnapshots(project.root, []);
    await expect(findSnapshotGaps(dir, new Date(), 0)).rejects.toThrow();
  });
});

describe("runMetricsHealthCli (S7 CLI)", () => {
  test("--help で help 出力 + exit 0", async () => {
    const { stdout, stderr, outText } = captureStreams();
    const ac = new AbortController();
    const code = await runMetricsHealthCli({
      args: ["health", "--help"],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
      now: new Date("2026-05-01T00:00:00.000Z"),
    });
    expect(code).toBe(0);
    expect(outText().length).toBeGreaterThan(0);
  });

  test("不明フラグで exit 1", async () => {
    const { stdout, stderr, errText } = captureStreams();
    const ac = new AbortController();
    const code = await runMetricsHealthCli({
      args: ["health", "--foo"],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
    });
    expect(code).toBe(1);
    expect(errText()).toMatch(/unknown flag/);
  });

  test("欠損なし → exit 0 + json 出力 missing=[]", async () => {
    await seedSnapshots(project.root, ["2026-04-29", "2026-04-30", "2026-05-01"]);
    const { stdout, stderr, outText } = captureStreams();
    const ac = new AbortController();
    const code = await runMetricsHealthCli({
      args: ["health", "--days", "3"],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
      now: new Date("2026-05-01T00:00:00.000Z"),
    });
    expect(code).toBe(0);
    const json = JSON.parse(outText());
    expect(json.missing).toEqual([]);
    expect(json.count).toBe(0);
    expect(json.days_checked).toBe(3);
  });

  test("欠損あり → exit 1 + missing 列挙", async () => {
    await seedSnapshots(project.root, ["2026-04-29"]);
    const { stdout, stderr, outText } = captureStreams();
    const ac = new AbortController();
    const code = await runMetricsHealthCli({
      args: ["health", "--days", "3"],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
      now: new Date("2026-05-01T00:00:00.000Z"),
    });
    expect(code).toBe(1);
    const json = JSON.parse(outText());
    expect(json.missing).toContain("2026-04-30");
    expect(json.missing).toContain("2026-05-01");
    expect(json.count).toBe(2);
  });

  test("--snapshot-dir が projectRoot 外で exit 1 (--allow-outside-project 無)", async () => {
    const { stdout, stderr, errText } = captureStreams();
    const ac = new AbortController();
    const code = await runMetricsHealthCli({
      args: ["health", "--snapshot-dir", "/tmp/cmux-team-traversal-health"],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
      now: new Date("2026-05-01T00:00:00.000Z"),
    });
    expect(code).toBe(1);
    expect(errText()).toMatch(/outside.*project/i);
  });

  test("--format text", async () => {
    await seedSnapshots(project.root, []);
    const { stdout, stderr, outText } = captureStreams();
    const ac = new AbortController();
    const code = await runMetricsHealthCli({
      args: ["health", "--days", "1", "--format", "text"],
      projectRoot: project.root,
      stdout,
      stderr,
      abortSignal: ac.signal,
      now: new Date("2026-05-01T00:00:00.000Z"),
    });
    expect(code).toBe(1);
    expect(outText()).toMatch(/missing.*2026-05-01/);
  });
});
