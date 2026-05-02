# T379 plan: cmux-team metrics サブコマンド実装 + hook_signals 棚卸し

## 1. 概要

CodeDNA を cmux-team 自身に適用するか **計測ベース** で判断するための baseline 計測基盤を構築する。

- 既存の events.jsonl (T358) / hook_signals (T216) / api_usage (T305) を input に、`cmux-team metrics` で per-task / 期間集計を返す CLI を実装する。
- 現状 `hook_signals` テーブルには **Pre/PostToolUse 系イベントが一切記録されていない** （現状の hook 設定が `Notification` / `StopFailure` / `SessionStart` / `SessionEnd` / `UserPromptSubmit` / `Stop` のみで、tool 単位観察用 hook は無い）ため、tool call レベルの集計を行うには **hook 受信パスの拡張** が必須。本タスクでは hook 拡張 → DB 列追加 → CLI 実装の順で TDD 実装する。
- 大量データ対策（GC など）は本タスクのスコープ外（CLAUDE.md の既知の注意点に既に記載されている方針を踏襲）。

## 2. hook_signals 棚卸しの判断

### 2.1 payload_json の構造（実 DB 確認結果）

`/Users/yamamoto/git/cmux-team/.team/traces/traces.db` の hook_signals に格納されている `type` の distinct 値は以下の通り（実測）:

```
AGENT_SPAWNED, AGENT_TOKEN_BOUND, CONDUCTOR_CLEAR, CONDUCTOR_DONE,
CONDUCTOR_REGISTERED, MASTER_REGISTERED, NOTIFICATION,
SESSION_CLEAR, SESSION_ENDED, SESSION_IDLE, SESSION_STARTED,
SESSION_STOP, TASK_CREATED, TASK_UPDATED
```

- `PreToolUse` / `PostToolUse` 系イベントは **0 件**。
- 既存 `payload_json` のうち `NOTIFICATION` のみが Claude Code hook stdin の生 JSON（`session_id`, `transcript_path`, `cwd`, `hook_event_name`, `message`, `notification_type` 等）を保持している。
- その他 (SESSION_*, AGENT_*) は cmux-team 側のメッセージ schema に従う独自 payload。

→ **結論**: 現状の payload_json から `tool_name` / `tool_input.file_path` / `tool_response.success` を抽出することは不可能。理由は **そもそもそのデータが入っていないから** であって、JSON_EXTRACT で済むかどうかの問題ではない。

### 2.2 必要な拡張

| 必要なフィールド | 現在の状態 | 対応方針 |
|---|---|---|
| `tool_name` | 取得経路なし | Master / Conductor / Agent settings の hooks に `PreToolUse` / `PostToolUse` を追加し、stdin の `tool_name` を含めて daemon に転送 |
| `tool_input.file_path` | 取得経路なし | hook stdin の `tool_input` を payload_json として保存 |
| `tool_response` (success / error) | 取得経路なし | PostToolUse hook stdin に含まれる `tool_response` を payload_json として保存 |
| `session_id` | NOTIFICATION の payload にのみ存在 | hook stdin の `session_id` を全 tool 系メッセージで取得し、専用列として追加 |

### 2.3 専用列追加 vs JSON_EXTRACT

両方を併用する設計を取る。

- **集計頻度の高い 2 列のみ専用列化**: `tool_name`, `session_id`
  - 理由: 集計 SQL の `WHERE tool_name = 'Edit' AND session_id = ?` を高速にしたい。インデックス化が必要なため SQLite の `JSON_EXTRACT` 結果ではなく実列にする。
- **`tool_input` / `tool_response` は payload_json のみ**: 列爆発を避ける。集計時に `JSON_EXTRACT(payload_json, '$.tool_input.file_path')` で抽出する。
- **`payload_json` の 64KB truncate** に注意: `tool_response.content` が長文（Read ツールの 1000 行ファイル等）になる可能性が高いため、**hook 受信時に `tool_response.content` を 1KB に切り詰めて再シリアライズ** する。`tool_response.success` フラグやエラーメッセージは保持する。
- ALTER TABLE migration は既存の `ensureHookSignalsColumns` パターンを踏襲（trace-store.ts:344）:

