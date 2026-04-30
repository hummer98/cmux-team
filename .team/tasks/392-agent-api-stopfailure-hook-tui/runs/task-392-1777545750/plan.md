# T392 実装計画書 — Agent API エラーを StopFailure hook で TUI 可視化

## 1. 背景と目的

cmux-team の TUI は `AgentState.status` が `starting | running | idle | asking` の 4 値しかなく、Claude Code 内部リトライで詰まった Agent も "running" のまま表示される。実機検証 (`A025-api-error-hook-probe.md`) で **`StopFailure` hook が API エラー 4 種別 (rate_limit / authentication_failed / billing_error / server_error) を payload.error として確定的に発火する** ことを確認したため、proxy 改造ゼロでこの hook 経路を追加し、daemon → dashboard までを一気通貫に拡張する。

A025 の結論:
1. proxy 改造不要、StopFailure 1 個で 4 種別を識別できる
2. rate_limit / authentication_failed / billing_error は **即発火** (~0–4s)、server_error のみ ~3 分のリトライ完走後に発火
3. 5xx 中の沈黙タイマーは不要 (Stop hook で自動復帰する場合は実害なし)
4. cmux-team の本番運用は OAuth 経路なので即発火想定で設計してよい

## 2. 影響範囲一覧（実コード Read 済み行番号）

### 2.1 settings.json hook 登録（3 関数）

| 関数 | ファイル | 行 | 既存 hook 並びの位置（StopFailure を入れる場所） |
|---|---|---|---|
| `generateMasterSettings` | `skills/cmux-team/manager/main.ts` | 1930-2010 | Notification (1967-1976) の直後、Stop (1977-1986) の前 |
| `generateAgentSettings` | `skills/cmux-team/manager/main.ts` | 2019-2084 | Notification (2042-2051) の直後、Stop (2052-2061) の前 |
| `generateConductorSettings` | `skills/cmux-team/manager/main.ts` | 2086-2178 | Notification (2122-2132) の直後、Stop (2133-2142) の前 |

### 2.2 cmdSend / Usage / SURFACE_REQUIRED_TYPES

| 箇所 | ファイル | 行 |
|---|---|---|
| `cmdSend` switch 全体 | `main.ts` | 1178-1394 |
| `SURFACE_REQUIRED_TYPES` set | `main.ts` | 1244-1254 |
| Usage 行（`default:` の console.error） | `main.ts` | 1389 |
| `buildMessageFromHookInput`（NOTIFICATION 分岐の隣に STOP_FAILURE 追加） | `main.ts` | 1710-1787 |

### 2.3 schema.ts 型定義

| 箇所 | ファイル | 行 |
|---|---|---|
| `NotificationMessage`（参考パターン） | `schema.ts` | 147-156 |
| `QueueMessage` discriminated union | `schema.ts` | 158-176 |
| 型 export ブロック | `schema.ts` | 178-190 |
| `AgentState` interface | `schema.ts` | 214-229 |
| `MasterStateSchema` + `MasterState` type | `schema.ts` | 233-256 |
| `ConductorState` schema + type（`agents: AgentState[]` を持つ） | `schema.ts` | 260-309 |

### 2.4 daemon.ts handleMessage / 副関数

| 箇所 | ファイル | 行 |
|---|---|---|
| `handleMessage` switch（先頭の `insertHookSignal` / `acceptHookSignal` 共通配管） | `daemon.ts` | 1437-1457 |
| `case "NOTIFICATION"` ハンドラ（参考実装） | `daemon.ts` | 2561-2584 |
| `resolveNotificationEnrichment` 逆引き優先順位（参考） | `daemon.ts` | 2606-2692 |
| `case "AGENT_SPAWNED"`（agent.status="starting" + lastApiError 初期化点） | `daemon.ts` | 1599-1651 |
| `case "SESSION_STARTED"`（master/conductor/agent 各 status="running" / "idle" 遷移点） | `daemon.ts` | 1653-1864 |
| `case "SESSION_IDLE"` の agent 分岐 | `daemon.ts` | 2305-2334（起点は 2305 行 `// T181: Conductor にマッチしなければ Agent surface として処理` コメント） |
| `writeAgentDone` の status enum（拡張対象） | `daemon.ts` | 168-194 |
| `findConductor` (surface / taskRunId 逆引き) | `daemon.ts` | 237-245 |
| `case "SHUTDOWN"` の直前（STOP_FAILURE case の挿入位置） | `daemon.ts` | 2586 直前 |

### 2.5 dashboard.tsx

| 箇所 | 行 |
|---|---|
| カラー定数（`RED` 既存） | 208-213 |
| `buildMasterSection` の status 分岐（disconnected / running / idle）※関数開始は 513 行 | 513-555 |
| `buildConductorRow` メイン分岐（starting / assigning / idle / asking / disconnected / broken / running） | 564-686 |
| Agent サブツリー描画（asking / running / starting / idle） | 688-742 |
| `formatConductorsSectionLabel` 集計 switch | 764-779 |
| `RATE_LIMIT_COLOR_MAP` の RED 利用例 | 270-275 |

### 2.6 await-agent 出力

| 箇所 | ファイル | 行 |
|---|---|---|
| `cmdAwaitAgent`（doc コメント / 出力 spec / exit code 表） | `main.ts` | 3808-3924 |
| `printAgentDoneAndExit`（status → exit code マップ） | `main.ts` | 3926-3947 |
| 上流の `writeAgentDone` 呼び出し（agent error 経由） | `daemon.ts` | 168-194 |

### 2.7 events-writer

| 箇所 | ファイル | 行 |
|---|---|---|
| `EventStreamRecord` union | `events-writer.ts` | 47-125 |
| `EVENTS_SCHEMA_VERSION` | `events-writer.ts` | 23 |

### 2.8 テスト

