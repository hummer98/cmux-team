# T380 plan.md Design Review

## Verdict

**Changes Requested**

## Summary

Plan は引用源インデックス（§A）の行番号・関数名・interface 名すべて実コード (`metrics-aggregate.ts` / `metrics-cli.ts` / `trace-store.ts`) と一致しており、構造・章立て・glossary 設計・CLAUDE.md 追記方針も妥当。一方で **(1) `tool_failure_rate` の軸分類**、**(2) §4.4 撤退判定の多重比較補正**、**(3) `dashboard-metrics.ts` との関係明示** の 3 点は spec の解釈・運用に直結するため Implementer 着手前に方針を確定させたい。

## Findings

### Critical

なし

### Major

#### M-1. `tool_failure_rate` を「制約違反系」に置くのは不適切

- **観点**: §1 実装との整合性 / taxonomy 6 軸の意味整合性
- **内容**: Plan §C は `tool_failure_rate` を `2.2 制約違反系` に配置している。しかし `failureRateByTask` の判定ロジック（`trace-store.ts:1267-1273`）は `JSON_EXTRACT(payload, '$.payload.tool_response.success') = 0 OR ...tool_response.error IS NOT NULL`、すなわち **「ツール呼び出しが失敗した率」** であり、Edit のミスマッチ・Read の存在しないファイル・Bash のコマンド失敗等を全て含む。これは「ルール違反」ではなく **「無駄な試行コスト」** であり、`2.1 探索コスト系` の方が意味整合的。
  - `deny_rate` は明確に Bash deny script による block 率なので「制約違反系」が妥当。これと `tool_failure_rate` を同じ軸に入れると spec を読む人が両者の semantic な違いを誤認しやすい。
- **修正案**: `tool_failure_rate` を §2.1 探索コスト系に移し、§2.2 制約違反系には `deny_rate` のみを残す。spec §2.1 に「`tool_failure_rate` は POST_TOOL_USE の success=false / error≠null の率であり、deny script による事前 block ではない」と 1 行注釈。

#### M-2. §4.4 撤退判定で多重比較補正が未言及

- **観点**: §1.3 t-test/Wilcoxon の選択基準 / §5 警報閾値の扱い
- **内容**: Plan §B §4.4 / §G.2 リスク表は「副作用系（§2.5）の **1 metric** でも `evaluation 平均 > baseline 平均 × (1 + threshold)` かつ p<0.05 なら撤退」と書く方針。しかし副作用系には `tokens.{input, output, cache, requests}` ＋ 将来追加 metric（header rot 等）が並ぶ。複数 metric を独立検定すると familywise α が膨らみ、α=0.05 でも実効的に偽陽性率が高くなる（4 metric なら ~18%）。撤退判定の意思決定品質に直結する。
- **修正案**: spec §4.4 に「複数 metric を同時検定する場合は Bonferroni（厳格）または Benjamini-Hochberg（FDR 制御、推奨）で補正した α を使う」と明記する方針を plan §B §4.4 / §G.2 に追記。具体的には「副作用系 N metric 検定時の閾値: α/N（Bonferroni）または BH 補正後の adjusted p<0.05」。

#### M-3. `dashboard-metrics.ts` との関係が未整理

- **観点**: §2 spec 構成の妥当性 / §G.2 リスクの抜け
- **内容**: `skills/cmux-team/manager/dashboard-metrics.ts` も `aggregateApiUsageByTask` / `aggregateApiUsageByRole` / `getProjection5h` / `getProjection7d` 等の SQL を呼んでおり、Metrics タブで token 集計を表示している（同ファイル冒頭コメント「責務分担: trace-store.ts / dashboard-metrics.ts / dashboard.tsx」）。spec が CLI metrics の単一視点で書かれると、読者は「dashboard の Metrics タブの数字と `cmux-team metrics` の出力は同じか？」を判断できない。
  - 実態: dashboard は token + rate limit + Pool Tokens（CLI に無し）、CLI は task lifecycle + tool call + token（dashboard に無し）。共通項は token 系の SQL のみ。
