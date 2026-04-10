# Design Review 結果 — T120 (再レビュー)

**判定**: Approved

前回指摘した必須修正 4 点（AbortController ベースの watcher 停止、throttle 50ms 化、Step 5 grep 検証コマンド明記、Step 3 早期 return 分岐での `state.wakeup = null` 追加）はいずれも反映済み。推奨修正 5 点も全て取り込まれている。`main.ts` の shutdown 経路 3 箇所（`main.ts:255-260` shutdown, `main.ts:272` onReload, `main.ts:350` onFullQuit）への abort 呼び出し追加指示も現状コードと整合している。改訂による新しいバグ・矛盾は検出できず、変更ファイル一覧・リスクテーブル・スコープ外記載も一貫している。Implementer が着手できる状態と判断する。

## 必須修正の反映状況

1. **AbortController 停止メカニズム: 反映済**
   - Step 1 の `DaemonState` 追加フィールドに `fileWatcherAbort: AbortController | null` を明記
   - Step 6 の `initFileWatcher` 実装例で `const ac = new AbortController(); state.fileWatcherAbort = ac;` を導入し、各 `watch(dir, { recursive, signal: ac.signal })` にシグナルを伝搬
   - catch 節に `if (e?.name === "AbortError") return;` を入れて正常終了扱いに分岐
   - `main.ts` の `shutdown()` / `onReload` / `onFullQuit` 内（計画書に `255-260, 272, 350` と明記）で `state.fileWatcherAbort?.abort()` を呼ぶ指示あり
   - 注: 計画書は「戻り値で AbortController を返す」代替案ではなく「`state.fileWatcherAbort` に内部でセットする」形を採用している。前回レビューの代替案として許容したパターンであり、テストからは `state.fileWatcherAbort?.abort()` で決定論的に閉じられるため要件を満たす

2. **throttle 50ms: 反映済**
   - Step 6 の `schedule()` 内 `setTimeout(() => { ...; requestWakeup(state); }, 50)` と明記
   - 計画書冒頭の「受け入れ条件 200ms 以内の内訳」表で 50ms debounce + tick 100ms + refresh 100ms = 200ms という根拠も付与されている

3. **Step 5 grep コマンド: 反映済**
   - Step 5 検証欄に具体コマンド `grep -n "state\.wakeup" skills/cmux-team/manager/daemon.ts` を記載
   - 期待結果も「`sleepUntilWakeup` 内の定義・代入と `requestWakeup` 内の `state.wakeup?.()` のみが残り、それ以外の `state.wakeup?.()` 呼び出しは 0 件」と具体化されている

4. **Step 3 `state.wakeup = null` 追加: 反映済**
   - `wakeupPending === true` 早期 return 分岐に `state.wakeup = null` を追加
   - コメントで「型上は `(() => void) | null` なので将来の変更で壊れないよう防衛的にクリアする」と意図を明記
   - 加えて `重要` 見出しで「不変条件（sleep 関数が完了した時点で `state.wakeup` は常に null）」を明文化しており、将来の保守観点でも強化されている

## 推奨修正の反映状況

- **Step 4 の多重 wakeup 統合テスト（ケース 5）: 反映済**
  - 「tick ループ相当: requestWakeup を複数回割り込ませても全て消化される」を 5 ケース目として追加
  - `pollInterval = 1000ms` の余裕設定、5 ループ合計 100ms 未満という具体的な合格基準あり
- **Step 7 テスト 3 の待機時間延長: 反映済**
  - 「500ms → 1000ms に延長」と本文内に明記、flaky 抑制の理由も付記
- **`saveTaskState` のイベント数コメント: 反映済**
  - Step 6 の 50ms debounce 理由に「`.tmp` と `task-state.json` のイベントは十分同一バッチに収まる」「片方しかイベントが届かない環境でも schedule が 1 回走れば十分」と明示
- **watcher 変数スコープコメント: 反映済**
  - Step 6 のコード片上部に「watcher を try の外側（IIFE 直下）で宣言して finally からアクセス可能にする」の Implementer 向け注釈あり
- **`file_watch_failed` ログイベント名: 反映済**
  - catch 内 `log("file_watch_failed", \`dir=${dir} ${e.message}\`).catch(() => {})` とイベント名を `*_failed` パターンに変更
  - 計画末尾のコーディング規約再確認欄でも CLAUDE.md ロギングポリシーへの整合を明示

## 新たな指摘

- **(情報共有・修正不要)** Step 6 の `log("file_watch_failed", ...).catch(() => {})` は fire-and-forget の安全化として妥当。既存 `daemon.ts:162` は `.catch` なしで fire-and-forget だったため、改善方向の変更になっている。
- **(情報共有・修正不要)** `main.ts` の実際の行番号を確認したところ、計画書の `255-260`（shutdown）・`272`（onReload 内 `state.running = false`）・`350`（onFullQuit 内 `state.running = false`）は現状コードと一致している。Implementer が作業時に行番号ズレを起こしても文脈（`shutdown` 関数 / `onReload` コールバック / `onFullQuit` コールバック）で特定できる書き方になっている。
- **(情報共有・修正不要)** 変更ファイル一覧の `daemon.ts` 欄に「`fileWatcherAbort` 追加」「AbortController 連携」「`file_watch_failed` ログ」「`AbortError` 分岐」「早期 return 分岐での `state.wakeup = null` 含む」まで漏れなく追記されており、前回レビューの末尾要望もクリアされている。

## Recommendations（Planner 向け、Changes Requested 時のみ）

- 該当なし（Approved）
