# T261 実装計画 v2: user_clear 誤判定の根拠スナップショットログ拡充

> 本計画は v1 に対する Design Reviewer のフィードバック（`design-review.v1.md`）5 項目を
> 全て反映した第 2 版。主な差分は以下:
>
> - **Step 0 の rebase を撤去**（本 worktree の base は `a1d51a2 Merge T259` で、T260 は既に含まれている）
> - **ConductorState 追加フィールドを 4 → 6 に拡張**（`sessionIdleAt` / `assignPromptFile` を追加）
> - **`source_guess` を pure 関数 `guessSessionIdleSource(prevStatus, ...)` として Step 2 で切り出し**、SESSION_IDLE ハンドラ冒頭で `prevStatus` をキャプチャして渡す
> - **ステップ数の表記を「Step 0〜Step 6 の計 7 段階（RED→GREEN は Step 1〜5 の 5 サイクル）」に修正**

## 1. 調査結果サマリー

### 1.1 user_clear 判定が発生する箇所（1 箇所のみ）

`user_clear` は `classify-stop.ts` ではなく、**daemon.ts の SESSION_CLEAR ハンドラ**で発火する。`classifyStopPayload` は `SESSION_STOP` payload を `IDLE` / `ASK` の二択に分類するのみで user_clear は関知しない（この点は task.md の調査期待ともやや異なる—`session_stop_classified` は Stop hook 分類、`user_clear` はそれとは別経路）。

判定ロジック（`daemon.ts:1936-2028` SESSION_CLEAR ハンドラ、worktree 実コード verify 済み）:

| 条件 | 処理 | 出力ログ |
|------|------|---------|
| Master surface | ignore | `master_session_clear_ignored` |
| Conductor `status=broken` | ignore | `session_event_ignored_broken`（T250） |
| Conductor `status=assigning` | 早期 return（daemon 自身の /clear を認識） | `session_clear_expected reason=daemon_assign_clear` |
| Conductor `status=disconnected\|starting` | idle / `conductor_recovered` / `conductor_ready` に復帰 | — |
| Conductor `status=running` + `taskRunId` 不一致 | stale 判定で早期 return | `session_clear_stale` |
| **Conductor `status=running` + `taskRunId` 一致（または未指定）** | **task_aborted reason=user_clear** + resetConductor | `task_aborted task_id=X reason=user_clear` |
| Conductor `status=idle` | 無音（TUI チラつき防止） | — |
| Agent surface | agent.status を running にリセット | `session_clear_agent_reset`（T236） |

該当 running 分岐の具体行: `daemon.ts:1986-2023`（`if (conductor && conductor.status === "running")` ブロック）。`task_aborted` emit は 2001 行。

### 1.2 T253 × C[128] 事例の race 分析

```
21:10:42 conductor_started task_id=253 C[128]          # assignTask: status="assigning" set、/clear 送信
21:10:44 session_stop_classified C[128] case=IDLE      # Stop hook (旧セッション) → IDLE
21:10:44 conductor_running via=SESSION_IDLE            # daemon.ts:1824-1831 保険経路で assigning→running
21:10:44 session_idle C[128]
21:10:45 task_aborted task_id=253 reason=user_clear    # 直後の SESSION_CLEAR: status=running で user_clear 認定
```

**根本原因**: assignTask の /clear 送信（21:10:42）に対し、**旧セッションの Stop hook** が先に飛来した。`daemon.ts:1824` の「T232 R1 保険経路」が `assigning && taskRunId` で running に遷移させたため、直後の SESSION_CLEAR（daemon 自身の /clear の遅延発火）が `session_clear_expected`（assigning 早期 return）ではなく user_clear 経路に流れ込んだ。

この race を**修正する**のは別タスクの責務（T261 のスコープ外）。T261 は「発生時にログから原因が追跡可能」な状態を作るのがゴール。

### 1.3 現在 state に保持している時刻フィールド

`ConductorState`（schema.ts:204-222）が持つ時刻系:

| フィールド | 目的 | 書き込みタイミング |
|-----------|------|-----------------|
| `startedAt` | Conductor 起動 / assign 開始時刻 | `assignTask` で `new Date().toISOString()`（conductor.ts:494） |
| `disconnectedAt` | disconnect 遷移時刻 | SESSION_ENDED / pid_dead / assign_failed |
| `lastHookAt` | **T260 で追加**。最後に届いた SESSION_* hook の時刻 | 各 hook ハンドラの先頭（SESSION_CLEAR ハンドラでも overwrite される） |

**不足しているもの（T261 で追加すべき 6 フィールド）**:

| 新規フィールド | 目的 | 書き込みタイミング |
|---------------|------|-----------------|
| `assigningSetAt` | `assigning` 状態を立てた時刻 | `conductor.ts:444` status="assigning" の直後 |
| `clearSentAt` | daemon が `/clear` を送り終えた時刻 | `conductor.ts:449` `/clear` Enter sendKey 直後 |
| `promptSentAt` | 新プロンプト送信確定時刻 | `conductor.ts:458` prompt sendKey 直後 |
| `assignPromptFile` | 送信した prompt ファイルパス | `conductor.ts:444` 付近、promptFile 生成後 |
| `sessionStartedClearAt` | SESSION_STARTED(source=clear) 受信時刻 | `daemon.ts:1358-1363` assigning→running 遷移点 |
| `sessionIdleAt` | **最新の SESSION_IDLE 時刻**（SESSION_IDLE の都度上書き、non-assigning 経路でも） | `daemon.ts:1834` `session_idle` log 直前 |

