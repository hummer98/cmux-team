# T262 Inspection Report

## 判定: GO

Phase 1 の目標（純粋関数 `transition()` への抽出 + 表駆動テスト + 既存挙動の温存）は満たされている。Should レベルの観察事項（一部 daemon 経路の未移行・dead branches）は impl-summary.md の「残課題（Phase 2 候補）」と整合しており、Phase 1 の破壊的変更なし方針に沿った判断として許容できる。

## 検証結果

### Must 観点

- [x] **1. コンパイルエラー無し（T262 起因なし）**
  - `bunx tsc --noEmit` のエラーは 2 件のみで、いずれも impl-summary.md 記載の既存エラーと一致
    - `skills/cmux-team/manager/conductor.ts:217` — optional-before-required parameter（既存）
    - `skills/cmux-team/manager/daemon.test.ts:3650` — reason type mismatch（既存）
  - `conductor-fsm.ts` / `conductor-fsm.test.ts` / `daemon.ts` の T262 由来追加コードに新規 TS エラーなし

- [x] **2. テスト全緑**
  - `bun test`: **644 pass / 0 fail** / 1490 expect() calls / 26 files / 24s
  - 新規 `conductor-fsm.test.ts` は **58 ケース** で全 pass
  - 既存 `daemon.test.ts` / `conductor.test.ts` も regression なし

- [x] **3. plan.md Step 1-7 完遂**
  - Step 1（skeleton）: `conductor-fsm.ts` に `FsmEvent` / `FsmEffect` / `transition` / `applyTransition` の骨格あり
  - Step 2（test RED）: `conductor-fsm.test.ts` に表駆動テスト 58 ケース
  - Step 3（transition GREEN）: status 別 switch 構造で A014 §2 の 25 遷移 + 補助遷移を網羅
  - Step 4（applyTransition）: 3 段階 effect runner（非 destructive 即時 → state commit → destructive 返却）実装
  - Step 5（呼び出し側置換）: `daemon.ts` で SESSION_STARTED / ACTIVE / IDLE / ASK / CLEAR(disconnected+starting) / ENDED / PID_DEAD / TIMEOUT_STARTING / TIMEOUT_ASSIGNING / ASSIGN_FAILED が `applyTransition` に置換、`conductor.ts:assignTask` は `ASSIGN_REQUEST` 経由
  - Step 6/7（検証）: bun test 緑 + tsc 既存エラーのみ + 表駆動テスト + impl-summary.md 整備

- [x] **4. B1/B2/B3/M1/M5 反映**
  - **B1**（`CONDUCTOR_CLEAR` + `surfaceMissing` flag）: `FsmEvent` discriminated union 内に `CONDUCTOR_CLEAR` が定義され、`surfaceMissing` プロパティを持つ。disconnected 状態で `surfaceMissing=true` のとき `forceCloseDisconnected` effect、それ以外は通常 reset
  - **B2**（3 段階 effect runner）: `applyTransition` 内で `runNonDestructiveEffect` → state commit → destructive を返却の順で実行
  - **B3**（surface 実在確認は呼び出し側）: `transition()` は `surfaceMissing` フラグを受け取るのみで、自身では存在チェックを行わない。daemon.ts / monitorConductors 側で `validateSurface` 等を実施
  - **M1**（log effect の `{ event, ctx }` 構造）: `FsmEffect` の log バリアントが `{ type: "log"; event: string; ctx?: object }` 形式、`buildLogDetail` で detail 文字列を組み立て
  - **M5**（テストポリシー）: `conductor-fsm.test.ts` は destructive effect の type と相対順序のみ assert、log effect は event 名の存在のみチェック

- [x] **5. 破壊的変更なし**
  - `schema.ts` 未変更（git status で確認、`ConductorStatus` union 同一）
  - `daemon.test.ts` / `conductor.test.ts` のテスト本体に挙動変更なし
  - 外部契約（team.json / task-state.json / ログ event 名）維持
  - 残留直接代入は 2 箇所のみで、いずれも意図的:
    - `conductor.ts:480` — applyTransition 後の防御的フォールバック（FSM が想定外に status を維持しなかった場合の保険）
    - `conductor.ts:642` — `resetConductor()` 内の destructive effect runner 自身（plan.md §6 で計画どおり残置）

### Should 観点

