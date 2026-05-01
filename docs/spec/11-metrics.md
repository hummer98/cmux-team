# 11. Metrics

> `cmux-team metrics` サブコマンド（T379）の集計ロジックと CodeDNA 評価判定基準の SSOT。
> 実装の根本は `skills/cmux-team/manager/metrics-aggregate.ts`（417 行）。本 spec はそれと整合する文書化である。
>
> 日次 snapshot 自動収集と cohort 比較ツール（T381）の仕様は §7〜§13 に記載。

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

**注意**: `deny_rate` は **Conductor の Bash deny script のみ**を集計対象とする（`help_metrics` および §6 Caveats を参照）。汎用的な PreToolUse exit-2 hook の block 率ではない。`deny_rate` は per-task aggregate のみで集計され、daily snapshot / cohort 比較（§7〜§9）の対象には含めていない（fact として 1 日単位の比率が安定しないため）。

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

hook_signals は `session_id` を持つが `task_id` を持たない。一方 api_usage は `task_id` を直接持つ。両者を統一して per-task 集計するため `task_sessions` テーブル（DDL: `trace-store.ts:121-134`）の `event IN ('assigned','agent_spawned')` 行で `session_id → task_id` を解決する。

`task_sessions` は同 `session_id` に対し複数行を持ちうる（resume / clear で append される）ため、`MIN(task_id) GROUP BY session_id` で 1:1 に集約してから JOIN する。これがないと 2 行 hit で tool 件数が二重カウントされる。

T407: `event = 'assigned'` だけでは Conductor 由来の tool_use しか task_id 解決できなかったため、`event IN ('assigned','agent_spawned')` に拡張して **Agent 由来 tool_use も task_id へ紐づけられる**ようにした。同時に `session_id != ''` の防御を加え、過去の backfill されていない空 session_id 行（旧 cmdSpawnAgent が `session_id: ""` で書いた agent_spawned 行や空 session_id の hook_signals 行）が互いに誤マッチして empty 同士で JOIN ヒットする regression を防ぐ。

`session_to_task` CTE 全文（`trace-store.ts` から逐語コピー）:

```sql
WITH session_to_task AS (
  SELECT session_id, MIN(task_id) AS task_id
  FROM task_sessions
  WHERE event IN ('assigned','agent_spawned')
    AND task_id IS NOT NULL
    AND session_id IS NOT NULL AND session_id != ''
  GROUP BY session_id
)
```

JOIN 側でも `h.session_id != ''` の防御を入れる:

```sql
LEFT JOIN session_to_task s2t
  ON h.session_id = s2t.session_id
  AND h.session_id != ''
```

> **脚注**: 同一の `session_to_task` CTE は `countToolCallsByTask` / `firstEditPerTask` / `failureRateByTask` の **3 関数に複製**されている。後続タスクで共通化候補だが、本 spec の範囲では事実として記録するに留める。

`task_id IS NULL`（unattached）の hook はこの CTE で除外される。task_assigned 前に発火した hook（session_started 未到達）は `task_sessions` に行が無いため LEFT JOIN 結果が NULL となり、`countToolCallsByTask` は `task_id=null` のまま残し、`firstEditPerTask` / `failureRateByTask` の per-task 集計からは除外される。詳細は §6 Caveats。

#### 3.5.1 spawn 時 `--session-id` pre-inject (T407)

`task_sessions` の `event='assigned'` / `event='agent_spawned'` 行に**空でない** `session_id` を確実に書き込むため、Manager 側で UUID v4 を pre-inject する経路を取る。

| ロール | spawn 経路 | UUID 発行サイト | claude 起動 flag | daemon 通知 |
|---|---|---|---|---|
| Conductor | `cmux-team conductor` | `cmdConductor`（`main.ts`） | `--session-id <UUID>` | `CONDUCTOR_REGISTERED` POST に sessionId 同梱 |
| Agent | `cmux-team spawn-agent` | `cmdSpawnAgent`（`main.ts`） | `--session-id <UUID>` | `AGENT_SPAWNED` POST に sessionId 同梱 |
| Master | （**scope 外** — 本タスクで対応せず） | — | — | — |

