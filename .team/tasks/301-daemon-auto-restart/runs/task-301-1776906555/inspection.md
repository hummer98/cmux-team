# T301 Inspection — daemon auto-restart 機能の完全廃止

- Run ID: `task-301-1776906555`
- Branch (worktree): `task-301-1776906555/task`
- Base: `main` @ `15665ed`
- Inspector: inspector Agent（独立セッション）
- 対象 worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-301-1776906555`

## Verdict: **GO**

## Summary

plan.md のサブタスク 1–7 すべてが impl-report の報告通りに実装されており、受け入れ条件の grep は厳密版・拡張版ともに 0 件、`bun test` 1083/1083 pass、`bunx tsc --noEmit` は本タスクで新規に発生したエラー 0 件（既存 3 件のみ、`daemon.ts` の行番号が削除分だけシフト）。温存すべき `stopDaemon` / `proxyPortChanged` / `daemon_reload` / `onReload` / `readdir` は全て残存しており、削除禁止領域への巻き込みも確認できなかった。critical / major 所見なしで GO 判定。

## Findings

所見なし（critical / major / minor いずれも 0 件）。

## Verification Evidence

### 1. 変更ファイル一覧と統計

```
$ git diff --stat
 CLAUDE.md                                  |  4 +--
 bin/cmux-team.js                           | 32 +++---------------
 docs/spec/05-install-and-infrastructure.md |  7 ++--
 docs/spec/06-implementation-tasks.md       |  5 ++-
 skills/cmux-team/manager/daemon.ts         | 54 +-----------------------------
 skills/cmux-team/manager/main.ts           | 53 +++++------------------------
 6 files changed, 21 insertions(+), 134 deletions(-)
```

plan.md §3「変更対象」と完全一致。新規作成・削除ファイルなし。

### 2. 受け入れ条件 grep（plan.md §4 サブタスク 6 + 受け入れ条件）

| # | コマンド | 結果 |
|---|---|---|
| 1 | `grep -rnE 'source_changed\|daemon_auto_restart\|initSourceWatcher\|checkSourceChanged\|sourceMtimes\|restartRequested' skills/cmux-team/manager/` | **0 件** |
| 2 | `grep -rnE 'source_changed\|daemon_auto_restart\|initSourceWatcher\|checkSourceChanged\|sourceMtimes\|auto[-_]restart\|自動再起動\|exit[ _]code[ _]?42\|exit\(42\)\|status === 42' docs/ CLAUDE.md README*.md` | **0 件** |
| 3 | `grep -rnE 'MAX_RESTARTS\|status === 42\|auto-restart' bin/` | **0 件** |
| 4 | `grep -rnE 'exit\(42\)\|status === 42\|\bexit 42\b' bin/ skills/cmux-team/manager/ docs/ CLAUDE.md` | **0 件** |

全 4 項目で 0 件。impl-report が false positive として言及していた greedy `exit.*42` の 2 件（`bun.lock`, `docs/spec/05 L422`）は、本検品の厳密パターンでは検出されないため改めて確認する必要なし。

### 3. daemon.ts 関連の削除確認

```
$ grep -nE '^import.*from "fs/promises"' skills/cmux-team/manager/daemon.ts
4:import { readdir, readFile, writeFile, mkdir, watch, rename } from "fs/promises";
```

- `stat` import は削除済み（impl-report §Files Changed と一致）
- `readdir` は `daemon.ts:664` `restoreMasters` で使用中のため温存（plan.md §4 サブタスク 3 指示通り）

```
$ grep -nE '\bstat\(' skills/cmux-team/manager/daemon.ts
(0 件)
```

`stat` 参照も完全削除。

### 4. main.ts 関連の削除確認

```
$ grep -n 'initSourceWatcher\|restartRequested\|daemon_reload_restart' skills/cmux-team/manager/main.ts
(0 件)
```

- `initSourceWatcher` の import / 初期化呼び出し
- `if (state.restartRequested) { ... process.exit(42); }` ブロック
- `daemon_reload_restart` ログイベント
- `MAX_RESTARTS` while ループ

以上すべて削除済み。`onReload` の置換は plan.md §4 サブタスク 4 の指示通り単発 `execFileSync` + `process.exit(0)` になっており（main.ts L710-720）、`stopDaemon(state)` / `state.fileWatcherAbort?.abort()` / `releasePidFile(pidFilePath)` の順序も維持されている。

### 5. bin/cmux-team.js の統合確認

```
$ grep -c 'execFileSync' bin/cmux-team.js
（1 箇所のみ、全コマンド共通経路）
```

`if (args[0] === "start")` 分岐が削除され、すべてのコマンドが単発 `execFileSync` を通る共通経路に統合されている。plan.md §4 サブタスク 5 の指示通り。

### 6. CLAUDE.md L435 書き換え確認

```
pidfile は onReload / onFullQuit /
shutdown 全経路で release され、正常系では
```

旧 `restartRequested / onReload` → 新 `onReload / onFullQuit / shutdown` に置換されており plan.md §3 の指示と一致。

### 7. 温存すべきシンボルの残存確認

| シンボル | 存在箇所 | 用途 |
|---|---|---|
| `stopDaemon` 関数定義 | `daemon.ts:359` | onReload / shutdown / source_changed でない他経路で必要 |
| `stopDaemon` 呼び出し | `daemon.ts:2294`, `main.ts:669, 703, 759` | shutdown / onReload / onFullQuit 等 |
| `proxyPortChanged` フィールド | `daemon.ts:89, 338, 794, 801, 804` + test + `main.ts:633` | proxy 再利用時の Master 再接続（独立機能） |
| `proxy_port_changed` ログ | `main.ts:634` | 同上 |
| `daemon_reload` / `daemon_reload_target` | `main.ts:700-701` | dashboard `r` キー経由のユーザー操作ログ |
| `onReload` | `main.ts:697`, `dashboard.tsx:1157, 1678` | 明示的再読み込み経路 |
| `state.fileWatcherAbort` 系 | `main.ts:704-705` | onReload 冒頭の watcher 停止 |
| `readdir` import | `daemon.ts:4` | `restoreMasters`（L664）で使用中 |

plan.md の「変更対象外」と完全一致。

### 8. tsc 新規エラー 0 件の検証

```
$ cd skills/cmux-team/manager && bunx tsc --noEmit 2>&1 | head -10
conductor.ts(201,3): error TS1016: A required parameter cannot follow an optional parameter.
daemon.test.ts(3870,9): error TS2322: Type '"new_session"' is not assignable to type ...
daemon.ts(1546,22): error TS2352: Conversion of type 'string | undefined' to type ...
```

main ブランチ（着手前）との比較:

```
$ (main 側) bunx tsc --noEmit
conductor.ts(201,3): error TS1016: ...
daemon.test.ts(3870,9): error TS2322: ...
daemon.ts(1598,22): error TS2352: ...
```

- 件数: 3 件 → 3 件（変化なし）
- 種類: 全て既存エラーで一致
- `daemon.ts` TS2352 の行番号が `1598 → 1546`（削除分 52 行の繰り上がり）だけ変動、エラー内容は同一
- **本タスクで新規発生したエラーは 0 件**

### 9. bun test 結果

```
$ cd skills/cmux-team/manager && bun test
 1083 pass
 0 fail
 2528 expect() calls
