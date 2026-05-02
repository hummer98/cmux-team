---
id: 412
title: メトリクス解析基盤: cmux-team metrics query CLI + cmux-team-analyze skill (DuckDB ad-hoc 解析)
priority: medium
created_at: 2026-05-01T23:47:17.467Z
---

## タスク
## 背景・動機

`docs/spec/11-metrics.md` で定義された 6 軸 metric は CLI (`cmux-team metrics`) と daily snapshot で集計できる状態だが、**ad-hoc な探索的解析**（cohort 切り直し、複数 data source 横断 JOIN、異常 task の絞り込み等）の手段が無い。現状 AI が metric 解析を必要とした場合、TypeScript で集計 script を書き起こすか `jq` + `sqlite3` を組み合わせる必要があり、reach のコストが高い。

DuckDB は `read_json('*.json')` / `read_csv` / `ATTACH ... (TYPE sqlite)` で **異種ファイル形式を 1 つの SQL で JOIN できる**ため、cmux-team の trace DB (SQLite) / snapshots (JSON) / events.jsonl を横断する ad-hoc 解析に最適。ただし AI は訓練データ bias で DuckDB を自発的に使わない傾向があるため、**CLI + skill + CLAUDE.md の 3 段で reach を矯正する**必要がある。

storage 層は SQLite のまま据え置く（書き込み並行性のため。daemon write × CLI read の workload は SQLite WAL が最適）。DuckDB は **read-only attach の analyzer 専用**として導入する。

## 実装内容

### Piece 1: `cmux-team metrics query <SQL>` CLI

- DuckDB を裏で起動し、以下を pre-attach した状態で SQL を流す薄い wrapper
  - `traces.db` を SQLite extension で read-only attach（`ATTACH '.team/traces/traces.db' AS t (TYPE sqlite, READ_ONLY)`）
  - `read_json('.team/metrics/snapshots/*.json')` を view として登録
  - `read_json('.team/logs/events.jsonl', format='nd')` を view として登録
- 出力 format: `--format json|csv|tsv|table`（default table）
- 引数: `--sql <SQL>` または stdin から SQL を受ける
- `duckdb` バイナリの存在確認 + 不在時は install 手順を案内
- 実装場所: `skills/cmux-team/manager/metrics-query.ts` + `metrics-cli.ts` から呼び出し

### Piece 2: `skills/cmux-team-analyze/SKILL.md`

- **Trigger description**（sharp に書く）:
  - 「メトリクス解析」「cohort 比較」「介入評価」「trace DB から〜」「DuckDB で〜」「baseline 比較」等の言及
  - AI 自身が「複数 task / 時系列 trend を見たい」と判断したとき
  - 既存 `trace-task` skill との棲み分け: `trace-task` = per-task 履歴、本 skill = 複数 task / 時系列 / cohort
- **Body 構成**:
  - 起動条件・棲み分け
  - DuckDB recipe ライブラリ（5〜10 個、§11 spec の SQL 例を実走可能形式に整形）
    - per-task token 集計
    - cohort 抽出（baseline vs evaluation の period filter）
    - claim-vs-diff 検出（summary mention vs git diff のファイル一致率）
    - forced_close 原因絞り込み（直前 N 件の hook_signals）
    - tool_failure 連鎖検出（同 session 内の連続失敗）
    - SESSION_STARTED の loaded_plugins / loaded_skills cohort filter
  - §11 spec への cross-link

### Piece 3: CLAUDE.md 1 行追記

- 「メトリクス解析・cohort 比較・trace DB の ad-hoc 探索は \`cmux-team-analyze\` skill を参照」
- 配置場所: 「Manager プロトコル」直後、または「進捗情報の取得方法」表の下

## 受入条件

- [ ] \`cmux-team metrics query --sql 'SELECT COUNT(*) FROM t.api_usage'\` が動作
- [ ] \`cmux-team metrics query\` で snapshots と traces.db を JOIN するクエリが通る（README 例の 1 つ）
- [ ] \`skills/cmux-team-analyze/SKILL.md\` が作成され、5 個以上の動作確認済み recipe を含む
- [ ] CLAUDE.md に 1 行追記
- [ ] \`docs/spec/11-metrics.md\` から新 skill / CLI への cross-link を追加
- [ ] \`duckdb\` 不在時の error message が install 手順を含む

## 実装順序（Conductor 向けガイド）

1. \`cmux-team metrics query\` CLI を先に実装（最小: SQLite attach + JSON view + format 出力）
2. skill から実 recipe を 5 個書きながら CLI の不足機能（--format / --explain 等）を炙り出して back-fill
3. CLAUDE.md / spec への cross-link は最後

## 関連 spec / task

- \`docs/spec/11-metrics.md\` §3 Data sources、§7-§13 snapshot / cohort 比較
- T379 / T380 / T381（metric CLI 本体・spec・snapshot 自動収集）
- T407 / T410（session_id pre-inject / loaded_plugins marker）
- 既存 \`skills/cmux-team/SKILL.md\` の trace-task skill との棲み分け

## 議論経緯（参考）

ユーザーとの会話で以下の判断が確定:
- storage 層を DuckDB に置き換えない（SQLite WAL の concurrent write を維持）
- snapshot JSON / events.jsonl / traces.db を **read-only で横断する analyzer** として DuckDB を導入
- 「CLI だけ作っても AI は思いつかない」ため skill + CLAUDE.md で reach を矯正
- 連鎖破壊系 (§2.3) / 知識引き継ぎ系 (§2.4) の semantic 解析（claim-vs-diff 等）は本タスク完了後の後続タスクで議論
