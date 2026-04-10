# T120 実装レポート — create-task 直後の daemon 即時反応

## 概要

`cmux-team create-task --status ready` 等の CLI 実行後、daemon の tick 反映まで最大 ~10 秒かかる現象を解消した。plan.md の Step 1〜8 を実装（Step 9 の手動 E2E は Inspector の範囲）。

## 変更ファイル一覧

| ファイル | 変更内容 |
|---|---|
| `skills/cmux-team/manager/daemon.ts` | `DaemonState.wakeupPending: boolean` と `DaemonState.fileWatcherAbort: AbortController \| null` を追加。`requestWakeup` 関数を追加。`sleepUntilWakeup` を `wakeupPending` ベースに書き換え（早期 return 分岐での `state.wakeup = null` 含む）。`initFileWatcher` を再帰監視（`.team/tasks`）+ `.team` 非再帰監視（filename で `task-state.json` のみ許可）+ 50ms debounce + AbortController 連携 + `file_watch_failed` ログ + AbortError 分岐に書き換え。`handleMessage` の TASK_CREATED で `state.wakeup?.()` を `requestWakeup(state)` に置換 |
| `skills/cmux-team/manager/main.ts` | `shutdown()` / `onReload` / `onFullQuit` の 3 箇所で `state.running = false` 直後に `state.fileWatcherAbort?.abort(); state.fileWatcherAbort = null;` を追加 |
| `skills/cmux-team/manager/daemon.test.ts` | wakeup 単体テスト 5 ケース + fs.watch 統合テスト 3 ケースを追加。`afterEach` で `fileWatcherAbort?.abort()` を呼び決定論的にクリーンアップ |

※ 初期 `git status` 時点で既に修正されていた `package-lock.json`（`3.29.0 → 3.32.0`）は本タスクとは無関係のためコミットから除外。

## 追加テストケース数と結果

- wakeup 単体テスト: **5 ケース追加**
  1. tick 中に requestWakeup → 次の sleep は即 resolve（< 50ms）
  2. sleep 中に requestWakeup → 即 resolve（< 50ms）
  3. setTimeout 満了で resolve（pollInterval=50ms）
  4. sleep 中の連続 requestWakeup で timer リークなし
  5. tick ループ相当: 5 回割り込み → pollInterval に達せず合計 < 100ms で完了
- fs.watch 統合テスト: **3 ケース追加**
  1. サブディレクトリ `task.md` 作成で `wakeupPending === true`（300ms 以内）
  2. `saveTaskState` による `task-state.json` 更新で `wakeupPending === true`（300ms 以内）
  3. `.team/output/foo.txt` 作成では `wakeupPending` が立たない（1000ms 待機）

## `bun test daemon.test.ts` の実行結果

```
 26 pass
 0 fail
 57 expect() calls
Ran 26 tests across 1 file.
```

`bun test`（manager/ 全体）:

```
 70 pass
 0 fail
 162 expect() calls
Ran 70 tests across 6 files.
```

全テスト pass。既存テストへの回帰なし。`afterEach` の AbortController 停止により bun test はハングせず即 exit する。

## `grep -n "state\.wakeup" daemon.ts` の結果

```
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

期待通り、`requestWakeup` 内の 1 箇所（L214）を除き、`state.wakeup?.()` の直接呼び出しは **0 件**。`sleepUntilWakeup` 内の代入・クリア（L222, L224, L229, L230, L233, L235, L236）と `requestWakeup` 内の呼び出し（L213, L214）だけが残る。L210 はドキュメントコメント。

## 型検査

`bunx tsc --noEmit` の結果:

```
dashboard.tsx(343,5): error TS2322: Type '"unstyled"' is not assignable to type 'WidgetVariant | undefined'.
dashboard.tsx(863,11): error TS2322: Type '"unstyled"' is not assignable to type 'WidgetVariant | undefined'.
```

上記 2 件は `dashboard.tsx` の既存の型エラーで、**本タスクとは無関係**。今回変更した `daemon.ts`, `daemon.test.ts`, `main.ts` には型エラーなし。

## 計画からの逸脱

**逸脱なし**。plan.md の Step 1〜8 をそのまま実装。Step 9 の手動 E2E 検証は Inspector の範囲外として実施しなかった。

## Inspector 向け検品観点メモ

### 受け入れ条件の検証ポイント

1. **tick 中の取りこぼし**: Step 4 のテストケース 1（「tick 中に requestWakeup → 次の sleep は即 resolve」）とケース 5（tick ループ相当 5 回）が主要な回帰防止。`wakeupPending` をクリアするパスが 3 箇所（早期 return、timer 満了、wakeup コールバック）にあることを確認。

2. **再帰 fs.watch**: Step 7 のテストケース 1（サブディレクトリ `task.md`）で Bun 1.3 の `{ recursive: true }` が macOS 上で動作することを確認済み。

3. **task-state.json の監視**: Step 7 のテストケース 2 で `saveTaskState` → rename → watch event → debounce → `requestWakeup` の連鎖が 300ms 以内に動くことを確認。`delete-task` の即時反応はこの経路でカバーされる。

4. **非対象ディレクトリの除外**: Step 7 のテストケース 3 で `.team/output/foo.txt` が `wakeupPending` を立てないことを確認。`.team` 直下 watcher は `recursive: false` + filename フィルタで `task-state.json` 以外を弾いている。

5. **AbortController 停止**: `afterEach` で `fileWatcherAbort.abort()` を呼ぶことで bun test が決定論的に終了する。**実装上の注意点は、shutdown パス 3 箇所（SIGINT/SIGTERM、onReload、onFullQuit）すべてで abort を呼んでいること**。grep で `fileWatcherAbort?.abort()` の出現箇所を確認可能:

```
$ grep -n "fileWatcherAbort" skills/cmux-team/manager/main.ts
257:    state.fileWatcherAbort?.abort();
258:    state.fileWatcherAbort = null;
275:      state.fileWatcherAbort?.abort();
276:      state.fileWatcherAbort = null;
355:      state.fileWatcherAbort?.abort();
356:      state.fileWatcherAbort = null;
```

### 手動 E2E（Step 9）で Inspector が確認すべきポイント

- **wakeup 即時性**: `cmux-team create-task --status ready` 後、`.team/logs/manager.log` の `task_received` まで 1 秒以内
- **HTTP 通知失敗時のフォールバック**: `.team/proxy-port` を一時破壊 → `create-task` → fs.watch 経路で 300ms 以内に tick
- **delete-task の即時反応**: `cmux-team delete-task --task-id N` → `task-state.json` 書き換えを fs.watch が拾う
- **10 秒ポーリング（フェイルセーフ）**: `CMUX_TEAM_POLL_INTERVAL=3000` で watcher を無効化した状態でも 3.5 秒以内に tick が回ること

### 既存機能への影響

- `handleMessage` の他の case（CONDUCTOR_DONE, SESSION_ENDED 等）は変更なし — `state.wakeup?.()` 呼び出しがもともと無かったため
- `scheduleRefresh` の 100ms debounce も変更なし
- `proxy.ts`, `task.ts` も変更なし（`saveTaskState` の rename は既存のままで OK）
