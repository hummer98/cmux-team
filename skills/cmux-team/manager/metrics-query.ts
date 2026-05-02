/**
 * T412: cmux-team metrics query — DuckDB ad-hoc CLI wrapper。
 *
 * 設計（plan §2 / §13 参照）:
 *  - 外部 `duckdb` binary を Bun.spawn で起動する薄い wrapper。
 *  - init SQL を pre-pend してから user SQL を流す。init SQL は traces.db
 *    （SQLite ATTACH READ_ONLY）+ events.jsonl + snapshots/*.json を
 *    DuckDB の view として登録する。
 *  - 不在ファイルは silent skip + stderr warn（best-effort 原則）。
 *  - format flag の DuckDB CLI 直結:
 *      json  → -json
 *      csv   → -csv
 *      tsv   → -csv -separator "\t"  (Reviewer rec #1)
 *      table → -box (DuckDB 0.10+ 推奨)
 *  - SQL injection 心配なし: user 入力はそのまま DuckDB に渡される。
 *    READ_ONLY ATTACH と projectRoot 内 file 限定なので escalation 経路無し。
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "path";
import { warn } from "./logger";
import { t } from "./i18n";

export type QueryFormat = "json" | "csv" | "tsv" | "table";

export interface ParsedQueryArgs {
  /** --sql で渡された SQL（無ければ null） */
  sql: string | null;
  format: QueryFormat;
  explain: boolean;
  help: boolean;
}

const QUERY_FLAGS = new Set(["--sql", "--format", "--explain", "--help", "-h"]);
const QUERY_FLAGS_WITH_VALUE = new Set(["--sql", "--format"]);
const VALID_FORMATS: ReadonlySet<QueryFormat> = new Set(["json", "csv", "tsv", "table"]);

class ArgError extends Error {}

