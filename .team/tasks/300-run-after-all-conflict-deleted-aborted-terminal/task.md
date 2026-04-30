---
id: 300
title: run_after_all conflict チェックが deleted/aborted を terminal として扱っていない
priority: medium
created_at: 2026-04-22T15:21:52.370Z
---

## タスク
## 現象

deleted な `--run-after-all` タスクが存在するとき、新規 `--run-after-all` タスクの作成が `RUN_AFTER_ALL_CONFLICT` で拒否される。aborted も同様と見られる。

## 原因

`skills/cmux-team/manager/task.ts:783-798` の競合チェックが `t.status !== "closed"` のみで terminal 判定している。`scanTasks`（`daemon.ts:2507,2511`）側は `closed | aborted | deleted` の 3 つを terminal 扱いしているため、この 1 箇所だけ規則がずれている。

```ts
// 現状（task.ts:788）
const conflict = tasks.find(
  (t) =>
    t.runAfterAll &&
    t.status !== "closed" &&
    !(exclusive && t.exclusive),
);
```

## 修正方針

terminal 判定をスキャン側に揃える。`aborted` と `deleted` も除外する:

```ts
const conflict = tasks.find(
  (t) =>
    t.runAfterAll &&
    t.status !== "closed" &&
    t.status !== "aborted" &&
    t.status !== "deleted" &&
    !(exclusive && t.exclusive),
);
```

可能なら `isTerminalStatus(status)` のようなヘルパを切り出し、`scanTasks` の `closed` Set 構築（daemon.ts:2505-2509）と `openTasksList` フィルタ（daemon.ts:2511）と conflict チェック（task.ts:788）で共有し、terminal 状態の規則が 3 箇所でずれないようにする。

## 対象ファイル

- `skills/cmux-team/manager/task.ts`（conflict チェック本体）
- `skills/cmux-team/manager/daemon.ts`（ヘルパ共有する場合）
- `skills/cmux-team/manager/task.test.ts`（deleted/aborted run_after_all が conflict にならないテスト追加）

## 確認手順

1. deleted な run_after_all タスクがある状態で、新規 run_after_all タスクが作成できること
2. aborted な run_after_all タスクがある状態で、新規 run_after_all タスクが作成できること
3. 既存テスト（ready/assigned な run_after_all がある場合は従来通り conflict）が引き続き通ること
