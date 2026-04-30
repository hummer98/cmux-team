# T358 実装計画 — Manager events.jsonl writer + 17 event 結線

## 1. 概要

`docs/spec/10-events-stream.md` で確定した v2 schema に従い、Manager daemon に **`events-writer.ts`** を新設して `.team/logs/events.jsonl` への append-only writer を実装する。Task FSM / Conductor FSM の各 transition、および wrapper 層 (daemon.ts / main.ts / task.ts) の特殊経路から writer に通知し、**16 event 種を 17+ 経路で emit** する（spec §6.6 と §6.13 のような別軸ペアでは両 event を独立に emit、`task_aborted` の 6 reason はそれぞれ別経路で発生するため経路数では 17+ となる）。retention policy は spec §7 の決定（無制限 append、rotate なし、自動 GC なし）に従い writer 側ではローテーション処理を行わない。既存 `manager.log` は並行運用として残す（v1 互換）。

> 「event 種は 16、emit 経路は task_aborted を 6 reason で展開すると 17+」という別軸である点に注意。reader の dedup は `task_id` + `event` + `ts` で行う（spec §8 準拠）。

---

## 2. 設計判断

### 2.1 Writer interface — シングルトン関数 export（logger.ts と同形）

```typescript
// skills/cmux-team/manager/events-writer.ts
export const EVENTS_SCHEMA_VERSION = 2;

// spec §6.6 準拠の独立 enum。task.ts の AbortReason とは別軸で型定義し、
// reader (T359/T360) が AbortReason の将来拡張に巻き込まれないようにする。
export type SpecAbortReason =
  | "judgment_pending"
  | "disconnect_timeout"
  | "user_clear"
  | "assign_failed"
  | "resume_marked_aborted"
  | "other";

export type EventStreamRecord =
  | { event: "task_created"; task_id: string; title: string }
  | { event: "task_ready"; task_id: string }
  | { event: "task_assigned"; task_id: string; conductor_surface: string; task_run_id: string }
  | { event: "task_completed"; task_id: string; conductor_surface: string; worktree_path: string; journal_summary: string }
  | { event: "task_completed_state_mismatch"; task_id: string; conductor_surface: string; reason: "missing_close_task"; worktree_path: string; journal_summary: string }
  | { event: "task_aborted"; task_id: string; reason: SpecAbortReason; journal_summary: string }
  | { event: "task_sync_guard_rejected"; task_id: string; kind: "diverged"|"uncommitted"|"detached"|"auto_pull_failed"; detail: string; main_branch: string }
  | { event: "task_reverted_to_ready"; task_id: string; reason: RevertReason }
  | { event: "conductor_running"; conductor_surface: string; task_id: string }
  | { event: "conductor_recovered"; conductor_surface: string; new_status: "idle"|"running" }
  | { event: "conductor_disconnected"; conductor_surface: string; reason: "session_ended"|"pid_dead"|"assign_failed"; task_id?: string }
  | { event: "conductor_asking"; conductor_surface: string; question: string }
  | { event: "conductor_done_unresolved"; task_id: string; conductor_surface: string; worktree_path: string; journal_summary: string }
  | { event: "conductor_start_timeout"; conductor_surface: string; elapsed_ms: number }
  | { event: "conductor_assign_timeout"; conductor_surface: string; task_run_id: string; elapsed_ms: number }
  | { event: "conductor_disconnect_timeout"; conductor_surface: string; task_id?: string; elapsed_ms: number };

export async function emitEvent(record: EventStreamRecord): Promise<void>;
```

**`AbortReason → SpecAbortReason` マップ表（task.ts:519-527 の 8 値 → spec §6.6 の 6 値）:**

| `AbortReason`（task.ts 内部値） | `SpecAbortReason`（events.jsonl 出力値） | 備考 |
|---|---|---|
| `user_clear` | `user_clear` | 同名 pass-through |
| `judgment_pending` | `judgment_pending` | 同名 pass-through |
| `assign_failed` | `assign_failed` | 同名 pass-through |
| `disconnect_timeout` | `disconnect_timeout` | 同名 pass-through |
| `abort_task` | `other` | abort-task CLI 由来。spec に該当値なしのため `other` に集約 |
| `resume_no_session_id` | `resume_marked_aborted` | resume 経路（main.ts:1023）はすべて spec 上 1 値に集約 |
| `resume_no_task_run_id` | `resume_marked_aborted` | 同上 |
| `resume_no_worktree` | `resume_marked_aborted` | 同上 |

このマップは `task.ts:markTaskAborted` の wrapper 末尾で `emitEvent` を呼ぶ際に明示的に変換する（reducer 側 / `apply-task-actions` 側では行わない）。マップ表自体は `events-writer.ts`（または同 module 内 helper）に `mapAbortReason(r: AbortReason): SpecAbortReason` として export し、テストで全 8 値の対応をカバーする。

