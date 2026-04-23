# T303 検品結果 (Inspector2)

> Inspector: task-303-1776910530/inspector2
> 実施日時: 2026-04-23
> 対象ブランチ: `task-303-1776910530/task`

## 1. 判定

**GO**

Plan §7「完了チェックリスト（構造）」の受け入れ条件を全て満たし、Critical な逸脱は発見されなかった。後述する残課題は、いずれも軽微な cleanliness または後続タスク相当の改善点であり、マージ可否を左右しない。

---

## 2. 検証結果サマリ

### 2.1 Plan §7 構造的受け入れ条件

| # | 条件 | 結果 | 根拠 |
|---|---|---|---|
| 1 | `shadowObserveTask` が `applyTaskEvent` 内 + `apply-task-actions.ts` cascade 側から呼ばれる（R5） | PASS | `task-state-store.ts:164,227`（親）、`apply-task-actions.ts:62-74`（子） |
| 2 | `grep -nE 'taskState\[.*\]\s*='` {daemon,main}.ts 0 件 | PASS | 実機 0 件 |
| 3 | `grep -nE 'ts\[[^\]]+\]\s*='` {daemon,main}.ts 0 件 | PASS | 実機 0 件 |
| 4 | `grep -nE '(taskState\|ts)\[[^\]]+\]\.[a-zA-Z_]+\s*='` 0 件（R15） | PASS | 実機 0 件 |
| 5 | `grep -nE 'delete\s+(taskState\|ts)\[[^\]]+\]\.[a-zA-Z_]+'` 0 件（R15） | PASS | 実機 0 件 |
| 6 | `grep -n 'saveTaskState('` {daemon,main}.ts 0 件 | PASS | 実機 0 件（import 残存は許容範囲） |
| 7 | `grep -n 'taskStateModified'` 0 件（R16） | PASS | 実機 0 件 |
| 8 | `task.ts` 内の `saveTaskState` 呼出は store 経由のみ | PASS | task.ts:384 は export のみ、呼び出しは store 内 |
| 9 | `events.ts` に `REVERT_TO_READY` 追加（R10 改名）exhaustive check pass | PASS | `events.ts:113-121` + `task-fsm.ts:156-160` exhaustive guard あり |
| 10 | `task-fsm.ts` の `REVERT_TO_READY` case が `state === "assigned"` のみ（R2） | PASS | `task-fsm.ts:147-156` で他 state は `noop(state)` |
| 11 | `apply-task-actions.ts` が `{ log, cascade_children }` を処理、cascade 子の shadow 呼出を新規テストで検証（R5） | PASS | `apply-task-actions.test.ts:96-132` |
| 12 | `task-state-store.ts` の `applyTaskEvent` / `updateTaskSessionId` が mutex で直列化、内部で `notifyStateChanged` を呼ぶ（R9） | PASS | `task-state-store.ts:35-45, 169-171, 232-234, 316-318` |
| 13 | D5 専用ヘルパ `updateTaskSessionId` が 3 段 guard を hard-code（R3） | PASS | `task-state-store.ts:298-327`（no_entry / taskrun_mismatch / not_assigned / unchanged） |
| 14 | T302 の `assign_skipped_terminal` 削除、`assign_skipped`（terminal）と `assign_skipped_unexpected`（想定外 noop）に分離（R7 / R12） | PASS | `daemon.ts:2704-2717` で prev 判定に基づき 2 ログに分離 |
| 15 | `__testApplyAssignCommit` export 削除、旧テストは `task-state-store.test.ts` に移設（R18） | PASS | daemon.ts は `applyAssignCommit`（non-export）に改名。daemon.test.ts:5062-5069 に移設コメント。`task-state-store.test.ts:91-126` で terminal noop カバー |
| 16 | `bun test` 全通過 | PASS | 1152 pass / 0 fail / 2717 expect() calls（38 files） |
| 17 | `bunx tsc --noEmit` 新規エラー 0 | PASS | 3 件検出だが main 上でも同じ 3 件（conductor.ts:201, daemon.test.ts:3870, daemon.ts:1558）。T303 由来の新規エラーなし |
| 18 | `docs/spec/07-state-machine.md` P2 完了内容で更新 | PASS | §2.2 遷移表に `REVERT_TO_READY` 行 + `CLOSE(autoClosed=true)` 行追加、§2.3 Mermaid に `assigned --> ready : RESTART / REVERT_TO_READY` と `[*] --> ready : CREATE(initialStatus=ready)`、§4.1 Task shadow 配線節新設、§5 に P2(T303) 行、§5.1 T302 脚注 |
| 19 | CLAUDE.md に書き込みポリシー追記 | PASS | `CLAUDE.md:402-418`「task-state 書き込みポリシー（T303）」節追加 |