Daemon は `CONDUCTOR_REGISTERED` / `AGENT_SPAWNED` ハンドラで `state.sessionId` 未設定なら採用、既存値があれば mismatch を warn (`session_id_mismatch_at_register_late`) して hook 信頼方針で破棄する。後続の SessionStart hook 由来 `SESSION_STARTED(source=startup)` で異なる UUID が届いた場合は `session_id_mismatch_at_startup` warn を出した上で hook 側を採用する（`source=clear/compact/resume/undefined` は warn 無し上書きで legacy 互換）。

`task_sessions` テーブルは **append-only 不変性**を保つ。/clear / /compact 後の追従は `task-state.json` の `sessionId` 更新のみで完結し、テーブル自体への UPDATE 経路は導入しない。spawn 時に書かれた `assigned` / `agent_spawned` 行に空でない UUID が入っていれば、Agent 由来 tool_use の task_id 解決には十分（同 task_id 配下に複数 session_id 行があっても `MIN(task_id) GROUP BY session_id` で集約される）。

`--resume` 経路（`cmdResume`）には `--session-id` を**渡さない**。既存 session を復元する目的のため。

---

## 4. CodeDNA 評価判定基準

CodeDNA 採用評価は「介入前 baseline」と「介入後 evaluation」の 2 cohort を統計検定で比較する。

実運用としての baseline 開始日時・期間・cohort 比較 CLI / 警報閾値の SSOT は **§7〜§13**（T381 で確定）に集約する。本節 §4 は taxonomy 上の判定方法の定義に絞る。

### 4.1 baseline period / evaluation period の定義

| 用語 | 定義 |
|---|---|
| baseline period | 介入導入前の連続 N day。CodeDNA 評価の比較基準点となる metric 観測期間 |
| evaluation period | 介入導入後の連続 N day。baseline と統計検定で比較する観測期間 |

**実運用値（T381 で確定）**: N = **4 週（28 day）**。baseline 開始日時 = **2026-05-04 (UTC, 月曜)**。詳細は §8 を参照。

> **歴史メモ**: タスク本文（T380）では暫定値 N=14 day としていたが、T381 で daily snapshot 自動収集が成立した結果、4 週を採用できる前提が揃った（snapshot 経由で再集計コストが消えるため期間を倍にしてもコスト増しない）。

### 4.2 cohort comparison の手順

1. 同一プロジェクト内の **subject-within** 比較（task ID 範囲または日付範囲で cohort tag を切る）
2. baseline cohort: 介入導入直前の N day（または task ID 範囲）
3. evaluation cohort: 介入導入直後の N day（または task ID 範囲）
4. 各 metric について cohort 平均・分布・stddev を比較
5. §4.3 の検定手順で有意差を判定
6. §4.4 の撤退判定または §10 の警報閾値に従って合否を決める

実装は §9「cohort 比較 CLI」を参照（`cmux-team metrics compare`）。

### 4.3 統計検定の選択

- **正規性検定**:
  - n < 30 → Shapiro-Wilk 検定で正規性を判定
  - n ≥ 30 → 中心極限定理（CLT）の仮定で正規性を許容（事前確定）
- **等分散性**: Levene 検定で判定。不等であれば Welch の t-test を採用（事前確定）
- **検定の選択フロー**:
  1. 正規性 OK & 等分散 OK → Student の t-test
  2. 正規性 OK & 等分散 NG → Welch の t-test
  3. 正規性 NG → Wilcoxon rank-sum 検定（順位ベース、分布形状に依存しない）

実装上 `cmux-team metrics compare`（§9）は **Welch の t-test を主、Mann-Whitney U（Wilcoxon と等価）を補助、比率系は 2-proportion z-test** の組み合わせで両方を必ず出力する（事前正規性検定を省略し下位互換）。

### 4.4 撤退判定

副作用系（§2.5）の **1 metric でも** 以下を満たすなら撤退する:

```
evaluation 平均 > baseline 平均 × (1 + threshold)  AND  adjusted p < 0.05
```

`threshold` は §2.5 の「警報閾値（暫定）」を用いる（例: `tokens.input` なら +30% → threshold=0.30）。

実装上の警報閾値の SSOT は §10 / `metrics-thresholds.ts` を参照。

#### 多重比較補正

副作用系には `tokens.{input, output, cache, requests}` の 4 種が並ぶため、複数 metric を同時検定する場合の familywise α 膨張を補正する必要がある。例えば 4 metric を α=0.05 で個別検定すると実効的 false positive rate は約 18% に達する。