Ran 1083 tests across 36 files. [49.45s]
```

impl-report の報告（1083 / 1083 pass）と一致。破壊されたテストはなし。

### 10. plan.md §4 サブタスクの実施状況

| サブタスク | 検証観点 | 結果 |
|---|---|---|
| 1. ドキュメント先行削除 | `docs/spec/05`, `06`, `CLAUDE.md` の該当行が書き換えられているか | diff で全件確認 ✓ |
| 2. テスト再確認 | `manager/*.test.ts` の grep 0 件 | Check 1 に含めて 0 件 ✓ |
| 3. `daemon.ts` 削除 | 関数・フィールド・import 削除 | 確認済み ✓ |
| 4. `main.ts` 削除 | import / 初期化 / restart ブロック / onReload 置換 | 確認済み ✓ |
| 5. `bin/cmux-team.js` | 分岐削除・統合 | 確認済み ✓ |
| 6. grep 確認 | 3 種類 0 件 | 実行済み ✓ |
| 7. tsc / bun test | 新規エラー 0 件 / 1083 pass | 実行済み ✓ |
| 8. 手動 E2E | Conductor 引き継ぎ | 本検品対象外（plan.md §4 サブタスク 8 注記と整合） |

### 11. impl-report の鵜呑み回避のための独立検証

- 受け入れ grep を本検品セッションで再実行 → 全て 0 件確認
- tsc を worktree と main の両方で実行し件数・種類を直接比較 → 新規エラー 0 件確認
- `bun test` を本検品セッションで実行 → 1083 pass 確認
- `stat` import / 参照を個別 grep → 0 件確認
- `readdir` の使用箇所を確認 → `restoreMasters` L664 で使用中のため温存が正当
- `onReload` 置換コード本体を Read で確認 → plan.md §4 サブタスク 4 指示通り

## Fix Required

なし（GO のため）。

## 補足（Conductor 引き継ぎ項目）

本検品で到達していないが、plan.md §4 サブタスク 8 に記載の手動 E2E は Conductor が後工程で実施すること:

1. 既存 daemon があれば `cat .team/daemon.pid | xargs kill` で停止
2. `cmux-team start` で再起動（`daemon_started` ログ確認）
3. `cmux-team status` で Conductor 一覧取得
4. 簡単なタスク 1 件を `ready` 昇格 → 割当 → close まで通す
5. `.team/logs/manager.log` に以下が **1 件も新規発火しない** こと
   - `source_changed`
   - `daemon_auto_restart`
   - `daemon_reload_restart`
6. TUI で `r` キー → reload 経路が `daemon_reload` / `daemon_reload_target` ログを出しつつ正常に単発 exec で起動すること