| 箇所 | ファイル | 行 |
|---|---|---|
| 既存 handleMessage テスト構造（参考） | `daemon.test.ts` | 353, 578-1133 など |
| Agent asking 描画テスト（新ケース挿入位置の参考） | `dashboard-conductor.test.tsx` | 78-107 |
| `formatConductorsSectionLabel` の集計テスト（error 集計を増やす） | `dashboard-conductor.test.tsx` | 114-143 |

### 2.9 spec / docs

| ファイル | 該当 |
|---|---|
| `docs/spec/07-state-machine.md` §1.1 Conductor 状態一覧 + §2 Task / §1.2 遷移表 | 20-99 |
| `docs/spec/04-templates.md`（hook 一覧の言及箇所はないため、追加判断） | — |
| `README.md` / `README.ja.md`（hook 一覧があれば） | 要確認 |

---

## 3. 設計判断（6 論点）

### 3.1 `STOP_FAILURE` の surface → target 解決

**採用案**: **NotificationMessage と同じ「hook 側 role flag を canonical source とし、daemon 側で `state.masters` → `findConductor` → `conductor.agents[]` の順に逆引き」する** (`resolveNotificationEnrichment` daemon.ts:2606-2692 と完全対称)。

- hook 側: `cmux-team send STOP_FAILURE --from-stdin --surface "${CMUX_SURFACE}" --pid "$PPID" --role <master|conductor|agent>` の形で `--role` を渡す（master / conductor / agent それぞれの settings.json で hardcode）
- daemon 側: 解決関数 `resolveStopFailureTarget(state, message)` を新設し以下の優先順位で逆引き:
  1. `message.role === "master"` → `state.masters.get(surface)`
  2. `message.role === "conductor"` → `findConductor(state, surface)`
  3. `message.role === "agent"` → `state.conductors.values()` を走査して `agent.surface === surface` なエージェントを返す
  4. `role` 不在の場合は `state.masters.has` → `findConductor` → agents 走査の **fallback 経路**を試す（NotificationMessage と同じセマンティクス）
  5. 全部 miss → `stop_failure_unknown_surface` を WARN ログに出して break（state 変更なし）

**理由**: NotificationMessage と同じパターンで実装することで、レビュー・テスト・運用の認知負荷を最小化できる。新規 helper を作らず既存パターンを踏襲。

> **fallback 経路の運用上の位置づけ**（任意修正 Design Review D 採用）: 上記 4 番目の「`role` 不在 fallback」は `settings.json` が `--role` を hardcode で必ず送る運用なので**実質 dead code**。それでも経路を維持するのは NotificationMessage との対称性のため（手動 `cmux-team send STOP_FAILURE` 等の将来互換も兼ねる）。実装時に「**契約上 role は常に来る、fallback は将来互換のため**」のコメントを `resolveStopFailureTarget` の fallback 分岐に 1 行入れること。

### 3.2 `lastApiError` のリセットタイミング

**採用案**: **「正常な状態遷移で自動消える」セマンティクス** とし、専用 clear API は持たない。

- `AGENT_SPAWNED`（daemon.ts:1629-1635）: 新規 agent エントリ作成時に `lastApiError: undefined` を明示的に書く（型上は optional のため省略可だが意図を明示する目的でリテラル指定）
- `SESSION_STARTED`（agent: 1818、conductor: 1697 / 1718、master: 1657-1660）: status が "running" / "idle" に遷移した時点で `lastApiError = undefined` をセット
- `SESSION_IDLE`（agent: 2316-2335 / conductor: 2284 / master: 2212）: idle 状態に遷移する経路でも `lastApiError = undefined`
- 明示クリアの CLI は新設しない（必要になったら別タスクで `cmux-team clear-error` を切る）

**理由**:
1. error 状態は次の SESSION_STARTED / SESSION_IDLE で自然に消えるべき (claude が再開したら error 表示は不要)
2. 「明示クリアコマンドが必要」という運用要件は A025 でも要求されていない
3. `error` バリアントから他状態に遷移する経路を **一箇所**（SESSION_STARTED / SESSION_IDLE）に集約することで FSM の予測可能性を保つ

**dashboard 表示中の "stale error" 問題**: error 状態のまま claude が長時間止まる場合（rate_limit で待機中など）は意図通り。ユーザーが /clear で復帰したら SESSION_CLEAR → SESSION_STARTED で消える。

**done file 上書き race（理論上の懸念、実害なし）**: STOP_FAILURE で `writeAgentDone(api_error)` を書いた直後、Stop hook 経由で SESSION_IDLE → `writeAgentDone(completed)` (daemon.ts:2312-2317) が走ると done file が "completed" で上書きされ、Conductor 側が間に合わなければ api_error を取り逃すパスが理論上ある。ただし通常フローでは Conductor の `await-agent` が spawn-agent 直後にブロックして常時 watch しており、done 出現と同時に `printAgentDoneAndExit` が unlink する (main.ts:3945) ため、上書き前に消費される。**await-agent が常時 watch している前提でこの race は実害なし**。

### 3.3 同 session_id で StopFailure 複数回受信時の挙動

**採用案**: **最新 payload で `lastApiError` を上書き（履歴は trace DB の `hook_signals` テーブルに既に残るので state には最新値のみ）**。冪等性は「同じ kind / at で来ても state は破壊しない」セマンティクスを保つ。

具体:
- `target.lastApiError = { kind, message, at: message.timestamp }` で常に上書き
- `target.status` は既に "error" なら no-op、それ以外なら "error" に遷移
- 受信ログ (`api_error_received`) は毎回出す（hook_signals + manager.log の双方）
- events.jsonl にも毎回 `api_error_received` を append（イベントストリームの完全性優先）

**理由**:
1. 履歴は trace DB と events.jsonl で既に保証される (同じ session_id で重複受信しても両方に追記される)
2. state には最新値のみ持つことで dashboard の表示ロジックが単純化される
3. 同 session_id で連続発火するのは server_error の自動リトライ完走後のみで、現実的に頻度は低い