```ts
const required = [
  "surface_uuid", "workspace_uuid", "role", "task_id",
  "conductor_surface", "agent_role", "message", "notification_type",
  "session_id",     // 新規追加
  "tool_name",      // 新規追加
] as const;
```

インデックスも追加:

```ts
db.exec("CREATE INDEX IF NOT EXISTS idx_hook_signals_session_id ON hook_signals(session_id)");
db.exec("CREATE INDEX IF NOT EXISTS idx_hook_signals_tool_name ON hook_signals(tool_name)");
```

## 3. session_id / task_id 紐付けの検証

### 3.1 現状

- `hook_signals` テーブル: `session_id` 列は **存在しない**。NOTIFICATION の payload_json に埋まっている。
- `task_sessions` テーブル: `session_id` (TEXT NOT NULL) が必須列として存在し、`(task_id, session_id)` の対応を保持している。
- `events.jsonl`: `task_assigned` / `task_completed` / `task_aborted` などの task lifecycle イベントは `task_id` を持つが `session_id` は持たない。`conductor_surface` は持つ。

### 3.2 join 戦略

```sql
-- hook_signals (新 session_id 列) ↔ task_sessions の最終 SESSION_STARTED 行
SELECT h.id, h.tool_name, ts.task_id
FROM hook_signals h
LEFT JOIN task_sessions ts
  ON ts.session_id = h.session_id
  AND ts.event = 'session_started'
WHERE h.type IN ('PRE_TOOL_USE', 'POST_TOOL_USE')
```

- task_sessions は同じ session_id に対して複数行を持ちうる（resume などで増える）。集計では `task_id` を取れれば十分なので `event = 'session_started'` 行から MIN を取る、もしくは `MAX(task_id)` で代替する（同じ session が複数の task に紐づくケースは現実には無い前提）。
- ズレが発生するケース:
  - **/clear 直後の hook**: `SESSION_STARTED` メッセージは送られるが `task_sessions` への upsert より前に PreToolUse が走る可能性 → join 結果が NULL になる。集計では `task_id IS NULL` を「unattached」として別カウントすれば良い。
  - **session_id 未取得 hook**: 万一 stdin に `session_id` が無い場合、専用列 NULL のまま payload_json にも入らない。集計対象外として扱う（warn 出力のみ）。

### 3.3 NOTIFICATION 既存行のバックフィル

NOTIFICATION の payload_json には `session_id` が既にある（実 DB で確認済み）。新たに追加した `session_id` 列は新規行のみ書き込まれる。**既存行のバックフィルは本タスクではしない**（理由: NOTIFICATION は本タスクの集計対象ではない、tool 系の集計には新規データのみで十分）。必要なら別タスクで `UPDATE hook_signals SET session_id = json_extract(payload_json, '$.session_id') WHERE type='NOTIFICATION' AND session_id IS NULL` を 1 回打つだけ。

## 4. metrics サブコマンドの実装方針

### 4.1 ファイル分割案

| ファイル | 役割 |
|---|---|
| `skills/cmux-team/manager/metrics-cli.ts` | argv parse / dispatcher / 出力 (json/text/csv) — **events-cli.ts と同パターン** で `runMetricsCli(opts): Promise<number>` を export し process.exit せず stdout/stderr を capture できるようにする |
| `skills/cmux-team/manager/metrics-aggregate.ts` | 集計ロジック（純粋関数群）。events.jsonl reader + DB クエリラッパー + per-task / 期間 / variance 計算 |
| `skills/cmux-team/manager/trace-store.ts` への追記 | tool 系 hook_signals 集計 SQL（`countToolCallsByTask` / `countToolCallsByDay` / `aggregateHookOutcomes` 等）+ `ensureHookSignalsColumns` の required に 2 列追加 |
| `skills/cmux-team/manager/schema.ts` への追記 | `PreToolUseMessage` / `PostToolUseMessage` zod schema を追加し、`QueueMessage` discriminated union に組み込む |
| `skills/cmux-team/manager/main.ts` への追記 | `buildMessageFromHookInput` に `PRE_TOOL_USE` / `POST_TOOL_USE` 分岐を追加 / `generateMasterSettings` / `generateAgentSettings` / `generateConductorSettings` に PreToolUse / PostToolUse hook を追加 / dispatcher に `case "metrics"` 追加 |
| `skills/cmux-team/manager/i18n/*` | `help_metrics` キーを追加（events と同じパターン） |

