# T412 Implementer Report

> Worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-412-1777679258/`
> Branch: `task-412-1777679258/task`
> Output ファイル仕様は plan.md §「出力先」を参照。

## Completed Tasks

| # | サブタスク | 状態 |
|---|-----------|------|
| S1 | `metrics-query.ts` 骨格 + 引数 parse | ✅ |
| S2 | init SQL ビルダ + view registration | ✅ |
| S3 | DuckDB binary 解決 + Bun.spawn | ✅ |
| S4 | `--explain` モード | ✅ |
| S5 | `main.ts` dispatch 追加 | ✅ |
| S6 | i18n 追加 (`help_metrics_query`) | ✅ |
| S7 | テスト網羅 `metrics-query.test.ts` | ✅ |
| S8 | skill 作成 `cmux-team-analyze` | ✅ |
| S9 | CLAUDE.md cross-link 追記 | ✅ |
| S10 | `docs/spec/11-metrics.md` cross-link | ✅ |
| S11 | 受入条件動作確認 | ✅ |
| S12 | ndjson mode | ⏭ scope 外（plan.md 通り skip） |

## Files Changed

### 新規作成

- `skills/cmux-team/manager/metrics-query.ts` — DuckDB ad-hoc CLI wrapper（core 実装、Bun.spawn + init SQL builder + format flag mapping + abort 連動）
- `skills/cmux-team/manager/metrics-query.test.ts` — per-file 単独実行テスト 31 ケース（fake duckdb 経由、実 binary 非依存）
- `skills/cmux-team-analyze/SKILL.md` — DuckDB recipe ライブラリ（R1〜R6 + R7〜R9 後続候補スタブ）

### 変更

- `skills/cmux-team/manager/main.ts` — `import { runMetricsQueryCli }` を追記し、`cmdMetrics` 内に `if (sub === "query")` 分岐を追加（既存 snapshot/compare/health と同形式の `runWithAbort` 経由）
- `skills/cmux-team/manager/i18n.ts` — `help_metrics` の Subcommands 表に `query` 行を追加（en/ja 両方）。`help_metrics_query` を新設（en/ja 両方、両 namespace 確認: `grep -n 'help_metrics_query' i18n.ts` → 2 件 hit）
- `CLAUDE.md` — 「進捗情報の取得方法」表直下に 1 行 cross-link を追記
- `docs/spec/11-metrics.md` — §5 末尾に §5.5「ad-hoc DuckDB クエリ（T412）」セクションを追加。§14「関連コード」に `metrics-query.ts` を、新たに「関連 skill」項目を追加して `skills/cmux-team-analyze/SKILL.md` を載せる

### 削除

なし。

## TDD Cycles / Verification Results

### サイクル 1: parseQueryArgs / buildInitSql / resolveDuckdbBin / formatToFlag

**RED**: テスト 19 ケースを先に書き、import 失敗を確認。
**GREEN**: `metrics-query.ts` を実装し、export 4 個を解決。
**REFACTOR**: `escapeSqlString` を private helper に分離。

### サイクル 2: runMetricsQueryCli end-to-end

**RED**: fake duckdb (bash script) に対する 12 ケースを書き、`writer.getWriter is not a function` で fail。
**GREEN**: Bun.spawn の `proc.stdin` は `FileSink` を返すので `sink.write()` + `await sink.end()` の API に修正。
**REFACTOR**: env を明示的に Bun.spawn に渡す形に統一（process.env の伝播を確実にし、テスト側の env 上書きが反映されるようにした）。

### 最終 per-file test run

```
$ cd skills/cmux-team/manager && bun test --timeout 30000 metrics-query.test.ts
 31 pass
 0 fail
 66 expect() calls
