# T261 実装計画: user_clear 誤判定の根拠スナップショットログ拡充

## 1. 調査結果サマリー

### 1.1 user_clear 判定が発生する箇所（1 箇所のみ）

`user_clear` は `classify-stop.ts` ではなく、**daemon.ts の SESSION_CLEAR ハンドラ**で発火する。`classifyStopPayload` は `SESSION_STOP` payload を `IDLE` / `ASK` の二択に分類するのみで user_clear は関知しない（この点は task.md の調査期待ともやや異なる—`session_stop_classified` は Stop hook 分類、`user_clear` はそれとは別経路）。

判定ロジック（`daemon.ts:1704-1811` SESSION_CLEAR ハンドラ）:

| 条件 | 処理 | 出力ログ |
|------|------|---------|
| Master surface | ignore | `master_session_clear_ignored` |
| Conductor `status=broken` | ignore | `session_event_ignored_broken` |
| Conductor `status=assigning` | 早期 return（daemon 自身の /clear を認識） | `session_clear_expected reason=daemon_assign_clear` |
| Conductor `status=disconnected\|starting` | idle / `conductor_recovered` / `conductor_ready` に復帰 | — |
| Conductor `status=running` + `taskRunId` 不一致 | stale 判定で早期 return | `session_clear_stale` |
| **Conductor `status=running` + `taskRunId` 一致（または未指定）** | **task_aborted reason=user_clear** + resetConductor | `task_aborted reason=user_clear` |
| Conductor `status=idle` | 無音（TUI チラつき防止） | — |
| Agent surface | agent.status を running にリセット | `session_clear_agent_reset` |

### 1.2 T253 × C[128] 事例の race 分析

```
21:10:42 conductor_started task_id=253 C[128]          # assignTask: status="assigning" set、/clear 送信
21:10:44 session_stop_classified C[128] case=IDLE      # Stop hook (旧セッション) → IDLE
21:10:44 conductor_running via=SESSION_IDLE            # daemon.ts:1594-1602 保険経路で assigning→running
21:10:44 session_idle C[128]
21:10:45 task_aborted task_id=253 reason=user_clear    # 直後の SESSION_CLEAR: status=running で user_clear 認定
```

**根本原因**: assignTask の /clear 送信（21:10:42）に対し、**旧セッションの Stop hook** が先に飛来した。`daemon.ts:1594` の「T232 R1 保険経路」が `assigning && taskRunId` で running に遷移させたため、直後の SESSION_CLEAR（daemon 自身の /clear の遅延発火）が `session_clear_expected` ではなく user_clear 経路に流れ込んだ。

この race を**修正する**のは別タスクの責務（T261 のスコープ外）。T261 は「発生時にログから原因が追跡可能」な状態を作るのがゴール。

### 1.3 現在 state に保持している時刻フィールド

`ConductorState`（schema.ts:200-222）が持つ時刻系:

| フィールド | 目的 | 書き込みタイミング |
|-----------|------|-----------------|
| `startedAt` | Conductor 起動 / assign 開始時刻 | `assignTask` で `new Date().toISOString()` |
| `disconnectedAt` | disconnect 遷移時刻 | SESSION_ENDED / pid_dead / assign_failed |
| `lastHookAt` | **T260 で追加**。最後に届いた SESSION_* hook の時刻 | 各 hook ハンドラの先頭 |

**不足しているもの（T261 で追加すべき）**:

| 新規フィールド | 目的 | 書き込みタイミング |
|---------------|------|-----------------|
| `assigningSetAt` | `assigning` 状態を立てた時刻 | `conductor.ts:405` で assignTask 開始直前 |
| `clearSentAt` | daemon が `/clear` を送り終えた時刻 | `conductor.ts:408-410` の sendKey 直後 |
| `promptSentAt` | 新プロンプト送信確定時刻 | `conductor.ts:419` の sendKey 直後 |
| `sessionStartedClearAt` | SESSION_STARTED(source=clear) 受信時刻 | `daemon.ts:1134` assigning→running 遷移点 |

