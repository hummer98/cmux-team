# Design Review — T264 plan v1

## Verdict: Changes Requested

## Summary

根本対策としての aborted 遷移化・journal による成果物ポインタ保存・`restartFromAborted` への委譲という骨子は妥当で、既存の `aborted` + `abortedAt` + `journal` 3 点セットパターンにも乗れている。一方で、**既存の aborted 化経路（user_clear / disconnect_timeout / assign_failed / cmdAbortTask）が全て実施している 2 要素**、すなわち `task_aborted` ログの emit と `cascadeAbortToChildren` 呼び出しが T264 plan では両方とも欠落している。これは観測性（TUI / `status` / trace）と依存タスク整合性の不変条件を崩すため、plan の修正が必要。

## Findings

### 1. `task_aborted` ログが emit されない — **critical**

既存コードでの aborted 化パスは以下 4 箇所、全て `task_aborted` ログを emit する:

| 経路 | 場所 | ログ |
|------|------|------|
| user_clear | `daemon.ts:2136` | `task_aborted task_id=X reason=user_clear` |
| disconnect_timeout | `daemon.ts:2685-2688` | `task_aborted task_id=X reason=disconnect_timeout ...` |
| assign_failed | `daemon.ts:2314-2317` | `task_aborted task_id=X reason=assign_failed ...` |
| cmdAbortTask | `main.ts:3225` / `main.ts:3266` | `task_aborted task_id=X reason=abort_task ...` |

T264 plan（S3）は `resume_marked_aborted` のみを emit し、`task_aborted` を書かない。これにより:

- `status` コマンドや dashboard の「完了/中止タスク一覧」の集計が漏れる
- 監査ログで「aborted になった理由」を `rg task_aborted` で一括検索できなくなる
- D5 の命名論理（`resume_` prefix で起動時経路を明示）は妥当だが、**既存 `task_aborted` を置換するのではなく両方 emit** するのが既存慣習。`task_unique_violation_startup` + ready 化の既存二段構えと同じ発想。

### 2. `cascadeAbortToChildren` が呼ばれない — **critical**

CLAUDE.md「依存タスクの cascade（T241）」は `cascade は以下 5 経路で同期的に走る` と明記。
既存 4 経路（abort-task CLI / delete-task CLI / forced close / user_clear / assign_failed）は全て `cascadeAbortToChildren` を呼び `child_reverted_to_draft` を emit する。

T264 plan は D2 で「cmdStart 起動フェーズでは子タスクの状態評価がまだ開始していない」として cascade 省略を選んでいるが:

- `task-state.json` には全タスクの状態がロード済みで、ready 子の検出は可能
- 「assigned 親 → 子は draft のまま」の不変条件は **scanTasks が維持する事後整合** であって、起動前の手動編集・過去バグ残骸・外部ツール操作で ready 子が残っている可能性はゼロでない
- cascade は冪等で副作用もなく、呼ばない理由がない

**既存の cascade 不変条件を崩すより、6 経路目として足す方が設計上クリーン。**

### 3. 統合テストで `task_aborted` emit / cascade 発動を検証しない — **major**

S4 は `classifyResumeAction` / `buildResumeAbortJournal` の pure helper テスト、S5 は `applyResumeTransitions(taskState, findTaskFile, now, existsSync)` の薄い wrapper を export して state 変換だけ検証する。

Findings 1/2 を plan に取り込むと、wrapper では `task_aborted` emit と `cascadeAbortToChildren` 起動の副作用まで検証する必要が出てくる。現状の S5 設計（純粋な state 変換 wrapper）では組み立てミス（emit 漏れ・cascade 漏れ）を検知できない。

### 4. 既存テスト影響（S6）の grep 手順が未明文化 — **major**

CRITICAL チェック項目「既存の `resume_fallback_to_ready` 参照テストが無いか grep」が plan に明示されていない。本レビュー時点で `rg resume_fallback_to_ready skills/cmux-team/manager/*.test.ts` = 0 件（.test.ts ファイルからは参照なし、`task.ts:94` のコメントが唯一のランタイム参照）を確認済みだが、plan 側にこの事実記録がないため、実装者が S7 のコメント修正とテスト削除を混同する可能性が残る。

### 5. 新規 reason `no_task_run_id` の互換性注意書きなし — **minor**

旧コードは `sessionId` 判定のみ分岐し、`taskRunId` 欠損は `reason=no_worktree` として報告されていた（`!ts.sessionId ? "no_session_id" : "no_worktree"` の二分岐）。

