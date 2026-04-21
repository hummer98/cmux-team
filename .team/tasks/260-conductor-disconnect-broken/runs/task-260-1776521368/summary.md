# T260 Summary: Conductor disconnect/broken 周辺のログ拡充

## 目的

T254 × C[128] の調査で顕在化した「disconnect → broken 遷移前後のログ空白」と「broken なのに Agent が spawn され続ける現象の原因不可視」を、1 本のログで状態が分かるよう可視化する。

## 成果

5 項目のログ拡充を完遂（全て plan.md §2 の優先度に沿って実装済み）:

| # | 項目 | 優先度 | 実装 |
|---|------|--------|------|
| 1 | disconnect 期間のスナップショット（pid / alive / last_hook_at / elapsed / taskRunId） | 高 | `formatConductorSnapshot` ヘルパーを `daemon.ts:192` に追加。5 経路で出力 |
| 2 | `conductor_broken` pid/alive 併記 + `broken_conductor_still_alive` | 高 | `conductor.ts:566-570` で pid/alive（未定義時 `pid=null alive=unknown`）。`daemon.ts:logBrokenIgnore` で broken 中 hook 受信を警告 |
| 3 | `abort_signal_sent` | 中 | `cmdAbortTask` 経路のみに限定（実際に `process.kill` が走る唯一の経路） |
| 4 | `task_aborted` の機械可読 `reason=` | 中 | user_clear / disconnect_timeout / assign_failed / abort_task すべて `reason=` キー付き |
| 5 | `agent_spawned` caller 情報 | 中 | `AgentSpawnedMessage` に optional `callerPid` / `callerSurface` 追加、`main.ts:1972-1975` で POST、`daemon.ts:1135-1143` でログ |

## 変更ファイル

- `skills/cmux-team/manager/schema.ts` — `ConductorState.lastHookAt`, `AgentSpawnedMessage.caller*` optional 追加
- `skills/cmux-team/manager/daemon.ts` — `formatConductorSnapshot`, `logBrokenIgnore`, snapshot ログ 5 経路、broken+alive 警告、caller ログ、abort reason 機械可読化、任意推奨の taskRunId 二重出力解消
- `skills/cmux-team/manager/conductor.ts` — `conductor_broken` pid/alive 併記、pid 未定義対応
- `skills/cmux-team/manager/main.ts` — `cleanupAssignedTask` 戻り値を `CleanupResult` に変更、`cmdAbortTask` で `abort_signal_sent` emit、`cmdRestartTask` は戻り値を捨てる（コメント明示）、AGENT_SPAWNED POST に caller 情報付加
- `skills/cmux-team/manager/daemon.test.ts` — T260 describe で 9 テスト追加
- `skills/cmux-team/manager/conductor.test.ts` — T260 describe で 3 テスト追加（うち 1 は idle reset negative test）

## コミット

```
036e2a9 feat(manager): agent_spawned に caller 情報と abort_signal_sent を追加
c711aa7 feat(manager): conductor_broken に pid/alive 併記 + broken_conductor_still_alive ログ
0708b7a feat(manager): task_aborted ログに reason を機械可読キーで出力
e84b4f8 feat(manager): formatConductorSnapshot と disconnect snapshot ログを追加
b2cdd69 feat(manager): ConductorState.lastHookAt と AgentSpawnedMessage caller 情報を追加
```

## テスト結果

```
534 pass / 0 fail / 1208 expect() calls / 20.12s / 23 files
```

origin/main 時点 522 pass → T260 で +12 テスト追加。既存テストの破壊なし。

## Design Review / Inspection

- Design Review: **Approved**（Recommendations 5 項目すべて実装時に反映済み）
- Inspection: **GO**（Fix Required なし）
- 任意推奨の `taskRunId=` 二重出力解消も snapshot 側に寄せて対応済み

## 残課題・次回改善候補

1. `daemon.test.ts:3191` の TS 型エラー（`source: "new_session"` が `SessionStartedMessage.source` enum に合致しない）。`bun test` には影響せず Inspector も GO 判定だが、`tsc --noEmit` で 1 件失敗する。次回 cleanup で修正推奨。
2. broken 後に能動的に PID 再確認する仕組み（`pidWatcherInterval` 復活 or ポーリング）は本タスクのスコープ外。今回のログで「broken なのに生きている」事象が可視化されたため、自動回収の判断材料として利用可能。別タスクで検討する価値あり。

## 手動 E2E 検証手順

`implementer-notes.md` §手動 E2E 検証手順 1〜5 参照。`CMUX_TEAM_DISCONNECT_TIMEOUT_SEC=30` で timeout を短縮可能（既存 env）。

## マージ方針

main ブランチへローカルマージ。conflict なし。

## 納品

- PR ではなくローカルマージ（本タスクは単独 Conductor / 共同レビュー不要の内部計装追加）
- worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-260-1776521368` → 削除
- ブランチ: `task-260-1776521368/task` → マージ後削除
