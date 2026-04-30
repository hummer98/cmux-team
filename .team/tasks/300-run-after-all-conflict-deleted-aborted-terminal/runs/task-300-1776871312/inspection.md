# T300 Inspection Report

## 判定: **GO**

run_after_all conflict チェックが `deleted` / `aborted` を terminal として扱うよう修正された。plan.md の指示に忠実で、スコープ逸脱なし、全テスト pass、T300 起因の tsc エラー 0 件。

---

## 検証結果（観点別）

### 1. plan との整合性 ✅ 合格

- plan.md §2「ヘルパ切り出し: 採用」の仕様通り、`task.ts` に `isTerminalStatus(status: string): boolean` を新規 export 追加
- plan.md §3 Step 2–4 の編集順序・編集箇所が実装と完全一致:
  - `task.ts:746-751` に `isTerminalStatus` 追加（期待位置: `createTaskProgrammatic` 直前）
  - `task.ts:800` の conflict 判定を `!isTerminalStatus(t.status)` に置換（plan の `:783-798` 相当）
  - `daemon.ts:20` の既存 import 行に `isTerminalStatus` を追加（新規 import 行を増やさず）
  - `daemon.ts:2507` の closed Set 構築を `isTerminalStatus(s.status)` に置換
  - `daemon.ts:2511` の openTasksList フィルタを `!isTerminalStatus(t.status)` に置換
- plan.md §3 Step 4 の注記通り、`daemon.ts:2533` 付近の `closedMetas`（表示用）は **意図的に触っていない**（grep で確認、触れていない）
- JSDoc も plan.md §2 の想定通り「3 箇所で共有する」旨を明記

### 2. 修正の正しさ ✅ 合格

- `createTaskProgrammatic` の conflict 判定は `runAfterAll && !isTerminalStatus(t.status) && !(exclusive && t.exclusive)` となり、`aborted` / `deleted` な run_after_all タスクが正しく除外される
- plan.md §3「exclusive 条件との組み合わせ表」の 10 行全てが期待通り:
  - `aborted` / `deleted` な既存は exclusive 組み合わせによらず一律許可
  - `ready` / `assigned` の挙動（既存仕様）は保たれる
  - exclusive 同士共存（既存=ready + 新規=exclusive）は従来通り許可

### 3. `isTerminalStatus` ヘルパ ✅ 合格

- `export function isTerminalStatus(status: string): boolean` として pure 関数で宣言
- 3 状態（`closed` / `aborted` / `deleted`）に対して true を返す仕様通り
- `daemon.ts` の既存 import 行に 1 識別子追加のみで、新規 import 行を増やしておらず plan.md §5「daemon.ts の import 追加 1 行のみ」の意図に沿う
- 利用箇所は plan.md 指定の 3 箇所（task.ts conflict / daemon.ts closed Set / daemon.ts openTasksList）で全て使用

### 4. テスト網羅性 ✅ 合格

`task.test.ts` に追加された 2 つの describe は plan.md §4 の計画と完全一致:

- `describe("isTerminalStatus (T300)")` — 7 ケース（closed/aborted/deleted=true, ready/assigned/draft=false, 未知値=false）
- `describe("createTaskProgrammatic run_after_all conflict (T300)")` — 9 ケース:
  | # | 既存 | 新規 | 期待 | 実装 |
  |---|---|---|---|---|
  | 1 | run_after_all aborted | run_after_all | 成功 | ✅ |
  | 2 | run_after_all deleted | run_after_all | 成功 | ✅ |
  | 3 | run_after_all closed | run_after_all | 成功 | ✅ |
  | 4 | run_after_all ready | run_after_all | conflict + existingTaskId | ✅ |
  | 5 | run_after_all assigned | run_after_all | conflict + existingTaskId | ✅ |
  | 6 | exclusive ready | exclusive | 成功 | ✅ |
  | 7 | run_after_all aborted (非排他) | exclusive | 成功 | ✅ |
  | 8 | exclusive deleted | run_after_all (非排他) | 成功 | ✅ |
  | 9 | run_after_all ready (非排他) | exclusive | conflict + existingTaskId | ✅ |

