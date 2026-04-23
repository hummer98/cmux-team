# T303 実装計画書: task-state mutation を pure reducer 経由に置換し SSOT を確立する

> Planner Agent: task-303-1776910530/planner-2 (revision)
> 作成日: 2026-04-23
> 更新日: 2026-04-23 (Design Review R1〜R19 反映)
> 対象ブランチ: `task-303-1776910530/task`
> 依存: T279（P1 shadow observer）完了済み / T302（assign 上書きガード）導入済み

---

## 0. 改訂履歴

- **rev2 (2026-04-23)**: Design Review（reviewer: task-303-1776910530/reviewer）の指摘 R1〜R19 を反映。
  - P0 修正: SSOT 射程の明示化（R1）/ `RESUME_REVERT_TO_READY` reducer guard 是正（R2）/ D5 専用ヘルパ分離（R3）
  - P1 修正: patch signature 変更（R4）/ cascade 子の shadow 配線（R5）/ bulk refresh 主張撤回（R6）/ `resetConductor` 条件分岐分割（R7）/ trace DB 責務明示（R8）/ notifyStateChanged 明示（R9）
  - P2 反映: event 名 `REVERT_TO_READY` に変更（R10）/ 完了基準明確化（R11）/ ログ rename 影響無しの明示（R12）/ mutex テスト assert 具体化（R13）/ `createTaskEntry` 比較と選択理由（R14）/ grep invariant 拡張（R15）/ `taskStateModified` flag 削除（R16）/ log emit 責務明示（R17）/ `__testApplyAssignCommit` export 削除（R18）/ 将来の Conductor P2 との対称性（R19）

---

## 1. 目的とスコープ

### 1.1 狙い

`task-state.json` への書き込みが daemon.ts / main.ts / task.ts に散在しており、pure reducer（`task-fsm.ts`）の遷移ガードを **バイパスしたまま** mutation できる構造が T220 / T302 の race を生んだ根本原因。本タスクで以下を達成する。

1. **daemon プロセス内の全 task-state mutation を単一の書き込み API に集約** — reducer を源泉（source of truth）として使い、非対応遷移は reducer 側 `noop` で弾く
2. **Task 側 shadow observer を配線** — P1 で未配線の `shadowObserveTask` を各 mutation 箇所に置き、reducer 期待値と実 state の drift を 24h 観測で検出する
3. **T302 暫定ガード撤去** — `__testApplyAssignCommit` 内の `assign_skipped_terminal` 分岐を reducer の `ASSIGN_OK` noop（`state !== "ready"`）に一元化し、コードパスを二重化しない
4. **in-process mutex で atomic write** — daemon プロセス内の `loadTaskState → modify → saveTaskState` を直列化して lost-update を防ぐ

> **SSOT の射程について（R1 反映）**
> 本タスクの「SSOT」は **daemon プロセス内の SSOT** である。`cmux-team close-task` 等の CLI 経路は新 Node プロセスで起動されるため、in-process mutex では保護できない。CLI ↔ daemon 間の cross-process race は、T302 と同じく **reducer noop（`ASSIGN_OK` / `CLOSE` / `ABORT` 等の guard による弾き）で観測的に吸収する**方針を採る（下記 P0-1 選択肢の (B)）。真の cross-process SSOT（file lock による排他化）は **別タスクに切り出す**（番号は本 PR マージ後に採番）。選択理由: T220 / T302 で既に観測された race は「CLI 側 abort が先行し、daemon 側 assign が古い load を書き戻す」パターンで、これは `ASSIGN_OK` の reducer guard で落ちるため追加の file lock 無しで吸収できる。file lock は observability（shadow diff）が 0 件で推移することを 24h 確認してから必要性を判断する。

### 1.2 スコープに含むもの

- `state-machine/events.ts`: `TaskFsmEvent` に新規 event 追加（`REVERT_TO_READY` — R10 採用で `RESUME_REVERT_TO_READY` から改名）
- `state-machine/task-fsm.ts`: 新 event の遷移定義（`assigned` のみ `ready` に遷移、他は noop — R2 反映）
- 新規 `state-machine/apply-task-actions.ts`: 薄い action ディスパッチャ（Conductor 側 P2 で `apply-conductor-actions.ts` と対称になる設計 — R19 反映）
- 新規 `state-machine/task-state-store.ts`: reducer 経由の書き込み API（mutex + shadow observer 呼出 + `notifyStateChanged` を内包 — R9 反映）
- daemon.ts / main.ts の全直接 mutation を書き込み API 経由に置換（`taskStateModified` flag も一括削除 — R16 反映）
- `task.ts` の `markTaskAborted` / `createTaskProgrammatic` も store 経由に合流
- `docs/spec/07-state-machine.md` の更新（§4 shadow 配線追記、§2.2 遷移表に新 event 追加、§5 に P2 完了記録）
- 新規ユニットテスト: reducer 新 event / apply-task-actions（cascade 子の shadow 呼出を含む） / mutex 直列化（R13 で assert 具体化） / T302 ガード削除後の terminal race

### 1.3 スコープ外（別タスク化の候補）

- **file lock によるクロスプロセス保護**: §1.1 脚注の通り別タスクに切り出す。観測（24h shadow 0 件）の結果次第で優先度を決める
- **sessionId-only メタデータ更新の汎用化**: `daemon.ts:1523` の `sessionId` 単独更新は status 遷移ではないので reducer 対象外。D5 専用ヘルパ `updateTaskSessionId` に隔離する（§3.1 / R3 反映）
- **Conductor 側 reducer の P2 置換**: `ConductorAction` の `reset_conductor` / `close_task_auto` 等は副作用が多岐にわたるため T279 計画通り shadow log のみで継続。Task 側の完了を見てから別タスクで Conductor 側 P2 を検討する。本タスクで新設する `apply-task-actions.ts` は Conductor 側 `apply-conductor-actions.ts` と対称になる設計を採用する（R19 反映）
- **A017 §5 の correction 更新**: A017 は運用スナップショットなので、仕様面の追補は 07-state-machine.md 側で行い、A017 は触らない

### 1.4 完了基準（R11 反映）

- **構造的**: Step 8 の grep invariant（§4 Step 8 / R15 で拡張）がすべて 0 件
- **動作**: `bun test` 全通過、`bunx tsc --noEmit` 型エラー 0
- **観測（24h）**: `fsm_shadow_diff` / `fsm_invariant_violation` / `fsm_shadow_error` がいずれも 0 件。1 件でも出た場合は「配線側のバグ」として即修正タスクを起票し、本 PR の P2 完了条件は「修正後 24h で 0 件」に書き換えて再観測する（P1 完了基準の「既知差分可」より厳格化）

---

## 2. 現状調査

### 2.1 Task shadow observer の配線状況

`grep -n shadowObserveTask skills/cmux-team/manager/{daemon,main,task}.ts` → **0 件**。
`state-machine/shadow.ts:118` に定義はあるが呼び出しは一箇所も無い（P1 の実質未完了部分）。Conductor 側は 17 箇所で配線済み（§1.3 で確認）。

### 2.2 daemon.ts 内の task-state mutation 箇所

```
grep -nE 'taskState\[|ts\[[^\]]+\]\s*=' skills/cmux-team/manager/daemon.ts
```

