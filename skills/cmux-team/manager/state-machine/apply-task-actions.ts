/**
 * T303: reducer (task-fsm.ts) が返した TaskAction[] を daemon 側副作用にブリッジする
 * 薄いディスパッチャ。`applyTaskEvent` 内部から mutex を保持したまま呼ばれる想定。
 *
 * 責務:
 *   - `log`            → logger.log(event, detail) にそのまま流す。spec §6 対応 5 種だけ
 *                        events.jsonl にも emit する（T358 M4 allowlist）
 *   - `cascade_children` → cascadeAbortToChildrenInPlace で state を in-place 更新し、
 *                          ready→draft に遷移した各 childId に対して
 *                          shadowObserveTask(childId, "ready", PARENT_ABORTED, childCtx, "draft")
 *                          を呼ぶ (R5 反映)
 *
 * 注意: `state` (TaskStateMap) は mutation buffer。呼び出し側 (task-state-store) が
 * cascade 処理完了後に `saveTaskState` で on-disk に flush する。
 */

import { log } from "../logger";
import { shadowObserveTask } from "./shadow";
import {
  cascadeAbortToChildrenInPlace,
  loadTasks,
} from "../task";
import type { TaskStateMap } from "../task";
import type { TaskAction, TaskCtx } from "./events";
import { emitEvent, type RevertReason } from "../events-writer";

/**
 * T358: log action 経由で events.jsonl に転送するときに必要な追加 context。
 *
 * reducer 自体は status 遷移とイベント名だけを知っている純関数のため、
 * spec §6 payload に必要な surface / taskRunId / title 等は caller (daemon.ts /
 * main.ts / task.ts) からこの context 経由で渡す。switch case と event 名の対応は
 * `dispatchEventStreamLog` を参照。
 */
export interface EventStreamContext {
  /** task_created で必要 */
  taskTitle?: string;
  /** task_assigned / task_completed_state_mismatch */
  conductorSurface?: string;
  /** task_assigned */
  taskRunId?: string;
  /** task_completed_state_mismatch */
  worktreePath?: string;
  /** task_completed_state_mismatch */
  journalSummary?: string;
}

export interface ApplyTaskActionsContext {
  projectRoot: string;
  taskId: string;
  /**
   * save 前の mutation buffer。
   * cascade_children はこの state を直接 mutate し、呼び出し側が saveTaskState で flush する。
   */
  state: TaskStateMap;
  /** cascade 子への shadow observer 呼出時に使う ctx */
  childCtx: TaskCtx;
  /** T358: events.jsonl 転送用の追加 context（caller が組み立てる） */
  eventStream?: EventStreamContext;
}

export interface ApplyTaskActionsResult {
  revertedChildren: string[];
}

/**
 * spec §6 対応 5 種だけ events.jsonl に emit する allowlist。
 * それ以外の log action 名（task_closed / task_deleted / task_aborted_core / 等）
 * は logger.log のみに残し、events.jsonl には流さない（T358 M4）。
 *
 * caller 側で必要な eventStream context が渡されていなければ
 * `events_writer_error` を残して emit 自体を skip する（design-review 新たな懸念 1）。
 */
async function dispatchEventStreamLog(
  taskId: string,
  event: string,
  detail: string | undefined,
  ctx: EventStreamContext | undefined,
): Promise<void> {
  switch (event) {
    case "task_created": {
      // ctx 自体は optional（fallback として空 title を許す）。
      const title = ctx?.taskTitle ?? "";
      await emitEvent({ event: "task_created", task_id: taskId, title });
      return;
    }
    case "task_ready": {
      await emitEvent({ event: "task_ready", task_id: taskId });
      return;
    }
    case "task_assigned": {
      if (!ctx?.conductorSurface || !ctx.taskRunId) {
        await log(
          "events_writer_error",
          `missing eventStream context for event=task_assigned task_id=${taskId}`,
        );
        return;
      }
      await emitEvent({
        event: "task_assigned",
        task_id: taskId,
        conductor_surface: ctx.conductorSurface,
        task_run_id: ctx.taskRunId,
      });
      return;
    }
    case "task_completed_state_mismatch": {
      if (ctx?.conductorSurface === undefined) {
        await log(
          "events_writer_error",
          `missing eventStream context for event=task_completed_state_mismatch task_id=${taskId}`,
        );
        return;
      }
      await emitEvent({
        event: "task_completed_state_mismatch",
        task_id: taskId,
        conductor_surface: ctx.conductorSurface,
        reason: "missing_close_task",
        worktree_path: ctx.worktreePath ?? "",
        journal_summary: ctx.journalSummary ?? "",
      });
      return;
    }
    case "task_reverted_to_ready": {
      // reducer detail は `reason=<RevertReason>` 形式（task-fsm.ts:159）。
      const m = detail?.match(/(?:^|\s)reason=([a-z_]+)/);
      const reason = (m?.[1] ?? "") as RevertReason;
      if (!reason) {
        await log(
          "events_writer_error",
          `missing reason in detail for event=task_reverted_to_ready task_id=${taskId} detail=${detail ?? ""}`,
        );
        return;
      }
      await emitEvent({
        event: "task_reverted_to_ready",
        task_id: taskId,
        reason,
      });
      return;
    }
    default:
      // allowlist 外の log は events.jsonl に流さない（manager.log だけに残す）。
      return;
  }
}

export async function applyTaskActions(
  actions: TaskAction[],
  context: ApplyTaskActionsContext,
): Promise<ApplyTaskActionsResult> {
  let revertedChildren: string[] = [];

  for (const action of actions) {
    if (action.type === "log") {
      await log(action.event, action.detail ?? "");
      await dispatchEventStreamLog(
        context.taskId,
        action.event,
        action.detail,
        context.eventStream,
      );
      continue;
    }
    if (action.type === "cascade_children") {
      const { tasks } = await loadTasks(context.projectRoot);
      const { revertedChildren: children } = cascadeAbortToChildrenInPlace(
        context.state,
        tasks,
        context.taskId,
      );
      revertedChildren = children;
      // cascade 子は reducer を通らない in-place mutation なので、ここで
      // shadow observer を明示的に呼ぶ (R5)。
      for (const childId of children) {
        try {
          await shadowObserveTask(
            childId,
            "ready",
            { type: "PARENT_ABORTED" },
            context.childCtx,
            "draft",
          );
        } catch {
          // shadowObserveTask は内部で try/catch + fsm_shadow_error を記録するので
          // ここでは追加処理不要 (二重記録防止)
        }
      }
      continue;
    }
    // exhaustive check
    const _exhaustive: never = action;
    void _exhaustive;
  }

  return { revertedChildren };
}
