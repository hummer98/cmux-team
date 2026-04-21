# T262 Implementation Summary

## 変更ファイル

### 新規
- `skills/cmux-team/manager/conductor-fsm.ts` — 純粋関数 `transition()` と effect runner `applyTransition()` を実装
- `skills/cmux-team/manager/conductor-fsm.test.ts` — 表駆動テスト 58 ケース（A014 §2 の 25 遷移 + broken 関連 + 到達可能セル + `setSessionId` 保持など後方互換テスト）

### 修正
- `skills/cmux-team/manager/daemon.ts`
  - SESSION_ACTIVE / SESSION_IDLE / SESSION_ASK / SESSION_STARTED / SESSION_CLEAR / ASSIGN_FAILED の `conductor.status = ...` 代入を `applyTransition(...)` 呼び出しに置換
  - SESSION_STARTED では FSM 呼び出し前に `prevSessionId` をキャプチャし、T203 C3 の task-state.json sessionId 同期と final `session_started` 集約ログは daemon 側に残置
  - ASSIGN_FAILED (conductor-kind) は `status === "assigning"` ガードを付与、else 分岐は防御的フォールバックとして生代入を残す
- `skills/cmux-team/manager/conductor.ts`
  - `assignTask()` の `conductor.status = "assigning"` を `ASSIGN_REQUEST` イベントの `applyTransition` に置換
  - `DaemonState` を持たない箇所用に最小 `makeAssignFsmContext()` ヘルパ（log / notifyStateChanged のみ実装、他は no-op）を追加
  - FSM が想定外に destructive effect を返した場合の `fsm_unexpected_destructive` 防御ログと、applyTransition 後 `status !== "assigning"` の場合の強制代入フォールバックを追加

### 非対象（残置）
- `conductor.ts:605` `conductor.status = targetStatus;` — `resetConductor()` 内の destructive effect runner 自身。計画どおり残置
- `daemon.ts` の ASSIGN_FAILED catch-all 末尾の raw 代入 — 想定外分岐の保険として残置

## テスト結果

- **bun test**: 緑（644 pass / 0 fail / 1490 expect() calls / 26 files, 24s）
- **bunx tsc --noEmit**: エラー 2 件（いずれも **T262 とは無関係の既存エラー** — `git stash` で確認済み）
  - `conductor.ts:217` optional-before-required parameter
  - `daemon.test.ts:3650` reason type mismatch
- **新規テストケース数**: 58（`conductor-fsm.test.ts`）

## plan.md との差分

### 計画どおり実施した点
- TDD 順序: Step 1 skeleton → Step 2 test RED → Step 3 transition() GREEN → Step 4 applyTransition → Step 5 呼び出し側置換 → Step 6/7 検証
- B1: `CONDUCTOR_CLEAR` を FsmEvent に追加、`surfaceMissing` フラグ伝播
- B2: 3 段階 effect runner（非 destructive 即時 → state commit → destructive 返却）
- B3: surface 実在確認は呼び出し側で実施・event に載せる
- M1: `{ type: "log"; event; ctx? }` 構造、`buildLogDetail` で detail 組み立て
- M5: テストは destructive effect の有無と相対順序のみ必須、log は event 名のみ検証

### 逸脱点
- **SESSION_STARTED で `setSessionId` を条件付きに**: plan.md は明記していないが、既存 daemon 実装は `message.sessionId` が undefined のとき `conductor.sessionId` を温存する。FSM を無条件 `next.sessionId = event.sessionId` にすると後方互換が壊れるため、`if (event.sessionId)` ガードを追加（idle/assigning/starting/running/disconnected 全て）
- **idle / asking 状態の SESSION_STARTED self-loop を追加**: 既存 daemon は状態に関係なく pid/sessionId を更新するため、FSM で default drop すると差分が出る。ログ・status 変更なしの self-loop（pid/sessionId 更新 + spawnPidWatcher + notifyStateChanged）として追加
- **running→running SESSION_STARTED の `conductor_running` ログを抑止**: 既存 daemon は running→running 自己遷移で `conductor_running` を出さず、集約 `session_started` のみ。FSM をそれに合わせ、`notifyStateChanged` のみ発火
- **disconnected SESSION_CLEAR の `new_status=idle` を除去**: 既存 daemon の `conductor_reset` ログに new_status が含まれないため ctx から `nextStatus` を外した
- **T203 C3 の task-state.json sessionId 同期は FSM 外に残置**: FSM は `DaemonState` を持たないので、daemon.ts 側で prevSessionId 差分検知 → `updateTaskSession` を呼ぶ従来実装を維持（計画の §7 フォローアップ候補と整合）
- **ASSIGN_FAILED conductor-kind の `status === "assigning"` ガード**: 既存実装は無条件に代入していたが、broken / disconnected 状態から誤って `disconnected` に巻き戻さないよう明示ガードを入れた

