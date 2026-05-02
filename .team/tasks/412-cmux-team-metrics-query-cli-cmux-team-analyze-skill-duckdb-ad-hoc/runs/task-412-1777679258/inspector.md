# T412 Inspector Report

> Inspector: surface-585-inspector-1777681187
> Worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-412-1777679258/`
> Branch: `task-412-1777679258/task` (HEAD = `2f7dbeb chore: release v4.24.0`)
> Implementer report: `implementer.md`（同 dir）
> Plan: `plan.md` / Design review: `design-review.md`（同 dir）

## Verdict: GO

## Summary

T412 の受入条件 6 件はすべて充足。`metrics-query.ts` が新規実装され、`Bun.spawn` 経由で外部 `duckdb` binary を spawn する薄い wrapper として完成している。`main.ts` への dispatch (`sub === "query"`)、i18n の en/ja 両 namespace 追加、CLAUDE.md / `docs/spec/11-metrics.md` への cross-link、`skills/cmux-team-analyze/SKILL.md`（recipe 6 個 + 後続候補 3 件のスタブ）も plan 通りに整備済み。新規 31 テスト + 既存 51 テスト（cli/snapshot/aggregate）が全 pass、touched files の `bunx tsc --noEmit` も exit 0。実 duckdb v1.5.2 を使った受入条件 1 (`SELECT COUNT(*) FROM t.api_usage` → 15494) / 2 (snapshots × traces.db JOIN) / 6 (binary 不在時の install 案内 + exit 1) も手元で再現できた。Critical 0 件・Major 0 件・Minor 1 件のため GO。

## Findings

### F1 [minor] `package-lock.json` の version 更新が T412 のスコープ外 commit として混入

`git diff package-lock.json` は `"version": "4.23.1" → "4.24.0"` のみの変更で、HEAD (`2f7dbeb chore: release v4.24.0`) で `package.json` が 4.24.0 に上がっているのに lockfile が同期されていなかった残務を `npm install` 等で修正した形に見える。T412 の CLI 実装とは無関係だが、release v4.24.0 の lockfile 同期漏れを副次的に塞いでいるため害はない。worktree に残ったまま T412 のコミットに含めるか、release-sync の chore commit として別途切り出すかは Conductor / Master 判断（GO/NOGO には影響しない）。

### F2 [minor] 検証時の補足記録（指摘ではない）

- `--help` (`help_metrics_query`) の出力本文が i18n 経由で正しく表示される（en/ja 両方 grep hit、ja で実機確認）。
- `metrics --help` の Subcommands 表に `query` 行が en/ja 両方で並ぶことを確認。
- `metrics query --bogus` で `Error: unknown flag: --bogus` + exit 1 が返ることを確認（arg parse の負経路）。
- `metrics query --explain --sql 'SELECT 1'` で `EXPLAIN` 経由の Physical Plan 表示が返ることを確認。
- `metrics query` (snapshots × traces.db LEFT JOIN, `snapshot_date / outcome / n / in_tok` を 5 行で取得) も 0 exit。

## Detailed Verification

### 1. 計画充足

| サブタスク | 状態 | 確認 |
|---|---|---|
| S1〜S11 | ✅ | implementer.md 通り。S12（ndjson）は scope 外で skip |
| 期待される変更ファイル | ✅ | 新規 3, 変更 4 が `git status` / `git diff --name-only` 一致 |
| `Bun.spawn` 使用 / `child_process` 不使用 | ✅ | `grep -n 'child_process' metrics-query.ts` → 0 件 |
| `runWithAbort` 経由 + `sub === "query"` | ✅ | `main.ts:5320`, `main.ts:5323` |
| i18n 両 namespace に `help_metrics_query` | ✅ | `i18n.ts:707` (en) / `:1709` (ja) の 2 件 hit |
| `help_metrics` Subcommands 表に `query` | ✅ | en/ja 両方で実 CLI 出力を確認 |

### 2. Dead/Zombie Code

旧実装との並行なし（T412 は完全な新規追加）。`metrics-query.ts` 内に未使用 import / 変数 / 関数は見当たらない。`escapeSqlString` 等の private helper も使われている。

### 3. テスト

```
$ bun test --timeout 30000 metrics-query.test.ts        → 31 pass / 0 fail (66 expect)
$ bun test --timeout 30000 metrics-cli.test.ts          → 18 pass / 0 fail
$ bun test --timeout 30000 metrics-snapshot.test.ts     → 15 pass / 0 fail
$ bun test --timeout 30000 metrics-aggregate.test.ts    → 18 pass / 0 fail
```

新規 31 件 + 既存 51 件、全 pass。`bun test` 全体実行は CLAUDE.md 禁忌のため per-file 単独実行で確認した。

### 4. 設計原則

- `runFooCli({ args, projectRoot, stdout, stderr, abortSignal }) → Promise<number>` 契約踏襲。
- DuckDB binary は npm 配布物に含めず、ユーザー手元 install 強制（plan §2.2 / D1 と整合）。
- init SQL は **存在判定で view 作成を skip + stderr warn** に統一されており、fresh project で `SELECT 1` が通る（best-effort 原則）。
- `--format tsv` は plan で示唆された `-list + .separator` ではなく **`-csv -separator "\t"`**（design-review F2 / Reviewer rec #1 を採用）— SQL と dot-command の境界が混ざらない素直な実装。

### 5. 統合

- `main.ts` への `import { runMetricsQueryCli } from "./metrics-query"` (line 44)。
- `cmdMetrics` 内 `if (sub === "query")` 分岐 (line 5320) が `snapshot` / `compare` / `health` の直後に配置（plan D14 と整合）。
- skill SKILL.md の YAML frontmatter は `name: cmux-team-analyze` + `description: >` (folded) で valid。

### 6. 型エラーゼロ化（touched files）

```
$ TOUCHED=i18n.ts|main.ts|metrics-query.test.ts|metrics-query.ts
$ bunx tsc --noEmit | grep -E "^($TOUCHED)" 
(no output)
```

EXIT 0 / 出力空 → pass。

### 7. 受入条件動作確認（実 binary）

DuckDB v1.5.2 (`/opt/homebrew/bin/duckdb`) で再現:

```bash
# 受入条件 1
$ PROJECT_ROOT=/Users/yamamoto/git/cmux-team \
    bun skills/cmux-team/manager/main.ts metrics query \
    --sql 'SELECT COUNT(*) FROM t.api_usage'