export function parseQueryArgs(argv: string[]): ParsedQueryArgs {
  const out: ParsedQueryArgs = {
    sql: null,
    format: "table",
    explain: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!QUERY_FLAGS.has(a)) {
      throw new ArgError(`unknown flag: ${a}`);
    }
    if (a === "--help" || a === "-h") {
      out.help = true;
      continue;
    }
    if (a === "--explain") {
      out.explain = true;
      continue;
    }
    if (QUERY_FLAGS_WITH_VALUE.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || QUERY_FLAGS.has(v)) {
        throw new ArgError(`${a} requires a value`);
      }
      i++;
      if (a === "--sql") {
        out.sql = v;
      } else if (a === "--format") {
        if (!VALID_FORMATS.has(v as QueryFormat)) {
          throw new ArgError(`--format must be one of json|csv|tsv|table: got ${v}`);
        }
        out.format = v as QueryFormat;
      }
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────
// S2: init SQL ビルダ
// ────────────────────────────────────────────────────────────────────────

function escapeSqlString(s: string): string {
  return s.replace(/'/g, "''");
}

/**
 * init SQL を組み立てる。各 source の存在判定:
 *  - traces.db 不在 → ATTACH 行 / SQLite extension load 自体を全部省略
 *  - events.jsonl 不在 → events view 省略
 *  - snapshot dir に *.json が 0 件 → snapshots / snapshots_per_task view 省略
 */
export function buildInitSql(projectRoot: string): string {
  const lines: string[] = [];

  const dbPath = join(projectRoot, ".team/traces/traces.db");
  if (existsSync(dbPath)) {
    lines.push("INSTALL sqlite;");
    lines.push("LOAD sqlite;");
    lines.push(`ATTACH '${escapeSqlString(dbPath)}' AS t (TYPE sqlite, READ_ONLY);`);
  }

  const eventsPath = join(projectRoot, ".team/logs/events.jsonl");
  if (existsSync(eventsPath)) {
    lines.push(
      "CREATE OR REPLACE VIEW events AS",
      `  SELECT * FROM read_json('${escapeSqlString(eventsPath)}',`,
      "                          format='newline_delimited',",
      "                          union_by_name=true,",
      "                          ignore_errors=true);",
    );
  }

  const snapshotDir = join(projectRoot, ".team/metrics/snapshots");
  if (snapshotDirHasJson(snapshotDir)) {
    const glob = join(snapshotDir, "*.json");
    lines.push(
      "CREATE OR REPLACE VIEW snapshots AS",
      `  SELECT * FROM read_json('${escapeSqlString(glob)}',`,
      "                          format='auto',",
      "                          union_by_name=true,",
      "                          ignore_errors=true);",
      "CREATE OR REPLACE VIEW snapshots_per_task AS",
      "  SELECT s.snapshot_date, s.window, pt.*",
      "  FROM snapshots s, UNNEST(s.per_task) AS u(pt);",
    );
  }

  return lines.join("\n");
}

function snapshotDirHasJson(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    const files = readdirSync(dir);
    return files.some((f) => f.endsWith(".json"));
  } catch {
    return false;
  }
}

// ────────────────────────────────────────────────────────────────────────
// S3: DuckDB binary 解決 + format flag マッピング
// ────────────────────────────────────────────────────────────────────────

export interface ResolveDuckdbBinOpts {
  env: Record<string, string | undefined>;
  /** Bun.which 互換。テスト DI 用 */
  which: (bin: string) => string | null;
}

export function resolveDuckdbBin(opts: ResolveDuckdbBinOpts): string | null {
  const fromEnv = opts.env.DUCKDB_BIN;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return opts.which("duckdb");
}

export function formatToFlag(format: QueryFormat): string[] {
  switch (format) {
    case "json":
      return ["-json"];
    case "csv":
      return ["-csv"];
    case "tsv":
      // Reviewer rec #1: -csv + -separator "\t" (dot-command 案より文法境界が綺麗)
      return ["-csv", "-separator", "\t"];
    case "table":
      // -box は DuckDB 0.10+ で利用可能 (Reviewer rec #5: error message にも明記)
      return ["-box"];
  }
}

// ────────────────────────────────────────────────────────────────────────
// CLI 入口
// ────────────────────────────────────────────────────────────────────────

export interface RunMetricsQueryCliOpts {
  /** "query" subcommand を含む args（main.ts dispatch から渡される） */
  args: string[];
  projectRoot: string;
  stdout: { write(s: string): boolean };
  stderr: { write(s: string): boolean };
  abortSignal: AbortSignal;
  /** テスト DI: Bun.which 差し替え */
  which?: (bin: string) => string | null;
  /** テスト DI: stdin が TTY かを上書き */
  stdinIsTTY?: boolean;
  /** テスト DI: stdin から SQL を読むときの ReadableStream 上書き */
  stdinStream?: ReadableStream<Uint8Array>;
}

const DUCKDB_INSTALL_HINT = `Error: 'duckdb' binary not found in PATH (and DUCKDB_BIN is not set).

cmux-team metrics query は DuckDB CLI を必要とします（DuckDB 0.10+ 推奨: -box flag のため）。以下のいずれかで導入してください:

  macOS (Homebrew):   brew install duckdb
  Linux (apt/dnf):    https://duckdb.org/docs/installation/ から binary を取得
  manual:             https://github.com/duckdb/duckdb/releases から CLI binary を $PATH に配置

別 path に置いている場合は環境変数 DUCKDB_BIN で上書き可能:
  DUCKDB_BIN=/opt/duckdb/bin/duckdb cmux-team metrics query --sql '...'
`;

export async function runMetricsQueryCli(
  opts: RunMetricsQueryCliOpts,
): Promise<number> {
  // args[0] === "query" を peel off（main.ts dispatch 由来）
  const argv = opts.args[0] === "query" ? opts.args.slice(1) : opts.args;

  let parsed: ParsedQueryArgs;
  try {
    parsed = parseQueryArgs(argv);
  } catch (e) {
    if (e instanceof ArgError) {
      opts.stderr.write(`Error: ${e.message}\n`);
      opts.stderr.write(`Run 'cmux-team metrics query --help' for usage.\n`);
      return 1;
    }
    throw e;
  }

  if (parsed.help) {
    opts.stdout.write(t("help_metrics_query"));
    opts.stdout.write("\n");
    return 0;
  }

  // SQL の解決: --sql > stdin。両方あれば --sql 優先 (Reviewer rec #3)。
  let userSql: string | null = parsed.sql;
  if (!userSql) {
    const stdinIsTTY = opts.stdinIsTTY ?? !!process.stdin.isTTY;
    if (stdinIsTTY && !opts.stdinStream) {
      opts.stderr.write(
        "Error: SQL is required. Pass --sql '<SQL>' or pipe via stdin.\n",
      );
      opts.stderr.write(`Run 'cmux-team metrics query --help' for usage.\n`);
      return 1;
    }
    userSql = await readAllStdin(opts.stdinStream ?? toReadable(process.stdin));
    if (!userSql || userSql.trim().length === 0) {
      opts.stderr.write("Error: stdin SQL is empty.\n");
      return 1;
    }
  }

  // binary 解決
  const which = opts.which ?? ((b: string) => Bun.which(b));
  const bin = resolveDuckdbBin({ env: process.env, which });
  if (!bin) {
    opts.stderr.write(DUCKDB_INSTALL_HINT);
    return 1;
  }

  // SQL 組み立て
  const initSql = buildInitSql(opts.projectRoot);
  await emitSourceWarnings(opts.projectRoot, opts.stderr);
  const finalUserSql = parsed.explain ? `EXPLAIN ${userSql}` : userSql;
  const fullSql =
    (initSql.length > 0 ? initSql + "\n" : "") + finalUserSql + ";\n";

  // spawn
  const flags = formatToFlag(parsed.format);
  const argv2 = [bin, ...flags, ":memory:"];
  const proc = Bun.spawn(argv2, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    signal: opts.abortSignal,
    env: { ...process.env } as Record<string, string>,
  });

  // stdin に full SQL を流して close。Bun.spawn は stdin: "pipe" のとき FileSink を返す。
  const sink = proc.stdin;
  if (sink) {
    sink.write(fullSql);
    await sink.end();
  }

  // stdout / stderr を相手にコピー（並行）
  const pStdout = relay(proc.stdout, opts.stdout);
  const pStderr = relay(proc.stderr, opts.stderr);
  await Promise.all([pStdout, pStderr]);
  const exitCode = await proc.exited;
  // abort 経由で kill されると null になる場合がある
  if (typeof exitCode === "number") return exitCode;
  return 130;
}

