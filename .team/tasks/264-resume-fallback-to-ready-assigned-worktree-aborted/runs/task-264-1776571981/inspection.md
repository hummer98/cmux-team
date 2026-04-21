# T264 Inspection

## Verdict: GO

## Summary

S1〜S7 全て実装済み、plan.md §4 の全サブタスクが対象 5 ファイル（`task.ts` / `task.test.ts` / `main.ts` / `main.test.ts` / `CLAUDE.md`）に反映されている。`bun test` は 620 pass / 0 fail、touched files の tsc エラー 0、pre-existing 2 件（`conductor.ts:197` / `daemon.test.ts:3650`）は本 PR 対象外でそのまま維持。旧ログキー `resume_fallback_to_ready` は skills/ から完全撤去、新しい 3 段 emit (`resume_marked_aborted` → `task_aborted reason=resume_*` → `child_reverted_to_draft`) が cmdStart 側で正しい順序で実装されている。Critical / Major 0 件、Minor のみ。

## Findings

### 1. 計画充足 — pass (no finding)

`git diff --name-only` で plan.md §3「変更するファイル」で指定した 5 ファイル全てが変更されている:

- `CLAUDE.md`（+22）
- `skills/cmux-team/manager/main.test.ts`（+109）
- `skills/cmux-team/manager/main.ts`（+133, -21 相当）
- `skills/cmux-team/manager/task.test.ts`（+68）
- `skills/cmux-team/manager/task.ts`（+65）

S1〜S7 の必要変更（helper 追加・wrapper 切り出し・cmdStart 置換・helper テスト・wrapper テスト・grep 検証・CLAUDE.md 同期）は全て含まれている。

### 2. Dead/Zombie Code — pass (no finding)

- `rg 'resume_fallback_to_ready' skills/` → 0 件（完全撤去）
- 旧 `status="ready"` への差し戻しコードは resume 経路から削除済み（`main.ts:793-819` 周辺は wrapper + aborted 化に置換済み）
- `resume_overflow_to_ready` は plan §5 D1 通り変更なし（slot 超過は成果物喪失リスクがないため触らない方針）

### 3. テスト — pass (no finding)

- `bun test` 全体: **620 pass / 0 fail / 1490 expect() calls**（期待値 620 pass と一致）
- S4 helper テスト（`task.test.ts`）: `classifyResumeAction` 5 ケース + `buildResumeAbortJournal` 3 ケース = 8 ケース確認
- S5 wrapper テスト（`main.test.ts`）: `describe("T264: applyResumeTransitions (cmdStart resume)")` に 4 ケース（(a) resume / (b) aborted+journal / (c) cascade / (d) ready 無影響）確認

### 4. 設計原則 — pass (no finding)

- **R1/R2 取り込み**: `main.ts:800-819` の for ループで `resume_marked_aborted` → `task_aborted` → `child_reverted_to_draft` の順で `await log()` が発行されている（D12 の期待順序と一致）
- **R5 採用**: `skills/cmux-team/manager/resume-classify.ts` は存在しない。`classifyResumeAction` / `buildResumeAbortJournal` は `task.ts:143-213` 付近に `detectStartupUniqueViolations` の直後へ同居配置されており、plan D7 改訂に沿う

### 5. 統合 — pass (no finding)

- cmdStart 側の resume ループは `applyResumeTransitions` wrapper 経由（`main.ts:794`）
- `loadTasks(PROJECT_ROOT)` は resume ループ直前で呼ばれ `allTasksForResume` として wrapper に渡されている（`main.ts:791-796`）
- cascade 結果 `revertedChildrenByParent` を消費して `child_reverted_to_draft` を emit（`main.ts:812-818`）

### 6. 型エラーゼロ化 — pass (no finding)

- TOUCHED files（`main.ts` / `main.test.ts` / `task.ts` / `task.test.ts`）に対する tsc エラー 0 件
- 残存する pre-existing エラー 2 件（`conductor.ts(197,3)` / `daemon.test.ts(3650,9)`）は TOUCHED 外で impl.md §Issues Encountered の申告通り

### 7. grep 検証（plan §6） — pass (no finding)

| コマンド | 期待 | 実測 |
|---------|------|------|
| `rg 'resume_fallback_to_ready' skills/` | 0 件 | 0 件 ✓ |
| `rg 'resume_marked_aborted' skills/cmux-team/manager/` | 複数件 | 3 件（task.ts コメント + main.ts コメント + main.ts emit） ✓ |
| `rg 'child_reverted_to_draft' skills/cmux-team/manager/main.ts` | >= 1 件 | 5 件（コメント 1 + emit 4） ✓ |
| `rg 'reason=resume_' skills/` | main.ts のみ | main.ts に 1 件 ✓ |

### 8. ドキュメント同期（S7） — pass (no finding / minor note)

- CLAUDE.md §依存タスクの cascade: 「5 経路」→「6 経路」に更新済み、6 番目に `resume_marked_aborted (T264)` 追記
- CLAUDE.md §エラーリカバリ直下に「起動時 resume 不可検出（T264）」節が追加され、3 reason と対応する `task_aborted` reason が明示
- `task.ts:94` コメント: `resume_fallback_to_ready` → `resume_marked_aborted` 更新済み

### 9. (minor) S5 テストは戻り値経路検証で間接的に emit 順序を担保 — minor

design-review-v2 Finding 3 と同じ指摘。`applyResumeTransitions` 戻り値 (`abortedTaskIds` / `abortReasons` / `journals` / `revertedChildrenByParent`) の整合性は S5 で検証済みだが、cmdStart 呼び出し側の emit 順序自体は自動テストされていない。plan §5 で「手動検証」と割り切られており、本 PR では許容。将来 cmdStart のテストが整備された段階で補完可能。

## 判定

- **Critical**: 0 件
- **Major**: 0 件
- **Minor**: 1 件（Finding 9。plan で許容済み）

判定基準「Critical 0 件 AND Major 2 件以下」を満たすため **GO**。
