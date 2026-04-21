# T263 Implementation Report

## 概要

`CONDUCTOR_DONE --success=false` + task-state が `assigned` のままの場合に、daemon が
worktree / branch を削除せず温存するよう実装した。人間が手動で rebase / 再投入を選択
できるようにし、T262 で発生した「完了済みタスクが最初からやり直される」問題を防ぐ。

## サブタスク完了状況

| サブタスク | 対象 | 状態 |
|-----------|------|------|
| T263-1 | `resetConductor` に `preserveWorktree` オプション追加 | ✅ 完了 |
| T263-2 | `handleConductorDone` 拡張（`opts.unresolved`） | ✅ 完了 |
| T263-3 | `CONDUCTOR_DONE` handler で `unresolved` 判定 | ✅ 完了 |
| T263-4 | `conductor.test.ts` ユニットテスト（case A / B + regression） | ✅ 完了 |
| T263-5 | `daemon.test.ts` 統合テスト（case C / D / E） | ✅ 完了 |
| T263-6 | `bun test` 全通過確認 | ✅ 完了 |

## 変更ファイル

### `skills/cmux-team/manager/conductor.ts`

1. `resetConductor` の `opts` に `preserveWorktree?: boolean` を追加
2. worktree / branch 削除ブロックを `if (!opts?.preserveWorktree)` でガード
3. ログ出力に `preserve_worktree=true` サフィックスを追加（`preserveWorktree: true` 時のみ）

### `skills/cmux-team/manager/daemon.ts`

1. `handleConductorDone` のシグネチャに `opts: { unresolved: boolean }` を追加
2. `unresolved=true` の分岐で `conductor_done_unresolved` ログを発行し、
   `resetConductor` に `preserveWorktree: true` を渡す
3. `CONDUCTOR_DONE` handler 内で `loadTaskState` を呼び出し、
   `!isSuccess && taskStatus === "assigned"` を `unresolved` として計算
4. `conductor_error` / `conductor_done_signal` のログに `task_status=<status>` を付与

### `skills/cmux-team/manager/conductor.test.ts`

以下 3 ケースを追加（`describe("resetConductor preserveWorktree オプション (T263)")`）:

- **case A**: `preserveWorktree=true` で worktree ディレクトリ / branch が残ること +
  `conductor_reset ... preserve_worktree=true` がログに出ること
- **case B**: `preserveWorktree=true` でも `ConductorState` が従来通り完全リセットされること
- **regression guard**: `preserveWorktree` 省略時は worktree / branch が削除され、
  `preserve_worktree=true` がログに出ないこと

### `skills/cmux-team/manager/daemon.test.ts`

以下 3 ケースを追加（`describe("T263: CONDUCTOR_DONE --success=false で worktree/branch を温存する")`）:

- **case C**: `success=false` + `task-state=assigned` → `conductor_done_unresolved` ログ +
  worktree / branch 温存 + `task_completed` は出ない
- **case D**: `success=true` → `task_completed` ログ + worktree 削除（従来動作の regression guard）
- **case E**: `success=false` + `task-state=closed` → `conductor_error task_status=closed` +
  `task_completed` ログ + worktree 削除（full cleanup）

## テスト結果

### bun test conductor.test.ts

```
 27 pass
 0 fail
 94 expect() calls
Ran 27 tests across 1 file.
```

### bun test daemon.test.ts

```
 135 pass
 0 fail
 394 expect() calls
Ran 135 tests across 1 file.
```

### bun test（全体）

```
 592 pass
 0 fail
 1386 expect() calls
Ran 592 tests across 25 files.
```

全テスト green、回帰なし。

## 型チェック

```
$ bunx tsc --noEmit
conductor.ts(197,3): error TS1016: A required parameter cannot follow an optional parameter.
daemon.test.ts(3650,9): error TS2322: Type '"new_session"' is not assignable to type '...'
```

2 件の型エラーは plan.md「6. 既存型エラーの先読み」で明示されていた **既存エラー** で、
T263 の改修とは無関係。本タスクで件数は増えていない（追加エラー 0 件）。

## 実装上の判断

### 1. preserveWorktree の実効範囲

`preserveWorktree=true` は **worktree ディレクトリと branch の削除のみ** をスキップする。
以下は従来通り実行される:

- sibling surface（Agent タブ）の close
- `ConductorState` のリセット（`status`, `taskRunId`, `taskId`, `taskTitle`,
  `worktreePath`, `outputDir`, `agents`, `disconnectedAt`）

これにより Conductor は idle に戻って次の ready タスクを拾える一方、人間は worktree
ディレクトリに入って `git rebase` / `git merge` を手動実行できる。

### 2. ログ設計

判定式は `!isSuccess && taskStatus === "assigned"` の 1 行で pinpoint に効く。
他の状態（`closed` / `aborted` / `deleted` / `missing`）は従来動作に落ちる。

ログ粒度:

- `CONDUCTOR_DONE` 受信時: `conductor_error task_status=<X> reason=<Y>`
- unresolved 判定時: `conductor_done_unresolved task_id=<N> reason=success_false_task_assigned`
- reset 時: `conductor_reset C[<N>] preserve_worktree=true`

`grep conductor_done_unresolved .team/logs/manager.log` で人間が手動介入すべき
worktree を一覧できる。

### 3. テスト戦略（plan.md との差異）

plan.md では「`execFile` を spy して呼ばれないことを検証」する案が挙げられていたが、
実装の `execFile` は `promisify(execFileCb)` でモジュール内 `const` にラップされており
外部から spyOn できない。そこで:

- 実 `git init` + `git worktree add` で worktree と branch を作成
- `resetConductor` 呼び出し後、`existsSync(worktreePath)` / `git branch --list <name>`
  で物理的な残存を検証

こちらのほうが結合度は上がるが、計画書「挙動の表」で期待される実挙動を直接検証できる。

既存の T242 / T243 テスト（`assignTask worktree base 解決`）でも同様に実 git
operations を使っており、既存パターンに整合する。

### 4. handleConductorDone の `conductor.taskId` スナップショット

`resetConductor` は `conductor.taskId` を `undefined` に書き換えるため、
ログ用に先に `const taskId = conductor.taskId` でスナップショットを取り、
`task_completed` / `conductor_done_unresolved` の `task_id=<N>` で使い回す。
（従来実装も同じ順序で `conductor.taskId` を参照していたが、分岐が増えたため
局所変数化して可読性を上げた。）

## Issues Encountered

なし。plan.md の判定式・ログ命名・挙動表がそのまま実装に落ちた。

## Out of Scope（確認のみ）

以下の `resetConductor` 呼び出し箇所は本タスクで変更しない。plan.md「1-bis」の表通り、
`preserveWorktree` を渡さないため従来動作を維持する:

- `CONDUCTOR_CLEAR` (`daemon.ts:1258`) — broken 明示クリア経路
- `disconnect_timeout` (`daemon.ts:2571`) — broken 遷移経路
- `SESSION_CLEAR` の user_clear cascade (`daemon.ts:2022`) — 手動 `/clear` 経路

## 完了条件

- [x] `resetConductor` に `preserveWorktree` オプションが追加されている
- [x] `handleConductorDone` が `opts.unresolved` を受け取り、unresolved=true の場合に
      `preserveWorktree: true` で reset する
- [x] `CONDUCTOR_DONE` handler が task-state を読んで `unresolved` を決定している
- [x] 新規テストが通る（case A / B / regression guard / C / D / E — 計 6 件）
- [x] 既存テストが全て通る（592/592 pass、回帰なし）
- [x] impl-report.md に結果サマリーと各サブタスクの完了状況が記載されている
