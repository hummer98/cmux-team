# T412 実装計画: メトリクス解析基盤 (cmux-team metrics query CLI + cmux-team-analyze skill)

> Planner: T412 / surface-585-planner-1777679369
> 関連 spec: `docs/spec/11-metrics.md`
> 関連 task: T379 (metrics CLI 本体) / T380 (spec) / T381 (snapshot+compare) / T407 (session_id pre-inject) / T410 (loaded_plugins / loaded_skills marker)

---

## 1. 課題分析

### 1.1 現状の問題点

- 既存 `cmux-team metrics` CLI (`metrics-{cli,aggregate,snapshot,compare,health}.ts`) は **固定 schema の集計** に特化した形で実装されている (`PerTaskMetrics` / `PerBucketMetrics` / `PeriodSummary`)。`--task-id` / `--since` / `--group-by` の 3 軸でしか切り直せず、ad-hoc な探索的解析（cohort 切り直し、異常 task の絞り込み、複数 source 横断 JOIN）はできない。
- 横断したい source は **3 系統** に分かれている:
  - `traces.db` (SQLite, `hook_signals` / `api_usage` / `task_sessions` / `rate_limit_snapshots`)
  - `.team/metrics/snapshots/YYYY-MM-DD.json` (1 ファイル = 1 日 fact, `per_task[]` + `period{}`)
  - `.team/logs/events.jsonl` (NDJSON task lifecycle stream, `schema_version: 2`)
- 「複数 source を JOIN したい」たびに TypeScript 集計関数を書き起こすか、`jq` + `sqlite3` を組み合わせる運用になっており、reach のコストが高い。
- AI（Claude）は訓練データ bias で DuckDB を自発的に使わない。よって CLI を作っただけでは利用されず、skill + CLAUDE.md を組み合わせた reach 矯正が必要。

### 1.2 根本原因

**「異種ファイル形式横断クエリの runtime が無い」** ことに尽きる。SQLite 単体では JSON / JSONL を attach できず、jq 単体では SQL 的 JOIN ができない。両者を埋めるのが DuckDB の `sqlite_scanner` 拡張 + `read_json` 関数。

storage 層（書き込み側）は `daemon write × CLI read` の workload で SQLite WAL が最適なため、**置換ではなく read-only analyzer として並存させる** のが構造的解。

### 1.3 影響範囲

| 領域 | 影響 |
|---|---|
| 既存 `cmux-team metrics` CLI | 影響なし（`metrics query` は新サブコマンドとして追加） |
| 既存 `metrics-{aggregate,snapshot,compare,health}.ts` | 影響なし（DuckDB 経路は別 module で完結） |
| 既存 `trace-task` skill | 役割棲み分けのみ（per-task 履歴は trace-task / 複数 task / 時系列 / cohort は cmux-team-analyze） |
| storage 層 (`trace-store.ts`) | 影響なし（read-only attach のみ） |
| package 配布 | DuckDB binary は **配布物に含めず** 利用者の手元 install を案内する（npm 配布物を膨らませない） |

---

## 2. 技術アプローチ

### 2.1 選択したアプローチ

**`duckdb` 外部 binary を spawn する薄い wrapper を実装し、init SQL を pre-pend してから user SQL を流す。**

```
[cmux-team metrics query --sql "..."]
  ↓
[runMetricsQueryCli (metrics-query.ts)]
  ├─ resolve duckdb binary (env DUCKDB_BIN > $PATH)
  ├─ build init SQL (INSTALL/LOAD sqlite; ATTACH ...; CREATE VIEW events; CREATE VIEW snapshots)
  ├─ build full SQL = init + ";\n" + user SQL
  ├─ spawn `duckdb -<format-flag> :memory: <full-sql via stdin or -c>`
  └─ relay stdout/stderr, exit code
```

#### 採用理由

- **薄い**: 既存集計 module を改変しない。`metrics-aggregate.ts` の派生 schema (`PerTaskMetrics` 等) と独立した経路。
- **AST フリー**: ユーザーから受け取る SQL を解釈しない（DuckDB に丸投げ）。SQL injection 問題は projectRoot 配下の read-only DB 相手なので **escalation 経路が無い**（`READ_ONLY` 強制 + ユーザー自身が打つコマンド）。
- **ローカル install 強制**: DuckDB binary を npm 配布物に含めない。利用者の `~/.duckdb/cli/duckdb` または `brew install duckdb` 経由。binary 不在時のエラーメッセージで案内する。
- **format 切替が CLI flag 直結**: `-json` / `-csv` / `-list` 等は DuckDB CLI が公式サポート。自前 formatter を書かない。
- **abort 伝播**: `Bun.spawn` の `signal: AbortSignal` で SIGTERM 連動。既存 `runWithAbort` helper をそのまま使う。