| # | 行 | mutation | 目的 | 対応 reducer event |
|---|---|---|---|---|
| D1 | 908 | `ts[taskId] = { ...ts[taskId], status: "ready" }` | `revertTaskToReady` 汎用ヘルパ（救済経路） | `REVERT_TO_READY`（新規）|
| D2 | 985 | `taskState[item.taskId] = { ...taskState[item.taskId], status: "ready" }` | `applyRestorePlan` B経路: worktree 消失 late check | `REVERT_TO_READY`（新規）|
| D3 | 1020 | `taskState[item.taskId] = { ...taskState[item.taskId], status: "ready" }` | `applyRestorePlan` B経路: launchConductor 失敗 rollback | `REVERT_TO_READY` |
| D4 | 1039 | `taskState[item.taskId] = { ...taskState[item.taskId], status: "ready" }` | `applyRestorePlan` D経路: unmatched resume / resumeNewSurface を ready 戻し | `REVERT_TO_READY` |
| D5 | 1523 | `ts[conductor.taskId] = { ...cur, sessionId: message.sessionId }` | SESSION_STARTED で sessionId のみ追記（3 段 guard あり — §3.1 / R3 参照） | **reducer 対象外**（`updateTaskSessionId` 専用ヘルパ） |
| D6 | 2688 | `ts[taskId] = { ...ts[taskId], status: 'assigned', assignedAt, worktreePath, taskRunId, conductorSlot, sessionId }` | `__testApplyAssignCommit`: assignTask 完了書き込み（T302 guard 込み）| `ASSIGN_OK` |
| D7 | 3152 | `taskState[taskId] = { ...taskState[taskId], status: "closed", closedAt, journal, deliverable: { kind: "none" } }` | `handleConductorDone` T274 auto-close | `CLOSE`（auto-close variant）|

補足:
- D1〜D4 の実 prev status は全サイトで `assigned`（§3.2 / R2 の確認表参照）。reducer guard は `state === "assigned"` のみにする
- D7 の直前（3117）で `markTaskAborted` を呼ぶ分岐（judgment_pending / `unresolved`）は既に task.ts に集約済み。**task.ts 側の mutation（`task.ts:598`）も T303 で store 経由に移行する**。
- D5 の 3 段 guard（taskRunId mismatch skip / assigned+sessionId 差分で write / それ以外 silent skip）は汎用 `updateTaskMetadata` では表現できないため、**D5 専用ヘルパ `updateTaskSessionId(projectRoot, taskId, sessionId, taskRunId)` を新設**し、内部で guard を hard-code する（R3 反映）
- `taskStateModified` flag を立てている箇所（986 / 1021 / 1041）および末尾 `if (taskStateModified) saveTaskState(...)` (1050 付近) は Step 4 で **flag 一式ごと削除**（R16 反映）

### 2.3 main.ts 内の task-state mutation 箇所

```
grep -nE 'taskState\[|ts\[[^\]]+\]\s*=' skills/cmux-team/manager/main.ts
```

| # | 行 | mutation | 目的 | 対応 reducer event |
|---|---|---|---|---|
| M1 | 848 | `taskState[v.taskId] = { ...prev, status: "ready", journal }` | `cmdStart` 起動時 unique violation → ready 差し戻し | `REVERT_TO_READY` |
| M2 | 887-889 | `taskState[k] = refreshed[k]!` / `delete taskState[k]` | `markTaskAborted` 実行後に on-disk と in-memory を同期（bulk refresh）| **書き込みではなく load 同期**（§3.1 / R6 — 当面残す）|
| M3 | 905 | `taskState[overflow.taskId] = { ...taskState[overflow.taskId], status: "ready" }` | `cmdStart` overflow: slot 数超過で末尾 resume 差し戻し | `REVERT_TO_READY` |
| M4 | 2975 | `taskState[taskId] = { ...taskState[taskId], status: newStatus }` | `cmdUpdateTask --status` | `UPDATE_STATUS` |
| M5 | 3145 | `taskState[taskId] = { status: "closed", closedAt, journal, deliverable }` | `cmdCloseTask` | `CLOSE` |
| M6 | 3750 | `ts[taskId] = { ...ts[taskId], status: "ready", journal: "[restart] ..." }` + `delete ts[taskId].{assignedAt,abortedAt,worktreePath,taskRunId,conductorSlot,sessionId}` | `restartFromAborted`（aborted → ready） | `RESTART` |
| M7 | 3824-3834 | `taskState[taskId] = { ...taskState[taskId], status: "ready", journal: "[restart] ..." }` + `delete` 群 | `cmdRestartTask`: conductor 不在時の ready 戻し | `RESTART` |
| M8 | 3853-3863 | 同上 | `cmdRestartTask`: conductor 在の通常 restart | `RESTART` |
| M9 | 3929 | `taskState[taskId] = { status: "deleted", deletedAt, journal }` | `cmdDeleteTask` | `DELETE` |

補足:
- **CLI 経路は別プロセス**: M4〜M9 は `cmux-team xxx` を起動した時点で新 Node プロセス。daemon 内 mutex では保護できない。T303 では shadow observer 配線まで実施し、cross-process race（M と daemon D6 の衝突等）は reducer noop で吸収する想定（§1.1 / §3.4）。observation の結果次第で file lock を別タスク化する
- **abort 経路**: `cmdAbortTask` / `cmdDeleteTask` 内で `markTaskAborted` を呼ぶため直接 mutation は無い。ただし markTaskAborted 内部（task.ts:598）は store 経由にする（§3.7）
- M6〜M8 restart は 2 フィールド書き込み + 6 フィールド削除の混在。`patch` API は **`{ merge?, remove? }` 形式**に拡張して `delete` を明示的に表現する（§3.1 / R4 反映）
- main.ts:973-975 付近の `if (taskStateModified) saveTaskState(...)` も Step 5 で削除（R16 反映）

### 2.4 task.ts 内の task-state mutation

| # | 行 | mutation | 目的 | 対応 reducer event |
|---|---|---|---|---|
| TS1 | 598 | `taskState[taskId] = { ...current, status: "aborted", abortedAt, journal }` | `markTaskAborted` | `ABORT(reason)` |
| TS2 | 708 | `state[t.id] = { ...current, status: "draft", journal }` | `cascadeAbortToChildren`: 子タスク cascade | `PARENT_ABORTED`（shadow は子にも必要 — R5）|
| TS3 | 867 | `taskState[newId] = entry` (`{ status, createdBy? }`) | `createTaskProgrammatic` | `CREATE`（reducer 経由で統合 — R14 採用）|

補足:
- TS3 は新規 entry 作成。R14 採用により **`applyTaskEvent({ type: "CREATE" })` に統合**する。reducer `CREATE` case を以下のように拡張し、`ctx.initialStatus` から初期 status を受け取る。`prev=undefined` は store 側で仮の `"draft"` を `taskReduce` に渡すことで reducer の純粋性を保つ

```ts
case "CREATE": {
  const initial = (ctx as TaskCtx & { initialStatus?: TaskStatus }).initialStatus ?? "draft";
  return withActions(initial, [{ type: "log", event: "task_created" }]);
}
```

- TS2 の cascade は `apply-task-actions.ts` の `cascade_children` 側から呼ばれる形に固定。cascade 対象の子 task に対しても **`shadowObserveTask(childId, "ready", PARENT_ABORTED, ctx, "draft")` を同 loop 内で呼ぶ**（R5 反映）

