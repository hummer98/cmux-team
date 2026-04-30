# T392 Implementation Report

実装ブランチ: `task-392-1777545750/task`
worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-392-1777545750`

## 完了した変更

### コア配管

- **`skills/cmux-team/manager/schema.ts`**
  - `StopFailureMessage`（Zod）を新設し `QueueMessage` discriminated union に追加
  - `AgentState.status` に `"error"` バリアント追加 + `lastApiError?: { kind, message?, at }`
  - `MasterStateSchema.status` に `"error"` 追加 + `lastApiError` optional
  - `ConductorState.status` に `"error"` 追加 + `lastApiError` optional

- **`skills/cmux-team/manager/main.ts`**
  - `buildMessageFromHookInput` に `STOP_FAILURE` 分岐を追加（NotificationMessage と同じく `--role` を flag 経由で受ける、empty 文字列 → undefined 正規化、payload.error 必須）
  - `SURFACE_REQUIRED_TYPES` に `"STOP_FAILURE"` 追加
  - `cmdSend` Usage 行に `NOTIFICATION` / `STOP_FAILURE` 追加
  - `generateMasterSettings` / `generateAgentSettings` / `generateConductorSettings` に `StopFailure` hook 登録（Notification と同型・同順）。それぞれ `--role master/agent/conductor` を hardcode
  - `cmdAwaitAgent` の help を更新（`api_error` ステータス追記、`11` exit code を Exit codes 表に追加）
  - `printAgentDoneAndExit` の status → exit code マップに `api_error → 11` を追加

- **`skills/cmux-team/manager/daemon.ts`**
  - `handleMessage` に `case "STOP_FAILURE"` 追加（NOTIFICATION の直後・SHUTDOWN の前）
  - `resolveStopFailureTarget(state, message)` 新設（NotificationMessage と同じ逆引き優先順位）
  - target に応じて `master.status / conductor.status / agent.status = "error"` + `lastApiError` 上書き
  - agent target では `writeAgentDone(..., { status: "api_error", kind, message })` を呼び Conductor の await-agent に伝える
  - `manager.log` に `api_error_received` 行 + `events.jsonl` に `api_error_received` event 1 行
  - 未知 surface は `stop_failure_unknown_surface` ログ + state 不変
  - `writeAgentDone` の status enum に `"api_error"` 追加 + 任意の `kind` / `message` 受け付け
  - `AGENT_SPAWNED` で新 agent エントリの `lastApiError: undefined` を明示
  - `SESSION_STARTED`（master / conductor / agent）で `lastApiError = undefined`（Conductor は `error` 状態を taskRunId 有無で `running`/`idle` に解除）
  - `SESSION_IDLE`（master / conductor / agent）で `lastApiError = undefined`（Conductor は `error` 状態を taskRunId 有無で `running`/`idle` に解除）

- **`skills/cmux-team/manager/events-writer.ts`**
  - `EventStreamRecord` union に `api_error_received { role, surface, kind, message? }` 追加
  - `EVENTS_SCHEMA_VERSION` は bump せず（add-only）

- **`skills/cmux-team/manager/dashboard.tsx`**
  - `API_ERROR_ICONS` 定数（`rate_limit:⏳ / authentication_failed:🔒 / billing_error:💰 / server_error:⚡`）と `apiErrorIcon` / `truncateApiErrorMessage` ヘルパーを export
  - `buildMasterSection` を `export function` 化（必須修正 2）+ `status === "error"` 分岐
  - `buildConductorRow` のメイン分岐に `isError` を `isAsking` の後・`isDisconnected` の前に挿入。RED + アイコン + `error <kind>` + truncated message
  - Agent サブツリーに `isAgentError` 分岐を追加（asking 優先・error は次点 — 任意修正 5 の通り `isAgentError = !isAgentAsking && a.status === "error"` で同時並立をガード）
  - `shadowObserveConductor` への STOP_FAILURE 流入は **起こさない**（reducer 監視は P3 まで shadow only）

### spec / docs

- **`docs/spec/07-state-machine.md`**
  - §1.1 状態一覧に `error` 行追加（7→8 値）+ Master / Agent も同等拡張の旨を追記
  - §1.2 遷移表に `STOP_FAILURE` 行追加 + `error` 列追加（broken 以外の全状態 → `error`、`SESSION_STARTED` / `SESSION_IDLE` で error → running/idle）
  - §1.4 mermaid 図に `STOP_FAILURE` / `error → idle/running` の遷移を追加
  - §1.5 不変条件に `C-I4` 追加（`status=error` ⇒ `lastApiError != null`）

- **`docs/spec/04-templates.md`**
  - 「settings.json hook 一覧」表を新設し `StopFailure` を含めて全 hook を列挙

- **`docs/spec/08-runtime-boundary.md`**
  - 正規化イベントアルファベット表に `STOP_FAILURE → api_error_received` 行追加

- **`docs/spec/glossary.md`**
  - `hook` 用語の説明に `StopFailure` を追加

### 新規 / 拡張テスト

- `schema.test.ts`: `StopFailureMessage` round-trip（pid required / payload.error required / role enum / QueueMessage 経由）+ AgentState / MasterState / ConductorState `lastApiError` 検証（10 件）
- `main.test.ts`:
  - `buildMessageFromHookInput STOP_FAILURE`（happy / role 透過 / error 欠落 throw / role 不正 throw）4 件
  - `generateMasterSettings` / `generateConductorSettings` / `generateAgentSettings` の `StopFailure` 出力 3 件
  - `cmdAwaitAgent`: `STATUS=api_error / KIND=rate_limit / exit 11` 1 件 + Help に `11 api_error` 1 件
- `daemon.test.ts`: `describe("handleMessage: STOP_FAILURE (T392)")` 配下 9 件（master/conductor/agent target / role fallback / unknown surface / 連続 2 回上書き / SESSION_STARTED でリセット / SESSION_IDLE でリセット / AGENT_SPAWNED で新規 agent の lastApiError undefined）
- `events-writer.test.ts`: `api_error_received` の field 検証 1 件
- `dashboard-conductor.test.tsx`: Agent error サブツリー 6 件 + Conductor error メイン行 1 件
- `dashboard-master.test.tsx`（**新規**）: 既存 idle/running/disconnected の回帰 3 件 + error 表示 3 件 = 6 件

## テスト結果

```
$ bunx tsc --project tsconfig.json --noEmit
exit=0  （新規エラー 0）
```

```
$ for f in *.test.ts state-machine/*.test.ts dashboard-*.test.tsx; do bun test --timeout 30000 "$f"; done
全ファイル PASS（fail 0）
```

主要ファイルの集計（抜粋）:

| ファイル | tests | result |
|---|---|---|
| `daemon.test.ts` | 186 | pass |
| `main.test.ts` | 196 | pass |
| `schema.test.ts` | 38 | pass |
| `events-writer.test.ts` | 19 | pass |
| `dashboard-conductor.test.tsx` | 14 | pass |
| `dashboard-master.test.tsx`（新規） | 6 | pass |
| `state-machine/*` | 223 | pass |

## 受け入れ基準チェック（タスク本文 8 項目）

- [x] 1. Master / Conductor / Agent の settings.json に `StopFailure` hook が登録される（main.ts 3 箇所 + main.test.ts で確認）
- [x] 2. `cmux-team send STOP_FAILURE --from-stdin` が動作する（buildMessageFromHookInput 分岐 + main.test.ts で確認）
- [x] 3. `AgentState` に `lastApiError` + `status: "error"` バリアント追加。`MasterState` / `ConductorState` も同等拡張（schema.ts + schema.test.ts）
- [x] 4. daemon が `STOP_FAILURE` 受信で対象 state を更新し、events.jsonl に `api_error_received` を記録する（daemon.ts STOP_FAILURE case + daemon.test.ts で確認）
- [x] 5. dashboard で error 状態が kind 別アイコン (⏳/🔒/💰/⚡/⚠) + 80 字短縮 message + RED で表示される（dashboard.tsx + dashboard-conductor / dashboard-master test）
- [x] 6. Conductor の `await-agent` が `STATUS=api_error KIND=<kind>` を出力し exit 11 で終わる（main.ts printAgentDoneAndExit + main.test.ts subprocess test）
- [x] 7. artifact A025 と spec 07 / 04 / 08 / glossary の整合性が取れている（spec / docs 更新済み）
- [x] 8. 既存テスト（daemon / dashboard / state-machine / main / schema / events-writer）が pass する（全テスト pass、tsc エラー 0）

## 既知の懸念

- **fallback role 経路は実質 dead code**（plan §3.1 末尾コメント反映済み）。settings.json は `--role` を hardcode で必ず送る契約のため、`resolveStopFailureTarget` の役割不在 fallback 分岐は将来互換性のためのみ維持される。
- **shadowObserveConductor への STOP_FAILURE 流入を起こさない**（plan §Step 6 の任意修正 E に従う）。`error` 状態は reducer 監視対象外で、reducer 拡張は P3 後続タスクへ委ねる。`fsm_invariant_violation` は p1 で log only なのでこの選択で運用上の影響なし。
- **events.jsonl `EVENTS_SCHEMA_VERSION` は bump しない**（add-only）。reader（spec 10）が unknown event を skip する実装になっている前提。skip しない reader が出現した場合は別タスクで bump 検討。
- **アイコン互換性**: `⏳ / 🔒 / 💰 / ⚡ / ⚠` は標準 Unicode/絵文字のみで実装。CMUX_NERD_FONT=0 でも表示可能だが、ターミナルによっては絵文字幅計算がずれる可能性あり（plan §9.7）。本タスクでは ASCII fallback は実装せず（最小スコープ）、必要なら別タスクで `nerdIcon` 経由に拡張する余地を残す。
- **5xx 沈黙タイマーは未実装**（plan §3.5 / §9.x）。A025 §結論 3 で「不要」が確定済み。3 分の体感が長い場合は別タスクで `running_silent_threshold` を導入できる。

---

## Round 2 修正（Inspector minor findings 反映）

Inspector の GO 判定後に検出された **plan と実装の整合 2 件** を TDD で反映。

### 1. `formatConductorsSectionLabel` に `error` カウント追加（plan §6.2 / §9.2）

- **対象**: `skills/cmux-team/manager/dashboard.tsx:850-867` `formatConductorsSectionLabel`
- **修正**:
  - switch 文に `case "error": errorCount++; break;` を追加
  - return 連結文字列末尾に `${errorCount > 0 ? ` ${errorCount} error` : ""}` を追加
- **テスト**: `dashboard-conductor.test.tsx` の `formatConductorsSectionLabel` describe に新ケース追加（"error 状態の Conductor がカウントされる (T392)"）。RED 確認後 GREEN。
- **挙動**: error 1 件 + running 1 件 + idle 1 件 → `"Conductors 1 running 1 error"` を出力（plan §9.2 採用案と一致）

### 2. SESSION_ASK 経路での `lastApiError` リセット（plan §3.6）

- **対象**: `skills/cmux-team/manager/daemon.ts` `case "SESSION_ASK"` (Conductor / Agent 分岐)
- **修正**:
  - Conductor 分岐: `conductor.status = "asking"` 直後に `conductor.lastApiError = undefined` を追加（既存 `conductor.status = "asking"` は無条件代入のため `error → asking` 遷移はそのまま機能。コメントで明示）
  - Agent 分岐: `agent.status = "asking"` 直後に `agent.lastApiError = undefined` を追加
  - Master 分岐: 既存実装は `master_session_ask_ignored` でログのみ出して break する設計（SESSION_STARTED / SESSION_IDLE で自然解除されるため SESSION_ASK での reset は不要）。**過剰修正回避のため触らず**。
- **テスト**: `daemon.test.ts` `describe("handleMessage: STOP_FAILURE (T392)")` に新ケース追加（"STOP_FAILURE 受信後の SESSION_ASK で lastApiError が undefined / status=asking に解除される (Conductor)"）。RED 確認後 GREEN。
- **整合**: plan §3.6「error は SESSION_STARTED / SESSION_IDLE / SESSION_ASK のいずれが来ても自然解除される」が実装で担保されたことを確認。

### 検証

| 項目 | 結果 |
|---|---|
| `dashboard-conductor.test.tsx` | 15 pass / 0 fail（+1 件追加） |
| `daemon.test.ts` | 187 pass / 0 fail（+1 件追加） |
| 全体回帰（manager 配下の `*.test.ts` / `state-machine/*.test.ts` / `dashboard-*.test.tsx`） | 全 ファイル pass |
| `bunx tsc --noEmit`（manager） | 0 エラー |