- **修正案**: spec §1 概要または §3 冒頭に「実装の SSOT は `metrics-aggregate.ts`（CLI 側）。`dashboard-metrics.ts` は同じ `trace-store.ts` の SQL を呼ぶ別系統の UI ビルダーで、CLI と互換する数値を Metrics タブに表示する。両者の責務分担はそれぞれのモジュール冒頭コメントを参照」を 2-3 行で追加。Plan §B §1 概要のサブ箇条に明示。

### Minor

#### m-1. `assigned_ts` / `closed_ts` / `bucket` フィールドが §A.1 列挙で漏れ

- **観点**: §1 実装との整合性
- **内容**: Plan §A.1 の `PerTaskMetrics` 説明は `(task_id, outcome, duration_ms, tool_calls, ...)` と書くが、interface には `assigned_ts` / `closed_ts` も含む（`metrics-aggregate.ts:42-43`）。同様に `PerBucketMetrics` の説明から `bucket` フィールド（`metrics-aggregate.ts:59`）が抜けている。引用源は実装の SSOT として参照される予定なので spec §5 で例を書く際に拾い漏れる懸念。
- **修正案**: §A.1 の括弧内列挙に `assigned_ts / closed_ts` / `bucket` を加える。

#### m-2. `session_to_task` CTE が 3 関数に複製されている事実が未言及

- **観点**: §1 実装との整合性 / §2.5 join key 説明
- **内容**: Plan §B §3.5 は `countToolCallsByTask` から CTE を引用する方針。しかし `firstEditPerTask`（`trace-store.ts:1219-1225`）と `failureRateByTask`（`trace-store.ts:1257-1263`）でも同じ CTE がコピペされている。spec §3.5 で「3 つの SQL 関数すべてが同じ CTE を持つ（cohort: countToolCallsByTask / firstEditPerTask / failureRateByTask）」と一言入れると正確。
- **修正案**: §B §3.5 の予告に「CTE は 3 関数に複製されている事実を脚注で示す」を追加。

#### m-3. CLAUDE.md は H2 増設より既存表への 1 行追加が好ましい

- **観点**: §4 CLAUDE.md 追記 / 既存トーンとの整合
- **内容**: CLAUDE.md は H2 セクションが 20+ 個あり、metrics 用に新規 H2 を増やすと散漫化の懸念。既存「進捗情報の取得方法」表（L192-196）に `cmux-team metrics` の行を追加 + 「リポジトリ構造」表に `docs/spec/11-metrics.md` 行を追加、の **最小変更（plan §E 候補 2）** の方が現行 CLAUDE.md と整合する。
- **修正案**: §E の推奨を候補 2（最小変更）に切り替えるか、候補 1 を採用するなら CLAUDE.md レビュアー（DocKeeper）にレビューを依頼する方針を §G.2 のリスクに追加。

#### m-4. 統計検定選択フローの粒度

- **観点**: §1.3 t-test / Wilcoxon の選択基準
- **内容**: Plan §G.2 で「§4.3 で n=30 / 正規性 / homoscedasticity の 3 条件を明示し、フローチャートを 3 行」と書く。正規性検定の具体手段（Shapiro-Wilk か CLT 仮定か）が Implementer 任せだと、spec のレビューサイクルで再ブレが起きやすい。
- **修正案**: plan §B §4.3 に「正規性検定: n<30 は Shapiro-Wilk、n≥30 は CLT 仮定で正規性を許容」「等分散性: Levene 検定 → 不等なら Welch」を 1 行ずつ事前確定。

#### m-5. baseline period N=14 day の根拠が未記述

- **観点**: §5 警報閾値の扱い
- **内容**: Plan §B §4.1 で「暫定 N=14」と書くが §G.2 リスク表には baseline 計測前の暫定値の話のみで、N=14 自体の根拠が無い。
- **修正案**: spec §4.1 に「N=14 day は cohort 内 task 数 30+ を確保しやすい短期境界として暫定設定」を 1 行。後続タスクで N を再評価する旨も併記。

#### m-6. `tool_call_stddev` の軸分類

- **観点**: §1 taxonomy 設計
- **内容**: Plan §C は `tool_call_stddev` を「俯瞰系」に置くが、これは「task 間で tool call 数がどれだけばらつくか」なので「探索コスト系の variance 指標」とも解釈可能。Plan の justify が無い。
- **修正案**: spec §2.1 末尾に「探索コスト系の variance / 平均は §2.6 俯瞰系に集約する（軸の二重カウント回避）」と 1 行 disclaimer を入れて意図を明示。

