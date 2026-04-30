# 11. Metrics

> `cmux-team metrics` サブコマンド（T379）の集計ロジックと CodeDNA 評価判定基準の SSOT。
> 実装の根本は `skills/cmux-team/manager/metrics-aggregate.ts`（417 行）。本 spec はそれと整合する文書化である。

---

## 1. 概要

本 spec は以下の 3 用途を持つ:

- **metric の SSOT**: 「何を測るか / どう計算するか」の単一情報源。CLI 出力・解釈・評価判定はすべてここから派生する。
- **CodeDNA 評価の事前合意点**: baseline 計測後の「介入の良し悪し」判定が後付け解釈にならないよう、軸・閾値・統計検定を事前確定する。
- **撤退判断の基準**: 副作用系 metric の悪化を検出したら撤退（§4.4）。

主な利用者:

| 利用者 | 用途 |
|---|---|
| Master | `cmux-team metrics` で task lifecycle / tool call / token を観測 |
| Implementer | 介入前後の baseline 比較（cohort comparison） |
| Reviewer | 撤退判断（副作用系 metric の閾値超過チェック） |

### 1.1 SSOT は CLI 側、dashboard は別系統 UI ビルダー

本 spec が扱う metric の SSOT は **CLI 側**（`metrics-aggregate.ts` + `metrics-cli.ts`）である。

`skills/cmux-team/manager/dashboard-metrics.ts` は同じ `trace-store.ts` の SQL（`aggregateApiUsageByRole` / `aggregateApiUsageByTask` 等）を呼ぶ別系統の UI ビルダーで、CLI と互換する数値を Manager dashboard の Metrics タブに表示する。両モジュールの責務分担は各冒頭コメントを参照。

### 1.2 軸構成（5 軸 → 6 軸）

タスク本文（T380）には「5 軸」と書かれているが、ユーザー確定で **6 軸**（俯瞰系を追加）が正。本 spec は 6 軸を採用する。タスク本文との差分はラベルのみで、実装上の影響はない。

---

## 2. Metrics taxonomy（6 軸）

各軸ごとに以下の列を持つ表を置く:

- **metric**: コード上の symbol または taxonomy 上の名称
- **定義**: 何を表す指標か
- **計算式**: 実装上の式（aggregate.ts に従う）
- **data source**: events.jsonl / hook_signals / api_usage / git log
- **SQL or jq 例**: 取得手段の例
- **警報閾値（暫定）**: **[暫定] baseline 計測前 — 業界経験則ベース**。baseline 取得後の commit で更新する
- **実装ステータス**: `実装済み` または `taxonomy 上定義のみ`

凡例:
- ◎ = T379 で実装済み
- ○ = 本 spec で taxonomy 定義のみ・実装は将来タスク

### 2.1 探索コスト系

「正解にたどり着くまでに無駄に探した量」を測る。

| metric | 定義 | 計算式 | data source | SQL or jq 例 | 警報閾値（暫定） | 実装ステータス |
|---|---|---|---|---|---|---|
| `tool_calls.Read` | task 内の Read 呼び出し回数 | `countToolCallsByTask` の Read 行 (`PRE_TOOL_USE`) | hook_signals | `jq '.[].tool_calls.Read'` | `[暫定]` baseline + 50% で警報 | ◎ |
| `tool_calls.Grep` | task 内の Grep 呼び出し回数 | 同上の Grep 行 | hook_signals | `jq '.[].tool_calls.Grep'` | `[暫定]` baseline + 50% | ◎ |
| `tool_calls.Edit` | task 内の Edit 呼び出し回数 | 同上の Edit 行 | hook_signals | `jq '.[].tool_calls.Edit'` | （観測のみ） | ◎ |
| `tool_call_total` | 全 tool 呼び出しの合計 | `Object.values(tool_calls).reduce((a,b)=>a+b,0)`（`metrics-aggregate.ts:291`） | hook_signals | `jq '.[].tool_call_total'` | `[暫定]` baseline + 30% | ◎ |
| `time_to_first_edit_ms` | `task_assigned` から最初の `Edit` までの ms | `Date.parse(first_edit_ts) - Date.parse(assigned_ts)`（`metrics-aggregate.ts:296-299`） | hook_signals + events.jsonl | `jq '.[].time_to_first_edit_ms'` | `[暫定]` baseline + 100% | ◎ |
| `tool_failure_rate` | PostToolUse で `success=false` または `error≠null` の割合 | `failures / total`（total=0 のとき 0、`metrics-aggregate.ts:292-294`） | hook_signals | §3.2 の `failureRateByTask` SQL | `[暫定]` baseline + 0.10（絶対値） | ◎ |
| Read 失敗率 | Read のみの tool_failure_rate | （未実装） | hook_signals | — | — | ○ |
| Read/Edit 比 | Read 件数 ÷ Edit 件数（探索深度） | （未実装） | hook_signals | — | — | ○ |
| `tool_calls.Glob` | Glob 呼び出し回数 | （実装ありだが taxonomy 未定義） | hook_signals | `jq '.[].tool_calls.Glob'` | （観測のみ） | ◎ |

