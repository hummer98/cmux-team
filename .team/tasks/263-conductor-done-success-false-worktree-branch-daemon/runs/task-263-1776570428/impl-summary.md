# T263 実装サマリー: CONDUCTOR_DONE --success=false 時の worktree/branch 保持

## Completed Tasks

- **ST1**: `resetConductor` に `preserveWorktree` オプションを追加（conductor.ts）
- **ST2**: `conductor.test.ts` に `preserveWorktree` 4 ケース追加（Case A/B/C/D）
- **ST3**: `handleConductorDone` に `opts?: { success?, reason? }` 追加、`loadTaskState` による unresolved 判定と `conductor_done_unresolved` ログ発行を実装（daemon.ts）
- **ST4**: `daemon.test.ts` に挙動テーブル 4 ケース追加（#1 / #6 / #9 / #10）

## Files Changed

| ファイル | 変更概要 |
|---|---|
| `skills/cmux-team/manager/conductor.ts` | `resetConductor` のシグネチャに `preserveWorktree?: boolean` を追加。worktree/branch 削除ブロック全体を `if (!opts?.preserveWorktree) { ... }` で囲む。ログに `worktree_preserved=true` suffix を条件付きで追加（`reasonSuffix` の直後、`aliveSuffix` の直前） |
| `skills/cmux-team/manager/daemon.ts` | `handleConductorDone(state, conductor, opts?)` に引数拡張。冒頭で `loadTaskState` を呼び `unresolved = !success && task-state ∉ {closed, aborted, deleted}` を算出。`unresolved` 時は `conductor_done_unresolved`、それ以外は `task_completed` を発行。`resetConductor` に `{ preserveWorktree: unresolved }` を渡す。`CONDUCTOR_DONE` handler（line 1310 付近）の呼び出しを `{ success: message.success, reason: message.reason }` 付きに変更 |
| `skills/cmux-team/manager/conductor.test.ts` | describe `"resetConductor preserveWorktree オプション (T263)"` を追加（4 ケース、実 git repo + worktree を使った fs 観測方式） |
| `skills/cmux-team/manager/daemon.test.ts` | describe `"handleConductorDone success/task-state 分岐 (T263)"` を追加（#1 / #6 / #9 / #10 の 4 ケース、`handleMessage(CONDUCTOR_DONE)` 経由で E2E 的に検証） |

## TDD Cycles

### ST1 → ST2（conductor.ts / conductor.test.ts）

- **RED/GREEN 手順**: 既存 26 テストを保ったまま `preserveWorktree` オプションを追加（後方互換: 未指定時の挙動は完全同一）。ST1 実装後に `bun test conductor.test.ts` で 26/26 pass を確認。続いて ST2 で 4 ケースを追加、4/4 pass → 合計 30/30 pass
- **REFACTOR**: conductor.ts は `preservedSuffix` 変数を 1 箇所で構築し、既存の `reasonSuffix` / `aliveSuffix` と同じパターンに揃えた（SSOT、1 行の log 呼び出しに統合）
- **VERIFY**: `bun test conductor.test.ts` 30 pass / 122 expect

### ST3 → ST4（daemon.ts / daemon.test.ts）

- **RED/GREEN 手順**: ST3 で `handleConductorDone` を拡張してから既存 141 テストで回帰確認（141/141 pass）。`CONDUCTOR_DONE` handler の呼び出しを素渡し（`success` / `reason`）に変更しても既存テストは破綻しない（既存 "2." テストは `success=true` のため `task_completed` 経路で従来通り）。ST4 で 4 ケースを追加、4/4 pass → 合計 145/145 pass
- **REFACTOR**: `handleConductorDone` 内で `taskId` を let ではなく const で 1 回だけ evaluation し、分岐は `if (!taskId || taskId === "undefined")` → `else if (unresolved)` → `else` の 3-way に整理。Design Review Finding 2（`loadTaskState` の double-read）は意図的に許容（コメントに明記）
- **VERIFY**: `bun test daemon.test.ts` 145 pass / 410+ expect

### 全体 VERIFY