### 4.2 main.ts dispatcher への登録ポイント

main.ts:5533 の `case "events":` の直後に `case "metrics":` を追加（events パターンと完全一致させる）:

```ts
case "metrics":
  await cmdMetrics();
  break;
```

`cmdMetrics()` は events の `cmdEvents()` と同じ thin wrapper（main.ts:4915 を参考）。SIGINT/SIGTERM ハンドリングと AbortController も同型とする（follow モードは無いが abort 自体は将来対応するため最初から設置）。

### 4.3 options のパース・バリデーション方針

| Option | 受け付ける値 | バリデーション |
|---|---|---|
| `--task-id <id>` | 文字列（例: `379`） | 数値 ID の形式は厳密に弾かない（draft/T プレフィックスへの将来拡張に備える） |
| `--since <duration\|ts>` | `7d` / `24h` / `30m` / ISO 8601 (`2026-04-01` または full datetime) | `events-cli.ts` の `parseSince` を export → import して再利用（DURATION_RE, ISO_LIKE_RE）。重複定義を作らない |
| `--format json\|text\|csv` | デフォルト `json` | events-cli では json/text のみだが metrics は csv も加える。`json` の出力は per-task オブジェクトの配列、`text` は key=value の 1 行/タスク、`csv` は header 1 行 + データ行 |
| `--group-by task\|day\|week` | デフォルト `task` | `task` 以外は時系列 bucket。week は ISO week (月曜開始) で固定 |
| `--help` / `-h` | flag | events-cli と同じく `t("help_metrics")` を stdout |

events-cli の `parseSince` / `parseTypes` を **export してから metrics-cli から import** する（events-cli.ts に既に`export function parseSince` / `parseTypes` がある）。csv は metrics-cli 専用なので新規実装。

## 5. 集計指標の実装詳細

すべて `metrics-aggregate.ts` の純粋関数として実装し、metrics-cli は呼び出すだけにする。

### 5.1 events.jsonl 由来（task lifecycle）

| 指標 | 計算式 | 実装関数 |
|---|---|---|
| task assigned 時刻 | `event = 'task_assigned'` の `ts` | `readTaskLifecycle(filePath, since): Map<task_id, Lifecycle>` |
| task completed/aborted 時刻 | `event = 'task_completed' \| 'task_aborted' \| 'task_completed_state_mismatch'` の `ts` | 同上 |
| 完了時間 | `closed_ts - assigned_ts` (ms) | `lifecycle.durationMs` |
| abort 率 | `task_aborted` 件数 / `task_assigned` 件数 | `aggregatePeriod(lifecycle)` |
| forced close 率 | `task_completed_state_mismatch` + `conductor_disconnect_timeout` 件数 / `task_assigned` 件数 | 同上 |
| task 完了率 | `task_completed` 件数 / `task_assigned` 件数 | 同上 |

events.jsonl のシーケンシャル read は events-cli.ts の `processLine` パターンを再利用するが、metrics は **bulk read のみ** で良いので follow ロジックは持たない。`runOnce` 相当の readline ベース実装で十分。

### 5.2 hook_signals 由来（tool call）

