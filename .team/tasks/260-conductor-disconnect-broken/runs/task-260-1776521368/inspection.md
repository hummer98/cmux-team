# Inspection: T260 実装検品

## 判定

**GO**

## サマリー

plan.md §2 の 5 要件はすべて実装され、Design Reviewer の 5 Recommendations にも対応済み。`bun test` は 534 pass / 0 fail で、新規追加 12 テスト（broken/snapshot/caller/negative test）が要件の全側面と Reviewer 要望の negative test をカバーする。`session_event_ignored_broken` は互換のため保持されており、grep 運用への配慮も行き届いている。唯一の懸念は `daemon.test.ts:3191` の TS 型エラー（`source: "new_session"` が `SessionStartedMessage.source` enum に合致しない）で、bun test には影響しないが次回 cleanup 候補。機能面のブロッカーは無いため GO とする。

## 要件充足

| # | 項目 | 判定 | 証拠 |
|---|------|------|------|
| 【高 1】 | disconnect 期間の snapshot（pid/alive/last_hook_at/elapsed/taskRunId） | OK | `formatConductorSnapshot` 定義 = `daemon.ts:192`。5 経路すべてで出力 — pid_dead: `daemon.ts:2095-2098`、SESSION_ENDED: `daemon.ts:1474-1478`、assigning_stuck: `daemon.ts:2030`、assign_failed: `daemon.ts:2042`、disconnect_timeout: `daemon.ts:2318-2321` |
| 【高 2-a】 | `conductor_broken` に pid/alive 併記（未定義時は `pid=null alive=unknown`） | OK | `conductor.ts:566-570`。`pid=${conductor.pid ?? "null"} alive=${conductor.pid !== undefined ? String(cmux.isAlive(conductor.pid)) : "unknown"}` |
| 【高 2-b】 | `broken_conductor_still_alive` ログ追加 | OK | `daemon.ts:215-218` (`logBrokenIgnore` ヘルパー) + `daemon.ts:1120-1125` (AGENT_SPAWNED)。4 broken ガード（SESSION_STARTED/ACTIVE/IDLE/CLEAR）すべてを `logBrokenIgnore` に置換済み（`daemon.ts:1176`,`1533`,`1620`,`1776`） |
| 【中 3】 | `abort_signal_sent` 出力 | OK（スコープ縮小で妥当） | `main.ts:3076-3082`。Implementer notes §実装中の設計判断 1 に記載の通り `cmdAbortTask` のみに限定（実際に `process.kill` が走る唯一の経路）。CLAUDE.md「便利機能は best-effort」方針とも整合 |
| 【中 4】 | `task_aborted` の機械可読 `reason=` | OK | 5 経路すべてで `reason=` 付き — user_clear: `daemon.ts:1831`（既存）、disconnect_timeout: `daemon.ts:2365`（既存）、assign_failed: `daemon.ts:2011` 新規、abort_task (conductor 不在): `main.ts:3054` 新規、abort_task (通常): `main.ts:3095` 新規 |
| 【中 5】 | `agent_spawned` に caller_pid / caller_surface | OK | `main.ts:1972-1975` で POST、`daemon.ts:1135-1143` で `caller=<surface> caller_pid=<N>` 後置出力 |

## 実装品質

### ロギングポリシー準拠

- `formatSurface` / `formatPair` を全面使用、生の `surface:NNN` は存在しない（`daemon.ts:211,216,1115,1124,1138-1139`、`conductor.ts:570` 等）
- `key=value` 形式統一（`pid=12345 alive=true last_hook_at=... elapsed_since_last_hook=Ns taskRunId=...`）
- 高頻度ループ内のログ追加なし。`cmux.isAlive` (`process.kill(pid, 0)`) の呼び出しは (i) disconnect 遷移時、(ii) disconnect_timeout 発火時、(iii) broken 化時、(iv) broken 状態への hook 到達時 — いずれも低頻度経路のみ
- `session_event_ignored_broken` は互換のため **削除せず保持**（`daemon.ts:211-214`、plan §6 のリスク緩和方針どおり）

### 既存スタイル整合

- TypeScript + Zod schema（optional で後方互換維持）
- 日本語コメントで T260 由来を明示（例: `daemon.ts:186-191`, `schema.ts:217-221`）
- `AgentSpawnedMessage` / `ConductorState` の追加フィールドはすべて optional（`schema.ts:47-50, 217-221`）

### テスト通過

```
534 pass
0 fail
1208 expect() calls
Ran 534 tests across 23 files. [20.12s]
```

origin/main 時点 522 pass → T260 で +12 pass（すべて追加テスト）。既存テストの破壊なし。

### 型チェック（参考）

`bunx tsc --noEmit` で 1 件の型エラーが新規に発生:

```
daemon.test.ts(3191,9): error TS2322: Type '"new_session"' is not assignable to type '"startup" | "resume" | "clear" | "compact" | undefined'.
```