**推奨**: Benjamini-Hochberg 法（FDR 制御、adjusted p < 0.05 を判定基準）

**代替**: Bonferroni 法（厳格、α/N を判定基準。N は同時検定する metric 数）
- 例: 副作用系 4 metric なら α/N = 0.05 / 4 = **0.0125**
- 将来 metric が増えると N も変わるため、検定時に N を確定させる

> **暫定注釈**: §2.x の「警報閾値（暫定）」はすべて **[暫定] baseline 計測前 — 業界経験則ベース**。N=4 週 baseline 取得後の commit で実測値に基づき更新する。実装上の cohort 比較 alarm 閾値は §10 で別途確定（コード SSOT）。

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

### 5.4 daily snapshot / cohort 比較 / health チェック（T381）

snapshot 自動収集と cohort 比較のサブコマンド `cmux-team metrics snapshot|compare|health` は §7〜§13 を参照。

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

> 以下の §7〜§13 は T381 で追加された **daily snapshot 自動収集 + cohort 比較ツール** の仕様。
>
> **閾値 SSOT 注釈**: §10「警報閾値」は **コード `skills/cmux-team/manager/metrics-thresholds.ts` の `DEFAULT_ALARM_THRESHOLDS` を SSOT** とする派生表示である。spec の数値はコードと同期する運用（docs-sync 対象）。値の改定はコード側を変更し、spec を後続で揃える。
>
> **タイムゾーン方針**: snapshot の `snapshot_date` は **UTC 基準**。JST 環境では snapshot_date が JST 翌日 09:00 までのデータを含む点に注意。launchd 推奨時刻は **UTC 00:05 = JST 09:05**（前日 UTC が確定済みのタイミング）。
>
> **schema_version 方針**: snapshot は fact として固定する設計。`schema_version` は **increment-only** とし、過去 snapshot は再生成しない。`v=2` 移行時は両形式を読める loader を追加し、on-the-fly upgrade は禁止。

---

## 7. snapshot スキーマ + 命名

### 配置 / 命名

```
.team/metrics/snapshots/YYYY-MM-DD.json
```

- `YYYY-MM-DD` は **UTC 基準**（snapshot_date 値と一致）
- 1 日 1 ファイル、increment-only
- atomic write（temp file + `fs.rename`）で partial write が永続化されないことを保証

### スキーマ (`schema_version = 1`)

```jsonc
{
  "schema_version": 1,
  "snapshot_date": "2026-05-01",       // YYYY-MM-DD（UTC 基準）
  "window": {
    "from": "2026-04-30T00:00:00.000Z", // [from, to)
    "to":   "2026-05-01T00:00:00.000Z"
  },
  "per_task":   [/* PerTaskMetrics[] = aggregateMetricsByTask 出力 */],
  "period":     {/* PeriodSummary = 同じ lifecycle map から aggregatePeriod 派生 */},
  "metadata": {
    "generated_at": "2026-05-01T00:05:00.000Z",
    "events_jsonl_size_bytes": 12345,
    "events_jsonl_path": ".team/events.jsonl",
    "traces_db_path": ".team/traces/traces.db"
  }
}
```

### 設計判断（fact / 派生分離）

- `per_task` と `period` は **同じ window から派生**（`aggregateMetricsByTask` を 1 度だけ呼び、その lifecycle map から `aggregatePeriod` を派生）
- `per_day` を含めない: 1 日 window では per_day = 1 要素で period と完全重複するため。期間横断の per-day trend が必要な場合は compare 側 `derivePerDayFromSnapshots` で snapshot 群から派生する
- `metadata` は実行時情報を sub-object に隔離（snapshot 再生に寄与しない情報を fact レベルから切り離す）

---

## 8. baseline / evaluation 期間

### baseline 開始日時

- **2026-05-04 (UTC, 月曜)**

### baseline 期間

- 4 週: **2026-05-04 〜 2026-05-31** (UTC, 両端含む)

### evaluation 期間

CodeDNA 投入後を起点として +4w → +8w → +12w のローリング:

| ラウンド | from (UTC) | to (UTC) | 備考 |
|----------|-----------|----------|------|
| +4w | CodeDNA 投入 +1 日 | +4 週 | 早期検知 |
| +8w | CodeDNA 投入 +1 日 | +8 週 | 安定性確認 |
| +12w | CodeDNA 投入 +1 日 | +12 週 | 長期影響評価 |

