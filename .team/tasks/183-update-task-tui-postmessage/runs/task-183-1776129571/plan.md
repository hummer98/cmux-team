# 実装計画: update-task の TUI 即時反映（postMessage 通知追加）

## 1. 背景と現状分析

### 通知経路の 2 系統

daemon の TUI refresh（`scheduleRefresh`）は `main.ts` のメインループ内で `await tick(state)` の後に呼ばれる。tick を早める経路は 2 系統ある：

1. **fs.watch**（`daemon.ts:187 initFileWatcher`）
   - `.team/tasks/` を `recursive: true` で監視（task.md の書き換えを拾う）
   - `.team/` 直下の `task-state.json` を非再帰で監視
   - 50ms debounce → `requestWakeup` → 即時 tick

2. **HTTP queue → handleMessage**（`proxy.ts`→`main.ts:273`→`daemon.ts:523`）
   - `postMessage` で `http://localhost:<port>/api/messages` に POST
   - `TASK_CREATED` ハンドラが `requestWakeup` を明示呼出（`daemon.ts:537`）
   - 他メッセージ種別も state を変更するため scheduleRefresh で反映される

### 現状の通知状況（コマンド別）

| コマンド | task-state.json 更新 | task.md 更新 | postMessage 通知 |
|----------|---------------------|--------------|------------------|
| create-task | ✅ | ✅ 新規作成 | `TASK_CREATED`（ready 時のみ・行1690） |
| update-task | ✅（status 変更時） | ✅（title/body/depends-on 時） | `TASK_CREATED`（status=ready 時のみ・行1774） |
| close-task | ✅ | — | `CONDUCTOR_DONE`（conductor 見つかる時のみ・行1829） |
| abort-task | ✅ | — | `CONDUCTOR_DONE` 常に送信（行2108） |
| delete-task | ✅ | — | **なし**（行2215-2253、通知送信ゼロ） |
| restart-task | ✅ | — | `CONDUCTOR_DONE` + `TASK_CREATED`（行2191, 2205） |

### 問題の本質

fs.watch は理論上は動くが、macOS の `fs.watch({recursive: true})` は FSEvents 経由で**信頼性が低い**（イベントの取りこぼし・遅延発生）。実運用で「10 秒待たされる」現象が発生しているのは fs.watch が fire しない / 遅延するケースが存在するため。

**対策**: ファイル変更を伴うすべての state-mutating コマンドで、明示的に HTTP 経由の postMessage を送って `requestWakeup` を発火させる。fs.watch は fallback として残す（冗長だが安全側）。

### state にタスク本文は載っていない

`scanTasks`（`daemon.ts:807`）は毎 tick で `loadTasks(projectRoot)` を呼び、ディスクからタスク定義を読み直す。`state.taskList` に反映されるのはメタ情報（id/title/status/dependsOn 等）のみで、本文は都度ファイル読み。つまり state キャッシュが古くなる問題は存在せず、**tick を発火さえさせれば TUI に即反映される**。

## 2. 設計判断: `TASK_UPDATED` 新設 vs `TASK_CREATED` 再利用

**選定: `TASK_UPDATED` を新設する。**

### 理由

| 観点 | TASK_CREATED 再利用 | TASK_UPDATED 新設 |
|------|---------------------|-------------------|
| daemon 側の副作用 | `task_received` ログが毎回出る（紛らわしい） | `task_updated` ログで意図が明確 |
| 既存挙動への影響 | 「ready に変わった時の割り当てトリガー」と混在 | 意味が分離される |
| 実装コスト | schema 変更不要 | schema + handleMessage 1 ケース追加 |
| 監査性（logs/manager.log） | 新規作成と区別できない | 区別できる |

TASK_CREATED は「新規 ready タスクが投入された」という意味を持っているため、title 編集で同じメッセージが流れるのは観測性を損なう。新設コストは小さい（10 行程度）。

### 設計方針

- `TASK_UPDATED` の daemon ハンドラは `requestWakeup(state)` + ログのみ。スキャンは次 tick の `scanTasks` に任せる（TASK_CREATED と同様）。
- `TASK_CREATED` の既存用途（ready 遷移で Conductor 割り当てトリガー）は**維持**する。実装上は `status → ready` のパスは両方送らず TASK_CREATED のみ（セマンティクスが「新たに割り当て可能になった」ため）。title/body/depends-on 編集など「割り当てとは無関係な変更」でのみ TASK_UPDATED を送る。

## 3. 変更対象ファイルと具体的変更箇所

### 3.1 `skills/cmux-team/manager/schema.ts`

- **追加**: `TaskUpdatedMessage` zod スキーマ（TASK_CREATED とフィールド同一: taskId, taskFile, timestamp）
- **変更**: `QueueMessage` discriminated union に `TaskUpdatedMessage` を追加
- **追加**: `export type TaskUpdatedMessage = z.infer<typeof TaskUpdatedMessage>;`

### 3.2 `skills/cmux-team/manager/daemon.ts`

