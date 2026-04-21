# Design Review: T260 plan.md

## 判定

**Approved**（実装時に下記「注意してほしい点」を踏まえること）

## サマリー

5 項目の要件をすべてカバーし、参照されているファイル/関数/行は実装と概ね一致する。`formatSurface` / `formatPair` 等の CLAUDE.md ロギングポリシーにも整合。ただし (a) `lastHookAt` の永続化方針が未確定、(b) `cleanupAssignedTask` 戻り値変更の影響範囲に restart-task 経路が漏れている、(c) ヘルパー（`formatConductorSnapshot`）の配置場所が plan 内で二択のまま、の 3 点のみ実装前に固めてほしい。

## 要件カバレッジ

| # | 項目 | 優先度 | 判定 | 備考 |
|---|------|-------|------|------|
| 1 | disconnect 期間のスナップショット | 高 | OK | `formatConductorSnapshot` で pid / alive / last_hook_at / elapsed / taskRunId を一括出力。5 箇所の `conductor_disconnected` + `conductor_disconnect_timeout` を網羅 |
| 2 | broken 後の Conductor プロセス生存可視化 | 高 | OK | `conductor_broken` へ `pid=X alive=...` 併記 + 新ログ `broken_conductor_still_alive` を 4 つの SESSION_* ガードと AGENT_SPAWNED 経路で出す方針が明確 |
| 3 | abort 通知の有無 | 中 | OK | `abort_signal_sent method=<none/sigterm/...>` を 5 経路（user_clear / disconnect_timeout / assign_failed / abort-task 不在 / abort-task 通常）で定義。将来拡張 (cmux_send / sigkill) の enum も含めている |
| 4 | user_clear 等 reason 機械可読化（task_aborted トップレベル化） | 中 | OK | 5 経路すべてで `reason=` が必須位置に入ることを確認。enum 値 5 種を列挙 |
| 5 | spawn-agent の caller_pid / caller_surface | 中 | OK | `AgentSpawnedMessage` に optional 追加、`agent_spawned` ログに `caller=S[N] caller_pid=N` を後置。ロールは "S"（不明）で割り切る判断も妥当 |

## 実装妥当性

### ファイル・関数の特定精度

以下について現行実装と照合して一致を確認:

- `conductor.ts:565-569` の `conductor_broken` / `conductor_reset` 出力ブロック（plan が `:567-569` と書いた範囲と実体は同じ）
- `daemon.ts:1077-1091` の AGENT_SPAWNED handler（broken チェック無しの現状は plan の指摘通り）
- `daemon.ts:1119/1470/1558/1713` の broken ガード 4 箇所（ログ行は `1121/1472/1560/1715`、plan の記述通り）
- `daemon.ts:1409` の SESSION_ENDED (conductor 分岐) で `disconnected` へ遷移
- `daemon.ts:1968/1980` の `conductor_disconnected`（reason=assigning_stuck / assign_failed）
- `daemon.ts:2249-2252` の `conductor_disconnect_timeout` と `daemon.ts:2272-2335` の `forceCloseDisconnectedConductor`
- `daemon.ts:1770` の task_aborted（既に `reason=user_clear` 付き）
- `daemon.ts:1949-1951` の task_aborted（assign_failed）、`daemon.ts:2302` の task_aborted（disconnect_timeout）
- `main.ts:1965-1972` の postMessage AGENT_SPAWNED
- `main.ts:2890-2932` の `cleanupAssignedTask`、`main.ts:3032` / `main.ts:3065` の task_aborted
- `daemon.ts:810-815` の `conductor_restore_skipped`（plan は `:809-815` と書いているが実体は `:810-815`、誤差は許容範囲）

### ロギングポリシー整合

- `formatSurface(surface, "C")` / `formatPair(...)` を使う方針は CLAUDE.md 準拠
- `key=value` 統一（`pid=X alive=true last_hook_at=... elapsed_since_last_hook=Ns taskRunId=...`）で OK
- `session_event_ignored_broken` を消さずに `broken_conductor_still_alive` を **並行出力** する判断は、既存 grep 運用への配慮として妥当（破壊的変更を避ける）

### pid alive の同期呼び出し

- `cmux.isAlive` は `process.kill(pid, 0)` を 1 回呼ぶだけで blocking はコンマ秒以下
- 呼び出し頻度は (i) disconnect 遷移時、(ii) disconnect_timeout 発火時、(iii) broken 化時、(iv) broken 状態の Conductor に hook が到達した時の 4 パターン。(iv) は hook = ターン境界ごとで高頻度ではない。plan の許容判断は妥当

### broken 後の能動的 PID watcher 復活をスコープ外にする判断

- `pidWatcherInterval` は `forceCloseDisconnectedConductor` で clear 済み（確認済み: `daemon.ts:2323-2327`）。broken 後に復活させるのは状態遷移変更を伴うため、今回の観測性向上スコープから外す判断は正しい

## 既存互換性

### 非破壊と判定できるもの