### 2.5 T302 暫定ガード位置

```
daemon.ts:2647-2699  __testApplyAssignCommit
  ├ 2680  if (currentStatus && isTerminalStatus(currentStatus)) { skip + resetConductor }
  └ 2688  ts[taskId] = { ...ts[taskId], status: 'assigned', ... }
```

`task.ts:745 isTerminalStatus(status)` は `closed|aborted|deleted` 判定。これは reducer の `ASSIGN_OK` case（task-fsm.ts:59-66）で `state === "ready"` のみ `assigned` に遷移、それ以外は `noop(state)` を返す挙動と等価。

`__testApplyAssignCommit` の export は Step 7 で削除し、旧 `daemon.test.ts:5062-5140` のテストは `task-state-store.test.ts` に移設する（R18 反映）。

### 2.6 atomic write の現状

- `saveTaskState`（task.ts:384-389）は `writeFile tmp → rename` で **file 書き込み自体は atomic**
- しかし `load → modify → save` はシリアル化されていない。daemon 内で `handleMessage`（1 tick で複数 message 消化）や `scanTasks` + `handleConductorDone` が同時に走る場合、lost update の可能性あり
- T220 race の本質は「CLI 側 abort/delete が走った直後に daemon 側 `__testApplyAssignCommit` が古い load 結果を書き戻す」。T302 はこれを guard したが、daemon 内に閉じた race（例: D3 rollback と D6 assign）は依然脆い

### 2.7 既存テスト

- `state-machine/fsm.test.ts` は reducer の純関数テーブル網羅（136 ケース）
- daemon 側の mutation 経路を直接呼ぶテストは `__testApplyAssignCommit` のみ export 済み。reducer 置換後はこのテストを `task-state-store.test.ts` に移設する（R18 反映）

---

## 3. 設計方針

### 3.1 書き込み API の一本化: `applyTaskEvent`

reducer 経由の唯一の mutation API を新設する。daemon プロセス内の全書き込みはこの関数を通す。

**ファイル**: 新規 `skills/cmux-team/manager/state-machine/task-state-store.ts`

**依存方向（循環なし、R9 反映）**:
```
task-state-store.ts → { logger.ts, task.ts, state-machine/{events, task-fsm, shadow}, eventBus.ts }
```
- `logger.ts` は `eventBus.ts` を import しない（CLAUDE.md「EventBus ポリシー」）
- store は両方を import するが、store を経由する呼び出しの向きが一方向（store → logger / store → eventBus）なので循環しない
- テスト用 mock / spy は `task-state-store.test.ts` 内で注入する

```ts
import { taskReduce } from "./task-fsm";
import { shadowObserveTask } from "./shadow";
import { applyTaskActions } from "./apply-task-actions";
import { loadTaskState, saveTaskState, loadTasks } from "../task";
import { log } from "../logger";
import { notifyStateChanged } from "../eventBus";
import type { TaskFsmEvent, TaskCtx, TaskStatus, TaskState, TaskStateMap } from "./events";

/** patch API: field 削除を明示的に表現可能な merge/remove 形式（R4 反映） */
export type TaskStatePatch =
  | { merge?: Partial<TaskState>; remove?: (keyof TaskState)[] };

/** 単一 task-state 更新のリクエスト。 */
export interface ApplyTaskEventInput {
  taskId: string;
  event: TaskFsmEvent;
  ctx?: Partial<TaskCtx>;
  /** status 以外のフィールド（assignedAt, worktreePath, journal, deliverable 等）。
   *  reducer が noop を返した場合は無視する契約。 */
  patch?: (prev: TaskState | undefined, next: TaskStatus) => TaskStatePatch;
}

export interface ApplyTaskEventResult {
  committed: boolean;  // false = reducer noop で saveTaskState skip
  prev: TaskStatus;
  next: TaskStatus;
  revertedChildren: string[];  // cascade_children action が走った場合の結果
}

/**
 * daemon プロセス内 task-state mutation の唯一の入口。
 *   1. in-process mutex で load → reduce → (patch merge/remove) → save → shadow → notifyStateChanged を直列化
 *   2. reducer が noop (next === prev) を返せば save せず skip（T302 ガード互換）
 *   3. action の cascade_children を apply-task-actions 経由で実行（子 task の shadow も呼ぶ）
 *   4. action の log はそのまま log() に emit
 *   5. mutex 内 save 完了直後に notifyStateChanged("task-state-store:applyTaskEvent:<event.type>:<taskId>") を呼ぶ
 *
 * 責務境界（呼び出し側に残す副作用 — R8 反映）:
 *   - trace DB insert (insertTaskSession など)
 *   - cmux send / postMessage / resetConductor など外部 I/O
 *   - これらは applyTaskEvent の呼び出し前後で呼び出し側が明示的に行う
 */
export async function applyTaskEvent(
  projectRoot: string,
  input: ApplyTaskEventInput,
): Promise<ApplyTaskEventResult>;
```

**設計ポイント**:

- **metadata-only パス（D5 専用ヘルパ — R3 反映）**:
  ```ts
  /**
   * SESSION_STARTED で sessionId を追記するための D5 専用ヘルパ。
   * 内部 guard（daemon.ts:1498-1535 の 3 段 guard を移植）:
   *   1. cur.taskRunId && cur.taskRunId !== taskRunId → skip + task_session_update_skipped log
   *   2. cur.status === "assigned" && cur.sessionId !== sessionId → write { ...cur, sessionId }
   *   3. それ以外 → silent skip
   * status 遷移を伴わないため shadow observer は呼ばない（reducer の責務外）。
   * mutex 内で実行し、write 時のみ notifyStateChanged を呼ぶ。
   */
  export async function updateTaskSessionId(
    projectRoot: string,
    taskId: string,
    sessionId: string,
    taskRunId: string,
  ): Promise<{ written: boolean; reason?: "taskrun_mismatch" | "not_assigned" | "unchanged" }>;
  ```
- **M2 等の汎用 metadata path**: `updateTaskMetadata(projectRoot, taskId, opts)` を予備的に用意（現時点では M2 bulk refresh は削除しない / §3.8 / R6 反映）。ただし当面は `applyTaskEvent` と `updateTaskSessionId` の 2 系統で足り、`updateTaskMetadata` の汎用 signature が必要になった時点で追加する（YAGNI）。
- **新規作成 `CREATE` event の統合（R14 反映）**:
  - 当初案: `createTaskEntry(projectRoot, taskId, initialStatus)` の別 API を用意
  - 採用案: `applyTaskEvent({ type: "CREATE" }, ctx: { initialStatus })` に統合
  - 選択理由: (a) 「全 mutation は store 経由」の SSOT 原則を維持、(b) shadow 配線も一元化できる、(c) reducer の純粋性は `prev=undefined` のとき store 側で仮の `"draft"` を渡すヘルパ（`taskReduceForCreate(initialStatus)`）で吸収可能
  - store 側実装:
    ```ts
    if (input.event.type === "CREATE") {
      const prev = cur?.status;  // undefined (新規) or 既存 status
      if (prev !== undefined) {
        // 既存 entry に対する CREATE は idempotent skip + log
        await log("task_create_idempotent_skip", `task_id=${input.taskId} existing_status=${prev}`);
        return { committed: false, prev, next: prev, revertedChildren: [] };
      }
      // 新規: ctx.initialStatus を reducer に渡す
      const { next, actions } = taskReduce("draft", input.event, { ...ctx, initialStatus });
      // ...
    }
    ```