**理由:**
- `logger.ts` と同じく function-style export（プロセス単位シングルトン）。daemon は 1 プロセス専用で多重起動は pidfile で防止済みなので DI は過剰
- discriminated union により type-safe な payload 組立を強制（spec §6 と 1:1 対応）
- TypeScript の exhaustive check で「spec に存在するが結線忘れ」を compile-time に検出可能
- `SpecAbortReason` を `AbortReason` から独立させることで、`AbortReason` 拡張時に spec を巻き込まない

### 2.2 `schema_version` / `ts` は writer 側で自動付与

- `schema_version = EVENTS_SCHEMA_VERSION` 定数を `JSON.stringify` 直前に注入
- `ts` は writer 側で `new Date().toISOString()` を生成（spec §3 の "UTC + ms + Z" 表記）。**呼び出し側に書かせない**（呼び忘れ・形式ズレを構造的に防止）
- これにより呼び出し側は payload 部分だけを意識すれば良い

### 2.3 Retention policy — 何もしない（spec §7 の決定）

- writer は append のみ。rotate / size limit / 古い記録の自動削除は実装しない
- `manager.log` / `traces.db` と同じ「単一 append + 手動 GC」方針で一貫性を保つ
- テストでは「writer が `truncate` / 上書きを呼ばないこと」「複数回 emit 後にすべての record が残ること」を assertion する

### 2.4 書き込みエラーは swallow（daemon 継続）

- `events.jsonl` writer の例外は `manager.log` に **`events_writer_error`** で記録するだけで throw しない（イベント名は `events_writer_error` で固定。reader / trace 側がパース可能にする）
- detail には `error.message` を必ず含める（後追い debug 用）。可能なら `error.code` / `error.stack` 先頭行も append
- daemon 全体の availability >> events.jsonl 完全性。ベストエフォート（CLAUDE.md 「便利機能は best-effort」記憶と整合）

### 2.5 結線位置の分担

| 層 | 結線方法 | 対象 event |
|---|---|---|
| **Task FSM 直系（apply-task-actions 経由 emit）** | `apply-task-actions.ts` を拡張し、reducer の `log` action のうち **spec §6 に対応する 5 種だけ** emit。それ以外は emit しない | `task_created` / `task_ready` / `task_assigned` / `task_completed_state_mismatch` / `task_reverted_to_ready` |
| **Task wrapper 層** | 既存の `await log("...")` の隣に `await emitEvent(...)` を直接追加 | `task_aborted`（task.ts:markTaskAborted で `mapAbortReason` 経由）/ `task_completed`（daemon.ts:handleConductorDone の **通常経路 1 ヶ所のみ**）/ `task_sync_guard_rejected`（main.ts:runSyncCheckOrExit）/ `conductor_done_unresolved`（daemon.ts:handleConductorDone の T269 経路）|
| **Conductor 直系** | daemon.ts の各 `await log("conductor_*", ...)` の隣に `await emitEvent(...)` を追加（shadow.ts は変更しない — shadow は P1 では実行しない契約） | `conductor_running` / `conductor_recovered` / `conductor_disconnected` / `conductor_asking` / `conductor_start_timeout` / `conductor_assign_timeout` / `conductor_disconnect_timeout` |

**`task_completed` を auto-close 経路から外す根拠（M3）:**
- spec §6.4 は「T274 auto-close（state が `assigned` のまま DONE が返る経路）は **本 event ではなく** `task_completed_state_mismatch`（§6.5）を出す」と規定
- auto-close ブランチ（`stateMismatchOnSuccess === true`、daemon.ts:3573 付近）では `emitEvent({event:"task_completed_state_mismatch", ...})` のみを呼ぶ
- 通常経路（`else`、daemon.ts:3637 付近）からのみ `emitEvent({event:"task_completed", ...})` を呼ぶ
- `manager.log` 側の二重 log（auto-close 経路で `task_completed_state_mismatch` と `task_completed` の両方を出している現状挙動）は dashboard / trace 互換のため **温存**。spec 制約は events.jsonl のみに適用

**Task FSM の wrapper 経路に寄せる理由:**
- `task_aborted` は wrapper (markTaskAborted) でしか taskTitle / journal が揃わない（reducer 側は `task_aborted_core` のみで spec の rich payload に届かない）
- 同様に `task_completed` は handleConductorDone でしか worktree_path / journal_summary が組み立てられない
- reducer 直系で取れる field のみで spec を満たすのは `task_created` / `task_ready` / `task_assigned` / `task_completed_state_mismatch` / `task_reverted_to_ready` の 5 種

