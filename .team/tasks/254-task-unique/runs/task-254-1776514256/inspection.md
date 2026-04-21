# T254 Inspection Report

- **Task**: T254 Task の二重起動を防ぐ unique 制約を不変条件として検査
- **Inspector**: inspector-254
- **Date**: 2026-04-18
- **Worktree**: `/Users/yamamoto/git/cmux-team/.worktrees/task-254-1776514256`
- **Files changed**: `skills/cmux-team/manager/{task.ts,conductor.ts,main.ts}` (3 files, +173/-3)

## Verdict: GO

## Summary

plan.md S1〜S5 は全て実装済みで、対象 3 ファイルに閉じている。`bunx tsc --noEmit` は clean、EventBus 直接使用ガードも 0 件。runtime 検査（`assignTask` 先頭）と起動時整合性チェック（`cmdStart`）の 2 段防御が期待どおりに配線され、violation surface は `initializeLayout` 後に `resetConductor(targetStatus: "broken", reason: "unique_violation")` で後追い broken 化されている。Critical 0 件・Major 0 件で GO 判定。

## Verification Performed

| 観点 | コマンド / Read | 結果 |
|------|----------------|------|
| 型エラー | `cd .worktrees/task-254-1776514256/skills/cmux-team/manager && bunx tsc --noEmit` | EXIT=0 / 出力 0 行 |
| EventBus ガード | `rg "bus\.(emit\|on)\b" skills/cmux-team/manager \| rg -v eventBus.ts` | 0 件（exit 1） |
| 変更範囲 | `git status --porcelain` | `task.ts / conductor.ts / main.ts` の 3 ファイルのみ |
| S1 grep | `rg -n "findAssignmentConflict\|detectStartupUniqueViolations\|UniqueViolation" task.ts` | 型 1 + 関数 2 が export |
| S2 grep | `rg -n "task_unique_violation_runtime\|findAssignmentConflict" conductor.ts` | import 1 + 使用 2 |
| S3 grep | `rg -n "task_unique_violation_startup\|detectStartupUniqueViolations\|violationSurfaces" main.ts` | import 1 + 検査 + 違反集約 ×2 |
| S4 配置 | `rg -n -B1 -A5 "violationSurfaces.size" main.ts` | `initializeLayout` 直後・`resumeAssignments` 反映前で確認 |

## Findings

### 1. 計画充足（Critical/None）
- S1 — `task.ts` に `UniqueViolation` 型、`findAssignmentConflict`、`detectStartupUniqueViolations` の 2 関数が追加済み（`task.ts:54-141`）。`conductorSlot` 未設定時は conflict=false（D8 / R3 遵守）。
- S2 — `assignTask` の `try {` 直後、`// --- 1. タスクファイル検索 ---` の前に検査が配置されている（`conductor.ts:269-286`）。worktree 作成前に失敗するため cleanup コストなし。違反は `AssignTaskError("task", ...)` で scanTasks 側の `e.kind === "task"` 分岐（`daemon.ts:2105`）に流れ、task は `aborted` + journal、Conductor は idle 維持となる。D4 遵守。
- S3 — `rawResumePlan` 構築ループ（`main.ts:630`）の直前に起動時チェックが配置されている（`main.ts:589-628`）。`existsSync(teamJsonPath)` で初回起動時の false positive 回避、violation 検出時は `taskState[v.taskId] = { ...prev, status: "ready", journal }` で in-memory 更新し `taskStateModified=true` を立てるため、既存の `saveTaskState` 経路で永続化される。D9 に従い try/catch で fail-open。
- S4 — `initializeLayout` 呼び出し（`main.ts:694`）の直後、`resumeAssignments` 反映ループ（`main.ts:716`）より前に `resetConductor(..., { targetStatus: "broken", reason: "unique_violation" })` を発行（`main.ts:704-713`）。`applyRestorePlan` が taskState(=ready) を見て idle に倒すケースを後段で明示上書きする順序となっている。
- S5 — S3 の taskState 書換により rawResumePlan 構築ループは自動的に violation taskId をスキップ。`Object.entries(taskState)` が更新後の参照を見ることを Read で確認（`main.ts:630` 以降）。

### 2. Dead/Zombie Code（None）
- 新規 import（`findAssignmentConflict`, `detectStartupUniqueViolations`, `resetConductor`）は全て使用されている。
- 未使用変数なし。`taskStateModified` は既存変数の再利用（D5 / plan §S3 メソッド制約遵守）。

### 3. テスト（None）
- プロジェクト方針「自動テストなし」に準拠。
- plan §5.3 に手動 E2E シナリオ T1（runtime 検査）、T2（起動時検査）、T3（false positive 無し）、T4（legacy conductorSlot 未設定）が再現手順 + 期待ログ付きで明記され、impl-report §Completed / §Issues に「S6 未実施（オーナー側で実施する前提）」と明記済み。検品時点で新規ブロッキングなし。

