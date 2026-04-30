/**
 * T381 S7: snapshot 自動収集の健全性チェック CLI。
 *
 * `cmux-team metrics health [--days N] [--snapshot-dir <path>] [--format json|text]`
 * 直近 N 日（既定 7、UTC 基準）に snapshot ファイルが揃っているかをチェックする。
 * 欠損あれば exit 1。launchd の StandardErrorPath で監視を組まなくても
 * **コマンド一発で枯渇判定** できる位置付け。
 *
 * spec: T381 plan.md S7
 */

import { readdir } from "fs/promises";
import { existsSync } from "node:fs";
import { join } from "path";
import { resolveUnderRoot } from "./metrics-path";
import { t } from "./i18n";

export interface FindGapsOpts {
  /** 「today」基準（UTC）。テスト時は固定可能。 */
  today: Date;
  /** チェック対象日数（>=1） */
  days: number;
}

/**
 * `today` 当日を含む直近 N 日分の YYYY-MM-DD（UTC）について、
 * snapshot ファイル（`<dir>/YYYY-MM-DD.json`）が存在しない日を返す。
 *
 * - dir が存在しなければ全日が gap
 * - days <= 0 で throw
 */
export async function findSnapshotGaps(
  snapshotDir: string,
  today: Date,
  days: number,
): Promise<string[]> {
  if (days <= 0 || !Number.isFinite(days)) {
    throw new Error(`days must be a positive integer: got ${days}`);
  }
  const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const requiredDates: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(todayUtc);
    d.setUTCDate(d.getUTCDate() - (days - 1 - i));
    requiredDates.push(d.toISOString().slice(0, 10));
  }
  if (!existsSync(snapshotDir)) {
    return requiredDates;
  }
  const entries = new Set(await readdir(snapshotDir));
  return requiredDates.filter((d) => !entries.has(`${d}.json`));
}

// ────────────────────────────────────────────────────────────────────────
// CLI
// ────────────────────────────────────────────────────────────────────────

export interface RunMetricsHealthCliOpts {
  args: string[];
  projectRoot: string;
  stdout: { write(s: string): boolean };
  stderr: { write(s: string): boolean };
  abortSignal: AbortSignal;
  /** テスト用 today 固定 */
  now?: Date;
}

interface ParsedHealthArgs {
  days: number;
  snapshotDir: string | null;
  format: "json" | "text";
  allowOutsideProject: boolean;
  help: boolean;
}

const HEALTH_FLAGS = new Set([
  "--days",
  "--snapshot-dir",
  "--format",
  "--allow-outside-project",
  "--help",
  "-h",
]);
const HEALTH_FLAGS_WITH_VALUE = new Set(["--days", "--snapshot-dir", "--format"]);

class ArgError extends Error {}

function parseHealthArgs(argv: string[]): ParsedHealthArgs {
  const out: ParsedHealthArgs = {
    days: 7,
    snapshotDir: null,
    format: "json",
    allowOutsideProject: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!HEALTH_FLAGS.has(a)) {
      throw new ArgError(`unknown flag: ${a}`);
    }
    if (a === "--help" || a === "-h") {
      out.help = true;
      continue;
    }
    if (a === "--allow-outside-project") {
      out.allowOutsideProject = true;
      continue;
    }
    if (HEALTH_FLAGS_WITH_VALUE.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || HEALTH_FLAGS.has(v)) {
        throw new ArgError(`${a} requires a value`);
      }
      i++;
      if (a === "--days") {
        const n = Number.parseInt(v, 10);
        if (!Number.isFinite(n) || n <= 0) {
          throw new ArgError(`--days must be a positive integer: got ${v}`);
        }
        out.days = n;
      } else if (a === "--snapshot-dir") {
        out.snapshotDir = v;
      } else if (a === "--format") {
        if (v !== "json" && v !== "text") {
          throw new ArgError(`invalid --format value: ${v} (must be json or text)`);
        }
        out.format = v;
      }
    }
  }
  return out;
}

export async function runMetricsHealthCli(opts: RunMetricsHealthCliOpts): Promise<number> {
  const argv = opts.args[0] === "health" ? opts.args.slice(1) : opts.args;

  let parsed: ParsedHealthArgs;
  try {
    parsed = parseHealthArgs(argv);
  } catch (e) {
    if (e instanceof ArgError) {
      opts.stderr.write(`Error: ${e.message}\n`);
      opts.stderr.write(`Run 'cmux-team metrics health --help' for usage.\n`);
      return 1;
    }
    throw e;
  }

  if (parsed.help) {
    opts.stdout.write(t("help_metrics_health"));
    opts.stdout.write("\n");
    return 0;
  }

  let snapshotDir: string;
  if (parsed.snapshotDir) {
    const r = resolveUnderRoot(opts.projectRoot, parsed.snapshotDir, {
      allowOutside: parsed.allowOutsideProject,
    });
    if (r.outside && !parsed.allowOutsideProject) {
      opts.stderr.write(
        "Error: --snapshot-dir resolves outside projectRoot. Pass --allow-outside-project to override.\n",
      );
      return 1;
    }
    snapshotDir = r.path;
  } else {
    snapshotDir = join(opts.projectRoot, ".team/metrics/snapshots");
  }

  const today = opts.now ?? new Date();
  const missing = await findSnapshotGaps(snapshotDir, today, parsed.days);

  const payload = {
    missing,
    count: missing.length,
    days_checked: parsed.days,
    snapshot_dir: snapshotDir,
  };

  if (parsed.format === "json") {
    opts.stdout.write(JSON.stringify(payload, null, 2));
    opts.stdout.write("\n");
  } else {
    if (missing.length === 0) {
      opts.stdout.write(`OK: no missing snapshots in last ${parsed.days} day(s)\n`);
    } else {
      opts.stdout.write(`MISSING (${missing.length} day(s) of last ${parsed.days}):\n`);
      for (const d of missing) opts.stdout.write(`  missing: ${d}\n`);
    }
  }

  return missing.length === 0 ? 0 : 1;
}