これら 4 つは「どの hook が / どの送信がどの順で起きたか」を判定直前に 1 行にまとめるための原料。

### 1.4 SESSION_IDLE の source 判別ロジックの現状

現状、`daemon.ts:1534` SESSION_IDLE ハンドラは source の推定を**していない**。条件分岐（`asking` / `disconnected` / `starting` / `assigning` / それ以外）で遷移先を決めているだけ。以下の source が暗黙にまとめて処理されている:

- daemon 自身の /clear 後に旧セッションが出す Stop → IDLE（= T253 bug の原因）
- Agent 完了後の Stop
- Conductor が自発的に idle に戻った
- assigned 直後にユーザーが /clear して新規 Conductor がプロンプト未投入で idle

`log("session_idle", ...)` は発火したが**なぜその判定に至ったか**は不明。T261 ではここに `source_guess=` を付ける。

### 1.5 daemon の送信イベントのログ有無

- `cmux.send` / `cmux.sendKey` は `cmux.ts` 側で低レベルにエラー時のみログ。**意図レベルでは未ログ**。
- `/clear` 送信（`conductor.ts:408-410`）も同様に無言。
- 新プロンプト送信（`conductor.ts:414-419`）も無言。
- 送信失敗時のみ `AssignTaskError` → 上位でログ、という形。

そのため「daemon が送った /clear」と「ユーザー手動 /clear」をログ上で区別する術がない。T261 で `clear_sent` / `assign_prompt_sent` の明示ログを追加する。

### 1.6 T260 との関係性と統合判断

**T260 は既に main にマージ済み**（commit `0a1aaa8`）。ただし本 worktree（`task-261-1776513199` 派生の base）は T260 マージ前の `ac269f6` を起点にしている。

| 点 | T260 | T261 |
|----|------|------|
| スコープ | disconnect → broken 遷移のログ強化 | user_clear 判定の根拠スナップショット |
| 触る path | conductor_disconnected / conductor_broken / agent_spawned / task_aborted | SESSION_CLEAR / SESSION_IDLE / SESSION_STARTED / assignTask |
| 導入済み基盤 | `formatConductorSnapshot`, `lastHookAt`, `task_aborted reason=` | — |

**推奨判断: 独立 PR（T260 の後続）**

理由:
1. T260 は既に merge 済みで cherry-pick の必要がない。Implementer が `origin/main` から rebase すれば `formatConductorSnapshot` と `lastHookAt` がそのまま使える。
2. T260 と T261 は触るハンドラが重なる部分（task_aborted フォーマット）と分離した部分（SESSION_CLEAR / SESSION_IDLE の snapshot）に分かれる。T260 が先にマージされているため、T261 は T260 の上に重ねる diff を作れば良い。
3. T261 で追加する 4 フィールド（`assigningSetAt` / `clearSentAt` / `promptSentAt` / `sessionStartedClearAt`）は `formatConductorSnapshot` に含めず、**判定直前の 1 行スナップショット専用**に別関数化する。こうすると T260 の既存 snapshot は disconnect 観点のまま保てる。

## 2. 設計方針

### 2.1 ConductorState に追加するフィールド

`skills/cmux-team/manager/schema.ts` に以下を追加:

```typescript
// assign タイムライン追跡（T261）
// - assigning 状態窓 open 時刻
assigningSetAt: z.string().datetime().optional(),
// - daemon が /clear 送信完了した時刻
clearSentAt: z.string().datetime().optional(),
// - daemon が新プロンプトの送信 (Enter 確定) を完了した時刻
promptSentAt: z.string().datetime().optional(),
// - SESSION_STARTED(source=clear) 到達で assigning→running 遷移した時刻
sessionStartedClearAt: z.string().datetime().optional(),
```

全て optional（`undefined` を許容）。永続化（team.json round-trip）に載せる必要なし — assign 窓内の一過性情報なので。