### 3.4 `await-agent` の `api_error` exit code

既存: `completed`/`ask` → 0、`timeout` → 2、`crashed` → 10、internal error → 1

**採用案**: **`api_error` → exit code 11**

- 0/1/2/10 はすべて使用済みなので衝突しない最小の整数として 11 を選ぶ
- 「異常終了系（10 / 11）」というブロックを作り、Conductor 側 shell が `case` で `[ "$STATUS" = "crashed" ] || [ "$STATUS" = "api_error" ]` のように扱える
- `printAgentDoneAndExit` の status → exit code マップに `api_error` 行を追加

合わせて出力フォーマット:
```
STATUS=api_error
KIND=rate_limit
MESSAGE=API Error: Server is temporarily limiting requests ...
TIMESTAMP=2026-04-30T10:23:00.000Z
TIMESTAMP_MS=1745983380000
```

`KIND` は `printAgentDoneAndExit` が done ファイルから `kind=` を読み取って `KIND=` として大文字化して出力する（既存の `key=value` 自動大文字化ロジックがそのまま動く）。

### 3.5 5xx 中 3 分沈黙時の挙動

**採用案**: **特別扱いせず素通し**（A025 §結論 3 と一致）。

- claude が自動リトライで復帰した場合: 通常の `Stop` hook が来て `SESSION_IDLE` に自然遷移し `lastApiError` も消える
- 復帰しなかった場合: 3 分後に `StopFailure` (`server_error`) が確定発火し、本タスクの経路で error 表示される
- daemon 側の沈黙タイマーは追加しない（過剰設計）

dashboard 上は:
- 5xx 沈黙中: agent.status は "running" のまま（リトライ中なので妥当）
- 3 分後: error 表示に切り替わる

**理由**: A025 §結論 3 で「沈黙タイマー不要」が明示済み。仮に 3 分の体感が長い場合は別タスクで `running_silent_threshold` を導入する余地を残しておく。

### 3.6 dashboard の error 表示優先度（asking と error の並立）

**採用案**: **`asking` を error より優先**（`isAsking` を `isError` より先に判定）

理論上 `StopFailure` は AskUserQuestion をブロックするため両立しない（A025 §「リトライ中は他 hook も来ない」）が、安全側に倒す:

```ts
const isAgentAsking = a.status === "asking";        // 最優先
const isAgentError = !isAgentAsking && a.status === "error";  // 次点
const isAgentRunning = a.status === "running" || a.status === "starting";
```

**理由**:
1. asking は **ユーザーの即時介入が必要**（質問待ち）。error より緊急度が高い
2. error は SESSION_STARTED / SESSION_IDLE / SESSION_ASK のいずれが来ても自然解除されるため、誤って asking 中に "error" のまま残るリスクはない
3. 両立する瞬間があったとしても、それは hook 配信の race にすぎず次 tick で自然解消する

---

## 4. schema 変更（diff 形式）

### 4.1 `schema.ts` — `StopFailureMessage` 追加

```diff
+ // T392: Claude Code StopFailure hook 受信時のメッセージ。
+ // payload.error は 4 種別 + forward-compat の string union。role は hook 側で hardcode。
+ // pid は NotificationMessage / SessionStopMessage と同じく required（settings.json は --pid "$PPID" を必ず付ける契約）。
+ export const StopFailureMessage = z.object({
+   type: z.literal("STOP_FAILURE"),
+   surface: z.string(),
+   pid: z.number(),
+   role: z.enum(["master", "conductor", "agent"]).optional(),
+   payload: z.object({
+     session_id: z.string().optional(),
+     transcript_path: z.string().optional(),
+     error: z.string(),  // "rate_limit" | "authentication_failed" | "billing_error" | "server_error" | unknown
+     last_assistant_message: z.string().optional(),
+   }),
+   timestamp: z.string().datetime(),
+ });
+ export type StopFailureMessage = z.infer<typeof StopFailureMessage>;
```