Ran 31 tests across 1 file. [6.57s]
```

### 既存テストへのリグレッション

```
$ bun test --timeout 30000 metrics-cli.test.ts        → 18 pass / 0 fail
$ bun test --timeout 30000 metrics-snapshot.test.ts   → 15 pass / 0 fail
```

### TypeScript check

```
$ cd skills/cmux-team/manager && bunx tsc --noEmit
(no output, exit 0)
```

## Recipe Verification (S8)

`PROJECT_ROOT=/Users/yamamoto/git/cmux-team` (本物の `.team/`) で 6 recipe を smoke。
DuckDB v1.5.2 (Variegata) を `brew install duckdb` で導入。

| recipe | 結果 | 備考 |
|--------|------|------|
| **R1**: per-task token 集計 | ✅ EXIT=0 | top 5 task の input/output/cache token + api_requests を JSON で取得。task_id="410" が input=8343 / output=130172 / cache=23.9M でトップ |
| **R2**: cohort 抽出 (baseline vs evaluation) | ✅ EXIT=0 | snapshots 範囲 `2026-04-29..29` (空) と `2026-04-30..30` (12 task) で対比。完了確認後 skill 内の `both` を `combined` にリネーム（DuckDB 予約語対応） |
| **R3**: forced_close 直前の hook_signals | ✅ EXIT=0 | `[]` だが構文・JOIN は通る（最近 forced_close 案件無し）。`h.timestamp BETWEEN ...` を `CAST(h.timestamp AS TIMESTAMP) BETWEEN ...` に修正（VARCHAR を TIMESTAMP として比較する明示 cast を skill にも反映） |
| **R4**: tool_failure 連鎖検出 | ✅ EXIT=0 | 初回試行で `Malformed JSON at byte 67942` で 1 行が原因の error。`json_valid(payload_json)` を WHERE に追加して mitigate（best-effort 原則）。比較演算子も `= 'false'` → `= 0` に統一（spec §3.2 `failureRateByTask` SQL と一致） |
| **R5**: SESSION_STARTED loaded_plugins cohort filter | ✅ EXIT=0 | task=412/411 の最近 5 session が `plugin_state=unknown` で並ぶ（旧 client / fallback 経路）。skill にも `json_valid` filter を反映 |
| **R6**: per-day trend (snapshots_per_task) | ✅ EXIT=0 | `2026-04-30` で tasks_n=12 / completed=11 を確認。`snapshots × snapshots_per_task` UNNEST 経路の動作確認 |

### Skill 内 recipe 修正点（実 binary smoke で発覚）

実機検証で発見した DuckDB 1.5 の挙動に合わせて、以下を skill 本文へ back-fill 済み:

1. R2: CTE alias `both` → `combined`（DuckDB 予約語）
2. R3: `h.timestamp BETWEEN ts1 AND ts2` → `CAST(h.timestamp AS TIMESTAMP) BETWEEN ts1 AND ts2`（VARCHAR 列を TIMESTAMP と比較する明示 cast）
3. R4: `JSON_EXTRACT(...) = 'false'` → `json_extract(...) = 0`（spec §3.2 一致）+ `json_valid(payload_json)` filter 追加
4. R5: `JSON_TYPE` / `JSON_EXTRACT` を lowercase 表記に統一 + `json_valid(h.payload_json)` filter 追加

## Acceptance Criteria Check

| 受入条件 | 結果 |
|----------|------|
| 1. `cmux-team metrics query --sql 'SELECT COUNT(*) FROM t.api_usage'` が動作 | ✅ `PROJECT_ROOT=/Users/yamamoto/git/cmux-team` 下で `count_star() = 15451` を 0 exit + 1 行 stdout で取得 |
| 2. snapshots × traces.db を JOIN するクエリが通る | ✅ `snapshots_per_task` LEFT JOIN `t.api_usage` で per-task の snapshot outcome + API token 集計 (R1 拡張形) を 5 行返す |
| 3. `skills/cmux-team-analyze/SKILL.md` が作成され、5 個以上の動作確認済み recipe を含む | ✅ R1〜R6 の 6 recipe、すべて smoke 済み（R7〜R9 は後続候補スタブ） |
| 4. CLAUDE.md に 1 行追記 | ✅ `grep -n 'cmux-team-analyze' CLAUDE.md` → 1 件 hit |
| 5. `docs/spec/11-metrics.md` から新 skill / CLI への cross-link を追加 | ✅ `grep -n 'metrics query\|cmux-team-analyze' docs/spec/11-metrics.md` → 6 件 hit |
| 6. `duckdb` 不在時の error message が install 手順を含む | ✅ `brew install duckdb` 前に確認: stderr に `brew install duckdb` / `https://duckdb.org/docs/installation/` / `https://github.com/duckdb/duckdb/releases` / `DUCKDB_BIN=...` 4 行と `DuckDB 0.10+ 推奨: -box flag のため` を含めて exit 1 |

### 動作確認コマンドログ

```bash
# 受入条件 6 (binary 不在時)
$ PROJECT_ROOT="$(pwd)" bun .../main.ts metrics query --sql 'SELECT 1'
Error: 'duckdb' binary not found in PATH (and DUCKDB_BIN is not set).
cmux-team metrics query は DuckDB CLI を必要とします（DuckDB 0.10+ 推奨: -box flag のため）。...
EXIT=1

# 受入条件 1
$ brew install duckdb       # → v1.5.2 (Variegata)
$ PROJECT_ROOT=/Users/yamamoto/git/cmux-team bun .../main.ts metrics query \
    --sql 'SELECT COUNT(*) FROM t.api_usage'
┌──────────────┐
│ count_star() │
├──────────────┤
│ 15451        │
└──────────────┘
EXIT=0
```

## Issues Encountered

### I1: Bun.spawn の env 継承

`process.env` を直前に書き換えてから `Bun.spawn` を呼んでも、テスト用の env (INPUT_PATH 等) が伝播せずに default 値に fallback する事象に遭遇。original cause を解析して `env: { ...process.env }` を Bun.spawn に明示的に渡す形に統一。本番経路でも env 継承が確実になる副作用があり、結果的に良い変更。

### I2: hook_signals.timestamp の VARCHAR

DuckDB の SQLite ATTACH では `hook_signals.timestamp` は VARCHAR (TEXT) のまま見える。`BETWEEN <timestamp>` で TIMESTAMP リテラルと比較すると **Binder Error: Cannot mix values of type VARCHAR and TIMESTAMP** が出るため、recipe 内の比較式は `CAST(h.timestamp AS TIMESTAMP)` を明示する必要がある（R3 で発覚 → skill に反映）。

### I3: malformed payload_json 行が 1 件

`hook_signals.payload_json` に malformed (truncated) JSON が含まれる行があり、DuckDB の `json_extract` / `json_type` が **Invalid Input Error: Malformed JSON at byte 67942** で全クエリを倒す。`json_valid(payload_json)` filter を WHERE に追加して mitigate。skill の R4 / R5 に反映済み。

### I4: 既存型エラー

該当なし。`bunx tsc --noEmit` exit 0、touched files / 新規 file ともに型エラー無し。

### I5: cleanup タスクの起票

不要。スコープ内で完結。
