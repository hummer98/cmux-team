/**
 * T303: daemon プロセス内 task-state mutation の唯一の入口。
 *
 * reducer (task-fsm.ts) を源泉として使い、非対応遷移は `noop` で弾く。
 * in-process mutex で load → reduce → patch merge/remove → cascade → save → shadow →
 * notifyStateChanged を直列化して lost-update を防ぐ。
 *
 * CLI プロセス（別 Node プロセス）との cross-process race は file lock では保護せず、
 * reducer の noop による観測的吸収に任せる（§1.1 / §3.4 — R1 選択理由）。
 *
 * 依存方向 (循環なし — R9):
 *   task-state-store → { logger, task, state-machine/{events,task-fsm,shadow}, apply-task-actions, eventBus }
 *   - logger は eventBus を import しない (CLAUDE.md EventBus ポリシー)
 */

import { log } from "../logger";
import { notifyStateChanged } from "../eventBus";
import { loadTaskState, saveTaskState } from "../task";
import type { TaskState, TaskStateMap } from "../task";
import { taskReduce } from "./task-fsm";
import { shadowObserveTask } from "./shadow";
import { applyTaskActions } from "./apply-task-actions";
import type { EventStreamContext } from "./apply-task-actions";
import type { TaskCtx, TaskFsmEvent, TaskStatus } from "./events";

// -----------------------------------------------------------------------------
// taskId shape invariant (T418)
// -----------------------------------------------------------------------------

/**
 * task-state.json のキー (taskId) として許容する形式。
 *
 * 現行 CLI は `String(maxId + 1).padStart(3, "0")` で 3 桁ゼロ埋め採番だが、
 * 将来 9999 タスクまでの拡張余地として 1〜4 桁の数字列を許容する。
 *
 * 旧 `daemon.ts::handleTodo` (削除済) が `Math.floor(Date.now()/1000)` を
 * ID として書き込んだ epoch 形式 zombie key (10 桁) を物理的にブロックする。
 * 詳細は `.team/tasks/418-task-state-json-epoch/runs/.../research.md` を参照。
 */
export const TASK_ID_RE = /^\d{1,4}$/;

export function assertTaskIdShape(taskId: string, caller: string): void {
  if (!TASK_ID_RE.test(taskId)) {
    throw new Error(
      `[${caller}] invalid taskId shape: ${JSON.stringify(taskId)} (expected /^\\d{1,4}$/)`,
    );
  }
}

// -----------------------------------------------------------------------------
// In-process mutex
// -----------------------------------------------------------------------------

let taskStateLock: Promise<void> = Promise.resolve();

/**
 * FIFO 保証の Promise チェーン方式 mutex。発行順に直列化される。
 * 全呼び出しで try/finally release を徹底 (リスク R1: デッドロック防止)。
 */
async function withTaskStateLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = taskStateLock;
  let release!: () => void;
  taskStateLock = new Promise<void>((r) => (release = r));
  try {
    await prev;
    return await fn();
  } finally {
    release();
  }
}

/** テスト専用: mutex を reset する。本番コードから呼ばない。 */
export function __resetTaskStateLockForTest(): void {
  taskStateLock = Promise.resolve();
}

// -----------------------------------------------------------------------------
// Patch types
// -----------------------------------------------------------------------------

/** T303 R4: patch API — merge で field 書き込み、remove で field 削除を明示。 */
export interface TaskStatePatch {
  merge?: Partial<TaskState>;
  remove?: Array<keyof TaskState>;
}

/** patch(prev, next) → TaskStatePatch の関数型。reducer noop 時は呼ばない契約。 */
export type TaskStatePatchFn = (
  prev: TaskState | undefined,
  next: TaskStatus,
) => TaskStatePatch;

// -----------------------------------------------------------------------------
// applyTaskEvent
// -----------------------------------------------------------------------------

export interface ApplyTaskEventInput {
  taskId: string;
  event: TaskFsmEvent;
  /** TaskCtx の一部。不足は内部でデフォルトを埋める。 */
  ctx?: Partial<TaskCtx>;
  /** status 以外のフィールド書き込み。reducer noop 時は呼ばない。 */
  patch?: TaskStatePatchFn;
  /**
   * T358: events.jsonl 転送用の追加 context。
   * apply-task-actions.ts の switch case で必要な field のみ caller が組み立てて渡す。
   * undefined の場合 spec §6 対応 5 種のうち eventStream 必須 case では emit が skip され
   * `events_writer_error` が manager.log に残る。
   */
  eventStream?: EventStreamContext;
}