### 2.2 代替案と却下理由

| 案 | 却下理由 |
|---|---|
| **A. DuckDB の Node binding (`@duckdb/node-api`) を npm dep に追加** | 配布物が肥大（バイナリ 50MB+）。DuckDB は SQL 探索ツールとしての利用が目的で、AI が直接呼ぶわけではない（CLI 越し）ため Node binding の利点は薄い。`bun:sqlite` のような first-class binding でもないため Bun との相性で罠に嵌る危険あり |
| **B. SQLite に JSON/JSONL を毎回 import して横断 JOIN** | 二重管理になる（snapshot fact が SQLite に複製される）。schema migration コストが発生。fact 不変性 (§13) と矛盾 |
| **C. `metrics-aggregate.ts` に cohort filter 引数を増やして固定 schema CLI で対応** | cohort 軸が増えるたびに引数追加 → CLI が膨張する。ad-hoc 性に対して構造的に対応していない（本質: SQL を打ちたい） |
| **D. DuckDB を storage 層に置き換え** | daemon の concurrent write workload に SQLite WAL が最適。書き込み並行性を犠牲にする見返りが無い |

### 2.3 既存パターンとの整合性

- 既存 `metrics-snapshot.ts` / `metrics-compare.ts` / `metrics-health.ts` の **`runFooCli({ args, projectRoot, stdout, stderr, abortSignal }) → Promise<number>` 契約** を踏襲する。
- main.ts 側 `cmdMetrics` に `query` ケースを追加し、`runWithAbort` 経由で signal 連携する（既存 snapshot/compare/health と同じ）。
- error message は `t("help_metrics_query")` で i18n 化（既存 `help_metrics*` と整合）。
- テストは `metrics-query.test.ts` を per-file 実行で書く（CLAUDE.md 「`bun test` 全体実行は禁忌」原則）。

### 2.4 構造的解決の検討

「ad-hoc 解析のたびに固定 schema 集計関数を書き足す」のは典型的な if/else 増殖 anti-pattern。本タスクは **「SQL を runtime として外部化する」** 構造的解決を取る:

- 集計ロジックを **SQL 文字列**（skill の recipe）として外部化 → Conductor / Master / 人間が直接編集可能
- 新しい cohort 軸が必要になっても、**コードを触らず recipe を追加するだけ**で対応できる
- DuckDB は read-only attach に閉じる → 副作用ゼロ

これは CLAUDE.md 「決定論的なものはコードで、判断が必要なものは AI で」原則と整合する（SQL recipe = AI 判断、CLI = 決定論的 runtime）。

### 2.5 init SQL の構成（決定）

`metrics-query.ts` が pre-pend する init SQL は以下を順次実行する:

```sql
INSTALL sqlite; LOAD sqlite;
ATTACH '<projectRoot>/.team/traces/traces.db' AS t (TYPE sqlite, READ_ONLY);
CREATE OR REPLACE VIEW events AS
  SELECT * FROM read_json('<projectRoot>/.team/logs/events.jsonl',
                          format='newline_delimited',
                          union_by_name=true,
                          ignore_errors=true);
CREATE OR REPLACE VIEW snapshots AS
  SELECT * FROM read_json('<projectRoot>/.team/metrics/snapshots/*.json',
                          format='auto',
                          union_by_name=true,
                          ignore_errors=true);
CREATE OR REPLACE VIEW snapshots_per_task AS
  SELECT s.snapshot_date, s.window, pt.*
  FROM snapshots s, UNNEST(s.per_task) AS u(pt);
```

**設計判断**:

- `t.api_usage` / `t.hook_signals` / `t.task_sessions` は SQLite attach 由来（命名空間 `t.` で明示）
- `events` / `snapshots` / `snapshots_per_task` は DuckDB の view（命名空間なし）
- `union_by_name=true` で events.jsonl の schema 揺れを吸収（schema_version=1 / 2 混在対応）
- `ignore_errors=true` で 1 行 parse 失敗が全体を倒さないようにする（best-effort 原則）
- snapshot view は `.team/metrics/snapshots/` が空でも view 作成自体は失敗しないよう、空 dir / 不在は **CLI 側で事前検出してメッセージを出した上で view 作成を skip** するか、`read_json` が glob 0 件を許容するかを確認 → 不可なら view 作成を条件付きにする（Subtask 2 の検証ポイント）

### 2.6 binary 不在時の error message

```
Error: 'duckdb' binary not found in PATH (and DUCKDB_BIN is not set).

cmux-team metrics query は DuckDB CLI を必要とします。以下のいずれかで導入してください:

  macOS (Homebrew):   brew install duckdb
  Linux (apt/dnf):    https://duckdb.org/docs/installation/ から binary を取得
  manual:             https://github.com/duckdb/duckdb/releases から CLI binary を $PATH に配置

別 path に置いている場合は環境変数 DUCKDB_BIN で上書き可能:
  DUCKDB_BIN=/opt/duckdb/bin/duckdb cmux-team metrics query --sql '...'
```

---

## 3. 変更対象

### 3.1 新規作成

| パス | 用途 |
|---|---|
| `skills/cmux-team/manager/metrics-query.ts` | DuckDB 起動 wrapper + init SQL ビルダ + CLI 入口 (`runMetricsQueryCli`) |
| `skills/cmux-team/manager/metrics-query.test.ts` | 単体テスト（per-file 実行） |
| `skills/cmux-team-analyze/SKILL.md` | DuckDB recipe 集 + trigger 定義 |

### 3.2 変更

| パス | 変更概要 |
|---|---|
| `skills/cmux-team/manager/main.ts` | `cmdMetrics` 内に `sub === "query"` 分岐を追加。import 追記 |
| `skills/cmux-team/manager/i18n.ts` | `help_metrics_query` を `en` / `ja` の両 namespace に追加。`help_metrics` の Subcommands 表に `query` を追記 |
| `CLAUDE.md` | 「進捗情報の取得方法」表の直下に 1 行 cross-link を追記 |
| `docs/spec/11-metrics.md` | §5 CLI 例の末尾 §5.5 に `cmux-team metrics query` の入出力例を追記。§14 関連 spec / 関連コードの末尾に skill / CLI を追記 |

### 3.3 削除

なし。

---

## 4. サブタスク分割

### S1: `metrics-query.ts` 骨格 — CLI 入口 + 引数 parse

- **対象**: `skills/cmux-team/manager/metrics-query.ts` (新規)
- **完了条件**:
  - `runMetricsQueryCli({ args, projectRoot, stdout, stderr, abortSignal }) → Promise<number>` を export
  - `--sql <SQL>` / stdin / `--format json|csv|tsv|table` / `--explain` / `--help` / `-h` の parse がテストで通る
  - `--sql` と stdin の両方が無い & TTY なら usage を出して exit 1
  - `--format` のデフォルトは `table`
- **メソッド制約**: `metrics-snapshot.ts` の `parseSnapshotArgs` パターンを踏襲（KNOWN_FLAGS Set + ArgError class）
- **検証**: `bun test --timeout 30000 metrics-query.test.ts -t "parses args"`

### S2: init SQL ビルダ + view registration

- **対象**: `skills/cmux-team/manager/metrics-query.ts`
- **完了条件**:
  - `buildInitSql(projectRoot): string` を内部関数として実装（テスト容易性のため export しても可）
  - 出力に `INSTALL sqlite`, `LOAD sqlite`, `ATTACH '...traces.db' AS t (TYPE sqlite, READ_ONLY)`, 3 つの `CREATE OR REPLACE VIEW`（`events` / `snapshots` / `snapshots_per_task`）が含まれる
  - `traces.db` が存在しない場合は ATTACH 文を省略 + stderr に warn を出す（best-effort 原則）
  - `events.jsonl` / snapshot dir が無い場合も同様にその view を省略する
  - 各 path はシェル展開を前提としない絶対パスで埋め込み、SQL 文字列内では single quote をエスケープする (`replace(/'/g, "''")`)
- **検証**: `bun test --timeout 30000 metrics-query.test.ts -t "init sql"` で snapshot 比較

### S3: DuckDB binary 解決 + spawn

