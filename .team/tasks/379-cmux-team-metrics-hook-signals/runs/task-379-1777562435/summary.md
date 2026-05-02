# T379 実装 summary

`cmux-team metrics` サブコマンドの新設と、その前提となる `hook_signals` テーブルへの tool 単位観察データ取り込みを TDD で 11 step に分解して実装した。design-review の Verdict: Approved を踏まえ、minor Recommendations 1〜5 をすべて反映している。

## 1. 実装した機能の概要

### 1.1 hook_signals 拡張（tool 単位の観察データ）

- `hook_signals` テーブルに `session_id` / `tool_name` 専用列を追加（idempotent な ALTER TABLE migration / SCHEMA CREATE TABLE 両対応）
- 高速 JOIN/WHERE 用に `idx_hook_signals_session_id` / `idx_hook_signals_tool_name` を追加
- `insertHookSignal` の INSERT に新 3 列（`role` / `session_id` / `tool_name`）を追加（QueueMessage 本体から取り出し）

### 1.2 PRE_TOOL_USE / POST_TOOL_USE / PRE_TOOL_USE_DENIED schema

- `schema.ts` に 3 種類の zod schema を追加し `QueueMessage` discriminated union に組み込み
- `buildMessageFromHookInput` に PRE_TOOL_USE / POST_TOOL_USE / PRE_TOOL_USE_DENIED 分岐を追加
- `tool_response.content` / `tool_input.content` は hook 受信時点で 1KB に切り詰めて payload_json の 64KB truncate を回避（success / error フラグは保持）

### 1.3 settings.json への hook 注入

- Master / Conductor / Agent の各 settings に `matcher: ""` の PreToolUse / PostToolUse hook を追加（`--role <master|conductor|agent>` をハードコード）
- Conductor は既存の Bash deny ブロック (`matcher: "Bash"`) と並列で `matcher: ""` ブロックを追加（Recommendation 2: filter 取得方式でテスト）
- Conductor の既存 Bash deny script に `cmux-team send PRE_TOOL_USE_DENIED` を `exit 2` 直前に注入し、deny を daemon に通知

### 1.4 `cmux-team metrics` CLI

- `metrics-cli.ts`: 引数 parse / format 分岐 / 出力（events-cli.ts と同型の thin wrapper）
- `metrics-aggregate.ts`: 純粋関数群（events.jsonl reader, period 集計, per-task / per-bucket 集計, stddev）
- `trace-store.ts`: tool 系 hook_signals 集計 SQL（`countToolCallsByTask` / `firstEditPerTask` / `failureRateByTask` / `denyRateByPeriod`）
- options: `--task-id` / `--since (5m / 1h / 2d / ISO 8601)` / `--format json|text|csv` / `--group-by task|day|week`
- 出力: per-task は `task_id, outcome, duration_ms, tool_calls, tool_failure_rate, time_to_first_edit_ms, tokens` / per-bucket は `tasks_assigned/completed/aborted, completion_rate, abort_rate, forced_close_rate, deny_rate, tool_call_total, tool_call_stddev, duration mean/stddev, tokens_total`
- `events-cli.ts` の `parseSince` / `parseTypes` を import 流用（重複定義なし）
- csv は RFC 4180 準拠（`,` / `\r\n` / `"` のエスケープ）

### 1.5 i18n / dispatcher

- `help_metrics` を ja / en の両方に追加（hook block 率の意味を明記 — Recommendation 5）
- `help_main` の Usage に `cmux-team metrics` 行を追加
- main.ts dispatcher の `case "events"` 直後に `case "metrics"` を追加（cmdMetrics は cmdEvents と同型）

### 1.6 design-review Recommendations の反映

