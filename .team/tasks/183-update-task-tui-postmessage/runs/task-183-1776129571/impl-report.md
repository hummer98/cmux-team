# 実装レポート: update-task の TUI 即時反映（TASK_UPDATED 追加）

## 変更ファイル一覧

| ファイル | 変更概要 |
|---------|---------|
| `skills/cmux-team/manager/schema.ts` | `TaskUpdatedMessage` zod スキーマを追加し、`QueueMessage` discriminated union に組み込み、型エクスポートを追加 |
| `skills/cmux-team/manager/daemon.ts` | `handleMessage` に `case "TASK_UPDATED"` を追加（`task_updated` ログ + `requestWakeup`） |
| `skills/cmux-team/manager/main.ts` | (1) `cmdSend` の `TASK_UPDATED` ケースと usage 行に追記、(2) `cmdUpdateTask` で TASK_CREATED を送らなかった場合に TASK_UPDATED を送る、(3) `cmdCloseTask` の conductor 不在時に TASK_UPDATED を送る、(4) `cmdAbortTask` の no-conductor 早期 return パスで TASK_UPDATED を送る、(5) `cmdDeleteTask` の末尾で TASK_UPDATED を送る |
| `skills/cmux-team/manager/i18n.ts` | 英/日 両方の `help_send` に `TASK_UPDATED` の定義ブロックを追加 |
| `skills/cmux-team/manager/queue.test.ts` | `TASK_UPDATED` をキューに送信・読み取りできることを検証するテスト追加 |
| `skills/cmux-team/manager/daemon.test.ts` | `handleMessage(TASK_UPDATED)` で `state.wakeupPending` が true になることの単体テスト追加 |
| `skills/cmux-team/manager/main.test.ts` | CLI subprocess + mock HTTP サーバーで各コマンドからの postMessage 内容を検証する統合テスト 6 件追加 |

## 追加/変更したテスト

### 1. `queue.test.ts`
- `"TASK_UPDATED メッセージを送信・読み取りできる"`

### 2. `daemon.test.ts`
- `describe("handleMessage: TASK_UPDATED")` を新設
- `"TASK_UPDATED は requestWakeup を発火させる"`

### 3. `main.test.ts`（新規 describe: `TASK_UPDATED postMessage (T183)`）

mock HTTP server を `port 0` で起動し CLI を `bun run main.ts` で subprocess 実行する統合テスト。
- `update-task: --title のみで TASK_UPDATED が送信される（TASK_CREATED は送らない）`
- `update-task: status=ready では TASK_CREATED のみ（TASK_UPDATED は送らない）` — 既存動作の回帰確認
- `update-task: status=draft への変更で TASK_UPDATED が送信される`
- `delete-task: TASK_UPDATED が送信される`
- `close-task: conductor 不在時に TASK_UPDATED が送信される`
- `abort-task: no-conductor 早期 return パスで TASK_UPDATED が送信される`
- `後方互換: proxy が TASK_UPDATED を 400 で返しても CLI は成功する`（古い daemon + 新 CLI の互換検証）

## 実装詳細メモ

### cmdUpdateTask
`notifiedTaskCreated` フラグを導入。status=ready 遷移では既存通り TASK_CREATED のみを送り、それ以外（title/body/depends-on の更新、および ready 以外への status 変更）では TASK_UPDATED を送る。

### cmdAbortTask（no-conductor 早期 return パス）
`findTaskFile(taskId)` を呼び直して taskFile パスを解決してから TASK_UPDATED を送る。conductor 不在でも `taskState` は aborted に遷移しているため、TUI が即時反映される。

### cmdCloseTask
conductor が見つかる場合は既存の CONDUCTOR_DONE で wakeup 発火するため追加送信なし。`else` 分岐で TASK_UPDATED を送る。

### cmdDeleteTask
末尾の `console.log` 直前に TASK_UPDATED の送信を追加。

### 後方互換性
古い daemon（TASK_UPDATED を知らない版）が新 CLI からメッセージを受信した場合、`proxy.ts:222-234` の zod parse 失敗経路で 400 が返る。CLI 側の `postMessage` は `try { fetch(...) } catch { /* 無視 */ }` で包まれているが、400 レスポンスは fetch が throw せずに解決する点に注意した。実装では `postMessage` が res.ok を見ていないためレスポンスコードによらず続行される（統合テストで検証済み）。

## テスト結果

### `bun test`
```
 174 pass
 0 fail
 371 expect() calls
Ran 174 tests across 11 files. [10.07s]
```

全テスト PASS。新規追加テスト 8 件（schema 1 + daemon 1 + CLI 統合 6）も含む。

### `bun run tsc --noEmit`
変更対象ファイルに起因する新規エラーなし。出力される 5 件のエラーは全て **本タスク変更前から存在する既存のエラー**:
- `cmux.ts(22,5)` — execFile 型不整合（既存）
- `dashboard.tsx(372,5), (952,11)` — WidgetVariant 型（既存）
- `main.test.ts(82,3)` — 既存テストの `match()` 戻り値型（既存）
- `main.ts(447,42)` — 既存処理の null 扱い（既存）

`git stash` で変更を退避した状態で同一のエラーが出ることを確認済み。本タスクで追加したファイル（schema/daemon/main/i18n/テスト）には新規 TS エラーは発生していない。

## 実装中に発生した問題と解決

### 1. main.test.ts の subprocess 起動
既存のテストには CLI を subprocess で起動するパターンが無かったため、`spawn("bun", ["run", "main.ts", ...])` + mock HTTP サーバー（node の `http` モジュール）で組み合わせた。`port 0` でランダムポートを取り、`.team/proxy-port` に書き込む。

### 2. `postMessage` のエラーハンドリング
400 レスポンス時の挙動を確認するため、mock サーバーを差し替える後方互換テストを実装した。`postMessage` は fetch を `try/catch` で包むのみ（レスポンスの `ok` チェックなし）だが、テスト結果から CLI は続行して正常終了することが確認できた。

### 3. 既存 TS エラー
プロジェクト全体で既存の TS エラーが 5 件あり、`tsc --noEmit` が非ゼロ終了する。本タスクの変更前後で差分なしを確認した上で、実装を完了扱いとした。