- **対象**: `skills/cmux-team/manager/metrics-query.ts`
- **完了条件**:
  - `resolveDuckdbBin(env): string | null` を実装。優先順位: `env.DUCKDB_BIN` → `Bun.which("duckdb")` → null
  - 不在時は §2.6 の error message を stderr に出して exit 1
  - 在りなら `Bun.spawn([bin, "-" + formatFlag, ":memory:"], { stdin: "pipe", stdout: "pipe", stderr: "pipe", signal: abortSignal })` で起動
  - 全 SQL（init + user SQL）を stdin に書いて close
  - stdout を opts.stdout へ relay、stderr を opts.stderr へ relay、子プロセス exit code をそのまま返す
- **メソッド制約**: spawn は `Bun.spawn`（既存 `cmdConductor` 等で使われている）。`child_process.spawn` は使わない
- **format → flag マッピング**:
  | `--format` | DuckDB CLI flag |
  |---|---|
  | `json` | `-json` |
  | `csv` | `-csv` |
  | `tsv` | `-list` + `.separator "\t"` の事前注入（または `-csv -separator "\t"`） |
  | `table` (default) | `-box`（DuckDB 0.10+）または `-table` の互換選択 |
- **検証**: テストでは `DUCKDB_BIN` を `tmp/fake-duckdb.sh` に向けて、stdin に渡された SQL 全文を assert する

### S4: `--explain` モード

- **対象**: `skills/cmux-team/manager/metrics-query.ts`
- **完了条件**:
  - `--explain` 指定時は user SQL を `EXPLAIN ` で prefix する
  - skill の recipe 開発時に index hint を見るために使う
- **検証**: テストで `--explain --sql "SELECT 1"` の stdin 末尾が `EXPLAIN SELECT 1` で始まっていることを assert

### S5: main.ts dispatch 追加

- **対象**: `skills/cmux-team/manager/main.ts`
- **完了条件**:
  - `import { runMetricsQueryCli } from "./metrics-query"` を追記
  - `cmdMetrics` 内 `sub === "snapshot"` 等と同形式で `if (sub === "query")` 分岐を追加し、`runWithAbort` 経由で呼ぶ
- **検証コマンド**: `grep -n 'sub === "query"' skills/cmux-team/manager/main.ts` で hit すること

### S6: i18n 追加

- **対象**: `skills/cmux-team/manager/i18n.ts`
- **完了条件**:
  - `help_metrics_query` を `en`（591-行ブロック）と `ja`（1555-行ブロック）の両方に追加
  - 既存 `help_metrics` の Subcommands 表に `query` 行を追加
  - 内容は §2.5 の利用可能 view (`t.api_usage` / `t.hook_signals` / `t.task_sessions` / `events` / `snapshots` / `snapshots_per_task`) と DUCKDB_BIN env を含める
- **検証**: `grep -n 'help_metrics_query' skills/cmux-team/manager/i18n.ts` が 2 件 hit (en + ja)

### S7: テスト網羅 — `metrics-query.test.ts`

- **対象**: `skills/cmux-team/manager/metrics-query.test.ts` (新規)
- **完了条件**: 以下を per-file 単独実行で通す
  1. arg parse: `--sql` / stdin / `--format` / `--explain` / 不正 flag
  2. `buildInitSql` snapshot 比較（traces.db 在/不在、events.jsonl 在/不在、snapshot dir 在/不在の組み合わせ）
  3. `resolveDuckdbBin` の優先順位（env > PATH > null）
  4. binary 不在時 stderr に install 案内が出る
  5. `--format json` / `csv` / `tsv` / `table` で正しい flag が渡る
  6. fake duckdb (シェルスクリプト) に対する end-to-end 起動: stdin に init+user SQL が渡り stdout が relay される
  7. abortSignal 発火で子プロセスが SIGTERM される
- **テスト戦略**:
  - fake duckdb は `mkdtempSync` で作った tmp dir に bash script として置く
  - `process.env.DUCKDB_BIN` を fake script に向けて test 内で setUp/tearDown
  - 実 duckdb binary に依存するテストは書かない（CI 安定性のため）
- **検証コマンド**: `cd skills/cmux-team/manager && bun test --timeout 30000 metrics-query.test.ts`

### S8: skill 作成 — `cmux-team-analyze`

