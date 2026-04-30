/**
 * T381 S2 / S3: daily snapshot 構築 + CLI。
 *
 * 設計:
 *  - `buildDailySnapshot` は純関数（aggregateMetricsByTask を 1 度だけ呼び、
 *    period は同じ lifecycle map から派生させる）
 *  - per_day は snapshot に含めない（fact / 派生分離）
 *  - metadata は generated_at / events_jsonl_size_bytes / 各ファイルパスを sub-object 化
 *  - CLI は atomic write（temp file + fs.rename）と path traversal 対策を持つ
 *
 * spec: T381 plan.md S2 / S3
 */

import { existsSync } from "node:fs";
import { mkdir, rename, stat, unlink, writeFile } from "fs/promises";
import { dirname, join } from "path";
import type { Database } from "bun:sqlite";
import { initDB } from "./trace-store";
import {
  aggregateMetricsByTask,
  aggregatePeriod,
  readTaskLifecycle,
  type PerTaskMetrics,
  type PeriodSummary,
} from "./metrics-aggregate";
import { resolveUnderRoot } from "./metrics-path";
import { t } from "./i18n";

export const SNAPSHOT_SCHEMA_VERSION = 1 as const;

export interface DailySnapshot {
  schema_version: 1;
  /** YYYY-MM-DD（UTC 基準） */
  snapshot_date: string;
  window: {
    /** [from, to) (UTC ISO 8601) */
    from: string;
    to: string;
  };
  per_task: PerTaskMetrics[];
  period: PeriodSummary;
  metadata: {
    generated_at: string;
    events_jsonl_size_bytes: number;
    events_jsonl_path: string;
    traces_db_path: string;
  };
}

export interface BuildDailySnapshotOpts {
  db: Database;
  /** events.jsonl 絶対パス */
  eventsFile: string;
  /** YYYY-MM-DD（UTC 基準） */
  snapshotDate: string;
  /** メタデータの generated_at */
  generatedAt: Date;
  /** メタデータに記録する traces.db のパス（既定は eventsFile と同じ project の `.team/traces/traces.db`） */
  tracesDbPath?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function dayBoundsUtc(snapshotDate: string): { from: Date; to: Date } {
  if (!DATE_RE.test(snapshotDate)) {
    throw new Error(`invalid snapshot date: ${snapshotDate} (expected YYYY-MM-DD)`);
  }
  const from = new Date(`${snapshotDate}T00:00:00.000Z`);
  if (Number.isNaN(from.getTime())) {
    throw new Error(`invalid snapshot date: ${snapshotDate}`);
  }
  const to = new Date(from.getTime() + 86_400_000);
  return { from, to };
}

/**
 * 1 日分の snapshot を構築する純関数。
 * `aggregateMetricsByTask` を 1 度だけ呼び、`aggregatePeriod` で period を派生する。
 * per_day は snapshot に含めない（compare 側で派生）。
 */
export async function buildDailySnapshot(
  opts: BuildDailySnapshotOpts,
): Promise<DailySnapshot> {
  const { from, to } = dayBoundsUtc(opts.snapshotDate);
  const lifecycle = await readTaskLifecycle(opts.eventsFile, from);
  const filteredLifecycle = new Map(
    [...lifecycle.entries()].filter(([, lc]) => {
      // [from, to) フィルタ: 終了済みは terminal_ts、open は assigned_ts で判定
      const cmp = lc.closed_ts ?? lc.assigned_ts;
      const t = Date.parse(cmp);
      return t >= from.getTime() && t < to.getTime();
    }),
  );

  const perTask = await aggregateMetricsByTask(opts.db, opts.eventsFile, {
    since: from,
    until: to,
  });
  const perTaskFiltered = perTask.filter((p) => filteredLifecycle.has(p.task_id));
  const period = aggregatePeriod(filteredLifecycle);

  const sizeBytes = await fileSize(opts.eventsFile);
  const tracesPath =
    opts.tracesDbPath ??
    join(dirname(dirname(opts.eventsFile)), "traces", "traces.db");

  return {
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    snapshot_date: opts.snapshotDate,
    window: {
      from: from.toISOString(),
      to: to.toISOString(),
    },
    per_task: perTaskFiltered,
    period,
    metadata: {
      generated_at: opts.generatedAt.toISOString(),
      events_jsonl_size_bytes: sizeBytes,
      events_jsonl_path: opts.eventsFile,
      traces_db_path: tracesPath,
    },
  };
}

async function fileSize(path: string): Promise<number> {
  try {
    const st = await stat(path);
    return st.size;
  } catch {
    return 0;
  }
}

// ────────────────────────────────────────────────────────────────────────
// CLI
// ────────────────────────────────────────────────────────────────────────

export interface RunMetricsSnapshotCliOpts {
  /** "snapshot" subcommand を含む args（main.ts dispatch から渡される） */
  args: string[];
  projectRoot: string;
  stdout: { write(s: string): boolean };
  stderr: { write(s: string): boolean };
  abortSignal: AbortSignal;
  /** テスト用: 既定 `--date` を override（既定は「昨日 UTC」） */
  now?: Date;
}

interface ParsedSnapshotArgs {
  date: string | null;
  out: string | null;
  force: boolean;
  allowOutsideProject: boolean;
  help: boolean;
}

const SNAPSHOT_FLAGS = new Set([
  "--date",
  "--out",
  "--force",
  "--allow-outside-project",
  "--help",
  "-h",
]);
const SNAPSHOT_FLAGS_WITH_VALUE = new Set(["--date", "--out"]);

class ArgError extends Error {}

function parseSnapshotArgs(argv: string[]): ParsedSnapshotArgs {
  const out: ParsedSnapshotArgs = {
    date: null,
    out: null,
    force: false,
    allowOutsideProject: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!SNAPSHOT_FLAGS.has(a)) {
      throw new ArgError(`unknown flag: ${a}`);
    }
    if (a === "--help" || a === "-h") {
      out.help = true;
      continue;
    }
    if (a === "--force") {
      out.force = true;
      continue;
    }
    if (a === "--allow-outside-project") {
      out.allowOutsideProject = true;
      continue;
    }
    if (SNAPSHOT_FLAGS_WITH_VALUE.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || SNAPSHOT_FLAGS.has(v)) {
        throw new ArgError(`${a} requires a value`);
      }
      i++;
      if (a === "--date") {
        if (!DATE_RE.test(v)) {
          throw new ArgError(`--date must match YYYY-MM-DD: got ${v}`);
        }
        out.date = v;
      } else if (a === "--out") {
        out.out = v;
      }
    }
  }
  return out;
}