### 2.2 スナップショットヘルパー

`daemon.ts` に `formatUserClearSnapshot(conductor, prevStatus, nowISO?)` を新設。既存 `formatConductorSnapshot` とは別関数にする（出力フィールドが異なる。既存 snapshot は disconnect 観点、新設は assign 窓観点）。

出力例:
```
prev_status=running assigning_set_at=2026-04-18T21:10:42.300+09:00 clear_sent_at=2026-04-18T21:10:42.900+09:00 session_started_clear_at=- session_idle_at=2026-04-18T21:10:44.100+09:00 elapsed_since_clear_sent=1200ms prompt_sent_at=2026-04-18T21:10:43.500+09:00 prompt_bytes=187 decision_reason=running_with_clear_from_user
```

`-` は未設定。`elapsed_since_clear_sent` は `nowISO ?? Date.now() - clearSentAt` を ms で計算。

### 2.3 classify-stop.ts への追加引数

**原則として classify-stop.ts には state を渡さない**。classifyStopPayload は pure function として保つ（テスト容易性のため）。user_clear 判定は daemon.ts 側で行うため、classifier は現状のまま IDLE / ASK の二択で OK。

代わりに daemon.ts の SESSION_CLEAR ハンドラ内で snapshot を出す。

### 2.4 ログ追加ポイント表

| # | ファイル | 関数 | 追加イベント | 出力内容 |
|---|---------|------|-------------|---------|
| A1 | `conductor.ts` | `assignTask` | `assigning_window_open` | `C[N] task_id=X taskRunId=<> assigning_set_at=<ISO>` |
| A2 | `conductor.ts` | `assignTask` | `clear_sent` | `C[N] source=daemon_assign taskRunId=<> clear_sent_at=<ISO>` |
| A3 | `conductor.ts` | `assignTask` | `assign_prompt_sent` | `C[N] task_id=X bytes=<N> prompt_file=<path> prompt_sent_at=<ISO>` |
| B1 | `daemon.ts` | SESSION_STARTED handler (assigning→running 分岐) | `assigning_window_close` | `C[N] via=SESSION_STARTED_clear elapsed=<ms> source_from_hook=<clear\|startup\|resume>` |
| B2 | `daemon.ts` | SESSION_IDLE handler (assigning→running 分岐) | `assigning_window_close` | `C[N] via=SESSION_IDLE elapsed=<ms> source_guess=clear_transient` |
| B3 | `daemon.ts` | SESSION_IDLE handler 全体 | `session_idle` の detail 拡張 | 既存 `session_idle C[N]` に `source_guess=<...>` を追加（新規イベント名ではなく既存の detail 拡張にして互換維持） |
| C1 | `daemon.ts` | SESSION_CLEAR handler (running 経路の **判定直前**) | `user_clear_decision` | `C[N] task_id=X ${formatUserClearSnapshot(...)}` |
| C2 | `daemon.ts` | SESSION_CLEAR handler (running 経路の判定後 — 既存) | `task_aborted` の detail 拡張 | 既存 `task_aborted task_id=X reason=user_clear` に変更なし（C1 で詳細を既に出している） |

補足:
- **A1〜A3 は state 書き込み + ログを同時に**。`conductor.assigningSetAt = new Date().toISOString()` を実施した直後に同じ ISO をログ出力する。
- **B1 / B2 の `assigning_window_close`** は state 側で `conductor.sessionStartedClearAt` に書き込んでから emit する。
- **C1 が T261 の核**。user_clear 判定を発火させる直前に 1 行スナップショットを吐く。

### 2.5 source_guess の推定ルール（SESSION_IDLE 時）

`daemon.ts` SESSION_IDLE handler で、以下の優先順位で `source_guess` を決定:

| 条件 | source_guess |
|------|--------------|
| `conductor.status === "assigning"` && 直近 `clearSentAt` との差が < 10s | `clear_transient` |
| `conductor.status === "assigning"` && `taskRunId` 有 | `prompt_pending` |
| `conductor.status === "running"` | `turn_end` |
| `conductor.status === "idle"` | `idle_noop` |
| `conductor.status === "disconnected"` | `recover` |
| `conductor.status === "asking"` | `ask_resolved` |
| 上記いずれでもない | `unknown` |

`clear_transient` が T253 事例の「旧セッションの Stop hook」を表す。

### 2.6 Claude Code 側の後方互換

- 既存ログイベント名（`session_idle`, `task_aborted`, `conductor_running`, `session_clear_expected`, `session_clear_stale`）は**変更しない**。新規イベントは別名（`user_clear_decision`, `clear_sent`, `assign_prompt_sent`, `assigning_window_open`, `assigning_window_close`）で追加。
- 既存イベントの detail 末尾にキーを追加するのは許容（`key=value` の集合なので parse 順序に依存しない運用を前提とする）。
- `task_aborted reason=user_clear` の形は T260 で既に機械可読化されているので変更不要。

## 3. 実装ステップ（TDD 順序）

ステップ数は **5 ステップ**。各ステップ RED → GREEN で進める。Implementer は origin/main に rebase した上で本 worktree 上で作業する。

### Step 0: 前準備（RED 以前）
- `git rebase origin/main` で T260 を取り込む
- `bun test` で既存テスト green を確認

### Step 1: `formatUserClearSnapshot` と state フィールドの RED
- **追加するテスト**: `daemon.test.ts` に以下を追加
  - `formatUserClearSnapshot(conductor, prevStatus)` が 4 フィールド全部 set の場合に `prev_status=... assigning_set_at=... clear_sent_at=... session_started_clear_at=... elapsed_since_clear_sent=...ms` を返す
  - 一部 undefined の場合は `-` で表示
  - `elapsed_since_clear_sent` は `nowISO` 引数で決定論的に計算
- **追加するテスト**: `ConductorState` が新 4 フィールドを optional で受け入れる（Zod parse でエラーにならない）
- **期待結果**: `formatUserClearSnapshot` が未実装でコンパイルエラー / テスト fail

### Step 2: `formatUserClearSnapshot` と state フィールドの GREEN
- **触るファイル**: `schema.ts`（4 フィールド追加）、`daemon.ts`（`formatUserClearSnapshot` export）
- **実装**: Zod フィールド追加、ヘルパー関数追加。ここで classify-stop.ts は触らない
- **期待結果**: Step 1 の RED テストが green

### Step 3: assignTask 側の送信ログ + state 書き込みの RED→GREEN
- **追加するテスト**: `conductor.test.ts` の `assignTask` テスト群に
  - assignTask 成功時に `conductor.assigningSetAt` / `clearSentAt` / `promptSentAt` が set される
  - （もしログ stub があれば）`clear_sent` / `assign_prompt_sent` / `assigning_window_open` が emit される
- **触るファイル**: `conductor.ts`（`assignTask` 本体）
- **実装**:
  - `conductor.assigningSetAt = new Date().toISOString()` を `status = "assigning"` の直後に
  - `await cmux.sendKey(conductor.surface, "return")` 直後（`/clear` Enter）に `conductor.clearSentAt` と `log("clear_sent", ...)`
  - 新プロンプト sendKey 直後に `conductor.promptSentAt` と `log("assign_prompt_sent", ...)`
  - `log("assigning_window_open", ...)` を `assigningSetAt` set 直後に
- **注意**: 既存のログインターフェースは `logger.ts` の `log(event, detail)` のみ。モックは `daemon.test.ts` の既存パターン（`createDaemon` が ephemeral log file を使う）を踏襲