評価コマンド例:

```bash
cmux-team metrics compare \
  --baseline 2026-05-04..2026-05-31 \
  --comparison 2026-06-15..2026-07-12
```

---

## 9. cohort 比較 CLI

### 出力構造

```jsonc
{
  "metrics": {
    "duration_ms":          { "baseline_mean": ..., "comparison_mean": ..., "delta": ..., "delta_pct": ..., "t_test": {...}, "mann_whitney": {...} },
    "tool_call_total":      { ... },
    "tool_failure_rate":    { ... },
    "time_to_first_edit_ms":{ ... },
    "tokens_total":         { ... }
  },
  "rates": {
    "completion_rate":   { "baseline": ..., "comparison": ..., "delta_pp": ..., "delta_pct": ..., "z_test": {...} },
    "abort_rate":        { ... },
    "forced_close_rate": { ... }
  },
  "alarms": [/* AlarmSignal[] */],
  "samples": { "baseline_n": ..., "comparison_n": ... },
  "skipped_files": [/* schema 不一致 / parse 失敗 */],
  "missing":       [/* snapshot ファイル無し */]
}
```

### dedup 2 段ルール（unionPerTask）

snapshot 範囲内に同じ `task_id` が複数出現した場合の優先規則:

1. **closed-state 優先**: `outcome != "open"` のレコードが優先
2. **同 outcome 内では snapshot_date 昇順最後**を採用（後発の方が lifecycle が完全）

理由: open task は後日 closed snapshot が出現するため、closed 優先で完全 lifecycle に上書き。同 outcome 内では時間経過で metric が確定するため後発を信頼する。

### exit code

| code | 意味 |
|------|------|
| 0 | 正常 (alarm 無し) |
| 1 | 引数エラー / IO エラー / 範囲不正 |
| 2 | alarm あり (CI 連携用) |

---

## 10. 警報閾値（DEFAULT_ALARM_THRESHOLDS）

> SSOT は `skills/cmux-team/manager/metrics-thresholds.ts`。下表はコード SSOT の参照表示。

| metric | direction | delta | unit | alarm 条件 |
|--------|-----------|-------|------|------------|
| `completion_rate` | `lower_is_worse` | 0.10 | pp | `delta_pp < -0.10` で alarm |
| `forced_close_rate` | `higher_is_worse` | 0.05 | pp | `delta_pp > 0.05` で alarm |
| `duration_ms_mean` | `higher_is_worse` | 0.30 | pct | `delta_pct > 0.30` で alarm（baseline_mean=0 では N/A 扱い） |
| `tool_failure_rate` | `higher_is_worse` | 0.05 | pp | `delta > 0.05` で alarm |

direction の意味:
- `lower_is_worse`: 値が下がると悪化（completion_rate）
- `higher_is_worse`: 値が上がると悪化

unit の意味:
- `pp`: percentage point（絶対差、0..1 スケール）
- `pct`: 相対変化率（baseline 比、0..1 スケール）

境界判定: 浮動小数の自然な丸め誤差で「ぴったり閾値」のときに alarm 化しないよう **strict greater / less** を使う（`delta_pp == -0.10` ぴったりは alarm にならない）。

---

## 11. snapshot 自動収集（運用）

### 推奨スケジュール

- **UTC 00:05 (= JST 09:05)** に `cmux-team metrics snapshot` を 1 日 1 回実行
- 前日 UTC のデータが確定済みのタイミング（CLI 既定 `--date` は「昨日 UTC」）

### macOS (launchd)

`skills/cmux-team/templates/launchd/com.cmux-team.metrics-snapshot.plist.template` をコピーし、`{{PROJECT_ROOT}}` を絶対パスに置換して `~/Library/LaunchAgents/com.cmux-team.metrics-snapshot.plist` に配置:

```bash
sed "s#{{PROJECT_ROOT}}#$(pwd)#g" \
  skills/cmux-team/templates/launchd/com.cmux-team.metrics-snapshot.plist.template \
  > ~/Library/LaunchAgents/com.cmux-team.metrics-snapshot.plist
launchctl load ~/Library/LaunchAgents/com.cmux-team.metrics-snapshot.plist
```