**注釈:**

- `tool_failure_rate` は POST_TOOL_USE の `success=false` / `error≠null` の率であり、deny script による事前 block ではない（後者は §2.2 制約違反系の `deny_rate`）。
- 探索コスト系の variance / 平均（`tool_call_stddev` / `duration_ms_mean` など）は §2.6 俯瞰系に集約する（軸の二重カウント回避）。

### 2.2 制約違反系

「事前ガードが何回 block したか」を測る。

| metric | 定義 | 計算式 | data source | SQL or jq 例 | 警報閾値（暫定） | 実装ステータス |
|---|---|---|---|---|---|---|
| `deny_rate` | bucket 期間内の `PRE_TOOL_USE_DENIED / PRE_TOOL_USE` 比 | `denied / pre_total`（`metrics-aggregate.ts:386` / `denyRateByPeriod` SQL） | hook_signals | §3.2 の `denyRateByPeriod` SQL | `[暫定]` baseline + 0.05（絶対値） | ◎ |
| lint / typecheck 失敗率 | PostToolUse の Bash で `bun run lint` 等の終了コードが非 0 だった率 | （未実装） | hook_signals | — | — | ○ |
| task reopen 率 | `restart-task` で `aborted → ready` に戻された task の比率 | （未実装） | events.jsonl | — | — | ○ |

**注意**: `deny_rate` は **Conductor の Bash deny script のみ**を集計対象とする（`help_metrics` および §6 Caveats を参照）。汎用的な PreToolUse exit-2 hook の block 率ではない。

### 2.3 連鎖破壊系

「ある変更がどこまで影響を波及させたか」を測る。

| metric | 定義 | 計算式 | data source | SQL or jq 例 | 警報閾値（暫定） | 実装ステータス |
|---|---|---|---|---|---|---|
| edit 後 dependent test 失敗率 | Edit を含む task の後続 Bash test 失敗率 | （未実装） | hook_signals | — | — | ○ |
| 後追い修正 commit 数 | 同 PR 内 fixup / amend commit count | （未実装） | git log | — | — | ○ |
| CI 失敗率 | PR check の failure ratio | （未実装） | git log + GH API | — | — | ○ |

### 2.4 知識引き継ぎ系

「同じ調査を何度繰り返したか」を測る。

| metric | 定義 | 計算式 | data source | SQL or jq 例 | 警報閾値（暫定） | 実装ステータス |
|---|---|---|---|---|---|---|
| 重複調査率 | 同 task 内の Researcher 起動回数 ÷ 生成 artifact 数 | （未実装） | hook_signals + `.team/artifacts/` | — | — | ○ |
| agent → rules promotion 率 | CLAUDE.md / `.team/agent-instructions/` の更新頻度 | （未実装） | git log | — | — | ○ |
| artifact 数の変化 | `.team/artifacts/Axxx-*.md` のデルタ件数 | （未実装） | filesystem | — | — | ○ |

### 2.5 副作用系

「介入が招いた望まない代償」を測る。撤退判定の中核（§4.4）。