| # | 内容 | 反映場所 |
|---|---|---|
| 1 | hook レイテンシ実測 | summary.md §5 で実運用後の測定方針として記載（現時点では新 hook がリリース前のため 0 件） |
| 2 | settings 生成テストに role アサーション + filter 取得 | `main.test.ts` の T379 settings テスト（Master / Conductor / Agent それぞれで `--role` 文字列をアサート、`matcher === ""` で filter） |
| 3 | session_id 重複対策の WITH CTE | `trace-store.ts` の `countToolCallsByTask` / `firstEditPerTask` / `failureRateByTask` SQL に `WITH session_to_task AS (... GROUP BY session_id)` を入れ、テストでも同 session_id × 2 行 fixture を追加 |
| 4 | Step 2 で `PreToolUseDeniedMessage` も同時 schema 化 | schema.ts に 3 種類同時追加。Step 6 は Bash script に send 1 行と CLI dispatcher 分岐の追加だけに収束 |
| 5 | help_metrics に hook block 率の意味を明記 | i18n.ts の `help_metrics` ja/en 両方で「現状は cmux-team の Bash deny rate に限定」と明示 |

> Recommendation 3 の「task_sessions の event 名」は plan.md / design-review では `'session_started'` と記述されていたが、実 DB の正規対応は `event = 'assigned'`（task_sessions テーブルは `assigned / agent_spawned / closed / aborted` の 4 値のみで、`session_started` は実在しない）。SQL とテストの両方で `event = 'assigned'` に修正済み（既存 DB を sqlite3 で検証して確認）。

## 2. 変更ファイル一覧

```
 package-lock.json                            |   4 +-
 skills/cmux-team/manager/i18n.ts             |  80 ++++++++++
 skills/cmux-team/manager/main.test.ts        | 230 ++++++++++++++++++++++++++-
 skills/cmux-team/manager/main.ts             | 191 +++++++++++++++++++++-
 skills/cmux-team/manager/schema.test.ts      | 149 +++++++++++++++++
 skills/cmux-team/manager/schema.ts           |  47 ++++++
 skills/cmux-team/manager/trace-store.test.ts | 175 ++++++++++++++++++++
 skills/cmux-team/manager/trace-store.ts      | 203 ++++++++++++++++++++++-
 8 files changed, 1066 insertions(+), 13 deletions(-)

新規:
  skills/cmux-team/manager/metrics-aggregate.test.ts
  skills/cmux-team/manager/metrics-aggregate.ts
  skills/cmux-team/manager/metrics-cli.test.ts
  skills/cmux-team/manager/metrics-cli.ts
```

## 3. 各 Step の実施結果

| Step | 内容 | 結果 |
|---|---|---|
| 1 | hook_signals に session_id / tool_name 列 + index 追加 | ✓ |
| 2 | PRE_TOOL_USE / POST_TOOL_USE / PRE_TOOL_USE_DENIED schema 追加 | ✓ |
| 3 | buildMessageFromHookInput に 3 type 分岐追加 + 1KB truncate | ✓ |
| 4 | insertHookSignal に session_id / tool_name 列を埋める | ✓ |
| 5 | Master / Conductor / Agent settings に PreToolUse / PostToolUse hook を追加 | ✓ |
| 6 | PRE_TOOL_USE_HOOK_SCRIPT に PRE_TOOL_USE_DENIED 通知 1 行追加 + cmdSend に case 追加 | ✓ |
| 7 | metrics-aggregate.ts 純粋関数群（lifecycle / period / per-task / per-bucket / stddev） | ✓ |
| 8 | metrics-cli.ts CLI ラッパー（json/text/csv × task/day/week） | ✓ |
| 9 | main.ts dispatcher に metrics 登録 + cmdMetrics + i18n 拡張 | ✓ |
| 10 | e2e 動作確認（実 events.jsonl + 実 traces.db） | ✓ |
| 11 | typecheck + summary.md 出力 | ✓ |

## 4. テスト結果

すべて個別ファイル単位で実行（CLAUDE.md の禁忌「`bun test` 全体実行」を遵守）。

