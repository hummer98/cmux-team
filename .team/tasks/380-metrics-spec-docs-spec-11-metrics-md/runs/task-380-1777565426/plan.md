# T380 実装計画書: metrics spec 文書化 (docs/spec/11-metrics.md)

> 計画書のみ。コード変更・ドキュメント本体作成は後続フェーズ（Implementer）で行う。

## 0. ゴール再掲

T379 で実装済みの `cmux-team metrics` サブコマンドを SSOT 化し、CodeDNA 採用評価の baseline 計測のため
「何を測るか / どう計算するか / 警報閾値」を後付け解釈の余地なく事前確定する。

成果物（後続フェーズで作成）:

1. **新規** `docs/spec/11-metrics.md` — Metrics taxonomy（6 軸） + CodeDNA 評価判定基準
2. **更新** `docs/spec/glossary.md` — `metrics SSOT` / `cohort comparison` / `baseline period` / `evaluation period` / `header rot` / `agent message GC`
3. **更新** `CLAUDE.md` — 短い metrics リファレンス（3-5 行、詳細は spec へリンク）

タスクファイル本体に「5 軸」とあったが、ユーザー指示で **6 軸**（俯瞰系を追加）が確定。本計画はこちらを正とする。

---

## A. 既存コードの読み取りサマリー（引用源インデックス）

### A.1 `skills/cmux-team/manager/metrics-aggregate.ts`（417 行）

集計ロジックの SSOT。Implementer はこのファイルから「実装上の真の計算式」を引用すること。

| 引用すべきシンボル | 行 | 役割 |
|---|---|---|
| `Outcome` 型 | 30 | task の終端区分 5 値（`completed` / `aborted` / `state_mismatch` / `forced_close` / `open`） |
| `PerTaskMetrics` interface | 40-56 | per-task JSON 出力 schema（task_id, outcome, assigned_ts, closed_ts, duration_ms, tool_calls, tool_call_total, tool_failure_rate, time_to_first_edit_ms, tokens.{input,output,cache,requests}） |
| `PerBucketMetrics` interface | 58-76 | per-bucket（day/week）JSON 出力 schema（bucket, tasks_assigned/completed/aborted, completion_rate, abort_rate, forced_close_rate, deny_rate, tool_call_total, tool_call_stddev, duration_ms_mean/stddev, tokens_total.{input,output,cache}） |
| `PeriodSummary` interface | 78-89 | 期間サマリ（forced_close / state_mismatch を含む 5 outcome ＋ rate 系 3 ＋ 平均/stddev） |
| `stddev` 関数 | 96-102 | 母集団標準偏差（spec の「ばらつき」定義と一致させる） |
| `TERMINAL_EVENTS` set | 113-118 | terminal とみなす events.jsonl 4 event： `task_completed` / `task_completed_state_mismatch` / `task_aborted` / `conductor_disconnect_timeout` |
| `classifyOutcome` 関数 | 120-133 | event → Outcome のマッピング |
| `readTaskLifecycle` | 143-216 | events.jsonl reader。`task_assigned` 必須・terminal は最新採用・`since` フィルタは open=assigned_ts / closed=terminal_ts で判定 |
| `aggregatePeriod` | 222-244 | `Map<task_id, Lifecycle>` → `PeriodSummary` |
| `aggregateMetricsByTask` | 263-322 | per-task 集計のオーケストレーション。tool_failure_rate = failures/total（total=0 で 0）、time_to_first_edit_ms = first_edit_ts − assigned_ts |
| `bucketKey` 関数 | 340-350 | day=YYYY-MM-DD / week=ISO week 月曜起点（UTC） |
| `aggregateMetricsByBucket` | 352-410 | bucket 単位再集計、deny_rate のみ bucket time-range で SQL re-query |

> **注意**: deny_rate は bucket ごとの time range で `denyRateByPeriod` を呼び直す。期間全体の deny_rate を全 bucket に同じ値で配布しない（spec にも明記すること）。

### A.2 `skills/cmux-team/manager/metrics-cli.ts`（344 行）

CLI ラッパー。spec §5「CLI からの取得例」の入出力契約をここから引用する。