これら 6 つは「どの hook が / どの送信がどの順で起きたか」を判定直前に 1 行にまとめるための原料。

**`lastHookAt` を `sessionIdleAt` に流用しない理由**: `lastHookAt` は SESSION_CLEAR ハンドラ冒頭でも `message.timestamp` に上書きされる（T260 の実装方針）。SESSION_CLEAR 時点で `formatUserClearSnapshot` を呼ぶと `lastHookAt` は SESSION_CLEAR 時刻に塗られ、「SESSION_IDLE が SESSION_CLEAR より 1.1s 先行していた」という race signature が消える。独立フィールドで SESSION_IDLE 時刻を保持する必要がある。

### 1.4 SESSION_IDLE の source 判別ロジックの現状

現状、`daemon.ts:1765` SESSION_IDLE ハンドラは source の推定を**していない**。条件分岐（`asking` / `disconnected` / `starting` / `assigning` / それ以外）で遷移先を決めているだけ。以下の source が暗黙にまとめて処理されている:

- daemon 自身の /clear 後に旧セッションが出す Stop → IDLE（= T253 bug の原因）
- Agent 完了後の Stop
- Conductor が自発的に idle に戻った
- assigned 直後にユーザーが /clear して新規 Conductor がプロンプト未投入で idle

`log("session_idle", ...)` は発火したが**なぜその判定に至ったか**は不明。T261 ではここに `source_guess=` を付ける。

### 1.5 daemon の送信イベントのログ有無

- `cmux.send` / `cmux.sendKey` は `cmux.ts` 側で低レベルにエラー時のみログ。**意図レベルでは未ログ**。
- `/clear` 送信（`conductor.ts:447-449`）も同様に無言。
- 新プロンプト送信（`conductor.ts:453-458`）も無言。
- 送信失敗時のみ `AssignTaskError` → 上位でログ、という形。

そのため「daemon が送った /clear」と「ユーザー手動 /clear」をログ上で区別する術がない。T261 で `clear_sent` / `assign_prompt_sent` の明示ログを追加する。

### 1.6 base commit と T260 の関係

**本 worktree の base は `a1d51a2 Merge T259` で、T260（`0a1aaa8 Merge T260`）は既に base に含まれている**（`git log --oneline` で確認済み）。したがって:

- **rebase は不要**。Step 0 は「`bun test` で既存 green 確認」と「base コミット確認（`git log -1` が `a1d51a2 Merge T259`）」のみ
- T260 で導入された `formatConductorSnapshot` / `conductor.lastHookAt` / `task_aborted reason=<key>` は全て利用可能
- T261 で追加する 6 フィールド（`assigningSetAt` / `clearSentAt` / `promptSentAt` / `assignPromptFile` / `sessionStartedClearAt` / `sessionIdleAt`）は `formatConductorSnapshot` には**含めず**、**判定直前の 1 行スナップショット専用**に別関数（`formatUserClearSnapshot`）化する。こうすると T260 の既存 snapshot は disconnect 観点のまま保てる

## 2. 設計方針

### 2.1 ConductorState に追加するフィールド（6 フィールド）

`skills/cmux-team/manager/schema.ts` の `ConductorState` スキーマに以下を追加:

| フィールド | 型 | 目的 | 書き込み位置 |
|-----------|-----|------|--------------|
| `assigningSetAt` | `z.string().datetime().optional()` | assigning 窓 open 時刻 | conductor.ts assignTask（status="assigning" 直後） |
| `clearSentAt` | `z.string().datetime().optional()` | /clear 送信完了時刻 | conductor.ts assignTask（/clear Enter sendKey 直後） |
| `promptSentAt` | `z.string().datetime().optional()` | 新プロンプト送信確定時刻 | conductor.ts assignTask（prompt sendKey 直後） |
| `assignPromptFile` | `z.string().optional()` | 送信した prompt ファイルパス（事後追跡用） | conductor.ts assignTask（promptFile 生成後） |
| `sessionStartedClearAt` | `z.string().datetime().optional()` | SESSION_STARTED(source=clear) 受信時刻 | daemon.ts SESSION_STARTED assigning→running 遷移点 |
| `sessionIdleAt` | `z.string().datetime().optional()` | **最新の SESSION_IDLE 時刻**（every SESSION_IDLE で上書き） | daemon.ts SESSION_IDLE ハンドラ（status 分岐後、`session_idle` log 直前） |

Zod 追加コード例:

```typescript
// T261: assign 窓タイムラインと判定スナップショット用
assigningSetAt: z.string().datetime().optional(),
clearSentAt: z.string().datetime().optional(),
promptSentAt: z.string().datetime().optional(),
assignPromptFile: z.string().optional(),
sessionStartedClearAt: z.string().datetime().optional(),
sessionIdleAt: z.string().datetime().optional(),
```

