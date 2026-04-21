# T260 実装計画書: Conductor disconnect/broken 周辺のログ拡充

## 1. 全体方針

T254 × C[128] のような「broken なのに Agent が spawn され続ける」現象の事後調査を「1 本のログで状態が分かる」レベルに引き上げる。
本タスクは **観測性向上のみ** を目的とし、状態遷移ロジックそのものは変更しない（broken 時の自動 kill 等は別タスク扱い）。

ただし、観測のために以下 2 点だけ最小限の state / message スキーマ変更を行う:

- `ConductorState.lastHookAt?: string` を追加（disconnect スナップショット用）
- `AgentSpawnedMessage` に `callerPid?: number` / `callerSurface?: string` を追加（spawn-agent 発行元追跡用）

どちらも optional で互換性は維持される。

---

## 2. 既存コード調査結果（調査観点への回答）

### 調査観点 1: 既存 state からのログ情報取得可能性

| 必要情報 | 既存 state | 取得可否 | 対処 |
|----------|------------|---------|------|
| Conductor PID 生存 | `conductor.pid` (schema.ts:208) | ○ `cmux.isAlive(pid)` (cmux.ts:224) | そのまま使える |
| 最終 hook 受信時刻 | **無し** | × | `ConductorState.lastHookAt` を新設 |
| taskRunId | `conductor.taskRunId` | ○ | そのまま |
| disconnect 経過時間 | `conductor.disconnectedAt` から計算 | ○ | そのまま |
| spawn-agent 呼び出し元 PID/surface | message に無し | × | `AgentSpawnedMessage` に追加 |

**結論:** PID alive 状態と taskRunId は state.conductors からそのまま取得可能。最終 hook 時刻のみ新規 state フィールドが必要。

### 調査観点 2: broken 後の Conductor プロセス生存検知

現状: `forceCloseDisconnectedConductor` (daemon.ts:2272) が `pidWatcherInterval` を clear する（L2324-2327）。これにより broken 遷移と同時に PID 監視は **完全停止する**。
hook push が来た場合は handler 入口の `if (conductor.status === "broken")` ガード（daemon.ts:1119/1470/1558/1713）で `session_event_ignored_broken` を出すだけで終わる。

つまり broken 後の生存確認チャネルは「事象ベース（push が来たかどうか）」のみで、能動的に生死を見ているコードは存在しない。

**対処方針:** broken への遷移直前に最後の pid alive 確認を行ってログに焼き、その後の AGENT_SPAWNED / SESSION_* 受信時に「broken なのに event が来た」ログを生存情報付きで出す。
broken 後の能動的な PID watcher 復活はスコープ外（その実装は「broken の自動 kill」or「broken からの自動 idle 復帰」など別タスクで議論する）。

### 調査観点 3: reason 機械可読化と journal 互換性

現状の `task_aborted` ログは 5 経路あり、reason の付け方が不統一:

| 経路 | 場所 | 現状フォーマット |
|------|------|------------------|
| user_clear | daemon.ts:1770 | `task_id=N reason=user_clear` |
| disconnect_timeout | daemon.ts:2302 | `task_id=N reason=disconnect_timeout journal_summary=...` |
| assign_failed (kind=task) | daemon.ts:1949 | `task_id=N title=... journal_summary=assign_failed: ...` ← reason 無し |
| abort-task CLI | main.ts:3032 / 3065 | `task_id=N title=... journal_summary=...` ← reason 無し |
| (delete-task は task_aborted を出さず deleted のみ) | main.ts:3280+ | n/a |

journal（task-state.json 内の文字列）は今回触らない。task-state.json の `journal` フィールドは既存の読み手（CLI の `cmux-team task show` 等）に影響するため互換維持。
ログ側だけ `reason=<enum>` を必ず先頭に付け、journal_summary は補助情報として残す（既存 grep を壊さないため `journal_summary=` キー名は維持）。

### 調査観点 4: 1 PR にまとめるか / 分割するか

タスクが「1 つの観測性向上」なので **1 PR で出す** が、コミットは下記 6 つに分割して review 可能性を担保する。
他タスクへの影響面が小さい順から積むことで、review 中の rebase が発生しても先頭側が無傷で残る。

---

## 3. 実装方針（5 項目別）

### 【高 1】disconnect 期間のスナップショット