| 引用すべき要素 | 行 | 役割 |
|---|---|---|
| `RunMetricsCliOpts` interface | 29-36 | in-process テスト可能な CLI entry point の契約 |
| `KNOWN_FLAGS` / `FLAGS_WITH_VALUE` | 46-55 | `--task-id` / `--since` / `--format` / `--group-by` / `--help` |
| `parseArgs` の制約 | 104-106 | `--task-id` は `--group-by task` (default) 時のみ有効 |
| `PER_TASK_HEADER` 配列 | 184-198 | CSV 列順（spec の表に合わせる） |
| `PER_BUCKET_HEADER` 配列 | 222-238 | CSV 列順 |
| `formatTextPerTask` / `formatTextPerBucket` | 124-168 | text format（key=value space-separated）の出力例 |
| `runMetricsCli` の events.jsonl/traces.db 必須チェック | 287-296 | 失敗時 stderr メッセージ |

### A.3 `skills/cmux-team/manager/trace-store.ts`（差分のみ確認した範囲）

SQL の SSOT。spec §3「Data sources の詳細」の SQL/CTE はすべてこのファイルを引用する。

| 引用すべき関数 / SQL | 行 | 役割 |
|---|---|---|
| `SCHEMA` 定数 | 120-202 | `task_sessions` / `hook_signals` / `api_usage` / `rate_limit_snapshots` の DDL |
| `task_sessions` 列定義 | 121-134 | session_id ↔ task_id の解決元（event=`assigned` 行で MIN(task_id)） |
| `hook_signals` 列定義 | 138-159 | type / tool_name / payload_json / session_id を含む 20 列 |
| `api_usage` 列定義 | 163-192 | input/output/cache_creation/cache_read tokens、ratelimit_* 列 |
| `aggregateApiUsageByTask` SQL | 1119-1143 | `task_id IS NOT NULL` フィルタ、(input+output) 降順、`limit` 切り |
| `countToolCallsByTask` SQL | 1173-1200 | **`WITH session_to_task AS (... GROUP BY session_id)` の CTE** がここに定義（spec §3 の join key 説明はこの CTE を引用） |
| `firstEditPerTask` SQL | 1215-1239 | tool_name='Edit' の `MIN(timestamp)` |
| `failureRateByTask` SQL | 1253-1286 | `JSON_EXTRACT(payload_json, '$.payload.tool_response.success') = 0 OR `error` IS NOT NULL` |
| `denyRateByPeriod` SQL | 1299-1318 | 期間内 PRE_TOOL_USE 総数 と PRE_TOOL_USE_DENIED 件数のみ。**Conductor の Bash deny script のみが集計対象**（spec で明記） |

### A.4 `skills/cmux-team/manager/i18n.ts` の `help_metrics`

| 引用すべき箇所 | 行 | 用途 |
|---|---|---|
| `help_metrics` ja | 591〜 | （spec §1 の「使い方」要約に流用） |
| `help_metrics` en | 1478-1514 | 英語版。CLI ヘルプ本文に含まれる「deny_rate は cmux-team の Bash deny 率であり汎用 hook block 率ではない」「task_assigned 前 hook は集計外」「tool_response.content は 1KB 切り詰め」の 3 点を spec の Caveats 節で必ず転載する |

### A.5 `docs/spec/10-events-stream.md`

events.jsonl の schema を記述する一次資料。

| 引用すべき箇所 | 行 | 用途 |
|---|---|---|
| §3「共通 field」（`ts` / `event` / `schema_version`） | 56-70 | spec §3 で events.jsonl を data source として扱う際の前提 |
| §5.1 Task lifecycle 8 event | 96-107 | terminal 4 event（`task_completed` / `task_completed_state_mismatch` / `task_aborted` / `conductor_disconnect_timeout`）が data source として確定していることを示す |
| §5.2 Conductor lifecycle 8 event | 111-120 | `conductor_disconnect_timeout` のみが metrics の forced_close 判定に使われることを引用 |

### A.6 `docs/spec/glossary.md`（既存フォーマット）

| 引用すべき構造 | 行 | 用途 |
|---|---|---|
| 二次資料宣言 | 6-7 | 「定義の本体を spec から複製すると DRY 違反」— 11-metrics.md でも同じ方針を踏襲 |
| 既存表の列構成（用語/定義/一次リンク/関連） | 26 等 | T380 で追加する 5 用語も同じ列で書く |
| 「コミュニケーション系」セクション | 156-170 | Trace DB / events stream / hook を既に整備済み — metrics は既存用語を `関連` 列で参照する |

### A.7 `CLAUDE.md`

最小変更方針（§E）に従い、編集対象は **2 箇所のみ**:

| 引用すべき箇所 | 行 | 用途 |
|---|---|---|
| 「リポジトリ構造」表（`docs/spec/...` 一覧） | 75-82 | `docs/spec/11-metrics.md` の 1 行を追加する場所 |
| 「進捗情報の取得方法」表 | 192-196 | `cmux-team metrics` の 1 行を追加する場所 |