| 指標 | SQL | 実装関数 |
|---|---|---|
| Read/Edit/Bash call 数 (per task) | `SELECT tool_name, COUNT(*) FROM hook_signals h JOIN task_sessions ts ON ts.session_id = h.session_id WHERE h.type='PRE_TOOL_USE' AND h.timestamp BETWEEN $since AND $until GROUP BY ts.task_id, h.tool_name` | `countToolCallsByTask(db, opts): Map<task_id, Map<tool_name, count>>` |
| time-to-first-Edit | `SELECT MIN(h.timestamp) FROM hook_signals h JOIN task_sessions ts USING(session_id) WHERE h.tool_name='Edit' AND h.type='PRE_TOOL_USE' GROUP BY ts.task_id` → `min_ts - assigned_ts` | `firstEditPerTask(db, opts): Map<task_id, ms>` |
| tool call 失敗率 (per task) | `JSON_EXTRACT(payload_json, '$.tool_response.success') = 0` または `tool_response.error IS NOT NULL` の件数 / 全 PostToolUse 件数 | `failureRateByTask(db, opts)` |
| hook block 率 (PreToolUse deny) | PreToolUse の中で hook 自身が exit 2 した件数 / 全 PreToolUse 件数。**Claude Code の標準仕様では「PreToolUse hook が exit 2 で deny したかどうか」を Claude Code 側がさらに別 hook で通知することは無い**。よって本指標は **「Conductor 側の Bash deny script が拒否した件数」** として、deny 時に専用 type `PRE_TOOL_USE_DENIED` を別途 daemon に送る hook を追加する（既存 `PRE_TOOL_USE_HOOK_SCRIPT` の `exit 2` 直前に `cmux-team send PRE_TOOL_USE_DENIED ...` を 1 行追加）。 | `denyRateByPeriod(db, opts)` |

### 5.3 api_usage 由来（token 消費）

既存の `aggregateApiUsageByTask` (trace-store.ts:1097) を再利用する。`metrics-aggregate.ts` 側でラップして `--since` の duration を `[sinceIso, untilIso]` に変換するだけ。

### 5.4 variance（タスク間ばらつき）

```ts
// 純粋関数として metrics-aggregate.ts に実装
export function stddev(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}
```

`tool call 数 / token 消費 / 完了時間` の 3 種について `--group-by task` 時に variance を併記する。

### 5.5 出力 schema（json）

```jsonc
// --group-by task
[
  {
    "task_id": "379",
    "assigned_ts": "2026-04-29T07:32:20.204Z",
    "closed_ts": "2026-04-29T13:18:00.993Z",
    "duration_ms": 20740789,
    "outcome": "completed", // completed | aborted | state_mismatch | forced_close | open
    "tool_calls": { "Read": 14, "Edit": 5, "Bash": 8, "Grep": 2 },
    "tool_call_total": 29,
    "tool_failure_rate": 0.034,
    "time_to_first_edit_ms": 84200,
    "tokens": { "input": 12345, "output": 4321, "cache": 99000, "requests": 18 }
  }
]
// --group-by day / week
[
  {
    "bucket": "2026-04-29",
    "tasks_assigned": 7,
    "tasks_completed": 6,
    "tasks_aborted": 1,
    "completion_rate": 0.857,
    "abort_rate": 0.143,
    "forced_close_rate": 0,
    "deny_rate": 0.012,
    "tool_call_total": 412,
    "tool_call_stddev": 38.4,
    "duration_ms_mean": 18923000,
    "duration_ms_stddev": 7320000,
    "tokens_total": { "input": 230000, "output": 78000, "cache": 1900000 }
  }
]
```

text / csv は同じデータをフラットに展開する。

## 6. テスト方針 (TDD)

### 6.1 fixture 戦略

- **DB**: `new Database(":memory:")` を `initDB` 相当の SCHEMA で初期化する小さなヘルパーを用意する（既存 `trace-store.test.ts` のパターンを踏襲）。`insertHookSignal` / `insertTaskSession` / `recordApiUsage` を直接呼んで前置データを作る。
- **events.jsonl**: `Bun.write(tmpFile, lines.map(JSON.stringify).join("\n"))` でテンポラリファイルを作り、`runOnce` 相当の reader にパスを渡す。`os.tmpdir()` 配下に `cmux-metrics-test-${randomUUID()}` で隔離。
- 大容量データのテストは不要（集計関数は決定論的）。