**目的:** `conductor_disconnected` 遷移時と `conductor_disconnect_timeout` 発火時の 2 点で、1 本で状態が分かるログを出す。

#### 3.1.1 新規ヘルパー: `formatConductorSnapshot(conductor)`

**追加先:** `skills/cmux-team/manager/conductor.ts`（末尾、export 関数として）または `daemon.ts` のローカル util 経由で `cmux.isAlive` を呼び出すため `daemon.ts` 内のローカル関数で良い。

擬似コード:
```ts
function formatConductorSnapshot(conductor: ConductorState): string {
  const pid = conductor.pid;
  const aliveStr = pid !== undefined ? String(cmux.isAlive(pid)) : "unknown";
  const lastHook = conductor.lastHookAt ?? "-";
  const elapsed = conductor.lastHookAt
    ? `${Math.round((Date.now() - new Date(conductor.lastHookAt).getTime()) / 1000)}s`
    : "-";
  return `pid=${pid ?? "null"} alive=${aliveStr} last_hook_at=${lastHook} elapsed_since_last_hook=${elapsed} taskRunId=${conductor.taskRunId ?? "-"}`;
}
```

**注:** `cmux.isAlive` は `process.kill(pid, 0)` を 1 回呼ぶだけの同期処理。disconnect 遷移時 / disconnect_timeout 発火時の発生頻度（タスク assign 数 / minute レベル）では blocking で問題なし（観点 2-2 への回答）。

#### 3.1.2 `lastHookAt` 更新点

`ConductorState` に `lastHookAt?: string` (ISO 8601) を追加し、以下の handler で更新する:

| handler | 場所 | 既存 disconnectedAt クリア箇所 |
|---------|------|-------------------------------|
| SESSION_STARTED | daemon.ts:1146 (Conductor 分岐) | `conductor.disconnectedAt = undefined` の直後 |
| SESSION_ACTIVE | daemon.ts:1477 | 同上 |
| SESSION_IDLE | daemon.ts:1565 | 同上 |
| SESSION_ASK | daemon.ts:1657 | 同上 |
| SESSION_CLEAR | daemon.ts:1734 (disconnected → idle 分岐のみ) | 既存の `disconnectedAt = undefined` の直後 |
| SESSION_ENDED | daemon.ts:1409 | **更新しない**（disconnect 起点。disconnectedAt と同じ値が入る） |

更新ルール: `conductor.lastHookAt = message.timestamp ?? new Date().toISOString();`

#### 3.1.3 ログ追加箇所

**A. `conductor_disconnected` 5 箇所すべて** に snapshot を併記:

| 行 | 既存ログ | 追加内容 |
|----|---------|---------|
| daemon.ts:1968 | `reason=assigning_stuck kind=task task_id=...` | + ` ${snapshot}` |
| daemon.ts:1980 | `reason=assign_failed kind=conductor task_id=... detail=...` | + ` ${snapshot}` |
| daemon.ts:2030 (`__testSpawnPidWatcherTick`) | この行は `session_ended` を出すだけだが、その直後の `conductor.status = "disconnected"` 設定後に新規 `conductor_disconnected` ログを追加。`reason=pid_dead pid=${pid}` + snapshot |
| daemon.ts:1409 (SESSION_ENDED) | `session_ended` のみで `conductor_disconnected` は出していない。同じ箇所に追加: `conductor_disconnected ${formatSurface(surface, "C")} reason=session_ended ${snapshot}` |
| daemon.ts:809-815 (restoreConductorsFromTeamJson の pid_dead 経路) | 既存 `conductor_pid_dead` ログがある。この直後に同 reason で `conductor_disconnected` を追加するか、既存ログに snapshot を後付けする |

**B. `conductor_disconnect_timeout` (daemon.ts:2249)** に snapshot を併記:
```
conductor_disconnect_timeout C[128] elapsed=310s ${snapshot}
```
※ 既存の `taskRunId=... elapsed=...` フィールドは snapshot 内に含まれるため、二重出力にならないようフォーマットを統一する。

#### 3.1.4 schema.ts 変更

```ts
export const ConductorState = z.object({
  // ... 既存 ...
  lastHookAt: z.string().datetime().optional(),  // 追加
});
```
runtime 専用フィールドではないため Zod スキーマに含める。永続化（team.json）には自動で含まれる（restoreConductorsFromTeamJson 経由で復元される）。

