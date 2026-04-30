# T358 完了サマリー — Manager events.jsonl writer + 17 event 結線

## タスク概要

T357 で確定した v2 schema に従い、Manager に append-only な events.jsonl writer を実装し、Task FSM / Conductor FSM / wrapper 層から spec §6 の 16 event 種を 17+ 経路で `.team/logs/events.jsonl` に emit する。retention は無制限 append、エラーは best-effort で manager.log にフォールバック。manager.log は v1 として並行運用継続。

## フェーズ実行履歴

| フェーズ | Agent | 結果 | 備考 |
|---|---|---|---|
| Phase 1: Plan | Planner (surface:164) | plan.md v1 (261 行) | |
| Phase 2: Design Review (round 1) | Reviewer (surface:167) | Changes Requested (Major 6 / Minor 7 / Nits 3) | |
| Phase 1: Plan (round 2) | Planner (surface:171) | plan.md v2 (396 行)、§8 レビュー対応履歴追加 | |
| Phase 2: Design Review (round 2) | Reviewer (surface:180) | **Approved** | Major 全件解消 |
| Phase 3: Implementation | Implementer (surface:181) | 実装完了 | 1755 tests pass / 0 fail / tsc clean |
| Phase 4: Inspection | Inspector (surface:183) | **GO** | Critical/Major なし、Minor 2 件は実害なし |

## 変更ファイル一覧

### 新規追加（2 ファイル）

- `skills/cmux-team/manager/events-writer.ts` — writer 本体（`emitEvent` / `EventStreamRecord` / `SpecAbortReason` / `mapAbortReason` / `EVENTS_SCHEMA_VERSION=2`）
- `skills/cmux-team/manager/events-writer.test.ts` — writer 単体テスト 18 件

### 編集（9 ファイル）

- `skills/cmux-team/manager/state-machine/task-fsm.ts` — CREATE reducer の log action 2 件返却 (M2)、ASSIGN_FAIL → `task_aborted_core` リネーム (M4)
- `skills/cmux-team/manager/state-machine/apply-task-actions.ts` — `EventStreamContext` 追加、allowlist 5 種の switch (M4)、渡し忘れ時 fallback log
- `skills/cmux-team/manager/state-machine/task-state-store.ts` — `eventStream` pass-through
- `skills/cmux-team/manager/state-machine/apply-task-actions.test.ts` — 9 件追加（payload 組立、negative）
- `skills/cmux-team/manager/state-machine/task-state-store.test.ts` — 2 件追加（CREATE+ready で 2 件 emit）
- `skills/cmux-team/manager/task.ts` — `createTaskProgrammatic` で eventStream 渡し、`markTaskAborted` で `mapAbortReason` 適用 (M1)
- `skills/cmux-team/manager/task.test.ts` — 2 件追加（mapAbortReason 8 値マップ）
- `skills/cmux-team/manager/daemon.ts` — `applyAssignCommit` で eventStream 渡し (M6)、auto-close で eventStream 渡し (M5)、handleConductorDone で `task_completed` を else 通常経路のみ emit (M3)、`conductor_done_unresolved` emit、Conductor lifecycle 12 経路で emit
- `skills/cmux-team/manager/main.ts` — `runSyncCheckOrExit` で `task_sync_guard_rejected` emit

## 結線対応表 (spec §6 ↔ 実装位置)

| spec § | event | 実装位置 |
|---|---|---|
| 6.1 | task_created | apply-task-actions (CREATE) |
| 6.2 | task_ready | apply-task-actions (CREATE+ready / UPDATE_STATUS) |
| 6.3 | task_assigned | apply-task-actions (ASSIGN_OK) / daemon.ts:applyAssignCommit |
| 6.4 | task_completed | daemon.ts:handleConductorDone 通常経路 else のみ |
| 6.5 | task_completed_state_mismatch | apply-task-actions (CLOSE autoClosed=true) / daemon.ts auto-close |
| 6.6 | task_aborted | task.ts:markTaskAborted (mapAbortReason 経由) |
| 6.7 | task_sync_guard_rejected | main.ts:runSyncCheckOrExit |
| 6.8 | task_reverted_to_ready | apply-task-actions (REVERT_TO_READY) |
| 6.9 | conductor_running | daemon.ts (3 経路: SESSION_STARTED / SESSION_ACTIVE / runtime_event) |
| 6.10 | conductor_recovered | daemon.ts (4 経路: SESSION_STARTED / SESSION_ACTIVE / SESSION_IDLE / SESSION_CLEAR) |
| 6.11 | conductor_disconnected | daemon.ts (4 経路: SESSION_ENDED / assigning_stuck / assign_failed:conductor / pid_dead) |
| 6.12 | conductor_asking | daemon.ts SESSION_ASK |
| 6.13 | conductor_done_unresolved | daemon.ts:handleConductorDone unresolved |
| 6.14 | conductor_start_timeout | daemon.ts:monitorConductors |
| 6.15 | conductor_assign_timeout | daemon.ts:monitorConductors |
| 6.16 | conductor_disconnect_timeout | daemon.ts:monitorConductors |

## テスト結果

- writer 単体: **18 pass / 0 fail / 148 expect()**
- 全 manager テスト個別実行（58 ファイル）: **1755 pass / 0 fail**
- tsc: 新規エラー 0 件

## レビュー指摘の対応

- Design Review round 1 Major 6 件 (M1-M6): plan v2 で全反映、Inspector が GO 判定で個別確認済み
- Design Review round 1 Minor 7 件 (m1-m7): plan v2 で全反映
- Design Review round 2「新たな懸念」3 件: Implementer が実装時に対応（eventStream 渡し忘れ negative test、reason= grep 確認、mkdtemp で test 隔離）

## 残課題（scope outside、別タスク）

- T359: `cmux-team events --follow` CLI 実装
- T360: Master watch mode 実装
- T361: CLAUDE.md / README への events stream 節追加
- schema v3、rotate / GC ポリシー、shadow 本実 reducer 化