---

## B. `docs/spec/11-metrics.md` の章構成（目次プロポーザル）

ファイル名は `docs/spec/11-metrics.md`、heading 番号は他の spec と揃える（H1=タイトル、H2=連番セクション）。

```
# 11. Metrics

## 1. 概要
## 2. Metrics taxonomy（6 軸）
   2.1 探索コスト系
   2.2 制約違反系
   2.3 連鎖破壊系
   2.4 知識引き継ぎ系
   2.5 副作用系
   2.6 俯瞰系
## 3. Data sources
   3.1 events.jsonl（task lifecycle）
   3.2 hook_signals テーブル（tool call）
   3.3 api_usage テーブル（token 消費）
   3.4 git log（補助）
   3.5 join key と session_to_task CTE
## 4. CodeDNA 評価の判定基準
   4.1 baseline period / evaluation period の定義
   4.2 cohort comparison の手順
   4.3 統計検定（t-test or Wilcoxon の選択基準）
   4.4 撤退判定の閾値（副作用系メトリクスの 1 つでも超過で撤退）
## 5. CLI からの取得例
## 6. Caveats（既知の集計上の注意）
## 7. 関連 spec / 関連 task
```

各章の予告（2-3 行）:

### §1 概要

- 本 spec の目的: metrics の SSOT、CodeDNA 評価の事前合意点、後付け解釈防止
- 誰が使うか: Master（`cmux-team metrics` で観測）、Implementer（baseline 比較）、Reviewer（撤退判断）
- 実装の SSOT は **`skills/cmux-team/manager/metrics-aggregate.ts`（CLI 側）** であり、本 spec はそれと整合する文書化である旨を明記
- **`dashboard-metrics.ts` との関係**: `skills/cmux-team/manager/dashboard-metrics.ts` は同じ `trace-store.ts` の SQL を呼ぶ別系統の UI ビルダーで、CLI と互換する数値を Manager dashboard の Metrics タブに表示する。spec が扱う SSOT は CLI 側であり、両者の責務分担はそれぞれのモジュール冒頭コメントを参照（2-3 行で明示）

### §2 Metrics taxonomy（6 軸）

各軸 1 サブセクションで以下のテーブルを置く:

| metric | 定義 | 計算式 | data source | SQL or jq 例 | 警報閾値（暫定） | 実装ステータス |
|---|---|---|---|---|---|---|

「実装ステータス」列は **`実装済み` / `taxonomy 上定義のみ`** の 2 値。各軸の対応表は §C で確定。

各軸末尾に追加する disclaimer / 注釈の予告:

- **§2.1 探索コスト系 末尾**:
  - 「`tool_failure_rate` は POST_TOOL_USE の `success=false` / `error≠null` の率であり、deny script による事前 block ではない（後者は §2.2 制約違反系の `deny_rate`）」を 1 行注釈として記載 — **M-1 対応**
  - 「探索コスト系の variance / 平均は §2.6 俯瞰系に集約する（軸の二重カウント回避）」を 1 行 disclaimer として記載 — **m-6 対応**
- **§2.2 制約違反系**: `tool_failure_rate` をこの軸から外し、`deny_rate` のみを残す（§C マトリクスと同期） — **M-1 対応**

### §3 Data sources

- `events.jsonl`（schema は `10-events-stream.md` を参照、本 spec では **terminal 4 event** と `task_assigned` の 5 event のみ集計に使うことを宣言）
- `hook_signals` テーブル（PRE_TOOL_USE / POST_TOOL_USE / PRE_TOOL_USE_DENIED の 3 type のみ集計に使う）
- `api_usage` テーブル（input / output / cache_creation_input / cache_read_input + task_id 列）
- `git log`（後追い修正 commit 数など補助 metrics の data source、未実装）
- join key 図と `session_to_task` CTE の SQL（`countToolCallsByTask` から引用）。**`MIN(task_id) GROUP BY session_id` 集約の理由**（resume / clear で task_sessions に複数行が append されるため二重カウント防止）を明記
- §3.5 末尾の脚注として「同一の `session_to_task` CTE は `countToolCallsByTask` / `firstEditPerTask` / `failureRateByTask` の 3 関数に複製されている（`trace-store.ts:1179-1184` / `1219-1225` / `1257-1263`）」を明記 — **m-2 対応**

### §4 CodeDNA 評価の判定基準