全て optional（`undefined` を許容）。team.json の round-trip 永続化に載せるかは**載せない**方針 — assign 窓内の一過性情報で、daemon 再起動後も次の assign サイクルで埋め直されるため。

### 2.2 スナップショットヘルパー（`formatUserClearSnapshot`）

`daemon.ts` のローカル util セクションに `formatUserClearSnapshot(conductor, prevStatus, nowISO?)` を新設する。既存 `formatConductorSnapshot` とは別関数（出力フィールドが異なる: 既存は disconnect 観点、新設は assign 窓観点）。

**シグネチャ（TypeScript）:**

```typescript
export function formatUserClearSnapshot(
  conductor: ConductorState,
  prevStatus: ConductorState["status"],
  nowISO?: string,
): string;
```

**出力フォーマット例:**

```
prev_status=running assigning_set_at=2026-04-18T21:10:42.300+09:00 clear_sent_at=2026-04-18T21:10:42.900+09:00 session_started_clear_at=- session_idle_at=2026-04-18T21:10:44.100+09:00 elapsed_since_clear_sent=2300ms prompt_sent_at=2026-04-18T21:10:43.500+09:00 prompt_file=.team/prompts/task-253-xxx.md
```

**仕様詳細:**

- `-` は `undefined` フィールドを表す
- `elapsed_since_clear_sent` は `(nowISO ?? new Date().toISOString())` の ms と `clearSentAt` の差分を `ms` 単位で出力。`clearSentAt` が undefined の場合は `-`
- `nowISO` 引数は**テストの決定論化**のため optional で受ける
- 関数は state を mutation しない（pure）

### 2.3 `guessSessionIdleSource` — pure 関数として Step 2 で切り出し

`daemon.ts` に pure 関数として追加（ユニットテスト可能にするため `formatUserClearSnapshot` と同じセクションに並べる）:

**シグネチャ:**

```typescript
export function guessSessionIdleSource(
  prevStatus: ConductorState["status"] | undefined,
  clearSentAtIso: string | undefined,
  taskRunId: string | undefined,
  messageTimestamp: string,
  nowMs?: number, // テスト注入用
): "clear_transient" | "prompt_pending" | "turn_end" | "idle_noop" | "recover" | "ask_resolved" | "unknown";
```

**判定ルール（優先順位）:**

| 入力 | 返り値 |
|------|--------|
| `prevStatus === "assigning"` && `clearSentAt` が直近 10s 以内（`messageTimestamp - clearSentAt < 10000ms`） | `clear_transient` |
| `prevStatus === "assigning"` && `taskRunId` 有（上記に該当せず） | `prompt_pending` |
| `prevStatus === "running"` | `turn_end` |
| `prevStatus === "idle"` | `idle_noop` |
| `prevStatus === "disconnected"` | `recover` |
| `prevStatus === "asking"` | `ask_resolved` |
| 上記いずれでもない（`starting` / `broken` / undefined） | `unknown` |

**重要**: `conductor.status` は SESSION_IDLE ハンドラ内で assigning→running / asking→running/idle 等の遷移で**書き換わる**。したがって guess 関数が参照すべきは**遷移前の status**（`prevStatus`）。SESSION_IDLE ハンドラ冒頭（`findConductor` 直後）で `const prevStatus = conductor?.status` をキャプチャし、guess 関数に引き渡す。

**`clear_transient` が T253 事例の「旧セッションの Stop hook」を表す。** T253 再現テスト（assigning → SESSION_IDLE）で期待ログ `source_guess=clear_transient` を正しく出すためには、`prevStatus` キャプチャを遷移より**前**に行うことが必須。

### 2.4 classify-stop.ts への追加引数

**原則として classify-stop.ts には state を渡さない**。`classifyStopPayload` は pure function として保つ（テスト容易性のため）。user_clear 判定は daemon.ts 側で行うため、classifier は現状のまま IDLE / ASK の二択で OK。T261 のスコープでは classify-stop.ts / classify-stop.test.ts は**変更しない**。

### 2.5 ログ追加ポイント表

| # | ファイル | 関数 / 位置 | 追加イベント | 出力内容 |
|---|---------|-----------|-------------|---------|
| A1 | `conductor.ts` | `assignTask` L444 付近 | `assigning_window_open` | `C[N] task_id=X taskRunId=<> assigning_set_at=<ISO>` |
| A2 | `conductor.ts` | `assignTask` L449 直後 | `clear_sent` | `C[N] source=daemon_assign taskRunId=<> clear_sent_at=<ISO>` |
| A3 | `conductor.ts` | `assignTask` L458 直後 | `assign_prompt_sent` | `C[N] task_id=X prompt_file=<path> prompt_sent_at=<ISO>` |
| B1 | `daemon.ts` | SESSION_STARTED (assigning→running) L1358-1363 | `assigning_window_close` | `C[N] via=SESSION_STARTED_clear elapsed=<ms> source_from_hook=<clear\|startup\|resume>` |
| B2 | `daemon.ts` | SESSION_IDLE (assigning→running) L1824-1831 | `assigning_window_close` | `C[N] via=SESSION_IDLE elapsed=<ms> source_guess=<clear_transient\|prompt_pending>` |
| B3 | `daemon.ts` | SESSION_IDLE ハンドラ全体 L1834-1837 | `session_idle` の detail 拡張 | 既存 `session_idle C[N]` に `source_guess=<...>` を追加（新規イベント名ではなく既存の detail 拡張で互換維持） |
| C1 | `daemon.ts` | SESSION_CLEAR (running 経路の判定直前) L1986 の先頭 | `user_clear_decision` | `C[N] task_id=X ${formatUserClearSnapshot(conductor, prevStatus)}` |