---

### 【高 2】broken 後の Conductor プロセス生存可視化

#### 3.2.1 `conductor_broken` ログに pid alive 併記

**変更箇所:** `conductor.ts:567-569`

```ts
// 変更前
const reasonSuffix = opts?.reason ? ` reason=${opts.reason}` : "";
await log(
  targetStatus === "broken" ? "conductor_broken" : "conductor_reset",
  `${formatSurface(conductor.surface, "C")}${reasonSuffix}`,
);
```

```ts
// 変更後
const reasonSuffix = opts?.reason ? ` reason=${opts.reason}` : "";
const aliveSuffix = targetStatus === "broken" && conductor.pid !== undefined
  ? ` pid=${conductor.pid} alive=${cmux.isAlive(conductor.pid)}`
  : "";
await log(
  targetStatus === "broken" ? "conductor_broken" : "conductor_reset",
  `${formatSurface(conductor.surface, "C")}${reasonSuffix}${aliveSuffix}`,
);
```

注: `conductor.ts` から `cmux.isAlive` を import する（既存 import に追加）。idle reset 経路では pid 情報を出さない（後続で SESSION_STARTED が来て pid が再設定される）。

#### 3.2.2 broken 中の event 受信ログを「危険状態」表現に切替

**現状:** `session_event_ignored_broken` のみが 4 箇所（daemon.ts:1121/1472/1560/1715）で出力されているが、「プロセスが生きているのに event が来た」という危険信号としては弱い。

**変更:** イベント名を `broken_conductor_still_alive` に変えるのではなく、**並行して** 2 本目を出す（既存の `session_event_ignored_broken` を grep している運用がある可能性に配慮）。

擬似コード（4 箇所共通）:
```ts
if (conductor.status === "broken") {
  await log(
    "session_event_ignored_broken",
    `${formatSurface(conductor.surface, "C")} event=SESSION_STARTED reason=broken_requires_manual_clear`
  );
  if (conductor.pid !== undefined && cmux.isAlive(conductor.pid)) {
    await log(
      "broken_conductor_still_alive",
      `${formatSurface(conductor.surface, "C")} pid=${conductor.pid} event=SESSION_STARTED`
    );
  }
  break;
}
```

ヘルパー化: 4 箇所同一パターンなので `daemon.ts` 内に local helper を作る:
```ts
async function logBrokenIgnore(conductor: ConductorState, eventName: string): Promise<void> {
  await log("session_event_ignored_broken", `${formatSurface(conductor.surface, "C")} event=${eventName} reason=broken_requires_manual_clear`);
  if (conductor.pid !== undefined && cmux.isAlive(conductor.pid)) {
    await log("broken_conductor_still_alive", `${formatSurface(conductor.surface, "C")} pid=${conductor.pid} event=${eventName}`);
  }
}
```

#### 3.2.3 AGENT_SPAWNED が broken に来たケース

**変更箇所:** `daemon.ts:1077-1091` (AGENT_SPAWNED handler)

現状 broken のチェックは無い。`conductor` が見つかったら無条件で `agents.push` してしまう。
broken 状態への AGENT_SPAWNED は **無視せずに記録のみ行い** Agent 登録は **続行する**（後段で resetConductor が再度走った時に sibling close される設計が崩れないようにする）。

```ts
const conductor = findConductor(state, message.conductorSurface);
if (conductor) {
  if (conductor.status === "broken") {
    const aliveStr = conductor.pid !== undefined ? String(cmux.isAlive(conductor.pid)) : "unknown";
    await log(
      "broken_conductor_still_alive",
      `${formatSurface(conductor.surface, "C")} pid=${conductor.pid ?? "null"} alive=${aliveStr} event=AGENT_SPAWNED agent=${formatSurface(message.surface, "A")}${message.role ? ` role=${message.role}` : ""}`
    );
  }
  conductor.agents.push({ /* 既存 */ });
  // 既存の agent_spawned ログ
}
```

---

### 【中 3】abort 通知の有無

**目的:** `task_aborted` 時に Conductor 側へ停止シグナルを送ったか/送っていないかを明示的にログする。

#### 3.3.1 `abort_signal_sent` イベントの定義

フォーマット:
```
abort_signal_sent C[N] task_id=X method=<none|cmux_send|sigterm|sigkill> reason=<reason>
```

