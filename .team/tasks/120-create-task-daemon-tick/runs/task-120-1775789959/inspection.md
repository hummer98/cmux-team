# T120 検品結果

**判定**: GO

plan.md の Step 1〜8 が過不足なく実装され、bun test は 70 pass / 0 fail で 2.17 秒完走・ハングなし。wakeupPending による tick 中取りこぼし解消、再帰 fs.watch + `.team/task-state.json` フィルタ監視、AbortController による決定論的停止、shutdown パス 3 箇所の abort 呼び出し、`CMUX_TEAM_POLL_INTERVAL` ポーリングのフェイルセーフ維持、すべて確認。実機 E2E スクリプトでも tick-中 wakeup 0.10ms / sleep-中 wakeup 10.59ms / setTimeout 100.87ms と受け入れ条件を余裕で満たす。再帰 fs.watch も `sub/task.md` のイベントまで実機で拾えることを確認した。

## 受け入れ条件チェック

| # | 条件 | 検証方法 | 結果 |
|---|---|---|---|
| 1 | `create-task --status ready` で 1 秒以内に反応 | TASK_CREATED → `requestWakeup` (daemon.ts:452) + fs.watch 再帰経路の二重保証。単体テストで wakeup < 50ms、fs.watch < 300ms を確認 | ✅ |
| 2 | `update-task --status ready` / `close-task` / `delete-task` / `abort-task` で即時反応 | `.team/task-state.json` を `.team` 非再帰 watcher + filename フィルタで監視（daemon.ts:158-178）。`saveTaskState` 経路の統合テスト 1 件 pass | ✅ |
| 3 | tick 実行中の複数通知が取りこぼされない | `wakeupPending` フラグで `state.wakeup === null` の間も記録。`sleepUntilWakeup` 冒頭の早期 return で消化（daemon.ts:220-226）。tick ループ相当テスト（5 回割り込み合計 < 100ms）pass | ✅ |
| 4 | HTTP 通知失敗時に fs.watch フェイルセーフが ~200ms 以内で反応 | 再帰 watch + 50ms debounce + tick（実測 <100ms） + scheduleRefresh 100ms = 〜200ms。統合テスト 300ms 内に `wakeupPending=true` を確認 | ✅ |
| 5 | `CMUX_TEAM_POLL_INTERVAL` のポーリングがフェイルセーフとして維持 | `createDaemon` (daemon.ts:95) で env 読込、`sleepUntilWakeup` の `setTimeout(..., state.pollInterval)` で満了経路健在。単体テスト「setTimeout 満了で resolve」pass | ✅ |
| 6 | `watcher.close()` / リーク対策が維持 | finally 節で `(watcher as any).close?.()` を冪等に呼ぶ（daemon.ts:191）+ AbortController で for-await 決定論的停止。bun test が 2.17 秒で exit することで検証 | ✅ |

## 手動 E2E 結果

### A. bun test 完走確認

```
 70 pass
 0 fail
 162 expect() calls
Ran 70 tests across 6 files. [2.17s]
```

`bun test 2>&1  0.20s user 0.18s system 17% cpu 2.179 total` — ハングなし、即 exit。実行時間 2.17 秒で目安 60 秒を大きく下回る。既存 70 テスト中、T120 で追加した wakeup 5 + fs.watch 3 = 8 ケースを含む全てが pass。

### B. requestWakeup 実機動作

`/tmp/t120-e2e.ts` を作成・実行（実 daemon.ts を import、一時 projectRoot で `createDaemon(projectRoot)` ※実装の実シグネチャは単引数）:

```
tick-中 wakeup: 0.10ms
sleep-中 wakeup: 10.59ms
setTimeout: 100.87ms
```

- **tick-中 wakeup**: 事前に `requestWakeup` で `wakeupPending=true` にした状態で `sleepUntilWakeup` を await → 早期 return で 0.10ms。50ms 未満の目標を大幅クリア。
- **sleep-中 wakeup**: sleep 突入後 10ms で `requestWakeup` → `state.wakeup()` 経由で 10.59ms で resolve。10ms のタイマ遅延分のみ、オーバーヘッド 0.59ms。
- **setTimeout 満了**: `pollInterval=100` で何も介入せず 100.87ms で resolve。目標どおり pollInterval ベースのフェイルセーフが健在。

実機で wakeup 経路は 50ms を全く寄せ付けない速度で動作。

### C. grep 静的チェック

```
$ grep -n "state\.wakeup" skills/cmux-team/manager/daemon.ts
210: * sleep 中なら state.wakeup?.() が resolve を呼び即座に起床する。
213:  state.wakeupPending = true;
214:  state.wakeup?.();
221:    if (state.wakeupPending) {
222:      state.wakeupPending = false;
223:      // 不変条件「sleep 関数完了時点で state.wakeup は常に null」を維持
224:      state.wakeup = null;
229:      state.wakeup = null;
230:      state.wakeupPending = false;
233:    state.wakeup = () => {
235:      state.wakeup = null;
236:      state.wakeupPending = false;
```

`state.wakeup?.()` の直接呼び出しは **L214（`requestWakeup` 内）の 1 箇所のみ**。`handleMessage` も `requestWakeup(state)` 呼び出しに置換済み（daemon.ts:452）。L210 はドキュメントコメントなので実コード 0 件。plan.md の Step 5 の期待通り。

