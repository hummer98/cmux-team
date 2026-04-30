# T358 実装サマリー — Manager events.jsonl writer + 17 event 結線

## 概要

`docs/spec/10-events-stream.md` v2 schema に準拠した append-only writer
`events-writer.ts` を新設し、Task FSM / Conductor FSM / wrapper 層の各 transition から
spec §6 の 16 event 種を 17+ 経路で `.team/logs/events.jsonl` に emit する。

retention は無制限 append（rotate / GC は writer の責務外）。書き込み失敗は throw せず
`manager.log` に `events_writer_error` を残す best-effort。manager.log は v1 として
並行運用継続。

## 実装ファイル一覧

### 新規追加（2 ファイル）

| ファイル | 概要 |
|---|---|
| `skills/cmux-team/manager/events-writer.ts` | writer 本体。`emitEvent` / `EventStreamRecord` discriminated union / `SpecAbortReason` (6 値) / `RevertReason` / `EVENTS_SCHEMA_VERSION=2` / `mapAbortReason` (8→6 値マップ) を export |
| `skills/cmux-team/manager/events-writer.test.ts` | writer 単体テスト 18 件（schema 適合 / 1 行 1 record / append-only 10 件 + 100 件 retention / mkdir 自動 / 書き込みエラー耐性 / 並行 emit 100 件 / 各 payload 型動作 / `mapAbortReason` 8 値マップ table-driven） |

### 編集（依存順 7 ファイル）

| ファイル | 変更ハイライト |
|---|---|
| `state-machine/task-fsm.ts` | (1) `CREATE` reducer を `initialStatus === "ready"` のとき `task_created` + `task_ready` の 2 件 log action 返却に拡張（M2）。(2) `ASSIGN_FAIL kind=task` 経路の log action 名を `task_aborted` → `task_aborted_core` にリネーム（M4、ABORT 側と統一） |
| `state-machine/apply-task-actions.ts` | `EventStreamContext` 型追加。`ApplyTaskActionsContext.eventStream?: EventStreamContext`。log action 処理時に **spec §6 対応 5 種だけ** event 名で switch し `emitEvent` を呼ぶ allowlist 設計（default は no-op return）。caller が必須 field を渡し忘れた場合は `events_writer_error` で fallback log + emit skip |
| `state-machine/task-state-store.ts` | `ApplyTaskEventInput.eventStream?: EventStreamContext` を pass-through。CREATE / 非 CREATE 両経路で `applyTaskActions` に渡す |
| `task.ts` | (1) `createTaskProgrammatic` に `eventStream: { taskTitle: title }` を渡す。(2) `markTaskAborted` 末尾で wrapper 側 `task_aborted` log の隣に `emitEvent({event:"task_aborted", task_id, reason: mapAbortReason(reason), journal_summary})`（dynamic import で循環依存回避） |
| `daemon.ts` | (1) `applyAssignCommit` で `eventStream: { conductorSurface, taskRunId }` を渡す（M6）。(2) `handleConductorDone` 通常経路 `else` のみ `task_completed` emit（auto-close 経路は `task_completed_state_mismatch` のみ、M3）。auto-close `applyTaskEvent({type:"CLOSE", autoClosed:true})` で `eventStream: { conductorSurface, worktreePath, journalSummary }`（M5）。T269 unresolved 経路で `conductor_done_unresolved` emit。(3) Conductor lifecycle 12 経路で `await log("conductor_*", ...)` 直後に `emitEvent` を並列配置 |
| `main.ts` | `runSyncCheckOrExit` の `ready_rejected` / `ready_auto_pull_failed` 経路で `emitEvent({event:"task_sync_guard_rejected", ...})`。kind は reject 時 `result.state` を流用、auto-pull-failed 時は固定値 `"auto_pull_failed"` |
| `state-machine/apply-task-actions.test.ts` | 9 件の events.jsonl 関連 test 追加（task_created/title 付き / task_ready / task_assigned eventStream + 渡し忘れ negative / task_completed_state_mismatch eventStream + 渡し忘れ negative / task_reverted_to_ready detail パース / allowlist 外 log は流れない） |
| `state-machine/task-state-store.test.ts` | 2 件追加（CREATE+ready で task_created + task_ready の 2 件 emit / CREATE+draft で task_created のみ emit） |
| `task.test.ts` | 2 件追加（markTaskAborted で `abort_task → other` マップ確認 / 8 値全 table-driven） |

## 結線対応表 (spec §6 ↔ 実装位置)

