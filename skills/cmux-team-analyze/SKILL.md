---
name: cmux-team-analyze
description: >
  cmux-team のメトリクス解析・cohort 比較・介入評価・複数 task 横断トレンド・
  trace DB 探索を DuckDB SQL で行うスキル。Triggers: 「メトリクス解析」
  「cohort 比較」「介入評価」「baseline 比較」「複数 task の傾向」「時系列 trend」
  「trace DB から〜」「DuckDB で〜」「§11 spec の SQL を実行」等の発言。
  per-task 履歴の分析は trace-task skill を使う（per-task 履歴 = trace-task /
  複数 task・時系列・cohort = 本 skill）。
---

# cmux-team-analyze: DuckDB によるメトリクス ad-hoc 解析

このスキルは `cmux-team metrics query` CLI（T412）を介して DuckDB ad-hoc SQL を
実行し、複数 task 横断・時系列・cohort 比較といった探索的解析を行う。

> CLI 本体: `cmux-team metrics query --sql '<SQL>'`（DuckDB 0.10+ が必要）
> 本 skill は recipe 集 + 利用可能 source の説明書。

## 1. 起動条件と棲み分け

| 用途 | 使うべき skill / CLI |
|------|--------------------|
| 単一 task の session 履歴を時系列で見る | `trace-task` skill |
| 単一 task の Conductor / Agent 出力を確認 | `trace-task` skill |
| 複数 task を横断した集計（per-task トレンド・分布） | **本 skill (cmux-team-analyze)** |
| baseline / evaluation 期間の cohort 比較 | **本 skill** + `cmux-team metrics compare` |
| 介入導入後の副作用検出（token 消費・forced_close 率） | **本 skill** |
| events.jsonl + traces.db を JOIN した分析 | **本 skill** |
| snapshot ファイルを跨ぐ per-task トレンド | **本 skill** |
| 既定 6 軸の集計表を出すだけ | `cmux-team metrics`（aggregate） |

> **判断軸**: 「1 タスクの中で何が起きたか」なら trace-task。「複数タスクで何が
> 起きているか」なら本 skill。

## 2. 利用可能な source

`cmux-team metrics query` 起動時に自動で attach される view / table:

| 名前 | 種別 | 由来 | 主な用途 |
|------|------|------|---------|
| `t.api_usage` | SQLite table | `.team/traces/traces.db` (READ_ONLY ATTACH) | token 消費、API 失敗、status code |
| `t.hook_signals` | SQLite table | 同上 | tool call、tool failure、deny、SESSION_STARTED marker |
| `t.task_sessions` | SQLite table | 同上 | session_id ↔ task_id の紐付け |
| `t.rate_limit_snapshots` | SQLite table | 同上 | proxy rate-limit の時系列 |
| `events` | DuckDB view | `.team/logs/events.jsonl` (`read_json` newline_delimited) | task lifecycle |
| `snapshots` | DuckDB view | `.team/metrics/snapshots/*.json` (1 行/file) | period サマリ |
| `snapshots_per_task` | DuckDB view | UNNEST(snapshots.per_task) を pre-join | per-task の時系列トレンド |

> 不在 source は stderr に warning を出して silent skip。fresh project でも
> `SELECT 1` のような単純クエリは通る。

### 2.1 hook_signals × task_sessions の JOIN idiom

`hook_signals` は `session_id` を持つが `task_id` を持たない。task_id へ紐付ける
には `task_sessions` を `MIN(task_id) GROUP BY session_id` で集約する
（spec §3.5）:

```sql
WITH session_to_task AS (
  SELECT session_id, MIN(task_id) AS task_id
  FROM t.task_sessions
  WHERE event IN ('assigned','agent_spawned')
    AND task_id IS NOT NULL
    AND session_id IS NOT NULL AND session_id != ''
  GROUP BY session_id
)
SELECT ...
FROM t.hook_signals h
LEFT JOIN session_to_task s2t
  ON h.session_id = s2t.session_id AND h.session_id != ''
WHERE ...
```

## 3. 共通ガイドライン

- 大きな `events.jsonl` / `t.hook_signals` を全件 scan しない。`WHERE timestamp >= '...'`
  で必ず時間範囲を絞る。
- DuckDB は read-only attach。`ATTACH` / `INSTALL` / `LOAD` を user SQL 内で再宣言しない。
- `--format` を選ぶときの目安: `table`（=既定, 人間用）/ `json`（jq に流す）/
  `csv` / `tsv`（spreadsheet 連携）。
- `--explain` で query plan を見ながら recipe を磨く。

---

# DuckDB Recipe Library

各 recipe は `<!-- recipe: <id> -->` コメントの直後に SQL を置く。コピペで
`cmux-team metrics query --sql '<RECIPE>'` に流せる形を保つ。

> **動作確認**: 各 recipe は実装フェーズで実 duckdb binary に対して 0 exit を
> 確認している（結果は task の implementer.md に記録）。

