# T264 Implementation Report

`resume_fallback_to_ready` を `resume_marked_aborted` (+ `task_aborted reason=resume_*` + cascade) に置き換えた。

## Completed Tasks

- **S1**: `classifyResumeAction` / `buildResumeAbortJournal` を `task.ts` に追加
- **S2**: `applyResumeTransitions` wrapper を `main.ts` に追加・export
- **S3**: `cmdStart` の resume ループを `applyResumeTransitions` 経由に置換
- **S4**: `task.ts` helper のユニットテスト 8 ケース追加
- **S5**: `applyResumeTransitions` 統合テスト 4 ケース追加
- **S6**: 既存テスト regression なし + grep 5 種一致
- **S7**: ドキュメント同期（task.ts コメント + CLAUDE.md cascade 5→6 経路 + resume 不可検出節）

## Files Changed

| ファイル | 変更概要 |
|---------|---------|
| `skills/cmux-team/manager/task.ts` | `dirname` / `basename` import 追加、`ResumeClassification` 型 + `classifyResumeAction` + `buildResumeAbortJournal` を `detectStartupUniqueViolations` の直後に export、既存コメント `resume_fallback_to_ready` → `resume_marked_aborted` に更新 |
| `skills/cmux-team/manager/main.ts` | `./task` からの import に `classifyResumeAction` / `buildResumeAbortJournal` / `TaskMeta` 追加、`ApplyResumeTransitionsDeps` / `ApplyResumeTransitionsResult` 型 + `applyResumeTransitions` wrapper を `cmdStart` 直前に export、`cmdStart` 内 resume ループ (702-726) を wrapper 経由に置換 (`loadTasks(PROJECT_ROOT)` を resume ループ直前で 1 回呼び `allTasksForResume` 取得 → `applyResumeTransitions` → 戻り値消費で `resume_marked_aborted` → `task_aborted reason=resume_*` → `child_reverted_to_draft` を順次 emit)。旧ログキー `resume_fallback_to_ready` は完全撤去 |
| `skills/cmux-team/manager/task.test.ts` | `describe("resume classify/journal (T264)")` 追加、`classifyResumeAction` 5 ケース + `buildResumeAbortJournal` 3 ケース = 8 ケース |
| `skills/cmux-team/manager/main.test.ts` | `applyResumeTransitions` import 追加、`describe("T264: applyResumeTransitions (cmdStart resume)")` 追加、(a) resume / (b) aborted+journal / (c) cascade / (d) ready 無影響 = 4 ケース。Finding 1 対応で minimal `TaskMeta` factory (`makeMeta`) を定義 |
| `CLAUDE.md` | cascade 節を 5 → 6 経路に更新、新 6 番目として `resume_marked_aborted (cmdStart 起動時、assigned タスクの resume 不可検出 — T264)` 追記、「起動時 resume 不可検出（T264）」節を新設し 3 reason 表 (`no_session_id` / `no_task_run_id` / `no_worktree`) + 対応する `task_aborted` reason を明示 |

### 新規作成・削除ファイル

なし（plan R5 採用により `resume-classify.ts` は作成せず `task.ts` に同居）。

## TDD Cycles / Verification Results

各サブタスクは「コード追加 → tsc → bun test」の小サイクルで進めた（純粋関数 + 戻り値検証で RED/GREEN/REFACTOR を同時進行）。

### S1: task.ts helper 追加

- **GREEN**: `bunx tsc --noEmit` → pre-existing 2 件のみ（`conductor.ts:197` / `daemon.test.ts:3650`、T264 対象外）、新規エラー 0
- **REFACTOR**: 既存 `existsSync` import を helper デフォルトに再利用、`dirname` / `basename` を既存 `join` と同 `path` import に統合

### S2: applyResumeTransitions wrapper 追加

- **GREEN**: `bunx tsc --noEmit` → 新規エラー 0
- **REFACTOR**: wrapper 自体は emit しない純粋寄り設計（R2 採用）。戻り値に `abortedTaskIds` / `abortReasons` / `journals` / `revertedChildrenByParent` を揃え呼び出し側が emit 順序を決める

### S3: cmdStart resume ループ置換

