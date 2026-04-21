# T260 Implementer Notes

## 実装したコミット

```
036e2a9 feat(manager): agent_spawned に caller 情報と abort_signal_sent を追加
c711aa7 feat(manager): conductor_broken に pid/alive 併記 + broken_conductor_still_alive ログ
0708b7a feat(manager): task_aborted ログに reason を機械可読キーで出力
e84b4f8 feat(manager): formatConductorSnapshot と disconnect snapshot ログを追加
b2cdd69 feat(manager): ConductorState.lastHookAt と AgentSpawnedMessage caller 情報を追加
```

plan.md §8 のコミット分割案（6 コミット）からは 5 コミット構成に変更。
当初の「コミット 6: E2E / doc / summary 補足（任意）」は本 implementer-notes で
代替しており、テンプレ変更や別ファイルの追加は無かったため独立コミット化していない。

## bun test の最終実行結果

```
534 pass
0 fail
1208 expect() calls
Ran 534 tests across 23 files. [20.05s]
```

（ベースライン 522 pass → +12 の追加テスト）

追加テストの内訳:

- `daemon.test.ts` T260 describe
  - `formatConductorSnapshot` 基本フォーマット
  - pid undefined → `pid=null alive=unknown`
  - SESSION_STARTED で `lastHookAt` が更新される
  - `__testSpawnPidWatcherTick` dead → `conductor_disconnected reason=pid_dead` snapshot
  - SESSION_ENDED (non-other) で `conductor_disconnected reason=session_ended:...` snapshot
  - broken Conductor への SESSION_STARTED は `session_event_ignored_broken` と `broken_conductor_still_alive` を並行出力
  - broken かつ pid 死亡時は `broken_conductor_still_alive` を出さない
  - AGENT_SPAWNED の `callerSurface/callerPid` が `agent_spawned` ログに載る
  - broken Conductor への AGENT_SPAWNED で `broken_conductor_still_alive` を出す

- `conductor.test.ts` T260 describe
  - broken 化時は `pid=X alive=<bool>` が出力される
  - pid 未定義の broken 化では `pid=null alive=unknown`
  - idle reset 経路では `pid=/alive=` を出さない（negative test / Reviewer 要望）

## Reviewer Recommendations 5 項目への対応状況

| # | 内容 | 対応 |
|---|------|------|
| 1 | `formatConductorSnapshot` を daemon.ts のローカル util に一本化 | ✅ `daemon.ts:192` に `export function formatConductorSnapshot`。conductor.ts 側には配置しない |
| 2 | `ConductorState.lastHookAt` を team.json に永続化 | ✅ schema.ts に `lastHookAt?: string` 追加、`updateTeamJson` で書き出し、`initializeLayout` で復元。復元後は次の SESSION_* 受信で上書きされる旨のコメントを `daemon.ts` 内に記載 |
| 3 | `cleanupAssignedTask` 戻り値変更の影響 (cmdRestartTask) | ✅ 戻り値を `{ method, pid? }` に変更。`cmdAbortTask` のみ `abort_signal_sent` を emit、`cmdRestartTask` は戻り値を捨ててコメントで理由を明記（restart-task は「中断」ではなく「やり直し」文脈のため） |
| 4 | `conductor_broken` の pid 未定義ケースは `pid=null alive=unknown` | ✅ `conductor.ts:resetConductor` で `pid=${conductor.pid ?? "null"} alive=${conductor.pid !== undefined ? cmux.isAlive(...) : "unknown"}` を emit。negative test で idle reset 経路に漏れないことを確認 |
| 5 | E2E の `DISCONNECT_TIMEOUT_SEC` env override 言及 | ✅ 本ファイル末尾の E2E 手順に記載 |

### 任意推奨への対応

- `conductor_disconnect_timeout` の `taskRunId=` 二重出力 → **対応済み**。snapshot 側に集約し、既存の `taskRunId=${taskRunId ?? "-"}` は削除（`daemon.ts:forceCloseDisconnectedConductor`）。

## 実装中の設計判断・trade-off

1. **`abort_signal_sent` の発火範囲**: plan では `user_clear / disconnect_timeout / assign_failed / abort-task` で発火する案だったが、実コードで `process.kill` が走るのは `cmdAbortTask` 経路のみ（他は state 遷移のみで SIGTERM を送らない）。`abort_signal_sent` のセマンティクスを「daemon が実際に停止シグナルを送った記録」に絞るため、abort-task のみに限定した。他 3 経路は既存の `task_aborted reason=...` で十分可観測。
2. **`broken_conductor_still_alive` の発火条件**: 「hook が届いた」だけでは古い hook の遅延着の可能性があるため、`cmux.isAlive(pid)` も確認してから emit。pid 未定義・pid 死亡ケースでは発火させない。
3. **AGENT_SPAWNED の caller 情報は任意フィールド**: `callerPid`/`callerSurface` は optional。既存の AGENT_SPAWNED 経路（手動 POST 等）で schema 違反にならないよう、schema.ts 上も optional として定義済み。
4. **commit 分割**: plan §8 は 6 コミット案だったが、「コミット 6: doc 補足」を本 implementer-notes に統合し 5 コミットに収斂。

## 手動 E2E 検証手順（plan.md §5.3）

実環境での観測は以下の手順で再現できる（時間がかかるため本実装では省略。本番投入後に都度検証）。

### 1. disconnect snapshot の確認

```
# 前提: cmux-team start 済み
# Conductor が running のペインを開いて Claude プロセスを外部から kill
kill -9 <conductor_pid>

# daemon の PID watcher が 1s 以内に検出する:
tail -f .team/logs/manager.log | grep -E "conductor_disconnected|conductor_broken|broken_conductor_still_alive"
# 期待: conductor_disconnected C[NNN] reason=pid_dead pid=<PID> alive=false last_hook_at=... elapsed_since_last_hook=Ns taskRunId=...
```

### 2. disconnect_timeout → broken 遷移

```
# 既定の DISCONNECT_TIMEOUT_SEC (300s) を短縮するには:
CMUX_TEAM_DISCONNECT_TIMEOUT_SEC=30 cmux-team start

# Conductor kill 後 30s 経過で:
# 期待: conductor_disconnect_timeout C[NNN] pid=<PID> alive=false ... taskRunId=...
#       conductor_broken C[NNN] reason=disconnect_timeout pid=<PID> alive=false
```

### 3. broken_conductor_still_alive の発火

```
# broken 化したあと、何らかの理由で Claude が hook を POST してきた場合:
# 期待: session_event_ignored_broken C[NNN] event=SESSION_STARTED reason=broken_requires_manual_clear
#       broken_conductor_still_alive C[NNN] event=SESSION_STARTED pid=<PID> alive=true ...

# broken から復帰させるには:
cmux-team clear-conductor --surface <NNN>
```

### 4. agent_spawned caller 情報

```
# Conductor pane から agent を spawn:
# （Conductor セッション内で）
cmux-team spawn-agent --role implementer --task-title "demo" --prompt-file ...

# daemon ログ:
# 期待: agent_spawned C[NNN]>A[MMM] role=implementer caller=C[NNN] caller_pid=<PID>
```

### 5. abort_signal_sent

```
cmux-team abort-task --task-id T260 --reason "testing abort_signal_sent"
# 期待: abort_signal_sent task_id=T260 surface=C[NNN] reason=abort_task method=sigterm pid=<PID>
#       task_aborted task_id=T260 reason=abort_task title=...
```