### 3.2 新規 event の追加

#### `events.ts` への追加

```ts
export type TaskFsmEvent =
  | { type: "CREATE" }
  | { type: "UPDATE_STATUS"; to: "draft" | "ready" }
  | { type: "ASSIGN_OK" }
  | { type: "ASSIGN_FAIL"; errorKind: "task" | "conductor" }
  | { type: "CLOSE"; autoClosed?: boolean }       // autoClosed で T274 分岐
  | { type: "ABORT"; reason: string }
  | { type: "DELETE" }
  | { type: "RESTART" }
  | { type: "PARENT_ABORTED" }
  // ↓ 新規 (T303)。R10 採用で `RESUME_REVERT_TO_READY` → `REVERT_TO_READY` に改名
  | { type: "REVERT_TO_READY"; reason: "worktree_missing" | "launch_failed" | "unmatched" | "unique_violation" | "overflow" };

// CREATE ctx 拡張（R14）
export interface TaskCtx {
  hasConductor: boolean;
  parentAborted: boolean;
  initialStatus?: TaskStatus;  // CREATE event 専用（他 event では未使用）
}
```

**event 名選択理由（R10）**: `RESUME_*` 接頭辞は resume 経路を連想させ、`unique_violation` / `overflow` など resume と直交する contexts に違和感が出る。`REVERT_TO_READY` は reason variant で文脈を伝える設計と整合する。

#### `task-fsm.ts` への追加（R2 反映 — `assigned` のみ受け付け）

```ts
case "REVERT_TO_READY": {
  // assigned 救済経路のみ対象。D1〜D4 / M1 / M3 すべて実 prev=assigned（§2.2 / §2.3 確認済み）
  // draft / ready / terminal (closed / aborted / deleted) はすべて noop
  if (state === "assigned") {
    return withActions("ready", [
      { type: "log", event: "task_reverted_to_ready", detail: `reason=${event.reason}` },
    ]);
  }
  return noop(state);
}

case "CLOSE": {
  if (state === "assigned" || state === "ready" || state === "draft") {
    const logEvent = event.autoClosed ? "task_completed_state_mismatch" : "task_closed";
    return withActions("closed", [{ type: "log", event: logEvent }]);
  }
  return noop(state);
}
```

**07-state-machine.md §2.2 遷移表への追記**:

| event \\ state | `draft` | `ready` | `assigned` | `closed` | `aborted` | `deleted` |
|---|---|---|---|---|---|---|
| `REVERT_TO_READY` | — | — | `ready` | — | — | — |

※ draft / ready / terminal 3 値はすべて noop。コードと表が完全一致（R2 反映）。

### 3.3 `applyTaskActions` の API 設計

**ファイル**: 新規 `skills/cmux-team/manager/state-machine/apply-task-actions.ts`

**Conductor 側 P2 との対称性（R19 反映）**:
- 配置: `state-machine/apply-task-actions.ts`（本タスク）/ 将来の `state-machine/apply-conductor-actions.ts`（後続タスク）
- 両者を `state-machine/apply-actions.ts` index（index.ts 的位置）から re-export する設計を採用
- インターフェース命名規則: `applyTaskActions` / `applyConductorActions` の pair

```ts
import { log } from "../logger";
import { shadowObserveTask } from "./shadow";
import { cascadeAbortToChildren, loadTasks, type TaskStateMap } from "../task";
import type { TaskAction, TaskCtx } from "./events";

export interface ApplyTaskActionsContext {
  projectRoot: string;
  taskId: string;
  /** saveTaskState 後の最新 in-memory state。cascade の in-place mutation に使う。 */
  state: TaskStateMap;
  /** cascade 子への shadow observer 呼出時に使う ctx */
  childCtx: TaskCtx;
  /** taskTitle など log に載せたい追加情報 */
  extraLogFields?: Record<string, string>;
}

export interface ApplyTaskActionsResult {
  revertedChildren: string[];
}

/**
 * reducer が返した TaskAction[] を daemon 側副作用にブリッジする。
 *   - log      → logger.log(event, detail) にそのまま流す
 *   - cascade  → cascadeAbortToChildren(state, tasks, taskId)。state を in-place で更新。
 *                加えて、ready → draft に遷移した全 childId に対して
 *                shadowObserveTask(childId, "ready", PARENT_ABORTED, childCtx, "draft") を呼ぶ（R5 反映）。
 *
 * log emit 責務（R17 反映）:
 *   - reducer action の `log` は reducer の核となる event (task_aborted_core / task_closed / task_reverted_to_ready / task_completed_state_mismatch / task_created) を emit
 *   - markTaskAborted など wrapper は wrapper 固有の context を `task_aborted`（extraLogFields 含む）として別途 emit する（§3.7）
 *   - 二重 emit を避けるため reducer 側の log event 名と wrapper 側を **別名**に分離する
 */
export async function applyTaskActions(
  actions: TaskAction[],
  context: ApplyTaskActionsContext,
): Promise<ApplyTaskActionsResult>;
```

**cascade 子の shadow 呼出（R5 実装詳細）**:
```ts
if (action.type === "cascade_children") {
  const tasks = await loadTasks(context.projectRoot);
  const { revertedChildIds } = cascadeAbortToChildrenInPlace(context.state, tasks, context.taskId);
  // 子 entry は in-place で status: "draft" に書き換わっている。
  // reducer を通していないため、ここで明示的に shadow observer を呼ぶ。
  for (const childId of revertedChildIds) {
    await shadowObserveTask(
      childId,
      "ready",
      { type: "PARENT_ABORTED" },
      context.childCtx,
      "draft",
    );
  }
  return { revertedChildren: revertedChildIds };
}
```

- **粒度**: log / cascade_children の 2 種類のみ。新しい action 種別が必要になったらここに足す
- **cascade の副作用**: `cascadeAbortToChildrenInPlace`（既存 `cascadeAbortToChildren` を mutation in-place 版にリネーム）は引数の `TaskStateMap` を mutate する。`applyTaskEvent` 内で mutex を取ったまま cascade を実行し、最後に saveTaskState で一括書き込みする（二重書き込みしない）

### 3.4 in-process mutex の実装方針

- 軽量 async mutex を `task-state-store.ts` 内に自前実装（外部依存を増やさない）
- 設計:

```ts
let taskStateLock: Promise<void> = Promise.resolve();

async function withTaskStateLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = taskStateLock;
  let release!: () => void;
  taskStateLock = new Promise<void>(r => (release = r));
  try {
    await prev;
    return await fn();
  } finally {
    release();
  }
}
```