- `AgentSpawnedMessage` に optional フィールド追加 → 旧 spawn-agent からの POST もパース可能（zod optional）
- `ConductorState.lastHookAt` を optional 追加 → 旧 team.json 読み込みも成立
- `task_aborted` ログのフィールド順序変更（reason を task_id の後ろに挿入） → `journal_summary=` は維持されるため、キー名ベースの grep は壊れない
- `session_event_ignored_broken` を残したまま `broken_conductor_still_alive` を追加 → dashboard.tsx:271 等の既存読み手に影響なし

### 注意が必要なもの

- `cleanupAssignedTask` の戻り値変更 (`void → { killMethod, pid }`) は破壊的変更。**main.ts 内の caller は abort-task だけでなく restart-task 経路 (`cmdRestartTask`、L3265 付近で同名関数を呼ぶ) にも影響する**。plan の Section 3.3.2 と 4 の表に restart-task が含まれていないため、影響の洗い出しを追加してほしい。
- `conductor_disconnect_timeout` の `taskRunId=` が既存フィールドと snapshot 内で重複する件は plan が明示しているが、運用的には二重出力よりも snapshot 側を優先した方が一貫する（`taskRunId=` を既存側から外して snapshot 一本にする）。grep を守りたいだけなら両方出しても構わないが、実装時に方針を一本化してほしい。

## テスト方針

### 妥当な点

- `__testSpawnPidWatcherTick` / `__setIsAliveImpl` (cmux.ts) の既存テスト慣行を踏襲する方針は良い
- ユニット 8 項目のカバレッジ（lastHookAt 更新、snapshot ログ、conductor_broken pid/alive、broken_conductor_still_alive、task_aborted reason、abort_signal_sent、agent_spawned caller）は概ね網羅的

### 追加/修正してほしい点

- `conductor.test.ts` に「idle reset 経路では pid=/alive= が出ない」という **negative test** も追加してほしい（broken 経路との条件分岐を保証するため）
- `main.ts` 側の `cleanupAssignedTask` は単体テストがないため、戻り値変更を検証するには abort-task の E2E に頼ることになる。最低限 `cleanupAssignedTask` の戻り値型が caller 2 箇所で受けられることを type-check で担保するのが望ましい
- E2E 手順の「disconnect_timeout 到達まで 5 分待機」は手動検証の負担が大きい。`DISCONNECT_TIMEOUT_SEC` を短縮する env override（既存にあれば利用、無ければ Debug flag の案を検討）を手順に含めてほしい

## コミット分割

6 分割案は妥当で、rebase 耐性もある順序（schema → 状態更新 → ログ追加 → abort 統一）。各コミットでユニットテスト同梱のポリシーも良い。

1 点だけ: コミット 4（`conductor_broken` + `logBrokenIgnore`）とコミット 5（AGENT_SPAWNED 警告 + caller）は broken 判定ロジックを両方触るため、レビュー時は 4 と 5 を近い時期に並列レビューすると理解が早い。順序自体は維持してよい。

## Recommendations

Approved のため Planner へ差し戻しは不要。ただし実装時に以下を確定させてから着手すること:

- `plan.md §3.1.1`: `formatConductorSnapshot` の配置を **daemon.ts のローカル util** に一本化する（「conductor.ts 末尾 or daemon.ts 内ローカル」の二択を確定）。`cmux.isAlive` / `ConductorState` の参照元が daemon.ts 側に集中するため、そちらに置くほうが import が浅い
- `plan.md §3.1.4 & §6`: `ConductorState.lastHookAt` を **永続化する**（team.json に保存）と確定する。既に `disconnectedAt` が永続化されているため粒度が揃う。復元直後の挙動（古い lastHookAt で起動する）については、`restoreConductorsFromTeamJson` 内で「復元時の lastHookAt は次の SESSION_* 受信で上書きされる」旨をコメントで明示する
- `plan.md §4 の表`: `main.ts:cmdRestartTask`（L3265 付近）の `cleanupAssignedTask` 呼び出しも戻り値変更の影響対象として追記する。必要なら `abort_signal_sent` を restart-task 経路でも出すかを決める（出すなら `reason=restart_task`、出さないなら理由を plan にコメントとして残す）
- `plan.md §3.2.1`: `conductor_broken` 出力で `conductor.pid === undefined` のケース — broken 到達時に既に pid クリア済みのパスがあるなら、`pid=null alive=unknown` を明示出力するほうが snapshot と対称で追跡しやすい（現案は「pid 未定義なら何も付けない」）
- `plan.md §3.2.3`: broken 状態の Conductor に AGENT_SPAWNED が来た場合、Agent を `conductor.agents.push` **しても後続の resetConductor 実行時には siblings 経由で close される** 点を確認し、plan コメントとして根拠を残す（現状の記述は "sibling close 設計が崩れないように" で曖昧）
- `plan.md §5.3`: E2E 手順に `DISCONNECT_TIMEOUT_SEC` 短縮の env（既存 `CMUX_TEAM_DISCONNECT_TIMEOUT_SEC` 相当があれば明記、無ければ Debug override を検討）を追加
