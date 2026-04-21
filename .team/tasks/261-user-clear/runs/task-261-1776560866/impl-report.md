# T261 Implementation Report

## Completed Tasks

- 4.1 ConductorState にフィールド追加（schema.ts）
- 4.2 assignTask でタイムスタンプ記録（conductor.ts: clear_sent / assigning_window_open / assign_prompt_sent）
- 4.3 assigning 窓 close を記録（daemon.ts: SESSION_STARTED / SESSION_IDLE R1 / assigning timeout の 3 経路）
- 4.4 user_clear_decision_snapshot ログ（daemon.ts: SESSION_CLEAR の assigning / running 両ブランチ）
- 4.5 session_idle_source_guess（daemon.ts: guessSessionIdleSource + session_idle ログへの併記）
- 4.6 daemon.test.ts テスト追加（10 テスト）
- 4.7 conductor.test.ts テスト追加（2 テスト）

## Files Changed

| パス | 変更概要 |
|------|---------|
| `skills/cmux-team/manager/schema.ts` | `ConductorState` に T261 フィールド 5 つ追加（`clearSentAt` のみ永続化、他 4 つはランタイム限定）|
| `skills/cmux-team/manager/conductor.ts` | `assignTask` で `clear_sent` / `assigning_window_open` / `assign_prompt_sent` をロギング + state 更新。`resetConductor` で 5 フィールドをクリア |
| `skills/cmux-team/manager/daemon.ts` | `formatUserClearDecision` 公開ヘルパー + `guessSessionIdleSource` 内部ヘルパー追加。SESSION_STARTED(assigning→running) / SESSION_IDLE(R1) / assigning timeout の 3 経路で `assigning_window_close` 発行。SESSION_CLEAR 2 ブランチで `user_clear_decision_snapshot` 発行。SESSION_IDLE ログに `session_idle_source_guess` 併記。`updateTeamJson` / `restoreConductorState` で `clearSentAt` のみ永続化 |
| `skills/cmux-team/manager/conductor.test.ts` | `assignTask snapshot フィールド記録 (T261)` describe ブロック追加（2 テスト）|
| `skills/cmux-team/manager/daemon.test.ts` | T261 describe ブロック 4 つ追加（snapshot 2 + window_close 3 + source_guess 3 + 永続化 1 = 計 10 テスト）|

## TDD Cycles / Verification Results

| サブタスク | RED | GREEN | REFACTOR | VERIFY |
|-----------|-----|-------|----------|--------|
| 4.1 | N/A（schema 追加のみ）| ✅ `ConductorState` に 5 フィールド追加 | JSDoc で永続化 / ランタイム限定を明示 | `bun test schema.ts` 相当 green |
| 4.2 | `assignTask` 呼び出しで clear_sent が log されるテスト追加 → fail | `cmux.send("/clear")` 直後に `clearSentAt` 代入 + 3 ログ発行 → green | ログは `log(event, detail)` + `formatSurface` を使い、生の文字列連結を排除 | conductor.test.ts 26 tests green |
| 4.3 | assigning_window_close テストで elapsed 検証 → fail | 3 経路で elapsed 算出 + ログ発行 → green | null handling を `??  "-"` で統一 | daemon.test.ts T261 3 tests green |
| 4.4 | user_clear_decision_snapshot テストで case=user_clear / decision_reason を検証 → fail | `formatUserClearDecision` ヘルパー経由で `user_clear_decision_snapshot` 発行 → green | ヘルパーは純関数 + JSDoc で契約を明記 (Finding 1) | daemon.test.ts T261 2 tests green |
| 4.5 | session_idle_source_guess テスト 3 ケースで値検証 → fail | `guessSessionIdleSource` + session_idle ログ併記 → green | 5000ms 閾値のコメントに Decision D11 根拠追記 (Finding 2) | daemon.test.ts T261 3 tests green |
| 4.6 | 10 テスト追加 → schema.ts 修正完了後 fail | 既存実装がある状態で全 assert 通過 → green | テストデータは固定時刻で reproducibility を担保 | `bun test daemon.test.ts` green（197 tests 含む）|
| 4.7 | 2 テスト追加（log 順序 + state 反映）→ fail | 既存実装で通過 → green | `spyOn(cmux, "send")` を mock | `bun test conductor.test.ts` 26 tests green |

### 最終検証

```bash
$ bun test
 597 pass
 0 fail
 1395 expect() calls
Ran 597 tests across 25 files. [30.62s]

$ bunx tsc --noEmit 2>&1 | grep -v "conductor.ts(197" | grep -v "daemon.test.ts(3650"
（空出力 — スコープアウトの 2 件以外に新規エラー無し）

$ grep -c "user_clear_decision_snapshot" daemon.ts daemon.test.ts
daemon.ts:4
daemon.test.ts:4

$ grep -c "clear_sent" conductor.ts conductor.test.ts
conductor.ts:2
conductor.test.ts:3

$ grep -c "assigning_window_close" daemon.ts daemon.test.ts
daemon.ts:5
daemon.test.ts:6

$ grep -c "session_idle_source_guess" daemon.ts daemon.test.ts
daemon.ts:2
daemon.test.ts:4
```

## Finding 反映状況

| # | Finding | 反映箇所 |
|---|---------|---------|
| 1 | `formatUserClearDecision(conductor, message)` の契約明記 | daemon.ts:213-220 JSDoc に「conductor からのみ state 取得、message は timestamp 取得用」と明記 |
| 2 | 5000ms 閾値の Decision Log 追記 | daemon.ts:250-253 に Decision D11（T253 事例約 2 秒 × 2.5x マージン）を JSDoc で記載 |
| 3 | SESSION_ACTIVE の instrument 対象外 | 実装では SESSION_ACTIVE ブランチに T261 ログを追加していない（D8 方針準拠、R1 は SESSION_IDLE のみ instrument） |
| 4 | 永続化回帰テスト追加 | daemon.test.ts:4021 `updateTeamJson / restoreConductors: T261 フィールド永続化` describe で team.json roundtrip を検証（`clearSentAt` 保持 / 他 4 つ undefined 戻り）|

## Issues Encountered

- `ConductorStateSchema` という名前で schema.ts を読もうとしたが、実際の export 名は `ConductorState`（型と schema 同名）だった。永続化テストで import alias を `{ ConductorState: ConductorStateSchema }` に修正して回避。
- scope outside の既存 tsc エラー 2 件（`conductor.ts:197` / `daemon.test.ts:3650`）には触らず、verify 時に grep で除外。