/** 「昨日 UTC」を YYYY-MM-DD で返す。 */
function yesterdayUtc(now: Date): string {
  const yest = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  return yest.toISOString().slice(0, 10);
}

function randomTmpName(targetBase: string): string {
  const r = Math.random().toString(36).slice(2, 10);
  return `.tmp-${process.pid}-${r}-${targetBase}`;
}

async function atomicWriteJson(targetPath: string, body: string): Promise<void> {
  const dir = dirname(targetPath);
  await mkdir(dir, { recursive: true });
  const base = targetPath.slice(targetPath.lastIndexOf("/") + 1);
  const tmp = join(dir, randomTmpName(base));
  try {
    await writeFile(tmp, body);
    await rename(tmp, targetPath);
  } catch (e) {
    try {
      await unlink(tmp);
    } catch {
      // tmp が無いケースは無視（rename 後の rollback 等）
    }
    throw e;
  }
}

export async function runMetricsSnapshotCli(
  opts: RunMetricsSnapshotCliOpts,
): Promise<number> {
  // args[0] === "snapshot" を peel off（main.ts dispatch 由来）
  const argv = opts.args[0] === "snapshot" ? opts.args.slice(1) : opts.args;

  let parsed: ParsedSnapshotArgs;
  try {
    parsed = parseSnapshotArgs(argv);
  } catch (e) {
    if (e instanceof ArgError) {
      opts.stderr.write(`Error: ${e.message}\n`);
      opts.stderr.write(`Run 'cmux-team metrics snapshot --help' for usage.\n`);
      return 1;
    }
    throw e;
  }

  if (parsed.help) {
    opts.stdout.write(t("help_metrics_snapshot"));
    opts.stdout.write("\n");
    return 0;
  }

  const now = opts.now ?? new Date();
  const date = parsed.date ?? yesterdayUtc(now);

  // 出力先解決
  let outPath: string;
  if (parsed.out) {
    const resolved = resolveUnderRoot(opts.projectRoot, parsed.out, {
      allowOutside: parsed.allowOutsideProject,
    });
    if (resolved.outside && !parsed.allowOutsideProject) {
      opts.stderr.write(
        `Error: --out resolves outside projectRoot. Pass --allow-outside-project to override.\n`,
      );
      return 1;
    }
    outPath = resolved.path;
  } else {
    outPath = join(opts.projectRoot, ".team/metrics/snapshots", `${date}.json`);
  }

  if (existsSync(outPath) && !parsed.force) {
    opts.stderr.write(`Error: snapshot file already exists: ${outPath} (use --force to overwrite)\n`);
    return 1;
  }

  const eventsFile = join(opts.projectRoot, ".team/logs/events.jsonl");
  if (!existsSync(eventsFile)) {
    opts.stderr.write(`Error: events.jsonl not found at ${eventsFile}\n`);
    return 1;
  }
  const dbPath = join(opts.projectRoot, ".team/traces/traces.db");
  if (!existsSync(dbPath)) {
    opts.stderr.write(`Error: traces.db not found at ${dbPath}\n`);
    return 1;
  }

  const db = initDB(opts.projectRoot);
  try {
    const snap = await buildDailySnapshot({
      db,
      eventsFile,
      snapshotDate: date,
      generatedAt: now,
      tracesDbPath: dbPath,
    });
    if (opts.abortSignal.aborted) {
      opts.stderr.write("Aborted before write.\n");
      return 130;
    }
    const body = JSON.stringify(snap, null, 2);
    await atomicWriteJson(outPath, body);
    opts.stdout.write(`${outPath}\n`);
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    opts.stderr.write(`Error: snapshot write failed: ${msg}\n`);
    return 1;
  } finally {
    try {
      db.close();
    } catch {
      // close は best-effort
    }
  }
}