```
metrics-aggregate.test.ts:  18 pass / 0 fail / 53 expect() calls
metrics-cli.test.ts:        16 pass / 0 fail / 33 expect() calls
schema.test.ts:             52 pass / 0 fail / 72 expect() calls
trace-store.test.ts:        38 pass / 0 fail / 234 expect() calls
trace-store-metrics.test.ts: 14 pass / 0 fail / 35 expect() calls
events-cli.test.ts:         19 pass / 0 fail / 93 expect() calls
main.test.ts:               213 pass / 0 fail / 590 expect() calls
daemon.test.ts:             187 pass / 0 fail / 667 expect() calls
dashboard-metrics.test.tsx:  39 pass / 0 fail / 85 expect() calls
classify-stop.test.ts:      16 pass / 0 fail / 23 expect() calls
```

新規追加テスト:
- T379 schema test: 17 ケース
- T379 buildMessageFromHookInput test: 6 ケース
- T379 settings test (Master/Conductor/Agent + Bash deny block): 9 ケース
- T379 hook_signals migration / insert test: 6 ケース
- T379 metrics-aggregate (lifecycle / period / per-task / per-bucket / stddev): 18 ケース
- T379 metrics-cli (parse / format / csv): 16 ケース

## 5. Recommendation 1: hook 発火レイテンシ実測の結果

### 5.1 現時点の baseline 測定（直近 1 時間）

```sql
SELECT type, COUNT(*) AS n,
       (julianday(MAX(timestamp)) - julianday(MIN(timestamp))) * 86400 AS span_sec
FROM hook_signals
WHERE timestamp > datetime('now', '-1 hour')
  AND type IN ('PRE_TOOL_USE','POST_TOOL_USE','PRE_TOOL_USE_DENIED')
GROUP BY type;
```

実行結果: **0 行**（PRE_TOOL_USE / POST_TOOL_USE / PRE_TOOL_USE_DENIED の hook_signals 行はまだ書き込まれていない）

### 5.2 解釈

本タスクで Master / Conductor / Agent の settings に新 hook を追加したが、これらは `cmux-team start` を再起動してテンプレートから settings.json を再生成しないと有効化されない。本リポジトリは現時点ではまだ旧 settings で稼働しているため、`hook_signals` テーブルに PRE_TOOL_USE / POST_TOOL_USE 行は 1 件も無い。

→ **本タスク内で実測するのは不可能**。`cmux-team start` でテンプレート再生成 → 1 タスク以上の実運用後に上記 SQL を再実行して、1 task あたりの累積 span_sec が 5s を超えるかを判定する必要がある。

### 5.3 5s 超過時の対応方針（別タスク化提案）

実測値が 1 task 累積 5s を超えるようなら、以下を別タスクで検討する:

1. **shell wrapper 短縮**: 現在の `bash -c 'cmux-team send PRE_TOOL_USE --from-stdin --surface ... --pid ... --role ... 2>/dev/null || true'` の起動コストが累積する。bun スタートアップ時間 (~50ms) × 数百回発火 ≈ 10〜30 秒。`cmux-team send` を proxy 経由で daemon に直接 IPC するよう変更する案。
2. **matcher 絞り込み**: PostToolUse の matcher を `"Edit|Write|Bash|Read"` 等に絞って、観察対象を必要なツールに限定する。
3. **timeout 調整**: 現在 3000ms に設定済み（claude のレスポンスに直接乗るので短め）。これを 1000ms に引き締めて、daemon 過負荷時の総遅延を減らす。

### 5.4 実運用 1 タスク後の再測定スクリプト

```bash
sqlite3 .team/traces/traces.db "
  SELECT type, COUNT(*) AS n,
         (julianday(MAX(timestamp)) - julianday(MIN(timestamp))) * 86400 AS span_sec
  FROM hook_signals
  WHERE timestamp > datetime('now', '-1 hour')
    AND type IN ('PRE_TOOL_USE','POST_TOOL_USE','PRE_TOOL_USE_DENIED')
  GROUP BY type"
```