```
$ grep -n "fileWatcherAbort" skills/cmux-team/manager/main.ts
257:    state.fileWatcherAbort?.abort();
258:    state.fileWatcherAbort = null;
275:    state.fileWatcherAbort?.abort();
276:    state.fileWatcherAbort = null;
355:    state.fileWatcherAbort?.abort();
356:    state.fileWatcherAbort = null;
```

3 箇所すべての shutdown 経路（SIGINT/SIGTERM/onQuit → `shutdown()`, `onReload`, `onFullQuit`）で abort + null クリアが揃っている。

### D. 再帰 fs.watch 実機動作

検品用スクリプトでサブディレクトリ内 `task.md` 作成を全イベント収集:

```
events: ["rename:sub","rename:sub/task.md"]
```

`rename:sub`（サブディレクトリ作成）と `rename:sub/task.md`（サブディレクトリ内のファイル作成）の**両方**が拾えた。`{ recursive: true }` は macOS / Bun 1.3.11 で期待通り動作し、NNN-slug/task.md 構造のタスク作成を確実に検知できる。

AbortController による停止も合わせて検証:「AbortSignal を渡した watch は `ac.abort()` で for-await ループが AbortError を出して抜ける」を別スクリプトでも確認済み。

## コード品質観点

- **規約**: コメントは日本語、識別子は英語。CLAUDE.md 準拠 ✅
- **ロギング**: `log("file_watch_failed", ...)` は `*_failed` パターンに準拠。`.catch(() => {})` で log 失敗を握り潰すのは冪等な後処理扱い ✅
- **AbortError 分岐**: `if (e?.name === "AbortError") return;` が catch 先頭にあり、停止時の余計なエラーログを抑制 ✅
- **空 catch**: `finally` の `try { (watcher as any).close?.(); } catch {}` のみ。冪等後処理として CLAUDE.md のロギングポリシーで許容 ✅
- **dead code / 後方互換**: `state.wakeup?.()` の直接呼び出しは全置換され残存 0。古い `initFileWatcher` のロジックは残っていない ✅
- **package-lock.json**: `git diff main..HEAD --stat` には含まれず、worktree の unstaged 変更のみ（3.29.0 → 3.32.0、impl-report.md どおり本タスク無関係） ✅
- **変更規模**: daemon.ts +79/-12、main.ts +6、daemon.test.ts +173/-1。plan.md の変更範囲に完全一致 ✅
- **初期化**: `createDaemon` で `wakeupPending: false`, `fileWatcherAbort: null` を明示初期化（daemon.ts:107-108）、DaemonState インターフェースに追加（daemon.ts:61-64） ✅

## テスト品質観点

- **wakeup 5 ケース網羅**: plan.md Step 4 の 1〜5 と一致（tick 中 / sleep 中 / setTimeout / 連続 requestWakeup / tick ループ相当）✅
- **時間閾値**: tick 中/sleep 中は `< 50ms`、setTimeout は `>= 45ms`、tick ループ 5 回は `< 100ms`。CI のジッタに対して安全圏 ✅
- **tick ループテスト**: `pollInterval = 1_000` をタイムアウト保険に設定し、5 回の割り込み消化が pollInterval 未満で終わることを検証。取りこぼしゼロをフラッピングなしで保証 ✅
- **fs.watch 3 ケース**: サブディレクトリ task.md / task-state.json / `.team/output/` 非発火。ケース 3 の待機 1000ms で macOS fs.watch のゆらぎ吸収 ✅
- **afterEach クリーンアップ**: `watcherState.fileWatcherAbort?.abort()` + `running = false` で watcher が確実に死ぬ。実行結果（2.17 秒で exit）がハング無しを裏付ける ✅
- **ポーリング探査の刻み**: 10ms × 30 回の `for` ループで wakeupPending を監視。300ms ウィンドウ内で確実に検出 ✅

## 問題点・リスク

重大な問題なし。軽微な観察事項:

- **tick ループテスト（ケース 5）のコメント**: plan.md では `pollInterval = 1000` と明記、実装は `1_000`。数値リテラルの表記が異なるが同値のため問題なし。
- **`createDaemon` のシグネチャ**: plan.md の E2E サンプルは `{ projectRoot, workspace, pollInterval }` 形式だが、実装は `createDaemon(projectRoot: string)` 単引数 + `state.pollInterval` 直接代入。Inspector 用スクリプトはこの差を吸収する形で書いた（E2E 成功）。実装側の変更は不要。
- **`.team` 非再帰 watcher の対象外ファイル**: `.team/proxy-port` 等の直下ファイル書き換えでも filename フィルタ（`task-state.json` / `.tmp` 以外）で確実に弾かれる設計。fs.watch 統合テストのケース 3（`.team/output/`）でフィルタの動作は確認済み。ただし `.team` 直下に `task-state.json` 以外のファイルが書かれるケースは将来増える可能性がある — 問題が起きたら filename 条件を見直す。今回のスコープでは許容。
- **`wakeupPending` ログなし**: 現状の設計では `requestWakeup` 呼び出しを状態遷移ログとして残していない。将来デバッグ時に「どの経路で wakeup が発火したか」を追跡したくなる可能性はあるが、plan.md のスコープ外なので今回は記録不要と判断。

以上、受け入れ条件達成と実装品質が確認できたため **GO** 判定とする。