### 4. 設計原則（None）
- `findAssignmentConflict`（単一 taskId 対象・runtime）と `detectStartupUniqueViolations`（全タスク走査 + cross-check・起動時）は責務が明確に分離されており、重複なし。D7 に従いログイベント名も `_runtime` / `_startup` で発生経路を区別。
- `resetConductor(targetStatus: "broken", reason: "unique_violation")` により `conductor_broken` ログの集約発行が一元化されている（D12 遵守）。個別の状態書換・ログを書かず resetConductor に委ねている点が適切。

### 5. 統合（None）
- `findAssignmentConflict` は `conductor.ts:9` で import、`conductor.ts:276` で呼び出し。
- `detectStartupUniqueViolations` は `main.ts:43` で import、`main.ts:607` で呼び出し。
- `resetConductor` は `main.ts:40` から import（既存 `launchConductor` 行に合流）、`main.ts:708` で `targetStatus:"broken", reason:"unique_violation"` 指定で呼び出し。
- 実行順 `S3 taskState 書換` → `initializeLayout` → `applyRestorePlan`（内部） → `S4 resetConductor broken` の順序を Read で確認。

### 6. 型エラーゼロ化（None, Critical観点 pass）
- touched files（`task.ts`, `conductor.ts`, `main.ts`）の `bunx tsc --noEmit` 出力 0 行。
- 既存型エラーも 0（impl-report §6.1 と一致）。

### 7. EventBus ガード（None）
- `rg "bus\.(emit|on)\b" skills/cmux-team/manager | rg -v eventBus.ts` → 0 件。S3/S4 の新規コードは `notifyStateChanged` を直接呼ばず、`resetConductor` 内の既存 `notifyStateChanged` 経由で state 変化通知される。

### 8. T254 特有の追加確認（All pass）
- **実行順序**: S3（taskState 書換） → initializeLayout → applyRestorePlan → S4（resetConductor broken）の順で配線済み（`main.ts:596-628, 694, 704-713`）。
- **fail-open 妥当性**: S3 整合性チェック自身の例外は try/catch で `error` ログ + 続行。A015 の fail-stop は「本体起動パラメータの解決失敗」に対する方針で、本 check は不変条件の二重防御であり、失敗時は防御が効かないだけ。D9 に従っており妥当。
- **ログ命名**: `task_unique_violation_runtime`（conductor.ts）/ `task_unique_violation_startup`（main.ts）/ `conductor_broken ... reason=unique_violation`（resetConductor 経由）の 3 系統が意図どおり分離。
- **AssignTaskError.kind**: runtime 検査で `"task"`（Conductor 維持）を使用（`conductor.ts:283`）。D4 / task.md 要件どおり。
- **conductorSlot 未設定**: `findAssignmentConflict` は `if (!existing) return { conflict: false }`、`detectStartupUniqueViolations` は `if (!slot) continue`。legacy データで false positive を出さない。
- **cross-check の意味**: R3 指針どおり、team.json に conductorSlot surface が一切現れない「stale slot」は violation としない実装。

## Minor Observations（非ブロッキング）

1. **team.json parse 時の `any` キャスト（impl-report R5 部分適用に同意）**
   `main.ts:602` で `(c: any) => ({ surface: c.surface, taskId: c.taskId })` と any を通す。team.json は daemon 管理の外部 JSON（ランタイムで変更され得る）で schema 強制の実益が薄い。impl-report でも narrow 型への絞り込み（`Array<{ surface: string; taskId?: string }>`）で安全性を回復している旨記載済み。非ブロッキング。
2. **ログ内 surface 表記が生の `surface:NNN` 形式**
   `task_unique_violation_runtime` / `task_unique_violation_startup` の detail 内で `existing_surface=surface:NN` や `surfaces=[surface:NN,...]` と表記されている。CLAUDE.md T192 は一次主語 surface に `formatSurface(s, "C")` を推奨するが、plan §5.3 のテスト期待ログが同形式で指定されており、複数 surface の配列を `C[N]` でリスト化するパターンは既存ログにも少ない。現状の plan との整合と読解性優先で非ブロッキング。将来的に log format を統一する場合は plan §5.3 のテスト期待ログも追従更新が必要。
3. **`saveTaskState` 上書きリスクは既知制約として継続（impl-report Issues 記載済み）**
   `applyRestorePlan` 内部の save と `main.ts:taskStateModified` の save が同一トランザクションでない点は本タスクで悪化しないが、violation という稀 + initializeLayout と concurrent に他経路で task-state を書く確率がほぼ無いため既存リスクに留まる。本タスクでは対処せず、後続タスクで扱う余地のある既知 Minor。
4. **runtime 検査で `loadTaskState` の追加呼び出し**
   scanTasks の各 assign で `loadTaskState` が 1 回増える。task-state.json は atomic 読み + 小サイズで既存 conductor.ts で複数箇所から呼ばれているため実測影響なし（plan §5.1 risk）。

## GO 判定根拠

- Critical: 0
- Major: 0
- Minor: 4（いずれも plan / impl-report で既知または正当化済み、本タスクスコープ内で塞ぐべき blocker なし）

判定基準「Critical 0 件 AND Major 2 件以下」を満たすため **GO**。