> **必須修正反映 (Design Review #1)**: `pid` を required に変更。`NotificationMessage.pid: z.number()` (schema.ts:152) / `SessionStopMessage.pid: z.number()` (schema.ts:122) と整合。settings.json は `--pid "$PPID"` を hardcode で必ず送る契約。

### 4.2 `schema.ts` — `QueueMessage` discriminated union に追加

```diff
 export const QueueMessage = z.discriminatedUnion("type", [
   ...
   NotificationMessage,
+  StopFailureMessage,
   ShutdownMessage,
 ]);
```

### 4.3 `schema.ts` — `AgentState` 拡張

```diff
 export interface AgentState {
   surface: string;
   role?: string;
   taskTitle?: string;
   spawnedAt: string;
   sessionId?: string;
   pid?: number;
   pidWatcherInterval?: ReturnType<typeof setInterval>;
-  status: "starting" | "running" | "idle" | "asking";
+  status: "starting" | "running" | "idle" | "asking" | "error";
   tokenHandle?: string;
+  /** T392: StopFailure hook 受信時の最新 API エラー情報。
+   *  上書きは hook 受信時のみ。AGENT_SPAWNED / SESSION_STARTED / SESSION_IDLE で undefined に戻る。
+   *  team.json には永続化される（pidWatcherInterval と違い JSON serialize 可）。 */
+  lastApiError?: {
+    kind: "rate_limit" | "authentication_failed" | "billing_error" | "server_error" | string;
+    message?: string;
+    at: string;
+  };
 }
```

### 4.4 `schema.ts` — `MasterStateSchema` 拡張

```diff
 export const MasterStateSchema = z.object({
   surface: z.string(),
   pid: z.number().optional(),
-  status: z.enum(["starting", "idle", "running", "disconnected"]),
+  status: z.enum(["starting", "idle", "running", "disconnected", "error"]),
   startedAt: z.string().datetime(),
   disconnectedAt: z.string().datetime().optional(),
   prompt: z.string().optional(),
   tokenHandle: z.string().optional(),
+  lastApiError: z.object({
+    kind: z.string(),
+    message: z.string().optional(),
+    at: z.string().datetime(),
+  }).optional(),
 });
```

### 4.5 `schema.ts` — `ConductorState` 拡張

```diff
 export const ConductorState = z.object({
   ...
   tokenHandle: z.string().optional(),
+  lastApiError: z.object({
+    kind: z.string(),
+    message: z.string().optional(),
+    at: z.string().datetime(),
+  }).optional(),
 });

 export type ConductorState = z.infer<typeof ConductorState> & {
   agents: AgentState[];
-  status: "starting" | "assigning" | "idle" | "running" | "asking" | "disconnected" | "broken";
+  status: "starting" | "assigning" | "idle" | "running" | "asking" | "disconnected" | "broken" | "error";
   pidWatcherInterval?: ReturnType<typeof setInterval>;
   runtimeSessionRef?: string;
 };
```

### 4.6 JSON serialize 互換性

- `lastApiError` は plain object（`Date` ではなく ISO 文字列）→ そのまま `JSON.stringify` 可
- `pidWatcherInterval` は引き続き serialize 対象外（既存パターン踏襲）
- 旧 team.json 復元時は `lastApiError` フィールドが無いため undefined が入る（zod `.optional()` で許容）
- `status: "error"` を含む team.json は新 daemon でのみ書き出される（旧 daemon 復元経路は migration 不要）

---

## 5. 実装手順（TDD 順）

### Step 1: schema 拡張（型レイヤー）

**RED (失敗テスト)** — `skills/cmux-team/manager/schema.test.ts` に追加:
- `case: "T392 StopFailureMessage parses minimum payload"` — `{ type: "STOP_FAILURE", surface, payload: { error: "rate_limit" }, timestamp }` の round-trip
- `case: "T392 AgentState supports status='error' + lastApiError"` — interface 互換性 (TypeScript 型エラーで RED)
- `case: "T392 MasterState/ConductorState lastApiError optional"`

**GREEN**: schema.ts を §4 の通り更新。`bunx tsc --noEmit` が通る。

### Step 2: cmux-team CLI の send サブコマンド受け口

**RED** — `skills/cmux-team/manager/main.test.ts` に追加:
- `case: "T392 buildMessageFromHookInput STOP_FAILURE happy path"` — hook stdin JSON `{ "hook_event_name": "StopFailure", "error": "rate_limit", "last_assistant_message": "...", "session_id": "uuid", "transcript_path": "..." }` を渡して `StopFailureMessageSchema.parse` を通る `QueueMessage` が返ること
- `case: "T392 buildMessageFromHookInput STOP_FAILURE role flag passthrough"` — `--role agent` が `message.role` に伝播
- `case: "T392 buildMessageFromHookInput STOP_FAILURE missing error field"` — error フィールド欠落で zod throw
- `case: "T392 STOP_FAILURE pid 欠落で zod throw"` — `--pid` を渡さずに parse すると zod エラーになる（pid required 契約の明示）

**GREEN**:
- `main.ts:1710-1787` `buildMessageFromHookInput` に `if (type === "STOP_FAILURE") { ... }` 分岐を追加（NotificationMessage と同じく `role` を `flag` 経由で受ける）
- `main.ts:1389` Usage 行に `STOP_FAILURE` を追加

**REFACTOR**: NotificationMessage / StopFailureMessage の共通配管が増えるなら helper 抽出を検討（M2 では先送り可）。

### Step 3: settings.json hook 登録

**RED** — `main.test.ts` に追加:
- `case: "T392 generateMasterSettings includes StopFailure hook"` — 出力 JSON を parse し `hooks.StopFailure[0].hooks[0].command` に `cmux-team send STOP_FAILURE --from-stdin --surface "${CMUX_SURFACE}" --pid "$PPID" --role master` を含むこと
- 同様に Conductor / Agent

**GREEN**: §2.1 の 3 関数に `StopFailure: [{ matcher: "", hooks: [{ type: "command", command: "...", timeout: 5000 }] }]` を追加。

注意: settings.json の hook 配列順は **Notification と同型・同順** にして、レビュー時の差分を最小化する。

### Step 4: daemon ハンドラ実装

**RED** — `daemon.test.ts` に新 describe ブロック追加:
- `describe("handleMessage: STOP_FAILURE")`
  - `test: "agent surface → agent.status='error' + lastApiError 上書き + events.jsonl 1 行"`
  - `test: "conductor surface → conductor.status='error' + lastApiError"`
  - `test: "master surface → master.status='error' + lastApiError"`
  - `test: "role flag が無くても fallback 逆引きで解決できる"`
  - `test: "未知 surface は stop_failure_unknown_surface ログのみで state 不変"`
  - `test: "同 surface に連続 2 回 STOP_FAILURE が来たら最新 timestamp / message で上書きされる（冪等）"`
  - `test: "AGENT_SPAWNED 後に STOP_FAILURE → SESSION_STARTED で lastApiError = undefined / status = running"`
  - `test: "STOP_FAILURE 受信後の SESSION_IDLE で lastApiError = undefined / status = idle"`

**GREEN**:
- `daemon.ts:2586` 直前（SHUTDOWN case の前）に `case "STOP_FAILURE": { ... }` を実装
- 内部で `resolveStopFailureTarget(state, message)` helper を呼び、target に応じて status と lastApiError を更新
- `await log("api_error_received", ...)` を出す
- `await emitEvent({ event: "api_error_received", role, surface, kind, message })` を出す（events-writer に新 record 追加）
- `notifyStateChanged("daemon.ts:handleMessage:stop-failure-<role>")` を発火

それから `AGENT_SPAWNED` / `SESSION_STARTED` / `SESSION_IDLE` の各分岐に「`lastApiError = undefined` をセット」する 1 行を追加（§3.2 の通り）。

**REFACTOR**: `resolveStopFailureTarget` と `resolveNotificationEnrichment` に共通の「surface → role」逆引きの抽出は将来検討（最小スコープでは個別実装でよい）。

### Step 5: events-writer 拡張

**RED** — `events-writer.test.ts` に追加:
- `case: "T392 emitEvent api_error_received"` — schema_version + ts + record が JSONL に append される

**GREEN**:
- `events-writer.ts:47-125` の union に追加:
  ```ts
  | {
      event: "api_error_received";
      role: "master" | "conductor" | "agent" | "unknown";
      surface: string;
      kind: string;
      message?: string;
    }
  ```
- `EVENTS_SCHEMA_VERSION` は **bump しない**（互換 add）。reader 側は新規 event を unknown としてスキップする実装になっている前提。スキップしない場合は別タスクで bump 検討。

### Step 6: dashboard error 表示

**RED** — `dashboard-conductor.test.tsx` に追加:
- `describe("buildConductorRow: Agent error サブツリー")`
  - `test: "agent.status='error' + lastApiError.kind='rate_limit' で ⏳ + RED + truncated message が出る"`
  - `test: "kind='authentication_failed' で 🔒"`
  - `test: "kind='billing_error' で 💰"`
  - `test: "kind='server_error' で ⚡"`
  - `test: "未知 kind で ⚠ fallback"`
  - `test: "asking と error が並立した場合は asking 優先（❓表示）"`
- `describe("buildConductorRow: Conductor error メイン行")`
  - `test: "conductor.status='error' で RED + ⚠ + kind icon + label"`
- 新規 `dashboard-master.test.tsx`（ファイル新設）
  - `test: "buildMasterSection error 状態で RED + icon + truncated message"`
- `formatConductorsSectionLabel` 既存テストに `error` カウント表示の追加を入れる（採用なら）

**GREEN**:
- `dashboard.tsx:208-213` のカラー定数は `RED` 既存なので追加不要
- **`dashboard.tsx:513` の `function buildMasterSection` を `export function buildMasterSection` に変更する**（必須修正 Design Review #2: テストファイル `dashboard-master.test.tsx` から直接 import するため。`buildConductorRow` / `formatConductorsSectionLabel` と同等の export 形態に揃える）
- `dashboard.tsx:513-555` `buildMasterSection` に `if (status === "error")` 分岐
- `dashboard.tsx:564-686` `buildConductorRow` メイン分岐に `isError` 分岐を **isAsking の後・isDisconnected の前** に挿入
- `dashboard.tsx:706-738` Agent サブツリーに `isAgentError` 分岐を `isAgentAsking` の後に追加
- **`shadowObserveConductor` への `STOP_FAILURE` 流入は起こさない**（任意修正 Design Review E 採用）。既存 SESSION_STARTED / SESSION_IDLE / SESSION_ASK / SESSION_CLEAR 末尾で呼ばれている `shadowObserveConductor(...)` のパターンに倣って STOP_FAILURE case 末尾にも追加したくなる衝動を抑える。reducer 監視は §1.5 不変条件 C-I4 「reducer 監視は P3 まで shadow only」と整合し、本タスクでは reducer 経由を使わない
- アイコンマップは関数スコープに定数化:
  ```ts
  const API_ERROR_ICONS: Record<string, string> = {
    rate_limit: "⏳",
    authentication_failed: "🔒",
    billing_error: "💰",
    server_error: "⚡",
  };
  // unknown → "⚠"
  ```
- 短縮 message は **80 字 truncate**（>80 なら 77 + "..."）。改行は空白に置換（asking と同パターン）

**REFACTOR**: error icon マップを dashboard.tsx 内 module-level 定数として export してテストから直接参照可能にする。

### Step 7: await-agent 出力 STATUS=api_error

**RED** — `main.test.ts`（または専用 test）に追加:
- `case: "T392 printAgentDoneAndExit api_error → exit 11"`
- `case: "T392 done file with status=api_error kind=rate_limit → STATUS=api_error KIND=rate_limit"`

**GREEN**:
- `daemon.ts:168-194` `writeAgentDone` の `payload.status` enum に `"api_error"` を追加し、`payload.kind?: string` / `payload.message?: string` も受け取れるようにする
- daemon の STOP_FAILURE ハンドラで agent target の場合は `writeAgentDone(..., { status: "api_error", kind, message })` を呼ぶ（asking と同じく Conductor が `await-agent` で受け取れるように）
- `main.ts:3938-3942` `printAgentDoneAndExit` の status → exit code マップに:
  ```ts
  status === "completed" || status === "ask" ? 0 :
  status === "crashed" ? 10 :
  status === "api_error" ? 11 :
  1
  ```
- `main.ts:3814` doc コメントの STATUS リストを更新（`completed | crashed | ask | api_error` + `KIND=<kind>`）
- `main.ts:3833-3838` Help の Exit codes 表にも `11 api_error` を追加

### Step 8: spec / docs 更新

DocKeeper Agent ではなく Implementer 範疇で以下を更新:

- `docs/spec/07-state-machine.md`:
  - §1.1 Conductor 状態一覧に `error` 行を追加（意味: StopFailure 受信、入口例: `STOP_FAILURE`）
  - §1.2 遷移表に `STOP_FAILURE` event の列を追加（全状態 → `error`、ただし `broken` は no-op）
  - §1.4 mermaid 図にも `error` 状態と遷移を追加
  - Task 側 §2 への影響なし（Task FSM は変わらない）
  - `error → idle/running` の遷移は SESSION_STARTED / SESSION_IDLE で起きると明記
- `docs/spec/04-templates.md`: hook 一覧の独立節は無いが、§Common Header の周辺に StopFailure 1 行を追加（あるいは「hook の追加・削除は generateXxxSettings 関数を見よ」で済ませる）
- `README.md` / `README.ja.md`: **`grep -l "Notification" README*` で hit すれば StopFailure を 1 行追加、hit しなければ skip**（任意修正 Design Review C 採用、確定方針）。Notification を README に書いていないなら StopFailure もアーキテクチャ詳細として README には載せず spec/template 側で完結させる

### Step 9: VERIFY（統合検証）

- `cd skills/cmux-team/manager && for f in *.test.ts state-machine/*.test.ts dashboard-*.test.tsx; do bun test --timeout 30000 "$f"; done` 全 pass（CLAUDE.md 記載の標準ルート）
- `bunx tsc --noEmit`（manager 配下）でエラー 0
- 手動動作確認 (§6.3) を実施

---

## 6. テスト計画

### 6.1 新規テスト一覧

| ファイル | 追加 case |
|---|---|
| `schema.test.ts` | `StopFailureMessage` round-trip / AgentState・MasterState・ConductorState の `lastApiError` optional 確認（3 件） |
| `main.test.ts` | `buildMessageFromHookInput STOP_FAILURE` の happy path / role 透過 / 必須欠落 / `generateMasterSettings`・`generateConductorSettings`・`generateAgentSettings` の StopFailure 出力（6 件） |
| `daemon.test.ts` | `describe("handleMessage: STOP_FAILURE")` 配下に 8 件（§Step 4 リスト） |
| `events-writer.test.ts` | `api_error_received` 出力（1 件） |
| `dashboard-conductor.test.tsx` | Agent error サブツリー 6 件 + Conductor error メイン行 1 件 |
| `dashboard-master.test.tsx`（**新規ファイル**） | Master error 表示 1 件 + 既存 idle/running/disconnected 回帰 3 件（既存挙動を保証） |
| `main.test.ts` (await-agent) | `printAgentDoneAndExit api_error → exit 11` / done ファイル変換 / Help 文字列に exit 11 が含まれる（3 件） |

### 6.2 既存テストへの追加 vs 新ファイル

- `dashboard-conductor.test.tsx`: 既存の `describe("buildConductorRow: Agent asking")` の隣に `describe("buildConductorRow: Agent error")` を追加（同じ helper / countYellow を流用したいので **新ファイルは作らず追記**）
- `formatConductorsSectionLabel` のテスト: error カウントを集計に入れる **採用判断は §7 リスク参照**（採用するなら既存ファイル追記）
- `dashboard-master.test.tsx`: 既存 master 関連テストファイルが無いため **新規作成**（命名規約は他の dashboard-*.test.tsx に合わせる）
- `daemon.test.ts`: 新規 `describe("handleMessage: STOP_FAILURE")` を末尾近く（既存 NOTIFICATION 系の隣）に追加

### 6.3 手動動作確認手順

```bash
# 1. settings.json 生成確認
cmux-team start  # daemon 起動
jq .hooks.StopFailure .team/prompts/surface:1-master-settings.json
jq .hooks.StopFailure .team/prompts/surface:N-conductor-settings.json
jq .hooks.StopFailure .team/prompts/surface:M-agent-settings.json

# 2. 直接 send で daemon 受信確認 (agent surface 例)
cat <<'EOF' | cmux-team send STOP_FAILURE --from-stdin --surface "surface:5" --pid 99999 --role agent
{
  "hook_event_name": "StopFailure",
  "session_id": "fake-session-uuid",
  "transcript_path": "/tmp/fake.jsonl",
  "error": "rate_limit",
  "last_assistant_message": "API Error: Server is temporarily limiting requests..."
}
EOF
# → OK

# 3. dashboard 確認
cmux-team status      # error 状態が表示されている
tail .team/logs/manager.log | grep api_error_received
tail .team/logs/events.jsonl | jq 'select(.event=="api_error_received")'

# 4. await-agent 出力確認 (Conductor surface 配下に dummy agent surface を作って done を書く)
echo -e "status=api_error\nkind=rate_limit\nmessage=test\ntimestamp_ms=$(date +%s)000" \
  > .team/conductors/surface_<C>/agent-done/surface_<A>.done
cmux-team await-agent --surface surface:<A> --timeout 5
echo "exit: $?"      # → 11
# 出力: STATUS=api_error / KIND=rate_limit / MESSAGE=test

# 5. リセット動作確認
cmux-team send SESSION_STARTED --surface surface:5 --pid 99999 --session-id new-session
# dashboard で error → running に切り替わり lastApiError が消える
```

### 6.4 既存テストへの破壊的影響

- `daemon.test.ts` の SESSION_STARTED 系テストには `lastApiError = undefined` をセットする 1 行が増えるが、既存 assertion (`expect(agent.status).toBe("running")` 等) には影響しない
- `dashboard-conductor.test.tsx` の `formatConductorsSectionLabel` テストは error カウント追加の有無で変わる（§7 リスク参照）
- `state-machine/*.test.ts`: status 列挙拡張で reducer の `STOP_FAILURE` 対応が追加されるが、本タスクは reducer 経由の遷移を **shadow 配線対象外**とし、daemon.ts での直接 mutation で実装する。reducer 拡張は後続タスク（P3 の Conductor side mutation reducer 化）で行う

---

## 7. spec 更新箇所一覧（行番号レベル）

### 7.1 `docs/spec/07-state-machine.md`

| 箇所 | 行 | 変更 |
|---|---|---|
| §1.1 Conductor 状態一覧テーブル | 22-32 | `error` 行を追加（"StopFailure hook 受信" / 入口例: "`STOP_FAILURE`") |
| §1.2 遷移表 | 40-60 | 列に `STOP_FAILURE` イベントを追加。各状態 → `error`、ただし `broken` のみ no-op |
| §1.4 Mermaid 図 | 75-99 | `error` 状態と `STOP_FAILURE` 遷移、`error → running/idle` の SESSION_STARTED/IDLE 遷移を追加 |
| §1.5 不変条件 | 102-109 | `C-I4`（新規）: `status=error` ⇒ `lastApiError != null`（reducer 監視は P3 まで shadow only） |
| §3 Conductor ↔ Task 同時遷移 | 198-210 | StopFailure は Task 側遷移を起こさない旨を明記（Task FSM は不変） |

