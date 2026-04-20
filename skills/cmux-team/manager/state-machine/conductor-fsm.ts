/**
 * T279: Conductor 側 FSM reducer。
 *
 * 純関数。`conductorReduce(state, event, ctx)` は {next, actions} を返し、
 * 副作用は一切発生させない。shadow.ts が呼び出し、actions は log に出すだけ。
 *
 * A017 §1.2 の遷移表を実装の正として扱う。daemon.ts の既存ロジックとの乖離は
 * `fsm_shadow_diff` に落ちるため impl-report / A017 §5 に記録する。
 */

import type {
  ConductorStatus,
  ConductorCtx,
  ConductorAction,
  ConductorReducerResult,
  FsmEvent,
} from "./events";

const EMPTY_ACTIONS: ConductorAction[] = [];

function noop(state: ConductorStatus): ConductorReducerResult {
  return { next: state, actions: [] };
}

function withActions(
  next: ConductorStatus,
  actions: ConductorAction[],
): ConductorReducerResult {
  return { next, actions };
}

/**
 * Conductor 側 reducer 本体。broken は全 event で no-op を返す終端状態。
 */
export function conductorReduce(
  state: ConductorStatus,
  event: FsmEvent,
  ctx: ConductorCtx,
): ConductorReducerResult {
  // broken は明示的 clear-conductor でのみ解除される (daemon.ts:1442 など多数の
  // logBrokenIgnore 経路)。reducer では全 event 対して no-op (actions は空)。
  if (state === "broken") {
    return noop(state);
  }

  switch (event.type) {
    case "REGISTERED": {
      // CONDUCTOR_REGISTERED は新規登録時のみ意味を持つ (daemon.ts:1611 以降)。
      // 既存 state で register が来た場合は idempotent skip 扱いで no-op にする。
      // shadow 呼び出し元は「idempotent skip も no-op」として記録する。
      if (state === "starting") return noop(state);
      // 新規 state が register される場合の期待値も starting (但し現実には事前に state が
      // 登録されている経路はないため、reducer としては state 変化なし)
      return noop(state);
    }

    case "SESSION_STARTED": {
      if (event.isMasterSurface || ctx.isMasterSurface) {
        // Master の SESSION_STARTED は Conductor FSM の対象外。
        return noop(state);
      }
      if (state === "starting" || state === "disconnected") {
        return withActions("idle", [
          { type: "spawn_pid_watcher" },
          {
            type: "log",
            event: state === "starting" ? "conductor_ready" : "conductor_recovered",
          },
        ]);
      }
      if (state === "assigning") {
        // T232 メイン経路: /clear 完了 → SESSION_STARTED(source=clear) で running へ。
        // reducer は source を厳密には問わないが、実 daemon は source=clear でのみ走る。
        // ここでは hasTaskRunId=true 前提で running に倒す。
        return withActions("running", [
          { type: "spawn_pid_watcher" },
          { type: "log", event: "conductor_running", detail: `via=SESSION_STARTED source=${event.source ?? "-"}` },
        ]);
      }
      // idle/running/asking で SESSION_STARTED を受けた場合は pid 更新のみで状態遷移なし。
      return withActions(state, [{ type: "spawn_pid_watcher" }]);
    }

    case "SESSION_IDLE": {
      if (state === "asking") {
        // T181 解決経路。hasTaskRunId で分岐。
        const next: ConductorStatus = ctx.hasTaskRunId ? "running" : "idle";
        return withActions(next, [
          { type: "log", event: "conductor_ask_resolved", detail: `new_status=${next}` },
        ]);
      }
      if (state === "disconnected") {
        const next: ConductorStatus = ctx.hasTaskRunId ? "running" : "idle";
        return withActions(next, [
          { type: "log", event: "conductor_recovered", detail: `via=SESSION_IDLE new_status=${next}` },
        ]);
      }
      if (state === "starting") {
        return withActions("idle", [{ type: "log", event: "conductor_ready", detail: "via=SESSION_IDLE" }]);
      }
      // T277: assigning 中の SESSION_IDLE は no-op (R1 保険経路は撤去済み)。
      // idle / running は pid ping 相当で状態変化なし。
      return noop(state);
    }

    case "SESSION_CLEAR": {
      if (state === "assigning") {
        // daemon 自身の /clear 戻り。session_clear_expected 経路。assigning 維持。
        return withActions(state, [
          { type: "log", event: "session_clear_expected", detail: "reason=daemon_assign_clear" },
        ]);
      }
      if (state === "disconnected" || state === "starting") {
        return withActions("idle", [
          {
            type: "log",
            event: state === "starting" ? "conductor_ready" : "conductor_recovered",
            detail: "via=SESSION_CLEAR",
          },
        ]);
      }
      if (state === "running") {
        // daemon.ts:2103 の user_clear 判定相当。manualUserInitiated=true で task abort + reset。
        if (event.manualUserInitiated) {
          return withActions("idle", [
            { type: "abort_task", reason: "user_clear" },
            { type: "cascade_children" },
            { type: "reset_conductor", targetStatus: "idle", reason: "user_clear" },
            { type: "log", event: "task_aborted", detail: "reason=user_clear" },
          ]);
        }
        // manualUserInitiated=false だが running で受けた SESSION_CLEAR は異常
        // (daemon 自身の /clear は assigning 経路でのみ想定)。state 変化は起こさず log のみ。
        return withActions(state, [
          { type: "log", event: "session_clear_unexpected_running", detail: "manual=false" },
        ]);
      }
      // idle / asking で SESSION_CLEAR は観測 only。
      return noop(state);
    }

    case "SESSION_ACTIVE": {
      if (state === "disconnected") {
        return withActions("running", [
          { type: "log", event: "conductor_recovered", detail: "via=SESSION_ACTIVE new_status=running" },
        ]);
      }
      if (state === "starting") {
        return withActions("idle", [
          { type: "log", event: "conductor_ready", detail: "via=SESSION_ACTIVE" },
        ]);
      }
      if (state === "assigning" && ctx.hasTaskRunId) {
        // T232 R1 相当。assigning → running (hasTaskRunId 条件付き)。
        return withActions("running", [
          { type: "log", event: "conductor_running", detail: "via=SESSION_ACTIVE" },
        ]);
      }
      return noop(state);
    }

    case "SESSION_ASK": {
      if (state === "idle" || state === "running" || state === "starting" || state === "assigning" || state === "disconnected" || state === "asking") {
        return withActions("asking", [{ type: "log", event: "conductor_asking" }]);
      }
      return noop(state);
    }

    case "SESSION_ENDED": {
      if (event.reason === "other") {
        // T216: other は曖昧な終了なので状態遷移しない (記録のみ)。
        return withActions(state, [
          { type: "log", event: "session_ended_other_ignored", detail: "reason=other" },
        ]);
      }
      if (state === "idle" || state === "running" || state === "asking" || state === "assigning" || state === "starting") {
        return withActions("disconnected", [
          { type: "log", event: "session_ended", detail: `reason=${event.reason ?? "-"}` },
          { type: "log", event: "conductor_disconnected", detail: `reason=session_ended:${event.reason ?? "-"}` },
        ]);
      }
      // disconnected 状態での SESSION_ENDED は重複通知なので no-op。
      return noop(state);
    }

    case "PID_DIED": {
      if (state === "idle" || state === "running" || state === "asking" || state === "assigning" || state === "starting") {
        return withActions("disconnected", [
          { type: "log", event: "session_ended", detail: "reason=pid_watcher" },
          { type: "log", event: "conductor_disconnected", detail: "reason=pid_dead" },
        ]);
      }
      return noop(state);
    }

    case "TIMEOUT": {
      if (event.kind === "starting" && state === "starting") {
        return withActions("disconnected", [
          { type: "log", event: "conductor_start_timeout" },
        ]);
      }
      if (event.kind === "assigning" && state === "assigning") {
        return withActions("disconnected", [
          { type: "log", event: "assigning_window_close", detail: "via=timeout" },
          { type: "log", event: "conductor_assign_timeout" },
        ]);
      }
      if (event.kind === "disconnected" && state === "disconnected") {
        return withActions("broken", [
          { type: "abort_task", reason: "disconnect_timeout" },
          { type: "cascade_children" },
          { type: "reset_conductor", targetStatus: "broken", reason: "disconnect_timeout" },
          { type: "log", event: "conductor_disconnect_timeout" },
        ]);
      }
      return noop(state);
    }

    case "ASSIGN": {
      if (!event.ok) {
        if (event.errorKind === "conductor") {
          // daemon.ts:2500 相当。assigning 状態になる前の保険も含めて disconnected。
          return withActions("disconnected", [
            { type: "log", event: "conductor_disconnected", detail: "reason=assign_failed kind=conductor" },
          ]);
        }
        // errorKind=task: タスク側の問題。Conductor は idle のまま。
        // daemon.ts:2460 — task を aborted にするが Conductor 側の状態は維持。
        // ただし同経路で assigning にセット済みなら disconnected に倒す (R2 保険、daemon.ts:2487)。
        if (state === "assigning") {
          return withActions("disconnected", [
            { type: "log", event: "conductor_disconnected", detail: "reason=assigning_stuck kind=task" },
          ]);
        }
        return withActions(state, [
          { type: "log", event: "assign_failed", detail: `kind=${event.errorKind ?? "-"}` },
        ]);
      }
      // assign 成功: idle → assigning (assignTask 内で status=assigning がセットされる)。
      if (state === "idle") {
        return withActions("assigning", [
          { type: "log", event: "conductor_assigning" },
        ]);
      }
      return noop(state);
    }

    case "DONE": {
      // handleConductorDone (daemon.ts:2879〜) と同分岐。
      // unresolved: worktree 温存 + task aborted (judgment_pending)。
      // success + currentTaskStatus=assigned: T274 auto-close。
      // それ以外 (success=true or late-regression): 正常完了。
      if (state !== "running" && state !== "asking") {
        // late_cleanup 経路 (daemon.ts:1303) を無視して no-op。
        return noop(state);
      }
      if (event.unresolved) {
        return withActions("idle", [
          { type: "abort_task", reason: "judgment_pending" },
          { type: "cascade_children" },
          { type: "reset_conductor", targetStatus: "idle", preserveWorktree: true, reason: "judgment_pending" },
          { type: "log", event: "conductor_done_unresolved" },
        ]);
      }
      if (event.success && event.currentTaskStatus === "assigned") {
        return withActions("idle", [
          { type: "close_task_auto" },
          { type: "reset_conductor", targetStatus: "idle", reason: "auto_close" },
          { type: "log", event: "task_completed_state_mismatch" },
        ]);
      }
      return withActions("idle", [
        { type: "reset_conductor", targetStatus: "idle", reason: "done" },
        { type: "log", event: "task_completed" },
      ]);
    }

    case "CLEAR_MANUAL": {
      // 予約 event。現状 emit されないが exhaustive check のため case を持つ。
      // running/asking なら user 発 /clear と同じく task abort。
      if (state === "running" || state === "asking") {
        return withActions("idle", [
          { type: "abort_task", reason: "clear_manual" },
          { type: "cascade_children" },
          { type: "reset_conductor", targetStatus: "idle", reason: "clear_manual" },
          { type: "log", event: "conductor_clear_manual" },
        ]);
      }
      return noop(state);
    }
  }

  // exhaustive check — 全 event が上の switch で処理済みであることを compile time に保証する。
  const _exhaustive: never = event;
  void _exhaustive;
  void EMPTY_ACTIONS;
  return noop(state);
}