- `applyTaskEvent` / `updateTaskSessionId` すべてこの `withTaskStateLock` で包む
- **FIFO 保証**: Promise チェーン方式なので発行順に直列化される。1 tick あたりの待ち時間は最悪ケース（assignTask の worktree 作成）でも数百 ms だが、mutex 内で worktree 作成は **しない**（既存コードもそうなっている）。mutex 内は `loadTaskState + reduce + patch merge/remove + saveTaskState + apply log/cascade + shadow + notifyStateChanged` のみ。
- **CLI との cross-process race**（R1 反映）: in-process mutex では保護されない。CLI 経路（M4〜M9）は status 遷移の幅が限定的（主に `CLOSE` / `ABORT` / `DELETE` / `RESTART`）で、これらは reducer が `assigned` 等にガードされているため競合したらどちらか一方が noop で落ちる。観測が必要になれば別タスクで file lock を導入する。
- **なぜ (A) file lock を本タスクに含めないか**（R1 選択理由）:
  - T302 で既に観測された race は `ASSIGN_OK` noop で吸収済み（実績あり）
  - `proper-lockfile` 等の依存追加 + 全 CLI 経路での排他化は変更範囲が広く、本タスクの「reducer 経由一本化」と疎結合の別問題
  - 24h の shadow 観測で diff が出ないことが確認できれば観測的に十分
  - diff が出た場合のみ file lock タスクを新規起票する（優先度判断に 24h の実測が使える）

### 3.5 shadow observer の配線方法

`applyTaskEvent` の内部で reducer 呼出 → 実 state 書き込み → `shadowObserveTask(taskId, prev, event, ctx, actualNext)` を呼ぶ。このため **呼び出し側は shadow を意識しなくてよい**（配線漏れが構造的に起きない）。

cascade 子の shadow も `apply-task-actions.ts` 側で一元化（§3.3 / R5）。

**観測期間**: 24h 実稼働で `fsm_shadow_diff` / `fsm_invariant_violation` / `fsm_shadow_error` が **0 件**（1 件でも NG / R11 反映）であることを確認する。

### 3.6 書き換えパターンのコード例

**Before (daemon.ts:1020):**
```ts
taskState[item.taskId] = { ...taskState[item.taskId], status: "ready" };
taskStateModified = true;
```

**After:**
```ts
await applyTaskEvent(state.projectRoot, {
  taskId: item.taskId,
  event: { type: "REVERT_TO_READY", reason: "launch_failed" },
  ctx: { hasConductor: false, parentAborted: false },
});
// taskStateModified 変数は不要（saveTaskState は mutex 内で完結 — R16）
```

**Before (daemon.ts:2688 の T302 ガード込み):**
```ts
const ts = await loadTaskState(state.projectRoot);
const currentStatus = ts[taskId]?.status;
if (currentStatus && isTerminalStatus(currentStatus)) {
  await log("assign_skipped_terminal", `...`);
  await resetConductor(updated, state.projectRoot, ...);
  return { committed: false, reason: "terminal", currentStatus };
}
ts[taskId] = { ...ts[taskId], status: 'assigned', assignedAt, ... };
await saveTaskState(state.projectRoot, ts);
return { committed: true };
```

**After (R7 反映: terminal vs unexpected noop を分離):**
```ts
const result = await applyTaskEvent(state.projectRoot, {
  taskId,
  event: { type: "ASSIGN_OK" },
  ctx: { hasConductor: true, parentAborted: false },
  patch: (_prev, next) => {
    if (next !== "assigned") return { merge: {} };  // reducer noop時は patch も無視
    return {
      merge: {
        assignedAt: new Date().toISOString(),
        worktreePath: updated.worktreePath,
        taskRunId: updated.taskRunId,
        conductorSlot: updated.surface,
        sessionId: updated.sessionId,
      },
    };
  },
});

if (!result.committed) {
  if (result.prev === "closed" || result.prev === "aborted" || result.prev === "deleted") {
    // T302 旧 terminal race: resetConductor で worktree 巻き戻し
    await log(
      "assign_skipped",
      `${formatSurface(updated.surface, "C")} task_id=${taskId} reason=terminal prev=${result.prev} taskRunId=${updated.taskRunId ?? "-"}`,
    );
    await resetConductor(updated, state.projectRoot, state.workspace ?? undefined);
  } else {
    // assigned / draft からの noop（scanTasks のバグ or race）— reset せず警告のみ
    await log(
      "assign_skipped_unexpected",
      `${formatSurface(updated.surface, "C")} task_id=${taskId} prev=${result.prev} (scanTasks selected non-ready)`,
    );
  }
  return { committed: false, reason: "non_ready", currentStatus: result.prev };
}
return { committed: true };
```

**判定の妥当性（R7 の表を踏襲）**:

| prev_status | T302 旧挙動 | After の新挙動 | 妥当性 |
|---|---|---|---|
| `closed` / `aborted` / `deleted` | reset | reset + `assign_skipped` | ✓ T302 と等価 |
| `assigned` | 発生しない前提 | reset せず `assign_skipped_unexpected` | ✓ 他 Conductor の巻き込み防止 |
| `draft` | 発生しない前提 | reset せず `assign_skipped_unexpected` | ✓ 過剰 reset 回避 |

### 3.7 markTaskAborted の移行

`task.ts:598` の直接 mutation を `applyTaskEvent` 経由に差し替える。既存の呼び出し側 API（`markTaskAborted(projectRoot, taskId, reason, detail, opts)`）は維持する（破壊的変更しない）。

**log emit の責務分離（R17 反映）**:
- reducer の `ABORT` action は `{ type: "log", event: "task_aborted_core", detail: \`reason=${reason}\` }` を返す（`task_aborted` とは別名）
- `markTaskAborted` は wrapper として `task_aborted`（extraLogFields 含む）を明示的に別途 emit する
- これにより reducer 由来と wrapper 由来が別 event 名になり、二重 emit の懸念がなくなる

内部実装:
```ts
// task.ts:markTaskAborted
const result = await applyTaskEvent(projectRoot, {
  taskId,
  event: { type: "ABORT", reason },
  ctx: { hasConductor: false, parentAborted: false },
  patch: (_prev, next) => next === "aborted" ? { merge: { abortedAt: now(), journal } } : { merge: {} },
});

if (!result.committed) {
  // reducer noop = 既に terminal。冪等 skip。
  return { revertedChildren: [], journal, idempotentSkip: true, existingStatus: result.prev };
}

// wrapper 側 log（extraLogFields 込み）。reducer 由来 task_aborted_core とは別 event。
await log("task_aborted", `task_id=${taskId} reason=${reason} ${formatExtraFields(opts)}`);

return { revertedChildren: result.revertedChildren, journal, idempotentSkip: false };
```

### 3.8 M2 bulk refresh の扱い（R6 反映）

当初案（§5 R6）では「markTaskAborted が applyTaskEvent 経由になれば in-memory state 共有で bulk refresh 不要」としていたが、`applyTaskEvent` は内部で `loadTaskState` を呼ぶ独立トランザクションなので、main.ts:809 の `taskState` 変数とは **別 reference**。markTaskAborted 後に main.ts 側 `taskState` を refresh しないと依然 stale のまま。

したがって **bulk refresh (M2) は当面残す**（最小破壊）。将来 main.ts 側 resume ループ全体を `applyTaskEvent` のループに置き換える際に不要になる想定だが、それは本タスク粒度外の refactor。

**Step 5-6 は削除**し、bulk refresh 削除の計画は取り下げる。

---

## 4. 実装ステップ（TDD 順序）

### Step 1. 新規 event と reducer case のテスト先行

