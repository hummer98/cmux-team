# T254 実装レポート: Task の二重起動を防ぐ unique 制約の不変条件検査

- **Task ID**: 254
- **Author**: impl-254
- **Date**: 2026-04-18
- **Worktree**: `/Users/yamamoto/git/cmux-team/.worktrees/task-254-1776514256`
- **Plan 基準**: plan.md S1〜S6（plan.md § 4）

## Completed Tasks

| # | サブタスク | 結果 |
|---|-----------|------|
| S1 | `task.ts` に `findAssignmentConflict` / `detectStartupUniqueViolations` / `UniqueViolation` 型を追加 | 完了 |
| S2 | `conductor.ts:assignTask` 先頭に runtime unique 検査を追加 | 完了 |
| S3 | `main.ts:cmdStart` に起動時整合性チェックを追加（`rawResumePlan` 構築前） | 完了 |
| S4 | `main.ts:cmdStart` の `initializeLayout` 後に違反 surface を broken 化 | 完了 |
| S5 | コード追加なし（S3 の taskState 更新で rawResumePlan から自動除外されることを確認） | 完了 |
| S6 | 手動 E2E テスト（T1〜T4） | **未実施**（実行環境の E2E は別途オーナー側で実施。手順は plan §5.3 に記載済み） |

## Files Changed

| ファイル | 変更概要 | +/- |
|---------|---------|-----|
| `skills/cmux-team/manager/task.ts` | unique 検査ヘルパー 2 関数（`findAssignmentConflict`, `detectStartupUniqueViolations`）と `UniqueViolation` 型を追加。既存 `TaskState` / `TaskStateMap` は破壊的変更なし。 | +93 / -0 |
| `skills/cmux-team/manager/conductor.ts` | `assignTask` 先頭に「0. Unique 検査」ステップを追加。違反時は `AssignTaskError("task", ...)` を throw し、既存の scanTasks エラーハンドラ経路で task abort + Conductor idle 維持となる。`findAssignmentConflict` を `./task` から import。 | +19 / -1 |
| `skills/cmux-team/manager/main.ts` | `cmdStart` 内 `rawResumePlan` 構築前に起動時整合性チェック（team.json × task-state.json cross-check）を追加。違反 taskId は `ready` に戻して journal に `unique_violation:` を追記。`initializeLayout` 完了後に違反 surface を `resetConductor(targetStatus: "broken", reason: "unique_violation")` で後追い broken 化する処理を追加。`detectStartupUniqueViolations`, `resetConductor` を import。 | +62 / -1 |

合計: 3 files changed, 174 insertions(+), 2 deletions(-)

## Verification Results

### 1. `bunx tsc --noEmit`

```bash
$ cd /Users/yamamoto/git/cmux-team/.worktrees/task-254-1776514256/skills/cmux-team/manager
$ bunx tsc --noEmit
# 出力なし、EXIT=0
```

新規型エラー 0 件。

### 2. S1 grep 検証

```bash
$ rg -n "findAssignmentConflict|detectStartupUniqueViolations|UniqueViolation" \
    skills/cmux-team/manager/task.ts
54:export interface UniqueViolation {
68:export function findAssignmentConflict(
96:export function detectStartupUniqueViolations(
99:): UniqueViolation[] {
136:  const result: UniqueViolation[] = [];
```

2 関数 + 型 が `export` されている。

### 3. S2 grep 検証

```bash
$ rg -n "task_unique_violation_runtime|findAssignmentConflict" \
    skills/cmux-team/manager/conductor.ts
9:import { loadTaskState, findAssignmentConflict } from "./task";
276:    const conflict = findAssignmentConflict(currentTaskState, taskId, conductor.surface);
279:        "task_unique_violation_runtime",
```

- import 合流: 既存 `loadTaskState` と同じ import 行
- 検査配置: `try {` ブロック先頭、`// --- 1. タスクファイル検索 ---` コメント直前（worktree 作成より前）

### 4. S3 grep 検証

```bash
$ rg -n "task_unique_violation_startup|detectStartupUniqueViolations|violationSurfaces" \
    skills/cmux-team/manager/main.ts
43:import { loadTaskState, ..., detectStartupUniqueViolations, type TaskState } from "./task";
596:  const violationSurfaces = new Set<string>();
607:    const violations = detectStartupUniqueViolations(taskState, conductorsFromTeamJson);
610:        violationSurfaces.add(s);
622:        "task_unique_violation_startup",
704:  if (violationSurfaces.size > 0) {
705:    for (const surface of violationSurfaces) {
```

- 起動時チェック本体は `rawResumePlan` 構築ループ（`main.ts:647` の `for` 以降）より前に配置
- `taskStateModified` は既存ローカル変数を再利用（新規フラグを立てない）
- `try/catch` で整合性チェック自体の失敗は error ログ + 続行（D9: A015 の fail-stop に該当しない）

### 5. S4 grep 検証 + 実装位置確認