**apply-task-actions の switch は allowlist 設計（M4）:**
- `task-fsm.ts` の `log` action は spec 対応 5 種以外にも次の名前で emit される: `task_aborted_core`（ABORT 経由）/ `task_aborted`（旧 ASSIGN_FAIL kind=task 由来 → 後述 M4 リネームで `task_aborted_core` に統一）/ `task_closed` / `task_deleted` / `task_restarted` / `task_reverted_to_draft` / `child_reverted_to_draft` / `assign_failed` / `task_create_idempotent_skip`
- apply-task-actions の switch は spec §6 に対応する 5 種だけ `emitEvent` を呼ぶ。**それ以外の log action 名は events.jsonl に emit せず、`logger.log` のみに残す**
- switch の **default は no-op**（明示的 `return`）にする。新規 log action 名の追加で writer 側の exhaustive check を壊さないための allowlist 設計
- `task-fsm.ts:79` の ASSIGN_FAIL 経路の log action 名を **`task_aborted` → `task_aborted_core` にリネーム**し、ABORT 側（`task-fsm.ts:104`）と naming 整合させる（reducer 側の log は wrapper 側 spec 名と被らない）

### 2.6 apply-task-actions.ts の context 拡張と payload routing

reducer が返す `log` action は `event: string, detail?: string` のみで spec の payload に必要な surface / taskRunId / title 等を持たない。これを補うため `applyTaskActions` の context に下記を追加し、log action の `event` 名で switch して payload を組み立てる。reducer 自体は **無変更**（純関数性を維持）。

```typescript
// state-machine/apply-task-actions.ts
export interface EventStreamContext {
  taskTitle?: string;        // task_created で必要
  conductorSurface?: string; // task_assigned / task_completed_state_mismatch
  taskRunId?: string;        // task_assigned
  worktreePath?: string;     // task_completed_state_mismatch
  journalSummary?: string;   // task_completed_state_mismatch
}

export interface ApplyTaskActionsContext {
  // 既存 field …
  eventStream?: EventStreamContext;
}
```

**caller ごとの eventStream 渡し方（switch case との対応）:**

| caller | event | 渡す eventStream payload | switch case の組立 |
|---|---|---|---|
| `task.ts:createTaskProgrammatic` | `task_created`（+ `task_ready` if ready） | `{ taskTitle: title }` | `{ event: "task_created", task_id, title: ctx.eventStream?.taskTitle ?? "" }` |
| `daemon.ts:applyAssignCommit`（line 2912）| `task_assigned` | `{ conductorSurface: updated.surface, taskRunId: updated.taskRunId }` | `{ event: "task_assigned", task_id, conductor_surface: ctx.eventStream.conductorSurface, task_run_id: ctx.eventStream.taskRunId }` |
| `daemon.ts:handleConductorDone` auto-close 経路（line 3585）| `task_completed_state_mismatch` | `{ conductorSurface: conductor.surface, worktreePath: conductor.worktreePath ?? "", journalSummary }` | `{ event: "task_completed_state_mismatch", task_id, conductor_surface, reason: "missing_close_task", worktree_path, journal_summary }` |
| `main.ts:cmdUpdateTask` (revertToReady) / 他 REVERT_TO_READY caller | `task_reverted_to_ready` | reducer の `detail` から reason を抽出（既存 detail 形式 `reason=<RevertReason>`）| `{ event: "task_reverted_to_ready", task_id, reason }` |

`journal_summary` は `collectResults()` の戻り値を流用、空でも `""` を必ず出す（spec §6.5「空でも `""` を出す」に従う）。

`task_assigned` payload と writer 型 `{ task_id, conductor_surface, task_run_id }` の対応は switch case 内で 1:1 で組み立てる（writer 側 discriminated union が exhaustive check で field 漏れを compile-time に弾く）。

### 2.7 既存 `manager.log` 並行運用（v1 残置）

- 既存 `await log("event_name", ...)` 行は **削除しない**
- v1 reader（dashboard / trace / 既存 grep ベースのデバッグ）が引き続き動作する
- `events.jsonl` は v2 reader（T359 CLI / T360 watch mode）専用

---

## 3. 実装ステップ（順序付き、TDD）

### Step (a) — writer module + writer 単体テスト

1. `events-writer.ts` を実装（追加のみ、既存ファイル変更なし）。`mapAbortReason(r: AbortReason): SpecAbortReason` も同 module で export
2. `events-writer.test.ts` で以下をカバー:
   - 1 record append → JSON.parse で復元できる
   - `schema_version=2` / `ts` が自動付与される（payload に含めなくても付く）
   - 連続 emit で record 数が増え、過去 record が消えない（retention=append-only）
   - `events.jsonl` parent dir が無い場合は `mkdir -p` する
   - 書き込みエラー（fs.appendFile reject）時に **throw せず** `manager.log` に `events_writer_error`（detail に `error.message` 含む）を残す
   - **並行 emit 100 件すべて JSON.parse で復元できる**（m4 反映、torn-write 耐性）
   - `mapAbortReason` の 8 値マップが table-driven test で完全網羅される（M1）