plan は 3 reason（`no_session_id` / `no_task_run_id` / `no_worktree`）に拡張する。改善ではあるが、grep チートシート / runbook / ダッシュボード集計側に新 reason を反映する必要がある旨を plan に追記すべき（ログ消費者側の改修範囲が拡がる情報）。

### 6. pure helper の配置先 — **minor**

D7 で `resume-classify.ts` 新規ファイルを選択しているが、同種の pure helper である `detectStartupUniqueViolations` は **`task.ts` 内**に同居している（`task.ts:96-`）。ファイル数を増やすより `task.ts` 末尾に追加する方が既存配置慣習と揃う。既存 `task.ts` の責務（状態管理・分類関数）とも整合する。

## Recommendations

### R1. S3 を以下の形に置き換える（Finding 1 + 2）

```ts
// resume 不可 → aborted 化
const taskFile = await findTaskFile(taskId);
const journal = buildResumeAbortJournal(taskId, taskFile, ts, action.reason);
const now = new Date().toISOString();
taskState[taskId] = {
  ...ts,
  status: "aborted",
  abortedAt: now,
  journal,
};
taskStateModified = true;

// cascade: 既存の aborted 化パスと整合
const { revertedChildren } = cascadeAbortToChildren(taskState, allTasks, taskId);
// ↑ allTasks は 702 行以前で既に loadTasks 済みか要確認。無ければ本ループ前で 1 回だけ呼ぶ

await log(
  "resume_marked_aborted",
  `task_id=${taskId} reason=${action.reason} ...`,
);
await log(
  "task_aborted",
  `task_id=${taskId} reason=${action.reason} journal_summary=${journal}`,
);
for (const childId of revertedChildren) {
  await log(
    "child_reverted_to_draft",
    `parent=${taskId} child=${childId} reason=parent_aborted`,
  );
}
```

- `allTasks` のロードは本ループ前に 1 回だけ（`await loadTasks(PROJECT_ROOT)`）で十分。既に `cmdStart` 内に存在すれば流用する
- Decision Log D2 を「呼ぶ」に書き換え、根拠を「cascade 不変条件（CLAUDE.md §依存タスクの cascade）の維持」に変更

### R2. S5 の wrapper を以下に拡張（Finding 3）

`applyResumeTransitions` の返り値か副作用で以下を検証できるようにする:
- `ts[taskId].status === "aborted"`, `abortedAt`, `journal` 期待文字列
- logger モックで `task_aborted` と `resume_marked_aborted` の 2 イベントが順に emit されること
- `cascadeAbortToChildren` 相当の副作用として、ready 子タスクが draft に戻ること（テストデータに親 → ready 子を仕込む）
- ログ emit 検証が重い場合、最低限 `revertedChildren.length` を wrapper の戻り値に含めて検証する

### R3. S6 に grep 手順を追加（Finding 4）

S6 直下に以下を明記:

```
検証コマンド（実装前後で実行）:
  rg 'resume_fallback_to_ready' skills/cmux-team/manager/*.test.ts
  # → 0 件のまま（本 PR 前後で変化なし）
  rg 'resume_marked_aborted' skills/cmux-team/manager/
  # → 実装 + テスト側で複数件
  rg 'task_aborted' skills/cmux-team/manager/*.test.ts
  # → R1/R2 対応で新規 1 件以上の参照が増える
```

### R4. 新 reason の波及箇所を S7 に追加（Finding 5）

S7 ドキュメント同期に以下を追加:
- CLAUDE.md の「エラーリカバリ」or 既知 reason 一覧に `resume_marked_aborted` の 3 reason を追記（必要に応じて）
- 運用 runbook / grep チートシートがあれば更新

### R5. pure helper を `task.ts` に置く（Finding 6、optional）

`resume-classify.ts` 新規作成をやめ、`task.ts` に `classifyResumeAction` / `buildResumeAbortJournal` を追加する案を検討。 D7 の再考を含めて plan に追記。採否は Planner 判断で可（最終的にビルド・テストが通れば許容できる軽微な案）。

---

CRITICAL チェック項目に対する本レビュー時点での確認結果:

- サブタスクカバレッジ: OK（S1-S7 網羅）
- 既存テスト影響: NG（grep 手順未明文化）— R3 で解消
- 削除タスク: OK（S3 注意1・S7 明示）
- `sessionId` 欠損ケース: OK（D3 + S4 ケース 1）
- `resume_overflow_to_ready` の扱い: OK（D1 明示・S3 注意3）

R1〜R4 を取り込めば Approved 相当になる見込み。
