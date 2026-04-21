# T290 実装レポート: Aborted 経路の journal/reason 表現統一

- 実施日: 2026-04-22
- 作業ブランチ: `task-290-1776804386/task`
- 作業ディレクトリ: `/Users/yamamoto/git/cmux-team/.worktrees/task-290-1776804386`
- Implementer: claude-opus-4-7

---

## 1. コミット履歴（Phase 別）

| # | SHA | Phase | 要約 |
|---|-----|-------|------|
| C1 | `7a90efd` | 1 | `task.ts` に `AbortReason` 型 / `markTaskAborted` / `parseAbortJournal` を追加。`task.test.ts` に新規 12 ケース（12 pass）。 |
| C2 | `361fb16` | 2.1 | `daemon.ts` の `assign_failed` 経路を `markTaskAborted` に置換。 |
| C3 | `303938a` | 2.2 | `daemon.ts` の `disconnect_timeout` 経路を置換。 |
| C4 | `f257bb6` | 2.3 | `daemon.ts` の `user_clear` 経路を置換。 |
| C5 | `a286cd8` | 2.4 | `daemon.ts` の `judgment_pending` 経路を置換。`daemon.test.ts` Case #9/#10 に `toMatch(/^reason=judgment_pending;/)` 構造 assert 追加。 |
| C6 | `7952f12` | 2.5 | `main.ts` の `cmdAbortTask` 2 分岐（conductor 無し / 通常）を `markTaskAborted` に置換。 |
| C7 | `2923de4` | 2.6 | `applyResumeTransitions` を純粋化（taskState mutate せず、`abortTargets[]` を返すだけ）。`cmdStart` の resume loop を `abortTargets` iterate + `markTaskAborted` に書き換え。`main.test.ts` 4 ケースを純粋 API 用に書き換え。 |
| C8 | `a1222a1` | 3 | `formatAbortedTaskLine(id, journal)` ヘルパーを `main.ts` に追加。`cmdAwaitTask` stderr 2 箇所 / `printSummaries` aborted 分岐を置換。 |
| extra | `e166817` | refactor | C1 直後の微リファクタ：`markTaskAborted` 内で journal template を function top に 1 const に統合（idempotent skip と active path で重複算出していたのを統合）。 |

計 **9 commits**（C1〜C8 + e166817）。全コミットメッセージ末尾に `(T290)` suffix あり。

---

## 2. Inspection Checklist §7 grep 結果

### (A) `markTaskAborted` 定義は 1 箇所のみ

```
$ rg -n "export (async )?function markTaskAborted" task.ts
467:export async function markTaskAborted(
```
→ ✅ 1 件（task.ts:467）

### (B) `parseAbortJournal` 定義は 1 箇所のみ

```
$ rg -n "^export function parseAbortJournal" task.ts
546:export function parseAbortJournal(journal: string | undefined): ParsedAbortJournal {
```
→ ✅ 1 件（task.ts:546）

### (C) `AbortReason` 型の使用

```
$ rg -n "AbortReason" task.ts main.ts daemon.ts
task.ts:413: * journal 新 format `reason=<AbortReason>; <detail>` の `<AbortReason>` に入る値。
task.ts:415:export type AbortReason =
task.ts:470:  reason: AbortReason,
task.ts:528:  reason?: AbortReason | string;
task.ts:556:  const legacyPrefixes: Array<[RegExp, AbortReason]> = [
```
→ ✅ 型定義 task.ts のみ。daemon.ts / main.ts には漏洩していない（reason は string literal で渡す）。

### (D) `journal = \`reason=${reason}; …\`` 書き出しは task.ts 内 1 箇所のみ

```
$ rg -n 'reason=\$\{reason\}' task.ts
479:  const journal = detail ? `reason=${reason}; ${detail}` : `reason=${reason};`;
506:  const parts: string[] = [`task_id=${taskId}`, `reason=${reason}`];  # ← log 出力行（journal ではない）
```
→ ✅ journal 組み立ては 1 箇所（task.ts:479）のみ。Design Reviewer C1 修正（`detail ? ... : \`reason=${reason};\``）も適用済み。

### (E) daemon.ts / main.ts に journal 組み立ての複製なし

```
$ rg -n 'const journal = `reason=' daemon.ts main.ts
（結果なし）
```
→ ✅ 0 件。すべて helper 経由。

### (F) `markTaskAborted(...)` 呼び出し箇所

```
$ rg -n "markTaskAborted\(" .
main.ts:311:   *  コメント（説明）
main.ts:852:    await markTaskAborted(PROJECT_ROOT, target.taskId, target.reason, target.detail);
main.ts:3491:    await markTaskAborted(PROJECT_ROOT, taskId, "abort_task", journal, { taskTitle: title });
main.ts:3517:  await markTaskAborted(PROJECT_ROOT, taskId, "abort_task", journal, { taskTitle: title });
daemon.ts:2258:            const { revertedChildren } = await markTaskAborted(...);  # user_clear
daemon.ts:2614:            const { revertedChildren } = await markTaskAborted(...);  # assign_failed
daemon.ts:3033:      const { revertedChildren } = await markTaskAborted(...);        # disconnect_timeout
daemon.ts:3127:      const { revertedChildren, idempotentSkip, existingStatus } = await markTaskAborted(...);  # judgment_pending
task.ts:467: （定義）
task.test.ts:* （テスト 12 箇所）
```

→ ✅ daemon.ts 4 箇所 + main.ts 3 箇所（cmdStart + cmdAbortTask ×2）= **計 7 箇所の callers**（定義・コメント・テスト除く）。すべての aborted 経路（assign_failed / disconnect_timeout / user_clear / judgment_pending / abort_task / resume_marked_aborted）を網羅。

### (G) legacy `journal: \`reason=...\`` 直書きは 0 件

