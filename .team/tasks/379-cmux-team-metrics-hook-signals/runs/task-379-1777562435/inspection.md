# T379 Inspection

Verdict: GO

## Summary

`cmux-team metrics` サブコマンド + `hook_signals` 棚卸しの実装は、Done 判定 / design-review Recommendations 1〜5 / 必須機能要件 / 非機能要件のすべてを満たしている。実 DB に対する CLI 動作確認 (json/text/csv × task/day/week)、in-memory fixture によるユニットテスト 612 件、`bunx tsc --noEmit` のエラー 0 件、責務分離 (CLI / aggregate / SQL) と既存パターン (events-cli) の踏襲が確認できた。指摘は minor 2 件のみで、blocker はない。

## Done 判定の確認 (タスク本文 .team/tasks/379-.../task.md L52-57)

- ✓ `cmux-team metrics --since 7d --format json` が動作し per-task 集計を返す
  - 実行確認: `bun run skills/cmux-team/manager/main.ts metrics --since 7d --format json | jq '. | length'` → 10、`jq .` で valid JSON。`task_id / assigned_ts / closed_ts / duration_ms / outcome / tool_calls / tool_call_total / tool_failure_rate / time_to_first_edit_ms / tokens` の per-task object 配列が返る。
- ✓ hook_signals に必要フィールドが揃っている (場合により追記)
  - 実 DB (`/Users/yamamoto/git/cmux-team/.team/traces/traces.db`) に対し ALTER TABLE migration が走り、`session_id` (列 18) / `tool_name` (列 19) が追加されている。`idx_hook_signals_session_id` / `idx_hook_signals_tool_name` も作成済み。
  - PRE_TOOL_USE / POST_TOOL_USE / PRE_TOOL_USE_DENIED の zod schema を `schema.ts:189-219` で定義、`QueueMessage` discriminated union にも組み込み済み。
  - hook 受信側 (`buildMessageFromHookInput`) で `tool_response.content` を 1KB に切り詰める処理を確認 (main.test.ts:1701)。
- ✓ bun test 既存 suite 全 pass (個別ファイル単位)
  - 実行ファイルと結果: metrics-aggregate (18), metrics-cli (16), schema (52), trace-store (38), trace-store-metrics (14), main (213), events-cli (19), daemon (187), dashboard-metrics (39), classify-stop (16) — **全 pass / 0 fail**。
- ✓ T358-T359 が前提 (T359 は recent commit `cdbd992` で merged)。

## Recommendation 反映の確認 (design-review.md §Recommendations)

- ✓ Recommendation 1 (hook 発火レイテンシ実測)
  - 新 hook がリリース前のため実測は不可能 (`hook_signals` に PRE_TOOL_USE/POST_TOOL_USE 行 0 件) 、summary.md §5 に「実運用 1 task 後に 5s 累積を超えたら別タスク化」の判定基準と再測定 SQL が記載されている。design-review が許容する「測定方針記載で OK」の要件を満たす。
- ✓ Recommendation 2 (settings テストの role アサーション + filter 取得)
  - `main.test.ts:2191-2281` で Master / Conductor / Agent それぞれについて `blocks.find((b) => b.matcher === "")` で観察 hook ブロックを取得し、`cmd.toContain("--role <role>")` をアサート。Conductor の Bash deny ブロックは `b.matcher === "Bash"` で別取得。index アクセスではなく filter 取得方式 ✓。
- ✓ Recommendation 3 (countToolCallsByTask SQL の session_id 重複対策)
  - `trace-store.ts:1179, 1220, 1258` の 3 関数 (`countToolCallsByTask` / `firstEditPerTask` / `failureRateByTask`) すべてに `WITH session_to_task AS (SELECT session_id, MIN(task_id) AS task_id FROM task_sessions WHERE event='assigned' GROUP BY session_id)` の CTE が適用されている。同 session_id × 2 行 fixture のテストも `trace-store-metrics.test.ts` で網羅。
  - 注: plan/design-review の `event='session_started'` は実 DB の対応値ではなく、`event='assigned'` が正しい (task_sessions テーブルの実態)。summary.md §1.6 で経緯を明記し、SQL とテスト両方で修正済み。
- ✓ Recommendation 4 (Step 2 で PreToolUseDeniedMessage も同時 schema 化)
  - `schema.ts:208-219` で `PreToolUseDeniedMessage` を `PreToolUseMessage` / `PostToolUseMessage` と同時に定義し、`QueueMessage` discriminated union L237 に組み込み済み。Step 6 は Bash script への 1 行追加のみに収束。
- ✓ Recommendation 5 (help_metrics に "hook block 率は Bash deny rate" 明記)
  - `i18n.ts:617-620` (en) と L1504-1507 (ja) の両方で「現状これは Conductor の Bash deny script (cmux send/send-key の block) のみを数えており、汎用的な hook block 率ではない」と明示。

## 機能要件のサンプリング検証

| Option | コマンド | 結果 |
|---|---|---|
| `--since 7d --format json` | per-task 配列 10 件、jq valid | ✓ |
| `--since 30d --group-by week --format json` | bucket "2026-04-27" 1 件 (mean/stddev/completion_rate 込み) | ✓ |
| `--since 30d --format text` | `task_id=X outcome=Y ...` 形式 1 行/task | ✓ |
| `--since 30d --format csv` | RFC 4180 ヘッダー + データ行 | ✓ |
| `--task-id 379` | 単一タスクの object 1 件 | ✓ |
| `--since 7d --group-by day` | `bucket=2026-04-30, tasks_assigned=10, completion_rate=0.9, ...` | ✓ |

