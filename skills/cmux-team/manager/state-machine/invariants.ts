/**
 * T279: reducer 及び実 state の不変条件検査。
 * 違反検出時は `fsm_invariant_violation` イベントで log に記録するのみ (throw しない)。
 *
 * P1 では shadow.ts から呼ばれ、副作用を発生させない (実 state を書き換えない)。
 */

import { log, formatSurface } from "../logger";
import type { ConductorStatus, ConductorCtx, TaskStatus, TaskCtx } from "./events";

/** 検査結果を string[] で返すヘルパー (テストで violation 有無を assert できるようにする)。 */
export interface InvariantReport {
  violations: string[];
}

/**
 * Conductor 側の不変条件検査。現状の検査項目:
 *   I1. running ⇒ hasTaskRunId
 *   I2. broken は assignedTaskRunId を持たない (running から遷移し得ないため、
 *       `hasTaskRunId=false` でなければ違反)
 *
 * ctx 不在の項目 (例: broken 時の worktree 存在) は呼び出し側で別経路で検査する。
 */
export function checkConductorInvariants(
  state: ConductorStatus,
  ctx: ConductorCtx,
): InvariantReport {
  const violations: string[] = [];
  if (state === "running" && !ctx.hasTaskRunId) {
    violations.push("I1: running without hasTaskRunId");
  }
  if (state === "broken" && ctx.hasTaskRunId) {
    violations.push("I2: broken still has taskRunId");
  }
  return { violations };
}

/**
 * Task 側の不変条件検査。
 *   T1. assigned ⇒ hasConductor
 *   T2. draft/ready は parentAborted=true では入らない (cascade で draft に戻す経路は OK だが、
 *       ready で parentAborted が true のまま残るのは `child_reverted_to_draft` 未実行の兆候)
 */
export function checkTaskInvariants(
  state: TaskStatus,
  ctx: TaskCtx,
): InvariantReport {
  const violations: string[] = [];
  if (state === "assigned" && !ctx.hasConductor) {
    violations.push("T1: assigned without hasConductor");
  }
  if (state === "ready" && ctx.parentAborted) {
    violations.push("T2: ready with parentAborted=true (cascade missed?)");
  }
  return { violations };
}

/**
 * Conductor 側 invariant 違反を log に記録する。shadow.ts から呼ぶ。
 * throw しない — 既存処理への影響ゼロを保証する (CLAUDE.md ロギングポリシー準拠)。
 */
export async function assertConductorInvariants(
  surface: string,
  state: ConductorStatus,
  ctx: ConductorCtx,
): Promise<void> {
  const { violations } = checkConductorInvariants(state, ctx);
  for (const v of violations) {
    await log(
      "fsm_invariant_violation",
      `${formatSurface(surface, "C")} scope=conductor state=${state} violation=${v}`,
    );
  }
}

/** Task 側 invariant 違反を log に記録する。 */
export async function assertTaskInvariants(
  taskId: string,
  state: TaskStatus,
  ctx: TaskCtx,
): Promise<void> {
  const { violations } = checkTaskInvariants(state, ctx);
  for (const v of violations) {
    await log(
      "fsm_invariant_violation",
      `scope=task task_id=${taskId} state=${state} violation=${v}`,
    );
  }
}
