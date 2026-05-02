/**
 * T416: `.team/` 配下の自動 GC コアモジュール。
 *
 * 起動時 (boot trigger) と periodic interval で sweep を回し、保持期間を超えた
 * 派生物（bodies / prompts / queue/processed / output / conductors / e2e-results）と
 * trace DB の古い hook_signals / api_usage 行を削除する。さらに boot 時のみ
 * `traces.db` の VACUUM と `tokens.db` の WAL checkpoint を実行する。
 *
 * 設計原則:
 * - sweep 関数は state 非依存の pure-ish API（active 保護は protect callback で注入）
 * - active 集合は呼び出し時に解決し、retention の下限不変条件で race を吸収
 * - log は集計のみ（個別ファイルパスは出さない — manager.log 膨張を避ける）
 * - 失敗しても daemon を落とさない（catch して team_gc_failed event を吐くだけ）
 */
import { readdir, stat, rm, rename, unlink } from "fs/promises";
import { existsSync, statSync } from "fs";
import { join } from "path";
import type { Database } from "bun:sqlite";
import { log, warn } from "./logger";
import { loadTaskState, isTerminalStatus } from "./task";
import { normalizeSurfaceForPath } from "./paths";
import { loadConfig, resolveGcConfig, type GcConfig } from "./config";
import { walCheckpointTokensDB } from "./token-store";
import type { DaemonState } from "./daemon";

// ─────────────────────────────────────────────────────────────────────────────
// 公開型
// ─────────────────────────────────────────────────────────────────────────────

export type GcCategory =
  | "bodies"
  | "prompts"
  | "queue_processed"
  | "output"
  | "conductors"
  | "e2e_results";

export interface GcDeletion {
  category: GcCategory;
  path: string;
  ageDays: number;
  bytes: number;
}

export interface RotationResult {
  file: string;
  fromBytes: number;
  rotatedTo: string[];
}

export interface GcTrigger {
  trigger: "boot" | "periodic" | "manual";
}

// ─────────────────────────────────────────────────────────────────────────────
// 内部 helpers
// ─────────────────────────────────────────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * 与えられた path の合計サイズを返す（best-effort）。
 * ディレクトリは再帰的に walk する。失敗したら 0 を返す（GC 進行を止めない）。
 */
async function estimateSize(path: string): Promise<number> {
  try {
    const st = await stat(path);
    if (st.isFile()) return st.size;
    if (!st.isDirectory()) return 0;
    const entries = await readdir(path, { withFileTypes: true });
    let total = 0;
    for (const e of entries) {
      const child = join(path, e.name);
      total += await estimateSize(child);
    }
    return total;
  } catch {
    return 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// sweep 関数群（pure-ish — state 非依存）
// ─────────────────────────────────────────────────────────────────────────────

export interface SweepDirOptions {
  dir: string;
  retentionDays: number;
  protect: (entryName: string) => boolean;
  category: GcCategory;
  now?: Date;
}

/**
 * mtime ベースで retention 経過した entry を返す（削除はしない）。
 *
 * - dir 自体が存在しなければ空配列
 * - protect(entryName) === true は保護
 * - retentionDays === 0 なら全エントリが削除候補（active 保護は protect 任せ）
 *
 * 戻り値は呼び出し側で `fs.rm({ recursive: true, force: true })` する想定。
 */
export async function sweepDirByMtime(opts: SweepDirOptions): Promise<GcDeletion[]> {
  const { dir, retentionDays, protect, category } = opts;
  const now = opts.now ?? new Date();

  if (!existsSync(dir)) return [];

  let entries: { name: string; isDirectory: boolean; isFile: boolean }[];
  try {
    const dirents = await readdir(dir, { withFileTypes: true });
    entries = dirents.map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
      isFile: e.isFile(),
    }));
  } catch (e: any) {
    await log(
      "team_gc_failed",
      `category=${category} reason=readdir error=${e?.message ?? String(e)}`,
    );
    return [];
  }

  const cutoffMs = now.getTime() - retentionDays * MS_PER_DAY;
  const result: GcDeletion[] = [];

  for (const entry of entries) {
    if (!entry.isFile && !entry.isDirectory) continue;
    if (protect(entry.name)) continue;

    const fullPath = join(dir, entry.name);
    let mtimeMs: number;
    try {
      const st = await stat(fullPath);
      mtimeMs = st.mtimeMs;
    } catch {
      continue; // 既に消えていたら skip
    }

    if (mtimeMs >= cutoffMs) continue; // retention 内 → 保持

    const bytes = await estimateSize(fullPath);
    const ageDays = (now.getTime() - mtimeMs) / MS_PER_DAY;
    result.push({ category, path: fullPath, ageDays, bytes });
  }

  return result;
}

