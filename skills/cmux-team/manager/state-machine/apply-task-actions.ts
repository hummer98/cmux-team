/**
 * T303: reducer (task-fsm.ts) が返した TaskAction[] を daemon 側副作用にブリッジする
 * 薄いディスパッチャ。`applyTaskEvent` 内部から mutex を保持したまま呼ばれる想定。
 *
 * 責務:
 *   - `log`            → logger.log(event, detail) にそのまま流す
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
}

export interface ApplyTaskActionsResult {
  revertedChildren: string[];
}

export async function applyTaskActions(
  actions: TaskAction[],
  context: ApplyTaskActionsContext,
): Promise<ApplyTaskActionsResult> {
  let revertedChildren: string[] = [];

  for (const action of actions) {
    if (action.type === "log") {
      await log(action.event, action.detail ?? "");
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