<!-- recipe: R1 -->
## R1. per-task token 集計（api_usage × task_sessions）

「直近 N task の token 消費」を per-task で見るための基礎集計。`t.api_usage`
は `task_id` を直接持つので JOIN は不要。outcome を `events` から拾う。

```sql
WITH closed AS (
  SELECT task_id,
         arg_max(event, ts) AS outcome_event,
         max(ts)             AS closed_ts
  FROM events
  WHERE event IN ('task_completed', 'task_completed_state_mismatch',
                  'task_aborted', 'conductor_disconnect_timeout')
  GROUP BY task_id
)
SELECT
  u.task_id,
  c.outcome_event AS outcome,
  c.closed_ts,
  SUM(u.input_tokens)                                                    AS tokens_input,
  SUM(u.output_tokens)                                                   AS tokens_output,
  SUM(u.cache_creation_input_tokens) + SUM(u.cache_read_input_tokens)    AS tokens_cache,
  COUNT(*)                                                               AS api_requests
FROM t.api_usage u
LEFT JOIN closed c USING (task_id)
WHERE u.task_id IS NOT NULL
GROUP BY u.task_id, c.outcome_event, c.closed_ts
ORDER BY tokens_input DESC
LIMIT 30;
```

<!-- recipe: R2 -->
## R2. cohort 抽出（baseline vs evaluation）

§8 の baseline / evaluation 期間の per-task metric を 1 つの SQL で 2 cohort に
分けて出す（per-task の変化を 1 行で並べたい時用）。

```sql
WITH baseline AS (
  SELECT 'baseline' AS cohort, *
  FROM snapshots_per_task
  WHERE snapshot_date BETWEEN '2026-05-04' AND '2026-05-31'
),
evalu AS (
  SELECT 'evaluation' AS cohort, *
  FROM snapshots_per_task
  WHERE snapshot_date BETWEEN '2026-06-15' AND '2026-07-12'
),
combined AS (
  SELECT * FROM baseline UNION ALL SELECT * FROM evalu
)
SELECT
  cohort,
  COUNT(*)                                  AS tasks_n,
  AVG(duration_ms)                          AS duration_ms_mean,
  AVG(tool_call_total)                      AS tool_call_mean,
  AVG(tool_failure_rate)                    AS tool_failure_rate_mean,
  AVG(tokens.input + tokens.output)         AS tokens_per_task_mean,
  COUNT(*) FILTER (WHERE outcome = 'completed')              AS completed,
  COUNT(*) FILTER (WHERE outcome = 'forced_close')           AS forced_close
FROM combined
GROUP BY cohort
ORDER BY cohort;
```

> 統計検定（Welch / Mann-Whitney / 2-prop z-test）が必要なら
> `cmux-team metrics compare --baseline ... --comparison ...` を併用する。
> 本 recipe は探索的に「差がありそうか」を見る用途。

<!-- recipe: R3 -->
## R3. forced_close 直前の hook_signals（原因絞り込み）

`conductor_disconnect_timeout` で閉じた task の直前 hook を時系列で並べる。
crash の根本原因（外部コマンド失敗・rate limit hit 等）の手がかりに。

```sql
WITH targets AS (
  SELECT task_id, MIN(ts) AS forced_at
  FROM events
  WHERE event = 'conductor_disconnect_timeout'
  GROUP BY task_id
),
session_to_task AS (
  SELECT session_id, MIN(task_id) AS task_id
  FROM t.task_sessions
  WHERE event IN ('assigned','agent_spawned')
    AND task_id IS NOT NULL
    AND session_id != ''
  GROUP BY session_id
)
SELECT
  t.task_id,
  h.timestamp,
  h.type,
  h.tool_name,
  SUBSTRING(h.payload_json, 1, 200) AS payload_head
FROM t.hook_signals h
JOIN session_to_task s2t ON h.session_id = s2t.session_id AND h.session_id != ''
JOIN targets t           ON s2t.task_id = t.task_id
WHERE CAST(h.timestamp AS TIMESTAMP) BETWEEN
  CAST(t.forced_at AS TIMESTAMP) - INTERVAL 5 MINUTE
  AND CAST(t.forced_at AS TIMESTAMP)
ORDER BY t.task_id, h.timestamp DESC
LIMIT 200;
```

<!-- recipe: R4 -->
## R4. tool_failure 連鎖検出（同 session 内の連続失敗）

PostToolUse で `success=false` が連続した区間を window 関数で抽出する。
3 連続以上の失敗は agent の loop / dead end の signal。