| metric | 定義 | 計算式 | data source | SQL or jq 例 | 警報閾値（暫定） | 実装ステータス |
|---|---|---|---|---|---|---|
| `tokens.input` | per-task の input_tokens 合計 | `SUM(input_tokens)`（`aggregateApiUsageByTask` SQL） | api_usage | `jq '.[].tokens.input'` | `[暫定]` baseline + 30% | ◎ |
| `tokens.output` | per-task の output_tokens 合計 | `SUM(output_tokens)` | api_usage | `jq '.[].tokens.output'` | `[暫定]` baseline + 30% | ◎ |
| `tokens.cache` | per-task の cache_creation + cache_read 合計 | `SUM(cache_creation_input_tokens) + SUM(cache_read_input_tokens)`（`trace-store.ts:1129`） | api_usage | `jq '.[].tokens.cache'` | `[暫定]` baseline + 50% | ◎ |
| `tokens.requests` | per-task の API リクエスト件数 | `COUNT(*)` from api_usage | api_usage | `jq '.[].tokens.requests'` | `[暫定]` baseline + 30% | ◎ |
| `tokens_total.{input,output,cache}` | per-bucket の token 合計 | per-task を bucket 内で `reduce` | api_usage | `jq '.[].tokens_total'` | `[暫定]` baseline + 30% | ◎ |
| header 自体の token cost | `{{COMMON_HEADER}}` 等が message に占める tokens | （未実装） | api_usage + template diff | — | — | ○ |
| refresh 失敗率 | proxy / token refresh の失敗率 | （未実装） | api_usage（status_code） | — | — | ○ |
| header rot 率 | header と運用の乖離度（agent 命令違反率の代理） | （未実装） | hook_signals | — | — | ○ |
| agent message GC 累積行数 | sub-agent message 履歴の累積 token | （未実装） | api_usage | — | — | ○ |

### 2.6 俯瞰系

軸横断の総量・分布。探索コスト系・副作用系の variance / 平均はここに集約する。

| metric | 定義 | 計算式 | data source | SQL or jq 例 | 警報閾値（暫定） | 実装ステータス |
|---|---|---|---|---|---|---|
| `duration_ms` | task assigned → terminal の所要時間 | `Date.parse(closed_ts) - Date.parse(assigned_ts)`（`metrics-aggregate.ts:197-200`） | events.jsonl | `jq '.[].duration_ms'` | `[暫定]` baseline + 50% | ◎ |
| `duration_ms_mean` / `duration_ms_stddev` | per-bucket の所要時間 平均 / 母集団 stddev | `mean(durations)` / `stddev(durations)`（`metrics-aggregate.ts:96-102`） | events.jsonl | `jq '.[].duration_ms_mean'` | `[暫定]` mean × 1.5 | ◎ |
| `completion_rate` | bucket 内の `tasks_completed / tasks_assigned` | `metrics-aggregate.ts:393` | events.jsonl | `jq '.[].completion_rate'` | `[暫定]` baseline − 0.10（絶対値） | ◎ |
| `abort_rate` | bucket 内の `tasks_aborted / tasks_assigned` | `metrics-aggregate.ts:394` | events.jsonl | `jq '.[].abort_rate'` | `[暫定]` baseline + 0.10 | ◎ |
| `forced_close_rate` | bucket 内の `forced_close / tasks_assigned` | `metrics-aggregate.ts:395` | events.jsonl | `jq '.[].forced_close_rate'` | `[暫定]` baseline + 0.05 | ◎ |
| `tool_call_stddev` | bucket 内の `tool_call_total` の母集団 stddev | `stddev(toolTotals)`（`metrics-aggregate.ts:398`） | hook_signals | `jq '.[].tool_call_stddev'` | （観測のみ） | ◎ |
| `tasks_completed` / `tasks_aborted` | bucket 内の終端カウント | filter + length | events.jsonl | `jq '.[].tasks_completed'` | （観測のみ） | ◎ |
| state_mismatch 率（per-bucket） | bucket 内の `state_mismatch / tasks_assigned`（`PeriodSummary` には実装済み、`PerBucketMetrics` は未） | （部分実装） | events.jsonl | — | — | ○ |

**注**: `stddev` は母集団標準偏差（`metrics-aggregate.ts:96-102`）。空配列は 0 を返す。

---

## 3. Data sources

`cmux-team metrics` の集計は以下 4 系統から成る。

### 3.1 events.jsonl（task lifecycle）

`.team/logs/events.jsonl`（schema 詳細は [`10-events-stream.md`](10-events-stream.md)）。本 spec は集計上 **5 種** の event のみを使用する:

- `task_assigned` — task lifecycle の起点（`assigned_ts`）
- terminal 4 種（`metrics-aggregate.ts:113-118` の `TERMINAL_EVENTS` set と一致）:
  - `task_completed` → outcome=`completed`
  - `task_completed_state_mismatch` → outcome=`state_mismatch`
  - `task_aborted` → outcome=`aborted`
  - `conductor_disconnect_timeout` → outcome=`forced_close`

1 task が複数 terminal を持つ場合は **最新** を採用（`metrics-aggregate.ts:174-181`）。`since` フィルタは:

- terminal を持つタスク: `terminal_ts >= since`
- open のタスク: `assigned_ts >= since`

の OR で判定する（`metrics-aggregate.ts:202-206`）。

### 3.2 hook_signals テーブル（tool call）

`.team/traces/traces.db` の `hook_signals` テーブル。スキーマ全 20 列は `trace-store.ts:138-159`。集計に使う `type` は **3 種のみ**:

- `PRE_TOOL_USE` — `tool_call_total` / per-tool count / `time_to_first_edit_ms` / `denyRateByPeriod` の母数
- `POST_TOOL_USE` — `tool_failure_rate` の母集団
- `PRE_TOOL_USE_DENIED` — `deny_rate` の分子

代表的な集計 SQL（`trace-store.ts`）:

| 関数 | 行 | 役割 |
|---|---|---|
| `countToolCallsByTask` | 1173-1200 | tool_calls の per-task × tool_name 集計 |
| `firstEditPerTask` | 1215-1239 | `MIN(timestamp) WHERE tool_name='Edit'` |
| `failureRateByTask` | 1253-1286 | `JSON_EXTRACT(payload_json,'$.payload.tool_response.success')=0 OR ...error IS NOT NULL` の集計 |
| `denyRateByPeriod` | 1299-1318 | bucket 範囲ごとに `PRE_TOOL_USE_DENIED / PRE_TOOL_USE` を再集計 |

> `deny_rate` は **bucket ごとの time range で `denyRateByPeriod` を呼び直す**（`metrics-aggregate.ts:380-386`）。期間全体の deny_rate を全 bucket に同じ値で配布しない。

### 3.3 api_usage テーブル（token 消費）

`api_usage` テーブル（DDL は `trace-store.ts:163-192`）。集計に使う列:

- `input_tokens` / `output_tokens` / `cache_creation_input_tokens` / `cache_read_input_tokens`
- `task_id`（`task_id IS NOT NULL` 行のみが per-task 集計対象）

集計 SQL は `aggregateApiUsageByTask`（`trace-store.ts:1119-1143`）。`tokens.cache` は `cache_creation_input_tokens + cache_read_input_tokens` の和を 1 列にまとめる（同 1129 行）。

### 3.4 git log（補助）

連鎖破壊系（§2.3）の「後追い修正 commit 数」「CI 失敗率」は git log + GitHub API を data source とする想定だが、本 spec の範囲では **未実装**。後続タスクで集計関数を追加する。

### 3.5 join key と `session_to_task` CTE

hook_signals は `session_id` を持つが `task_id` を持たない。一方 api_usage は `task_id` を直接持つ。両者を統一して per-task 集計するため `task_sessions` テーブル（DDL: `trace-store.ts:121-134`）の `event='assigned'` 行で `session_id → task_id` を解決する。

`task_sessions` は同 `session_id` に対し複数行を持ちうる（resume / clear で append される）ため、`MIN(task_id) GROUP BY session_id` で 1:1 に集約してから JOIN する。これがないと 2 行 hit で tool 件数が二重カウントされる。

`session_to_task` CTE 全文（`trace-store.ts:1179-1184` から逐語コピー）:

```sql
WITH session_to_task AS (
  SELECT session_id, MIN(task_id) AS task_id
  FROM task_sessions
  WHERE event = 'assigned' AND task_id IS NOT NULL
  GROUP BY session_id
)
```

> **脚注**: 同一の `session_to_task` CTE は `countToolCallsByTask` / `firstEditPerTask` / `failureRateByTask` の **3 関数に複製**されている（`trace-store.ts:1179-1184` / `1220-1225` / `1258-1263`）。後続タスクで共通化候補だが、本 spec の範囲では事実として記録するに留める。