method の意味:
- `none`: シグナル送信なし（disconnect_timeout 経路 / assign_failed 経路）
- `cmux_send`: `cmux.send(surface, "/exit")` 等のソフト停止（現状未実装、将来用の予約）
- `sigterm`: `process.kill(pid, "SIGTERM")` （abort-task / restart-task 経路）
- `sigkill`: SIGKILL（現状未実装、将来用）

#### 3.3.2 出力箇所

| 経路 | 既存 task_aborted の場所 | abort_signal_sent の追加内容 |
|------|----------------------|------------------------------|
| user_clear (daemon.ts:1770) | running → SESSION_CLEAR | `method=none reason=user_clear` （既存コードは pid を kill していない — `conductor.pid = undefined` で参照を切るだけ） |
| disconnect_timeout (daemon.ts:2302) | forceCloseDisconnectedConductor | `method=none reason=disconnect_timeout` （PID kill 無し。これが調査時に「Conductor が走り続ける」と判明する根拠ログになる） |
| assign_failed kind=task (daemon.ts:1949) | scanTasks の AssignTaskError catch | `method=none reason=assign_failed kind=task` |
| abort-task CLI (main.ts:3032 conductor 不在経路) | conductor 不在時 | `method=none reason=abort_task conductor=not_found` |
| abort-task CLI (main.ts:3065 conductor あり経路) | cleanupAssignedTask 完了後 | `method=sigterm reason=abort_task pid=${conductor.pid}` （cleanupAssignedTask が SIGTERM を送るため） |

**注:** main.ts 側では state.conductors を直接参照できない（CLI プロセス）。`conductor.pid` は team.json から得る。`cleanupAssignedTask` 内で実際に SIGTERM を送ったか（`isProcessAlive` の結果）を返り値で受け取り、それに応じて method を決定する設計が望ましい:

```ts
// cleanupAssignedTask の戻り値を変更
async function cleanupAssignedTask(conductor: any): Promise<{ killMethod: "sigterm" | "none"; pid?: number }> {
  // ... 既存 ...
  if (conductor.pid && isProcessAlive(conductor.pid)) {
    process.kill(conductor.pid, "SIGTERM");
    return { killMethod: "sigterm", pid: conductor.pid };
  }
  return { killMethod: "none", pid: conductor.pid };
}
```

呼び出し側で結果を受けて `abort_signal_sent` を出す。

---

### 【中 4】user_clear / その他 abort 理由のトップレベル化

**目的:** `task_aborted` の reason を必ず機械可読な enum 値で出力する。

#### 3.4.1 reason 値の定義（enum）

```
user_clear           - SESSION_CLEAR (running → idle 経路)
disconnect_timeout   - forceCloseDisconnectedConductor
assign_failed        - scanTasks AssignTaskError catch (kind=task)
abort_task           - abort-task CLI (cmdAbortTask)
restart_task         - restart-task CLI (cmdRestartTask が CONDUCTOR_DONE reason=restarted を送る経路の補完。task_aborted 自体は出ないので除外)
```

#### 3.4.2 既存 task_aborted ログのフォーマット統一

| 場所 | Before | After |
|------|--------|-------|
| daemon.ts:1770 | `task_id=${taskId} reason=user_clear` | （変更なし — 既に reason 付き） |
| daemon.ts:1949 | `task_id=${task.id} title=${task.title} journal_summary=assign_failed: ${e.reason}` | `task_id=${task.id} reason=assign_failed title=${task.title} journal_summary=...` |
| daemon.ts:2302 | `task_id=${taskId} reason=disconnect_timeout journal_summary=${journal}` | （変更なし — 既に reason 付き） |
| main.ts:3032 | `task_id=${taskId}${title ...} journal_summary=${journal}` | `task_id=${taskId} reason=abort_task${title ...} journal_summary=${journal}` |
| main.ts:3065 | `task_id=${taskId}${title ...} journal_summary=${journal}` | `task_id=${taskId} reason=abort_task${title ...} journal_summary=${journal}` |

journal_summary フィールド名は既存運用のため維持。順序は `task_id=` → `reason=` → 残り、で統一する。

#### 3.4.3 互換性

- task-state.json の `journal` フィールドは触らないため CLI / TUI の表示は変化しない
- ログを grep している運用（あれば）に対しては「reason= が必ず先頭近くに出る」という追加保証が入るだけで、既存フィールドは削除しない（破壊的変更なし）