### 6.2 各モジュールの unit test

| テストファイル | 対象 | 重点 |
|---|---|---|
| `metrics-aggregate.test.ts` | events.jsonl reader / SQL クエリ / variance 計算 | task 4 件 + tool call 12 件 + api_usage 8 件の fixture で per-task / period / week 集計が期待通りになるか。stddev は手計算と一致するか |
| `metrics-cli.test.ts` | argv parse / 出力 format / exit code | events-cli.test.ts と同パターン: `runMetricsCli({ args, projectRoot, stdout, stderr, abortSignal })` を直接呼ぶ。`--format csv` のヘッダー行 / 値エスケープを最低 2 ケース |
| `trace-store.test.ts` への追記 | `ensureHookSignalsColumns` が新 2 列を追加するか / `countToolCallsByTask` の SQL が正しい結果を返すか | ALTER TABLE 冪等性の test (2 回実行で warn 1 回のみ) |
| `main.test.ts` への追記 | `buildMessageFromHookInput("PRE_TOOL_USE", ...)` の schema 検証 | 必須フィールド欠損 / unknown tool_name / payload truncate |

### 6.3 テスト実行コマンド

CLAUDE.md の禁忌に従い `bun test` 全体実行は **絶対に避ける**。個別ファイル単位:

```bash
cd skills/cmux-team/manager
for f in metrics-aggregate.test.ts metrics-cli.test.ts trace-store.test.ts main.test.ts; do
  bun test --timeout 30000 "$f"
done
```

既存テストへの影響確認も同じ手順で `events-cli.test.ts` / `dashboard-metrics.test.tsx` を回し、grep 走査で `hook_signals` / `payload_json` を参照しているテストが他に無いか確認する。

## 7. 実装ステップ（TDD 順序）

### Step 1: hook_signals に session_id / tool_name 列を追加

1. `trace-store.test.ts` に「`ensureHookSignalsColumns` が `session_id` / `tool_name` 列を追加し、idempotent である」テストを追加 → red
2. `trace-store.ts:344` の `required` に 2 列を追加、`CREATE INDEX` も追記 → green

### Step 2: PRE_TOOL_USE / POST_TOOL_USE schema を追加

1. `schema.ts` の zod schema に `PreToolUseMessage` / `PostToolUseMessage` を追加（NotificationMessage:147 のパターン）し、`QueueMessage` discriminated union に組み込む
2. テスト: `schema.test.ts` 相当があれば追記、無ければ `main.test.ts` で `QueueMessage.parse(...)` の最低限のテストを追加

`PreToolUseMessage` / `PostToolUseMessage` の必須フィールド:

```ts
{
  type: "PRE_TOOL_USE" | "POST_TOOL_USE",
  surface: string,
  pid: number,
  role: "master" | "conductor" | "agent",
  sessionId: string | undefined,
  toolName: string,                       // payload.tool_name
  payload: Record<string, any>,           // hook stdin の生 JSON (tool_input / tool_response 含む)
  timestamp: string
}
```

### Step 3: buildMessageFromHookInput に 2 タイプ対応

1. `main.test.ts:1394` の `describe("buildMessageFromHookInput (T203)")` に PRE_TOOL_USE / POST_TOOL_USE のケースを追加
   - `tool_name` が無い → throw
   - `tool_response.content` が 8KB 超 → 1KB に切り詰めて payload に入れる
2. `main.ts:1712` の `buildMessageFromHookInput` 末尾（throw 直前）に `if (type === "PRE_TOOL_USE")` / `if (type === "POST_TOOL_USE")` 分岐を追加

### Step 4: insertHookSignal を 2 新列に対応

1. `trace-store.test.ts` に「PRE_TOOL_USE メッセージを insert すると session_id / tool_name 専用列が埋まる」テストを追加
2. `trace-store.ts:446` `insertHookSignal` の INSERT 文に session_id / tool_name 列を追加し、QueueMessage 内の `sessionId` / `toolName` を取り出す（NotificationMessage の enrichment と違い、PreToolUse は最初から本体メッセージに乗っているので UPDATE 経路ではなく INSERT 時に直接書く）

