# T241 実装サマリ

## 概要

`depends_on` に親を含む `ready` 子タスクを、親が `aborted` / `deleted` に遷移した瞬間に `draft` へ戻す cascade を 5 経路（実体 6 箇所）に実装した。`cascadeAbortToChildren` 純粋関数を `task.ts` に切り出し、daemon / CLI 両方から呼ぶ構成。

## 変更ファイル一覧

| ファイル | 変更内容 |
|---|---|
| `skills/cmux-team/manager/task.ts` | `CascadeAbortResult` 型 + `cascadeAbortToChildren` 関数を追加 |
| `skills/cmux-team/manager/daemon.ts` | 3 経路（user_clear / forceClose / assign_failed）に cascade 呼び出しを追加 |
| `skills/cmux-team/manager/main.ts` | 2 経路 3 箇所（cmdAbortTask×2 / cmdDeleteTask）に cascade 呼び出しを追加 |
| `skills/cmux-team/manager/task.test.ts` | pure function テスト 6 ケース追加 |
| `skills/cmux-team/manager/daemon.test.ts` | 統合テスト 7 ケース追加（5 直接 + 回帰 1 + E2E 1） |
| `CLAUDE.md` | 「エラーリカバリ」セクション直下に `### 依存タスクの cascade（T241）` を追記 |

`git diff --stat` 結果（package-lock.json は既存差分）:
```
 CLAUDE.md                               |  20 +++++
 skills/cmux-team/manager/daemon.test.ts | 139 ++++++++++++++++++++++++++++++++
 skills/cmux-team/manager/daemon.ts      |  38 ++++++++-
 skills/cmux-team/manager/main.ts        |  30 ++++++-
 skills/cmux-team/manager/task.test.ts   |  98 +++++++++++++++++++++-
 skills/cmux-team/manager/task.ts        |  42 ++++++++++
```

## 各サブタスクの完了状況

| ID | 内容 | 状態 |
|----|------|------|
| S1 | `cascadeAbortToChildren` を `task.ts` に追加 | ✅ |
| S2 | `task.test.ts` に pure function テスト 6 ケース追加 | ✅ |
| S3 | `daemon.ts` の 3 経路に cascade 呼び出し追加 | ✅ |
| S4 | `main.ts` の 3 箇所に cascade 呼び出し追加 | ✅ |
| S5 | `daemon.test.ts` に統合テスト 5+1 ケース + E2E 1 ケース追加 | ✅ |
| S6 | `CLAUDE.md` 更新 | ✅ |
| S7 | 全体テスト + tsc 確認 | ✅ |

## 実行したテストコマンドと結果

### `bun test task.test.ts`
```
24 pass
0 fail
47 expect() calls
Ran 24 tests across 1 file. [16ms]
```

### `bun test daemon.test.ts`
```
96 pass
0 fail
276 expect() calls
Ran 96 tests across 1 file. [2.92s]
```

### `bun test`（全体）
```
458 pass
0 fail
1026 expect() calls
Ran 458 tests across 21 files. [13.43s]
```

### `bunx tsc --noEmit`

エラーなし（exit 0、無出力）。

## Recommendation 1〜4 の適用結果

| # | 内容 | 適用箇所 |
|---|------|---------|
| **R1** | ログキー `reason=` を全経路で `parent_aborted` に統一（delete 経路でも `parent_aborted`） | daemon.ts 3 箇所 + main.ts 3 箇所 ともに `reason=parent_aborted`。`reason=parent_deleted` は使用していない |
| **R2** | assign_failed 経路の配線 E2E を 1 ケース追加 | `daemon.test.ts` 末尾に `"E2E: assign_failed 経路（git 未初期化）で親 abort → 子 ready が draft に戻る"` を追加。`scanTasks(state)` 経由で cascade が発動することを実環境で確認 |
| **R3** | `cmdAbortTask` の `loadTasks` を関数冒頭で 1 回だけ実行 | `main.ts:2977` で `const { tasks: allTasks } = await loadTasks(PROJECT_ROOT)` を 1 回呼び、Conductor 不在分岐（L2998）と Conductor 有り分岐（L3030）の両方で再利用 |
| **R4** | `cascadeAbortToChildren` の JSDoc 冒頭に呼び出し責務を明記 | `task.ts` の JSDoc 1 行目に **太字**で「呼び出し側は親が aborted/deleted に遷移した直後のみ呼ぶこと（cascade 関数内では遷移状態を検証しない）」を明記 |

## cascade 呼び出し箇所一覧（最終）

```
task.ts:263   export function cascadeAbortToChildren(...)

daemon.ts:18   import { ..., cascadeAbortToChildren } from "./task"
daemon.ts:1677 user_clear（SESSION_CLEAR ハンドラ内 conductor running 分岐）
daemon.ts:1839 assign_failed（scanTasks 内 AssignTaskError kind="task" 分岐）
daemon.ts:2182 forceCloseDisconnectedConductor（disconnect timeout）

main.ts:43    import { ..., cascadeAbortToChildren, ... } from "./task"
main.ts:2998  cmdAbortTask（Conductor 不在分岐）
main.ts:3030  cmdAbortTask（Conductor 有り分岐）
main.ts:3283  cmdDeleteTask
```

## 自己判断した箇所・リスク

### 自己判断

1. **plan.md L304 のログ reason 矛盾**（design-review Finding 1）: コード例は `parent_deleted` だったが、Decision D7 / Recommendation 1 に従い `parent_aborted` に統一して実装。
2. **R2（E2E テスト）**: 既存の `"scanTasks: assignTask エラー分離"` describe ブロックで使われている「git 未初期化な testDir で worktree 作成失敗 → assign_failed → task が aborted」というパターンを踏襲し、子タスクを 1 件追加して cascade の発動を検証。`scanTasks(state)` を 1 回呼ぶだけで親 abort + cascade が連鎖することを E2E で確認できる。

### 残存リスク（plan.md §6 で既に許容済み）

1. **CLI と daemon の同時書き込みレース**: `loadTaskState` → mutate → `saveTaskState` 間で daemon と CLI が同じ `task-state.json` を書き換えるとロスト更新の可能性（plan.md §6.3）。本タスクの対象外。実装は既存の load-modify-save パターンを厳守し、新たなレースは導入していない。
2. **CLI 経路で子の TASK_UPDATED は送らない**（D6）: file watcher が `.team/task-state.json` を監視するため最終的に TUI は反映される。即時性要求なし。
3. **assigned 子へは journal を追記しない**（仕様通り）: 走行中の作業は止めないため、parent abort の情報は assigned 子の journal には残らない。

## 仕様適合性

task.md / plan.md §9 の受け入れ条件:

- ✅ 親が abort/deleted になった瞬間に、ready 子が自動で draft に戻る → 5 経路 6 箇所すべてに cascade を配線
- ✅ 子の journal から理由が追跡できる → `parent_aborted: <parentId>` を journal に追記（既存 journal は `; ` で連結）
- ✅ 既存の正常系（親 closed → 子 assigned）に回帰なし → 回帰テスト ケース6 で `filterExecutableTasks` が closed 親の子 ready を拾うことを確認済み
- ✅ 全体テスト 458/458 pass、`bunx tsc --noEmit` クリーン