3. `bun test events-writer.test.ts` 単体で green

### Step (b) — Task FSM reducer 直系の結線（apply-task-actions 経由）

1. `apply-task-actions.ts` の `ApplyTaskActionsContext` に `eventStream?: EventStreamContext` を追加
2. `log` action 処理時に **spec §6 対応 5 種だけ** event 名で switch し、対応する `EventStreamRecord` を組み立てて `emitEvent` を呼ぶ。**switch の default は明示的 `return`（no-op）**
3. **`task-fsm.ts:79`（ASSIGN_FAIL kind=task 経路）の log action 名を `task_aborted` → `task_aborted_core` にリネーム** し、ABORT 側（line 104）と統一する。これにより reducer 直系の log action 名は wrapper 側 spec 名と被らない
4. **`task-fsm.ts:42-49`（CREATE reducer）を `initialStatus === "ready"` のとき `task_created` + `task_ready` の 2 件 log action を返すように変更**（M2 推奨方針 a）。reducer 純関数性は保持される
5. caller (`task-state-store.ts:applyTaskEvent`) のシグネチャを拡張し、呼び出し側から `eventStream` context を受け取って apply-task-actions に渡す
6. caller ごとに以下の eventStream を渡す（§2.6 の表に対応）:
   - `task.ts:createTaskProgrammatic` → `{ taskTitle: title }` （CREATE）
   - `daemon.ts:applyAssignCommit`（line 2912）→ `{ conductorSurface: updated.surface, taskRunId: updated.taskRunId }` （ASSIGN_OK）
   - `daemon.ts:handleConductorDone` auto-close 経路（line 3585、`applyTaskEvent({type:"CLOSE", autoClosed:true})`）→ `{ conductorSurface: conductor.surface, worktreePath: conductor.worktreePath ?? "", journalSummary }`
   - REVERT_TO_READY caller → reducer detail から reason を抽出
7. test: 既存の reducer / store テストに加え、emit が起きることを spy で確認。`createTaskProgrammatic({status:"ready"})` で `task_created` + `task_ready` 両方が emit されるテストを追加（M2）

### Step (c) — wrapper 層の結線

1. `task.ts:markTaskAborted` 末尾の `await log("task_aborted", ...)` の直後に `emitEvent({ event: "task_aborted", task_id, reason: mapAbortReason(reason), journal_summary })` を追加（M1 マップ適用）
2. `daemon.ts:handleConductorDone`:
   - **通常経路（`else` ブランチ、line 3637 付近）からのみ** `emitEvent({event:"task_completed", task_id, conductor_surface, worktree_path, journal_summary})` を追加（M3）
   - auto-close 経路（`stateMismatchOnSuccess === true`、line 3573 付近）は **`task_completed` を emit しない**。`task_completed_state_mismatch` のみ emit（apply-task-actions 経由、Step (b) で結線済み）
   - T269 unresolved 経路（line 3530-3538 付近）で `emitEvent({event:"conductor_done_unresolved", task_id, conductor_surface, worktree_path, journal_summary})` を追加
3. `main.ts:runSyncCheckOrExit` の `ready_rejected` / `ready_auto_pull_failed` 経路に `emitEvent({event:"task_sync_guard_rejected", ...})` を追加:
   - **kind の出所**: reject 経路（`verdict.kind === "reject"`）は `result.state` をそのまま流す（`SyncState` のうち到達するのは `diverged` / `uncommitted` / `detached` の 3 値）。auto-pull-failed 経路は **固定値 `"auto_pull_failed"`**（m1 反映）
   - `detail` には verdict / result から取得可能なメッセージを文字列化して載せる
   - `main_branch` は config の `mainBranch`

### Step (d) — Conductor FSM の結線

> **注**: 以下の line 番号は **2026-04-29 時点**のもの。anchor は各経路の `await log("conductor_*", ...)` 行の **直前または直後**。実装時は `grep -n 'await log("conductor_'` で最新位置を再取得する（m6 反映）。