- **対象**: `skills/cmux-team-analyze/SKILL.md` (新規)
- **完了条件**:
  - YAML frontmatter:
    - `name: cmux-team-analyze`
    - `description`: 起動条件を sharp に列挙（「メトリクス解析」「cohort 比較」「介入評価」「trace DB から〜」「DuckDB で〜」「baseline 比較」+ 「複数 task / 時系列 trend」+ 「§11 spec の SQL を実行」）+ trace-task との棲み分けを 1 行
  - 本文構成:
    1. 起動条件と棲み分け（trace-task = per-task 履歴 / 本 skill = 複数 task / 時系列 / cohort）
    2. 利用可能 source（init SQL で attach される view / table の説明表）
    3. **DuckDB recipe ライブラリ**（§11 spec の SQL を実走可能形式に整形、6 個以上）:
       - R1: per-task token 集計（`t.api_usage` × `t.task_sessions` の `session_to_task` CTE）
       - R2: cohort 抽出（baseline vs evaluation の period filter、§8 の日付範囲を引数化）
       - R3: forced_close 原因絞り込み（直前 N 件の hook_signals）
       - R4: tool_failure 連鎖検出（同 session 内の連続失敗を window 関数で）
       - R5: SESSION_STARTED の loaded_plugins / loaded_skills cohort filter（§3.5.2 の SQL idiom を実走形式に整形）
       - R6: per-day trend（snapshot から `snapshots_per_task` を unnest して outcome 別件数）
       - R7（任意, 余力で）: claim-vs-diff 検出は **後続タスク扱い**（task 本文 §議論経緯と整合。skill にはスタブ link のみ置き、recipe としては書かない。受入条件「5 個以上」を満たせば十分）
    4. 各 recipe は `<!-- recipe: <name> -->` コメント + ```sql ブロックでコピー実行可能に
    5. §11 spec への cross-link（§3.5 / §3.5.2 / §7-§13）
- **検証**: `cmux-team metrics query --sql "<R1〜R6 の SQL>"` を 6 本通して 0 exit を確認した record を計画書に残す（実装フェーズで成果記録）
- **言語**: 日本語（ドキュメント）+ 英語（SQL コード）

### S9: CLAUDE.md cross-link 追記

- **対象**: `/Users/yamamoto/git/cmux-team/CLAUDE.md`
- **完了条件**:
  - 「進捗情報の取得方法」表の直下、`metric サマリ` 行の直後に 1 行追記
  - 文言案: `> メトリクス解析・cohort 比較・trace DB の ad-hoc 探索 (DuckDB SQL): `cmux-team-analyze` skill を参照（CLI: `cmux-team metrics query`）。`
- **検証コマンド**: `grep -n 'cmux-team-analyze' CLAUDE.md` が 1 件 hit

### S10: spec cross-link 追記

- **対象**: `docs/spec/11-metrics.md`
- **完了条件**:
  - §5 末尾に §5.5 サブセクションを追加し `cmux-team metrics query` の利用可能 view 一覧 + minimal 例 (`SELECT COUNT(*) FROM t.api_usage`) を記載
  - §14 「関連 spec / 関連 task / 関連コード」の「関連コード」項目末尾に `metrics-query.ts` を追記、新たに「関連 skill」項目を追加して `skills/cmux-team-analyze/SKILL.md` を載せる
- **検証コマンド**: `grep -n 'metrics query\|cmux-team-analyze' docs/spec/11-metrics.md` が 3 件以上 hit

### S11: 受入条件の動作確認

- **対象**: 計画外（実装後の検証ステップ）
- **完了条件**:
  - `cmux-team metrics query --sql 'SELECT COUNT(*) FROM t.api_usage'` が 0 exit + 1 行 stdout
  - snapshots × traces.db の JOIN クエリ（R2 cohort 抽出を例に）が動作
  - `duckdb` を一時的に `mv` した状態で `cmux-team metrics query --sql 'SELECT 1'` が install 案内付き stderr + exit 1
- **記録先**: `.team/output/planner.md` の補足セクション、または review 時の comment

### S12（任意, 後続候補）: ndjson 出力 mode

- DuckDB CLI には `-jsonlines` フラグがあるため、`--format ndjson` を将来追加できる。本タスクの受入条件外。

---

## 5. リスク

### 5.1 既存機能への影響

- **ゼロ想定**: `metrics-query.ts` は新規 module。`cmdMetrics` 内の既存 `snapshot` / `compare` / `health` / fallback aggregate は触らない（`if` 分岐を 1 つ追加するのみ）。
- 既存 `metrics-cli.test.ts` には影響なし（module 分離）。

### 5.2 エッジケース

| ケース | 対応 |
|---|---|
| `traces.db` 不在（init 直後） | ATTACH 文を skip + stderr warn。`SELECT 1` 等は通す |
| `events.jsonl` 不在 | `events` view 作成を skip + stderr warn |
| snapshot dir 0 ファイル | `snapshots` / `snapshots_per_task` view 作成を skip。受入条件 R6 は snapshot 1 件以上の前提とする |
| events.jsonl の schema_version 揺れ | `union_by_name=true` で吸収。1 行 parse 失敗は `ignore_errors=true` で 0 行扱い |
| 巨大 events.jsonl (数 GB) のフル scan | DuckDB のストリーム読み出しに任せる。projectRoot の規模では問題化しないが、skill の recipe 内で `WHERE ts >= '...'` filter を必須化して案内する |
| user SQL が `ATTACH` / `INSTALL` / `LOAD` を含み init を上書き | DuckDB セッション内で複数 attach は許容される。read-only なので escalation は無い。skill recipe に「init で attach 済み」と明記して二重 ATTACH を避ける |
| stdin から SQL を渡しつつ `--sql` も指定 | `--sql` を優先、stdin は無視（usage に明記） |
| Windows | DuckDB CLI は Windows でも動くが、本リポジトリは macOS / Linux 前提。Windows 動作確認は scope 外（CLAUDE.md / README に Windows 言及なし） |
| DuckDB version 差 | `INSTALL sqlite; LOAD sqlite` は DuckDB 0.9 以降で安定。`-box` flag は 0.10+。`-list` は古くから安定。テストでは `-list` 互換にフォールバックする選択肢も検討（init SQL の version detect は不要、CLI flag のみで分岐） |
| SQL injection（user 入力） | scope 外（projectRoot read-only DB / ユーザー自身が打つ CLI / `READ_ONLY` 強制）。CLAUDE.md「実装ルール」に該当するセキュリティ境界ではない |

### 5.3 テスト戦略

- **fake binary 戦略**: `metrics-query.test.ts` は `DUCKDB_BIN=<tmpdir>/fake-duckdb.sh` を使い、実 duckdb binary に依存しない。CI でも安定。
- **per-file 実行**: `cd skills/cmux-team/manager && bun test --timeout 30000 metrics-query.test.ts`（CLAUDE.md 「`bun test` 全体実行は禁忌」）
- **integration smoke**: 実装フェーズの最後で **手動** で `brew install duckdb` → `cmux-team metrics query --sql 'SELECT COUNT(*) FROM t.api_usage'` を流して 1 度確認（`.github/workflows/test.yml` には追加しない — CI に DuckDB を入れるコストを避けるため）
- **skill recipe 動作確認**: S8 完了条件で 6 本の SQL recipe を手動実行し、結果サンプルを skill 内 comment に記録する

---

## 6. 既存型エラーの先読み

```bash
cd skills/cmux-team/manager && bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "^(metrics-query\.ts|metrics-cli\.ts|main\.ts|i18n\.ts)" || true
```

実行結果（worktree `task-412-1777679258` で確認、Planning フェーズ時点）: **EXIT=0 / 出力なし**。本タスクで触る予定のファイル（`main.ts` / `i18n.ts`）に既存の型エラーは無い。`metrics-query.ts` は新規ファイル。

#### 6.1 本タスクのスコープで解消するエラー

該当なし。

#### 6.2 後続タスク（cleanup）に分離するエラー

該当なし。

---

## 7. Decision Log

| ID | 検討事項 | 結論 | 理由 |
|----|---------|------|------|
| D1 | DuckDB を Node binding で組み込むか external binary spawn にするか | **external binary spawn** | npm 配布物を肥大させない。Bun との binding 互換性の罠を避ける。AI が CLI 越しに使う前提なので Node API は不要 |
| D2 | storage 層を SQLite から DuckDB に置換するか | **置換しない**（read-only attach のみ） | daemon の concurrent write workload は SQLite WAL が最適。DuckDB は単一 writer 前提で並行書き込みが弱い |
| D3 | binary 不在時の挙動 | **exit 1 + 詳細な install 案内** | best-effort fallback (jq + sqlite3 など) は複雑性に見合わない。明示的に install を促す |
| D4 | snapshot JSON の view 化方法 | **`snapshots`（1 行/file の生 view）+ `snapshots_per_task`（unnest 後の per-task view）の 2 段** | recipe で per-task を扱うことが多いので unnest 済み view を提供。生 view も period サマリ用に残す |
| D5 | `events.jsonl` の schema 揺れ対応 | **`union_by_name=true` + `ignore_errors=true`** | schema_version=1/2 混在を許容。1 行 parse 失敗が全体を倒さない（best-effort 原則） |
| D6 | CLI に `--format ndjson` を含めるか | **本タスクでは含めない**（json / csv / tsv / table の 4 種に絞る） | DuckDB の `-jsonlines` flag を将来追加可能。受入条件と直接関係しないため scope を絞る |
| D7 | `--explain` を入れるか | **入れる** | recipe 開発時に index hint / row estimate を見るために頻繁に必要。実装コスト極小（user SQL を `EXPLAIN ` で prefix するだけ） |
| D8 | skill の配置を `skills/cmux-team-analyze/` にするか `skills/cmux-team/skills/` 等の plugin 内入れ子にするか | **`skills/cmux-team-analyze/`** (top-level) | 既存 `cmux-team-gh` / `cmux-team-guide` / `dockeeper` / `trace-task` も top-level。plugin manifest (`./skills/`) は配下を全部拾う |
| D9 | trace-task skill との棲み分け表現 | skill 冒頭で 1 行明記（per-task 履歴 = trace-task / 複数 task・時系列・cohort = cmux-team-analyze） | description にも入れる。誤起動防止 |
| D10 | claim-vs-diff recipe を本タスクで実装するか | **後続タスク扱い、skill には placeholder link のみ** | task 本文 §議論経緯で「semantic 解析は後続」と確定済み。受入条件「5 個以上」は他の 6 recipe で満たせる |
| D11 | DuckDB の `-box` / `-table` / `-list` のどれを `--format table` の実体にするか | **`-box` を第一候補、unsupported で fallback はせず documented version 要件として install 案内に記載** | 動作確認が単純。version detect ロジックを増やさない |
| D12 | テストで実 duckdb binary に依存させるか | **しない**（fake bash script で stdin 経由 SQL を assert） | CI 安定性 + brew install を CI に追加するコストを避ける |
| D13 | snapshot dir / events.jsonl 不在時の view 作成 | **存在判定して view 作成を skip + stderr warn** | view 作成失敗で全体エラーになるのを防ぐ。`SELECT 1` のような小さなクエリでも fail しないようにする |
| D14 | `cmdMetrics` の dispatch 位置 | 既存 `snapshot` / `compare` / `health` の **直後**（aggregate fallback の前） | 既存読み手の理解しやすさ重視。`runWithAbort` パターンを継承 |
| D15 | skill 名 | **`cmux-team-analyze`**（task 本文どおり） | 既存 skill との namespace 衝突なし。`analyze` で十分 sharp |

---

## 8. 実装順序サマリ（Conductor 向け）

1. **S1 → S2 → S3 → S4** (`metrics-query.ts` 本体): 骨格 → init SQL → spawn → `--explain`
2. **S5 → S6** (dispatch + i18n): `cmdMetrics` への配線、help text
3. **S7** (テスト): per-file 実行で 7 ケース通す
4. **S8** (skill): recipe を 6 本書きながら CLI の不足を S1〜S4 に back-fill
5. **S9 → S10** (cross-link): CLAUDE.md / spec
6. **S11** (受入条件確認): 実 duckdb で smoke

---

## 9. 補足: 受入条件チェックリスト → サブタスクのマッピング

| 受入条件 | 担当サブタスク |
|---|---|
| `cmux-team metrics query --sql 'SELECT COUNT(*) FROM t.api_usage'` が動作 | S1-S6 + S11 |
| `cmux-team metrics query` で snapshots と traces.db を JOIN するクエリが通る（README 例の 1 つ） | S2 + S8 (R2) + S11 |
| `skills/cmux-team-analyze/SKILL.md` が作成され、5 個以上の動作確認済み recipe を含む | S8 (R1〜R6) |
| CLAUDE.md に 1 行追記 | S9 |
| `docs/spec/11-metrics.md` から新 skill / CLI への cross-link を追加 | S10 |
| `duckdb` 不在時の error message が install 手順を含む | S3 + S7 (case 4) |