Agent FSM は本仕様書では明示的に書かれていないが、§1 全般に「Agent も同じ status / lastApiError 拡張を受ける」一文を追加する（または Agent の独立節を新設するか判断は実装時）。

### 7.2 `docs/spec/04-templates.md`

| 箇所 | 行 | 変更 |
|---|---|---|
| 全般 | — | hook 一覧の独立節がないため、§Common Header (29-44) の隣に「Master / Conductor / Agent settings.json hook 一覧」表を新設し、`StopFailure` を含めて全 hook を列挙する（既存 Notification / Stop / SessionStart / SessionEnd も同表に明記） |

### 7.3 `README.md` / `README.ja.md`

要 grep 確認。hook 一覧があれば 1 行追加。無ければ更新不要。

### 7.4 `docs/spec/08-runtime-boundary.md`

| 箇所 | 行 | 変更 |
|---|---|---|
| §正規化イベントアルファベット | 118-130 | `StopFailure` → 正規化イベント `api_error_received` の対応行を追加 |

---

## 8. 受け入れ基準チェックリスト（タスク本文 8 項目）

- [ ] 1. Master / Conductor / Agent の settings.json に `StopFailure` hook が登録される（§Step 3）
- [ ] 2. `cmux-team send STOP_FAILURE --from-stdin` が動作する（手動 stdin で 200 OK、§6.3 step 2）
- [ ] 3. `AgentState` に `lastApiError` + `status: "error"` バリアントが追加される（§4.3）。`MasterState` / `ConductorState` にも同等拡張（§4.4 / §4.5）
- [ ] 4. daemon が `STOP_FAILURE` 受信で対象 state を更新し、events.jsonl に `api_error_received` を記録する（§Step 4 / §Step 5）
- [ ] 5. dashboard で error 状態が kind 別アイコン (⏳/🔒/💰/⚡/⚠) + 80 字短縮 message + RED で表示される（§Step 6）
- [ ] 6. Conductor の await-agent が `STATUS=api_error KIND=<kind>` を出力し exit 11 で終わる（§Step 7、§3.4）
- [ ] 7. artifact A025 と spec 07 / 04 / 08 の整合性が取れている（§7、§Step 8）
- [ ] 8. 既存テスト (daemon / dashboard / state-machine / main / schema / events-writer) が pass する（§Step 9）

