/**
 * T279: Task 側 FSM reducer。
 *
 * A017 §2.2 の遷移表に対応。純関数で副作用なし。
 *
 * Task.status は task.ts 時点で `string` 型のため、reducer 側では
 * events.ts の `TaskStatus` union (6 値) のみ扱う。`in_progress` 等の
 * 既存の string リテラルで出現する値は reducer の対象外 (そもそも A017 にも無い)。
 */

import type {
  TaskStatus,
  TaskCtx,
  TaskAction,
  TaskFsmEvent,
  TaskReducerResult,
} from "./events";

function noop(state: TaskStatus): TaskReducerResult {
  return { next: state, actions: [] };
}

function withActions(next: TaskStatus, actions: TaskAction[]): TaskReducerResult {
  return { next, actions };
}

/**
 * Task 側 reducer。deleted は終端 state (復活経路なし)。
 */
export function taskReduce(
  state: TaskStatus,
  event: TaskFsmEvent,
  ctx: TaskCtx,
): TaskReducerResult {
  // deleted は復活不可な終端 state。全 event で no-op。
  if (state === "deleted") {
    return noop(state);
  }

  switch (event.type) {
    case "CREATE": {
      // CREATE は新規作成時の記録用。reducer としては state 変化なし。
      return withActions(state, [{ type: "log", event: "task_created" }]);
    }

    case "UPDATE_STATUS": {
      // draft ⇔ ready の手動切替。assigned / closed / aborted からは来ない前提。
      if (state === "draft" && event.to === "ready") {
        return withActions("ready", [{ type: "log", event: "task_ready" }]);
      }
      if (state === "ready" && event.to === "draft") {
        return withActions("draft", [{ type: "log", event: "task_reverted_to_draft" }]);
      }
      // 同じ status への update や unsupported transition は no-op。
      return noop(state);
    }

    case "ASSIGN_OK": {
      // scanTasks の assignTask 成功経路。ready → assigned。
      if (state === "ready") {
        return withActions("assigned", [
          { type: "log", event: "task_assigned" },
        ]);
      }
      return noop(state);
    }

    case "ASSIGN_FAIL": {
      // errorKind=task は task 側を aborted に倒す (daemon.ts:2460 相当)。
      // errorKind=conductor は Conductor 側を disconnected にして task は ready のまま。
      if (event.errorKind === "task" && state === "ready") {
        return withActions("aborted", [
          { type: "log", event: "task_aborted", detail: "reason=assign_failed kind=task" },
          { type: "cascade_children" },
        ]);
      }
      return withActions(state, [
        { type: "log", event: "assign_failed", detail: `kind=${event.errorKind}` },
      ]);
    }

    case "CLOSE": {
      // close-task CLI。assigned → closed が主経路。ready / draft からも可 (手動 close)。
      if (state === "assigned" || state === "ready" || state === "draft") {
        return withActions("closed", [{ type: "log", event: "task_closed" }]);
      }
      // closed / aborted からは no-op。
      return noop(state);
    }

    case "ABORT": {
      // abort-task CLI、user_clear、judgment_pending、resume_marked_aborted など。
      if (state === "assigned" || state === "ready" || state === "draft") {
        return withActions("aborted", [
          { type: "log", event: "task_aborted", detail: `reason=${event.reason}` },
          { type: "cascade_children" },
        ]);
      }
      return noop(state);
    }

    case "DELETE": {
      // delete-task CLI。draft / ready のみ許可 (assigned は禁止)。
      if (state === "draft" || state === "ready") {
        return withActions("deleted", [
          { type: "log", event: "task_deleted" },
          { type: "cascade_children" },
        ]);
      }
      return noop(state);
    }

    case "RESTART": {
      // restart-task CLI。aborted / closed → ready。
      if (state === "aborted" || state === "closed") {
        return withActions("ready", [{ type: "log", event: "task_restarted" }]);
      }
      return noop(state);
    }

    case "PARENT_ABORTED": {
      // cascade_children 経路。ready の子のみ draft に戻す (T241)。
      if (state === "ready") {
        return withActions("draft", [
          { type: "log", event: "child_reverted_to_draft", detail: "reason=parent_aborted" },
        ]);
      }
      // draft / assigned / closed / aborted の子は変更なし (CLAUDE.md T241 節参照)。
      return noop(state);
    }
  }

  // exhaustive check
  const _exhaustive: never = event;
  void _exhaustive;
  return noop(state);
}
