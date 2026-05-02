/**
 * T412: cmux-team metrics query (DuckDB ad-hoc CLI) のテスト。
 *
 * - 引数 parse (S1): --sql / stdin / --format / --explain / --help / 不正 flag
 * - init SQL ビルダ (S2): traces.db / events.jsonl / snapshot dir 在/不在の組み合わせ
 * - resolveDuckdbBin (S3): env > PATH > null
 * - --explain (S4): user SQL を EXPLAIN prefix
 * - end-to-end via fake duckdb (S3/S7): stdin に init+user SQL が渡る、stdout relay
 * - --sql と stdin 同時指定 → --sql 優先 (Reviewer Recommendation #3)
 * - abortSignal 発火で fake duckdb が SIGTERM される
 *
 * テスト戦略:
 *   実 duckdb binary に依存しない。fake-duckdb.sh を tmp dir に置き
 *   DUCKDB_BIN env でそれを指すようにする。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from "fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "os";
import { join } from "path";
import { createDummyProject, type DummyProject } from "./test-project";
import {
  runMetricsQueryCli,
  buildInitSql,
  resolveDuckdbBin,
  parseQueryArgs,
  formatToFlag,
} from "./metrics-query";

let project: DummyProject;
let fakeBinDir: string;
let fakeDuckdb: string;
let savedDuckdbBin: string | undefined;

beforeEach(async () => {
  project = await createDummyProject({ prefix: "cmux-metrics-query-test-" });
  fakeBinDir = await mkdtemp(join(tmpdir(), "cmux-fake-duckdb-"));
  fakeDuckdb = join(fakeBinDir, "fake-duckdb.sh");
  savedDuckdbBin = process.env.DUCKDB_BIN;
});

afterEach(async () => {
  await project.dispose();
  await rm(fakeBinDir, { recursive: true, force: true });
  if (savedDuckdbBin === undefined) delete process.env.DUCKDB_BIN;
  else process.env.DUCKDB_BIN = savedDuckdbBin;
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

/**
 * fake duckdb を install する。
 *  - stdin を `$INPUT_PATH` (env) に保存
 *  - flag 一覧を `$FLAGS_PATH` に保存
 *  - exit code は env `EXIT_CODE` (default 0)
 *  - stdout に `STDOUT` 環境変数の内容を流す（デフォルト "ROW\n"）
 *  - SIGTERM を受けたら exit 143
 */
async function installFakeDuckdb(opts: { exitCode?: number; stdout?: string } = {}): Promise<void> {
  const exitCode = opts.exitCode ?? 0;
  const stdoutText = opts.stdout ?? "ROW\n";
  const script = `#!/bin/bash
# Fake duckdb for testing. Records all flags and stdin to side channels.
# SIGTERM-friendly: handle signal explicitly to exit 143.
trap 'exit 143' TERM
: > "\${INPUT_PATH:-/tmp/fake-duckdb-stdin.txt}"
echo "$@" > "\${FLAGS_PATH:-/tmp/fake-duckdb-flags.txt}"
cat - > "\${INPUT_PATH:-/tmp/fake-duckdb-stdin.txt}"
if [ -n "\${SLEEP_SECS:-}" ]; then
  sleep "\${SLEEP_SECS}" &
  wait $!
fi
printf '%s' "${stdoutText.replace(/'/g, "'\\''")}"
exit ${exitCode}
`;
  await writeFile(fakeDuckdb, script);
  await chmod(fakeDuckdb, 0o755);
}

// ────────────────────────────────────────────────────────────────────────
// S1: parseQueryArgs
// ────────────────────────────────────────────────────────────────────────