---

## 9. リスクと注意点

### 9.1 既存 Notification hook との重複発火リスク

A025 §「リトライ中は他 hook も来ない」より、StopFailure 発火後に約 1 分後 `Notification(idle_prompt)` が**二次通知として来る**。

- 影響: `STOP_FAILURE` で `lastApiError` が入った直後、`NOTIFICATION` も来る
- 現状の `NOTIFICATION` ハンドラ（daemon.ts:2561-2584）は state 遷移を起こさず logging のみなので **副作用は無い**
- ただし dashboard の status 表示は asking とは別経路（NOTIFICATION → permission_prompt 等は asking ではなく単なる log）なので問題なし
- 念のため `case "NOTIFICATION"` 内で `target.status === "error"` の場合に何も塗り替えないことを確認（既存実装は state 不変なので OK）

### 9.2 status 列挙拡張による既存コードへの影響

`AgentState.status` / `MasterState.status` / `ConductorState.status` に `"error"` を追加することで、TypeScript の `switch` / `Record` lookup で網羅性チェックが落ちる箇所がある:

| 箇所 | 影響 | 対応 |
|---|---|---|
| `dashboard.tsx:706-738` Agent サブツリー | `isAgentAsking` / `isAgentRunning` 以外は idle 扱い → error も idle に流れる | §Step 6 で `isAgentError` 分岐追加 |
| `dashboard.tsx:564-686` `buildConductorRow` | else 節で running 扱い | §Step 6 で `isError` 分岐追加 |
| `dashboard.tsx:524-555` `buildMasterSection` | else 節で idle 扱い | §Step 6 で `isError` 分岐追加 |
| `dashboard.tsx:764-779` `formatConductorsSectionLabel` | switch 漏れで `error` がカウントされない | **判断必要**: error カウントを表示するか? → §6.2 採用案: error カウントも追加（"Conductors 1 error" を表示）して可視性を確保 |
| `state-machine/conductor-fsm.ts` 等の reducer | `STOP_FAILURE` event 未対応 | reducer 拡張は P3 後続タスク。本タスクは shadow observer 経由でも捕捉しない（§Step 6 GREEN 末尾で明示） |
| `daemon.ts:2269-2272` 等の `c.status === "running"` 判定 | TUI tick 判定ロジック | `error` も "応答待ち" 系として扱うか判断。最小スコープでは追加しない |