origin/main の同ファイルでは 0 件だったため T260 で混入した test-only issue。`package.json` に `typecheck` script は無く、bun test は runtime Zod なので実行には影響しない。機能影響ゼロのため GO 判定は変えず、次回 cleanup 候補として指摘。

## Reviewer Recommendations 対応

| # | 内容 | 実コード確認 |
|---|------|------|
| 1 | `formatConductorSnapshot` を daemon.ts のローカル util に一本化 | OK — `daemon.ts:192` のみに定義。`conductor.ts` / 他ファイルに重複なし（`rg formatConductorSnapshot` で確認済み） |
| 2 | `ConductorState.lastHookAt` を team.json に永続化 | OK — `schema.ts:221` で optional 定義、`daemon.ts:2461` で `updateTeamJson` 書き出し、`daemon.ts:875-877` で `initializeLayout` 復元。「次の SESSION_* で上書きされる」旨のコメントあり |
| 3 | `cleanupAssignedTask` 戻り値変更の restart-task 経路対応 | OK — `main.ts:2900-2903` で `CleanupResult` 型定義、`cmdAbortTask` (`main.ts:3074`) で受け取り `abort_signal_sent` emit、`cmdRestartTask` (`main.ts:3267-3270`) は戻り値を捨て「restart は中断ではなくやり直し」のコメントで意図明示 |
| 4 | `conductor_broken` pid 未定義時 `pid=null alive=unknown` | OK — `conductor.ts:569`。対応する negative test（idle reset では pid/alive を出さない）も `conductor.test.ts:486-504` に追加済み |
| 5 | E2E 手順に `CMUX_TEAM_DISCONNECT_TIMEOUT_SEC` 言及 | OK — `implementer-notes.md` §手動 E2E 検証手順 2 に明記。該当 env は `daemon.ts:2266-2267` で実在（default 300s） |

任意推奨（`conductor_disconnect_timeout` の `taskRunId=` 二重出力解消）も対応済み — `daemon.ts:2318-2321` で snapshot 一本化、旧 `taskRunId=${conductor.taskRunId ?? "-"}` の重複は削除。

## テスト結果

```
534 pass / 0 fail / 1208 expect() calls / 20.12s / 23 files
```

追加テスト（合計 12）:

- `daemon.test.ts` T260 describe: 9 テスト（snapshot 基本 / pid 未定義 / lastHookAt 更新 / pid_dead snapshot / SESSION_ENDED snapshot / broken SESSION_STARTED 並行出力 / broken pid 死亡は still_alive 非出力 / agent_spawned caller / broken AGENT_SPAWNED 警告）
- `conductor.test.ts` T260 describe: 3 テスト（broken pid alive / broken pid 未定義 / idle reset negative）

タイミング依存・実時計依存のテストはなし（`__setIsAliveImpl` / `__testSpawnPidWatcherTick` を使った in-memory 決定論的検証のみ）。flake 懸念なし。

## 破壊的変更・互換性

| 項目 | 影響 | 判定 |
|------|------|------|
| `AgentSpawnedMessage` に `callerPid`/`callerSurface` optional 追加 | 旧 spawn-agent からの POST は optional のまま受信可能 | 問題なし |
| `ConductorState.lastHookAt` optional 追加 | 旧 team.json 読み込みは `c.lastHookAt` が undefined で復元される | 問題なし |
| `cleanupAssignedTask` 戻り値 `void → CleanupResult` | caller 2 箇所（`cmdAbortTask` / `cmdRestartTask`）すべて更新済み。外部 import なし（`rg cleanupAssignedTask` で自身の定義 + 2 caller のみ） | 問題なし |
| `task_aborted` ログのフィールド順序変更（reason を早い位置に） | `journal_summary=` キー名は維持。キーベース grep は影響なし | 問題なし |
| `conductor_disconnect_timeout` から独立 `taskRunId=` フィールド削除（snapshot 内へ統合） | key 名 `taskRunId=` は snapshot 内に含まれるため `grep taskRunId=` 互換 | 問題なし |
| `session_event_ignored_broken` 継続出力 | `dashboard.tsx:271` 等の既存読み手に影響なし | 問題なし |
| Plan 比での微小差分: `agent_spawned` の caller role prefix は plan で "S" (unknown) だったが実装は "C" | spawn-agent は Conductor 由来がデフォルトなので "C" の方が情報量が多く妥当 | 問題なし（小さな改善） |

## Fix Required

なし（GO）。次回改善候補:

1. `daemon.test.ts:3191` — `source: "new_session"` を `SessionStartedMessage.source` enum の値（例: `"startup"`）に差し替えるか、該当フィールドを削除する。`bun test` には影響しないが `tsc --noEmit` が 1 件失敗する。T260 で新規混入（origin/main の同ファイルは 0 件）。
2. 本実装のスコープ外だが、broken 後に能動的に PID を再確認する仕組み（`pidWatcherInterval` の復活 or ポーリング）を別タスクで検討する価値あり — 今回のログ追加で「broken なのに生きている」事象が可視化されたので、自動回収の判断材料として使える。