- `state-machine/fsm.test.ts` に `REVERT_TO_READY` の全 6 state × 5 reason バリアントを追加。`assigned → ready` のみ遷移、他は noop を assert（R2 反映）
- `CLOSE(autoClosed=true)` で `task_completed_state_mismatch` log action、`autoClosed=false` で `task_closed` log action を assert
- `ABORT` の log action が `task_aborted_core`（R17 反映）になっていることを assert
- `CREATE` の log action が `task_created`、`ctx.initialStatus` 反映を assert（R14 反映）
- 実装（events.ts / task-fsm.ts）はテスト後

### Step 2. `applyTaskActions` の単体テスト + 実装

- 新規 `state-machine/apply-task-actions.test.ts`:
  - log action が logger.log を正しく呼ぶ（logger を module mock で差し替え）
  - cascade_children が `cascadeAbortToChildrenInPlace` を呼び state を mutate する
  - **cascade 対象の各 childId に対して `shadowObserveTask` が呼ばれる**（R5 反映）
  - 空 actions は no-op
- 実装: `apply-task-actions.ts` + `state-machine/apply-actions.ts` index（R19）
- `cascadeAbortToChildren` → `cascadeAbortToChildrenInPlace` へのリネームを task.ts 側でも反映（public API として残しつつ、rename 経由で呼ぶ）

### Step 3. `applyTaskEvent` の単体テスト + 実装

- 新規 `state-machine/task-state-store.test.ts`（R13 反映で具体化）:
  - **reducer noop → committed=false、saveTaskState 未呼出**: `loadTaskState` spy 呼出回数 = 1、`saveTaskState` spy 呼出回数 = 0
  - **reducer 遷移 → committed=true、saveTaskState 呼出、shadowObserveTask 呼出、notifyStateChanged 呼出**: 各 spy 呼出回数 = 1
  - **mutex 直列化（同 task、ASSIGN_OK 2 並行）**: `Promise.all([applyTaskEvent(..., ASSIGN_OK), applyTaskEvent(..., ASSIGN_OK)])` → 片方 `committed=true, prev="ready", next="assigned"`、もう片方 `committed=false, prev="assigned", next="assigned"` (noop)。`loadTaskState` 呼出回数 = 2（各 transaction 独立 load）、`saveTaskState` 呼出回数 = 1 (noop は save しない)
  - **mutex 直列化（同 task、ABORT + ASSIGN_OK 並行）**: ABORT 先行なら ASSIGN noop、ASSIGN 先行なら ABORT が `assigned → aborted`
  - **patch merge**: reducer noop 時は patch 無視、遷移時のみ apply
  - **patch remove**: restart 経路で `{ merge: { status:"ready", journal }, remove: ["assignedAt","taskRunId",...] }` を返すと on-disk の entry から対象 key が削除される（R4 反映）
  - **cascade_children action**: state に子の draft 書き込みが入り、saveTaskState 後の on-disk に反映、かつ `shadowObserveTask` が子 count 分呼ばれる
  - **CREATE idempotent skip**: 既存 entry に対する CREATE は committed=false + `task_create_idempotent_skip` log
  - **CREATE 新規**: `prev=undefined` + `ctx.initialStatus="ready"` → committed=true, next="ready", `task_created` log
  - **notifyStateChanged source 引数**: `"task-state-store:applyTaskEvent:ASSIGN_OK:<taskId>"` 形式（R9 反映）
- 実装: `task-state-store.ts`（`withTaskStateLock` + `applyTaskEvent` + `updateTaskSessionId`）

### Step 4. daemon.ts の mutation 置換

順序:
1. **D6 `__testApplyAssignCommit`** → `applyTaskEvent(ASSIGN_OK)` + R7 の terminal / unexpected 分岐で resetConductor / ログ分岐
2. **D7 `handleConductorDone` auto-close** → `applyTaskEvent(CLOSE, autoClosed=true)`。trace DB insert は呼び出し側に残す（R8）
3. **D1〜D4 resume 経路** → `applyTaskEvent(REVERT_TO_READY, reason)`
4. **D5 sessionId 更新** → `updateTaskSessionId(projectRoot, taskId, sessionId, taskRunId)`（専用ヘルパ / R3）
5. **`taskStateModified` flag の削除**（R16）:
   - daemon.ts:986 / 1021 / 1041 の flag 立て削除
   - daemon.ts:1050 付近の `if (taskStateModified) await saveTaskState(...)` 削除
   - 変数宣言 `let taskStateModified = false;`（daemon.ts:980 付近）削除

各 step で `bun test` pass を確認してから次へ。

### Step 5. main.ts の mutation 置換

順序:
1. **M5 `cmdCloseTask`** → `applyTaskEvent(CLOSE)` + deliverable を patch.merge
2. **M9 `cmdDeleteTask`** → `applyTaskEvent(DELETE)` + deletedAt / journal を patch.merge
3. **M6〜M8 `restartFromAborted` / `cmdRestartTask`** → `applyTaskEvent(RESTART)` + `patch: { merge: { status:"ready", journal }, remove: ["assignedAt","abortedAt","worktreePath","taskRunId","conductorSlot","sessionId"] }`（R4 反映）
4. **M4 `cmdUpdateTask`** → `applyTaskEvent(UPDATE_STATUS)`
5. **M1 / M3 `cmdStart` の unique violation / overflow** → `applyTaskEvent(REVERT_TO_READY)`
6. **M2 bulk refresh** → **削除しない**（R6 反映）。in-memory state と on-disk の整合性維持のため当面残す
7. **`taskStateModified` flag の削除**（R16）:
   - main.ts:849 / 906 の flag 立て削除
   - main.ts:973-975 付近の `if (taskStateModified) await saveTaskState(...)` 削除
   - 変数宣言 `let taskStateModified = false;`（main.ts:830 付近）削除

### Step 6. task.ts の mutation 置換

- TS1 `markTaskAborted` を `applyTaskEvent(ABORT)` 経由に書き換え（§3.7）。wrapper 側で `task_aborted`（extraLogFields 含む）を別途 emit（R17）
- TS2 `cascadeAbortToChildren` → `cascadeAbortToChildrenInPlace` にリネーム（public export は維持）。apply-task-actions.ts からのみ呼ばれる形に固定
- TS3 `createTaskProgrammatic` を `applyTaskEvent({ type: "CREATE" }, ctx: { initialStatus })` 経由に置換（R14 反映）

### Step 7. T302 暫定ガード撤去 + `__testApplyAssignCommit` 整理

- `__testApplyAssignCommit` の `isTerminalStatus` 分岐を削除（reducer noop に吸収）
- **`assign_skipped_terminal` → `assign_skipped`（terminal 由来）と `assign_skipped_unexpected`（想定外 noop）に分離**（R12 反映）
- 外部依存調査: `grep -rn "assign_skipped_terminal" .` → `daemon.ts:2682` と `daemon.test.ts` 4 箇所のみ。ダッシュボード / TUI / trace DB / アラートパイプライン側の参照 0 件（R12 反映）。テストの assert 文字列差し替えのみで完結
- **`__testApplyAssignCommit` export を削除**（R18）:
  - T302 guard 撤去後、本関数は `applyTaskEvent` への薄いラッパに退化するため export の価値がなくなる
  - 旧 `daemon.test.ts:5062-5140` の T302 ケース（terminal / unexpected）を `task-state-store.test.ts` に移設
  - daemon.test.ts 側は移設後に削除