**`acceptHookSignal` のフィルタは不要**（任意修正 Design Review A 採用）。`claude-code-backend.ts:276-311` の `acceptHookSignal` は switch に hit しない type を `event = null` のまま no-op で受け流す（default ブランチ無し、`emitEvent` も呼ばれない）。よって STOP_FAILURE を `daemon.ts:1455-1457` の `state.backend.acceptHookSignal(message)` に渡しても何も起きない。当初の「STOP_FAILURE は acceptHookSignal の対象外として daemon.ts:1455 でフィルタ」案は**削除**し、特別なガードなしでそのまま流して良い。

### 9.3 `cmux-team send STOP_FAILURE --from-stdin` の throttle 影響

rate_limit エラーで claude が止まったとき、StopFailure hook 自身が `cmux-team send` を呼ぶが、これは **claude の API 呼び出しではなく** local IPC（HTTP POST to `localhost:<proxy-port>/api/messages`）なので rate_limit の影響を受けない。

ただし以下の懸念:
- proxy が落ちている場合（極稀）: hook が exit 1 で失敗するが claude は気にしない（`2>/dev/null || true` で suppress）
- daemon が忙しい場合: queue 長 1 増えるだけで影響軽微
- 同時に多数の Agent が同じ rate_limit を踏んだ場合: 数十件の STOP_FAILURE が瞬間的に届くが、handleMessage は順次処理するので race は起きない（既存 NOTIFICATION と同じ）