補足:

- **A1〜A3 は state 書き込み + ログを同時に**。`conductor.assigningSetAt = new Date().toISOString()` を実施した直後に同じ ISO をログ出力する。
- **B1 / B2 の `assigning_window_close`** は state 側で `conductor.sessionStartedClearAt` に書き込んでから emit する。
- **C1 が T261 の核**。user_clear 判定を発火させる直前に 1 行スナップショットを吐く。既存の `task_aborted task_id=X reason=user_clear`（L2001）は変更なし — C1 で詳細を既に出している。
- **SESSION_IDLE ハンドラ冒頭で `prevStatus` キャプチャ**: `const conductor = findConductor(...)` の直後（L1786 付近）に `const prevStatus = conductor?.status` を 1 行挿入。
- **SESSION_CLEAR ハンドラ冒頭でも `prevStatus` キャプチャ**: L1942 `const conductor = findConductor(...)` の直後に `const prevStatus = conductor?.status` を 1 行挿入。`formatUserClearSnapshot` の第 2 引数に渡す。

### 2.6 Claude Code 側の後方互換

- 既存ログイベント名（`session_idle`, `task_aborted`, `conductor_running`, `session_clear_expected`, `session_clear_stale`）は**変更しない**。新規イベントは別名（`user_clear_decision`, `clear_sent`, `assign_prompt_sent`, `assigning_window_open`, `assigning_window_close`）で追加。
- 既存イベントの detail 末尾にキーを追加するのは許容（`key=value` の集合なので parse 順序に依存しない運用を前提とする）。
- `task_aborted reason=user_clear` の形は T260 で既に機械可読化されているので変更不要。

## 3. 実装ステップ（TDD 順序）

**Step 0（前準備） + Step 1〜5（RED→GREEN の 5 サイクル） + Step 6（REFACTOR）の計 7 段階。**

Implementer は本 worktree（`/Users/yamamoto/git/cmux-team/.worktrees/task-261-1776535990`）で作業する。base は既に `a1d51a2 Merge T259` で T260 を含むため rebase 不要。

### Step 0: 前準備（RED 以前）

- `git log -1 --oneline` で base が `a1d51a2 Merge T259` であることを確認
- `bun test` で既存テスト green を確認（skills/cmux-team/manager/ 配下）
- T260 の利用可能性を確認: `conductor.lastHookAt`, `formatConductorSnapshot`, `task_aborted reason=<key>` が存在すること

### Step 1: RED — `formatUserClearSnapshot` / `guessSessionIdleSource` / state 6 フィールドの失敗テスト

- **追加するテスト**: `daemon.test.ts` に以下を追加
  1. `describe("T261: formatUserClearSnapshot")`
     - 全 6 フィールド set の場合に `prev_status=... assigning_set_at=... clear_sent_at=... session_started_clear_at=... session_idle_at=... elapsed_since_clear_sent=...ms prompt_sent_at=... prompt_file=...` を返す
     - 一部 undefined の場合は `-` で表示
     - `elapsed_since_clear_sent` は `nowISO` 引数で決定論的に計算
  2. `describe("T261: guessSessionIdleSource")`
     - `prevStatus="assigning"` + `clearSentAt` 直近 5s → `clear_transient`
     - `prevStatus="assigning"` + `clearSentAt` 15s 前 + `taskRunId` 有 → `prompt_pending`
     - `prevStatus="assigning"` + `clearSentAt` undefined + `taskRunId` 有 → `prompt_pending`
     - `prevStatus="running"` → `turn_end`
     - `prevStatus="idle"` → `idle_noop`
     - `prevStatus="disconnected"` → `recover`
     - `prevStatus="asking"` → `ask_resolved`
     - `prevStatus="starting"` / `"broken"` / undefined → `unknown`
  3. `describe("T261: ConductorState 6 フィールド追加")`
     - Zod parse で 6 フィールド全部 optional 受け入れ
     - 6 フィールド set で round-trip 成功
- **期待結果**: `formatUserClearSnapshot` / `guessSessionIdleSource` が未実装 → TypeScript コンパイルエラーまたは import エラーでテスト fail

### Step 2: GREEN — schema 6 フィールド + pure 関数 2 つ

- **触るファイル**: `schema.ts` / `daemon.ts`
- **実装**:
  1. `schema.ts` の `ConductorState` に 6 フィールド追加（2.1 の Zod コード例）
  2. `daemon.ts` に `formatUserClearSnapshot` を export で追加（2.2 の仕様）
  3. `daemon.ts` に `guessSessionIdleSource` を export で追加（2.3 の仕様）
  4. 2 つの util は既存 `formatConductorSnapshot` の近く（daemon.ts のローカル util セクション）に配置