### 2.2 Plan §4 実装ステップの整合

| Step | 内容 | 結果 |
|---|---|---|
| Step 1 | 新規 event と reducer case のテスト先行 | PASS（`fsm.test.ts` に REVERT_TO_READY 全 6 state × 5 reason、CREATE initialStatus、CLOSE autoClosed、ABORT task_aborted_core のテストあり） |
| Step 2 | `applyTaskActions` 単体テスト + 実装 | PASS（`apply-task-actions.test.ts` 7 ケース + cascade 子 shadow 呼出 assert） |
| Step 3 | `applyTaskEvent` 単体テスト + 実装 | PASS（`task-state-store.test.ts` 22 ケース、R13 の具体化した assert を全て網羅） |
| Step 4 | daemon.ts の mutation 置換（D1〜D7） | PASS（D1〜D4: REVERT_TO_READY、D5: updateTaskSessionId、D6: applyAssignCommit(ASSIGN_OK)、D7: CLOSE(autoClosed=true)） |
| Step 5 | main.ts の mutation 置換（M1〜M9） | PASS（M1/M3: REVERT_TO_READY、M4: UPDATE_STATUS、M5: CLOSE、M6〜M8: RESTART、M9: DELETE） |
| Step 6 | task.ts の mutation 置換（TS1〜TS3） | PASS（TS1: markTaskAborted → ABORT、TS2: cascadeAbortToChildrenInPlace にリネーム + 後方互換 alias、TS3: createTaskProgrammatic → CREATE） |
| Step 7 | T302 guard 撤去 + `__testApplyAssignCommit` 整理 | PASS（`daemon.ts` の `applyAssignCommit` に集約、export 削除） |
| Step 8 | Grep invariant check | PASS（全 invariant 0 件） |
| Step 9 | docs/spec/07-state-machine.md 更新 | PASS |
| Step 10 | 実稼働 24h 観測 | 後続（マージ後観測） |

### 2.3 検品観点（Plan「検品観点」1〜8）