1. daemon.ts の以下経路に `emitEvent` を追加（既存 `await log("conductor_*", ...)` の直後）:
   - line 1697-1699 の `conductor_recovered`（SESSION_STARTED）
   - line 1719-1722 の `conductor_running`（assigning → running）
   - line 2024-2026 の `conductor_disconnected`（SESSION_ENDED → reason=`session_ended`）
   - line 2104 の `conductor_recovered`（SESSION_ACTIVE）
   - line 2113-2117 の `conductor_running`（SESSION_ACTIVE assigning → running）
   - line 2220-2226 の `conductor_recovered`（SESSION_IDLE）
   - line 2310-2312 の `conductor_asking`
   - line 2399 の `conductor_recovered`（SESSION_CLEAR）
   - line 2836-2838 / 2855-2857 の `conductor_disconnected`（assigning_stuck / assign_failed:conductor → reason=`assign_failed`）
   - line 2989-2991 の `conductor_disconnected`（pid_dead → reason=`pid_dead`）
   - line 3358-3360 の `conductor_start_timeout`
   - line 3390-3392 の `conductor_assign_timeout`
   - line 3411-3413 の `conductor_disconnect_timeout`
   - line 3077 の `conductor_running`（runtime_event）
2. payload は対応 conductor の `surface` / `taskId` / `taskRunId` を渡す。`conductor_disconnected.reason` は SESSION_ENDED / pid_dead / assign_failed の 3 値に正規化

### Step (e) — Retention policy 確認テスト

1. `events-writer.test.ts` で「100 record emit → ファイルサイズが累積している（rotate されない）」「writer は `truncate` / `O_TRUNC` flag を使わない」を assertion
2. spec §7 への準拠を test として記録

### Step (f) — 統合 / 回帰確認

1. `cd skills/cmux-team/manager && bun test --timeout 30000 events-writer.test.ts` を最終 green
2. 既存 FSM テスト群（`task-fsm.test.ts` / `conductor-fsm.test.ts` / `apply-task-actions.test.ts` / `daemon.test.ts` 等）も影響範囲として実行し既存 assertion を破壊していないことを確認（CLAUDE.md「`bun test` 全体実行は禁忌」に従い個別 file 単位で）
3. **`task-fsm.test.ts` の ASSIGN_FAIL kind=task テスト**を `task_aborted_core` 名に追従修正（M4 改名に伴う既存テスト破壊回避）

---

## 4. ファイル別変更内容

依存順（上位ファイルの新規 API が下位で利用される流れ）に並べた:

### 新規追加

| ファイル | 内容 |
|---|---|
| `skills/cmux-team/manager/events-writer.ts` | writer 本体。`emitEvent(record)` / `EVENTS_SCHEMA_VERSION` / `EventStreamRecord` / `SpecAbortReason` / `mapAbortReason` を export。内部で `path.join(projectRoot, ".team/logs/events.jsonl")` に append。エラーは `manager.log` に `events_writer_error` で逃がす（detail に error.message 含む） |
| `skills/cmux-team/manager/events-writer.test.ts` | writer の unit test。schema 適合 / append-only / エラー耐性 / mkdir / retention / 並行 emit 100 件 / `mapAbortReason` 8 値の 7 観点 |

### 編集対象

| ファイル | 変更内容 |
|---|---|
| `skills/cmux-team/manager/state-machine/task-fsm.ts` | (1) **`CREATE` reducer を `initialStatus === "ready"` のとき `task_created` + `task_ready` の 2 件 log action を返すよう拡張**（M2）。(2) **ASSIGN_FAIL kind=task の log action 名を `task_aborted` → `task_aborted_core` にリネーム**（M4、ABORT 側と命名統一）。reducer の純関数性・既存遷移は不変 |
| `skills/cmux-team/manager/state-machine/apply-task-actions.ts` | `ApplyTaskActionsContext` に `eventStream?: EventStreamContext` を追加。`log` action 処理時に **spec 対応 5 種だけ**（task_created / task_ready / task_assigned / task_completed_state_mismatch / task_reverted_to_ready）event 名で switch し `emitEvent` を呼ぶ。**switch の default は明示的 `return`（no-op）** で allowlist 設計（M4） |
| `skills/cmux-team/manager/state-machine/task-state-store.ts` | `ApplyTaskEventInput` に `eventStream?` を pass-through。caller がそのまま渡せるようにする |
| `skills/cmux-team/manager/task.ts` | `createTaskProgrammatic` で `eventStream: { taskTitle: title }` を渡す。`markTaskAborted` 末尾で `emitEvent({ event: "task_aborted", task_id, reason: mapAbortReason(reason), journal_summary })`（M1 マップ適用、spec §6.6） |
| `skills/cmux-team/manager/daemon.ts` | (1) `handleConductorDone` の **通常経路 1 ヶ所のみ** で `task_completed` emit（M3、auto-close 経路では emit しない）。auto-close 経路は `applyTaskEvent({type:"CLOSE", autoClosed:true})` 呼び出しで `eventStream: { conductorSurface, worktreePath, journalSummary }` を渡し、apply-task-actions 経由で `task_completed_state_mismatch` のみ emit（M5）。T269 unresolved 経路で `conductor_done_unresolved` emit。(2) Conductor lifecycle 各経路で `emitEvent` を `await log("conductor_*", ...)` 直後に追加。(3) `applyAssignCommit`（line 2912）の `applyTaskEvent({type:"ASSIGN_OK"})` 呼び出しで `eventStream: { conductorSurface: updated.surface, taskRunId: updated.taskRunId }` を渡す（M6） |
| `skills/cmux-team/manager/main.ts` | `runSyncCheckOrExit` の `ready_rejected` / `ready_auto_pull_failed` 経路で `emitEvent({ event: "task_sync_guard_rejected", task_id, kind, detail, main_branch })`（spec §6.7）。kind は **reject 時 `result.state`、auto_pull_failed は固定値**（m1 反映） |