- **期待結果**: Step 1 の RED テストが全て green

**設計決定**: `guessSessionIdleSource` を Step 6 REFACTOR ではなく Step 2 GREEN で作るのは、Step 4 の SESSION_IDLE ハンドラ実装が pure 関数呼び出しに依存するため。TDD サイクルを簡潔に保つ目的。

### Step 3: RED→GREEN — assignTask 側の送信ログ + state 書き込み

- **追加するテスト**: `conductor.test.ts` の `describe("T261: assignTask タイムライン")` に以下
  - assignTask 成功時に `conductor.assigningSetAt` / `clearSentAt` / `promptSentAt` / `assignPromptFile` が set される
  - ログファイル内に `assigning_window_open` / `clear_sent` / `assign_prompt_sent` の 3 イベントが順序通りに現れる
  - 各ログの detail キー（`assigning_set_at` / `clear_sent_at` / `prompt_sent_at` / `prompt_file`）が存在
- **触るファイル**: `conductor.ts`（`assignTask` 本体、L440-460 付近）
- **実装**:
  - L444 の `conductor.status = "assigning"` 直後に
    ```typescript
    conductor.assigningSetAt = new Date().toISOString();
    conductor.assignPromptFile = promptFile; // L411 付近で生成済みの変数
    await log("assigning_window_open",
      `${formatSurface(conductor.surface, "C")} task_id=${taskId} taskRunId=${taskRunId} assigning_set_at=${conductor.assigningSetAt}`);
    ```
  - L449 の `/clear` Enter `sendKey` 直後に
    ```typescript
    conductor.clearSentAt = new Date().toISOString();
    await log("clear_sent",
      `${formatSurface(conductor.surface, "C")} source=daemon_assign taskRunId=${taskRunId} clear_sent_at=${conductor.clearSentAt}`);
    ```
  - L458 の prompt `sendKey` 直後に
    ```typescript
    conductor.promptSentAt = new Date().toISOString();
    await log("assign_prompt_sent",
      `${formatSurface(conductor.surface, "C")} task_id=${taskId} prompt_file=${promptFile} prompt_sent_at=${conductor.promptSentAt}`);
    ```
- **注意**: 既存のログインターフェースは `logger.ts` の `log(event, detail)` のみ。モックは `daemon.test.ts` の既存パターン（`createDaemon` が ephemeral log file を使う）を踏襲。conductor.test.ts 側も同様のパターンで log 内容を検証。

### Step 4: RED→GREEN — SESSION_STARTED / SESSION_IDLE の遷移ログ + source_guess 埋め込み

- **追加するテスト**: `daemon.test.ts` の `describe("T261: assigning_window_close + session_idle source_guess")` に以下
  - assigning + SESSION_STARTED(source=clear) → running: `assigning_window_close C[N] via=SESSION_STARTED_clear elapsed=<ms>` が emit される。`conductor.sessionStartedClearAt` が set
  - assigning + taskRunId + SESSION_IDLE → running: `assigning_window_close C[N] via=SESSION_IDLE elapsed=<ms> source_guess=clear_transient` が emit される（clearSentAt が直近）
  - 各 status（running / idle / asking / disconnected / starting）+ SESSION_IDLE で `session_idle` detail に `source_guess` が正しく付与される
  - **`conductor.sessionIdleAt` が SESSION_IDLE 受信の都度 `message.timestamp` で上書きされる**（assigning だけでなく running/idle 経路でも）
- **触るファイル**: `daemon.ts`（SESSION_STARTED ハンドラ L1358-1363 / SESSION_IDLE ハンドラ L1765-1840）
- **実装**:

  **SESSION_STARTED 側（L1358-1363 付近の assigning→running 遷移）:**
  ```typescript
  // 遷移直後、既存 log("conductor_running ... via=SESSION_STARTED") の直後に
  conductor.sessionStartedClearAt = message.timestamp;
  const elapsed = conductor.clearSentAt
    ? new Date(message.timestamp).getTime() - new Date(conductor.clearSentAt).getTime()
    : undefined;
  await log("assigning_window_close",
    `${formatSurface(message.surface, "C")} via=SESSION_STARTED_clear elapsed=${elapsed ?? "-"}ms source_from_hook=${message.source ?? "-"}`);
  ```

  **SESSION_IDLE 側（L1786 の `const conductor = findConductor(...)` 直後）:**
  ```typescript
  // 冒頭で prevStatus をキャプチャ（遷移より前）
  const prevStatus = conductor?.status;
  ```

  SESSION_IDLE assigning→running 遷移（L1824-1831）の **遷移直後**に:
  ```typescript
  const elapsed = conductor.clearSentAt
    ? new Date(message.timestamp).getTime() - new Date(conductor.clearSentAt).getTime()
    : undefined;
  const guess = guessSessionIdleSource(
    prevStatus, conductor.clearSentAt, conductor.taskRunId, message.timestamp
  );
  await log("assigning_window_close",
    `${formatSurface(message.surface, "C")} via=SESSION_IDLE elapsed=${elapsed ?? "-"}ms source_guess=${guess}`);
  ```

  SESSION_IDLE ハンドラ末尾の既存 `log("session_idle", ...)`（L1834-1837）を拡張:
  ```typescript
  // 全 status 分岐を抜けた後、log 直前に
  conductor.sessionIdleAt = message.timestamp;
  const guessForSessionIdle = guessSessionIdleSource(
    prevStatus, conductor.clearSentAt, conductor.taskRunId, message.timestamp
  );
  await log(
    "session_idle",
    `${formatSurface(message.surface, "C")} source_guess=${guessForSessionIdle}`
  );
  ```