### Step 8. Grep invariant check（R15 拡張反映）

**基本 invariant**:
```bash
grep -nE 'taskState\[.*\]\s*=' skills/cmux-team/manager/daemon.ts skills/cmux-team/manager/main.ts  # 0 件
grep -nE 'ts\[[^\]]+\]\s*=' skills/cmux-team/manager/daemon.ts skills/cmux-team/manager/main.ts  # 0 件
grep -n 'saveTaskState(' skills/cmux-team/manager/daemon.ts skills/cmux-team/manager/main.ts  # 0 件
```

**field 個別代入 / 個別 delete も 0 件**（R15 反映 — restart 経路の `delete ts[taskId].xxx` 等の検出）:
```bash
grep -nE '(taskState|ts)\[[^\]]+\]\.[a-zA-Z_]+\s*=' skills/cmux-team/manager/daemon.ts skills/cmux-team/manager/main.ts  # 0 件
grep -nE 'delete\s+(taskState|ts)\[[^\]]+\]\.[a-zA-Z_]+' skills/cmux-team/manager/daemon.ts skills/cmux-team/manager/main.ts  # 0 件
```

**`taskStateModified` flag 残存も 0 件**（R16 反映）:
```bash
grep -n 'taskStateModified' skills/cmux-team/manager/daemon.ts skills/cmux-team/manager/main.ts  # 0 件
```

**残存許容は `task-state-store.ts` / `apply-task-actions.ts` / `task.ts`（store 経由 + 純粋ヘルパ）のみ**。

### Step 9. docs/spec/07-state-machine.md 更新

- §2.2 遷移表に `REVERT_TO_READY` 行追加（`assigned → ready` のみ、他は noop）
- §2.3 Mermaid に `assigned --> ready : REVERT_TO_READY` の矢印追加
- §4 shadow 配線表に Task 側の配線エントリ追加（applyTaskEvent が唯一の経路である旨、cascade 子も apply-task-actions 経由で shadow されることを明記）
- §5 段階計画に「**P2 (T303, 本タスク)**: task-state mutation を reducer 経由に一本化、24h 観測で `fsm_shadow_diff = 0` / `fsm_invariant_violation = 0` / `fsm_shadow_error = 0`」を追記（R11）
- T302 脚注の追記（暫定ガードの経緯 → reducer 化で削除済み）
- CLI ↔ daemon の cross-process race は reducer noop で観測的に吸収する旨と、file lock は別タスク化の脚注を追加（R1）

### Step 10. 実稼働 24h 観測

- マージ後 `manager.log` を 24h 監視
- `grep -c fsm_shadow_diff manager.log` が **0** であることを確認（R11: 既知差分も NG）
- `grep -c fsm_invariant_violation manager.log` が 0 であることを確認
- `grep -c fsm_shadow_error manager.log` が 0 であることを確認
- 非ゼロなら配線側のバグとして即修正タスク起票 + 本 PR の P2 完了条件は「修正後 24h で 0 件」に書き換え再観測

---

## 5. リスクと緩和策

| # | リスク | 影響 | 緩和策 |
|---|---|---|---|
| R1 | mutex デッドロック | daemon 停止 | mutex 内では I/O（saveTaskState）以外で重い処理をしない。worktree 作成 / launchConductor は mutex 外に保つ。全呼び出しで `try/finally release()` を徹底 |
| R2 | CLI プロセス側の race | 稀に lost update | T303 では観測のみ（§1.1 / R1 反映）。shadow で `fsm_shadow_diff` が出たら file lock 導入を別タスク化 |
| R3 | patch API の型安全性 | metadata 書き忘れ | `{ merge?, remove? }` 形式で field 削除を明示可能に（R4 反映）。各呼出箇所でコメント明示 |
| R4 | 既存テストの大量破壊 | regression | Step ごとに `bun test` pass を確認。daemon.test.ts の `__testApplyAssignCommit` ケースは task-state-store.test.ts に移設（R18） |
| R5 | markTaskAborted の挙動変化 | 6 経路で破壊 | 外部 API（シグネチャ・戻り値）は維持。log event 名を reducer `task_aborted_core` と wrapper `task_aborted` に分離して二重 emit を防ぐ（R17） |
| R6 | bulk refresh 残存（M2） | P2 以降の refactor 余地 | **削除しない**（R6 反映）。`applyTaskEvent` 独立 load のため stale 解消は従来通り必要。将来 main.ts resume ループ全体の置換で解消 |
| R7 | `deleted` 行が in-memory に残存 | ダッシュボード表示崩れ | reducer は deleted を終端として扱うため問題なし。patch.merge で deleted 時に全フィールド（deletedAt / journal）を書ける |
| R8 | T302 ガード削除後に terminal race が再発 | assigned 不整合 | reducer `ASSIGN_OK` が `state !== "ready"` で noop を返すことを fsm.test.ts で厳密にテスト済み。加えて After 例（§3.6 / R7）で terminal / unexpected 分離により観測性も向上 |
| R9 | shadow 配線漏れで diff 過検知 | 24h 観測で false positive | `applyTaskEvent` + `apply-task-actions.ts` のみが唯一の書き込み経路（cascade 子も含む）。内部で必ず shadow を呼ぶ設計で保証（R5 反映） |
| R10 | trace DB insert と task-state mutation の atomicity | 事後追跡性 | trace DB は呼び出し側責務（R8 反映）。store は task-state のみ担当し、trace 書き込みは呼び出し側で `applyTaskEvent` の前後に実行する |
| R11 | notifyStateChanged / EventBus 循環依存 | import 失敗 | 依存方向を `task-state-store → { logger, task, state-machine, eventBus }` で固定し循環なしを §3.1 冒頭に明記（R9） |
| R12 | resume 起動時の I/O コスト増加 | 起動時間悪化 | LR-1 参照。resume 候補 N 件で saveTaskState 呼出も N 回になる。起動時間計測を受け入れ確認に入れ、問題時は batch モード追加を別タスク化 |

### ロールバック方法

- 全変更は 1 PR（T303 ブランチ）にまとめる。リスクを検知したら PR を revert
- T302 ガード削除（Step 7）は最終コミットに分離し、reducer 置換の regression と切り離して revert できるようにする
- 実稼働 24h で diff が出た場合: PR 単位の revert ではなく「配線側の修正パッチ」で対応する設計

### LR-1. resume 起動時の I/O コスト増加（R リスクに組み込み済みだが観測は必要）

現実装の applyRestorePlan は `taskStateModified` flag を立てて末尾で 1 回 saveTaskState を呼ぶ pattern（daemon.ts:1050）。`applyTaskEvent` 経由になると 1 mutation = 1 saveTaskState = 1 tmp + rename になる。resume 候補が多い場合（10 件など）、起動時の disk I/O が 10 倍に。

- 受け入れ確認: resume 候補 3〜10 件の環境で起動時間を計測し、現状比 +100% 以内に収まるかを目視確認。超過時は応急として batch モード（1 トランザクションで複数 event 適用）追加を別タスク化

---

## 6. テスト戦略

### 6.1 新規ユニットテスト

