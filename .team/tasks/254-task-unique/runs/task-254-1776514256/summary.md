# T254 実行サマリー

- **Task ID**: 254
- **Title**: Task の二重起動を防ぐ unique 制約を不変条件として検査
- **Conductor**: task-254-1776514256 (surface:128)
- **Worktree**: `.worktrees/task-254-1776514256`
- **Branch**: `task-254-1776514256/task` (base: `main` @ 890e5c9)

## 完了したサブタスク

- Phase 1 Plan: Planner Agent が `plan.md` 作成（372 行、S1〜S6 サブタスク + Decision Log D1〜D10）
- Phase 2 Design Review: Design Reviewer が Approved、Minor findings 4 件に対する Recommendations R1〜R5 を Implementer に伝達
- Phase 3 Implementation: Implementer Agent が S1〜S5 を実装（S6 の手動 E2E は実環境でオーナー側実施）
- Phase 4 Inspection: Inspector Agent が GO 判定（Critical 0 / Major 0 / Minor 4 いずれも既知・正当化済み）

## 変更ファイル

| ファイル | 変更概要 | +/- |
|---------|---------|-----|
| `skills/cmux-team/manager/task.ts` | `UniqueViolation` 型、`findAssignmentConflict`、`detectStartupUniqueViolations` の 2 関数を追加 | +93 / -0 |
| `skills/cmux-team/manager/conductor.ts` | `assignTask` 先頭に runtime unique 検査。違反時は `AssignTaskError("task", "task_already_assigned_to=<surface>")` | +19 / -1 |
| `skills/cmux-team/manager/main.ts` | `cmdStart` に起動時整合性チェック。違反時は task を ready + journal、Conductor は `resetConductor(targetStatus: "broken", reason: "unique_violation")` で broken 化 | +62 / -1 |

合計 3 files, +174 / -2

## 実装の二段防御

1. **Runtime 検査**（`assignTask` 先頭）— scanTasks から呼ばれた時点で `loadTaskState` を再読込し、対象 taskId が別 Conductor に `assigned` でないかを検査。違反は `AssignTaskError("task", ...)` で既存エラーハンドラに流す（task abort + Conductor idle 維持）
2. **起動時整合性チェック**（`cmdStart` の `rawResumePlan` 構築前）— `task-state.json` × `team.json.conductors` を cross-check。違反 taskId は `ready` + journal 付与、違反 surface は `initializeLayout` 後に broken 化

## ログイベント命名

| イベント | 発生箇所 | 意味 |
|---------|---------|------|
| `task_unique_violation_runtime` | assignTask 内 | scanTasks の assign タイミングで検出 |
| `task_unique_violation_startup` | cmdStart 内 | daemon 再起動時に team.json ↔ task-state.json の食い違いを検出 |
| `conductor_broken reason=unique_violation` | resetConductor 経由 | 違反 surface の fail-stop ログ（D12 集約） |

## 検証

- `bunx tsc --noEmit`: EXIT=0（新規エラー 0）
- `rg "bus\.(emit|on)\b" skills/cmux-team/manager | rg -v eventBus.ts`: 0 件
- 変更ファイル: plan §3.1 指定の 3 個に閉じている
- 手動 E2E（plan §5.3 T1〜T4）: 実環境でオーナー側実施（スコープ外）

## スコープ外（別タスク）

- `main.ts:601` `resume_fallback_to_ready` の条件見直し（task.md 項目 2）— runtime 検査（S2）が安全網として機能するため本タスクでは扱わない
- atomic 書き込み（`saveTaskState`）— 既実装のため再実装しない
- `saveTaskState` 上書きリスク（既存 Minor、本タスクで悪化なし）

## アーティファクト

- `plan.md` — 実装計画（372 行）
- `design-review.md` — Design Reviewer の Approved レポート
- `impl-report.md` — Implementer のレポート（TDD/検証結果 + R1〜R5 適用状況）
- `inspection.md` — Inspector の GO 判定レポート
- `summary.md` — 本サマリー

## マージ方法

ローカルマージ（プロジェクト方針: タスク指示に PR 要求なし、変更規模は 3 ファイル）。