- **注意**:
  - T260 `lastHookAt` の更新は各ハンドラの先頭で既に行われている（L1795）ため、本ステップで再実装不要
  - `prevStatus` は SESSION_IDLE 内の遷移より**前**にキャプチャすること（2.3 の根拠）
  - `sessionIdleAt` は every SESSION_IDLE で上書きする（non-assigning 経路でも）

### Step 5: RED→GREEN — SESSION_CLEAR の user_clear_decision スナップショット

- **追加するテスト**: `daemon.test.ts` の `describe("T261: user_clear_decision スナップショット")` に以下
  - **T253 事例再現**: assigning → SESSION_IDLE(clear_transient) → SESSION_CLEAR の順で注入した場合、`task_aborted` の**直前**に `user_clear_decision C[N] task_id=X prev_status=running assigning_set_at=<...> clear_sent_at=<...> session_started_clear_at=- session_idle_at=<SESSION_IDLE時刻> elapsed_since_clear_sent=<ms> prompt_sent_at=<...> prompt_file=<...>` が emit される
  - **`session_idle_at` が SESSION_IDLE 時刻で埋まり、SESSION_CLEAR の timestamp と異なる**（lastHookAt を流用すると SESSION_CLEAR 時刻に上書きされるため、この検証で独立フィールドの必要性を担保）
  - 通常の手動 /clear（running → 直接 SESSION_CLEAR、assigning 窓を通らない）でも snapshot が出る。ただし `assigning_set_at=-` / `clear_sent_at=-` 等で「assign 窓外」であることが表現される
  - 既存の `task_aborted task_id=X reason=user_clear` は変わらず emit（detail 変更なし）
- **触るファイル**: `daemon.ts`（SESSION_CLEAR ハンドラ L1986 付近）
- **実装**:

  SESSION_CLEAR ハンドラ冒頭（L1942 `const conductor = findConductor(...)` の直後）に:
  ```typescript
  const prevStatus = conductor?.status;
  ```

  L1986 の `if (conductor && conductor.status === "running")` ブロック先頭（task-state 書き換えより**前**）に:
  ```typescript
  await log(
    "user_clear_decision",
    `${formatSurface(conductor.surface, "C")} task_id=${conductor.taskId ?? "-"} ${formatUserClearSnapshot(conductor, prevStatus ?? "running")}`
  );
  ```

  既存の `log("task_aborted", ...)` は変更なし（user_clear_decision の後に従来通り emit）。
- **期待結果**: T253 事例の再現テストで user_clear_decision が期待通りの snapshot を出す

### Step 6: REFACTOR

- `resetConductor` で 6 フィールドを全て `undefined` に戻す処理を追加（`conductor.ts:603-617` の state リセット部）:
  ```typescript
  conductor.assigningSetAt = undefined;
  conductor.clearSentAt = undefined;
  conductor.promptSentAt = undefined;
  conductor.assignPromptFile = undefined;
  conductor.sessionStartedClearAt = undefined;
  conductor.sessionIdleAt = undefined;
  ```
  （`sessionIdleAt` は「最新」なので reset 時にクリアするのが意味的に正しい）
- `formatUserClearSnapshot` / `guessSessionIdleSource` の引数順序を最終チェック
- `daemon.ts` のローカル util セクション（L197 付近）に新関数 2 つを並べて配置
- テストが全て green のまま保持
- CLAUDE.md ロギングポリシー遵守の再確認（空 catch なし、error キー使用、surface 表記は `formatSurface(surface, "C")`）

## 4. テスト戦略

### 4.1 classify-stop.test.ts
**追加なし**。classifyStopPayload は pure function で state に触らないため、T261 のスコープ外。

### 4.2 daemon.test.ts（integration + unit）

以下の describe ブロックを追加:

- **`describe("T261: formatUserClearSnapshot")`**（unit）:
  - 全 6 フィールド set で期待フォーマット
  - 一部 undefined の場合 `-`
  - `elapsed_since_clear_sent` の決定論計算（nowISO 引数注入）
  - `clearSentAt` undefined 時は `elapsed_since_clear_sent=-`

- **`describe("T261: guessSessionIdleSource")`**（unit）:
  - 2.3 の 7 パターン全てを網羅（clear_transient / prompt_pending / turn_end / idle_noop / recover / ask_resolved / unknown）
  - `clearSentAt` の境界値（9999ms → clear_transient、10001ms → prompt_pending）

- **`describe("T261: ConductorState 6 フィールド追加")`**（unit）:
  - Zod parse round-trip（6 フィールド optional）