| # | 観点 | 結果 | 根拠 |
|---|---|---|---|
| 1 | Plan §7 受け入れ条件全充足 | PASS | 2.1 節参照 |
| 2 | pure reducer の純粋性（I/O なし） | PASS | `task-fsm.ts` は純関数のみ。I/O 呼出なし |
| 3 | mutex の実装 | PASS | `withTaskStateLock` は Promise チェーン FIFO。`applyTaskEvent` / `updateTaskSessionId` 双方で直列化されている |
| 4 | cascade_children で子に shadow 呼出 | PASS | `apply-task-actions.ts:62-74`。`task-state-store.test.ts:206-240` と `apply-task-actions.test.ts:96-132` で assert |
| 5 | 副作用の責務境界（trace DB / postMessage / resetConductor を store 外に） | PASS | `task-state-store.ts:105-109` に責務境界コメント。実際 trace DB insert は `daemon.ts:3199-3213` に残置（R8 準拠）、resetConductor は `daemon.ts:2708` に残置 |
| 6 | D5 専用ヘルパの 3 段 guard | PASS | `task-state-store.ts:298-327` + `task-state-store.test.ts:452-504` で全経路カバー |
| 7 | 循環依存なし | PASS | store → { logger, task, state-machine/*, apply-task-actions, eventBus }。logger は eventBus に依存しない（CLAUDE.md「EventBus ポリシー」維持）。`task.ts` は store に対して dynamic import（循環回避） |
| 8 | 不要な抽象化・plan 外変更 | PASS | plan §1.2 スコープ内の変更のみ。plan §1.3 で外された M2 bulk refresh は `refreshTaskStateFromDisk` ヘルパとして保存され、直接 mutation から store 経由に昇格しつつ削除はしていない |

---

## 3. 発見事項

### 3.1 Critical（NOGO 理由）

**なし**

### 3.2 軽微（GO でも修正推奨。後続タスクに回せる水準）

1. **daemon.ts / main.ts の未使用 import**
   - `daemon.ts:20` と `main.ts:42` の `import { ... saveTaskState, cascadeAbortToChildren, ... }` は実呼出が存在しない。grep invariant は `saveTaskState(` で絞っているため invariant 自体は 0 件を満たすが、dead import が残っている。
   - 影響: コード cleanliness のみ。TSC エラーなし。削除しても動作は変わらない。

2. **`task-state-store.ts:207-209` の status 明示 override が redundant**
   - `Object.assign(baseEntry, patchValue.merge)` が先に `status` を merge するため、その後の `if (patchValue?.merge && "status" in patchValue.merge && patchValue.merge.status) baseEntry.status = patchValue.merge.status;` は同じ結果を二度書く dead code。
   - 影響: 機能に影響なし。コード可読性のみ。コメントは「restart 経路で重要」とあるが、`remove: ["status"]` のようなケースはなく、`Object.assign` で十分。

3. **`task.ts:874-886` createTaskProgrammatic の patch.merge.status が redundant**
   - reducer が既に `next = initialStatus` を返すため、`merge: { ..., status: initialStatus }` の status フィールドは上書きしても同値。
   - 影響: 機能に影響なし。

4. **`main.ts:3180` cmdCloseTask の `remove: []` 空配列 + 誤解を招くコメント**
   - `// close 時は assigned 時の resume metadata をクリア (冪等)` とあるが `remove: []` は何も消さない。closed 状態で `assignedAt` / `taskRunId` / `worktreePath` / `sessionId` が残存する可能性がある。
   - 影響: 既存動作を維持しているだけ（T303 以前から残存していた）。ただしコメントと実装が不整合。
   - 後続タスク候補: close 時の残存フィールド方針を明文化する／クリアする場合は別 PR で実施。

5. **`task.ts:719-722` の後方互換 alias (`cascadeAbortToChildren = cascadeAbortToChildrenInPlace`) は task.test.ts / daemon.test.ts からのみ参照**
   - Plan §3.3 の想定通り public export を維持しているが、実プロダクションコードからは呼ばれていない（全て `applyTaskActions` 経由）。
   - 影響: なし（alias は意図通り）。将来的にテストが `cascadeAbortToChildrenInPlace` に移行した時点で alias 削除を検討。

### 3.3 観測事項（対応不要 — 設計通り）

- `refreshTaskStateFromDisk` による bulk refresh が 6 箇所（daemon.ts 3 箇所 / main.ts 3 箇所）に散在するのは Plan §3.8 / R6 の通り当面残す方針。`applyTaskEvent` が独立 load/save するため、呼び出し側の in-memory taskState と別 reference になる点を吸収するためのヘルパ。将来 resume ループ全体を store 経由に置き換える別タスクで解消される想定。

- M2 bulk refresh を消さなかったことで Step 5-6（§4）の削除計画は Plan rev2 で取り下げられており、実装と plan rev2 は整合している。

- `trace DB insert` 副作用は `daemon.ts:3199-3213` に残置されており（T274 auto-close 経路）、Plan §3.1 の「責務境界（呼び出し側に残す副作用 — R8）」に準拠。

---

## 4. Fix Required（NOGO の場合）

**該当なし（GO 判定のため）**

---

## 5. 残課題（後続タスクに回せる改善点）

1. **24h 実稼働観測（Plan §7 「リリース後観測」）**
   - マージ後 24h で `fsm_shadow_diff` / `fsm_invariant_violation` / `fsm_shadow_error` の 3 種が manager.log に 0 件であることを確認。
   - 1 件でも非ゼロなら配線側のバグとして即修正タスクを起票し、本 PR の P2 完了条件を「修正後 24h で 0 件」に書き換えて再観測。

2. **file lock による cross-process 保護（Plan §1.3）**
   - CLI ↔ daemon 間の race は reducer noop で観測的に吸収する方針。24h shadow 観測で diff が出た場合のみ別タスク化。

3. **未使用 import のクリーンアップ**
   - 3.2 節 1 の dead import（`saveTaskState` / `cascadeAbortToChildren` 等）削除。1 行の簡易修正なので、次回 docs-sync 等のついでで解消可。

4. **task-state-store.ts の status override 重複コード削除**
   - 3.2 節 2 の `baseEntry.status = patchValue.merge.status;` ブロック（task-state-store.ts:207-209）を削除。`Object.assign` が既に同等処理を済ませている。

5. **cmdCloseTask の close 時 resume metadata 残存方針**
   - 3.2 節 4 の通り、`main.ts:3180` の `remove: []` 空配列は現状の既存動作維持。closed 時に `assignedAt` / `taskRunId` / `worktreePath` / `sessionId` を残す／消すのどちらにするか別タスクで判断。dashboard 側表示にも影響するため仕様決定を伴う。

6. **Conductor 側 mutation の reducer 置換（Plan §1.3 / P3）**
   - `ConductorAction` の `reset_conductor` / `close_task_auto` 等の副作用を `apply-conductor-actions.ts` 経由に集約する Plan §3.3 R19 の対称設計。本タスクは Task 側のみ担当した。

---

## 6. 補足: 検証コマンドと実行結果

```bash
# Grep invariants（§4 Step 8）
$ grep -nE 'taskState\[.*\]\s*=' skills/cmux-team/manager/daemon.ts skills/cmux-team/manager/main.ts
(0 件)

$ grep -nE 'ts\[[^\]]+\]\s*=' skills/cmux-team/manager/daemon.ts skills/cmux-team/manager/main.ts
(0 件)

$ grep -n 'saveTaskState(' skills/cmux-team/manager/daemon.ts skills/cmux-team/manager/main.ts
(0 件)

$ grep -nE '(taskState|ts)\[[^\]]+\]\.[a-zA-Z_]+\s*=' skills/cmux-team/manager/daemon.ts skills/cmux-team/manager/main.ts
(0 件)

$ grep -nE 'delete\s+(taskState|ts)\[[^\]]+\]\.[a-zA-Z_]+' skills/cmux-team/manager/daemon.ts skills/cmux-team/manager/main.ts
(0 件)

$ grep -n 'taskStateModified' skills/cmux-team/manager/daemon.ts skills/cmux-team/manager/main.ts
(0 件)

# Full test suite
$ bun test
1152 pass / 0 fail / 2717 expect() calls / 38 files / 49.48s

# State-machine only
$ bun test state-machine/
205 pass / 0 fail / 416 expect() calls / 3 files / 126ms

# TSC
$ bunx tsc --noEmit
3 errors（全て main branch にも存在する既存エラー。T303 由来の新規エラー 0 件）
```

## 7. 結論

T303 は Plan rev2 で定義された P2 （Task 側 SSOT 確立）を構造的・テスト的に満たしており、Critical な逸脱は存在しない。軽微な cleanliness 改善点（3.2 節 1〜4）は後続タスクまたは docs-sync で段階的に解消できる水準であり、マージ判断を阻害しない。

**判定: GO**