┌──────────────┐
│ count_star() │
├──────────────┤
│ 15494        │
└──────────────┘
EXIT=0

# 受入条件 2 (snapshots × traces.db JOIN)
$ PROJECT_ROOT=/Users/yamamoto/git/cmux-team \
    bun skills/cmux-team/manager/main.ts metrics query \
    --sql "SELECT s.snapshot_date, s.outcome, COUNT(*) AS n,
                  SUM(u.input_tokens) AS in_tok
           FROM snapshots_per_task s
           LEFT JOIN t.api_usage u ON s.task_id = u.task_id
           GROUP BY s.snapshot_date, s.outcome
           ORDER BY s.snapshot_date DESC LIMIT 5"
┌───────────────┬───────────┬────┬────────┐
│ snapshot_date │  outcome  │ n  │ in_tok │
│   2026-04-30  │ completed │ 11 │  NULL  │
│   2026-04-30  │   open    │  1 │  NULL  │
└───────────────┴───────────┴────┴────────┘
EXIT=0

# 受入条件 6 (PATH から duckdb を除外)
$ PATH=/usr/bin:/bin DUCKDB_BIN= PROJECT_ROOT=/Users/yamamoto/git/cmux-team \
    /opt/homebrew/bin/bun skills/cmux-team/manager/main.ts metrics query --sql 'SELECT 1'
Error: 'duckdb' binary not found in PATH (and DUCKDB_BIN is not set).

cmux-team metrics query は DuckDB CLI を必要とします（DuckDB 0.10+ 推奨: -box flag のため）。以下のいずれかで導入してください:
  macOS (Homebrew):   brew install duckdb
  Linux (apt/dnf):    https://duckdb.org/docs/installation/ から binary を取得
  manual:             https://github.com/duckdb/duckdb/releases から CLI binary を $PATH に配置
別 path に置いている場合は環境変数 DUCKDB_BIN で上書き可能:
  DUCKDB_BIN=/opt/duckdb/bin/duckdb cmux-team metrics query --sql '...'
EXIT=1
```

### Cross-link 確認

```
$ grep -n 'cmux-team-analyze' CLAUDE.md
200:> メトリクス解析・cohort 比較・trace DB の ad-hoc 探索 (DuckDB SQL) は
    `cmux-team-analyze` skill を参照（CLI: `cmux-team metrics query`）。

$ grep -nE 'metrics query|cmux-team-analyze|metrics-query' docs/spec/11-metrics.md
489: §5.5 ad-hoc DuckDB クエリ（T412）導入文
504: 最小例 (count)
507: events.jsonl サンプル
510: snapshot サンプル
520: 前提（DuckDB 0.10+ + DUCKDB_BIN）
817: §14 関連コードに metrics-query.ts 追記
821: §14 関連 skill に SKILL.md 追記
```

### Skill recipe 数

`grep -c '<!-- recipe:' skills/cmux-team-analyze/SKILL.md` → **7 件**（R1〜R6 + R7 後続スタブを含む）。
受入条件「5 個以上の動作確認済み recipe」は R1〜R6 の 6 件（implementer.md §Recipe Verification で実 binary smoke 完了）で充足。R7〜R9 は後続候補スタブとして §4 に列挙。

## Fix Required

なし（GO）。F1 (package-lock.json) は GO 判定に影響せず、release ハウスキーピングとして任意で別 commit へ切り出せばよい。