- **追加**: `handleMessage` の switch に `case "TASK_UPDATED"` を新設（`daemon.ts:525` の TASK_CREATED の直後）
  ```ts
  case "TASK_UPDATED": {
    await log("task_updated", `task_id=${message.taskId}`);
    requestWakeup(state);
    break;
  }
  ```

### 3.3 `skills/cmux-team/manager/main.ts`

- **変更 (cmdUpdateTask, 行1702-1789)**:
  - 関数末尾（console.log 直前、行1783 付近）に「何か変化があったが TASK_CREATED を送らなかった場合」は TASK_UPDATED を送る分岐を追加
  - 具体的には: `status=ready` への遷移で TASK_CREATED を既に送った場合は**スキップ**、それ以外で title/body/depends-on/status (ready 以外)の変更があれば TASK_UPDATED を送る
  - 判定フラグ: `let notifiedTaskCreated = false;` を先頭で宣言し、TASK_CREATED 送信時に true にする

- **変更 (cmdCloseTask, 行1791-1855)**:
  - conductor が見つからなかった場合でも TUI 反映が必要（現状 CONDUCTOR_DONE 未送信）
  - 行1835 の `}` 直後（CONDUCTOR_DONE 送信ブロック外側）に「conductor 不在なら TASK_UPDATED を送る」追加

- **変更 (cmdDeleteTask, 行2215-2253)**:
  - 現状 postMessage 送信ゼロ
  - 関数末尾（`console.log` 直前、行2252）で `await postMessage({ type: "TASK_UPDATED", ... })` を追加

- **変更 (cmdAbortTask, 行2044-2130)**:
  - 通常パス（conductor 検出時）は既存の CONDUCTOR_DONE 送信（行2108）で wakeup 発火済み → 追加変更なし
  - **no-conductor 早期 return パス（行2061-2074）は postMessage 送信がゼロ**。`saveTaskState(PROJECT_ROOT, taskState)`（行2070）直後、`log("task_aborted", ...)`（行2071）の前後で以下を追加:
    ```ts
    await postMessage({
      type: "TASK_UPDATED",
      taskId,
      taskFile: taskFilePath,
      timestamp: new Date().toISOString(),
    });
    ```
  - taskFile は関数冒頭で解決済みのパスを流用する（既存処理に合わせる）

- **restart-task**: conductor 不在パスも含め既存の TASK_CREATED 送信（`main.ts:2166-2171`）で wakeup 発火済みのため**追加変更なし**

- **cmdSend の help 文言（行722 付近）**: `TASK_UPDATED` を受け付ける `case` を追加し、usage の enumeration にも追記（send CLI 経由でも発行できるようにして e2e で使えるようにする）

### 3.4 `skills/cmux-team/manager/i18n.ts`

- ヘルプ文字列（行112, 161, 296, 326, 516, 628, 677, 812, 843, 1033）に `TASK_UPDATED` を追加
- create/update/close/delete の説明文に「変更は即座に TUI に反映される」旨を追記

### 3.5 ダッシュボード（dashboard.tsx）

**変更なし**。`scheduleRefresh` は既存のメインループで呼ばれており、tick が発火すれば自動で TUI が更新される。

## 4. TDD の順序

### Step 1: schema テスト（`schema.test.ts` が存在しないので `daemon.test.ts` or 新規 `schema.test.ts` に追加）

- `TaskUpdatedMessage` を parse できること
- `QueueMessage` discriminated union が `TASK_UPDATED` を受理すること

### Step 2: `daemon.test.ts` の handleMessage テスト拡張

既存の TASK_CREATED 系テスト（行663, 691 付近）に続けて:
- TASK_UPDATED を handleMessage に渡すと `state.wakeupPending` が true になること
- `log` に `task_updated` が出力されること（必要なら fake logger で検証）

### Step 3: `main.test.ts` / `queue.test.ts` の統合テスト

`queue.test.ts` に倣って:
- update-task で title/body/depends-on だけ変えたとき TASK_UPDATED がキューに載ること
- update-task で status=ready に変えたときは TASK_CREATED のみ載ること（TASK_UPDATED は載らない）
- delete-task 実行後に TASK_UPDATED が載ること
- close-task（conductor なし）で TASK_UPDATED が載ること
- **abort-task で team.json に conductor が存在しないとき TASK_UPDATED がキューに載ること**（no-conductor 早期 return パスの回帰防止）
- **restart-task で conductor 不在時も TASK_CREATED がキューに載ること**（既存動作の回帰テスト）
- **古い daemon + 新 CLI の後方互換テスト**: TASK_UPDATED を受信した proxy が parse 失敗で 400 を返しても CLI 側 `postMessage` が catch で握りつぶし、CLI 全体は成功扱いになること（`proxy.ts:222-234` の挙動を踏まえて queue.test.ts 相当で明示）

### Step 4: 実装（上記 3.1〜3.4 を順に適用）

テスト Green 化を確認しながら進める。

### Step 5: e2e 手動確認（CLAUDE.md 記載の手順）

