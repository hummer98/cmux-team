/**
 * T279: shadow mode observer。
 *
 * daemon.ts の各 handler 末尾から呼ばれ、pure reducer (conductor-fsm.ts / task-fsm.ts) を
 * 実行して「期待次状態」を計算し、実 state (actualNext) との diff を `fsm_shadow_diff` ログに
 * 記録する。state mutation / notifyStateChanged は一切行わない (観測 only)。
 *
 * shadow 側の計算結果は別 Map (`shadowConductorMap` / `shadowTaskMap`) に保持し、
 * 実 state 型 (ConductorState / TaskStateEntry) には絶対に重ねない。
 *
 * 例外は握り潰さず `log("fsm_shadow_error", ...)` に記録 (CLAUDE.md ロギングポリシー準拠)。
 * shadow が壊れても既存処理に影響しないように、呼び出し側でも try/catch で包むこと。
 */

import { log, formatSurface } from "../logger";
import type {
  ConductorStatus,
  ConductorCtx,
  FsmEvent,
  TaskStatus,
  TaskCtx,
  TaskFsmEvent,
} from "./events";
import { conductorReduce } from "./conductor-fsm";
import { taskReduce } from "./task-fsm";
import {
  checkConductorInvariants,
  checkTaskInvariants,
} from "./invariants";

/**
 * Conductor 側の shadow 期待状態。実 state とは別管理。
 * surface 文字列 (例 `surface:665`) をキーにする。
 */
const shadowConductorMap = new Map<string, ConductorStatus>();
/**
 * Task 側の shadow 期待状態。taskId をキーにする。
 */
const shadowTaskMap = new Map<string, TaskStatus>();

/**
 * テスト用: shadow Map の内容を覗く / reset する。本番コードからは呼ばない。
 */
export function __getShadowConductor(surface: string): ConductorStatus | undefined {
  return shadowConductorMap.get(surface);
}
export function __getShadowTask(taskId: string): TaskStatus | undefined {
  return shadowTaskMap.get(taskId);
}
export function __resetShadowState(): void {
  shadowConductorMap.clear();
  shadowTaskMap.clear();
}

/**
 * Conductor 側 shadow observer。daemon.ts の handler 末尾から呼ばれる。
 *
 * @param surface - Conductor surface (例 `surface:665`)
 * @param prev - handler 冒頭でキャプチャ済みの実 state の前値
 * @param event - FsmEvent (handler 側で組み立てて渡す)
 * @param ctx - ConductorCtx (handler 側で組み立てて渡す)
 * @param actualNext - handler 完了後の実 state (前値と同値なら state 変化なし)
 */
export async function shadowObserveConductor(
  surface: string,
  prev: ConductorStatus,
  event: FsmEvent,
  ctx: ConductorCtx,
  actualNext: ConductorStatus,
): Promise<void> {
  try {
    const { next: expectedNext, actions } = conductorReduce(prev, event, ctx);

    if (expectedNext !== actualNext) {
      await log(
        "fsm_shadow_diff",
        `${formatSurface(surface, "C")} scope=conductor event=${event.type} prev=${prev} expected=${expectedNext} actual=${actualNext}`,
      );
    }

    // 不変条件検査 (期待次状態に対して)。違反は fsm_invariant_violation に別出し。
    const { violations } = checkConductorInvariants(expectedNext, ctx);
    for (const v of violations) {
      await log(
        "fsm_invariant_violation",
        `${formatSurface(surface, "C")} scope=conductor state=${expectedNext} violation=${v}`,
      );
    }

    // shadow 期待値を Map に保持 (実 state には絶対に重ねない)。
    shadowConductorMap.set(surface, expectedNext);

    // actions は P1 では log only (副作用は実行しない)。
    for (const a of actions) {
      await log(
        "fsm_shadow_action",
        `${formatSurface(surface, "C")} scope=conductor type=${a.type} detail=${JSON.stringify(a)}`,
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await log(
      "fsm_shadow_error",
      `${formatSurface(surface, "C")} scope=conductor event=${event.type} error=${msg}`,
    );
  }
}

/**
 * Task 側 shadow observer。task CLI handler / cascade 経路末尾から呼ばれる。
 *
 * @param taskId - Task の `T<NNN>` 形式 ID
 * @param prev - handler 冒頭でキャプチャ済みの実 task.status
 * @param event - TaskFsmEvent
 * @param ctx - TaskCtx
 * @param actualNext - handler 完了後の実 task.status
 */
export async function shadowObserveTask(
  taskId: string,
  prev: TaskStatus,
  event: TaskFsmEvent,
  ctx: TaskCtx,
  actualNext: TaskStatus,
): Promise<void> {
  try {
    const { next: expectedNext, actions } = taskReduce(prev, event, ctx);

    if (expectedNext !== actualNext) {
      await log(
        "fsm_shadow_diff",
        `scope=task task_id=${taskId} event=${event.type} prev=${prev} expected=${expectedNext} actual=${actualNext}`,
      );
    }

    const { violations } = checkTaskInvariants(expectedNext, ctx);
    for (const v of violations) {
      await log(
        "fsm_invariant_violation",
        `scope=task task_id=${taskId} state=${expectedNext} violation=${v}`,
      );
    }

    shadowTaskMap.set(taskId, expectedNext);

    for (const a of actions) {
      await log(
        "fsm_shadow_action",
        `scope=task task_id=${taskId} type=${a.type} detail=${JSON.stringify(a)}`,
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await log(
      "fsm_shadow_error",
      `scope=task task_id=${taskId} event=${event.type} error=${msg}`,
    );
  }
}