### Step 4: SESSION_STARTED / SESSION_IDLE の assigning→running 遷移ログ RED→GREEN
- **追加するテスト**: `daemon.test.ts` に
  - assigning + SESSION_STARTED(source=clear) → running: `assigning_window_close via=SESSION_STARTED_clear elapsed=<ms>` が emit される。`conductor.sessionStartedClearAt` が set
  - assigning + taskRunId + SESSION_IDLE → running: `assigning_window_close via=SESSION_IDLE elapsed=<ms> source_guess=clear_transient` が emit される
  - SESSION_IDLE の `session_idle` detail に `source_guess` が含まれる（各 status で期待値が異なる）
- **触るファイル**: `daemon.ts`（SESSION_STARTED / SESSION_IDLE ハンドラ）
- **実装**:
  - line 1134 assigning→running 遷移直後に `conductor.sessionStartedClearAt = timestamp` + `log("assigning_window_close", ...)`
  - line 1594-1602 assigning→running 遷移直後に `log("assigning_window_close", ...)`
  - line 1604-1607 の `session_idle` detail に `source_guess` を付与
- **注意**: T260 `lastHookAt` の更新は各ハンドラの先頭で既に行われているため、本ステップで再実装不要

### Step 5: SESSION_CLEAR の user_clear 判定直前スナップショット RED→GREEN
- **追加するテスト**: `daemon.test.ts` SESSION_CLEAR テスト群に
  - running Conductor の user_clear 発火時、**task_aborted の直前**に `user_clear_decision C[N] task_id=X prev_status=running assigning_set_at=... clear_sent_at=... session_idle_at=... elapsed_since_clear_sent=...ms prompt_sent_at=... prompt_bytes=...` が emit される
  - `lastHookAt` / `session_idle` 時刻のトレースに基づいて snapshot の値が埋まっている
- **触るファイル**: `daemon.ts`（SESSION_CLEAR ハンドラ running 分岐 先頭、line 1755〜 の前）
- **実装**:
  - line 1755 の `if (conductor && conductor.status === "running")` ブロック先頭で `log("user_clear_decision", \`${formatSurface(conductor.surface, "C")} task_id=${taskId ?? "-"} ${formatUserClearSnapshot(conductor, "running")}\`)` を呼ぶ
  - `prompt_bytes` は state に持たせない（既に `conductor.promptSentAt` で代用 — bytes が欲しければ `.team/prompts/<...>` を `statSync` するが I/O を増やすので **初版では prompt_bytes=- で構わない**。代わりに `prompt_file` パスを出して事後追跡可能にする）
  - **決定**: `prompt_file` を state に持たせる（`conductor.assignPromptFile`）。`prompt_bytes` は出さない
- **期待結果**: T253 事例の再現テスト（assigning → SESSION_IDLE → SESSION_CLEAR の順で入力）で user_clear_decision が期待通りの snapshot を出す

### Step 6: REFACTOR
- `formatUserClearSnapshot` の引数順序見直し（`conductor` 一つで済む設計にできるか検討）
- `source_guess` ロジックを独立関数化（`guessSessionIdleSource(conductor, messageTimestamp)` として daemon.ts 内に閉じる。export 不要）
- `clearSentAt` が old value のまま残るケースの整理: `resetConductor` で `assigningSetAt / clearSentAt / promptSentAt / sessionStartedClearAt / assignPromptFile` を全部 `undefined` に戻す
- `daemon.ts` のローカル util セクション（line 197 あたり）に新関数を並べて配置

## 4. テスト戦略

### 4.1 classify-stop.test.ts
**追加なし**。classifyStopPayload は pure function で state に触らないため、T261 のスコープ外。

### 4.2 daemon.test.ts（integration）
以下の describe ブロックを追加:

- `describe("T261: formatUserClearSnapshot")`:
  - 全フィールド set で期待フォーマット
  - 一部 undefined の場合 `-`
  - `elapsed_since_clear_sent` の決定論計算（nowISO 引数注入）

- `describe("T261: assigning_window_open/close ログ")`:
  - SESSION_STARTED(source=clear) で window close, elapsed が正しい
  - SESSION_IDLE(assigning+taskRunId) で window close, source_guess=clear_transient
  - SESSION_IDLE(assigning+taskRunId) で SESSION_STARTED より先だった場合の順序依存（sessionStartedClearAt 書き換えなし）