1. `cmux-team start` で daemon 起動
2. 別ペインで `cmux-team create-task --status draft --title "test"`
3. `cmux-team update-task --task-id <id> --title "renamed"` → TUI で title が **1秒以内**に書き換わること
4. `cmux-team update-task --task-id <id> --body "new body"` → TUI の表示が更新されること（body を表示する場所があれば）
5. `cmux-team delete-task --task-id <id>` → open task 数が即減少し、closed セクションに移動すること
6. `.team/logs/manager.log` に `task_updated task_id=...` 行が出ていること

## 5. 影響範囲と懸念点

### 影響範囲
- **daemon 側**: 新ケース 1 つ追加のみ。既存メッセージの挙動は変わらない。
- **CLI 側**: postMessage の追加呼び出し（3 箇所）。HTTP 失敗時は無視される（`postMessage` が catch で握りつぶす設計）ため失敗しても CLI 自体は成功する。
- **schema**: discriminated union に case 追加。後方互換性あり（古い daemon が新 CLI からのメッセージを受け取ると zod parse でエラーになるが、`queue.ts` / proxy 側で catch していれば問題ない — 要確認）。

### 懸念点

1. **古い daemon + 新 CLI の組み合わせ**: ユーザーが daemon を再起動せずに CLI だけアップデートすると、TASK_UPDATED を受信した古い daemon が zod parse エラーを出す。`proxy.ts:222-234` を確認した結果、**parse 失敗時は 400 を返し、CLI 側 `postMessage` が catch で握りつぶすため後方互換 OK**（CLI は成功扱いで継続）。TUI 反映は fs.watch フォールバックに退行するが CLI 動作は壊れない。
2. **二重通知**: status=ready 遷移時に TASK_CREATED と TASK_UPDATED を両方送ると `task_received` と `task_updated` がログに並んで出る。cmdUpdateTask では「ready 遷移時は TASK_CREATED のみ」にして重複を避ける。
3. **fs.watch との重複 wakeup**: ファイル変更でも wakeup、HTTP でも wakeup で 2 回発火する。`requestWakeup` は冪等（wakeupPending フラグ）なので実害なし。むしろ二重化により信頼性が上がる。
4. **restart-task の TASK_CREATED は維持**: すでに送られているため TASK_UPDATED は不要。現状維持。

## 6. 既存テスト・e2e への影響

- `daemon.test.ts`: 既存 TASK_CREATED テストには影響なし。新ケース追加のみ。
- `queue.test.ts`: 既存の TASK_CREATED read/write テストには影響なし。
- `main.test.ts`: cmdUpdateTask の既存テスト（status=ready 送信）は維持される。title/body 単独変更テストが新規追加される。
- `e2e.ts`: `cliSend("TASK_CREATED", ...)` の既存呼び出しは無変更。
- **破壊的変更なし**。既存 API / CLI 仕様はそのまま。

## 7. 受け入れ基準チェックリスト

- [x] update-task の title/body/depends-on 変更で 1 秒以内に TUI 反映（HTTP → requestWakeup → tick → scheduleRefresh は数十ms〜数百ms）
- [x] update-task の status=ready 既存挙動（TASK_CREATED による Conductor 割り当て）を維持
- [x] delete-task も即時反映（現状の通知ゼロを解消）
- [x] close-task（conductor 不在パス）も即時反映
- [x] abort-task 通常パス（conductor 検出時）は既存の CONDUCTOR_DONE で即時反映済み
- [x] **abort-task（conductor 不在パス）も TASK_UPDATED で即時反映**（本タスクで新規追加）
- [x] restart-task は既存の TASK_CREATED で即時反映済み → 変更不要
- [x] 既存テスト破壊なし（追加のみ）

## 修正履歴 (Review 対応)

### 1 回目の Design Review（Changes Requested）対応

Design Reviewer の指摘 (`design-review.md`) に従って以下を修正:

1. **§3.3 abort-task の扱いを修正**
   - Before: 「abort-task / restart-task: 既存の CONDUCTOR_DONE / TASK_CREATED 送信で wakeup 発火済みのため追加変更なし」
   - After: no-conductor 早期 return パス（`main.ts:2061-2074`）で postMessage 送信がゼロだった点を明記。`saveTaskState` 直後に `TASK_UPDATED` を送る具体的な実装コードを追加。restart-task は既存通知で OK の旨を分離記述。

2. **§4 Step 3 統合テストに 3 項目追加**
   - abort-task の no-conductor 早期 return パスで TASK_UPDATED がキューに載ること
   - restart-task の no-conductor パスで TASK_CREATED がキューに載ること（既存動作の回帰テスト）
   - 古い daemon + 新 CLI の後方互換テスト（proxy 400 → CLI catch で握りつぶし → 成功扱い）

3. **§5 懸念点 1 を断定的記述に変更**
   - 「proxy の parse 失敗ハンドリングを確認する」→「`proxy.ts:222-234` を確認した結果、parse 失敗時は 400 を返し CLI 側 `postMessage` が握りつぶすため後方互換 OK」と断定。

4. **§7 受け入れ基準チェックリストを再構成**
   - abort-task を「通常パス（CONDUCTOR_DONE）」と「不在パス（TASK_UPDATED — 本タスク新規追加）」に分割
   - restart-task は単独項目として「既存の TASK_CREATED で即時反映済み → 変更不要」に整理