### 触らない

- `state-machine/conductor-fsm.ts` — Conductor reducer の log action は `events.jsonl` に流さない（shadow 経由でも emit しない契約）。emit は daemon.ts の `await log("conductor_*", ...)` 隣で並列配置
- `state-machine/shadow.ts` — shadow は observer 専用、events.jsonl emit の責務は持たせない（manager.log の `fsm_shadow_action` のみ）。詳細は §6.X
- `logger.ts` — manager.log は v1 並行運用で温存
- hook shell (`hooks/*.sh` 等) — CLAUDE.md ガードレール「hook には分岐ロジックを持たせない、daemon に転送」の遵守。emit は daemon 側のみ

---

## 5. テスト計画

### 5.1 events-writer.test.ts（writer 単体）

| 観点 | 検証方法 |
|---|---|
| schema 適合 | emit 後の 1 行を JSON.parse → `schema_version`・`ts`・`event` 必須 field を確認。`ts` は `\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z` regex |
| 1 record/line | trailing `\n`、JSON 内に改行が含まれない（`JSON.stringify` の挙動） |
| append-only | 連続 N=10 回 emit → 行数 N、過去行が破壊されない |
| エラー耐性 | mock fs.appendFile を reject → throw せず、`manager.log` に **`events_writer_error`**（event 名固定、detail に `error.message` 含む）が残る |
| mkdir 自動 | `.team/logs/` が無い状態で emit → 作られる |
| retention | 100 record 連続 emit → 全部残る（truncate されない、rotate されない） |
| **並行 emit 耐性** | **100 件 `Promise.all([...])` で並行 emit → 全行が JSON.parse 成功**（m4、torn-write 耐性確認）|
| `mapAbortReason` | 8 値（user_clear / judgment_pending / assign_failed / disconnect_timeout / abort_task / resume_no_session_id / resume_no_task_run_id / resume_no_worktree）→ 6 値マップを table-driven で完全網羅（M1）|
| 型安全 | TypeScript compile-only test として `EventStreamRecord` の必須 field 欠落が compile error になることを別 fixture で確認 |

### 5.2 統合テスト（既存テスト拡張）

| ファイル | 追加 assertion |
|---|---|
| `task-state-store.test.ts` / `apply-task-actions.test.ts` | `applyTaskEvent({ event: CREATE, eventStream:{taskTitle} })` で `events.jsonl` に `task_created` record が追加される。**`createTaskProgrammatic({status:"ready"})` で `task_created` + `task_ready` 両方が emit される**（M2）|
| `task-fsm.test.ts` | ASSIGN_FAIL kind=task の log action 名を `task_aborted_core` に追従（M4 改名） |
| `daemon.test.ts`（or 既存 conductor lifecycle tests） | conductor_recovered / conductor_running / conductor_disconnected / conductor_asking 各経路で対応 record が emit される。**auto-close 経路で `task_completed` が events.jsonl に emit されない**ことを negative assertion で確認（M3）|
| `markTaskAborted.test.ts`（既存）| `task_aborted` record が `mapAbortReason` 適用後の `SpecAbortReason` で emit されることを 8 値分パラメタライズして確認（M1）|
| `runSyncCheckOrExit` のテスト | reject / auto-pull failed の双方で `task_sync_guard_rejected` record が emit される。**`runSyncCheckOrExit` は `process.exit(1)` を踏むため、test 側で `process.exit` を mock するか、関数を inject 可能なシグネチャに切り出す**（n3 反映） |
| timeout 経路 | `monitorConductors` の各 timeout で対応 record が emit される（既存テストに spy を挿入） |

### 5.3 fixture / mock 戦略

- `createDummyProject()` ヘルパで temp `PROJECT_ROOT` を作り、test 終了時に events.jsonl を read して assertion
- `CMUX_TEAM_LOGGER_STRICT=1` を維持（PROJECT_ROOT 未設定の fail-fast は writer にも適用）