- `describe("T261: SESSION_IDLE source_guess")`:
  - status=assigning + clearSentAt<10s → `clear_transient`
  - status=running → `turn_end`
  - status=idle → `idle_noop`
  - status=disconnected → `recover`
  - status=asking → `ask_resolved`
  - status=starting + taskRunId なし → （`starting` は今の実装で idle に移る） — テストは条件網羅のため

- `describe("T261: user_clear_decision スナップショット")`:
  - assigning → SESSION_IDLE(clear_transient) → SESSION_CLEAR (= T253 再現) で `user_clear_decision` が emit され、snapshot に以下が含まれる:
    - `prev_status=running`
    - `assigning_set_at=<先にset した時刻>`
    - `clear_sent_at=<assignTask で set した時刻>`
    - `session_started_clear_at=-`（SESSION_STARTED(clear) が来る前に SESSION_IDLE で遷移した race 状況）
    - `elapsed_since_clear_sent` が 2000ms 前後の数値
  - 通常の手動 /clear（status=running から直接 SESSION_CLEAR）でも snapshot が出る。ただし `assigning_set_at=-` 等で「assign 窓外」であることが表現される
  - 既存の `task_aborted reason=user_clear` は変わらず emit

### 4.3 conductor.test.ts
- `describe("T261: assignTask の送信時刻 state 書き込み")`:
  - assignTask 成功後に `conductor.assigningSetAt` / `clearSentAt` / `promptSentAt` / `assignPromptFile` が set
  - これらの値は ISO 8601 local TZ 付き文字列
- `describe("T261: clear_sent / assign_prompt_sent ログ")`:
  - ログファイル内に `clear_sent C[N] source=daemon_assign` が現れる
  - `assign_prompt_sent C[N] task_id=X prompt_file=...` が現れる

### 4.4 ISO 時刻の mock 方針
- 既存 daemon.test.ts では `new Date().toISOString()` を直接呼んでいる箇所が多く、**時刻モックは行っていない**。代わりに `expect(...).toBeDefined()` や `expect(...).toMatch(/^\d{4}-/)` で shape を検証するパターン。
- T261 でも同方針を踏襲。`elapsed_since_clear_sent` の数値は `toBeGreaterThan(0)` / `toBeLessThan(5000)` などのレンジ検証で脆さを回避。
- ただし `formatUserClearSnapshot` のユニットテストは `nowISO` 引数を明示注入することで決定論的な `elapsed` 値（例: 1200ms）をテストする。

## 5. リスク・考慮点

### 5.1 既存ログとの後方互換
- 既存 `session_idle C[N]` → `session_idle C[N] source_guess=<...>` の detail 追記は互換（空白区切り `key=value` のみ）。parse する側は source_guess を optional として扱えば壊れない。
- 既存 `task_aborted task_id=X reason=user_clear` はそのまま。T261 は追加ログ `user_clear_decision` を**前に**出すだけ。
- 既存の `conductor_running via=SESSION_STARTED` / `conductor_running via=SESSION_IDLE` はそのまま残す。`assigning_window_close` は**別行**として追加する（conductor_running とペアで 2 行出るのを許容）。

### 5.2 `clearSentAt` の古い値問題
- `resetConductor` で 4 フィールド + `assignPromptFile` をクリアする。クリア漏れがあると次回の assign サイクルで古い値が snapshot に混入し誤解析を招く。**Step 6 REFACTOR でクリア処理を確認必須**。

### 5.3 hook_signals テーブルへの副作用
- hook_signals テーブルへの書き込みは `insertHookSignal` で `handleMessage` 入口で行われる（T216 ポリシー）。**T261 は新イベントを追加するだけで、insertHookSignal の呼び出し位置は変更しない**。副作用なし。