async function relay(
  src: ReadableStream<Uint8Array> | null,
  sink: { write(s: string): boolean },
): Promise<void> {
  if (!src) return;
  const reader = src.getReader();
  const dec = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.length > 0) sink.write(dec.decode(value, { stream: true }));
    }
    const tail = dec.decode();
    if (tail.length > 0) sink.write(tail);
  } catch {
    // 子プロセス側 EPIPE / abort などは無視（exitCode で判定）
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // 二重 release は無視
    }
  }
}

async function readAllStdin(src: ReadableStream<Uint8Array>): Promise<string> {
  const reader = src.getReader();
  const dec = new TextDecoder();
  let out = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.length > 0) out += dec.decode(value, { stream: true });
    }
    out += dec.decode();
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // 二重 release は無視
    }
  }
  return out;
}

/**
 * Node の Readable (process.stdin) を Web ReadableStream<Uint8Array> に変換する thin shim。
 * Bun は Node Readable も受けられるが、テスト用 ReadableStream と契約を統一するため。
 */
function toReadable(input: NodeJS.ReadStream): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      input.on("data", (chunk) => {
        const buf = typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
        controller.enqueue(buf);
      });
      input.on("end", () => controller.close());
      input.on("error", (e) => controller.error(e));
    },
  });
}

async function emitSourceWarnings(
  projectRoot: string,
  stderr: { write(s: string): boolean },
): Promise<void> {
  const dbPath = join(projectRoot, ".team/traces/traces.db");
  if (!existsSync(dbPath)) {
    stderr.write(`Warning: ${dbPath} not found. SQLite views (t.*) will be unavailable.\n`);
    await warn("metrics_query_source_missing", `path=${dbPath} kind=traces.db`);
  }
  const eventsPath = join(projectRoot, ".team/logs/events.jsonl");
  if (!existsSync(eventsPath)) {
    stderr.write(`Warning: ${eventsPath} not found. 'events' view will be unavailable.\n`);
    await warn("metrics_query_source_missing", `path=${eventsPath} kind=events.jsonl`);
  }
  const snapshotDir = join(projectRoot, ".team/metrics/snapshots");
  if (!snapshotDirHasJson(snapshotDir)) {
    stderr.write(
      `Warning: no snapshots in ${snapshotDir}. 'snapshots' / 'snapshots_per_task' views will be unavailable.\n`,
    );
    await warn("metrics_query_source_missing", `path=${snapshotDir} kind=snapshots`);
  }
}
