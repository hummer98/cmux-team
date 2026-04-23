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
  // CREATE は呼び出し側 (store) が既存 entry に対しては idempotent skip し、
  // 新規時のみ reducer に fake prev="draft" で渡すため、ここで deleted 除外しても支障ない。
  if (state === "deleted") {
    return noop(state);
  }

  switch (event.type) {
    case "CREATE": {
      // T303: CREATE は新規エントリ生成用。ctx.initialStatus で初期 status を指定
      // (draft / ready)。未指定時は draft。呼び出し側 store で既存 entry に対する
      // CREATE は reducer 到達前に idempotent skip される契約。
      const initial: TaskStatus = ctx.initialStatus ?? "draft";
      return withActions(initial, [{ type: "log", event: "task_created" }]);
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
      // T303: autoClosed=true (T274 auto-close) では区別可能な log event を emit する。
      if (state === "assigned" || state === "ready" || state === "draft") {
        const logEvent = event.autoClosed ? "task_completed_state_mismatch" : "task_closed";
        return withActions("closed", [{ type: "log", event: logEvent }]);
      }
      // closed / aborted からは no-op。
      return noop(state);
    }

    case "ABORT": {
      // abort-task CLI、user_clear、judgment_pending、resume_marked_aborted など。
      // T303 R17: reducer 側 log は `task_aborted_core` (wrapper 側の markTaskAborted は
      // `task_aborted` を別途 emit する)。二重 emit 防止のため別名に分離。
      if (state === "assigned" || state === "ready" || state === "draft") {
        return withActions("aborted", [
          { type: "log", event: "task_aborted_core", detail: `reason=${event.reason}` },
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
      // restart-task CLI。aborted / closed / assigned → ready。
      // T303: assigned → ready も許容。cmdRestartTask は走行中タスクのクリーンアップ後に
      // 再キューに戻す正当な経路で、A017 §2.2 の restart semantics と整合する。
      if (
        state === "aborted" ||
        state === "closed" ||
        state === "assigned"
      ) {
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

    case "REVERT_TO_READY": {
      // T303: assigned 救済経路のみ対象。D1〜D4 / M1 / M3 はすべて実 prev=assigned。
      // draft / ready / terminal (closed / aborted / deleted) はすべて noop。
      if (state === "assigned") {
        return withActions("ready", [
          { type: "log", event: "task_reverted_to_ready", detail: `reason=${event.reason}` },
        ]);
      }
      return noop(state);
    }
  }

  // exhaustive check
  const _exhaustive: never = event;
  void _exhaustive;
  return noop(state);
}