- **§4.1 baseline period / evaluation period**:
  - baseline period: 介入導入前の連続稼働 N day（暫定 N=14、§G リスク参照）
  - evaluation period: 介入後の連続 N day（同 N=14）
  - **N=14 day の根拠**: cohort 内 task 数 30+ を確保しやすい短期境界として暫定設定。後続タスクで実測値を見て再評価する旨を併記 — **m-5 対応**
- **§4.2 cohort comparison**: 同一プロジェクト内の同期間と他期間（subject-within）。task ID 範囲で比較できるよう task_id を cohort tag として扱う
- **§4.3 統計検定の選択**:
  - per-task サンプルが 30+ で正規性を仮定可なら t-test、それ以外（durations の分布が右裾長い等）は Wilcoxon rank-sum
  - **正規性検定**: n<30 は Shapiro-Wilk、n≥30 は CLT 仮定で正規性を許容（事前確定） — **m-4 対応**
  - **等分散性**: Levene 検定で判定、不等であれば Welch の t-test を採用（事前確定） — **m-4 対応**
- **§4.4 撤退判定の閾値**:
  - 副作用系（§2.5）の 1 metric でも `evaluation 平均 > baseline 平均 × (1 + threshold)` かつ adjusted p<0.05 なら撤退
  - **多重比較補正**: 副作用系には `tokens.{input,output,cache,requests}` ＋ 将来追加 metric（header rot 等）が並ぶため、複数 metric を同時検定する場合の familywise α 膨張を抑える必要がある — **M-2 対応**
    - **推奨**: Benjamini-Hochberg 法（FDR 制御、adjusted p<0.05 を判定基準とする）
    - **代替**: Bonferroni 法（厳格、α/N を判定基準とする — N は同時検定する metric 数）
  - 「副作用系 N metric 検定時の閾値: α/N（Bonferroni）または BH 補正後の adjusted p<0.05」と数式レベルで明記

### §5 CLI からの取得例

3 例:
1. per-task JSON（`cmux-team metrics --since 7d`）
2. per-day CSV（`cmux-team metrics --group-by day --format csv --since 14d`）
3. per-task text、1 タスク（`cmux-team metrics --task-id 379 --format text`）

各例に「期待出力スキーマの抜粋」を 5-10 行で示す。

text format の注記（**m-8 対応**）:
- text 形式は 1 行 per task で `key=value` を space-separated で並べるが、`tool_calls` フィールドは値が object 型のため **JSON-encoded value として 1 行内に埋め込まれる**
- 例: `task_id=379 outcome=completed tool_calls={"Read":12,"Edit":3,"Bash":5} tool_call_total=20 ...`
- パース時は `tool_calls=` の後の `{...}` を JSON.parse する必要がある旨を明示

### §6 Caveats

`help_metrics` から 3 点を転載:
- deny_rate は cmux-team の Bash deny 率であり汎用 hook block 率ではない
- tool call と task の紐付けは task_assigned 後の hook のみ（task_sessions.session_id JOIN）
- tool_response.content は 1KB 切り詰め

### §7 関連 spec / 関連 task

- `10-events-stream.md`（events.jsonl schema）
- `09-token-pool.md`（api_usage の出所）
- `glossary.md`（用語集）
- T379 / T354 / T266（実装履歴）

---

## C. taxonomy 6 軸 × T379 実装 metric の対応表

T379 で実装された metric（出所は `metrics-aggregate.ts` の interface 定義）:

```
PerTaskMetrics: outcome / duration_ms / tool_calls(Record) / tool_call_total /
                tool_failure_rate / time_to_first_edit_ms /
                tokens.{input,output,cache,requests}
PerBucketMetrics: tasks_assigned / tasks_completed / tasks_aborted /
                  completion_rate / abort_rate / forced_close_rate /
                  deny_rate / tool_call_total / tool_call_stddev /
                  duration_ms_mean / duration_ms_stddev / tokens_total.*
```

軸別マトリクス（◎=T379 で実装済み、○=本 spec で taxonomy 定義のみ・実装は将来タスク）:

| 軸 | 実装済み metric (T379) | 未実装 metric（taxonomy で定義） |
|---|---|---|
| 2.1 探索コスト系 | ◎ Read 件数 (`tool_calls.Read`) / Grep 件数 (`tool_calls.Grep`) / Edit 件数 (`tool_calls.Edit`) / `tool_call_total` / `time_to_first_edit_ms` / **`tool_failure_rate`**（PostToolUse の `success=false` or `error≠null` — 「無駄な試行コスト」として位置づけ、deny script による事前 block ではない） | ○ Read 失敗率 (Read だけに絞った tool_failure_rate)、Read/Edit 比、Glob 件数 |
| 2.2 制約違反系 | ◎ `deny_rate`（Bash deny 限定 — Conductor の Bash deny script が事前に block した率） | ○ lint/typecheck 失敗率（PostToolUse の Bash で `bun run lint` 等の終了コード）、task reopen 率（restart-task の頻度） |
| 2.3 連鎖破壊系 | （実装なし） | ○ edit 後 dependent test 失敗率、後追い修正 commit 数（git log で同 PR 内 fixup commit count）、CI 失敗率 |
| 2.4 知識引き継ぎ系 | （実装なし） | ○ 重複調査率（同 task 内 Researcher 起動回数 / artifact 数）、agent → rules promotion 率（CLAUDE.md / .team/agent-instructions/ の更新頻度）、artifact 数の変化 |
| 2.5 副作用系 | ◎ `tokens.{input,output,cache,requests}`（per-task） / `tokens_total.*`（per-bucket） | ○ header 自体の token cost、refresh 失敗率、header rot 率、agent message GC 累積行数 |
| 2.6 俯瞰系 | ◎ `duration_ms` / `completion_rate` / `abort_rate` / `forced_close_rate` / `tool_call_stddev`（tool call variance） / `tasks_completed` / `tasks_aborted` | ○ state_mismatch 率（PerTaskMetrics の outcome=`state_mismatch` 集計、PeriodSummary には実装あり・per-bucket は未） |

**未実装 metric も §2 のテーブルに「実装ステータス: taxonomy 上定義のみ」として明記する** — 後付け解釈防止のため、評価開始前に taxonomy 全体を確定させる。

実装済みかどうかは Implementer が `grep -nE 'Outcome|PerTaskMetrics|PerBucketMetrics' skills/cmux-team/manager/metrics-aggregate.ts` で原本を確認できる。

---

## D. glossary.md 追加用語（5 用語 → 実際は 6 用語）

タスク本体に書かれた 5 用語に加え `baseline period` と `evaluation period` は 1 行で並べて 1 セクション化する。

挿入位置: 既存「10. コミュニケーション系」の **直後**に新セクション「11. Metrics 関連」を追加。glossary は二次資料なので 1〜2 行の要約 + 一次リンクのみ（DRY）。

| 用語 | 定義（1-2 行） | 一次リンク | 関連 |
|---|---|---|---|
| metrics SSOT | `cmux-team metrics` サブコマンドの計算ロジック（`metrics-aggregate.ts`）と本 spec が metric の単一情報源。CLI 出力・spec・解釈はここから派生する | `11-metrics.md#1-概要` | `cmux-team metrics` / Trace DB / events stream |
| cohort comparison | 介入前後の同一プロジェクト内 task 群を「baseline cohort」「evaluation cohort」に分け、metric 平均と分布を統計検定で比較する評価方式 | `11-metrics.md#42-cohort-comparison-の手順` | baseline period / evaluation period |
| baseline period | 介入導入前に連続 N day 取得する metric 観測期間。CodeDNA 評価の比較基準点 | `11-metrics.md#41-baseline-period--evaluation-period-の定義` | cohort comparison / evaluation period |
| evaluation period | 介入導入後に連続 N day 取得する metric 観測期間。baseline と統計検定で比較する | `11-metrics.md#41-baseline-period--evaluation-period-の定義` | cohort comparison / baseline period |
| header rot | エージェント `{{COMMON_HEADER}}` 等のテンプレートヘッダーが古くなり、現行の運用と乖離した状態。副作用系 metric として観測対象 | `11-metrics.md#25-副作用系` | agent message GC / `{{COMMON_HEADER}}` |
| agent message GC | サブエージェント実行時に蓄積するメッセージ履歴の累積 token 量、および定期的な剪定処理。副作用系 metric として観測対象 | `11-metrics.md#25-副作用系` | header rot / token consumption |

> 補足: タスク本文の「5 用語」は `baseline period / evaluation period` を 1 用語として数えていた可能性があるが、glossary では別エントリにする方が検索性が高いため 6 行とする。差分は 1 行のみで実害なし。

---

## E. CLAUDE.md 追記内容（最小変更方針）

**採用方針: 候補 2（最小変更） — m-3 対応**

理由: 現行 CLAUDE.md は H2 セクションが 20+ 個あり、metrics 用に新 H2 を追加すると散漫化・既存トーンとの不整合を招く。既存表への 1 行追加に留める方が現行 CLAUDE.md と整合する。

