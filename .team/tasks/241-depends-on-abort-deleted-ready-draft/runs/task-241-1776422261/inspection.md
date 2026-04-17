# T241 Inspection Report

## Verdict: GO

## Summary

T241 実装は仕様・plan・design-review の全要件を満たしている。cascade 呼び出しは 5 経路 6 箇所すべてに正しく配線されており（saveTaskState 直前、notifyStateChanged 条件付き、ログ統一）、pure function テスト 6 ケース + 統合テスト 7 ケース（5 直接 + 回帰 1 + E2E 1）がすべて pass、`bunx tsc --noEmit` もクリーン。Recommendation R1〜R4 もすべて適用されている。Critical findings 0 件、Minor findings 0 件、Recommendations 1 件のみ。

## 実装箇所の grep 確認結果

### cascadeAbortToChildren 呼び出し（6 箇所）

```
task.ts:263    export function cascadeAbortToChildren(...)  ← 定義
daemon.ts:18   import { ..., cascadeAbortToChildren } from "./task"
daemon.ts:1677 user_clear 経路（SESSION_CLEAR ハンドラ内 conductor running 分岐）
daemon.ts:1839 assign_failed 経路（scanTasks 内 AssignTaskError kind="task" 分岐）
daemon.ts:2182 forceCloseDisconnectedConductor（disconnect timeout）

main.ts:43    import { ..., cascadeAbortToChildren, type TaskState } from "./task"
main.ts:2998  cmdAbortTask（Conductor 不在分岐）
main.ts:3030  cmdAbortTask（Conductor 有り分岐）
main.ts:3283  cmdDeleteTask
```

5 経路 6 箇所すべて網羅。

### 順序検証（saveTaskState 直前）

いずれの経路も以下の順序が守られている:

1. 親を `aborted`/`deleted` に mutate
2. `cascadeAbortToChildren(ts, tasks, parentId)` を呼ぶ
3. `saveTaskState(projectRoot, ts)` を呼ぶ（親 + 子をまとめて 1 回だけ保存）
4. `task_aborted` / `task_deleted` ログ
5. `revertedChildren` を for-loop で `child_reverted_to_draft` ログ
6. (daemon 経路のみ) `revertedChildren.length > 0` 時のみ `notifyStateChanged(...)` 呼び出し

### ログ reason 統一（R1）

```
$ grep -rn "parent_deleted" skills/cmux-team/manager/
(マッチ 0 件)
```

すべて `reason=parent_aborted` に統一済み（delete 経路も含む）。

### cmdAbortTask の loadTasks 呼び出し（R3）

```
$ grep -n "await loadTasks" skills/cmux-team/manager/main.ts
1100:  const { tasks } = await loadTasks(PROJECT_ROOT);
2976:  const { tasks: allTasks } = await loadTasks(PROJECT_ROOT);   ← cmdAbortTask 冒頭 1 回のみ
3282:  const { tasks: allTasks } = await loadTasks(PROJECT_ROOT);   ← cmdDeleteTask
3317:  const { tasks, taskState } = await loadTasks(PROJECT_ROOT);
```

cmdAbortTask 内で `allTasks` を冒頭で 1 回取得し、Conductor 不在分岐（L2998）と有り分岐（L3030）の両方で再利用している。

### cascadeAbortToChildren JSDoc（R4）

`task.ts` の JSDoc 1 行目（太字強調）:

> **呼び出し側は親が aborted/deleted に遷移した直後のみ呼ぶこと（cascade 関数内では遷移状態を検証しない）**。

呼び出し責務が明記されており、誤って closed 経路から呼ぶリスクを防止している。

## テスト結果

### `bun test task.test.ts`

```
bun test v1.3.12 (700fc117)
 24 pass
 0 fail
 47 expect() calls
Ran 24 tests across 1 file. [16.00ms]
```

`cascadeAbortToChildren (T241)` describe に 6 ケース:

1. 親 aborted + 子 ready → draft に戻る
2. 親 aborted + 子 draft → 変化なし
3. 親 aborted + 子 assigned → 変化なし
4. 親 aborted + 子 closed/aborted/deleted → 変化なし
5. 複数 depends_on の子 ready → 1 親 cascade でも draft
6. 既存 journal がある子 → `; parent_aborted:` で追記

### `bun test daemon.test.ts`

```
 96 pass
 0 fail
 276 expect() calls
Ran 96 tests across 1 file. [2.98s]
```

`depends_on cascade on parent abort/delete (T241)` describe に 7 ケース:

1. ケース1: 親 abort → 子 ready が draft に戻る
2. ケース2: 親 abort → 子 assigned は維持
3. ケース3: 親 delete → 子 ready が draft に戻る
4. ケース4: 複数 depends_on のうち 1 つが abort でも draft に戻る
5. ケース5: 孫世代 A→B→C で A abort → B=ready は draft、C は変化なし
6. ケース6（回帰）: 親 closed → 子 ready は filterExecutableTasks で拾われる
7. E2E: assign_failed 経路（git 未初期化）で親 abort → 子 ready が draft に戻る

### 全体テスト

```
 458 pass
 0 fail
 1026 expect() calls
Ran 458 tests across 21 files. [14.52s]
```

既存テストに回帰なし。

### `bunx tsc --noEmit`

exit 0、出力なし（型エラーゼロ）。既存型エラーの新規導入もなし。

## Findings

Critical / Major / Minor findings いずれも 0 件。

## Recommendations

1. **（任意・非ブロッキング）R3 との一貫性を main.ts 全体に広げる余地**: cmdAbortTask では loadTasks 1 回化（R3）が適用されているが、cmdDeleteTask は独立コマンドで十分シンプルなため現状で問題ない。将来 delete-task 内で他分岐が増えた際に同じリファクタを検討する程度で十分。

## 仕様適合性チェック

| 項目 | 結果 | 確認内容 |
|---|---|---|
| 親 abort/deleted → ready 子が draft | ✅ | 5 経路 6 箇所すべて配線済み。pure + 統合テストで確認 |
| 子 journal に `parent_aborted: <parentId>` | ✅ | 新規 journal / 既存 journal の両方テスト済み（`; ` 連結） |
| ログ `child_reverted_to_draft parent=X child=Y reason=parent_aborted` | ✅ | delete 経路含め統一 |
| ready のみ draft 化 | ✅ | pure function テストで draft/assigned/closed/aborted/deleted を確認 |
| 循環 depends_on で O(N) 終了 | ✅ | 1 パス走査（再帰なし）で実装 |
| 正常系（親 closed → 子 assign）回帰なし | ✅ | ケース6（回帰）で `filterExecutableTasks` 動作確認 |
| R1 parent_aborted 統一 | ✅ | parent_deleted マッチ 0 件 |
| R2 assign_failed 経路 E2E | ✅ | daemon.test.ts 末尾に追加 |
| R3 cmdAbortTask loadTasks 1 回 | ✅ | main.ts:2976 で 1 回、両分岐で共有 |
| R4 JSDoc 呼び出し責務明記 | ✅ | 冒頭 1 行目に太字で明記 |
| CLAUDE.md 更新 | ✅ | エラーリカバリ直下に `### 依存タスクの cascade（T241）` 追記、5 経路・ログ形式すべて記載 |

## 結論

T241 は仕様・plan・design-review のすべての要件を完全に満たしている。受け入れ条件 3 項目（ready 子の自動 draft 化、journal 追跡、正常系回帰なし）をすべて充足し、Recommendation 4 項目（R1-R4）すべて反映済み。全テスト 458/458 pass、型チェッククリーン。**GO**。