結果が **1 task あたり累積 5s を超える** ようなら、上記 §5.3 案を別タスク化して対応する（本タスクには含めない方針 / design-review Recommendation 1）。

## 6. typecheck 結果

```bash
bunx tsc --noEmit
```

→ **エラー 0 件**。新規 / 既存ともに型エラーなし（baseline と完全一致）。

## 7. e2e 動作確認

実 `.team/logs/events.jsonl` + `.team/traces/traces.db`（2026-04-24 〜 2026-05-01 の 7 日分）で動作確認:

```bash
PROJECT_ROOT=/Users/yamamoto/git/cmux-team \
  bun run skills/cmux-team/manager/main.ts metrics --since 30d --format json | head -100
```

→ T359 / T379 / T392 / T393 / T394 / T396 / T397 / T398 / T400 / T401 が per-task で正しく集計され、outcome / assigned_ts / closed_ts / duration_ms が正常値を返した。

```bash
... metrics --since 30d --group-by week --format json
... metrics --since 30d --format text
... metrics --since 30d --format csv
... metrics --task-id 392 --format json
```

→ 全 format / 全 group-by で正常出力。

> 補足: `tool_calls` および `tokens` が現状 0 になるのは、(a) 新 hook がまだ稼働していない（PRE_TOOL_USE / POST_TOOL_USE 行が DB に無い）、(b) api_usage の task_id が NULL のまま記録されている（proxy.ts の解決失敗、または T305 後の運用設定差異）— のいずれも本タスクのスコープ外。集計関数自体は in-memory fixture で正しく動作することを `metrics-aggregate.test.ts` で網羅している。

## 8. Done 判定の確認

- [x] `cmux-team metrics --since 7d --format json` が動作し per-task 集計を返す
- [x] hook_signals に必要フィールドが揃っている（session_id / tool_name 列追加 + 旧 DB 互換 ALTER TABLE migration）
- [x] bun test 既存 suite 全 pass（個別ファイル単位）
- [x] design-review Recommendation 1〜5 がすべて反映されている
- [x] typecheck 新規エラー 0 件

## 9. 残課題 / 既知の制約

1. **Recommendation 1 の実測は本タスクでは未完了**。`cmux-team start` で新 settings を反映させて 1 タスク以上運用したあとに §5.4 のスクリプトで再測定する必要がある（5s 超過時のみ別タスク化）。
2. **api_usage の task_id 解決**: 既存 DB の api_usage 行は task_id が全件 NULL（12,583 行 / 7 日分）。これは proxy.ts の task_id 解決ロジックが動いていないか、本リポジトリ運用の特定設定によるもの。tokens 集計が常に 0 になるが、本タスクの集計ロジックは正しい（fixture テストで検証済み）。→ **T403 として別タスク起票済み** (`metrics: api_usage の task_id 解決の調査・修正`、status: draft)。
3. **DB 肥大対策（GC）は未実装**。CLAUDE.md の既知の注意点に従い別タスク。`hook_signals` 行数が 100k を超えたら手動 DELETE で対応。
4. **NOTIFICATION 既存行の session_id バックフィル**は本タスクではしない（plan.md §3.3 / design-review Approved Items に従う）。必要なら別タスクで `UPDATE hook_signals SET session_id = json_extract(payload_json, '$.session_id') WHERE type='NOTIFICATION' AND session_id IS NULL` を 1 回実行する。
5. **task_sessions の event 名前**: plan.md / design-review は `'session_started'` と書いていたが、実 DB の対応は `event = 'assigned'`（task_sessions テーブルは `assigned / agent_spawned / closed / aborted` の 4 値のみ）。SQL とテストの両方で修正済み。docs/spec/ 側に同名の誤記があれば docs-sync で別タスク対応。
6. **dashboard 統合は未実装**（plan.md §8 / design-review Approved Items の方針通り、CLI 出力のみで本タスク完結）。
