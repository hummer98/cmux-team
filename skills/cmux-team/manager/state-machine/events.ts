/**
 * T279: Conductor / Task FSM の discriminated union 型定義。
 * reducer (conductor-fsm.ts / task-fsm.ts) と shadow observer (shadow.ts) で共有。
 *
 * schema.ts への依存は `import type` のみ (循環依存回避)。schema 側は本ファイルを参照しない。
 */

import type { ConductorState } from "../schema";

/** Conductor.status と 1:1 対応 (schema.ts:262)。 */
export type ConductorStatus = ConductorState["status"];

/**
 * Task.status は task.ts:33 時点では `string` (unions 未定義)。
 * reducer は A017 §2.1 の 6 値のみ扱う。
 */
export type TaskStatus =
  | "draft"
  | "ready"
  | "assigned"
  | "closed"
  | "aborted"
  | "deleted";

/**
 * Conductor 側 reducer が扱う FSM イベント。
 *
 * - hook 由来: SESSION_STARTED / SESSION_IDLE / SESSION_CLEAR / SESSION_ACTIVE /
 *   SESSION_ASK / SESSION_ENDED (SESSION_STOP は daemon 側で IDLE/ASK に分類済みなので含めない)
 * - daemon 内部由来: TIMEOUT / ASSIGN / DONE / PID_DIED / CLEAR_MANUAL / REGISTERED
 *
 * `CLEAR_MANUAL` は現時点 (2026-04-20) では emit されない予約 event。
 * SESSION_CLEAR の `manualUserInitiated=true` で同等セマンティクスを表現しているため、
 * reducer は exhaustive check のため case を持つが shadow 配線側は emit しない。
 * 将来 user 発 /clear を hook 外の経路で検出する場合に使う。
 */
export type FsmEvent =
  | {
      type: "SESSION_STARTED";
      source: "startup" | "resume" | "clear" | "compact" | undefined;
      /** Master surface なら reducer は状態遷移せず no-op を返す。 */
      isMasterSurface: boolean;
    }
  | { type: "SESSION_IDLE" }
  | {
      type: "SESSION_CLEAR";
      /**
       * user が手動で /clear を打ったと daemon が判断したか。
       * daemon.ts:2103 の `running + taskRunId` 一致分岐が該当。
       * `false` は daemon 自身が assignTask 内で送った /clear の戻り。
       */
      manualUserInitiated: boolean;
    }
  | { type: "SESSION_ACTIVE" }
  | { type: "SESSION_ASK" }
  | {
      type: "SESSION_ENDED";
      /** `"other"` は曖昧な終了なので reducer 側で no-op に落とす。 */
      reason: "stop" | "other" | string | undefined;
    }
  | {
      type: "TIMEOUT";
      /** STARTING_TIMEOUT_SEC / ASSIGNING_TIMEOUT_SEC / DISCONNECT_TIMEOUT_SEC 由来。 */
      kind: "starting" | "assigning" | "disconnected";
    }
  | {
      type: "ASSIGN";
      /** assignTask 成功 (true) / AssignTaskError (false) */
      ok: boolean;
      /** AssignTaskError.kind。ok=true の場合は undefined。 */
      errorKind?: "task" | "conductor";
    }
  | {
      type: "DONE";
      /** CONDUCTOR_DONE.success */
      success: boolean;
      /**
       * handleConductorDone 分岐結果。
       * true: judgment_pending (T269) — success=false かつ task が未完結 (assigned/missing)。
       * false: 通常完了 or T274 auto-close or late regression guard。
       */
      unresolved: boolean;
      /**
       * T274 判定に必要な「CONDUCTOR_DONE 受信時点の task-state.status」。
       * reducer は closed/aborted/deleted であれば late-regression と判断し、
       * success=false でも unresolved と扱わず worktree を消して idle に戻す。
       */
      currentTaskStatus?: TaskStatus;
    }
  | { type: "PID_DIED" }
  | {
      type: "CLEAR_MANUAL";
      /**
       * 予約 event。現状 emit されない。SESSION_CLEAR(manualUserInitiated=true) で
       * 同等セマンティクスを表現済み。将来 hook 外経路で user 発 /clear を検出する用途に残す。
       */
    }
  | { type: "REGISTERED" };

/** Task 側 reducer が扱う FSM イベント。 */
export type TaskFsmEvent =
  | { type: "CREATE" }
  | { type: "UPDATE_STATUS"; to: "draft" | "ready" }
  | { type: "ASSIGN_OK" }
  | { type: "ASSIGN_FAIL"; errorKind: "task" | "conductor" }
  | { type: "CLOSE" }
  | { type: "ABORT"; reason: string }
  | { type: "DELETE" }
  | { type: "RESTART" }
  | { type: "PARENT_ABORTED" };

/**
 * Conductor reducer の context (純関数化のため呼び出し側で計算済みの値を渡す)。
 */
export interface ConductorCtx {
  /** conductor.assignedTaskRunId != null (T232 running 不変条件用)。 */
  hasTaskRunId: boolean;
  /** SESSION_CLEAR 送信からの経過 ms (unused だが T261 統計と対称)。 */
  clearSentAtElapsedSec?: number;
  /** ASSIGNING_TIMEOUT_SEC = 60s の判定用経過 ms。 */
  assigningSetAtElapsedSec?: number;
  /** DISCONNECT_TIMEOUT_SEC = 300s の判定用経過 ms。 */
  disconnectedElapsedSec?: number;
  /** Master surface か (SESSION_* を Master では reducer 対象外にする)。*/
  isMasterSurface?: boolean;
  /** timeout 判定の共通タイムスタンプ (ms)。 */
  now: number;
}

/** Task reducer の context。 */
export interface TaskCtx {
  /** assigned 時は必ず Conductor が紐付く。 */
  hasConductor: boolean;
  /** cascade_children 起点になるか (親が aborted/deleted に遷移した直後)。 */
  parentAborted: boolean;
}

/**
 * reducer が返す副作用記述 (Conductor)。P1 では shadow.ts が log に出すのみで実行しない。
 */
export type ConductorAction =
  | {
      type: "reset_conductor";
      targetStatus: "idle" | "broken";
      reason?: string;
      preserveWorktree?: boolean;
    }
  | { type: "spawn_pid_watcher" }
  | { type: "abort_task"; reason: string }
  | { type: "cascade_children" }
  | { type: "close_task_auto" } // T274
  | { type: "notify_state_changed"; source: string }
  | { type: "log"; event: string; detail?: string };

/** reducer が返す副作用記述 (Task)。 */
export type TaskAction =
  | { type: "cascade_children"; parentId?: string }
  | { type: "log"; event: string; detail?: string };

export interface ConductorReducerResult {
  next: ConductorStatus;
  actions: ConductorAction[];
}

export interface TaskReducerResult {
  next: TaskStatus;
  actions: TaskAction[];
}