- `setupExisting` helper が plan.md §3「task-state.json 側の status を優先」特性に則って `loadTaskState` → 書き換え → `saveTaskState` の 2 段構成で実装されている
- conflict ケースでは `RUN_AFTER_ALL_CONFLICT` エラーコードと `existingTaskId` の両方を検証しており、回帰防止強度が適切

### 5. 副作用・回帰 ✅ 合格

```
bun test: 1083 pass / 0 fail / 2528 expect() calls (36 files, 49.31s)
```

- 既存テスト全件 pass（Deliverable T295, cascadeAbortToChildren, parseTaskMeta 等）
- `bunx tsc --noEmit` で報告される 3 件（conductor.ts(201,3) / daemon.test.ts(3870,9) / daemon.ts(1598,22)）は **baseline（git stash 後）で同一 3 件** が出ることを独自に検証。T300 起因の新規エラーは **0 件**
- implementation.md の「ベースライン既存 3 件は T300 スコープ外」という主張は事実

### 6. 作業境界遵守 ✅ 合格

git diff --stat:
```
 package-lock.json                     |   4 +-
 skills/cmux-team/manager/daemon.ts    |   6 +-
 skills/cmux-team/manager/task.test.ts | 190 ++++++++++++++++++++++++++++++++++
 skills/cmux-team/manager/task.ts      |  14 ++-
```

- plan.md §完了条件で指定された 3 ファイル（task.ts / daemon.ts / task.test.ts）のみ意味のある変更
- package-lock.json は `version: 4.5.0 → 4.5.1` の 2 行差分のみで、HEAD コミット `f96f99e chore: release v4.5.1` で package.json が 4.5.1 になっているのに lockfile の version フィールドが 4.5.0 のままだったのを `npm install` が自動同期した結果（→ findings 参照）。実装者の能動的変更ではなく、むしろ lockfile のズレを是正する方向の差分

### 7. 回帰防止 ✅ 合格

- ready / assigned な run_after_all に対する conflict は従来通り発生し、`existingTaskId` も正しく伝播（テスト #4, #5, #9 で確認）
- exclusive 同士共存（#6）も従来通り許可
- `filterRunAfterAllTasks` 側（daemon.ts:2523 付近）は `closedIds` Set 経由で既に terminal を除外済みのため、実行経路の挙動も作成経路と揃う

---

## Findings

### F1. package-lock.json の version 自動同期（軽微・情報）

- 差分: `version: "4.5.0" → "4.5.1"`（2 行）
- 原因: `f96f99e chore: release v4.5.1` で package.json は 4.5.1 に上がっていたが package-lock.json の version フィールドが同期されていなかった。Conductor が worktree セットアップ時に `npm install` を実行した結果、lockfile が HEAD の package.json に追従した
- 影響: 依存関係のバージョン変化は 0（`node_modules` ツリーに変化なし）。lockfile 整合性が改善される方向の差分
- 対応: plan.md §完了条件で明記されていない変更ではあるが、T300 のロジックに影響せず、むしろ直すべき既存のドリフトを埋めている。**GO 判定を阻害しない**
- 参考: この lockfile のズレ自体は T300 とは独立した issue として、将来の release フローで `npm install` 後に lockfile もコミットに含める運用を再確認する価値あり（本タスクでの対応は不要）

### F2. 既存 tsc エラー 3 件（スコープ外・情報）

- `conductor.ts(201,3)`: required parameter が optional parameter の後に来ている型エラー
- `daemon.test.ts(3870,9)`: SESSION_STARTED source 型 literal `"new_session"` がユニオン外
- `daemon.ts(1598,22)`: `string | undefined` → discriminated union の型アサーション

これら 3 件は baseline から存在しており T300 とは無関係。implementation.md の報告と一致。T300 スコープ外として別途対応されるべき（既存の技術的負債）。

---

## Summary

T300 は「terminal 状態の定義が 3 箇所で分散していた不整合」を構造的に解消する修正で、plan.md は `isTerminalStatus` ヘルパを task.ts 側に据え「作成経路と実行経路の terminal 定義を揃える」という正しい設計判断を示している。実装は plan.md に忠実で、スコープ外の変更なし、テスト網羅性十分、回帰なし、T300 起因の tsc エラーなし、既存 1083 テスト全件 pass。

軽微な findings（F1: lockfile の version 自動同期 / F2: 既存 tsc エラー）はいずれも T300 のスコープ外・判定に影響なし。

**判定: GO**
