# T290 Summary — Aborted 経路の journal/reason 表現統一

- Task ID: T290
- Branch: `task-290-1776804386/task`
- Base: main (c9b8bc1)
- 実施日: 2026-04-22
- Verdict: **GO**（Inspector 独立検品で Critical/Fix Required なし）

## 目的

abort 経路 6 種（user_clear / judgment_pending / assign_failed / disconnect_timeout / abort_task CLI / resume_marked_aborted）で journal / log reason の表現がバラバラだった問題を解消。`markTaskAborted(projectRoot, taskId, reason, detail)` ヘルパーに集約し、await-task / show-task の出力で reason が先頭に明示される構造へ。

## 実装結果（9 commits）

| SHA | Phase | 要約 |
|---|---|---|
| `7a90efd` | 1 | `task.ts` に `AbortReason` 型 / `markTaskAborted` / `parseAbortJournal` 追加 + task.test.ts 12 ケース |
| `361fb16` | 2.1 | daemon.ts assign_failed を markTaskAborted に置換 |
| `303938a` | 2.2 | daemon.ts disconnect_timeout を置換 |
| `f257bb6` | 2.3 | daemon.ts user_clear を置換 |
| `a286cd8` | 2.4 | daemon.ts judgment_pending を置換 + `toMatch(/^reason=judgment_pending;/)` 構造 assert |
| `7952f12` | 2.5 | main.ts abort-task CLI 2 branches を置換 |
| `2923de4` | 2.6 | applyResumeTransitions 純粋化 + cmdStart resume loop 書き換え + main.test.ts 4 ケース書き直し |
| `a1222a1` | 3 | formatAbortedTaskLine + await-task / printSummaries で reason 先頭表示 |
| `e166817` | refactor | markTaskAborted の journal template を 1 const に統合 |

## 成果

- status: "aborted" 直代入: **6 箇所 → 1 箇所**（task.ts 内のみ）
- log("task_aborted") 呼び出し: **7 箇所 → 1 箇所**
- cascadeAbortToChildren caller: **8 箇所 → 2 箇所**（markTaskAborted 内 + delete-task のみ）
- journal on-disk 形式: `reason=<reason>; <detail>` の prefix string（案 A 採用、migration 不要）
- T269 型乖離（reason/journal 不一致）は markTaskAborted 内で同一引数を使う構造で**再発不能**

## テスト結果

- bun test: **982 pass / 0 fail**（Inspector 独立再現済み）
- bunx tsc --noEmit: **T290 起因の新規エラー 0 件**（残 3 件は main 由来の pre-existing）

## 設計判断

- **D1**: journal シリアライズ = 案 A（prefix string）。案 B/C より grep 可能性・構造整合に優れる
- **D2**: markTaskAborted のシグネチャ確定。冪等 skip（closed/aborted/deleted）を helper 内で担保
- **D3**: 後方互換 parser `parseAbortJournal`。旧 format 6 prefix を best-effort 推定、未知は reason=undefined
- **D4**: `formatAbortedTaskLine(id, journal)` で await-task / printSummaries の reason 先頭表示
- **D5**: applyResumeTransitions を純粋関数化（破壊的変更、main.test.ts 4 ケース書き直し）

## Design Reviewer Recommendations の適用

- **C1**: markTaskAborted writer が detail 空時も末尾 `;` を付与 → 適用済み（task.ts:479）
- **Option A**: markTaskAborted 内 idempotent skip 時に task_aborted log を emit しない（caller 側で既存ログを維持） → 適用済み

## 参照ドキュメント（worktree 内）

- plan.md — Planner 計画書（668 行）
- design-review.md — Design Review（17,917 B）
- impl-report.md — Implementer レポート（9,754 B）
- inspection.md — Inspector 検品（8,959 B）

## 納品

- ローカルマージ（ff-only）で main に統合
- worktree: `.worktrees/task-290-1776804386` を削除
- branch: `task-290-1776804386/task` を削除

## Minor observations（GO 後の追補候補、非 blocker）

1. await-task stderr フォーマットが plan の例示（`Task N was aborted: [reason] detail`）と実装（`Task N aborted [reason]: detail`）で微妙に異なる。要件は達成
2. plan §7.2 D の grep パターンは template literal にマッチしないため、実装の検証は `rg 'reason=\$\{reason\}'` 相当が正確
3. impl-report §2(J) の tsc 件数は「main 5→3」記載だが Inspector 再現では「main 3→3」で新規 0。不変条件は満たす