describe("parseQueryArgs (S1)", () => {
  test("--sql + --format json", () => {
    const p = parseQueryArgs(["--sql", "SELECT 1", "--format", "json"]);
    expect(p.sql).toBe("SELECT 1");
    expect(p.format).toBe("json");
    expect(p.explain).toBe(false);
    expect(p.help).toBe(false);
  });

  test("デフォルト format=table", () => {
    const p = parseQueryArgs(["--sql", "SELECT 1"]);
    expect(p.format).toBe("table");
  });

  test("--explain flag", () => {
    const p = parseQueryArgs(["--sql", "SELECT 1", "--explain"]);
    expect(p.explain).toBe(true);
  });

  test("--help / -h", () => {
    expect(parseQueryArgs(["--help"]).help).toBe(true);
    expect(parseQueryArgs(["-h"]).help).toBe(true);
  });

  test("不正 flag は throw", () => {
    expect(() => parseQueryArgs(["--bogus"])).toThrow();
  });

  test("--format 不正値は throw", () => {
    expect(() => parseQueryArgs(["--sql", "x", "--format", "yaml"])).toThrow();
  });

  test("--sql に値が無いと throw", () => {
    expect(() => parseQueryArgs(["--sql"])).toThrow();
  });

  test("--format に値が無いと throw", () => {
    expect(() => parseQueryArgs(["--sql", "x", "--format"])).toThrow();
  });

  test("--format 受理: json/csv/tsv/table", () => {
    for (const f of ["json", "csv", "tsv", "table"] as const) {
      expect(parseQueryArgs(["--sql", "x", "--format", f]).format).toBe(f);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// S2: buildInitSql
// ────────────────────────────────────────────────────────────────────────

describe("buildInitSql (S2)", () => {
  test("traces.db / events.jsonl / snapshot dir すべて存在 → 全 ATTACH + view", async () => {
    // trace DB を seed
    const dbPath = join(project.root, ".team/traces/traces.db");
    await mkdir(join(project.root, ".team/traces"), { recursive: true });
    await writeFile(dbPath, ""); // 中身空でも existsSync さえ通れば OK

    // events.jsonl
    await mkdir(join(project.root, ".team/logs"), { recursive: true });
    await writeFile(join(project.root, ".team/logs/events.jsonl"), "");

    // snapshot dir
    const snapDir = join(project.root, ".team/metrics/snapshots");
    await mkdir(snapDir, { recursive: true });
    await writeFile(join(snapDir, "2026-05-01.json"), "{}");

    const sql = buildInitSql(project.root);
    expect(sql).toContain("INSTALL sqlite");
    expect(sql).toContain("LOAD sqlite");
    expect(sql).toContain(`ATTACH '${dbPath}' AS t (TYPE sqlite, READ_ONLY)`);
    expect(sql).toContain("CREATE OR REPLACE VIEW events AS");
    expect(sql).toContain("CREATE OR REPLACE VIEW snapshots AS");
    expect(sql).toContain("CREATE OR REPLACE VIEW snapshots_per_task AS");
    expect(sql).toContain("union_by_name=true");
    expect(sql).toContain("ignore_errors=true");
  });

  test("traces.db 不在 → ATTACH 行が省略される", () => {
    const sql = buildInitSql(project.root);
    expect(sql).not.toContain("ATTACH");
  });

  test("events.jsonl 不在 → events view が省略される", () => {
    const sql = buildInitSql(project.root);
    expect(sql).not.toContain("CREATE OR REPLACE VIEW events");
  });

  test("snapshot dir 不在 → snapshots view が省略される", () => {
    const sql = buildInitSql(project.root);
    expect(sql).not.toContain("CREATE OR REPLACE VIEW snapshots");
  });

  test("snapshot dir 空 → snapshots view が省略される", async () => {
    await mkdir(join(project.root, ".team/metrics/snapshots"), { recursive: true });
    const sql = buildInitSql(project.root);
    expect(sql).not.toContain("CREATE OR REPLACE VIEW snapshots");
  });

  test("path に含まれる single quote が SQL escape される", async () => {
    // "It's" を含む project root を作る
    const oddRoot = await mkdtemp(join(tmpdir(), "cmux-odd's-"));
    await mkdir(join(oddRoot, ".team/traces"), { recursive: true });
    await writeFile(join(oddRoot, ".team/traces/traces.db"), "");
    try {
      const sql = buildInitSql(oddRoot);
      expect(sql).toContain("''"); // quote escaped
      // 元の単一 quote が naked で残っていないこと（path 内のみ）
      const attachLine = sql.split("\n").find((l) => l.includes("ATTACH"));
      expect(attachLine).toBeDefined();
      // Attach 行内に escape された path が含まれる
      expect(attachLine).toContain(oddRoot.replace(/'/g, "''"));
    } finally {
      await rm(oddRoot, { recursive: true, force: true });
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// S3: resolveDuckdbBin / formatToFlag
// ────────────────────────────────────────────────────────────────────────

describe("resolveDuckdbBin (S3)", () => {
  test("env DUCKDB_BIN が最優先", () => {
    const which = (_bin: string) => "/usr/bin/duckdb";
    const r = resolveDuckdbBin({ env: { DUCKDB_BIN: "/opt/d/duckdb" }, which });
    expect(r).toBe("/opt/d/duckdb");
  });

  test("env なし → PATH (which) を使う", () => {
    const which = (_bin: string) => "/usr/local/bin/duckdb";
    expect(resolveDuckdbBin({ env: {}, which })).toBe("/usr/local/bin/duckdb");
  });

  test("env なし & PATH なし → null", () => {
    const which = (_bin: string) => null;
    expect(resolveDuckdbBin({ env: {}, which })).toBeNull();
  });

  test("env が空文字列 → 無視して PATH に fallback", () => {
    const which = (_bin: string) => "/x/duckdb";
    expect(resolveDuckdbBin({ env: { DUCKDB_BIN: "" }, which })).toBe("/x/duckdb");
  });
});

describe("formatToFlag (S3)", () => {
  test("各 format → DuckDB CLI flag list", () => {
    expect(formatToFlag("json")).toEqual(["-json"]);
    expect(formatToFlag("csv")).toEqual(["-csv"]);
    // Reviewer Recommendation #1: tsv は -csv -separator "\t"
    expect(formatToFlag("tsv")).toEqual(["-csv", "-separator", "\t"]);
    expect(formatToFlag("table")).toEqual(["-box"]);
  });
});

// ────────────────────────────────────────────────────────────────────────
// S3 + S4 + S7: end-to-end via fake duckdb
// ────────────────────────────────────────────────────────────────────────

describe("runMetricsQueryCli end-to-end (S3 / S4 / S7)", () => {
  test("--help で help 表示 + exit 0", async () => {
    const cap = captureStreams();
    const code = await runMetricsQueryCli({
      args: ["query", "--help"],
      projectRoot: project.root,
      stdout: cap.stdout,
      stderr: cap.stderr,
      abortSignal: new AbortController().signal,
    });
    expect(code).toBe(0);
    expect(cap.outText().length).toBeGreaterThan(0);
  });

  test("不正 flag で exit 1 + stderr に error", async () => {
    const cap = captureStreams();
    const code = await runMetricsQueryCli({
      args: ["query", "--bogus"],
      projectRoot: project.root,
      stdout: cap.stdout,
      stderr: cap.stderr,
      abortSignal: new AbortController().signal,
    });
    expect(code).toBe(1);
    expect(cap.errText()).toContain("Error");
  });

  test("--sql 無し & stdin TTY → usage + exit 1", async () => {
    const cap = captureStreams();
    const code = await runMetricsQueryCli({
      args: ["query"],
      projectRoot: project.root,
      stdout: cap.stdout,
      stderr: cap.stderr,
      abortSignal: new AbortController().signal,
      stdinIsTTY: true,
    });
    expect(code).toBe(1);
    expect(cap.errText().length).toBeGreaterThan(0);
  });

  test("DuckDB binary 不在 → install 案内 + exit 1", async () => {
    process.env.DUCKDB_BIN = ""; // env-empty
    const cap = captureStreams();
    const code = await runMetricsQueryCli({
      args: ["query", "--sql", "SELECT 1"],
      projectRoot: project.root,
      stdout: cap.stdout,
      stderr: cap.stderr,
      abortSignal: new AbortController().signal,
      // 注入で which が常に null を返すようにする
      which: () => null,
    });
    expect(code).toBe(1);
    expect(cap.errText()).toContain("duckdb");
    expect(cap.errText()).toContain("brew install duckdb");
    expect(cap.errText()).toContain("DUCKDB_BIN");
    // Reviewer Recommendation #5: 0.10+ 推奨を 1 行記載
    expect(cap.errText()).toContain("0.10");
  });

  test("fake duckdb に stdin 経由で init+user SQL が渡る (--sql)", async () => {
    await installFakeDuckdb();
    const inputPath = join(fakeBinDir, "stdin.txt");
    const flagsPath = join(fakeBinDir, "flags.txt");
    process.env.DUCKDB_BIN = fakeDuckdb;
    process.env.INPUT_PATH = inputPath;
    process.env.FLAGS_PATH = flagsPath;

    const cap = captureStreams();
    const code = await runMetricsQueryCli({
      args: ["query", "--sql", "SELECT 42"],
      projectRoot: project.root,
      stdout: cap.stdout,
      stderr: cap.stderr,
      abortSignal: new AbortController().signal,
    });

    expect(code).toBe(0);
    const stdinContent = await readFile(inputPath, "utf8");
    expect(stdinContent).toContain("SELECT 42");
    // flags に -box (default --format=table)、最後に :memory: が並ぶ
    const flags = await readFile(flagsPath, "utf8");
    expect(flags).toContain("-box");
    expect(flags).toContain(":memory:");
    expect(cap.outText()).toContain("ROW");

    delete process.env.INPUT_PATH;
    delete process.env.FLAGS_PATH;
  });

  test("--format json で -json が DuckDB に渡る", async () => {
    await installFakeDuckdb();
    const flagsPath = join(fakeBinDir, "flags.txt");
    process.env.DUCKDB_BIN = fakeDuckdb;
    process.env.INPUT_PATH = join(fakeBinDir, "stdin.txt");
    process.env.FLAGS_PATH = flagsPath;

    const cap = captureStreams();
    const code = await runMetricsQueryCli({
      args: ["query", "--sql", "SELECT 1", "--format", "json"],
      projectRoot: project.root,
      stdout: cap.stdout,
      stderr: cap.stderr,
      abortSignal: new AbortController().signal,
    });
    expect(code).toBe(0);
    const flags = await readFile(flagsPath, "utf8");
    expect(flags).toContain("-json");
    delete process.env.INPUT_PATH;
    delete process.env.FLAGS_PATH;
  });

  test("--explain で stdin 内に EXPLAIN prefix が入る (S4)", async () => {
    await installFakeDuckdb();
    const inputPath = join(fakeBinDir, "stdin.txt");
    process.env.DUCKDB_BIN = fakeDuckdb;
    process.env.INPUT_PATH = inputPath;
    process.env.FLAGS_PATH = join(fakeBinDir, "flags.txt");

    const cap = captureStreams();
    const code = await runMetricsQueryCli({
      args: ["query", "--sql", "SELECT 1", "--explain"],
      projectRoot: project.root,
      stdout: cap.stdout,
      stderr: cap.stderr,
      abortSignal: new AbortController().signal,
    });
    expect(code).toBe(0);
    const stdinContent = await readFile(inputPath, "utf8");
    // user SQL の直前に EXPLAIN
    expect(stdinContent).toContain("EXPLAIN SELECT 1");
    delete process.env.INPUT_PATH;
    delete process.env.FLAGS_PATH;
  });

  test("--sql と stdin 両方指定 → --sql が優先される (Reviewer Rec #3)", async () => {
    await installFakeDuckdb();
    const inputPath = join(fakeBinDir, "stdin.txt");
    process.env.DUCKDB_BIN = fakeDuckdb;
    process.env.INPUT_PATH = inputPath;
    process.env.FLAGS_PATH = join(fakeBinDir, "flags.txt");

    const cap = captureStreams();
    const stdinSrc = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("SELECT 999"));
        controller.close();
      },
    });
    const code = await runMetricsQueryCli({
      args: ["query", "--sql", "SELECT 42"],
      projectRoot: project.root,
      stdout: cap.stdout,
      stderr: cap.stderr,
      abortSignal: new AbortController().signal,
      stdinIsTTY: false,
      stdinStream: stdinSrc,
    });
    expect(code).toBe(0);
    const stdinContent = await readFile(inputPath, "utf8");
    expect(stdinContent).toContain("SELECT 42");
    expect(stdinContent).not.toContain("SELECT 999");
    delete process.env.INPUT_PATH;
    delete process.env.FLAGS_PATH;
  });

  test("stdin から SQL を読む (--sql 無し、TTY でない)", async () => {
    await installFakeDuckdb();
    const inputPath = join(fakeBinDir, "stdin.txt");
    process.env.DUCKDB_BIN = fakeDuckdb;
    process.env.INPUT_PATH = inputPath;
    process.env.FLAGS_PATH = join(fakeBinDir, "flags.txt");

    const cap = captureStreams();
    const stdinSrc = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("SELECT 'from-stdin'"));
        controller.close();
      },
    });
    const code = await runMetricsQueryCli({
      args: ["query"],
      projectRoot: project.root,
      stdout: cap.stdout,
      stderr: cap.stderr,
      abortSignal: new AbortController().signal,
      stdinIsTTY: false,
      stdinStream: stdinSrc,
    });
    expect(code).toBe(0);
    const stdinContent = await readFile(inputPath, "utf8");
    expect(stdinContent).toContain("from-stdin");
    delete process.env.INPUT_PATH;
    delete process.env.FLAGS_PATH;
  });

  test("DuckDB が non-zero exit → exit code が relay される", async () => {
    await installFakeDuckdb({ exitCode: 7, stdout: "" });
    process.env.DUCKDB_BIN = fakeDuckdb;
    process.env.INPUT_PATH = join(fakeBinDir, "stdin.txt");
    process.env.FLAGS_PATH = join(fakeBinDir, "flags.txt");

    const cap = captureStreams();
    const code = await runMetricsQueryCli({
      args: ["query", "--sql", "SELECT 1"],
      projectRoot: project.root,
      stdout: cap.stdout,
      stderr: cap.stderr,
      abortSignal: new AbortController().signal,
    });
    expect(code).toBe(7);
    delete process.env.INPUT_PATH;
    delete process.env.FLAGS_PATH;
  });

  test("abortSignal 発火で fake duckdb が SIGTERM 終了 (exit 143 が relay)", async () => {
    await installFakeDuckdb();
    process.env.DUCKDB_BIN = fakeDuckdb;
    process.env.INPUT_PATH = join(fakeBinDir, "stdin.txt");
    process.env.FLAGS_PATH = join(fakeBinDir, "flags.txt");
    process.env.SLEEP_SECS = "5";

    const ac = new AbortController();
    const cap = captureStreams();
    const promise = runMetricsQueryCli({
      args: ["query", "--sql", "SELECT 1"],
      projectRoot: project.root,
      stdout: cap.stdout,
      stderr: cap.stderr,
      abortSignal: ac.signal,
    });
    // 200ms 待ってから abort
    await new Promise((r) => setTimeout(r, 200));
    ac.abort();
    const code = await promise;
    // Bun.spawn は signal で kill されると exitCode が null か非0 になる
    expect(code).not.toBe(0);

    delete process.env.INPUT_PATH;
    delete process.env.FLAGS_PATH;
    delete process.env.SLEEP_SECS;
  }, 10000);
});