### 5.4 テストの脆さ
- `elapsed_since_clear_sent` は wall-clock に依存。ユニットテスト（formatUserClearSnapshot）は `nowISO` 注入で決定論化、integration テストは範囲検証で脆さ回避。

### 5.5 `prompt_bytes` の扱い
- 初版では `prompt_bytes` を出さない。代わりに `prompt_file` パスを snapshot に含める。bytes が欲しければ事後に `wc -c <prompt_file>` 等で取得可能。I/O を増やして tick を重くするよりログの再構成可能性を優先。

### 5.6 masters / agents への影響
- 本 PR が触る state mutation は Conductor のみ。Master / Agent は対象外。`handleMessage` 分岐の該当箇所のみ編集し他経路を侵食しないように注意。

### 5.7 T260 の前提
- Implementer は origin/main から rebase する必要がある（T260 は main、worktree base は v3.54.1 タグ時点）。rebase せずに独立実装すると `lastHookAt` / `formatConductorSnapshot` を再発明してしまう。

## 6. 完了条件

### 6.1 T253 bug 事例のログ再現（期待値）

T253 × C[128] の race が再発した場合、新ログ基準では以下のようになる（既存行は省略、新規/拡張行のみ）:

```
21:10:42.300 assigning_window_open C[128] task_id=253 taskRunId=task-253-xxx assigning_set_at=2026-04-18T21:10:42.300+09:00
21:10:42.900 clear_sent C[128] source=daemon_assign taskRunId=task-253-xxx clear_sent_at=2026-04-18T21:10:42.900+09:00
21:10:43.500 assign_prompt_sent C[128] task_id=253 prompt_file=.team/prompts/task-253-xxx.md prompt_sent_at=2026-04-18T21:10:43.500+09:00
21:10:44.100 assigning_window_close C[128] via=SESSION_IDLE elapsed=1200ms source_guess=clear_transient
21:10:44.100 session_idle C[128] source_guess=clear_transient
21:10:45.200 user_clear_decision C[128] task_id=253 prev_status=running assigning_set_at=2026-04-18T21:10:42.300+09:00 clear_sent_at=2026-04-18T21:10:42.900+09:00 session_started_clear_at=- session_idle_at=2026-04-18T21:10:44.100+09:00 elapsed_since_clear_sent=2300ms prompt_sent_at=2026-04-18T21:10:43.500+09:00 prompt_file=.team/prompts/task-253-xxx.md decision_reason=running_with_clear_source_unknown
21:10:45.200 task_aborted task_id=253 reason=user_clear
```

解析視点:
- `user_clear_decision` 1 行を読めば「clear 送信から 2.3s しか経っていない」「session_started_clear が未到達」「SESSION_IDLE が先に来て running に倒された」という race のシグネチャが即判定可能
- `assigning_window_close via=SESSION_IDLE source_guess=clear_transient` が「保険経路で遷移した」ことを明示
- 根本修正は別タスクだが、観測可能性が担保されたことで誤判定の再発が即特定可能になる

### 6.2 チェックリスト
- [ ] `bun test` 全 green（既存 + 新規）
- [ ] ConductorState に 4 フィールド + `assignPromptFile` 追加済み
- [ ] `formatUserClearSnapshot` が `daemon.ts` で export され、テストが通る
- [ ] `assigning_window_open` / `clear_sent` / `assign_prompt_sent` が assignTask で emit
- [ ] `assigning_window_close` が SESSION_STARTED(clear) と SESSION_IDLE(assigning+taskRunId) で emit
- [ ] `session_idle` の detail に `source_guess=` が付与
- [ ] `user_clear_decision` が SESSION_CLEAR の running 分岐直前で emit
- [ ] `resetConductor` が 4 フィールド + `assignPromptFile` をクリア
- [ ] T260 と独立 PR として rebase 済み
- [ ] CLAUDE.md ロギングポリシー遵守（空 catch なし、error キー使用、surface 表記）