### Step 5: settings.json に PreToolUse / PostToolUse hook を追加

1. `main.test.ts` の settings 生成テストに「Master/Conductor/Agent settings に PreToolUse (matcher: "") と PostToolUse (matcher: "") の hook が含まれる」テストを追加
2. `generateMasterSettings` (main.ts:1962) / `generateAgentSettings` (main.ts:2063) / `generateConductorSettings` (main.ts:2141) に以下のブロックを追加:

```json
"PreToolUse": [
  // 既存の Bash deny ブロック（Conductor のみ。matcher: "Bash"）と並列で追記する
  {
    "matcher": "",
    "hooks": [{
      "type": "command",
      "command": "bash -c 'cmux-team send PRE_TOOL_USE --from-stdin --surface \"${CMUX_SURFACE}\" --pid \"$PPID\" --role <role> 2>/dev/null || true'",
      "timeout": 3000
    }]
  }
],
"PostToolUse": [
  {
    "matcher": "",
    "hooks": [{
      "type": "command",
      "command": "bash -c 'cmux-team send POST_TOOL_USE --from-stdin --surface \"${CMUX_SURFACE}\" --pid \"$PPID\" --role <role> 2>/dev/null || true'",
      "timeout": 3000
    }]
  }
]
```

Conductor の既存 `PreToolUse: matcher: "Bash"` deny script は **そのまま温存** する。Claude Code は同じ event に複数 matcher の hook ブロックを登録できるため共存可能（既存仕様で settings に複数ブロックが並ぶ箇所は他にも多数）。

### Step 6: PRE_TOOL_USE_DENIED 送信を Bash deny script に追加

`main.ts:1658` の `PRE_TOOL_USE_HOOK_SCRIPT` で `exit 2` の直前に以下を挿入:

```bash
cmux-team send PRE_TOOL_USE_DENIED --message "cmux send/send-key denied" --surface "${CMUX_SURFACE:-}" --pid "$PPID" 2>/dev/null || true
```

`PRE_TOOL_USE_DENIED` メッセージの schema は最小（surface/pid/role/timestamp + reason 文字列のみ）。集計対象として `denyRateByPeriod` から参照する。

### Step 7: metrics-aggregate.ts の純粋関数群を実装

1. `metrics-aggregate.test.ts` を新規作成し、6 つの集計関数 (`readTaskLifecycle`, `aggregatePeriod`, `countToolCallsByTask`, `firstEditPerTask`, `failureRateByTask`, `denyRateByPeriod`) のテストを fixture 駆動で書く → red
2. `metrics-aggregate.ts` を実装 → green
3. trace-store.ts に追加で必要な SQL 関数（`countToolCallsByTask` 等）はこちらに移すか trace-store 側に置くかは責務分担で判断: **生 SQL は trace-store 側、集計の組み立て＋events.jsonl との結合は metrics-aggregate** とする（dashboard-metrics と同じ分担方針 — dashboard-metrics.ts:1 のコメント参照）

### Step 8: metrics-cli.ts CLI ラッパーを実装

1. `metrics-cli.test.ts` を新規作成し、events-cli.test.ts と同パターンで stdout/stderr capture テストを書く → red
2. `metrics-cli.ts` を実装。argv parse は events-cli の `parseSince` / `parseTypes` を import 流用（**未 export なら events-cli 側に export 追加**） → green
3. csv フォーマッタは新規実装（最小: header 行 + 値の `,` / 改行 / `"` を ダブルクォートで囲んでエスケープ）

### Step 9: main.ts dispatcher に登録

1. main.ts:5533 直後に `case "metrics":` を追加
2. `cmdMetrics()` 関数を main.ts:4915 の `cmdEvents()` と同型で追加
3. `i18n/*` に `help_metrics` キーを追加（events と同じく日本語/英語）

### Step 10: e2e 動作確認

