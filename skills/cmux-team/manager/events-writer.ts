/**
 * T358: events.jsonl writer.
 *
 * Manager daemon が外向け event channel `.team/logs/events.jsonl` に
 * 1 行 1 record で append する書き手。spec: docs/spec/10-events-stream.md。
 *
 * 設計判断:
 *  - logger.ts と同形の function-style export（プロセス単位シングルトン、daemon は 1 プロセス）
 *  - `schema_version` / `ts` は writer 側で自動付与（呼び忘れ・形式ズレを構造的に防止）
 *  - retention は append のみ。rotate / size limit / 自動 GC は writer の責務外
 *  - 書き込み失敗は throw せず manager.log に `events_writer_error` を残す
 *    (daemon の availability >> events.jsonl 完全性)
 *
 * AbortReason → SpecAbortReason マップは `mapAbortReason` を参照。task.ts の内部 8 値は
 * spec §6.6 の 6 値（独立 enum）に集約される。
 */

import { appendFile, mkdir } from "fs/promises";
import { dirname, join } from "path";
import { log } from "./logger";
import type { AbortReason } from "./task";

export const EVENTS_SCHEMA_VERSION = 2;

/**
 * spec §6.6 準拠の独立 enum。task.ts の `AbortReason` とは別軸で型定義し、
 * reader (T359/T360) が AbortReason の将来拡張に巻き込まれないようにする。
 */
export type SpecAbortReason =
  | "judgment_pending"
  | "disconnect_timeout"
  | "user_clear"
  | "assign_failed"
  | "resume_marked_aborted"
  | "other";

/**
 * REVERT_TO_READY 経路の reason。spec §6.8 enum と一致。
 */
export type RevertReason =
  | "worktree_missing"
  | "launch_failed"
  | "unmatched"
  | "unique_violation"
  | "overflow";

export type EventStreamRecord =
  | { event: "task_created"; task_id: string; title: string }
  | { event: "task_ready"; task_id: string }
  | {
      event: "task_assigned";
      task_id: string;
      conductor_surface: string;
      task_run_id: string;
    }
  | {
      event: "task_completed";
      task_id: string;
      conductor_surface: string;
      worktree_path: string;
      journal_summary: string;
    }
  | {
      event: "task_completed_state_mismatch";
      task_id: string;
      conductor_surface: string;
      reason: "missing_close_task";
      worktree_path: string;
      journal_summary: string;
    }
  | {
      event: "task_aborted";
      task_id: string;
      reason: SpecAbortReason;
      journal_summary: string;
    }
  | {
      event: "task_sync_guard_rejected";
      task_id: string;
      kind: "diverged" | "uncommitted" | "detached" | "auto_pull_failed";
      detail: string;
      main_branch: string;
    }
  | { event: "task_reverted_to_ready"; task_id: string; reason: RevertReason }
  | { event: "conductor_running"; conductor_surface: string; task_id: string }
  | {
      event: "conductor_recovered";
      conductor_surface: string;
      new_status: "idle" | "running";
    }
  | {
      event: "conductor_disconnected";
      conductor_surface: string;
      reason: "session_ended" | "pid_dead" | "assign_failed";
      task_id?: string;
    }
  | {
      event: "conductor_asking";
      conductor_surface: string;
      question: string;
    }
  | {
      event: "conductor_done_unresolved";
      task_id: string;
      conductor_surface: string;
      worktree_path: string;
      journal_summary: string;
    }
  | {
      event: "conductor_start_timeout";
      conductor_surface: string;
      elapsed_ms: number;
    }
  | {
      event: "conductor_assign_timeout";
      conductor_surface: string;
      task_run_id: string;
      elapsed_ms: number;
    }
  | {
      event: "conductor_disconnect_timeout";
      conductor_surface: string;
      task_id?: string;
      elapsed_ms: number;
    }
  | {
      // T392: StopFailure hook 経由で確定した API エラー（rate_limit / authentication_failed
      // / billing_error / server_error / forward-compat）。schema_version は bump しない（add-only）。
      event: "api_error_received";
      role: "master" | "conductor" | "agent" | "unknown";
      surface: string;
      kind: string;
      message?: string;
    };

/**
 * `task.ts:AbortReason`（8 値）→ spec §6.6 `SpecAbortReason`（6 値）への構造的マップ。
 * 拡張時は両端を同時に見直すため、テストで全 8 値を網羅する。
 */
export function mapAbortReason(r: AbortReason): SpecAbortReason {
  switch (r) {
    case "user_clear":
      return "user_clear";
    case "judgment_pending":
      return "judgment_pending";
    case "assign_failed":
      return "assign_failed";
    case "disconnect_timeout":
      return "disconnect_timeout";
    case "abort_task":
      return "other";
    case "resume_no_session_id":
    case "resume_no_task_run_id":
    case "resume_no_worktree":
      return "resume_marked_aborted";
  }
  // exhaustive check
  const _exhaustive: never = r;
  void _exhaustive;
  return "other";
}

function eventsFilePath(): string {
  // logger.ts と同じ env 解決方針。CMUX_TEAM_LOGGER_STRICT=1 を尊重しないが、
  // logger.log（fallback 経路）で同様の strict check は走るので writer 自体は
  // PROJECT_ROOT 未設定でも cwd フォールバックで動く。
  const projectRoot = process.env.PROJECT_ROOT || process.cwd();
  return join(projectRoot, ".team/logs/events.jsonl");
}

/**
 * record を 1 行 JSON にエンコードして events.jsonl に append する。
 *
 * - `schema_version` / `ts` は呼び出し側に書かせず writer が注入する
 * - 書き込み失敗時は throw せず、manager.log に `events_writer_error` を残す
 *   (daemon 全体の availability を最優先する best-effort)
 */
export async function emitEvent(record: EventStreamRecord): Promise<void> {
  const filePath = eventsFilePath();
  const enriched = {
    ts: new Date().toISOString(),
    schema_version: EVENTS_SCHEMA_VERSION,
    ...record,
  };
  const line = JSON.stringify(enriched) + "\n";
  try {
    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, line);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    const code = err?.code ? ` code=${err.code}` : "";
    const stackHead = err?.stack ? ` stack=${err.stack.split("\n")[0]}` : "";
    try {
      await log(
        "events_writer_error",
        `event=${record.event} message=${err?.message ?? String(e)}${code}${stackHead}`,
      );
    } catch {
      // logger も失敗するケース（例: PROJECT_ROOT strict + 未設定）は完全に飲む。
      // events.jsonl の不達は daemon 機能要件ではない（best-effort）。
    }
  }
}
