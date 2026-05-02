# T412 タスクサマリー: メトリクス解析基盤 (cmux-team metrics query CLI + cmux-team-analyze skill)

> Conductor: surface:585
> Branch: `task-412-1777679258/task`
> Worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-412-1777679258`
> 関連 spec: `docs/spec/11-metrics.md`

## 概要

`docs/spec/11-metrics.md` で定義された 6 軸 metric を **ad-hoc に SQL で探索する経路** を導入。SQLite（trace DB）/ JSON（snapshot）/ JSONL（events stream）の異種ファイル形式を **DuckDB の read-only attach** で 1 SQL から JOIN できるようにし、AI が cohort 比較・異常 task 絞り込み・複数 source 横断解析を実行可能にする。

storage 層は SQLite WAL のまま（concurrent write 維持）。DuckDB は **read-only analyzer 専用**として並存する構造的解。

## 完了したサブタスク

| # | サブタスク | 担当 |
|---|-----------|------|
| Phase 1 | plan.md 作成 (S1〜S12 + Decision Log 15 件) | Planner Agent |
| Phase 2 | Design Review (Approved, Minor 7 件 → 5 件 back-fill) | Design Reviewer Agent |
| Phase 3 | TDD 実装 (S1〜S11 完遂、S12 は scope 外で skip) | Implementer Agent |
| Phase 4 | 検品 (GO 判定、Critical 0 / Major 0 / Minor 1) | Inspector Agent |

## 変更ファイル

### 新規作成
- `skills/cmux-team/manager/metrics-query.ts` — DuckDB 起動 wrapper + init SQL ビルダ + format 切替
- `skills/cmux-team/manager/metrics-query.test.ts` — 31 テストケース（fake duckdb 経由、実 binary 非依存）
- `skills/cmux-team-analyze/SKILL.md` — DuckDB recipe 集（R1〜R6 + R7〜R9 後続スタブ）

### 変更
- `skills/cmux-team/manager/main.ts` — `cmdMetrics` に `sub === "query"` 分岐追加
- `skills/cmux-team/manager/i18n.ts` — `help_metrics_query` を en/ja 両 namespace に追加 + 既存 `help_metrics` の Subcommands 表更新
- `CLAUDE.md` — 「進捗情報の取得方法」表直下に 1 行 cross-link 追記
- `docs/spec/11-metrics.md` — §5.5「ad-hoc DuckDB クエリ（T412）」追加 + §14 関連コード/関連 skill 追記
- `package-lock.json` — release v4.24.0 同期残務（副次的混入、Inspector F1 で許容判断）

## テスト結果

```
$ bun test --timeout 30000 metrics-query.test.ts        → 31 pass / 0 fail (66 expect)
$ bun test --timeout 30000 metrics-cli.test.ts          → 18 pass / 0 fail
$ bun test --timeout 30000 metrics-snapshot.test.ts     → 15 pass / 0 fail
$ bun test --timeout 30000 metrics-aggregate.test.ts    → 18 pass / 0 fail
```

新規 31 件 + 既存 51 件すべて pass。`bunx tsc --noEmit` の touched files 部分は exit 0。

## 受入条件

| 条件 | 結果 |
|------|------|
| 1. `metrics query --sql 'SELECT COUNT(*) FROM t.api_usage'` が動作 | ✅ `count_star() = 15494` を 0 exit |
| 2. snapshots × traces.db を JOIN するクエリが通る | ✅ `snapshots_per_task LEFT JOIN t.api_usage` で 5 行返却 |
| 3. `cmux-team-analyze` skill に 5 個以上の動作確認済み recipe | ✅ R1〜R6 の 6 件すべて smoke 済み |
| 4. CLAUDE.md に 1 行追記 | ✅ |
| 5. `docs/spec/11-metrics.md` から cross-link | ✅ §5.5 + §14 |
| 6. `duckdb` 不在時の error message が install 手順を含む | ✅ Homebrew/apt/manual + DUCKDB_BIN env を案内 |

## 設計上のキーポイント

- **構造的解決**: ad-hoc 集計を「コード追加」ではなく「SQL recipe 追加」で対応できる reach に切り替えた（D1: Node binding 不採用、D2: storage 置換せず、D4: snapshots / snapshots_per_task の 2 段 view）
- **AI reach 矯正**: CLI だけでは AI が DuckDB を発想しないため、skill description（trigger 語彙）+ CLAUDE.md cross-link の 3 段で誘導
- **best-effort init**: traces.db / events.jsonl / snapshot dir 不在時は ATTACH/view 作成を skip + warn（small project でも `SELECT 1` が通る）
- **Reviewer フィードバックの back-fill**: `--format tsv` を `-csv -separator "\t"` に変更（dot-command と SQL の境界が混ざらない）/ help text に「DuckDB 0.10+ 推奨」追記 / 「`--sql` + stdin 同時指定で `--sql` 優先」テスト追加

## マージ先

`main` ブランチへローカル ff-only マージ予定。