export interface ApplyTaskEventResult {
  committed: boolean;
  /** reducer 呼出時の prev status (新規 entry に対する CREATE は undefined)。 */
  prev: TaskStatus | undefined;
  /** reducer 計算後の next status (noop 時は prev と同値)。 */
  next: TaskStatus;
  revertedChildren: string[];
}

/**
 * daemon プロセス内 task-state mutation の唯一の入口。
 *
 * 実行順序 (mutex 内):
 *   1. loadTaskState
 *   2. taskReduce(prev, event, ctx) → { next, actions }
 *   3. reducer noop (next === prev) → committed=false で early return
 *   4. patch(prev, next) → { merge, remove } を state に適用
 *      - merge で field を上書き、remove で field を削除
 *   5. applyTaskActions(actions) — cascade_children は state を in-place mutate し、
 *      子 shadow を呼ぶ。log アクションは logger に emit。
 *   6. saveTaskState
 *   7. shadowObserveTask(親) — prev → actualNext の観測
 *   8. notifyStateChanged(`task-state-store:applyTaskEvent:<event.type>:<taskId>`)
 *
 * **責務境界 (呼び出し側に残す副作用 — R8):**
 *   - trace DB insert (insertTaskSession 等)
 *   - cmux send / postMessage
 *   - resetConductor / worktree 削除 / launchConductor
 *   これらは applyTaskEvent の呼び出し前後で呼び出し側が明示的に行う。
 */
export async function applyTaskEvent(
  projectRoot: string,
  input: ApplyTaskEventInput,
): Promise<ApplyTaskEventResult> {
  assertTaskIdShape(input.taskId, "applyTaskEvent");
  return withTaskStateLock(async () => {
    const taskState = await loadTaskState(projectRoot);
    const cur = taskState[input.taskId];
    const ctx: TaskCtx = {
      hasConductor: input.ctx?.hasConductor ?? false,
      parentAborted: input.ctx?.parentAborted ?? false,
      initialStatus: input.ctx?.initialStatus,
    };

    // CREATE: 既存 entry に対しては idempotent skip
    if (input.event.type === "CREATE") {
      if (cur !== undefined) {
        await log(
          "task_create_idempotent_skip",
          `task_id=${input.taskId} existing_status=${cur.status}`,
        );
        return {
          committed: false,
          prev: cur.status as TaskStatus,
          next: cur.status as TaskStatus,
          revertedChildren: [],
        };
      }
      // 新規: reducer に fake prev="draft" を渡す
      const { next, actions } = taskReduce("draft", input.event, ctx);
      const patchValue = input.patch ? input.patch(undefined, next) : undefined;
      const newEntry: TaskState = { status: next };
      if (patchValue?.merge) Object.assign(newEntry, patchValue.merge);
      if (patchValue?.remove) {
        for (const k of patchValue.remove) {
          delete newEntry[k];
        }
      }
      taskState[input.taskId] = newEntry;

      // log / cascade actions を先に処理 (state in-place mutate)
      const { revertedChildren } = await applyTaskActions(actions, {
        projectRoot,
        taskId: input.taskId,
        state: taskState,
        childCtx: {
          hasConductor: false,
          parentAborted: true,
        },
        eventStream: input.eventStream,
      });

      await saveTaskState(projectRoot, taskState);

      try {
        await shadowObserveTask(input.taskId, "draft", input.event, ctx, next);
      } catch {
        // shadow は内部 try/catch で error log 済み
      }

      notifyStateChanged(
        `task-state-store:applyTaskEvent:${input.event.type}:${input.taskId}`,
      );

      return {
        committed: true,
        prev: undefined,
        next,
        revertedChildren,
      };
    }

    // 非 CREATE: 既存 entry の status を prev として reducer に渡す
    const prevStatus = (cur?.status as TaskStatus | undefined) ?? "draft";
    const { next, actions } = taskReduce(prevStatus, input.event, ctx);

    if (next === prevStatus) {
      // reducer noop: patch / save / shadow / notify すべてスキップ
      return {
        committed: false,
        prev: prevStatus,
        next,
        revertedChildren: [],
      };
    }

    // 遷移: patch を適用
    const baseEntry: TaskState = cur ? { ...cur } : { status: next };
    baseEntry.status = next;
    if (input.patch) {
      const patchValue = input.patch(cur, next);
      if (patchValue?.merge) Object.assign(baseEntry, patchValue.merge);
      if (patchValue?.remove) {
        for (const k of patchValue.remove) {
          delete baseEntry[k];
        }
      }
      // merge の status を最優先したいなら patch 内で明示的に書く (restart 経路で重要)
      if (patchValue?.merge && "status" in patchValue.merge && patchValue.merge.status) {
        baseEntry.status = patchValue.merge.status;
      }
    }
    taskState[input.taskId] = baseEntry;

    // log / cascade を先に処理 (state in-place mutate → save の順序で on-disk 一貫性保つ — P2-A)
    const { revertedChildren } = await applyTaskActions(actions, {
      projectRoot,
      taskId: input.taskId,
      state: taskState,
      childCtx: {
        hasConductor: false,
        parentAborted: true,
      },
      eventStream: input.eventStream,
    });

    await saveTaskState(projectRoot, taskState);

    try {
      await shadowObserveTask(input.taskId, prevStatus, input.event, ctx, next);
    } catch {
      // shadow は内部 try/catch で error log 済み
    }

    notifyStateChanged(
      `task-state-store:applyTaskEvent:${input.event.type}:${input.taskId}`,
    );

    return {
      committed: true,
      prev: prevStatus,
      next,
      revertedChildren,
    };
  });
}