---

### 【中 5】spawn-agent の発行元情報

#### 3.5.1 schema.ts 変更

```ts
export const AgentSpawnedMessage = z.object({
  type: z.literal("AGENT_SPAWNED"),
  conductorSurface: z.string(),
  surface: z.string(),
  role: z.string().optional(),
  taskTitle: z.string().optional(),
  callerPid: z.number().optional(),       // 追加
  callerSurface: z.string().optional(),   // 追加
  timestamp: z.string().datetime(),
});
```

#### 3.5.2 main.ts cmdSpawnAgent 変更

**変更箇所:** `main.ts:1965-1972`

```ts
// caller の取得
const callerSurface = process.env.CMUX_SURFACE;  // spawn-agent が走っている surface（通常は Conductor 自身）
const callerPid = process.pid;                    // CLI プロセスの PID

await postMessage({
  type: "AGENT_SPAWNED",
  conductorSurface,
  surface,
  role,
  taskTitle,
  callerPid,
  callerSurface,
  timestamp: new Date().toISOString(),
});
```

`callerSurface` は CLI プロセスを起動したシェルの環境変数 `CMUX_SURFACE` を読む。Conductor が起動した spawn-agent なら Conductor の surface、Manager 経由なら Manager の surface（または不在）。
`callerPid` は spawn-agent CLI 自身の PID。**Conductor の Claude プロセス PID とは異なる** ことに注意（spawn-agent は Claude Code の Bash tool 経由で起動された子プロセス）。
ただし、shell の親プロセスを辿れば Conductor の Claude PID を特定できるため、調査時の起点として十分機能する。

**より精確な caller_pid を取りたい場合:** `process.ppid` も併記する案もあるが、ppid は shell の PID であって Claude の PID ではない。今回は `callerPid=process.pid + callerSurface` で「どの surface 経由で発行されたか」が分かれば十分とする（broken 判定は callerSurface で行える）。

#### 3.5.3 daemon.ts AGENT_SPAWNED handler 変更

**変更箇所:** `daemon.ts:1087-1090`

```ts
// 変更前
await log(
  "agent_spawned",
  `${formatPair(message.conductorSurface, message.surface, "C", "A")}${message.role ? ` role=${message.role}` : ""}`
);
```

```ts
// 変更後
const callerSuffix = message.callerSurface
  ? ` caller=${formatSurface(message.callerSurface, "S")}${message.callerPid ? ` caller_pid=${message.callerPid}` : ""}`
  : "";
await log(
  "agent_spawned",
  `${formatPair(message.conductorSurface, message.surface, "C", "A")}${message.role ? ` role=${message.role}` : ""}${callerSuffix}`
);
```

`callerSurface` のロールは `S`（不明）で出す。これは Conductor 由来か Manager 由来か Master 由来か特定できないため。
将来的に `cmux-team` CLI が呼び出し元を判定して `caller_role` を渡せるようになったら `formatSurface(s, role)` の role を切り替える。

---

## 4. ファイル/関数変更サマリ