```bash
cd skills/cmux-team/manager
bun run main.ts metrics --since 7d --format json | head -100
bun run main.ts metrics --since 7d --format text
bun run main.ts metrics --since 7d --format csv
bun run main.ts metrics --task-id 358 --format json
bun run main.ts metrics --since 30d --group-by week --format json
```

事前に `cmux-team start` を 1 回再起動して新 settings を反映し、しばらく実運用したあとで PreToolUse hook の payload_json が正しく入っているかも確認:

```bash
sqlite3 .team/traces/traces.db "SELECT type, tool_name, session_id, substr(payload_json, 1, 200) FROM hook_signals WHERE type IN ('PRE_TOOL_USE','POST_TOOL_USE') ORDER BY id DESC LIMIT 5"
```

### Step 11: Done 判定の確認

タスク本文の Done 判定を再確認:

- [ ] `cmux-team metrics --since 7d --format json` が動作し per-task 集計を返す
- [ ] hook_signals に必要フィールドが揃っている（session_id / tool_name 列追加 + PreToolUse/PostToolUse メッセージ受信）
- [ ] bun test 既存 suite 全 pass（個別ファイル単位で実行）

すべて `OK` を確認したら `cmux-team close-task --task-id 379 --deliverable-kind=merged ...` で close（実装担当 Implementer の責務）。

## 8. 想定される変更ファイル一覧

### 新規

- `skills/cmux-team/manager/metrics-cli.ts`
- `skills/cmux-team/manager/metrics-aggregate.ts`
- `skills/cmux-team/manager/metrics-cli.test.ts`
- `skills/cmux-team/manager/metrics-aggregate.test.ts`

### 修正

- `skills/cmux-team/manager/schema.ts` — PreToolUseMessage / PostToolUseMessage / PreToolUseDeniedMessage を追加し discriminated union に組み込む
- `skills/cmux-team/manager/trace-store.ts` — `ensureHookSignalsColumns` の required に 2 列追加 / `insertHookSignal` の INSERT に session_id / tool_name を追加 / `countToolCallsByTask` 等の集計 SQL 追加
- `skills/cmux-team/manager/main.ts`
  - `buildMessageFromHookInput` に PRE_TOOL_USE / POST_TOOL_USE / PRE_TOOL_USE_DENIED 分岐
  - `generateMasterSettings` / `generateAgentSettings` / `generateConductorSettings` に PreToolUse / PostToolUse hook 追加
  - `PRE_TOOL_USE_HOOK_SCRIPT` の deny 時 `cmux-team send PRE_TOOL_USE_DENIED` 追加
  - dispatcher に `case "metrics"` 追加
  - `cmdMetrics()` 関数追加
- `skills/cmux-team/manager/events-cli.ts` — `parseSince` / `parseTypes` を export（既に export 済みなので一時的に追加で確認のみ）
- `skills/cmux-team/manager/i18n/ja.ts` / `en.ts` — `help_metrics` キーを追加
- `skills/cmux-team/manager/main.test.ts` — buildMessageFromHookInput / settings 生成のテスト追加
- `skills/cmux-team/manager/trace-store.test.ts` — migration / insertHookSignal の新列テスト / countToolCallsByTask テスト追加
- `docs/spec/01-skill-cmux-team.md` または別ファイル — `cmux-team metrics` の subcommand 仕様を追記（必要なら docs-sync で別タスク対応も可）

### 触らない

- `task-state.json` 操作 — 本タスクは task-state を mutate しない（`applyTaskEvent` / `updateTaskSessionId` 経由のみのルールに違反しない）
- `dashboard.tsx` / `dashboard-metrics.ts` — UI 統合は本タスクのスコープ外。CLI 出力のみで十分

## 9. リスク / 未解決の論点

### 9.1 hook 発火頻度による DB 肥大

PreToolUse / PostToolUse は **タスク 1 件あたり数十〜数百回発火** する。1 日 5 タスク稼働で 1000〜5000 行/日の write が増える。