Implementer が CLAUDE.md に加える変更は **2 箇所のみ**:

### E.1 「リポジトリ構造」表（L75-82）に 1 行追加

```markdown
| `docs/spec/11-metrics.md` | Metrics taxonomy（6 軸）・data source・CodeDNA 評価判定基準 |
```

### E.2 「進捗情報の取得方法」表（L192-196）に 1 行追加

```markdown
| metric サマリ（task lifecycle / tool call / token） | `cmux-team metrics --since 7d` または `cmux-team metrics --group-by day --format csv` |
```

**やらないこと**:
- 新 H2 セクション「## Metrics（観測指標）」は **作らない**
- 「既知の注意点」セクションにも追記しない（既存表の 2 箇所更新のみで十分情報が届く）

候補 1（H2 増設）は本タスクで採用しない。spec の存在は「リポジトリ構造」表で示し、操作方法は「進捗情報の取得方法」表で示すことで、新 H2 を増やさず既存トーンを維持する。

---

## F. T379 整合チェック方針（Done 直前チェックリスト）

Implementer は spec を書き終えた段階で以下を **手で** 確認し、結果を本 plan.md の隣に `t379-verify.md` として残す。

### F.1 metric 名と計算式の整合

```bash
# spec の metric 名がコード上の symbol と一致するか
grep -nE 'tool_call_total|tool_failure_rate|time_to_first_edit_ms|deny_rate|tool_call_stddev|duration_ms_mean|completion_rate|abort_rate|forced_close_rate' \
  docs/spec/11-metrics.md \
  skills/cmux-team/manager/metrics-aggregate.ts \
  skills/cmux-team/manager/metrics-cli.ts
```

各 metric につき spec / aggregate / cli の 3 ファイルすべてに出現することを目視確認。

### F.2 SQL CTE 名と JOIN key

`session_to_task` CTE 名と `MIN(task_id) GROUP BY session_id` 集約が spec §3.5 に出現するか:

```bash
grep -n 'session_to_task' docs/spec/11-metrics.md skills/cmux-team/manager/trace-store.ts
```

### F.3 events.jsonl の terminal 4 event

spec §3.1 の terminal event 列挙が `metrics-aggregate.ts:113-118` の `TERMINAL_EVENTS` set と一致:

```bash
grep -n 'task_completed\|task_aborted\|task_completed_state_mismatch\|conductor_disconnect_timeout' \
  docs/spec/11-metrics.md skills/cmux-team/manager/metrics-aggregate.ts
```

### F.4 出力 JSON フィールド名（PerTaskMetrics / PerBucketMetrics）

```bash
# spec §5 の例の field 名が interface と一致
grep -nE '^\s+(task_id|outcome|assigned_ts|closed_ts|duration_ms|tool_calls|tool_call_total|tool_failure_rate|time_to_first_edit_ms|tokens):' \
  skills/cmux-team/manager/metrics-aggregate.ts
```

### F.5 Caveats 3 点の転載

`help_metrics` の 3 点が spec §6 に揃っているか目視:
- deny_rate = Bash deny 限定（汎用 hook block 率ではない）
- task_assigned 前 hook は集計外
- tool_response.content は 1KB 切り詰め

### F.6 CLI 例の妥当性

実環境で 3 例を実行し、spec §5 の期待出力スキーマと整合することを確認。**global インストール版 / source 直接実行の両方を併記** — **m-7 対応**（worktree 内で global 版とソース版が乖離する可能性があるため、source ベースで検証できる手段を残す）。

```bash
# 方式 A: global インストール版
cmux-team metrics --since 7d --format json | jq '.[0] | keys'
cmux-team metrics --group-by day --since 14d --format csv | head -2
cmux-team metrics --task-id 379 --format text

# 方式 B: worktree 内 source 直接実行（検証時の優先手段）
bun run skills/cmux-team/manager/main.ts metrics --since 7d --format json | jq '.[0] | keys'
bun run skills/cmux-team/manager/main.ts metrics --group-by day --since 14d --format csv | head -2
bun run skills/cmux-team/manager/main.ts metrics --task-id 379 --format text
```

field 名が spec §5 例と完全一致することを確認。両方式の出力が一致することも確認（不一致なら global 版が古い可能性あり）。

### F.7 glossary 参照リンク

```bash
# 6 用語が glossary §11 にすべて入っているか
grep -nE 'metrics SSOT|cohort comparison|baseline period|evaluation period|header rot|agent message GC' \
  docs/spec/glossary.md
```

### F.8 CLAUDE.md の差分