- **partial migration（Phase 2 候補として明示）**
  - 以下の 4 経路は FSM に定義されているが daemon.ts は従来パスを残しており、本番からは FSM 経路で呼ばれない:
    1. `CONDUCTOR_DONE` (daemon.ts:1260) — done マーカー検出経路
    2. `CONDUCTOR_CLEAR` (daemon.ts:1307) — running 状態の手動 /clear 経路
    3. `TIMEOUT_DISCONNECT` (daemon.ts:2563) — disconnected→broken への forced close
    4. `SESSION_CLEAR + running` (daemon.ts:2024) — task abort 経路
  - 結果として `conductor-fsm.ts` の以下 transition branches は unit test では検証済みだが production からは到達不能（dead in production / live in tests）:
    - `running + SESSION_CLEAR` の `abortTask` effect
    - `disconnected + TIMEOUT_DISCONNECT` の `forceCloseDisconnected` effect
    - `asking + CONDUCTOR_DONE` / `disconnected + CONDUCTOR_DONE`
    - `broken + CONDUCTOR_CLEAR`
  - impl-summary.md の「残課題 Phase 2 候補」と一致しており、Phase 1 の「破壊的変更なし」方針に沿った判断として許容
- **`abortTask` effect は placeholder**
  - daemon.ts の `runDestructiveEffects` 内で `abortTask` は `log("fsm_abort_task_not_implemented", ...)` のみ。FSM 上は定義されているが、上記 partial migration により daemon から呼ばれない。Phase 2 で SESSION_CLEAR+running を FSM 経由化する際に実装される想定
- **`makeFsmContext.updateTaskSession` は no-op**
  - T203 C3 の task-state.json sessionId 同期は daemon.ts の SESSION_STARTED handler 側に残置（impl-summary.md §逸脱点に明記）。ASSIGN_REQUEST 等で副作用なしのため現状問題なし
- **FSM テストカバレッジ**
  - A014 §2 の 25 遷移 + broken 関連 + 到達可能セル + `setSessionId` 保持で **58 ケース**。plan.md の目標（45-55）を上回る
- **ログ event 名の重複・typo**
  - `conductor_started` / `conductor_running` / `conductor_reset` / `conductor_recovered_from_disconnect` / `signal_ignored` / `fsm_unexpected_destructive` 等、既存 event と整合。typo なし

### Nice to have

- **impl-summary.md の逸脱点が合理的**
  - SESSION_STARTED の `setSessionId` 条件付き化、idle/asking の SESSION_STARTED self-loop 追加、running→running の `conductor_running` 抑止、disconnected SESSION_CLEAR の `new_status` 除去 — いずれも既存 daemon の非明示仕様（後方互換）を吸収するための逸脱で、daemon.test.ts の expectation と整合させるための必要最小限の調整
- **ASSIGN_FAILED の `status === "assigning"` ガード**
  - broken / disconnected 状態から誤って `disconnected` に巻き戻る回帰を防ぐ良い判断。plan.md には明記されていないが、防御的設計として妥当
- **「残課題 Phase 2 候補」の妥当性**
  - 8 項目すべて Phase 1 のスコープ外として整理されており、ASSIGN_REQUEST の FsmContext フル化、T203 C3 sync の effect 化、final session_started ログの集約、resetConductor の FSM 吸収など、論理的な順序で進められる構成

## Fix Required

なし（GO 判定）。

## 総評

Phase 1 のゴール「Conductor 状態機械を純粋関数に抽出する（破壊的変更なし）」は達成されている。

- 純粋関数 `transition()` と effect runner `applyTransition()` が `conductor-fsm.ts` に独立し、表駆動テスト 58 ケースで A014 §2 の 25 遷移 + 後方互換テストを網羅
- 既存 644 件のテストは全て pass、TS エラーは documented な 2 件のみ
- `daemon.ts` の主要な status mutation 経路（SESSION_STARTED / ACTIVE / IDLE / ASK / CLEAR(部分) / ENDED / PID_DEAD / TIMEOUT_STARTING / TIMEOUT_ASSIGNING / ASSIGN_FAILED）が `applyTransition` 経由に統一
- B1/B2/B3/M1/M5 の設計判断はすべて実装に反映
- 残留する 2 箇所の生代入（防御フォールバック + resetConductor 自身）は計画どおりの意図的残置
- 4 経路（CONDUCTOR_DONE / CONDUCTOR_CLEAR / TIMEOUT_DISCONNECT / SESSION_CLEAR+running）の partial migration は impl-summary.md に Phase 2 候補として明示されており、本番影響なし

Phase 2 で残り 4 経路の FSM 経由化と、abortTask / updateTaskSession effect の本実装、resetConductor の FSM 吸収を進めることで、Conductor のすべての status 変化が単一の `transition()` で説明できる構造に到達する見通しが立っている。