集計指標 (タスク本文の最低要件) のカバレッジ:

| 指標 | 出力 field | 確認 |
|---|---|---|
| 完了時間 | `duration_ms` | ✓ |
| abort 率 | `abort_rate` (per-bucket) | ✓ |
| Read/Grep/Edit/Bash call 数 | `tool_calls.{Read,Grep,Edit,Bash}` (per-task) | ✓ |
| token 消費 | `tokens.{input,output,cache,requests}` | ✓ |
| time-to-first-Edit | `time_to_first_edit_ms` | ✓ |
| tool call 失敗率 | `tool_failure_rate` | ✓ |
| hook block 率 | `deny_rate` (per-bucket) | ✓ |
| forced close 率 | `forced_close_rate` | ✓ |
| task 完了率 | `completion_rate` | ✓ |
| tool call 数の std | `tool_call_stddev` (per-bucket) | ✓ |

## 非機能要件チェック

- ✓ **後方互換性**: 既存の hook_signals データは ALTER TABLE migration 後も触られず、`session_id`/`tool_name` 専用列が NULL のまま残る。`events-cli.test.ts` (19) / `dashboard-metrics.test.tsx` (39) / `daemon.test.ts` (187) すべて pass。idempotent migration テストも `trace-store.test.ts` 内に存在。
- ✓ **コーディング規約**:
  - logger.ts → eventBus.ts 循環依存なし
  - `bus.emit` / `bus.on` 直接呼び出しの新規追加なし
  - `taskState[id] = ...` / `saveTaskState(` の直接 mutation 新規追加なし (main.ts の既存 read アクセスのみ)
  - cmux `tree(workspace)` の workspace 省略なし
- ✓ **設計の一貫性**:
  - `metrics-cli.ts` は `events-cli.ts` と同パターン (`runMetricsCli({ args, projectRoot, stdout, stderr, abortSignal }): Promise<number>` を export、`parseSince` は events-cli から import 流用) — DRY 維持
  - 責務分離 (CLI / aggregate / SQL) が plan.md §4.1 通り (metrics-cli ↔ metrics-aggregate ↔ trace-store)
- ✓ **SQL injection**: T379 で追加された 3 つの `db.prepare(...)` はすべて名前付き placeholder (`$type`, `$sinceIso`, `$untilIso`) でバインド。文字列連結 SQL なし。

## Findings

### blocker

- なし

### major

- なし

### minor

1. **空 catch {} が新規コードに 4 件混入** (CLAUDE.md「空の catch {} 禁止」)
   - `metrics-aggregate.test.ts:55,215,397` (test cleanup の `rm` / `db.close`)
   - `metrics-cli.ts:322` (`try { db.close(); } catch {}`)
   - `trace-store.ts` migration の `try { migratedDb?.close(); } catch {}`
   - 影響: テスト cleanup と DB close の決定論的 swallow なので機能影響は無いが、ガードレールの文言通りに従えば warn-only でも logger に出すべき。後続タスクで `console.warn` 等に置き換える程度で十分。

2. **api_usage の task_id 解決が動作せず tokens 集計が常に 0**
   - 現状の本リポ `.team/traces/traces.db` の api_usage 行は task_id 全件 NULL (summary.md §9 で言及)。集計ロジック自体は fixture テストで正しく動作するため本タスクのスコープ外。proxy.ts の task_id 解決ロジック調査は別タスク化推奨。

3. **新 PreToolUse / PostToolUse hook はリリース前のため実 DB に行が無い**
   - `cmux-team start` でテンプレート再生成 → 1 タスク以上の実運用後に hook レイテンシ・row 数の実測が必要 (summary.md §5.4 のスクリプト)。本タスクは「測定方針記載」までの完了で OK。

## Approved Items (このまま納品して良い部分)

- `metrics-aggregate.ts` / `metrics-cli.ts` の純粋関数 + thin wrapper 構成 (events-cli パターン踏襲)
- `trace-store.ts` の `ensureHookSignalsColumns` 拡張 (session_id / tool_name 列 + index、idempotent migration)
- `trace-store.ts` の集計 SQL 群 (countToolCallsByTask / firstEditPerTask / failureRateByTask / denyRateByPeriod) と `WITH session_to_task` CTE
- `schema.ts` の PreToolUse / PostToolUse / PreToolUseDeniedMessage の 3 schema (discriminated union 組み込み済み)
- `main.ts` の `buildMessageFromHookInput` 分岐 (PRE_TOOL_USE / POST_TOOL_USE / PRE_TOOL_USE_DENIED + 1KB truncate)
- `main.ts` の Master / Conductor / Agent settings 生成 (matcher: "" 観察 hook + Conductor 既存 deny ブロックとの並列共存)
- `main.ts` dispatcher の `case "metrics"` 登録 + `cmdMetrics()` (events と同型)
- `i18n.ts` の `help_metrics` ja/en (Bash deny rate の意味明記)
- 個別ファイル単位のテスト群 (T379 で追加された 72 ケースを含む計 612 件)
- summary.md §5 の hook レイテンシ実測の判定基準 + 再測定 SQL
- task-state を mutate しない / dashboard 統合は別タスク化、という設計判断

以上、実装は計画書 / 設計レビュー / Done 判定をすべて満たしており、minor 指摘 (空 catch {} 4 件) は blocker ではない。**Verdict: GO**。