`task_id IS NULL`（unattached）の hook はこの CTE で除外される。task_assigned 前に発火した hook（session_started 未到達）は `task_sessions` に行が無いため LEFT JOIN 結果が NULL となり、`countToolCallsByTask` は `task_id=null` のまま残し、`firstEditPerTask` / `failureRateByTask` の per-task 集計からは除外される。詳細は §6 Caveats。

---

## 4. CodeDNA 評価判定基準

CodeDNA 採用評価は「介入前 baseline」と「介入後 evaluation」の 2 cohort を統計検定で比較する。

### 4.1 baseline period / evaluation period の定義

| 用語 | 定義 |
|---|---|
| baseline period | 介入導入前の連続 N day。CodeDNA 評価の比較基準点となる metric 観測期間 |
| evaluation period | 介入導入後の連続 N day。baseline と統計検定で比較する観測期間 |

**N の暫定値**: `N = 14 day`

**根拠**: cohort 内 task 数 30+ を確保しやすい短期境界として暫定設定。タスク発生密度（直近 1 週間で T370 番台 → T380 程度の進行ペース）から、14 day で 30+ task を見込める。後続タスクで実測値を見て再評価する。

> **注釈**: baseline 計測前は撤退判定の閾値（§4.4）も「業界経験則ベース」の暫定値である。実測 baseline で update する。

### 4.2 cohort comparison の手順

1. 同一プロジェクト内の **subject-within** 比較（task ID 範囲で cohort tag を切る）
2. baseline cohort: 介入導入直前の task ID 範囲（例: T350〜T380）
3. evaluation cohort: 介入導入直後の task ID 範囲（例: T381〜T410）
4. 各 metric について cohort 平均・分布・stddev を比較
5. §4.3 の検定手順で有意差を判定
6. §4.4 の撤退判定に従って合否を決める

### 4.3 統計検定の選択

- **正規性検定**:
  - n < 30 → Shapiro-Wilk 検定で正規性を判定
  - n ≥ 30 → 中心極限定理（CLT）の仮定で正規性を許容（事前確定）
- **等分散性**: Levene 検定で判定。不等であれば Welch の t-test を採用（事前確定）
- **検定の選択フロー**:
  1. 正規性 OK & 等分散 OK → Student の t-test
  2. 正規性 OK & 等分散 NG → Welch の t-test
  3. 正規性 NG → Wilcoxon rank-sum 検定（順位ベース、分布形状に依存しない）

### 4.4 撤退判定

副作用系（§2.5）の **1 metric でも** 以下を満たすなら撤退する:

```
evaluation 平均 > baseline 平均 × (1 + threshold)  AND  adjusted p < 0.05
```

`threshold` は §2.5 の「警報閾値（暫定）」を用いる（例: `tokens.input` なら +30% → threshold=0.30）。

#### 多重比較補正

副作用系には `tokens.{input, output, cache, requests}` の 4 種が並ぶため、複数 metric を同時検定する場合の familywise α 膨張を補正する必要がある。例えば 4 metric を α=0.05 で個別検定すると実効的 false positive rate は約 18% に達する。

**推奨**: Benjamini-Hochberg 法（FDR 制御、adjusted p < 0.05 を判定基準）

**代替**: Bonferroni 法（厳格、α/N を判定基準。N は同時検定する metric 数）
- 例: 副作用系 4 metric なら α/N = 0.05 / 4 = **0.0125**
- 将来 metric が増えると N も変わるため、検定時に N を確定させる

> **暫定注釈**: 上記閾値はすべて **[暫定] baseline 計測前 — 業界経験則ベース**。N=14 day baseline 取得後の commit で実測値に基づき更新する。閾値レビュータスクは §7 関連 task 参照。

---

## 5. CLI からの取得例

`cmux-team metrics` の入出力契約は `metrics-cli.ts:29-36`（`RunMetricsCliOpts`）に定義。`--task-id` は `--group-by task`（既定）でのみ有効（`metrics-cli.ts:104-106`）。

### 5.1 per-task JSON

```bash
cmux-team metrics --since 7d --format json | jq '.[0] | keys'
```

期待出力（key 列挙、値は省略）:

```json
[
  "assigned_ts",
  "closed_ts",
  "duration_ms",
  "outcome",
  "task_id",
  "time_to_first_edit_ms",
  "tokens",
  "tool_call_total",
  "tool_calls",
  "tool_failure_rate"
]
```