```bash
git diff CLAUDE.md  # 「リポジトリ構造」表に 1 行 + 「進捗情報の取得方法」表に 1 行（合計 +2 行）
```

最小変更方針（§E 参照）に従い、新 H2 セクションは追加しない。差分が 2 行のみであることを確認する。

---

## G. 作業順序とリスク

### G.1 作業順序

1. `docs/spec/11-metrics.md` を新設（§1〜§7 を埋める）
   - 先に §3 Data sources（事実から）
   - 次に §2 Metrics taxonomy（6 軸の表）
   - その次に §4 CodeDNA 評価判定基準（仮置き値含む）
   - 最後に §1 概要 / §5 CLI 例 / §6 Caveats / §7 関連
2. `docs/spec/glossary.md` に §11「Metrics 関連」を追加（6 用語）
3. `CLAUDE.md` を更新（最小変更方針: 「リポジトリ構造」表 1 行 + 「進捗情報の取得方法」表 1 行のみ。新 H2 は追加しない）
4. F.1〜F.8 のチェックリストを上から実行し、結果を `t379-verify.md` に追記
5. 全ファイルを `git diff --stat` で量的確認 → close-task

### G.2 想定リスクと対処

| リスク | 影響 | 対処 |
|---|---|---|
| **警報閾値の数値が baseline 未計測** | 撤退判断ができない / 数値の固定化に説得力がない | spec §4.4 の閾値表に「**[暫定] baseline 計測前 — 業界経験則ベース**」の注釈を必ず付ける。例: `+30%` 等の根拠は「相対比較・CV 0.3 想定の経験則」。baseline 取得後の commit で更新するため、§4.4 末に「閾値レビュータスク」へのリンクを残す |
| **副作用系 N metric 同時検定で familywise α が膨張** — **M-2 対応** | 4 metric 検定で実効的 false positive rate が ~18% に達し、撤退判定が偽陽性で揺れる | spec §4.4 で多重比較補正を明記。推奨は Benjamini-Hochberg（FDR 制御、adjusted p<0.05）、代替は Bonferroni（α/N）。式レベルで明示し、Implementer が実装時に決め打ちで済むようにする |
| **N=14 day baseline period の根拠不在** — **m-5 対応** | レビューで「なぜ 14 日?」が再発する | spec §4.1 に「cohort 内 task 数 30+ を確保しやすい短期境界として暫定設定」と明記し、後続タスクで再評価する旨を併記 |
| **5 軸 vs 6 軸の不整合**（タスク本体は 5 軸） | spec とタスク本体のラベルがずれる | ユーザー確定の **6 軸** を spec の正とし、タスク本文と差分があることを §1 注釈で明示 |
| **未実装 metric を「実装済み」と誤記** | spec が嘘になる | §2 の各テーブルに「実装ステータス」列を必ず置き、`metrics-aggregate.ts` の interface に **存在しない** field は `taxonomy 上定義のみ` 固定 |
| **deny_rate の意味が誤読される** | metric を間違って解釈 | §2.2 と §6 の **両方** で「Bash deny 限定」を明記。`help_metrics` 引用も必ず転載 |
| **session_to_task CTE 名の誤記** | SQL 例が動かない | §3.5 で CTE 全文を `trace-store.ts:1179-1184` から逐語コピー（行番号もコメント） |
| **glossary が一次定義を抱え込む** | DRY 違反、片方が腐る | glossary §11 は要約 1-2 行 + 一次リンクのみ。詳細は 11-metrics.md だけに置く |
| **CodeDNA 統計検定の選択基準が曖昧** — **m-4 対応強化** | 後で恣意的判定になる | §4.3 で n=30 / 正規性 / homoscedasticity の 3 条件を明示し、フローチャートを 3 行で書く。**正規性検定は n<30→Shapiro-Wilk / n≥30→CLT 仮定**、**等分散性は Levene 検定 → 不等なら Welch** を事前確定する |
| **CLI 例の出力 schema が将来変わる** | spec が腐る | §5 の例は `keys` の列挙だけにし、具体的な数値は出さない（実装変更で grep が壊れない） |

### G.3 やらないこと

- **コード変更は一切なし** — `metrics-aggregate.ts` / `metrics-cli.ts` / `trace-store.ts` / `i18n.ts` を Implementer が触る必要はない（spec が実装に追随する）
- **未実装 metric の実装は別タスク** — §C で `taxonomy 上定義のみ` とラベルした metric は本タスクの範囲外（後続 issue として spec §7 から参照）
- **baseline 計測の実施は別タスク** — §4 で「baseline 取得は手順の定義のみ」、実際の計測ジョブ作成は本タスクの範囲外