---

## 6. 影響範囲・注意点

### 6.1 既存 logger / manager.log との関係

- `manager.log` は **温存**（free-text 形式、v1 reader 互換）
- `events.jsonl` は **追加チャネル**（structured JSONL、v2 reader 専用）
- emit は二重に走るため log volume は増える。spec §7 で生成レート低を見積もり済み

### 6.2 EventBus / notifyStateChanged との関係

- spec §1: events.jsonl は **プロセス境界をまたぐ外向け**、EventBus は **daemon プロセス内 TUI refresh**。レイヤーが完全に独立
- 今回 EventBus は変更しない。`notifyStateChanged` の呼び出し位置にも触れない

### 6.3 hook ガードレール（CLAUDE.md）

- 「hook には分岐ロジックを持たせない、全イベントを daemon に転送する」を遵守
- emit は daemon 内部 (`emitEvent` 関数) でのみ呼ぶ。hook shell スクリプトには `events.jsonl` への書き込みロジックを **入れない**

### 6.4 task-state mutation 規約（CLAUDE.md）

- 「`applyTaskEvent` / `updateTaskSessionId` 経由のみ。`taskState[...] =` / `saveTaskState(` を直接書いてはいけない」
- 今回の writer は task-state を mutate しない（log 専用）。規約は影響範囲外
- `apply-task-actions.ts` への変更は context 引数追加のみで mutation 規約は変えない

### 6.5 EventBus 直接呼び出し禁止（CLAUDE.md）

- writer は `notifyStateChanged` / `onStateChanged` を呼ばない（events.jsonl 自体は TUI に影響しない）。`bus.emit` / `bus.on` も使わない

### 6.6 logger.ts の循環依存ルール

- CLAUDE.md「`logger.ts` からの `eventBus.ts` import 禁止」を遵守
- `events-writer.ts` は `logger.ts` を import してエラー時のフォールバック log に使う。`eventBus.ts` は import しない

### 6.7 16 event vs 17+ 経路の整理（m5 反映）

- spec 本体は **16 event 種**（v2 確定版）
- `task_aborted` は `SpecAbortReason` 6 値で 6 経路（M1 マップ後）。他 event の経路と合算して **17+ 経路で 16 event 種を emit** する設計
- 経路数と event 種数を混同しない。reader の dedup は `task_id` + `event` + `ts` で行う（spec §8）

### 6.8 surface ID 形式

- writer payload では **`surface:N` 形式**（cmux `identify` 出力）を使う（spec §6 注記）
- `formatSurface(s, "C")` で生成される `C[N]` は人間可読用（manager.log のみ）。events.jsonl には raw surface ID を渡す

### 6.9 events.jsonl に emit しない event の明示（m2 / m3）

- **`task_completed_state_missing`**（daemon.ts:3630 ブランチ、task-state.json に entry がない race ケース）は spec §6 のどの event にも対応しない。**events.jsonl には emit しない**。`manager.log` だけに残す（m2）
- **`shadow.ts` の `fsm_shadow_action`**（Conductor reducer の log action を observer として manager.log に出すもの）は **events.jsonl に emit しない**。emit 責務は daemon.ts の `await log("conductor_*", ...)` 隣で並列配置の経路のみが持つ。将来 shadow を本実 reducer に昇格させる際は scope outside（§7 末項）の別タスクで再設計（m3）

### 6.10 テスト並列実行禁忌

- CLAUDE.md「`bun test` 全体実行は禁忌」: 個別 file 単位で実行。`for f in ...; do bun test --timeout 30000 "$f"; done` を使う

---

## 7. scope outside（今回触らない範囲）

- **`cmux-team events` CLI（T359）** — tail / filter / `--follow` 実装は別タスク
- **Master watch mode（T360）** — `/cmux-team:watch` の reader 実装は別タスク
- **CLAUDE.md / README 更新（T361）** — Master / Manager プロトコル節への events stream 追記は別タスク
- **既存 `manager.log` の廃止 / 統合** — v1 並行運用を維持。manager.log 側のフォーマット変更も行わない
- **schema v3 への準備** — v2 確定版にのみ対応。breaking change が決まった時点で別タスク
- **events.jsonl の rotate / GC** — spec §7 の決定どおり writer 側で何もしない。`.team/` 全体 GC ポリシーが将来別タスクで検討される
- **shadow observer の本実 reducer 化** — Conductor reducer の log アクションを `events.jsonl` ソースに昇格させる作業は別タスク（P2 以降）。今回は daemon.ts の既存 log() 隣に emit を並列配置するに留める
- **hook shell の変更** — CLAUDE.md ガードレールに従い触らない