| ファイル | 関数 / 行 | 変更内容 |
|---------|-----------|---------|
| skills/cmux-team/manager/schema.ts | `ConductorState` (L200-) | `lastHookAt?: string` 追加 |
| skills/cmux-team/manager/schema.ts | `AgentSpawnedMessage` (L41-) | `callerPid?: number`, `callerSurface?: string` 追加 |
| skills/cmux-team/manager/daemon.ts | new helper `formatConductorSnapshot()` | pid/alive/lastHookAt/elapsed/taskRunId をフォーマット |
| skills/cmux-team/manager/daemon.ts | new helper `logBrokenIgnore()` | session_event_ignored_broken + broken_conductor_still_alive を一括出力 |
| skills/cmux-team/manager/daemon.ts | SESSION_STARTED / ACTIVE / IDLE / ASK / CLEAR handler 各 Conductor 分岐 | `conductor.lastHookAt = message.timestamp` 追加 |
| skills/cmux-team/manager/daemon.ts | `__testSpawnPidWatcherTick` (L2019-) | dead 検出時に `conductor_disconnected ... ${snapshot}` ログ追加 |
| skills/cmux-team/manager/daemon.ts | scanTasks AssignTaskError catch (L1949-1992) | `conductor_disconnected` ログに snapshot 併記 + `task_aborted` に reason 追加 |
| skills/cmux-team/manager/daemon.ts | `monitorConductors` `conductor_disconnect_timeout` (L2249-2252) | snapshot 併記 |
| skills/cmux-team/manager/daemon.ts | `forceCloseDisconnectedConductor` `task_aborted` (L2301-2304) | reason 順序統一（既に reason 付き） |
| skills/cmux-team/manager/daemon.ts | SESSION_CLEAR `task_aborted` (L1770) | reason 既に付与 — 変更なし |
| skills/cmux-team/manager/daemon.ts | SESSION_CLEAR running 分岐 (L1755-1791) | `abort_signal_sent C[N] task_id=X method=none reason=user_clear` 追加 |
| skills/cmux-team/manager/daemon.ts | forceCloseDisconnectedConductor (L2272-) | `abort_signal_sent ... method=none reason=disconnect_timeout` 追加 |
| skills/cmux-team/manager/daemon.ts | scanTasks AssignTaskError kind=task 分岐 | `abort_signal_sent ... method=none reason=assign_failed` 追加 |
| skills/cmux-team/manager/daemon.ts | broken ガード 4 箇所 (L1119-1124, L1470-1475, L1558-1563, L1713-1718) | `logBrokenIgnore(conductor, "SESSION_STARTED")` 等に置換 |
| skills/cmux-team/manager/daemon.ts | AGENT_SPAWNED handler (L1077-1091) | broken 状態の Conductor からの spawn を `broken_conductor_still_alive` で記録 + caller 情報をログに含める |
| skills/cmux-team/manager/conductor.ts | `resetConductor` (L502-573) | broken 経路で `pid=X alive=true|false` を `conductor_broken` ログに併記 |
| skills/cmux-team/manager/main.ts | `cleanupAssignedTask` (L2890-2932) | 戻り値を `{ killMethod, pid }` に変更 |
| skills/cmux-team/manager/main.ts | `cmdAbortTask` (L2985-3106) | `cleanupAssignedTask` 戻り値を受けて `abort_signal_sent` ログ + `task_aborted` に reason=abort_task 追加（2 箇所） |
| skills/cmux-team/manager/main.ts | `cmdSpawnAgent` (L1965-1972) | `AGENT_SPAWNED` メッセージに `callerPid=process.pid`, `callerSurface=process.env.CMUX_SURFACE` を追加 |

---

## 5. テスト方針

### 5.1 既存ユニットテスト構成の確認

- `daemon.test.ts` (3000+ 行) — DaemonState の handler 単体テストが充実。`conductor_broken` / `conductor_disconnect_timeout` / `task_aborted` 系の既存テストあり (L810, L2258, L2736-2909 等)
- `conductor.test.ts` — `resetConductor` の broken 経路テストあり (L406)
- 慣行: `setIsAliveImpl` (cmux.ts:221) で PID 生存をモックし、`__testSpawnPidWatcherTick` を直接呼んで状態遷移を検証

### 5.2 追加するユニットテスト

| テスト | ファイル | 内容 |
|--------|---------|------|
| `lastHookAt が SESSION_STARTED で更新される` | daemon.test.ts | message.timestamp が conductor.lastHookAt に入ることを検証 |
| `lastHookAt が disconnect 経路で snapshot ログに出る` | daemon.test.ts | `__testSpawnPidWatcherTick` で dead → ログ末尾に `last_hook_at=...` が出ることを assert（log フォーマットを正規表現で検証） |
| `conductor_broken に pid=N alive=true が併記される` | conductor.test.ts | `setIsAliveImpl(() => true)` で broken に遷移させ、ログ出力に `pid=` `alive=true` が含まれることを検証 |
| `broken 状態への SESSION_STARTED で broken_conductor_still_alive が出る` | daemon.test.ts | broken 化 → SESSION_STARTED 投入 → ログ 2 本（既存 ignored + 新規 still_alive）が出ることを検証 |
| `broken 状態への AGENT_SPAWNED で broken_conductor_still_alive が出る` | daemon.test.ts | 同上、AGENT_SPAWNED 投入版 |
| `task_aborted の全 4 経路で reason= が含まれる` | daemon.test.ts + main の単体テスト（あれば） | user_clear / disconnect_timeout / assign_failed / abort_task の各経路でログを確認 |
| `abort_signal_sent が disconnect_timeout 経路で method=none で出る` | daemon.test.ts | forceCloseDisconnectedConductor 直接呼び出しでログ検証 |
| `agent_spawned に caller=S[N] caller_pid=N が出る` | daemon.test.ts | AGENT_SPAWNED handler に callerPid/callerSurface 付きで投入し、ログ末尾を検証 |