---

## H. 出力先

- 本 plan.md: `/Users/yamamoto/git/cmux-team/.worktrees/task-380-1777565426/.team/tasks/380-metrics-spec-docs-spec-11-metrics-md/runs/task-380-1777565426/plan.md`
- 後続フェーズの成果物:
  - `/Users/yamamoto/git/cmux-team/.worktrees/task-380-1777565426/docs/spec/11-metrics.md`（新規）
  - `/Users/yamamoto/git/cmux-team/.worktrees/task-380-1777565426/docs/spec/glossary.md`（更新）
  - `/Users/yamamoto/git/cmux-team/.worktrees/task-380-1777565426/CLAUDE.md`（更新）
  - `/Users/yamamoto/git/cmux-team/.worktrees/task-380-1777565426/.team/tasks/380-metrics-spec-docs-spec-11-metrics-md/runs/task-380-1777565426/t379-verify.md`（チェック結果）

以上。

---

## 改訂履歴

### rev2（design-review.md 反映、Major 3 + Minor 8）

- **M-1**: §C のマトリクスで `tool_failure_rate` を「2.2 制約違反系」→「2.1 探索コスト系」へ移動。§B §2.1 末尾に「`tool_failure_rate` は POST_TOOL_USE の success=false / error≠null の率であり、deny script による事前 block ではない」を 1 行注釈する方針を追加。§C §2.2 制約違反系には `deny_rate` のみを残す
- **M-2**: §B §4.4 に多重比較補正（推奨: Benjamini-Hochberg FDR / 代替: Bonferroni）を追加。「副作用系 N metric 検定時の閾値: α/N（Bonferroni）または BH 補正後 adjusted p<0.05」を式レベルで明記。§G.2 リスク表にも対応行を追加
- **M-3**: §B §1 概要に「実装の SSOT は `metrics-aggregate.ts`（CLI 側）。`dashboard-metrics.ts` は同じ `trace-store.ts` の SQL を呼ぶ別系統の UI ビルダーで、CLI と互換する数値を Metrics タブに表示する」を 2-3 行で追加。spec で扱う SSOT が CLI 側であることを明示
- **m-1**: §A.1 の `PerTaskMetrics` 説明に `assigned_ts` / `closed_ts` を追加、`PerBucketMetrics` 説明に `bucket` を追加
- **m-2**: §B §3.5 予告に「同一の `session_to_task` CTE が `countToolCallsByTask` / `firstEditPerTask` / `failureRateByTask` の 3 関数に複製されている事実を脚注で示す」を追加（行番号 1179-1184 / 1219-1225 / 1257-1263 を併記）
- **m-3**: §E の推奨を **候補 2（最小変更）** に切り替え。「リポジトリ構造」表に 1 行 + 「進捗情報の取得方法」表に 1 行のみ、新 H2 セクションは作らない。理由（H2 が 20+ あり散漫化回避）を §E に明記。§A.7 / §G.1 / §F.8 も同方針に整合
- **m-4**: §B §4.3 に「正規性検定: n<30 は Shapiro-Wilk、n≥30 は CLT 仮定で正規性を許容」「等分散性: Levene 検定 → 不等なら Welch」を 1 行ずつ事前確定として追加。§G.2 リスク表も更新
- **m-5**: §B §4.1 に「N=14 day は cohort 内 task 数 30+ を確保しやすい短期境界として暫定設定。後続タスクで再評価」を予告。§G.2 リスク表に対応行を追加
- **m-6**: §B §2.1 末尾 disclaimer として「探索コスト系の variance / 平均は §2.6 俯瞰系に集約する（軸の二重カウント回避）」を追加。§C の `tool_call_stddev` の置き先（俯瞰系）はそのまま
- **m-7**: §F.6 のコマンド例に `bun run skills/cmux-team/manager/main.ts metrics ...` の source 直接実行手段を併記。global 版と source 版の両方で出力一致を確認する旨も明記
- **m-8**: §B §5 text 例の予告に「`tool_calls` は JSON-encoded value として 1 行内に埋め込まれる（例: `tool_calls={"Read":12,"Edit":3,...}`）」とパース方法を明示

### rev1（初稿）

- §A 引用源インデックス、§B 章構成（7 章）、§C 6 軸 × T379 metric マトリクス、§D glossary 6 用語、§E CLAUDE.md 追記内容、§F 整合チェック方針、§G 作業順序とリスク、§H 出力先 を初版として作成