| spec § | event | 実装位置 |
|---|---|---|
| 6.1 | `task_created` | `state-machine/apply-task-actions.ts: dispatchEventStreamLog` (CREATE reducer 経由) |
| 6.2 | `task_ready` | 同上 (CREATE reducer + UPDATE_STATUS 経由) |
| 6.3 | `task_assigned` | 同上 (ASSIGN_OK reducer 経由 / `daemon.ts: applyAssignCommit` で eventStream 渡し) |
| 6.4 | `task_completed` | `daemon.ts: handleConductorDone` 通常経路 `else` のみ |
| 6.5 | `task_completed_state_mismatch` | `state-machine/apply-task-actions.ts: dispatchEventStreamLog` (CLOSE autoClosed=true reducer 経由 / `daemon.ts: handleConductorDone` auto-close で eventStream 渡し) |
| 6.6 | `task_aborted` | `task.ts: markTaskAborted` wrapper 末尾 (mapAbortReason 経由で 8→6 値) |
| 6.7 | `task_sync_guard_rejected` | `main.ts: runSyncCheckOrExit` reject / auto-pull-failed 経路 |
| 6.8 | `task_reverted_to_ready` | `state-machine/apply-task-actions.ts: dispatchEventStreamLog` (REVERT_TO_READY reducer 経由、detail から reason 抽出) |
| 6.9 | `conductor_running` | `daemon.ts` SESSION_STARTED(assigning→running) / SESSION_ACTIVE(assigning+taskRunId→running) / `handleRuntimeEvent: session_started` (assigning→running) の 3 経路 |
| 6.10 | `conductor_recovered` | `daemon.ts` SESSION_STARTED(disconnected→idle) / SESSION_ACTIVE(disconnected→running) / SESSION_IDLE(disconnected→running or idle) / SESSION_CLEAR(disconnected→idle) の 4 経路 (new_status 付き) |
| 6.11 | `conductor_disconnected` | `daemon.ts` SESSION_ENDED (reason=session_ended) / scanTasks ASSIGN err kind=task assigning_stuck (reason=assign_failed) / scanTasks ASSIGN err kind=conductor (reason=assign_failed) / `__testSpawnPidWatcherTick` PID_DIED (reason=pid_dead) の 4 経路 |
| 6.12 | `conductor_asking` | `daemon.ts` SESSION_ASK (asking 状態遷移) |
| 6.13 | `conductor_done_unresolved` | `daemon.ts: handleConductorDone` unresolved 経路 |
| 6.14 | `conductor_start_timeout` | `daemon.ts: monitorConductors` STARTING_TIMEOUT_SEC 超過 |
| 6.15 | `conductor_assign_timeout` | `daemon.ts: monitorConductors` ASSIGNING_TIMEOUT_SEC 超過 |
| 6.16 | `conductor_disconnect_timeout` | `daemon.ts: monitorConductors` DISCONNECT_TIMEOUT_SEC 超過直前 |

**経路数の整理**: 16 event 種を 17+ 経路で emit。
`task_aborted` は SpecAbortReason 6 値で 6 経路、`conductor_recovered` 4 経路、`conductor_disconnected` 4 経路、
`conductor_running` 3 経路、その他は 1〜2 経路。reader の dedup は `task_id` + `event` + `ts`（spec §8）。

## 実行テスト結果

### 1. writer 単体

```
$ bun test --timeout 30000 events-writer.test.ts
18 pass / 0 fail / 148 expect() calls
```

### 2. 関連既存テスト（state-machine + task）

```
$ bun test --timeout 30000 events-writer.test.ts state-machine/apply-task-actions.test.ts \
    state-machine/task-state-store.test.ts state-machine/fsm.test.ts task.test.ts
341 pass / 0 fail / 821 expect() calls
```

うち events.jsonl 関連の追加 assertion:
- `apply-task-actions.test.ts`: 9 件追加（allowlist / payload 組立 / 渡し忘れ negative）
- `task-state-store.test.ts`: 2 件追加（CREATE+ready で 2 件 emit / CREATE+draft で 1 件 emit）
- `task.test.ts`: 2 件追加（markTaskAborted の SpecAbortReason マップ）
- `events-writer.test.ts`: 18 件新規（schema / append-only / retention / 並行耐性 / mapAbortReason）

### 3. 全テスト個別実行（CLAUDE.md 「`bun test` 全体実行禁忌」遵守）

```
$ for f in *.test.ts state-machine/*.test.ts; do bun test --timeout 30000 "$f"; done
58 / 58 ファイル PASS / 1755 件 pass / 0 件 fail
```

### 4. tsc 型検査

```
$ bunx tsc --noEmit -p tsconfig.json
（出力なし、新規エラー 0 件）
```

## plan からの逸脱

なし。plan §3 Step (a)〜(f) の順番どおり、design-review の「新たな懸念 3 件」をすべて反映:
1. `apply-task-actions` switch case で eventStream 必須 field の渡し忘れ → `events_writer_error` で skip + negative assertion test 追加
2. `task_reverted_to_ready` の reason 抽出元 → `task-fsm.ts` の `reason=` detail 形式が他用途と被らないことを grep で確認済み（task_aborted_core / child_reverted_to_draft も同形式だが allowlist 外で events.jsonl に流れない）
3. fixture の `events.jsonl` 直読み戦略 → 各 caller test は `createDummyProject({prefix: "..."})` で test ごとに隔離した temp PROJECT_ROOT を作っており、ファイル単位安全性を担保

## 残課題

- **T359**: `cmux-team events --follow` CLI の実装（reader 側、tail / filter / `--follow`）
- **T360**: Master watch mode の実装（events.jsonl を購読して介入要 event を user に escalation）
- **T361**: CLAUDE.md / README への events stream 節追加
- **schema v3 への準備**: 必要になった時点で別タスク
- **rotate / GC ポリシー**: `.team/` 全体 GC ポリシーの一部として別タスク

## コミット

- 未コミット（`git status` の変更ファイル一式は Conductor の完了処理でコミット）
