# Design Review: T151

## 判定: Changes Requested

## Findings

### [Critical] resetConductor での sessionId クリアは通常完了フローを破壊する

- **場所**: conductor.ts L507（Step 2-4 の変更対象）
- **問題**: 計画では `resetConductor` 内で `conductor.sessionId = undefined` を設定するとしているが、通常のタスク完了フローでは Conductor の Claude セッションは永続的に動き続ける（`/clear` で次タスクを待機するだけで、プロセスは再起動しない）。resetConductor は `handleConductorDone`（daemon.ts L1062）と `forceCloseDisconnectedConductor`（daemon.ts L1038）の2箇所から呼ばれる。

  **通常完了フロー（handleConductorDone 経由）:**
  1. タスク完了 → CONDUCTOR_DONE → handleConductorDone → resetConductor
  2. resetConductor で sessionId = undefined に（計画の変更）
  3. Conductor は idle に戻る（Claude セッションは生存中 — 同じ sessionId で動作中）
  4. 新タスク割り当て → `assignTask` → `conductor.sessionId` が undefined
  5. `scanTasks`（daemon.ts L834）が `task-state.json` に `sessionId: undefined` を記録
  6. セッション切断 → resume 不可能（sessionId がない）

  計画の根拠は「reset 後に Conductor が cmux-team conductor で再起動する」だが、通常完了では再起動しない。再起動するのは abort/restart の場合のみ。

- **推奨**: Step 2-4 を削除し、現行の動作（sessionId を保持）を維持する。abort/restart では新たな `cmdConductor` が `CONDUCTOR_SESSION` メッセージで新 sessionId を通知するため、resetConductor で明示的にクリアする必要はない。

### [Major] conductor.sessionId! の non-null assertion が残存する

- **場所**: conductor.ts L397（`assignTask` 内の trace DB 挿入）
- **問題**: 計画の E1 セクション（エッジケース対応）で `conductor.sessionId!` → `conductor.sessionId ?? ""` への変更が言及されているが、正式な Step に含まれていない。新設計では sessionId は `CONDUCTOR_SESSION` メッセージで非同期に設定されるため、HTTP 通知失敗時に undefined になりうる。`!` のままだと TypeScript の型安全性が崩れ、trace DB に `undefined` が文字列として挿入される。
- **推奨**: Step 2 に正式な変更項目として追加する。

  ```typescript
  // 変更前（L397）:
  session_id: conductor.sessionId!,

  // 変更後:
  session_id: conductor.sessionId ?? "",
  ```

### [Minor] launchConductor が cmdSpawnConductor 経由で呼ばれる場合に paneId が未解決

- **場所**: conductor.ts（新関数 `launchConductor`）、main.ts L1007（`cmdSpawnConductor`）
- **問題**: 旧 `spawnSingleConductor` は内部で `getPaneIdForSurface(surface)` を呼んで paneId を解決していた（conductor.ts L74）。新 `launchConductor` は `paneId?: string` を引数として受け取るが、`cmdSpawnConductor` からは paneId を渡さない。結果、CONDUCTOR_REGISTERED の paneId が空文字列になり、`resetConductor` でのサブ surface クリーンアップが pane ベースではなく agent リストベースにフォールバックする。
- **推奨**: `launchConductor` 内で `paneId` が未指定の場合に `getPaneIdForSurface` を呼ぶか、`cmdSpawnConductor` から paneId を渡す。

  ```typescript
  // launchConductor の先頭に追加:
  if (!paneId) {
    paneId = await getPaneIdForSurface(surface);
  }
  ```

### [Minor] pidWatcher の sessionId 保持（Step 4-2）と resetConductor の sessionId クリア（Step 2-4）が矛盾

- **場所**: daemon.ts L864（pidWatcher）、conductor.ts L507（resetConductor）
- **問題**: Step 4-2 では pidWatcher で sessionId を保持する（resume に必要）と述べ、Step 2-4 では resetConductor で sessionId をクリアすると述べている。`forceCloseDisconnectedConductor` は pidWatcher で disconnected 判定された後に呼ばれ、resetConductor を実行する。pidWatcher で保持した sessionId が resetConductor でクリアされるため、設計意図に一貫性がない。
- **推奨**: Critical の修正（resetConductor で sessionId をクリアしない）で解消される。

## コード照合結果

計画書の行番号・関数名を実際のコードと照合した結果:

| 計画の記述 | 実際のコード | 結果 |
|-----------|-------------|------|
| schema.ts SessionClearMessage 後 L75 | L69-75 | OK |
| schema.ts QueueMessage L82-93 | L82-93 | OK |
| conductor.ts spawnSingleConductor L69-110 | L69-110 | OK |
| conductor.ts launchConductorOnSurface L147-182 | L147-182 | OK |
| conductor.ts initializeConductorSlots L186-234 | L186-234 | OK |
| conductor.ts resetConductor L448-513 | L448-513 | OK |
| conductor.ts spawnConductor L555-598 | L555-598 | OK |
| conductor.ts spawnConductor 外部未使用 | Grep 確認: conductor.ts 内のみ | OK |
| main.ts import L33 | L33: `spawnSingleConductor` | OK |
| main.ts cmdConductor L817-879 | L817-879 | OK |
| main.ts getArg("session-id") L844 | L844 | OK |
| main.ts if (sessionId) L857-859 | L857-859 | OK |
| main.ts cmdSpawnConductor L1003-1009 | L1003-1009 | OK |
| main.ts cmdAbortTask L1568-1573 | L1568-1573 | OK |
| main.ts cmdRestartTask L1653-1658 | L1653-1658 | OK |
| main.ts cmdSend L521-626 | L521-626 | OK |
| daemon.ts handleMessage CONDUCTOR_REGISTERED L558 | L549-558 | OK |
| daemon.ts pidWatcher sessionId L864 | L864 | OK |
| daemon.ts daemon restart recovery L368-396 | L366-396 | OK |
| daemon.ts scanTasks sessionId L834 | L834 | OK |
| E1 分析: CONDUCTOR_SESSION は SESSION_STARTED より先に到達 | cmdConductor のフロー確認済み | OK |

## Recommendations

1. **Step 2-4 を削除する**: resetConductor で `conductor.sessionId = undefined` を設定しない。現行のコメント（L507）を維持する。理由: 通常のタスク完了フローでは Conductor セッションは再起動されず、同じ sessionId が継続使用される。
2. **E1 の defensive 変更を正式な Step に昇格する**: conductor.ts L397 の `conductor.sessionId!` → `conductor.sessionId ?? ""` を Step 2 に追加する。
3. **（任意）launchConductor で paneId 未指定時の解決を追加**: `cmdSpawnConductor` 経路での paneId 欠落を防ぐ。