| ファイル | テスト内容 | 行数目安 |
|---|---|---|
| `state-machine/fsm.test.ts` 追補 | `REVERT_TO_READY` 全 6 state × 5 reason variant（assigned のみ遷移、他 noop）/ `CLOSE(autoClosed)` action 差分 / `ABORT` が `task_aborted_core` を emit / `CREATE` が `task_created` + ctx.initialStatus 反映 | +60 行 |
| `state-machine/apply-task-actions.test.ts` 新規 | log action emit / cascade_children 副作用 / **cascade 子の shadow 呼出** / 空 actions は no-op | 100 行 |
| `state-machine/task-state-store.test.ts` 新規 | R13 反映のテスト一式:<br>- reducer noop → committed=false、saveTaskState 未呼出<br>- 遷移 → committed=true、save + shadow + notifyStateChanged 各 1 回<br>- mutex 直列化 (ASSIGN_OK × 2): 片方 committed=true、もう片方 noop。load 2 回、save 1 回<br>- mutex 直列化 (ABORT + ASSIGN_OK)<br>- patch merge / remove の両対応<br>- cascade_children で子 shadow 呼出<br>- CREATE idempotent skip / 新規成功<br>- notifyStateChanged source 文字列フォーマット<br>- updateTaskSessionId 3 段 guard テスト | 280 行 |
| `daemon.test.ts` 既存 T302 ケース移設 | 5062-5140 を `task-state-store.test.ts` に移設。terminal noop + unexpected noop（R7）の両ケースを追加 | ±0 行（移動） |

### 6.2 既存テストの更新

- `fsm.test.ts` の `Task FSM — ASSIGN_OK` ケース（現 639-651）は変更不要（reducer 自体の挙動は同じ）
- `daemon.test.ts` の `__testApplyAssignCommit` ケースは `task-state-store.test.ts` に移設。`assign_skipped_terminal` → `assign_skipped` / `assign_skipped_unexpected` に分離（R12）
- `cascadeAbortToChildren` → `cascadeAbortToChildrenInPlace` へのリネームに伴うテスト import 修正（public API として旧名の re-export を残す場合は追加テスト不要）

### 6.3 手動検証 E2E

1. **T302 race 再現シナリオ**: daemon 起動 → 長時間 assign（worktree 作成中）を人為的に遅延 → 別シェルから `cmux-team abort-task` → assign 完了が `assign_skipped reason=terminal` で記録され、Conductor が idle に戻ることを確認
2. **REVERT_TO_READY 経路**: daemon 停止 → worktree を手動削除 → 再起動で resume 失敗 → `task-state.json` の該当タスクが ready に戻っていること + `task_reverted_to_ready reason=worktree_missing` ログを確認
3. **shadow 24h 観測**: `grep -c fsm_shadow_diff manager.log` / `grep -c fsm_invariant_violation manager.log` / `grep -c fsm_shadow_error manager.log` を 24h 後に確認（R11: 3 種すべて 0 件）
4. **既存ゴールデンパス**: `cmux-team create-task --status ready` → 自動 assign → `cmux-team close-task` の一連が通ること
5. **cascade 経路**: 親タスクを abort → 子タスク（ready）が draft に戻ること + `fsm_shadow_diff` が発生しないことをダッシュボードで確認
6. **restart 経路の field 削除**: `cmux-team restart-task` で aborted → ready に戻した後、on-disk の task-state.json で `assignedAt` / `worktreePath` / `taskRunId` / `conductorSlot` / `sessionId` / `abortedAt` が **削除されている**ことを確認（R4）

---

## 7. 完了チェックリスト

### 受け入れ条件（構造）

- [ ] `state-machine/shadow.ts:shadowObserveTask` が `applyTaskEvent` 内および `apply-task-actions.ts` の cascade 処理内で呼ばれる（配線の構造的保証 / R5）
- [ ] `grep -nE 'taskState\[.*\]\s*=' skills/cmux-team/manager/{daemon,main}.ts` が 0 件
- [ ] `grep -nE 'ts\[[^\]]+\]\s*=' skills/cmux-team/manager/{daemon,main}.ts` が 0 件
- [ ] `grep -nE '(taskState|ts)\[[^\]]+\]\.[a-zA-Z_]+\s*=' skills/cmux-team/manager/{daemon,main}.ts` が 0 件（R15: field 個別代入）
- [ ] `grep -nE 'delete\s+(taskState|ts)\[[^\]]+\]\.[a-zA-Z_]+' skills/cmux-team/manager/{daemon,main}.ts` が 0 件（R15: 個別 delete）
- [ ] `grep -n 'saveTaskState(' skills/cmux-team/manager/{daemon,main}.ts` が 0 件
- [ ] `grep -n 'taskStateModified' skills/cmux-team/manager/{daemon,main}.ts` が 0 件（R16）
- [ ] `task.ts` 内の `saveTaskState` 呼出は `task-state-store.ts` 経由のみ
- [ ] `events.ts` に `REVERT_TO_READY`（R10 改名）追加済み、exhaustive check pass
- [ ] `task-fsm.ts` の `REVERT_TO_READY` case が `state === "assigned"` のみ受け付ける（R2）
- [ ] `apply-task-actions.ts` が `{ log, cascade_children }` を処理し、cascade 子の shadow 呼出まで新規テストで検証済み（R5）
- [ ] `task-state-store.ts` の `applyTaskEvent` / `updateTaskSessionId` が mutex で直列化され、内部で `notifyStateChanged` を呼ぶ（R9）
- [ ] D5 専用ヘルパ `updateTaskSessionId` が 3 段 guard（taskRunId mismatch / assigned+diff / silent skip）を hard-code（R3）
- [ ] T302 の `assign_skipped_terminal` 分岐が削除され、`assign_skipped`（terminal 由来）と `assign_skipped_unexpected`（想定外 noop）に分離（R7 / R12）
- [ ] `__testApplyAssignCommit` export が削除され、旧テストは `task-state-store.test.ts` に移設済み（R18）
- [ ] `bun test` 全通過（新規 + 既存）
- [ ] `bunx tsc --noEmit` で型エラー 0
- [ ] `docs/spec/07-state-machine.md` が P2 完了内容で更新済み（§2.2 遷移表 / §2.3 Mermaid / §4 shadow 配線 / §5 段階計画 + file lock の別タスク化脚注）

### リリース後観測（R11 反映 — 厳格化）

- [ ] 24h 実稼働で `fsm_shadow_diff` **0 件**（`grep -c fsm_shadow_diff .team/logs/manager.log`）
- [ ] 24h 実稼働で `fsm_invariant_violation` **0 件**
- [ ] 24h 実稼働で `fsm_shadow_error` **0 件**
- [ ] 差分検出時は 07-state-machine.md に記録し、配線側の修正タスクを起票、再観測 24h で 0 件

### ドキュメント

- [ ] `CLAUDE.md` の関連節に「daemon プロセス内の task-state 書き込みは `applyTaskEvent` / `updateTaskSessionId` 経由のみ」の不変条件を追記
- [ ] `CLAUDE.md` または `docs/spec/07-state-machine.md` に「CLI ↔ daemon 間の cross-process race は reducer noop で観測的に吸収する。file lock は別タスク化」を明記（R1）
- [ ] `conductor-prompt.md` / `runs/<id>/summary.md` で conductor-role.md Step 11 の既存挙動に影響がないことを確認（CLI はインターフェース維持）