- **`describe("T261: assigning_window_close ログ")`**（integration）:
  - SESSION_STARTED(source=clear) で window close, elapsed が正しい
  - SESSION_IDLE(assigning+taskRunId) で window close, source_guess=clear_transient
  - 両方来た場合の順序依存（先に来た方だけ close ログが出て状態更新される）

- **`describe("T261: session_idle source_guess")`**（integration）:
  - prevStatus=assigning + clearSentAt<10s → `clear_transient`
  - prevStatus=running → `turn_end`
  - prevStatus=idle → `idle_noop`
  - prevStatus=disconnected → `recover`
  - prevStatus=asking → `ask_resolved`
  - prevStatus=starting → `unknown`

- **`describe("T261: sessionIdleAt の書き込み")`**（integration）:
  - SESSION_IDLE の都度 `conductor.sessionIdleAt = message.timestamp` で上書き
  - non-assigning 経路（status=running で SESSION_IDLE）でも更新される
  - SESSION_CLEAR で `lastHookAt` が上書きされた後も `sessionIdleAt` は SESSION_IDLE 時点の値を保持

- **`describe("T261: user_clear_decision スナップショット")`**（integration）:
  - T253 再現: assigning → SESSION_IDLE(clear_transient, SESSION_IDLE 時刻 = t1) → SESSION_CLEAR(時刻 = t2, t2 > t1) で
    - `user_clear_decision` が emit され、`session_idle_at=t1`（= t2 ではない）
    - snapshot に `prev_status=running assigning_set_at=<> clear_sent_at=<> session_started_clear_at=- session_idle_at=t1 elapsed_since_clear_sent=<2000ms前後>` を含む
  - 通常の手動 /clear（status=running から直接 SESSION_CLEAR、assigning 経路を通らない）でも snapshot が出る。`assigning_set_at=-` / `clear_sent_at=-` で「assign 窓外」を表現
  - 既存の `task_aborted reason=user_clear` はそのまま emit（ペアで出る）

### 4.3 conductor.test.ts

- **`describe("T261: assignTask のタイムライン state 書き込み")`**:
  - assignTask 成功後に 4 フィールド（`assigningSetAt` / `clearSentAt` / `promptSentAt` / `assignPromptFile`）が set
  - これらの値は ISO 8601 local TZ 付き文字列（`assignPromptFile` 除く）

- **`describe("T261: clear_sent / assign_prompt_sent / assigning_window_open ログ")`**:
  - ログファイル内に 3 イベントがこの順序で現れる
  - 各 detail キーの存在検証（正規表現ベース）

- **`describe("T261: resetConductor で 6 フィールドクリア")`**:
  - reset 前に 6 フィールドを set
  - resetConductor 呼び出し後、全 6 フィールドが `undefined`

### 4.4 ISO 時刻の mock 方針

- 既存 daemon.test.ts では `new Date().toISOString()` を直接呼んでいる箇所が多く、**時刻モックは行っていない**。代わりに `expect(...).toBeDefined()` や `expect(...).toMatch(/^\d{4}-/)` で shape を検証するパターン。
- T261 でも同方針を踏襲。`elapsed_since_clear_sent` の数値は `toBeGreaterThan(0)` / `toBeLessThan(5000)` などのレンジ検証で脆さを回避。
- ただし `formatUserClearSnapshot` / `guessSessionIdleSource` のユニットテストは `nowISO` / `nowMs` 引数を明示注入することで決定論的な値（例: `elapsed=1200ms`）をテストする。

## 5. リスク・考慮点

### 5.1 既存ログとの後方互換

- 既存 `session_idle C[N]` → `session_idle C[N] source_guess=<...>` の detail 追記は互換（空白区切り `key=value` のみ）。parse する側は source_guess を optional として扱えば壊れない。
- 既存 `task_aborted task_id=X reason=user_clear` はそのまま。T261 は追加ログ `user_clear_decision` を**前に**出すだけ。
- 既存の `conductor_running via=SESSION_STARTED` / `conductor_running via=SESSION_IDLE` はそのまま残す。`assigning_window_close` は**別行**として追加する（`conductor_running` とペアで 2 行出るのを許容）。

### 5.2 `clearSentAt` ほかの古い値問題

- `resetConductor` で 6 フィールド全てをクリアする（Step 6 REFACTOR）。クリア漏れがあると次回の assign サイクルで古い値が snapshot に混入し誤解析を招く。
- **チェック箇所**: `resetConductor`（conductor.ts:603-617）、および将来 `clear-conductor` CLI で明示的に idle 化する経路（該当があれば）。
- テストケース（4.3 の「6 フィールドクリア」describe）で担保する。

### 5.3 hook_signals テーブルへの副作用

- hook_signals テーブルへの書き込みは `insertHookSignal` で `handleMessage` 入口で行われる（T216 ポリシー）。**T261 は新イベントを追加するだけで、insertHookSignal の呼び出し位置は変更しない**。副作用なし。

### 5.4 テストの脆さ

- `elapsed_since_clear_sent` は wall-clock に依存。ユニットテスト（formatUserClearSnapshot / guessSessionIdleSource）は `nowISO` / `nowMs` 注入で決定論化、integration テストは範囲検証で脆さ回避。