// -----------------------------------------------------------------------------
// refreshTaskStateFromDisk — M2 bulk refresh ヘルパ (R6)
// -----------------------------------------------------------------------------

/**
 * applyTaskEvent / markTaskAborted 等の store 経由書き込み後、呼び出し側が
 * 保持している in-memory `taskState` 変数を on-disk の最新値に揃えるためのヘルパ。
 *
 * 目的: `applyTaskEvent` は内部で独立 load/save するため、呼び出し側のローカル変数
 * とは別 reference になる。sameness を保ちたいフロー (applyRestorePlan、
 * cmdStart の applyResumeTransitions 後処理) で利用する。
 *
 * store 経由でない直接 mutation を main.ts / daemon.ts から排除するための
 * ラッパ (Step 8 grep invariant の「{daemon,main}.ts に代入 0 件」を満たすため)。
 */
export async function refreshTaskStateFromDisk(
  projectRoot: string,
  mutable: TaskStateMap,
): Promise<void> {
  const refreshed = await loadTaskState(projectRoot);
  for (const k of Object.keys(refreshed)) {
    mutable[k] = refreshed[k]!;
  }
  for (const k of Object.keys(mutable)) {
    if (!(k in refreshed)) delete mutable[k];
  }
}

// -----------------------------------------------------------------------------
// updateTaskSessionId — D5 専用ヘルパ (R3)
// -----------------------------------------------------------------------------

export interface UpdateTaskSessionIdResult {
  written: boolean;
  reason?: "taskrun_mismatch" | "not_assigned" | "unchanged" | "no_entry";
}

/**
 * SESSION_STARTED 受信時に sessionId を task-state に追記する専用ヘルパ。
 *
 * 3 段 guard (daemon.ts 1498-1535 から移植):
 *   1. cur.taskRunId && cur.taskRunId !== taskRunId → skip (taskrun_mismatch)
 *   2. cur.status === "assigned" && cur.sessionId !== sessionId → write
 *   3. それ以外 → silent skip (not_assigned / unchanged / no_entry)
 *
 * status 遷移を伴わないため shadow observer は呼ばない (reducer の責務外)。
 * mutex 内で実行し、write 時のみ notifyStateChanged を呼ぶ。
 */
export async function updateTaskSessionId(
  projectRoot: string,
  taskId: string,
  sessionId: string,
  taskRunId: string | undefined,
): Promise<UpdateTaskSessionIdResult> {
  assertTaskIdShape(taskId, "updateTaskSessionId");
  return withTaskStateLock(async () => {
    const taskState = await loadTaskState(projectRoot);
    const cur = taskState[taskId];

    if (!cur) {
      return { written: false, reason: "no_entry" };
    }

    // Guard 1: taskRunId mismatch (両方が立っていて不一致 → stale と判定)
    if (taskRunId && cur.taskRunId && cur.taskRunId !== taskRunId) {
      return { written: false, reason: "taskrun_mismatch" };
    }

    // Guard 2: assigned + sessionId 差分 → write
    if (cur.status === "assigned" && cur.sessionId !== sessionId) {
      taskState[taskId] = { ...cur, sessionId };
      await saveTaskState(projectRoot, taskState);
      notifyStateChanged(
        `task-state-store:updateTaskSessionId:${taskId}`,
      );
      return { written: true };
    }

    // Guard 3: assigned でない or sessionId 一致 → silent skip
    if (cur.status !== "assigned") {
      return { written: false, reason: "not_assigned" };
    }
    return { written: false, reason: "unchanged" };
  });
}