- `bun test`（全 25 ファイル）: **605 pass / 0 fail / 1453 expect**
- `bunx tsc --noEmit`: touched files 起因の新規エラーゼロ（既存の 2 件 `conductor.ts(197,3)` / `daemon.test.ts(3650,9)` は本タスクと無関係で main ブランチでも出ている）

## Test Results

```
bun test v1.3.12 (700fc117)
 605 pass
 0 fail
 1453 expect() calls
Ran 605 tests across 25 files. [33.14s]
```

新規追加テスト内訳:
- `conductor.test.ts` T263: 4 ケース全通過（Case A=preserve true, B=preserve false 明示, C=未指定, D=preserve true + broken）
- `daemon.test.ts` T263: 4 ケース全通過（#1 success=true && closed, #6 success=false && closed, #9 success=false && assigned ★本命, #10 success=false && missing）

## Decisions

### Design Review Finding 1 への対応（`conductor_error` と `conductor_done_unresolved` の役割分担）

**意図的な 2 行構成**として plan.md 通り実装した:
- `conductor_error C[192] reason=...` — `CONDUCTOR_DONE --success=false` シグナル**受信時**のログ（daemon.ts:1306 付近）。Conductor が `success=false` を送信した事実そのものを記録
- `conductor_done_unresolved task_id=X ... task_state=assigned ...` — `handleConductorDone` 内の**判定結果**（task-state を読んだ上で unresolved と判断した場合のみ発行）

この 2 行が同じシーケンスで並ぶのは冗長ではなく、「シグナル受信」と「判定結果」を分離するための意図的設計。grep で `conductor_done_unresolved` だけを拾えば「人間判断待ち」タスクだけが列挙できるのが利点。

### その他の実装判断

- **Design Review Finding 2**: `collectResults` と `handleConductorDone` の両方が `loadTaskState` を呼ぶ double-read は許容。性能影響は無視できるため可読性優先（コメント追加）
- **Design Review Finding 5**: テストは実 git repo + worktree を作って fs 上の削除/温存を観察する方式を採用。`execFile` の mock.module spy は `promisify` 済み関数に効かない技術的制約があるため。既存 `listSiblingsSpy` / `closeSurfaceSpy` パターンと整合的に `getPaneForSurfaceSpy` は併用した
- **Design Review Finding 6**: `conductor_reset` ログの `worktree_preserved=true` suffix の有無は、conductor.test.ts（Case A/B/C）と daemon.test.ts（Case #9/#1）の双方でアサーションに組み込んだ
- **Decision D7**: `preserveWorktree=true` でも ConductorState は必ずリセットする（in-memory の `taskRunId` / `taskId` / `agents` 等は `undefined` / `[]` に戻る）。これをしないと次のタスク割当が破綻する
- **Decision D10**: `CONDUCTOR_DONE` handler 側の `isSuccess` ロジックは既存ログ出力にのみ使い、分岐判定は `handleConductorDone` に集約。`message.success` / `message.reason` を素渡しすることで重複を排除
- **小さな可読性改善**: `handleConductorDone` 内で `conductor.taskId` を `const taskId` に束ね、`taskId && taskId !== "undefined"` のチェックを `if (!taskId || taskId === "undefined")` に反転して早期リターンで読みやすくした（ただし今回は 3-way if/else を使用）

## Issues Encountered

- **Bun の `mock.module` が promisify 済み関数に効かない件**: 当初 Design Review Finding 5 の通り `execFile` を mock して call spy する方針を検討したが、`conductor.ts` は `const execFile = promisify(execFileCb)` を module top-level で確定させているため、後からの差し替えが効かない。代替として実 git repo を `tmpdir` 配下に作って worktree を物理的に配置し、`existsSync` と `git show-ref` で fs 上の残存/削除を観察する方式に切り替えた。1 テストあたり数百 ms 増えるが、既存の assignTask テストでも同様パターンが使われており許容範囲
- **既存の 2 件の型エラー**: `conductor.ts(197,3)` と `daemon.test.ts(3650,9)` は main ブランチ状態でも発生する既存エラーで、本タスクでは触れていない。touched files（conductor.ts の新規追加ブロック / daemon.ts の `handleConductorDone` / 両 test ファイルの新規 describe）からの新規型エラーはなし