export interface RotateLogOptions {
  file: string;
  sizeBytes: number;
  keep: number;
}

/**
 * ログファイルをサイズ閾値超でローテートする（T416）。
 *
 * - file 不在 / 閾値未満 → null を返す（FS 不変）
 * - 閾値超 → `.<keep>` を unlink → `.N → .N+1` を後ろから順に rename → file → .1 を rename
 * - file 自体は削除する（次の write が `O_CREAT` で新 inode を作る前提）
 *
 * `appendFile` が短命 fd で常に再 open することに依存している（proxy.ts:905 の仕様）。
 */
export async function rotateLogFile(opts: RotateLogOptions): Promise<RotationResult | null> {
  const { file, sizeBytes, keep } = opts;
  if (!existsSync(file)) return null;

  let st;
  try {
    st = statSync(file);
  } catch {
    return null;
  }
  if (st.size < sizeBytes) return null;

  const fromBytes = st.size;
  const rotatedTo: string[] = [];

  // .keep を unlink（最古を捨てる）
  const oldest = `${file}.${keep}`;
  if (existsSync(oldest)) {
    try {
      await unlink(oldest);
    } catch (e: any) {
      await log(
        "team_gc_failed",
        `reason=rotate_unlink file=${oldest} error=${e?.message ?? String(e)}`,
      );
    }
  }

  // .N → .N+1（N=keep-1 から 1 まで降順）
  for (let i = keep - 1; i >= 1; i--) {
    const src = `${file}.${i}`;
    const dst = `${file}.${i + 1}`;
    if (existsSync(src)) {
      try {
        await rename(src, dst);
        rotatedTo.push(dst);
      } catch (e: any) {
        await log(
          "team_gc_failed",
          `reason=rotate_rename src=${src} dst=${dst} error=${e?.message ?? String(e)}`,
        );
      }
    }
  }

  // file → .1
  try {
    await rename(file, `${file}.1`);
    rotatedTo.push(`${file}.1`);
  } catch (e: any) {
    await log(
      "team_gc_failed",
      `reason=rotate_rename src=${file} dst=${file}.1 error=${e?.message ?? String(e)}`,
    );
    return null;
  }

  return { file, fromBytes, rotatedTo };
}

export interface GcTraceDbOptions {
  db: Database;
  retentionDays: number;
  now?: Date;
  dryRun?: boolean;
}

/**
 * trace DB の `hook_signals` / `api_usage` から retention 超過行を削除する。
 *
 * dryRun 時は SELECT COUNT のみで件数を返す（DELETE しない）。
 */
export function gcTraceDb(opts: GcTraceDbOptions): {
  hookSignalsDeleted: number;
  apiUsageDeleted: number;
} {
  const { db, retentionDays, dryRun } = opts;
  const now = opts.now ?? new Date();
  const cutoffIso = new Date(now.getTime() - retentionDays * MS_PER_DAY).toISOString();

  if (dryRun) {
    const hookCnt = (
      db
        .prepare("SELECT COUNT(*) AS c FROM hook_signals WHERE timestamp < ?")
        .get(cutoffIso) as { c: number } | undefined
    )?.c ?? 0;
    const apiCnt = (
      db
        .prepare("SELECT COUNT(*) AS c FROM api_usage WHERE timestamp < ?")
        .get(cutoffIso) as { c: number } | undefined
    )?.c ?? 0;
    return { hookSignalsDeleted: hookCnt, apiUsageDeleted: apiCnt };
  }

  const hookRes = db.prepare("DELETE FROM hook_signals WHERE timestamp < ?").run(cutoffIso);
  const apiRes = db.prepare("DELETE FROM api_usage WHERE timestamp < ?").run(cutoffIso);
  return {
    hookSignalsDeleted: Number(hookRes.changes ?? 0),
    apiUsageDeleted: Number(apiRes.changes ?? 0),
  };
}