## 苦労した点・判断

### 1. FSM と daemon の「どこまで FSM に寄せるか」境界
- SESSION_STARTED の final 集約ログ (`session_started source=... pid=...`) は LogCtx に push すると他テストの表現と衝突する。**daemon.ts 側に残し、FSM は状態遷移固有のログ（`conductor_started` / `conductor_running` / `conductor_reset` / `conductor_recovered_from_disconnect`）のみ担当** とした。
- C3 の task-state.json sessionId 同期は `DaemonState.runningTasks` を参照するため FSM 外に残置（Phase 2 で別 effect として抽出候補）。

### 2. 既存テストの壊れ方で判明した非明示仕様の吸収
- `sessionId 無しメッセージは既存値を保つ（後方互換）`
- `running→running SESSION_STARTED では conductor_running ログなし`
- `idle / asking 状態での SESSION_STARTED は pid/sessionId のみ更新`
- `disconnected SESSION_CLEAR の conductor_reset ログに new_status は含まれない`

これらは plan.md に明記されていなかったが、daemon.test.ts のログ matcher と state assertion を両立するために段階的に埋めた。

### 3. ASSIGN_REQUEST の FSM 統合
- `conductor.ts:assignTask()` は `DaemonState` を持たない呼び出し経路。`FsmContext` 全体を渡すには大きな shim が必要だったが、ASSIGN_REQUEST は実質 `log + notifyStateChanged` しか使わないため、**最小 context（他は no-op）** を作って注入する判断にした。
- FSM が destructive を返さない前提だが、将来変更されたときに静かに落とされないよう、防御的な `fsm_unexpected_destructive` ログと強制代入フォールバックを残した。

### 4. ASSIGN_FAILED の conductor-kind ガード追加
- 既存コードは `conductor.status = "disconnected"` を無条件に代入していた。これを `kind: "conductor"` の FSM イベントにしたとき、`idle` や `broken` 状態で誤って `disconnected` に巻き戻ると回帰になる。**`status === "assigning"` の時のみ FSM 経由に切り替え、それ以外は従来どおり生代入（防御的フォールバック）** にした。

## 残課題（Phase 2 候補）

1. **ASSIGN_REQUEST の FsmContext フル化** — 現在 conductor.ts の `makeAssignFsmContext()` は `DaemonState` 不要なエフェクトのみ実装。`requestWakeup` / `updateTaskSession` / `formatSnapshot` を使う遷移を追加する場合は真の `FsmContext` に置き換える必要がある
2. **T203 C3 の task-state.json sessionId 同期を FSM effect 化** — 現在 daemon.ts 側で prevSessionId 差分検知している部分を `{ type: "syncTaskSession", sessionId }` effect として抽出できる
3. **final session_started 集約ログを FSM に寄せる** — source/pid を含む 1 行サマリログを `buildLogDetail` で組み立てられるようにする
4. **`assigning_stuck` のタイムアウト閾値を config 化** — 現在 ハードコード（daemon.ts の該当箇所）
5. **ASSIGN_FAILED else-branch の昇格** — `status === "assigning"` ガードの else 側（防御的フォールバック）を削除し、FSM 側で `status !== "assigning"` を明示的に handle する
6. **resetConductor の FSM への吸収** — 現在は destructive effect として外部にあるが、`applyTransition` 内で `status = targetStatus` を設定する形に段階的に移行可能
7. **A014 §5.5 stale taskRunId guard の自動テスト拡充** — 現状 FSM テストで `ignore + warn` は検証しているが、end-to-end の stale race シナリオは daemon.test.ts 側
8. **ログ matcher のヘルパー化** — 現在各テストで `manager.log` を読んで regex/includes している部分を `expectLogContains(event, {key: value})` に共通化
