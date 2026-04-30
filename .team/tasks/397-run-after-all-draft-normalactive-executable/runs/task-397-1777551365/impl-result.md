# T397 実装結果

## 概要

`filterRunAfterAllTasks` の `normalActive` フィルタを「assigned OR (ready AND depends_on 全 closed)」の executable ベースに修正し、draft な依存先で間接ロックされるデッドロックを解消した。テスト 7 件追加、全て pass。

## 修正したファイル

### 1. `skills/cmux-team/manager/task.ts`（468-503 行）

| 種別 | 内容 |
|---|---|
| docstring | `filterRunAfterAllTasks` の説明を新仕様（normalActive = assigned または ready+deps closed）に書き換え。間接デッドロック回避の意図を明記 |
| inline コメント（旧 489 行） | 「ready + assigned 数」→「実際に動く / 動ける通常タスク（T397 注釈付き）」に書き換え |
| `normalActive` フィルタ（旧 490-494 行） | `t.status === "ready"` 単独判定 → `assignedIds.has(t.id) \|\| (t.status === "ready" && t.dependsOn.every(d => closedIds.has(d)))` に変更 |

シグネチャ・返り値型は変更なし。呼び出し元 `daemon.ts:2943` への波及は無し（plan.md §7 通り）。

### 2. `skills/cmux-team/manager/task.test.ts`

- import に `filterRunAfterAllTasks` を追加（7 行目付近）
- `describe("filterExecutableTasks", …)` と `describe("sortByPriority", …)` の間に新規 `describe("filterRunAfterAllTasks", …)` を追加
- 専用ヘルパー `makeMeta`（`runAfterAll` opt 対応）を含む 7 ケース（T1〜T7）

## 追加したテスト T1〜T7 の通過状況

| # | description | 観点 | 結果 |
|---|---|---|---|
| T1 | ready でも depends_on 未解決（依存先が draft）なら run_after_all 発火 | 新規（T397 本体） | pass |
| T2 | ready で depends_on が解決済みの通常タスクは run_after_all をブロック | regression | pass |
| T3 | assigned な通常タスクは run_after_all をブロック | regression | pass |
| T4 | 通常タスク全 closed なら run_after_all 発火 | 基本パス | pass |
| T5 | run_after_all に depends_on するタスク（cleanup chain）は normalActive 除外 | regression | pass |
| T6 | run_after_all 自身の depends_on が未解決なら発火しない | regression | pass |
| T7 | 残っている通常タスクが draft のみなら run_after_all 発火 | コーナー | pass |

```
$ bun test --timeout 30000 task.test.ts -t "filterRunAfterAllTasks"
 7 pass
 0 fail
 7 expect() calls
```

### TDD 中間状態

修正前の task.ts に T1〜T7 を追加して走らせた段階では **T1 のみ fail**（T7 は既存実装でも `t.status === "ready"` チェックなので draft はカウントされず通る）。修正適用後に T1 も green になり、修正効果を確認できた。

## `bun test` の結果

```
$ cd skills/cmux-team/manager && bun test --timeout 30000 task.test.ts daemon.test.ts
 294 pass
 0 fail
 874 expect() calls
Ran 294 tests across 2 files. [24.87s]
```

- task.test.ts: 既存 100 件 + 新規 7 件 = 全 107 件 pass
- daemon.test.ts: 既存 187 件 全 pass（`294 - 107 = 187`）
- 全体: 294/294 pass

## `bunx tsc --noEmit` の結果

```
$ cd skills/cmux-team/manager && bunx tsc --noEmit
（出力無し、exit=0）
```

型エラー無し。

## 想定外の問題・judgement call

- なし。plan.md §10 の手順通りに実施した。
- TDD の事前検証として T1〜T7 を追加した段階での fail 内訳が plan.md の想定（「T1, T7 が fail」）と若干異なり、実際には T1 のみ fail（T7 は既存仕様でも pass）。draft は元コードの `t.status === "ready"` チェックでもブロック対象に含まれないため自然な結果で、修正の正当性に影響なし。

## 完了条件チェックリスト

- [x] `filterRunAfterAllTasks` の `normalActive` フィルタを executable ベース（assigned OR (ready AND deps closed)）に修正
- [x] 新規テスト T1: ready で dep が draft のタスクが存在しても run_after_all が発火する
- [x] 既存挙動 regression T2: ready で dep が解決済みのタスクは run_after_all をブロックする
- [x] 既存挙動 regression T3: assigned タスクは run_after_all をブロックする
- [x] `cd skills/cmux-team/manager && bun test --timeout 30000 task.test.ts daemon.test.ts` が green
- [x] `bunx tsc --noEmit` が green