#### m-7. F.6 の CLI 実行手段が global インストール前提

- **観点**: §6 整合チェック方針
- **内容**: F.6 の `cmux-team metrics ...` は global CLI 前提だが、worktree 内で global 版とソース版が乖離する可能性あり。Implementer の検証時に source ベースで実行できないと検証品質が下がる。
- **修正案**: F.6 のコマンド例に `bun run skills/cmux-team/manager/main.ts metrics ...` 等の source 直接実行手段を併記。

#### m-8. text format の `tool_calls=` フィールドが JSON-encoded である注記

- **観点**: §2 spec §5 CLI 出力例の正確性
- **内容**: `formatTextPerTask`（`metrics-cli.ts:140`）は `tool_calls=` を `fmtTextValue(r.tool_calls)` で出力し、object なので JSON.stringify される。spec §5 の text 例で `tool_calls={"Read":12,"Edit":3,...}` の形を必ず示し、parse 方法（json と違い 1 行に key=value space-separated だが値部分は JSON-encoded） を 1 行で示すと利用者が混乱しない。
- **修正案**: §B §5 の text 例の予告に「`tool_calls` は JSON-encoded value として 1 行内に埋め込まれる」と明示。

## Recommendations

Planner が plan.md を再改訂する際の優先順位:

1. **M-1**（軸分類修正）— spec §C のマトリクス全体に波及するため最優先で確定。
2. **M-2**（多重比較補正）— spec §4.4 撤退判定の数式に直結。
3. **M-3**（dashboard 関係）— spec §1 / §3 に短い説明を追加するだけで spec の信頼性が上がる。
4. **m-3**（CLAUDE.md 最小変更案への切り替え）— H2 増設の妥当性をユーザーに確認するか、最小変更で commit。
5. m-1 / m-2 は plan の文言修正のみで完結するので一括対応可。
6. m-4 / m-5 / m-6 / m-7 / m-8 は spec 本体に直接書き込まれる節なので Implementer フェーズで対応してもよい（plan 改訂の必須ではない）。

## Approved-as-is sections

レビューで合意できた章:

- **§A 引用源インデックス**: 行番号・関数名・interface 名すべて実コードと一致確認済み（M-1〜M-3 とは別個）
  - `Outcome`/`PerTaskMetrics`/`PerBucketMetrics`/`PeriodSummary`/`stddev`/`TERMINAL_EVENTS`/`classifyOutcome`/`readTaskLifecycle`/`aggregatePeriod`/`aggregateMetricsByTask`/`bucketKey`/`aggregateMetricsByBucket`（`metrics-aggregate.ts`）
  - `RunMetricsCliOpts`/`KNOWN_FLAGS`/`FLAGS_WITH_VALUE`/`PER_TASK_HEADER`/`PER_BUCKET_HEADER`/`formatTextPerTask`/`formatTextPerBucket`/`runMetricsCli`（`metrics-cli.ts`）
  - `SCHEMA`/`task_sessions`/`hook_signals`/`api_usage`/`aggregateApiUsageByTask`/`countToolCallsByTask`/`firstEditPerTask`/`failureRateByTask`/`denyRateByPeriod`（`trace-store.ts`）
  - `session_to_task` CTE 範囲 `trace-store.ts:1179-1184` も逐語確認
- **§B 章構成（目次プロポーザル）**: 7 章構成は他の docs/spec/ ファイル（`10-events-stream.md` 等）と整合
- **§D glossary 追加 6 用語の挿入位置と列構成**: 既存 §10 直後に §11 として追加、二次資料方針・列構成（用語/定義/一次リンク/関連）すべて既存 glossary と整合。`baseline period` / `evaluation period` を別エントリ化する判断も検索性の観点から妥当
- **§F 整合チェックリスト F.1〜F.5 / F.7 / F.8**: F.6 のみ m-7 で指摘、その他は実用的
- **§G.1 作業順序**: Data sources → taxonomy → 評価 → 概要 の順は事実 → 解釈の組み立て方として妥当
- **§G.3 やらないこと**: コード変更なし / 未実装 metric は別タスク / baseline 計測は別タスク、いずれも本タスクの scope 設定として妥当