- **GREEN**:
  - `bunx tsc --noEmit` → 新規エラー 0
  - `bun test` → 608 pass (ベースライン維持)
  - `rg resume_fallback_to_ready skills/` → 0 件（完全撤去を確認）

### S4: task.ts helper ユニットテスト

- **RED → GREEN**: 8 ケース追加後 `bun test task.test.ts` → 35 pass 0 fail (既存 27 + 新規 8)
- テストケース:
  1. `classifyResumeAction`: sessionId 欠 → `no_session_id`
  2. taskRunId 欠 → `no_task_run_id`
  3. worktreePath 欠 → `no_worktree`
  4. worktreePath あり + exists=false → `no_worktree`
  5. 3 点揃い + exists=true → `resume`
  6. `buildResumeAbortJournal` ディレクトリ形式 → `[resume] lost worktree (taskRunId=task-262-1776560393). artifacts preserved at .team/tasks/262-conductor/runs/task-262-1776560393/`
  7. 単一ファイル形式 → `(runs dir not found — legacy flat task file)` を含む
  8. `taskFile=undefined` + `no_session_id` → `[resume] missing session id (taskRunId=unknown). artifacts preserved at .team/tasks/<unknown>/runs/unknown/`

### S5: applyResumeTransitions 統合テスト

- **RED → GREEN**: 4 ケース追加後 `bun test main.test.ts` → 103 pass 0 fail (既存 99 + 新規 4)
- 主要検証:
  - (a) 既存 resume path: `resumePlan` に push、`modified=false`
  - (b) worktree 不在: `abortedTaskIds=["1"]`、journal に `.team/tasks/1-foo/runs/task-1-123/`、`taskState["1"].status="aborted"`、`abortedAt="2026-04-19T12:00:00Z"`
  - (c) cascade: 親 "1" abort → `revertedChildrenByParent["1"]=["2"]`、`taskState["2"].status="draft"`、journal に `parent_aborted: 1`
  - (d) ready 無影響: `resumePlan=[]`, `abortedTaskIds=[]`, `modified=false`
- **Finding 1 対応**: `makeMeta()` factory で TaskMeta の全必須フィールドを minimal に生成

### S6: 全体検証 + grep 5 種

- `bun test` 全体: **620 pass / 0 fail / 1490 expect() calls** (ベースライン 608 → +12 の期待通り)
- `bunx tsc --noEmit`: pre-existing 2 件のみ、新規エラー 0

grep 結果（plan §6 全て期待値一致）:

| コマンド | 期待 | 結果 |
|---------|------|------|
| `rg 'resume_fallback_to_ready' *.test.ts` | 0 件 | 0 件 ✓ |
| `rg 'resume_fallback_to_ready' .` | 0 件 (skills/) | 0 件 ✓ |
| `rg 'resume_marked_aborted' .` | 複数件 | 3 件 (task.ts コメント + main.ts コメント + main.ts emit) ✓ |
| `rg 'task_aborted' *.test.ts` | 既存に言及あり | daemon.test.ts の既存 T261 テスト 7 件（新規 S5 は戻り値経路で間接検証） ✓ |
| `rg 'reason=resume_' .` | 実装側のみ | main.ts 1 件 (reason=${reason} を埋めた template literal) ✓ |

### S7: ドキュメント同期

- `task.ts:94` コメント: `resume_fallback_to_ready` → `resume_marked_aborted`（S1 で同時実施）
- `CLAUDE.md` §依存タスクの cascade: 「5 経路」→ 「6 経路」、6 番目に `resume_marked_aborted (T264)` を追加
- `CLAUDE.md` §エラーリカバリに「起動時 resume 不可検出（T264）」節を新設、3 reason 表と emit 順序を記載
- `A015-fallback-design-policy.md` は歴史的記録として更新せず（plan D10 方針）
- `rg 'resume_fallback_to_ready' skills/` → 0 件、`rg '6 経路で同期的' CLAUDE.md` → 1 件ヒット

## Issues Encountered

特になし。out-of-scope な既存型エラー 2 件（`conductor.ts(197,3)` / `daemon.test.ts(3650,9)`) は plan §6 の baseline と一致し、本 PR では触っていない。エラー行数は 2 のまま維持（完了条件を満たす）。