実体は `PerTaskMetrics` interface（`metrics-aggregate.ts:40-56`）の配列。`tokens` は `{input, output, cache, requests}` の object。

### 5.2 per-day CSV

```bash
cmux-team metrics --group-by day --since 14d --format csv | head -2
```

期待出力（ヘッダー行のみ、`metrics-cli.ts:222-238` の `PER_BUCKET_HEADER` と一致）:

```csv
bucket,tasks_assigned,tasks_completed,tasks_aborted,completion_rate,abort_rate,forced_close_rate,deny_rate,tool_call_total,tool_call_stddev,duration_ms_mean,duration_ms_stddev,tokens_input,tokens_output,tokens_cache
```

ISO week は月曜起点（`metrics-aggregate.ts:340-350`）。day bucket は `YYYY-MM-DD`（UTC）。

### 5.3 per-task text

```bash
cmux-team metrics --task-id 379 --format text
```

期待出力（1 行 / 1 task、`metrics-cli.ts:124-144` の `formatTextPerTask` と一致）:

```text
task_id=379 outcome=completed assigned_ts=2026-04-30T03:30:50.123Z closed_ts=2026-04-30T05:14:22.456Z duration_ms=6212333 tool_call_total=82 tool_failure_rate=0.0488 time_to_first_edit_ms=85230 tokens_input=12345 tokens_output=6789 tokens_cache=23456 tokens_requests=120 tool_calls={"Read":12,"Edit":3,"Bash":5,"Grep":7}
```

> **text format の注**: `tool_calls` フィールドは object 型のため **JSON-encoded value** として 1 行内に埋め込まれる（`fmtTextValue` で `JSON.stringify` 後、空白等を含めば `JSON.stringify` で再 quote）。パース時は `tool_calls=` の後の `{...}` を `JSON.parse` する必要がある。

---

## 6. Caveats

`help_metrics`（`i18n.ts` の ja: `i18n.ts:1478-1514` / en: `i18n.ts:591-627`）からの転載 3 点:

1. **`deny_rate` は cmux-team の Bash deny 率であり汎用 hook block 率ではない**
   - 計算式: `(PRE_TOOL_USE_DENIED 件数) / (PRE_TOOL_USE 件数)`
   - 現状これは Conductor の Bash deny script（`cmux send` / `send-key` の block）のみを数えており、PreToolUse hook が exit 2 で deny したケースを網羅していない。
   - 「cmux-team の Bash deny 率」と読むべきで、汎用的な hook block 率ではない。

2. **`task_assigned` 前に発火した hook は集計外**
   - tool call と task の紐付けは `task_sessions.session_id` を `MIN(task_id) GROUP BY session_id` で集約して JOIN する（§3.5）。
   - `task_assigned` 前に発火した hook（`session_started` 未到達）は `task_sessions` に対応行が無いため、per-task 集計から除外される。

3. **`tool_response.content` は 1KB に切り詰め**
   - hook 受信時点で 1KB に truncate される（`HOOK_SIGNAL_PAYLOAD_LIMIT` 関連）。
   - `success` / `error` フラグは保持されるため `tool_failure_rate` の判定には影響しない。
   - 大きな tool 出力の本文を後追い解析することは（現状）できない。

---

## 7. 関連 spec / 関連 task

### 関連 spec

- [`10-events-stream.md`](10-events-stream.md) — events.jsonl schema（terminal 4 event の一次定義）
- [`09-token-pool.md`](09-token-pool.md) — api_usage / token pool（副作用系 metric の data source）
- [`glossary.md`](glossary.md) — 用語集（§11 Metrics 関連）

### 関連 task

- **T379** — `cmux-team metrics` サブコマンド + hook_signals 棚卸し（実装本体）
- **T380** — 本 spec（metrics 文書化）
- **T354** — dashboard Metrics タブ（`dashboard-metrics.ts`、CLI と互換数値の UI 表示）
- **T266** — hook_signals テーブル新設（data source の起点）
- **未起票（後続）**:
  - 連鎖破壊系（§2.3）metric の実装
  - 知識引き継ぎ系（§2.4）metric の実装
  - 副作用系（§2.5）の header rot / agent message GC metric の実装
  - baseline period 計測実施 + §2 警報閾値の実測値更新
  - `session_to_task` CTE の 3 関数共通化リファクタ（§3.5 脚注）