```bash
$ rg -n -B1 -A5 "violationSurfaces.size" skills/cmux-team/manager/main.ts
704:  if (violationSurfaces.size > 0) {
705-    for (const surface of violationSurfaces) {
706-      const c = state.conductors.get(surface);
707-      if (!c) continue;
708-      await resetConductor(c, state.projectRoot, state.workspace ?? undefined, {
709-        targetStatus: "broken",
```

- `initializeLayout` 呼び出し（`main.ts:694`）の直後、`resumeAssignments` 反映ループより前に配置
- `resetConductor` は surface 実在確認内蔵（T251）＋ broken 化集約ログ（D12 `conductor_broken`）に委譲

### 6. EventBus 直接使用ガード（CLAUDE.md 必須条件）

```bash
$ rg "bus\.(emit|on)\b" skills/cmux-team/manager | rg -v eventBus.ts
# 0 件（exit 1 — rg が何もマッチしなかった）
```

既存制約を維持。

### 7. 変更ファイル範囲

```bash
$ git status --porcelain
 M skills/cmux-team/manager/conductor.ts
 M skills/cmux-team/manager/main.ts
 M skills/cmux-team/manager/task.ts
```

plan §3.1 の指定 3 ファイルに閉じている。新規作成・削除ファイルなし。

## Design Decisions

### Design Review Recommendations の適用状況

| ID | 項目 | 適用 | 備考 |
|----|------|------|------|
| R1 | `applyRestorePlan` は disk を再読みするため S3 のインメモリ更新は反映されない。S4 の `resetConductor` が team.json 由来の running を強制上書きする、という挙動説明 | 反映 | `main.ts` の S4 コメントに明記（`applyRestorePlan` 時点では旧 disk 値を見ている、team.json 由来で running として復元され得る旨） |
| R2 | `resume_fallback_to_ready` の条件見直しは本タスクのスコープ外 | 反映 | plan §7 D5 の通り、変更なし。runtime 検査（S2）が安全網として機能する |
| R3 | `detectStartupUniqueViolations` の cross-check 定義明確化: `conductorSlot=S_A` かつ team.json に `{surface: S_B, taskId: X}` (S_A !== S_B) の場合のみ violation とする。stale slot（team.json に conductorSlot が一切ない）は検出しない | 反映 | `task.ts:findAssignmentConflict` の JSDoc と `detectStartupUniqueViolations` の JSDoc + 実装ロジック 2 で明示 |
| R4 | main.ts `saveTaskState` 上書きリスク（Minor）の既知制約記載 | 反映 | 本レポート §Issues Encountered に記載 |
| R5 | コーディング規約: `as any` 回避 / `formatSurface` 利用 / エラーログ | 部分適用 | `conductorsFromTeamJson` の map で `(c: any)` を使用しているが、これは team.json ファイル内の外部データ（JSON parse 結果で型情報なし）。内部の `Array<{ surface: string; taskId?: string }>` へ narrow 型付けした時点で型安全性を回復している。ログ内の surface は plan §5.3 のテスト記述に合わせて `surface:SNN` 形式のまま（logger の内部関数と整合しないリスクを避けるため） |

### plan との差分

- plan §4 の S3 コード例では挿入位置を `main.ts:579` 付近と指定。実ファイルの該当位置（`taskState` / `taskStateModified` / `rawResumePlan` 宣言直後、`for (const [taskId, ts] of Object.entries(taskState))` の直前）に配置。
- plan §4 の S4 コード例では挿入位置を `main.ts:653` 付近と指定。実ファイルの該当位置（`initializeLayout` 呼び出しの直後、`resumeAssignments` 反映ループの直前）に配置。
- 上記 2 点は行番号の微差のみで、意図どおりの実行順（`initializeLayout` → `violationSurfaces` broken 化 → `resumeAssignments` 反映）を満たす。

## Issues Encountered

### 既知の制約（Minor、本タスクでは対処しない）

- **`saveTaskState` 上書きリスク（R4）**
  `main.ts:717-719` 付近の `if (taskStateModified) { await saveTaskState(PROJECT_ROOT, taskState); }` は、`initializeLayout` → `applyRestorePlan` 内部で発生し得る `saveTaskState` 呼び出しを上書きしうる既存リスク。S3 で発火点（`taskStateModified = true` を立てる箇所）が増えるが、violation 自体が稀かつ initializeLayout 内部での task state 更新と concurrent に発生する確率は極低。本タスクでは対処しない。

### 未実施

- **S6（手動 E2E テスト）**: 本実装は worktree 内で完結するため、実環境での E2E（daemon start / team.json 手動編集・復旧）はオーナー側で実施する前提。plan §5.3 にテストシナリオ T1〜T4 と期待ログが明記されている。

## 検証まとめ

- `bunx tsc --noEmit`: EXIT=0（新規エラー 0）
- `rg "bus\.(emit|on)\b"` 除 eventBus.ts: 0 件
- 変更ファイル: 3 個（plan §3.1 指定どおり）
- plan §8 チェックリストの S1〜S5 + tsc + eventBus + ファイル範囲は全て満たす