```
$ rg -n 'journal: `reason=' daemon.ts main.ts
（結果なし）
```
→ ✅ 0 件。

### (H) hard-coded journal 文字列は T290 コメント以外なし

```
$ rg -n 'journal.*`reason=[a-z_]+;' daemon.ts main.ts
daemon.ts:3121:    // T290: markTaskAborted に集約。journal は `reason=judgment_pending;
```
→ ✅ マッチは T290 のリファクタ意図を書いたコメント 1 件のみ。実際の書き出しコードは 0 件。

### (I) `bun test` 全ケース pass

```
$ bun test --timeout 600000
 982 pass
 0 fail
 2340 expect() calls
Ran 982 tests across 35 files. [44.59s]
```
→ ✅ 982/982 pass。

### (J) `bunx tsc --noEmit` 新規エラー 0 件

```
$ bunx tsc --noEmit
conductor.ts(201,3): error TS1016: A required parameter cannot follow an optional parameter.
daemon.test.ts(3956,9): error TS2322: Type '"new_session"' is not assignable to type '"startup" | "resume" | "clear" | "compact" | undefined'.
daemon.ts(1597,22): error TS2352: Conversion of type 'string | undefined' to type ...
```

→ ✅ 残 3 件は **T290 と無関係な既存エラー**（main 上でも再現確認済み）。T290 により以下 2 件は**解消**：
- `daemon.test.ts(4854,21): Property 'abortedTaskIds' does not exist on type 'ApplyResumeTransitionsResult'`（C7 で新インターフェースに置換）
- `daemon.test.ts(4855,21): Property 'modified' does not exist on type 'ApplyResumeTransitionsResult'`（同上）

→ main: 5 件 → task-290: 3 件（**減少**。T290 新規エラー 0 件）。

### (K) T290 コメント・タグの参照点

```
$ rg -n "T290" skills/cmux-team/manager
task.ts:407,410,447,478,536   # ヘルパー定義近辺の意図コメント
main.ts:276,279,310,326,328,331,836,850,3322   # 新 helper と resume loop の意図コメント
main.test.ts:1372,1411,1436,1444  # テスト書き換え意図
daemon.test.ts:4469,4609  # judgment_pending structural assert の意図
```
→ ✅ 計 **22 箇所**に T290 trace あり（意図コメント + テスト意図）。

---

## 3. 設計 Recommendations の適用状況

| 項目 | 対応 |
|------|------|
| **C1 修正** — detail 空時も末尾 `;` を付与 | ✅ task.ts:479 `detail ? \`reason=${reason}; ${detail}\` : \`reason=${reason};\``。task.test.ts T2 の expect も `reason=abort_task;` に修正。`parseAbortJournal` regex は `/^reason=([a-z_]+);\s?(.*)$/s` を維持。 |
| **Option A 採用** — idempotent skip 時は `markTaskAborted` 内では log emit しない | ✅ closed/aborted/deleted 時は `{ revertedChildren: [], journal, idempotentSkip: true, existingStatus }` を返すのみ（log を emit しない）。呼び出し側（`handleConductorDone`）が `conductor_done_unresolved_skip` を従来通り emit（daemon.ts:3132 周辺）。 |

---

## 4. 補足: C7 の破壊的変更点

`applyResumeTransitions` の signature を **純粋関数（pure-ish）** に変更：

### Before（mutation & cascade 内包）
```ts
export async function applyResumeTransitions(
  projectRoot: string,
  taskState: TaskStateMap,
  log: Logger,
): Promise<{ resumePlan: ...; abortedTaskIds: string[]; modified: boolean }>
```
→ 副作用: `taskState` を mutate、`markTaskAborted` を内部で呼んで cascade 実行。

### After（純粋: taskState 不変、caller が markTaskAborted を呼ぶ）
```ts
export interface ApplyResumeTransitionsResult {
  resumePlan: Array<{ taskId; taskRunId; worktreePath; sessionId }>;
  abortTargets: Array<{
    taskId;
    reason: "resume_no_worktree" | "resume_no_session_id" | "resume_no_task_run_id";
    classifyReason: "no_worktree" | "no_session_id" | "no_task_run_id";
    detail;
  }>;
}
export function applyResumeTransitions(
  taskState: TaskStateMap,
  now?: string,
): ApplyResumeTransitionsResult
```
→ 副作用なし、decision のみ返す。caller（`cmdStart`）が `abortTargets` を iterate して `markTaskAborted` を呼ぶ（main.ts:848-855）。`taskState` は各 iteration 後に再 load して次 iteration で正しく参照。

**動機**: 既存 `cascadeAbortToChildren` が `markTaskAborted` 内部に集約されたため、外部から「decision」と「mutation」を分離する余地が生まれた。テスト容易性も向上（pure 部分を argumentless で単体 test 可能）。

---

## 5. 設計逸脱

**なし**。plan.md §5（Phase 1〜4）および design-review.md の Recommendations に 100% 従った。

---

## 6. 最終状態サマリ

- ✅ Phase 1〜4 全実装完了
- ✅ C1〜C8 + e166817 の計 9 commits
- ✅ 全コミットに `(T290)` suffix
- ✅ `bun test`: 982 pass / 0 fail
- ✅ `bunx tsc --noEmit`: T290 起因エラー 0（残 3 件は pre-existing）
- ✅ Inspection Checklist §7 (A〜K) 全 pass
- ✅ Design Reviewer Recommendations（C1 修正 + Option A）適用

以上で T290 実装完了。