```sql
WITH failures AS (
  SELECT
    session_id,
    timestamp,
    tool_name,
    CASE WHEN type = 'POST_TOOL_USE'
      AND (
        json_extract(payload_json, '$.payload.tool_response.success') = 0
        OR json_extract(payload_json, '$.payload.tool_response.error') IS NOT NULL
      )
    THEN 1 ELSE 0 END AS is_failure
  FROM t.hook_signals
  WHERE type = 'POST_TOOL_USE'
    AND session_id != ''
    AND timestamp >= '2026-05-01'
    AND payload_json IS NOT NULL
    AND json_valid(payload_json)         -- malformed payload を skip（best-effort 原則）
),
runs AS (
  SELECT *,
    SUM(is_failure) OVER (
      PARTITION BY session_id
      ORDER BY timestamp
      ROWS BETWEEN 2 PRECEDING AND CURRENT ROW
    ) AS rolling_failures
  FROM failures
)
SELECT session_id, timestamp, tool_name, rolling_failures
FROM runs
WHERE rolling_failures >= 3
ORDER BY session_id, timestamp
LIMIT 100;
```

<!-- recipe: R5 -->
## R5. SESSION_STARTED の loaded_plugins / loaded_skills cohort filter

§3.5.2 で導入された SESSION_STARTED hook payload の `loadedPlugins` /
`loadedSkills` を cohort tag として使う。「特定 plugin が enabled な session
だけを母集団に絞る」ユースケース。

```sql
SELECT
  h.session_id,
  s2t.task_id,
  CASE
    WHEN json_type(h.payload_json, '$.loadedPlugins') = 'NULL' THEN 'unknown'
    WHEN json_type(h.payload_json, '$.loadedPlugins') IS NULL  THEN 'unknown'
    WHEN json_array_length(json_extract(h.payload_json, '$.loadedPlugins')) = 0 THEN 'empty'
    ELSE 'loaded'
  END AS plugin_state,
  json_extract(h.payload_json, '$.loadedPlugins') AS plugins,
  json_extract(h.payload_json, '$.loadedSkills')  AS skills
FROM t.hook_signals h
LEFT JOIN (
  SELECT session_id, MIN(task_id) AS task_id
  FROM t.task_sessions
  WHERE event IN ('assigned','agent_spawned') AND task_id IS NOT NULL AND session_id != ''
  GROUP BY session_id
) s2t ON h.session_id = s2t.session_id AND h.session_id != ''
WHERE h.type = 'SESSION_STARTED'
  AND h.timestamp >= '2026-05-01'
  AND json_valid(h.payload_json)         -- malformed payload を skip
ORDER BY h.timestamp DESC
LIMIT 200;
```

> 注意: cohort filter で `plugin_state = 'unknown'` の session を「plugin 無し
> cohort」に混ぜないこと（spec §3.5.2 注釈）。

<!-- recipe: R6 -->
## R6. per-day trend（snapshot から outcome 別件数）

snapshot 群を時系列で並べて outcome 別件数の trend を見る。
`snapshots_per_task` view に snapshot_date が pre-join されているので、
per-day trend は GROUP BY だけで済む。

```sql
SELECT
  snapshot_date,
  COUNT(*)                                         AS tasks_n,
  COUNT(*) FILTER (WHERE outcome = 'completed')    AS completed,
  COUNT(*) FILTER (WHERE outcome = 'aborted')      AS aborted,
  COUNT(*) FILTER (WHERE outcome = 'forced_close') AS forced_close,
  COUNT(*) FILTER (WHERE outcome = 'state_mismatch') AS state_mismatch,
  AVG(duration_ms)                                 AS duration_ms_mean,
  AVG(tool_call_total)                             AS tool_call_mean
FROM snapshots_per_task
WHERE snapshot_date >= '2026-05-01'
GROUP BY snapshot_date
ORDER BY snapshot_date;
```

## 4. 後続候補（recipe スタブ）

以下は本 skill には完成形 recipe を載せていないが、将来追加する候補。

- **R7. claim-vs-diff 検出**: agent の自己申告 outcome と git diff の差分から
  「completed と言いながら何も書いていない」「aborted なのに変更あり」等の
  semantic mismatch を抽出する。実装は semantic 解析が必要なため後続タスク扱い
  （T412 議論経緯参照）。
- **R8. duration_ms 異常 task の絞り込み**: per-task duration の Z-score で
  outlier を抽出。
- **R9. proxy rate-limit hit と forced_close の相関**: `t.rate_limit_snapshots`
  と `events` の forced_close を時系列 JOIN。

## 5. 関連 spec / 関連 CLI

- spec: [`docs/spec/11-metrics.md`](../../docs/spec/11-metrics.md) — Metrics taxonomy / data source / cohort 比較
- CLI:
  - `cmux-team metrics query` — DuckDB ad-hoc SQL（本 skill が直接利用）
  - `cmux-team metrics` — 既定 6 軸の per-task / per-period aggregate（事前定義）
  - `cmux-team metrics snapshot|compare|health` — 日次 snapshot / 統計検定 / 欠損確認
- 関連 skill:
  - `trace-task` — per-task の session 履歴分析（棲み分けは §1 参照）
