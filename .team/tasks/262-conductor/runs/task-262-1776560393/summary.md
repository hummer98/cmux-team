# T262 結果サマリー

## タスク概要

Conductor 状態機械を純粋関数 `transition(state, event) → { next, effects[] }` に抽出し、
A014 §2 の 25 遷移を表駆動テストで網羅する。Phase 1（破壊的変更なし）のみ実施。
Phase 2（状態削減）と Phase 3（FSM パッケージ移行）は後続タスク化候補として先送り。

## フェーズ結果

| Phase | 担当 | 結果 |
|-------|------|------|
| Phase 1: Plan | Planner v1 → v2 | plan.md v2 (38431 bytes) を Design Reviewer v2 が **Approved** |
| Phase 2: Design Review | Design Reviewer v1 → v2 | v1 Changes Requested → Planner 再設計 → v2 Approved |
| Phase 3: Impl | Implementer | bun test 644 pass / 0 fail、TS エラーは既存 2 件のみ |
| Phase 4: Inspection | Inspector | **GO** |

## 変更ファイル

### 新規

- `skills/cmux-team/manager/conductor-fsm.ts` (45525 bytes) — 純粋関数 `transition()` と effect runner `applyTransition()`
- `skills/cmux-team/manager/conductor-fsm.test.ts` (35050 bytes) — 表駆動テスト 58 ケース

### 修正

- `skills/cmux-team/manager/daemon.ts` (+156 / -120) — SESSION_STARTED / ACTIVE / IDLE / ASK / CLEAR / ENDED / PID_DEAD / TIMEOUT_STARTING / TIMEOUT_ASSIGNING / ASSIGN_FAILED の `conductor.status = ...` 代入を `applyTransition` 経由に置換
- `skills/cmux-team/manager/conductor.ts` — `assignTask()` の ASSIGN_REQUEST 経路化、最小 `makeAssignFsmContext()` ヘルパ追加

## テスト結果

- **bun test**: 644 pass / 0 fail / 1490 expect() calls / 26 files / 24s
- **bunx tsc --noEmit**: エラー 2 件（いずれも既存・T262 無関係）
  - `conductor.ts:217` optional-before-required parameter
  - `daemon.test.ts:3650` reason type mismatch
- **新規テストケース数**: 58（A014 §2 の 25 遷移 + broken 関連 + 到達可能セル + `setSessionId` 保持）

## 主要な設計判断

- **B1**: `FsmEvent` に `CONDUCTOR_CLEAR` を discriminated union として追加。`surfaceMissing` フラグで `forceCloseDisconnected` vs 通常 reset を分岐
- **B2**: `applyTransition` は 3 段階 runner
  1. 非 destructive effect は即時実行
  2. state commit
  3. destructive effect（resetConductor / abortTask / forceCloseDisconnected）を返却し、呼び出し側が try/catch で実行。失敗時は呼び出し側が `status=disconnected` + `disconnectedAt=now` をセット（fail-stop exclusion）
- **B3**: surface 実在確認は呼び出し側（daemon.ts / monitorConductors）で実施し、event の `surfaceMissing` フラグに載せる
- **M1**: log effect は `{ type: "log"; event: string; ctx?: object }` 構造。`buildLogDetail` で detail 文字列を組み立て
- **M5**: テストは destructive effect の type・相対順序のみ assert、log effect は event 名の存在のみチェック（ログ matcher の過剰結合を回避）

## 自己判断

- **Phase 1 のみに限定**: タスク本文の「Phase 1 と Phase 2 を分割する案」を採用。Phase 2（状態削減）は A014 の 7 状態を見直して別タスク化する前提とした
- **SESSION_STARTED の `setSessionId` 条件付き化**: 既存 daemon の後方互換（sessionId undefined 時に既存値を保つ）を吸収するため、`if (event.sessionId)` ガードを追加
- **ASSIGN_FAILED の `status === "assigning"` ガード**: broken / disconnected から `disconnected` へ誤って巻き戻る回帰を防ぐ防御的ガードを plan.md 未記載で追加

## 残課題（Phase 2 候補）

Inspector 検品で partial migration として確認済み:

1. 4 経路の FSM 経由化（CONDUCTOR_DONE / CONDUCTOR_CLEAR(running) / TIMEOUT_DISCONNECT / SESSION_CLEAR+running）
2. `abortTask` effect の本実装（現在は placeholder）
3. T203 C3 task-state.json sessionId 同期を FSM effect 化
4. final `session_started` 集約ログを FSM に寄せる
5. ASSIGN_REQUEST の FsmContext フル化
6. `resetConductor` の FSM への吸収
7. ASSIGN_FAILED else-branch（防御的フォールバック）の昇格

## マージ先

ローカルマージ（`main` へ ff-only）。
