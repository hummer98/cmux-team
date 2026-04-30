# T301: daemon auto-restart 機能の完全廃止 — 実装レポート

- Run ID: `task-301-1776906555`
- Branch (worktree): `task-301-1776906555/task`
- Base: `main` @ `15665ed`
- Implementer: impl Agent
- 作業 worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-301-1776906555`

## Completed Tasks

- [x] サブタスク 1: ドキュメント先行削除（docs/spec/05, 06, CLAUDE.md）
- [x] サブタスク 2: テストファイル再確認（0 件、削除対象なし）
- [x] サブタスク 3: `daemon.ts` から `sourceMtimes` / `restartRequested` / `initSourceWatcher` / `checkSourceChanged` / tick source_changed ブロックを削除、未使用 `stat` import を削除
- [x] サブタスク 4: `main.ts` から `initSourceWatcher` import / 初期化、`restartRequested` ブロック、onReload exit 42 ループを削除（単発 execFileSync に置換）
- [x] サブタスク 5: `bin/cmux-team.js` の `start` 分岐削除（全コマンド共通の単発 execFileSync に統合）
- [x] サブタスク 6: 受け入れ grep 検証（厳密条件すべて 0 件）
- [x] サブタスク 7: `bunx tsc --noEmit` 新規エラー 0 件、`bun test` 1083/1083 pass
- [ ] サブタスク 8: 手動 E2E は Conductor が後工程で実施（本 Implementer は対象外）

## Files Changed

`git diff --stat`:

```
 CLAUDE.md                                  |  4 +--
 bin/cmux-team.js                           | 32 +++---------------
 docs/spec/05-install-and-infrastructure.md |  7 ++--
 docs/spec/06-implementation-tasks.md       |  5 ++-
 skills/cmux-team/manager/daemon.ts         | 54 +-----------------------------
 skills/cmux-team/manager/main.ts           | 53 +++++------------------------
 6 files changed, 21 insertions(+), 134 deletions(-)
```

### 変更概要

| ファイル | 変更概要 |
|---|---|
| `skills/cmux-team/manager/daemon.ts` | `DaemonState.sourceMtimes` / `restartRequested` フィールド削除、`createDaemon` の初期化削除、`initSourceWatcher` / `checkSourceChanged` 関数定義削除、`tick()` の source_changed ブロック削除、未使用 `stat` import 削除 |
| `skills/cmux-team/manager/main.ts` | `initSourceWatcher` import 削除、`state.sourceMtimes = await initSourceWatcher();` 削除、`if (state.restartRequested) { ... process.exit(42); }` ブロック削除、`onReload` の exit 42 while ループを単発 `execFileSync` + `process.exit(0)` に置換 |
| `bin/cmux-team.js` | `start` コマンド分岐の exit 42 while ループを削除し、全コマンドが単発 `execFileSync` の共通経路に統合 |
| `docs/spec/05-install-and-infrastructure.md` | L66 auto-restart 記述削除、L154 auto-restart 文削除、L193 `auto-restart 後` → `proxy 再利用時` に書き換え |
| `docs/spec/06-implementation-tasks.md` | L23 `exit code 42 で自動再起動` 削除、L119 ソース mtime 監視 bullet 削除、L198 `auto-restart 後の Master proxy 再接続` → `proxy 再利用時の Master 再接続` に書き換え |
| `CLAUDE.md` | L435 `restartRequested / onReload` → `onReload / onFullQuit / shutdown` に書き換え |

## Verification Results

### 1. tsc 結果（touched files）

```
$ bunx tsc --noEmit
conductor.ts(201,3): error TS1016: A required parameter cannot follow an optional parameter.
daemon.test.ts(3870,9): error TS2322: Type '"new_session"' is not assignable to type '"startup" | "resume" | "clear" | "compact" | undefined'.
daemon.ts(1546,22): error TS2352: Conversion of type 'string | undefined' to type '{ type: "SESSION_STARTED"; ...
```

- 着手前と同じ 3 件の既存エラーのみ
- daemon.ts の行番号は 1598 → 1546 に変化（削除による繰り上がり）、エラー内容は同一
- **新規エラー 0 件**

### 2. bun test 結果

```
$ cd skills/cmux-team/manager && bun test
 1083 pass
 0 fail
 2528 expect() calls