/**
 * traces.db の `VACUUM` を実行して領域を回収する（boot trigger 時のみ）。
 *
 * - 既にロックされている / writer 競合時は SQLITE_BUSY が返るため呼び出し側で boot 時の
 *   writer 不在状態を保証すること（main.ts §8.4 参照）。
 * - `freedBytes` は VACUUM 前後のファイルサイズ差から best-effort で算出。
 */
export function vacuumTraceDb(opts: { db: Database }):
  | { ok: true; durationMs: number; freedBytes: number }
  | { ok: false; error: string } {
  const { db } = opts;
  // bun:sqlite は filename を直接公開していないため `PRAGMA database_list` で取得する
  let dbPath: string | null = null;
  try {
    const rows = db.prepare("PRAGMA database_list").all() as Array<{
      seq: number;
      name: string;
      file: string;
    }>;
    const main = rows.find((r) => r.name === "main");
    dbPath = main?.file && main.file.length > 0 ? main.file : null;
  } catch {
    dbPath = null;
  }

  let beforeSize = 0;
  if (dbPath && existsSync(dbPath)) {
    try {
      beforeSize = statSync(dbPath).size;
    } catch {
      beforeSize = 0;
    }
  }

  const start = Date.now();
  try {
    db.exec("VACUUM");
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const durationMs = Date.now() - start;

  let afterSize = 0;
  if (dbPath && existsSync(dbPath)) {
    try {
      afterSize = statSync(dbPath).size;
    } catch {
      afterSize = beforeSize;
    }
  }
  const freedBytes = Math.max(0, beforeSize - afterSize);
  return { ok: true, durationMs, freedBytes };
}

/**
 * tokens.db の WAL を TRUNCATE モードで checkpoint する。token-store の
 * walCheckpointTokensDB をそのまま使う薄ラッパー（命名統一のため）。
 */
export function checkpointTokensDb(): { ok: boolean; error?: string; framesCheckpointed?: number } {
  const r = walCheckpointTokensDB();
  if (r.ok) return { ok: true, framesCheckpointed: r.framesCheckpointed };
  return { ok: false, error: r.error };
}

// ─────────────────────────────────────────────────────────────────────────────
// active 集合解決
// ─────────────────────────────────────────────────────────────────────────────

interface ActiveSet {
  taskRunIds: Set<string>;
  conductorSurfaces: Set<string>;
  promptFiles: Set<string>;
}

/**
 * active な taskRunId / conductor surface / prompt name を解決する。
 *
 * - task-state.json の status が terminal でない全 entry の taskRunId
 * - state.conductors の全 surface（`normalizeSurfaceForPath` 後の名前）
 * - active taskRunId に対応する prompt ファイル名（best-effort で 24h mtime 保護も併用）
 */
async function resolveActiveSet(state: DaemonState): Promise<ActiveSet> {
  const taskRunIds = new Set<string>();
  const conductorSurfaces = new Set<string>();
  const promptFiles = new Set<string>();

  try {
    const taskState = await loadTaskState(state.projectRoot);
    for (const entry of Object.values(taskState ?? {})) {
      if (!entry || isTerminalStatus(entry.status)) continue;
      if (entry.taskRunId) taskRunIds.add(entry.taskRunId);
    }
  } catch (e: any) {
    await log(
      "team_gc_failed",
      `reason=resolve_active_task_state error=${e?.message ?? String(e)}`,
    );
  }

  for (const [surface, c] of state.conductors.entries()) {
    conductorSurfaces.add(normalizeSurfaceForPath(surface));
    if (c.taskRunId) taskRunIds.add(c.taskRunId);
  }

  for (const taskRunId of taskRunIds) {
    promptFiles.add(`${taskRunId}.md`);
    promptFiles.add(`${taskRunId}.expanded.md`);
  }

  return { taskRunIds, conductorSurfaces, promptFiles };
}

// ─────────────────────────────────────────────────────────────────────────────
// runTeamGC エントリ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GC を 1 度実行する。多重実行は `state.gcInFlight` flag で弾く。
 *
 * 順序: (1) DB GC → (2) traces.db VACUUM (boot only) → (3) tokens.db checkpoint (boot only)
 *       → (4) dir sweeps → (5) log rotation
 */
export async function runTeamGC(state: DaemonState, opts: GcTrigger): Promise<void> {
  const trigger = opts.trigger;

  if (state.gcInFlight) {
    await log("team_gc_skipped", `reason=in_flight trigger=${trigger}`);
    return;
  }
  state.gcInFlight = true;

  const startMs = Date.now();
  let totalDeletions = 0;
  let totalBytes = 0;

  try {
    let projectConfig: { gc?: GcConfig } = {};
    try {
      projectConfig = await loadConfig(state.projectRoot);
    } catch (e) {
      const err = e as { message?: string };
      await warn(
        "team_gc_warn",
        `reason=load_config_failed error=${err?.message ?? String(e)}`,
      );
      projectConfig = {};
    }
    const cfg = resolveGcConfig(projectConfig);

    await log(
      "team_gc_started",
      `trigger=${trigger} dry_run=${cfg.dryRun}`,
    );

    // retention=0 警告（active 保護 race の安全網が破れる構成）
    const retentionFields: Array<[string, number]> = [
      ["bodies", cfg.retention.bodiesDays],
      ["prompts", cfg.retention.promptsDays],
      ["queue_processed", cfg.retention.queueProcessedDays],
      ["output", cfg.retention.outputDays],
      ["conductors", cfg.retention.conductorsDays],
      ["e2e_results", cfg.retention.e2eResultsDays],
    ];
    for (const [name, days] of retentionFields) {
      if (days === 0) {
        await warn(
          "team_gc_warn",
          `category=${name} reason=retention_zero_active_protection_unsafe`,
        );
      }
    }

    // active 集合の解決（FS sweep 前に固定する）
    const active = await resolveActiveSet(state);

    // (1) DB GC
    if (state.traceDb) {
      try {
        const dbRes = gcTraceDb({
          db: state.traceDb,
          retentionDays: cfg.retention.dbDays,
          dryRun: cfg.dryRun,
        });
        await log(
          "team_gc_db",
          `hook_signals_deleted=${dbRes.hookSignalsDeleted} api_usage_deleted=${dbRes.apiUsageDeleted} retention_days=${cfg.retention.dbDays} dry_run=${cfg.dryRun}`,
        );
        totalDeletions += dbRes.hookSignalsDeleted + dbRes.apiUsageDeleted;
      } catch (e: any) {
        await log(
          "team_gc_failed",
          `trigger=${trigger} reason=db_gc error=${e?.message ?? String(e)}`,
        );
      }

      // (2) traces.db VACUUM — boot trigger のみ
      if (trigger === "boot" && !cfg.dryRun) {
        try {
          const v = vacuumTraceDb({ db: state.traceDb });
          if (v.ok) {
            await log(
              "team_gc_db_vacuum",
              `duration_ms=${v.durationMs} freed_bytes=${v.freedBytes}`,
            );
          } else {
            await log(
              "team_gc_failed",
              `trigger=${trigger} reason=db_vacuum error=${v.error}`,
            );
          }
        } catch (e: any) {
          await log(
            "team_gc_failed",
            `trigger=${trigger} reason=db_vacuum error=${e?.message ?? String(e)}`,
          );
        }
      }
    } else {
      await warn("team_gc_warn", `reason=trace_db_null trigger=${trigger}`);
    }

    // (3) tokens.db WAL checkpoint — boot trigger のみ
    if (trigger === "boot" && !cfg.dryRun) {
      try {
        const r = checkpointTokensDb();
        await log(
          "team_gc_wal_checkpoint",
          `frames_checkpointed=${r.framesCheckpointed ?? 0} ok=${r.ok}${r.error ? ` error=${r.error}` : ""}`,
        );
      } catch (e: any) {
        await log(
          "team_gc_failed",
          `trigger=${trigger} reason=wal_checkpoint error=${e?.message ?? String(e)}`,
        );
      }
    }

    // (4) dir sweeps
    const teamDir = join(state.projectRoot, ".team");
    const NOW_MS = Date.now();
    const PROMPT_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

    const protectByName = (set: Set<string>) => (name: string) => set.has(name);
    const protectNone = () => false;

    const sweeps: Array<{
      dir: string;
      retentionDays: number;
      protect: (name: string) => boolean;
      category: GcCategory;
      protectMtimeRecent?: boolean;
      protectMtimeRecentWindowMs?: number;
    }> = [
      {
        dir: join(teamDir, "logs/traces/bodies"),
        retentionDays: cfg.retention.bodiesDays,
        protect: protectNone,
        category: "bodies",
      },
      {
        dir: join(teamDir, "prompts"),
        retentionDays: cfg.retention.promptsDays,
        protect: protectByName(active.promptFiles),
        category: "prompts",
        protectMtimeRecent: true,
        protectMtimeRecentWindowMs: PROMPT_RECENT_WINDOW_MS,
      },
      {
        dir: join(teamDir, "queue/processed"),
        retentionDays: cfg.retention.queueProcessedDays,
        protect: protectNone,
        category: "queue_processed",
      },
      {
        dir: join(teamDir, "output"),
        retentionDays: cfg.retention.outputDays,
        protect: protectByName(active.taskRunIds),
        category: "output",
      },
      {
        dir: join(teamDir, "conductors"),
        retentionDays: cfg.retention.conductorsDays,
        protect: protectByName(active.conductorSurfaces),
        category: "conductors",
      },
      {
        dir: join(teamDir, "e2e-results"),
        retentionDays: cfg.retention.e2eResultsDays,
        protect: protectNone,
        category: "e2e_results",
      },
    ];

    for (const s of sweeps) {
      let candidates = await sweepDirByMtime({
        dir: s.dir,
        retentionDays: s.retentionDays,
        protect: s.protect,
        category: s.category,
      });

      // prompts のみ「mtime 24h 以内は強保護」で再フィルタ（retention 短縮時の安全網）
      if (s.protectMtimeRecent) {
        const window = s.protectMtimeRecentWindowMs ?? PROMPT_RECENT_WINDOW_MS;
        const cutoffMs = NOW_MS - window;
        candidates = candidates.filter((d) => {
          try {
            return statSync(d.path).mtimeMs < cutoffMs;
          } catch {
            return false;
          }
        });
      }

      if (candidates.length === 0) continue;

      let bytes = 0;
      let count = 0;
      for (const cand of candidates) {
        bytes += cand.bytes;
        if (cfg.dryRun) {
          count++;
          continue;
        }
        try {
          await rm(cand.path, { recursive: true, force: true });
          count++;
        } catch (e: any) {
          await log(
            "team_gc_failed",
            `trigger=${trigger} reason=rm category=${s.category} path=${cand.path} error=${e?.message ?? String(e)}`,
          );
        }
      }

      await log(
        "team_gc_deleted",
        `category=${s.category} count=${count} bytes=${bytes} dry_run=${cfg.dryRun}`,
      );
      totalDeletions += count;
      totalBytes += bytes;
    }

    // (5) log rotation — bodies 等の sweep が終わった後（rotation 出力が即削除されない順序）
    if (!cfg.dryRun) {
      const rotateTargets = [
        join(teamDir, "logs/traces/api-trace.jsonl"),
        join(teamDir, "logs/manager.log"),
      ];
      for (const target of rotateTargets) {
        try {
          const r = await rotateLogFile({
            file: target,
            sizeBytes: cfg.rotation.sizeBytes,
            keep: cfg.rotation.keep,
          });
          if (r) {
            await log(
              "team_gc_rotated",
              `file=${r.file} from_bytes=${r.fromBytes} rotated_to=${r.rotatedTo.join(",")}`,
            );
          }
        } catch (e: any) {
          await log(
            "team_gc_failed",
            `trigger=${trigger} reason=rotate file=${target} error=${e?.message ?? String(e)}`,
          );
        }
      }
    }

    const durationMs = Date.now() - startMs;
    await log(
      "team_gc_completed",
      `trigger=${trigger} duration_ms=${durationMs} total_deletions=${totalDeletions} total_bytes=${totalBytes} dry_run=${cfg.dryRun}`,
    );
  } catch (e: any) {
    await log(
      "team_gc_failed",
      `trigger=${trigger} error=${e?.message ?? String(e)}`,
    );
  } finally {
    state.gcInFlight = false;
  }
}

/**
 * テスト用 helper: state.gcInterval を clearInterval する。
 */
export function __clearGCIntervalForTest(state: DaemonState): void {
  if (state.gcInterval) {
    clearInterval(state.gcInterval);
    state.gcInterval = undefined;
  }
}
