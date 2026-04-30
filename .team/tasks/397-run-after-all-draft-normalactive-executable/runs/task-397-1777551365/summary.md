# T397 完了サマリー

## タスク
run_after_all が draft 経由で間接デッドロックする問題を、`filterRunAfterAllTasks` の `normalActive` を executable ベース（`assigned OR (ready AND deps 全 closed)`）に修正する。

## 完了したサブタスク
- Phase 1: Planner Agent (surface:503) で plan.md を作成
- Phase 3: Implementer Agent (surface:504) で TDD 実装（task.ts 修正 + テスト 7 件追加）
- Phase 4: Inspector Agent (surface:505) で検品 → GO（minor 指摘なし）

## 変更ファイル一覧

| ファイル | 変更 |
|---|---|
| `skills/cmux-team/manager/task.ts` | docstring 更新（468-479）/ inline コメント更新（498-500）/ `normalActive` フィルタを executable ベースに修正（501-508） |
| `skills/cmux-team/manager/task.test.ts` | `filterRunAfterAllTasks` を import 追加、新規 `describe("filterRunAfterAllTasks", …)` ブロックに 7 ケース（T1-T7）追加 |

## 修正の要点

`normalActive` フィルタ:
```ts
// 修正前
(t.status === "ready" || assignedIds.has(t.id))
// 修正後
(
  assignedIds.has(t.id) ||
  (t.status === "ready" && t.dependsOn.every(d => closedIds.has(d)))
)
```

これにより、`ready` だが `depends_on` の依存先が `draft` のタスクが `run_after_all` を間接ロックする問題を解消。

## テスト結果

```
$ cd skills/cmux-team/manager && bun test --timeout 30000 task.test.ts daemon.test.ts
 294 pass
 0 fail
 874 expect() calls
Ran 294 tests across 2 files. [24.87s]

$ bunx tsc --noEmit
（exit=0、エラーなし）
```

- 新規テスト T1-T7 全て pass
- 既存テスト regression なし（既存 287 件 + 新規 7 件 = 294/294 pass）
- TypeScript 型エラーなし

## 完了条件チェックリスト

- [x] `filterRunAfterAllTasks` の `normalActive` フィルタを executable ベースに修正
- [x] 新規テスト T1: ready で dep が draft のタスクが存在しても run_after_all が発火する
- [x] 既存挙動 regression T2: ready で dep が解決済みのタスクは run_after_all をブロックする
- [x] 既存挙動 regression T3: assigned タスクは run_after_all をブロックする
- [x] `cd skills/cmux-team/manager && bun test --timeout 30000 task.test.ts daemon.test.ts` が green
- [x] `bunx tsc --noEmit` が green

## マージコミット

- branch: `task-397-1777551365/task`
- commit: `e198827` `fix(task): run_after_all が draft 経由で間接デッドロックする問題を解消 (T397)`
- merged into: `main` (ff-only)
- merge sha: `e1988277327b0623e7baa95aeb650affaa54ee13`