Ran 1083 tests across 36 files. [49.78s]
```

### 3. grep 検証結果

plan.md 7 節「検証（必須）」に対応:

| # | コマンド | 結果 |
|---|---|---|
| 1 | `bunx tsc --noEmit` 新規エラーなし（変更ファイルに対して） | ✅ 0 件 |
| 2 | `cd skills/cmux-team/manager && bun test` | ✅ 1083/1083 pass |
| 3 | `grep -rnE 'source_changed\|daemon_auto_restart\|initSourceWatcher\|checkSourceChanged\|sourceMtimes' skills/cmux-team/manager/` | ✅ 0 件 |
| 4 | `grep -rnE 'source_changed\|daemon_auto_restart\|initSourceWatcher\|checkSourceChanged\|sourceMtimes\|auto[-_]restart\|自動再起動\|exit[ _]code[ _]?42\|exit\(42\)\|status === 42' docs/ CLAUDE.md README*.md` | ✅ 0 件 |
| 5 | `grep -nE 'exit\(42\)\|status === 42' bin/cmux-team.js` | ✅ 0 件 |

plan.md 4 節 サブタスク 6 Check 3（`grep -rnE 'exit.*42|exit 42|status === 42|exit\(42\)' bin/ skills/cmux-team/manager/ docs/ CLAUDE.md`）は以下 2 件の false positive のみ。auto-restart / exit 42 機構とは無関係:

- `skills/cmux-team/manager/bun.lock:113` — auto-generated ink 依存ツリー記述で偶発的に `exit`（exit は存在しない "ansi-styles" の後方)…実態は greedy `.*` が長距離マッチして拾ったもの。意味的に exit 42 とは無関係
- `docs/spec/05-install-and-infrastructure.md:422` — `process.exit(1)` と `T242` / `T275` のタスク ID が同じ長い行に混在し、greedy マッチで拾われた

厳密パターン（`exit\(42\)`, `status === 42`, `\bexit 42\b`）では全ファイル 0 件を確認。

### 4. bin/cmux-team.js 動作確認

```
$ node bin/cmux-team.js status
cmux-team  RUNNING  PID 26559  conductors 2  layout=16x9
...
```

wrapper は単発 `execFileSync` 経路で正常動作。

## Subtask 8 (Manual E2E) 確認項目（Conductor 引き継ぎ用）

plan.md 4 節サブタスク 8 の手順を Conductor が実行すること。

1. 既存 daemon があれば `cat .team/daemon.pid | xargs kill` で停止
2. `cmux-team start` で再起動（初回ログに `daemon_started` が出ることを確認）
3. `cmux-team status` で Conductor 一覧が取れることを確認
4. 簡単なタスクを 1 件 `ready` 昇格 → 割り当て → close まで通ることを確認
5. `.team/logs/manager.log` に以下のログが **1 件も新規発火しない** こと:
   - `source_changed`
   - `daemon_auto_restart`
   - `daemon_reload_restart`

### onReload（dashboard `r` キー）確認項目

- TUI ダッシュボードで `r` キー → reload が走り `daemon_reload` / `daemon_reload_target` ログが出ること
- 新 daemon が無事に起動し TUI が再描画されること
- exit 42 ループが回ってしまう挙動が出ないこと（新実装は単発 `execFileSync` のみ）

## Issues Encountered

- **tsc 既存エラー 3 件**: 本タスク着手前から存在する既知エラー（conductor.ts:201, daemon.test.ts:3870, daemon.ts TS2352）。今回の削除で行番号のみ変動（daemon.ts 1598 → 1546）。本タスクのスコープ外のため修正せず。
- **plan.md サブタスク 6 Check 3 の greedy `exit.*42` パターン**: 2 件の false positive が残存（`bun.lock` / `docs/spec/05` L422 いずれも auto-restart 機構と無関係）。厳密版（plan.md 7 節 Check 5）では 0 件のため受け入れ条件は満たす。

## Scope Discipline

- plan.md に明示されていない変更は行なっていない
- 温存:
  - `stopDaemon(state)` 関数定義（onReload / shutdown / onFullQuit で使用中）
  - `proxyPortChanged` / `proxy_port_changed` イベント（proxy 再利用時の Master 再接続として独立機能）
  - `daemon_reload` / dashboard `r` キー（ユーザー明示操作経路）
  - `daemon_reload_target` ログ
  - `state.fileWatcherAbort` 系（onReload 冒頭の watcher 停止順序を維持）
  - `releasePidFile(pidFilePath)` の呼び出し順序（onReload の exec 直前 release は維持）
- `readdir` import は `restoreMasters` で使用中のため残置（`stat` のみ削除）