---

## 8. レビュー対応履歴

Design Review (Changes Requested) の指摘 13 件への対応サマリー（後続 Reviewer の差分把握用）:

### Major（必須対応、6 件）

| ID | 対応セクション | 変更要約 |
|---|---|---|
| **M1** | §2.1, §2.5, §3 Step (a)/(c), §4, §5.1 / 5.2 | `EventStreamRecord` の `task_aborted.reason` を spec §6.6 準拠の独立 `SpecAbortReason` 型（6 値）として定義。`AbortReason → SpecAbortReason` マップ表（8 値 → 6 値、`abort_task → other` / `resume_no_* → resume_marked_aborted`）を §2.1 に追記。`mapAbortReason` を `events-writer.ts` で export し table-driven test で全網羅。`task.ts:markTaskAborted` で wrapper 側からマップ適用 |
| **M2** | §2.5, §3 Step (b), §4（task-fsm.ts 追加）, §5.2 | `task-fsm.ts:CREATE` reducer を `initialStatus === "ready"` のとき `task_created` + `task_ready` の 2 件 log action 返却に変更（推奨方針 a）。`createTaskProgrammatic({status:"ready"})` で両 event emit のテスト追加 |
| **M3** | §2.5, §3 Step (c), §4（daemon.ts 説明）, §5.2 | `task_completed` は `handleConductorDone` の **通常経路 1 ヶ所のみ** emit。auto-close 経路（`stateMismatchOnSuccess === true`）は `task_completed_state_mismatch` のみ emit。manager.log 側の二重 log は v1 互換のため温存と明記。negative assertion でテスト |
| **M4** | §2.5 末尾, §3 Step (b), §4（task-fsm.ts 編集対象に追加）, §5.2 | `apply-task-actions` の switch は spec §6 対応 5 種のみ emit、それ以外は logger.log のみで残す allowlist 設計（switch default は no-op）。`task-fsm.ts:79`（ASSIGN_FAIL kind=task）の log action 名を `task_aborted` → `task_aborted_core` にリネームし ABORT 側と命名統一 |
| **M5** | §2.6, §3 Step (b) | auto-close 経路 `applyTaskEvent({type:"CLOSE", autoClosed:true})` 呼び出しで `eventStream: { conductorSurface: conductor.surface, worktreePath: conductor.worktreePath ?? "", journalSummary }` を渡すと §3 Step (b) で明示。`journal_summary` は `collectResults()` 流用、空でも `""` を出す旨を §2.6 に記載 |
| **M6** | §2.6, §3 Step (b), §4 | `applyAssignCommit`（daemon.ts:2912）の `applyTaskEvent({type:"ASSIGN_OK"})` 呼び出しで `eventStream: { conductorSurface: updated.surface, taskRunId: updated.taskRunId }` を渡す指示を追加。writer 型と switch case 対応関係を §2.6 表で明示 |

### Minor（推奨、7 件すべて反映）

| ID | 対応セクション | 変更要約 |
|---|---|---|
| **m1** | §3 Step (c) | `task_sync_guard_rejected.kind` の出所を「reject 時は `result.state` から、auto_pull_failed は固定値」に書き換え |
| **m2** | §6.9 | `task_completed_state_missing`（daemon.ts:3630 ブランチ）は events.jsonl に emit しない決定を明記（manager.log のみ） |
| **m3** | §6.9 | shadow.ts は events.jsonl に emit しない（manager.log の `fsm_shadow_action` のみ）旨を追記 |
| **m4** | §5.1 | テスト「並行 emit 100 件全行 JSON.parse 成功」を追加（torn-write 耐性確認） |
| **m5** | §1, §6.7 | 概要を「**16 event 種を 17+ 経路で emit**」に書き換え。経路数と event 種数の別軸である点を明示 |
| **m6** | §3 Step (d) 冒頭注記 | line 番号に「2026-04-29 時点、anchor は `await log("conductor_*", ...)` 行直前/直後」の注記。実装時は `grep -n` で再取得 |
| **m7** | §2.4, §5.1 | writer エラー fallback log 名を `events_writer_error`（detail に `error.message` 含む）と固定化 |

### Nits（任意、部分反映）

| ID | 対応 | 備考 |
|---|---|---|
| **n1** | §4 編集対象を依存順（events-writer → task-fsm → apply-task-actions → task-state-store → task → daemon → main）に並べ替え | 反映済み |
| **n2** | §6.8 surface ID 表記方針は維持 | 反映不要、現状維持 |
| **n3** | §5.2 `runSyncCheckOrExit` テスト方針に「`process.exit` mock または inject 可能シグネチャに切り出し」を明記 | 反映済み |
