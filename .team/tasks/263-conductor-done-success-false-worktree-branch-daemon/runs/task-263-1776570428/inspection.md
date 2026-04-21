# T263 Inspection: CONDUCTOR_DONE --success=false 時の worktree/branch 保持

## Verdict: GO

## Summary

plan.md の ST1〜ST4 全サブタスクが実装され、`resetConductor` への `preserveWorktree` オプション追加、`handleConductorDone` の task-state 分岐、`conductor_done_unresolved` ログ発行、両 test ファイルへの 8 ケース追加（4+4）が揃っている。全 605 テスト pass（新規 8 件含む）、touched files 起因の新規型エラーはゼロ（既存 2 件のみ main と共通）、conductor-role.md Step 9.5 の仕様（worktree 温存 + task-state を `assigned` のまま残す + 人間判断用ログ）と実装が一致する。

## Findings

### 1. [minor] 変更ファイル数は 4 件（schema.ts の diff は main 側の T265 commit 進行によるもの）

`git diff main --name-only` では 5 件表示されるが、schema.ts は branch が a705acd を base にしており main が 067e31f まで進行した差分が見えているだけ。`git diff HEAD --stat` では本タスクが変更したのは計画通りの 4 ファイル（conductor.ts +45 / daemon.ts +49 / conductor.test.ts +190 / daemon.test.ts +217）。追加で schema.ts を触ってはいない。問題なし。

### 2. [minor] Dead/Zombie code なし

- `preserveWorktree` / `conductor_done_unresolved` / `worktree_preserved` の全識別子は conductor.ts / daemon.ts / 両 test で利用されている（grep 結果で確認）
- 未使用 import なし（`existsSync` / `readFile` 等は Case #9/#10 で使用）
- `resetConductor` の既存呼び出し元 5 箇所（CONDUCTOR_CLEAR / forceCloseDisconnectedConductor / SESSION_CLEAR user_clear / CONDUCTOR_DONE 経由の handleConductorDone / 他）は `preserveWorktree` のデフォルト false で従来挙動維持

### 3. [minor] 設計原則の遵守

- `preserveWorktree=true` でも ConductorState リセット（status=idle, taskRunId/taskId/worktreePath/agents クリア）は unconditional に実行される（conductor.ts:634-653）。Case A のテストで `conductor.taskRunId`/`taskId`/`worktreePath`/`agents` が全て undefined/[] になることを検証済み
- success 判定は `handleConductorDone` に集約（D10）。CONDUCTOR_DONE handler は `message.success` / `message.reason` を素渡し
- ログは `formatSurface(conductor.surface, "C")` を使い既存パターンに整合
- `conductor_reset` ログ 1 行に `worktree_preserved=true` suffix を追加する方式（D12）で、grep 1 発で温存 worktree を列挙可能

### 4. [minor] 挙動表 10 ケースのテスト網羅

plan.md §2.4 の 10 ケース中、代表 4 ケース（#1 / #6 / #9 / #10）を daemon.test.ts に追加（要求通り）。#9（success=false && assigned、本命）と #10（task-state missing）で worktree 温存、#1（success=true && closed）と #6（success=false && closed）で削除を検証。ケース #2/#3/#4/#5/#7/#8 は #1/#6 のテストで同じ分岐にぶら下がる経路のため未カバーでも実装ロジック上は保守側に収まる。

## Test Results

```
bun test v1.3.12 (700fc117)

 605 pass
 0 fail
 1453 expect() calls
Ran 605 tests across 25 files. [32.60s]
```

- 新規 T263 テスト内訳:
  - `conductor.test.ts` → "resetConductor preserveWorktree オプション (T263)" 4 ケース全 pass（Case A/B/C/D）
  - `daemon.test.ts` → "handleConductorDone success/task-state 分岐 (T263)" 4 ケース全 pass（#1/#6/#9/#10）
- 既存テストは 1 件も破綻していない（T261 snapshot / T260 broken / T234 CONDUCTOR_REGISTERED 等を含む）

## Type Check Results

```
conductor.ts(197,3): error TS1016: A required parameter cannot follow an optional parameter.
daemon.test.ts(3650,9): error TS2322: Type '"new_session"' is not assignable to type '"startup" | "resume" | "clear" | "compact" | undefined'.
```

- **両エラーは clean base（stash で T263 diff を退避した状態）でも同じ 2 件が出る既存エラー**で、本タスクの touched 行とは無関係（conductor.ts:197 は `assignTask` シグネチャ、daemon.test.ts:3650 は T261 無関係テスト）
- T263 で追加された行（conductor.ts の `preserveWorktree` / `preservedSuffix` ブロック、daemon.ts の `handleConductorDone` 拡張、両 test の describe ブロック）からの新規型エラーはゼロ
- impl-summary.md の「touched files 起因の新規エラーゼロ」記述と一致

## Spec Alignment

conductor-role.md Step 9.5 の「rebase 衝突時は worktree 削除せず、タスク状態 `assigned` のまま、success=false で通知」仕様と実装が一致:

- `CONDUCTOR_DONE --success false` + task-state=assigned → worktree/branch 温存（Case #9 でテスト済み）
- `handleConductorDone` は task-state を書き換えない（close/abort しない）— plan.md D8/D9 通り
- `conductor_done_unresolved task_id=X C[N] task_state=assigned reason=... worktreePath=...` ログで `grep conductor_done_unresolved manager.log` による人間判断待ちタスク列挙が可能
- `cmux-team show-task T263` 等でタスクは open のまま残る（task-state 非変更）