- 対策: payload_json の `tool_response.content` を 1KB に truncate（4 章で記載）
- GC は本タスクでは未実装（CLAUDE.md 既知の注意点に従い別タスク化）。`hook_signals` の row 数が 100k を超えたら別タスクで GC を入れる

### 9.2 hook timeout 3000ms の妥当性

`cmux-team send` がローカル proxy 経由なので通常 < 50ms だが、daemon 過負荷時は数百 ms かかる。3000ms は十分なマージンだが、PostToolUse hook の遅延が claude のレスポンス時間に直接乗る点に留意。`|| true` で suppress しているので失敗しても claude セッションは止まらない。

### 9.3 Claude Code の hook 仕様変更リスク

Claude Code が将来的に PreToolUse の stdin schema を変更する可能性がある（`tool_input` 構造、`tool_response` の fields 等）。**daemon 側では hook stdin の生 JSON を payload_json にそのまま入れる方針** にしているため schema 変更には強い。集計層（metrics-aggregate）が `JSON_EXTRACT` で参照する path が変わったら集計結果が NULL になるが、daemon は壊れない。

### 9.4 task_id 未確定の hook

`task_assigned` イベント前に `PreToolUse` が走るタイミング（Conductor が plan 読み込みのために自分の作業ディレクトリを Read 等する）がある。これは `task_sessions` に session_id レコードが無いため `JOIN` で task_id が NULL になる。**集計では「unattached」として別カウント** する。

### 9.5 同 session_id 内で複数タスクを跨ぐ可能性

理論上、同じ Conductor session が時系列で 2 つ以上のタスクを処理しうる（assigned → completed → next assigned が同 session 内）。`task_sessions` は新タスク assigned 時に新 session_id を発行する設計（実装確認済み）なので **現状はこの問題は発生しない** が、もし将来「session 跨ぎでタスクを処理する」ようになった場合に hook_signals.task_id が 1:1 でなくなる。本タスクでは現状仕様に沿って task_sessions の最新行で join する。

### 9.6 events.jsonl の `journal_summary` を含む長文 record

`task_completed` の `journal_summary` は数 KB に達することがある。metrics は使わない（filter で event だけ見れば OK）が、`readTaskLifecycle` は不要 field を読み飛ばす実装にする（`record.event` と `record.task_id` と `record.ts` のみ）。

### 9.7 NOTIFICATION 既存行の session_id バックフィル

3.3 で「本タスクではしない」と決めた。万一バックフィルが必要になった場合のクエリだけ記録しておく:

```sql
UPDATE hook_signals
SET session_id = json_extract(payload_json, '$.session_id')
WHERE session_id IS NULL
  AND type = 'NOTIFICATION'
  AND json_valid(payload_json)
  AND json_extract(payload_json, '$.session_id') IS NOT NULL;
```

### 9.8 csv フォーマットの spec

CSV は spec が無いと実装ぶれる。本タスクでは RFC 4180 を採用する:

- 区切り `,`、改行 `\r\n`
- フィールド内の `,` / `\r` / `\n` / `"` を含む場合のみダブルクォートで囲む
- ダブルクォートは `""` でエスケープ

実装は metrics-cli.ts に `formatCsvRow(values: string[]): string` として 20 行程度で書く。

### 9.9 master の hook 発火と headers の汚染

Master は `ANTHROPIC_CUSTOM_HEADERS: x-cmux-role: master` を持つので role 列は決定論的に master になる。ただし api_usage と異なり hook_signals の role 列は env 経由ではなく `--role` flag 経由で書き込む。settings.json テンプレートで `--role master` をハードコードしているため schema 上は master が入る。**Conductor が CMUX_TEAM_AGENT として spawn された Agent と区別できない可能性** に注意 — Agent settings 側の `--role agent` が確実に渡るかを Step 5 のテストで確認する。

---

以上で plan は完了。Implementer はこの plan に従い Step 1 〜 11 を順に進める。各 Step はテスト → 実装の TDD ペアで完結し、Step 間の依存は **線形** （Step N が完了していなければ Step N+1 のテストが書けない）。