→ throttle 起因の問題は構造的に発生しない。

### 9.4 lastApiError の team.json 永続化

`team.json` に persist する `MasterState` / `ConductorState` (`schema.ts:233-309`) に `lastApiError` を追加するが、既存の永続化経路 (`persistMasterFile` / Conductor の persist) は zod schema を経由するため schema 拡張だけで動く。pidWatcherInterval 等の non-serializable runtime field と違い、`lastApiError` は plain object なのでそのまま JSON 化される。

restoreConductors / restoreMasters で復元時:
- 古い team.json (lastApiError 不在) → undefined で復元 OK
- 新 team.json で error 状態のまま daemon 再起動 → restore 後 status="error" のまま、次の SESSION_STARTED で消える

restore 時に強制的に `lastApiError = undefined` にリセットするかは判断ポイント:
- **採用**: 起動時の "stale error" を避けるため強制リセット。理由: daemon 再起動中に届いた hook は失われており、再起動後の error 表示は誤情報の可能性が高い
- 該当箇所: `restoreMasters` (daemon.ts:875-908 周辺) と Conductor restore（要 grep 特定）

### 9.5 `runtime-backend` interface への影響

`Issue #30 M3-b` で `acceptHookSignal` 経由で hook を backend に流す配管が入っている (daemon.ts:1455-1457)。STOP_FAILURE は **opencode backend では発生しない** (Claude Code 専用 hook) ため当初は type guard の要否を要確認としていたが、**対処不要・確定**（任意修正 Design Review A 採用）。

`claude-code-backend.ts:276-311` の `acceptHookSignal` 実装を確認した結果:
- switch に hit しない type は `event = null` のまま no-op で受け流す（default ブランチ無し）
- `emitEvent` も呼ばれず副作用ゼロ
- discriminated union 全網羅は要求していない

→ STOP_FAILURE を `acceptHookSignal` にそのまま流しても何も起きないため、`daemon.ts:1455` での type guard / フィルタは**不要**。実装時にここで余計なガードを入れない。

### 9.6 events.jsonl schema_version

`api_error_received` event は events.jsonl の schema 拡張だが、`EVENTS_SCHEMA_VERSION = 2` のまま bump しない（add-only 拡張）。reader (`docs/spec/10-events-stream.md` 等) が unknown event を skip する実装になっているか要確認。skip しない場合は別タスクで bump 検討。

### 9.7 アイコン表示の互換性

`⏳` (U+23F3) / `🔒` (U+1F512) / `💰` (U+1F4B0) / `⚡` (U+26A1) は CMUX_NERD_FONT=0 環境（Nerd Font 無し）でも標準 Unicode で表示できる。ただしターミナルによっては幅計算がずれる可能性がある（特に絵文字）。既存の `nerdIcon(nerd, fallback)` ヘルパーを使い、fallback として `[rate_limit]` `[auth]` `[billing]` `[server]` の ASCII ラベルを用意するのが安全。

→ アイコン表示を Nerd Font / Unicode 絵文字 / ASCII fallback の 3 段で実装するかは判断ポイント。最小スコープでは Unicode 絵文字のみで OK だが、本実装時に調整。

---

## 設計判断の注釈（Round 2 — Design Review 反映）

design-review.md の指摘への判断結果:

### 必須修正（両方反映済み）

1. **`StopFailureMessage.pid` を required 化**（§4.1） — `NotificationMessage` / `SessionStopMessage` と整合。§Step 2 RED テスト一覧に `STOP_FAILURE pid 欠落で zod throw` を追加済み
2. **`buildMasterSection` を export に変更**（§Step 6 GREEN） — `dashboard-master.test.tsx` から直接 import するため `export function` 化を明記。§6.1 / §6.2 のテスト方針はそのまま維持

### 任意修正（5 件すべて採用）

| ID | 内容 | 反映先 |
|---|---|---|
| A | `acceptHookSignal` フィルタ不要を確定 | §9.2（フィルタ削除） / §9.5（要確認 → 対処不要・確定） |
| B | await-agent 常時 watch 前提による done file race 実害なし | §3.2 末尾に 1 段落追記 |
| C | README hook 一覧の更新方針確定 | §Step 8（grep hit したら追加 / 無ければ skip と明文化） |
| D | `role` 不在 fallback の運用上の位置づけ | §3.1 末尾に 1 段落追記（実装時に fallback 分岐に「契約上 role は常に来る、将来互換のため」コメントを入れる） |
| E | `shadowObserveConductor` への STOP_FAILURE 流入を起こさない明記 | §Step 6 GREEN 末尾に 1 行追加 |

### 行番号の軽微訂正（反映済み）

- §2.4 SESSION_IDLE agent 分岐: `2316-2335` → `2305-2334`（起点を 2305 行のコメント基準に）
- §2.5 `buildMasterSection`: `524-555` → `513-555`（関数開始 513 行）
- §7.1 §1.5 不変条件: `102-110` → `102-109`

---

## 付録: 用語整理

- **target**: STOP_FAILURE hook の送信元 surface に対応する Master / Conductor / Agent state エントリ
- **api_error_received**: events.jsonl で本タスクが新設する event 名（過去形は `task_completed` 等の既存命名と一致）
- **kind**: payload.error の値（rate_limit / authentication_failed / billing_error / server_error / forward-compat）
- **STATUS=api_error**: await-agent stdout に出る status 値（done ファイルの `status=api_error` を大文字化）

以上。