### 5.5 `prompt_bytes` の扱い

- 初版では `prompt_bytes` を出さない。代わりに `prompt_file`（= `conductor.assignPromptFile`）パスを snapshot に含める。bytes が欲しければ事後に `wc -c <prompt_file>` 等で取得可能。I/O を増やして tick を重くするよりログの再構成可能性を優先。

### 5.6 masters / agents への影響

- 本 PR が触る state mutation は Conductor のみ。Master / Agent は対象外。`handleMessage` 分岐の該当箇所のみ編集し他経路を侵食しないように注意。

### 5.7 `sessionIdleAt` と `lastHookAt` の使い分け

- `lastHookAt`（T260）は SESSION_* hook 全般（STARTED / IDLE / CLEAR / ENDED）の最終受信時刻。`formatConductorSnapshot`（disconnect 観点）で使用。
- `sessionIdleAt`（T261）は SESSION_IDLE 限定。`formatUserClearSnapshot`（user_clear 判定観点）で使用。
- 2 つの別フィールドが必要な理由は 1.3 節で記述（SESSION_CLEAR ハンドラで `lastHookAt` が上書きされるため）。

## 6. 完了条件

### 6.1 T253 bug 事例のログ再現（期待値）

T253 × C[128] の race が再発した場合、新ログ基準では以下のようになる（既存行は省略、新規/拡張行のみ）:

```
21:10:42.300 assigning_window_open C[128] task_id=253 taskRunId=task-253-xxx assigning_set_at=2026-04-18T21:10:42.300+09:00
21:10:42.900 clear_sent C[128] source=daemon_assign taskRunId=task-253-xxx clear_sent_at=2026-04-18T21:10:42.900+09:00
21:10:43.500 assign_prompt_sent C[128] task_id=253 prompt_file=.team/prompts/task-253-xxx.md prompt_sent_at=2026-04-18T21:10:43.500+09:00
21:10:44.100 assigning_window_close C[128] via=SESSION_IDLE elapsed=1200ms source_guess=clear_transient
21:10:44.100 session_idle C[128] source_guess=clear_transient
21:10:45.200 user_clear_decision C[128] task_id=253 prev_status=running assigning_set_at=2026-04-18T21:10:42.300+09:00 clear_sent_at=2026-04-18T21:10:42.900+09:00 session_started_clear_at=- session_idle_at=2026-04-18T21:10:44.100+09:00 elapsed_since_clear_sent=2300ms prompt_sent_at=2026-04-18T21:10:43.500+09:00 prompt_file=.team/prompts/task-253-xxx.md
21:10:45.200 task_aborted task_id=253 reason=user_clear
```

解析視点:

- `user_clear_decision` 1 行を読めば「clear 送信から 2.3s しか経っていない」「session_started_clear が未到達」「SESSION_IDLE が `session_idle_at` として 1.1s 先行していた」という race のシグネチャが即判定可能
- `assigning_window_close via=SESSION_IDLE source_guess=clear_transient` が「保険経路で遷移した」ことを明示
- `session_idle_at` が SESSION_CLEAR の timestamp（21:10:45.200）ではなく SESSION_IDLE 時点（21:10:44.100）で埋まっていることが race signature の核
- 根本修正は別タスクだが、観測可能性が担保されたことで誤判定の再発が即特定可能になる

### 6.2 チェックリスト（Implementer 納品時に確認）

- [ ] `bun test` 全 green（既存 + 新規）
- [ ] `ConductorState` に 6 フィールド（`assigningSetAt` / `clearSentAt` / `promptSentAt` / `assignPromptFile` / `sessionStartedClearAt` / `sessionIdleAt`）追加済み
- [ ] `formatUserClearSnapshot` が `daemon.ts` で export され、ユニットテストが通る
- [ ] `guessSessionIdleSource` が `daemon.ts` で export され、7 パターンのユニットテストが通る
- [ ] `assigning_window_open` / `clear_sent` / `assign_prompt_sent` が `assignTask` で順序通り emit
- [ ] `assigning_window_close` が SESSION_STARTED(clear) と SESSION_IDLE(assigning+taskRunId) で emit
- [ ] `session_idle` の detail に `source_guess=` が付与
- [ ] `conductor.sessionIdleAt` が SESSION_IDLE の都度 `message.timestamp` で上書き（non-assigning 経路含む）
- [ ] SESSION_IDLE / SESSION_CLEAR ハンドラ冒頭で `const prevStatus = conductor?.status` をキャプチャ
- [ ] `user_clear_decision` が SESSION_CLEAR の running 分岐直前で emit（task_aborted より前）
- [ ] `resetConductor` が 6 フィールド全てを `undefined` にクリア
- [ ] base は `a1d51a2 Merge T259` のまま（T260 は既に含まれているため rebase 不要）
- [ ] CLAUDE.md ロギングポリシー遵守（空 catch なし、error キー使用、surface 表記は `formatSurface(surface, "C")`）
- [ ] `classify-stop.ts` / `classify-stop.test.ts` は**変更していない**
- [ ] `insertHookSignal` の呼び出し位置は**変更していない**（T216 ポリシー遵守）
