# T264 Summary

`resume_fallback_to_ready` を `resume_marked_aborted` に置き換え、daemon 再起動時に `assigned` + worktree 不在のタスクを自動的に `aborted` へ遷移させるようにした。これにより Inspector GO 済み成果が自動破棄されるリグレッション（T262 事例）を防止する。

## Completed Sub-Tasks

| # | タスク | 状態 |
|---|--------|------|
| S1 | `classifyResumeAction` / `buildResumeAbortJournal` を `task.ts` に追加 | ✅ |
| S2 | `applyResumeTransitions` wrapper を `main.ts` に追加・export | ✅ |
| S3 | `cmdStart` resume ループを wrapper 経由に置換 + 3 段 emit | ✅ |
| S4 | `task.ts` helper のユニットテスト 8 ケース | ✅ |
| S5 | `applyResumeTransitions` 統合テスト 4 ケース | ✅ |
| S6 | grep 検証（`resume_fallback_to_ready` = 0 件） | ✅ |
| S7 | CLAUDE.md / `task.ts` コメント同期 | ✅ |

## Files Changed

| ファイル | 変更 |
|---------|------|
| `skills/cmux-team/manager/task.ts` | +65 行（helper 関数・型・コメント更新） |
| `skills/cmux-team/manager/main.ts` | +133 行、-21 行（wrapper + cmdStart 書き換え） |
| `skills/cmux-team/manager/task.test.ts` | +68 行（helper テスト 8 ケース） |
| `skills/cmux-team/manager/main.test.ts` | +109 行（wrapper テスト 4 ケース） |
| `CLAUDE.md` | +22 行（cascade 節・エラーリカバリ節更新） |

## Test Results

- `bun test` 全体: **620 pass / 0 fail / 1490 expect() calls**（ベースライン 608 + 新規 12）
- `bunx tsc --noEmit`（touched files）: **エラー 0 件**
- `rg 'resume_fallback_to_ready' skills/`: **0 件**（完全撤去）
- `rg 'resume_marked_aborted' skills/cmux-team/manager/`: 3 件（コメント 2 + emit 1）
- `rg 'child_reverted_to_draft' skills/cmux-team/manager/main.ts`: 5 件（cascade 6 経路目）

## Design Decisions

| ID | 決定 | 根拠 |
|----|------|------|
| D1 | slot 超過（`resume_overflow_to_ready`）は本 PR で触らない | 成果物喪失リスクがなく、意図的な差し戻し経路のため |
| D2 | `cascadeAbortToChildren` を呼ぶ（5→6 経路化） | T241 の cascade 不変条件を維持。D/R 独立レビューで critical 指摘 |
| D7 | helper は `resume-classify.ts` 新規作成せず `task.ts` に同居 | 既存の `detectStartupUniqueViolations` と同じ責務域、ファイル増加を避ける |
| D11-D12 | emit 順序: `resume_marked_aborted` → `task_aborted` → `child_reverted_to_draft` | 既存 aborted 化パス（user_clear / disconnect_timeout / assign_failed / cmdAbortTask）と整合 |

## Review History

- Plan v1: Changes Requested（critical 2 件: `task_aborted` emit 欠落、cascade 省略）
- Plan v2: **Approved**（R1-R5 全取り込み、新 critical なし）
- Inspection: **GO**（Critical 0 / Major 0 / Minor 1 件、plan で許容済）

## Merge Target

`main` — ローカルマージ（小規模バグ修正・テスト追加のためレビュー不要）

## 残課題・注記

- T264 は T263 の修正（`ee698d6`）に依存するが、`origin/main` に T263 がまだ push されていないため、ローカル `main` から worktree を切って作業した（`head-fallback` 経路）。
- task-state.json 上の T264 は Conductor 開始前の誤作動で `aborted` 状態のまま。close-task 時に closed に更新される想定。
- 手動検証（cmdStart 本体の emit 順序 E2E）は plan で許容済み、将来 cmdStart テストが整備された段階で補完可能。