ログ検証ヘルパーは既存の `daemon.test.ts` に存在する（manager.log を読み取って正規表現マッチ）。同パターンを踏襲する。

### 5.3 E2E（手動）

CLAUDE.md の「テスト方法」セクションに従って `cmux-team start` → 適当なタスク投入 → 1 つの Conductor を `kill -9 <pid>` で殺す → disconnect_timeout 到達まで 5 分待機 → manager.log を grep:

```bash
grep -E "conductor_disconnected|conductor_disconnect_timeout|conductor_broken|task_aborted|abort_signal_sent" .team/logs/manager.log
```

期待する出力（順序）:
1. `conductor_disconnected ... pid=X alive=false last_hook_at=...`
2. `conductor_disconnect_timeout ... elapsed=310s pid=X alive=false ...`
3. `task_aborted task_id=N reason=disconnect_timeout journal_summary=...`
4. `abort_signal_sent C[N] task_id=N method=none reason=disconnect_timeout`
5. `conductor_broken C[N] reason=disconnect_timeout pid=X alive=false`

その後、kill されたはずの Conductor を生存させた状態で `cmux send` で Claude を再投入し、SESSION_STARTED が来たら:
6. `session_event_ignored_broken C[N] event=SESSION_STARTED ...`
7. `broken_conductor_still_alive C[N] pid=X event=SESSION_STARTED`

---

## 6. リスク・影響範囲

| リスク | 影響 | 緩和策 |
|--------|------|--------|
| `conductor_disconnected` のログフォーマット変更 | grep 運用への影響 | 既存フィールド（reason= など）の順序とキー名は維持し、snapshot は末尾追加のみ |
| `conductor_disconnect_timeout` から `taskRunId=` フィールドが snapshot に統合される | grep 運用への影響 | snapshot 内にも `taskRunId=` を含めることで重複は出るが grep 互換性は維持 |
| `cleanupAssignedTask` の戻り値変更 | 既存 caller 2 箇所（abort-task / restart-task）の修正が必要 | 戻り値を optional 化（caller が無視しても良い）か、両 caller を同時更新 |
| `AgentSpawnedMessage` への optional フィールド追加 | キュー互換性 | optional のため、旧 spawn-agent 実装（caller 情報なし）からの POST も受信可能 |
| `lastHookAt` 復元の挙動 | restoreConductorsFromTeamJson 経由 | 永続化されない値に retreat したい場合は schema から外して runtime 専用にする選択肢もあり（要レビュー判断） |
| broken 中の `cmux.isAlive` 同期呼び出し | hook 受信頻度に応じて N 回 / sec | hook 自体が高頻度ではない（Stop hook = ターン境界）ため許容 |

---

## 7. コミット分割案（1 PR 内）

review 中に rebase が起きてもコンフリクトが小さい順:

1. **schema 拡張**: ConductorState.lastHookAt + AgentSpawnedMessage.callerPid/callerSurface
2. **lastHookAt 更新点追加**: SESSION_* handler 5 箇所で `conductor.lastHookAt = message.timestamp`
3. **formatConductorSnapshot ヘルパー + disconnect 系ログ拡充**: 高 1 すべて
4. **conductor_broken の pid alive 併記 + logBrokenIgnore 導入**: 高 2（AGENT_SPAWNED 以外）
5. **AGENT_SPAWNED handler の broken 警告 + caller 情報ログ**: 高 2 残り + 中 5
6. **abort_signal_sent / task_aborted reason 統一**: 中 3 + 中 4

各コミットでユニットテスト追加を同梱する。

---

## 8. 完了判定

- 上記 1〜7 のコミットが PR としてまとまっている
- ユニットテスト（`bun test` 全件）が green
- E2E（手動）で manager.log に新規ログが期待通り出る
- 既存 `session_event_ignored_broken` / `conductor_disconnected` / `task_aborted` を grep する箇所（dashboard.tsx:271 等）が壊れていない