`StartCalendarInterval` は launchd の **local time** 解釈なので JST 環境では `Hour=9, Minute=5` を設定する（これが UTC 00:05 に相当）。

### Linux (cron)

```cron
# UTC 00:05 daily（システム TZ に応じて時刻を調整。例: JST → 5 9 * * *）
5 0 * * * cd /path/to/project && cmux-team metrics snapshot >> .team/logs/snapshot.log 2>&1
```

### GitHub Actions

```yaml
on:
  schedule:
    - cron: "5 0 * * *"   # UTC 00:05
jobs:
  snapshot:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx -y @cmux/team metrics snapshot
      - uses: actions/upload-artifact@v4
        with:
          name: metrics-snapshot
          path: .team/metrics/snapshots/
```

---

## 12. failure 検知

### `cmux-team metrics health`

直近 N 日（既定 7、UTC 基準）に snapshot ファイルが揃っているかをチェックする。launchd `StandardErrorPath` で監視を組まなくても **コマンド一発で枯渇判定** できる位置付け。

```bash
cmux-team metrics health --days 7
```

| exit code | 意味 |
|-----------|------|
| 0 | 全日揃っている |
| 1 | 欠損あり (json/text に missing 列挙) |

### launchd の StandardErrorPath

snapshot ジョブの stderr を `<project>/.team/logs/snapshot.log` に流す:

```xml
<key>StandardOutPath</key>
<string>{{PROJECT_ROOT}}/.team/logs/snapshot.log</string>
<key>StandardErrorPath</key>
<string>{{PROJECT_ROOT}}/.team/logs/snapshot.log</string>
```

`KeepAlive=false` を設定し、snapshot 失敗時に launchd が無限再起動しないようにする。

---

## 13. snapshot fact / 不変条件

### 不変条件

- snapshot は 1 日 = 1 ファイル、再生成禁止
- atomic write を保証する（partial JSON が永続化されない）
- schema_version は increment-only（v=2 移行時は両形式 loader を追加し、過去 snapshot は変更しない）
- events.jsonl が rotate されたあとに過去 snapshot を再生成する用途は **想定外**（fact が固定済み）

### partial write の検知

snapshot ディレクトリに `.tmp-*` が残っていたら、過去の write 中断の可能性を示す。次回起動時に手動で掃除すること:

```bash
rm .team/metrics/snapshots/.tmp-*
```

---

## 14. 関連 spec / 関連 task / 関連コード

### 関連 spec

- [`10-events-stream.md`](10-events-stream.md) — events.jsonl schema（terminal 4 event の一次定義）
- [`09-token-pool.md`](09-token-pool.md) — api_usage / token pool（副作用系 metric の data source）
- [`glossary.md`](glossary.md) — 用語集（§11 Metrics / cohort 比較）

### 関連 task

- **T379** — `cmux-team metrics` サブコマンド + hook_signals 棚卸し（実装本体）
- **T380** — 本 spec の §1〜§6（metrics 文書化・taxonomy）
- **T381** — 本 spec §7〜§13（daily snapshot 自動収集 + cohort 比較 CLI 実装）
- **T354** — dashboard Metrics タブ（`dashboard-metrics.ts`、CLI と互換数値の UI 表示）
- **T266** — hook_signals テーブル新設（data source の起点）
- **未起票（後続）**:
  - 連鎖破壊系（§2.3）metric の実装
  - 知識引き継ぎ系（§2.4）metric の実装
  - 副作用系（§2.5）の header rot / agent message GC metric の実装
  - baseline period 計測完了後の §2 警報閾値の実測値更新
  - `session_to_task` CTE の 3 関数共通化リファクタ（§3.5 脚注）
  - `derivePerDayFromSnapshots` を CLI から露出する `cmux-team metrics trend` サブコマンド
  - `runWithAbort` helper の既存 `cmdEvents` / `cmdMetrics` への展開（cleanup）

### 関連コード

- 実装本体: `skills/cmux-team/manager/metrics-{aggregate,cli,stats,snapshot,compare,health,thresholds,path}.ts`
- launchd template: `skills/cmux-team/templates/launchd/com.cmux-team.metrics-snapshot.plist.template`
- T379 既存 metrics CLI: `cmux-team metrics --group-by task|day|week`（snapshot/compare/health とは独立）
