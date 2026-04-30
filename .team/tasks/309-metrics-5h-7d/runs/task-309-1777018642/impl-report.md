# T309 実装レポート

Metrics タブから重複する「統合（5h/7d）」セクションを削除した。
ヘッダー右端 (`buildRateLimitDisplay`) の `5h:` / `7d:` バー付き表示は無傷。

## ファイル別差分サマリー

### 1. `skills/cmux-team/manager/dashboard-metrics.ts` (-20 行)

- `MetricsData` interface から `unifiedFive` / `unifiedSeven` フィールド + JSDoc を削除
- `buildMetricsRows` 内の unified 5h / 7d 描画ブロック（コメント + `rows.push` 4 文）を削除
- `utilizationColor` 関数は他の 2 箇所（L226, L256）で使用中のため残置

### 2. `skills/cmux-team/manager/dashboard.tsx` (-4 行)

- L1830-1831（db=null フォールバック側）の `unifiedFive:` / `unifiedSeven:` 代入行を削除
- L1871-1872（通常パス）の同 2 行を削除
- 右辺で参照していた `daemon.rateLimit?.unified5hUtilization` / `unified7dUtilization` は
  行ごと削除なので孤立参照は残らない（ヘッダー側の参照は別系統で全て無傷）

### 3. `skills/cmux-team/manager/i18n.ts` (-2 行)

- en (`metrics_section_unified: "Unified (5h / 7d)"`) と ja (`"統合（5時間 / 7日）"`) を
  両方同時に削除（型整合性維持）

### 4. `skills/cmux-team/manager/dashboard-metrics.test.tsx` (-2 行)

- テストフィクスチャ `makeData()` から `unifiedFive: 0.4,` / `unifiedSeven: 0.2,` を削除

## テスト結果

| 項目 | 結果 |
|---|---|
| `bun test ./dashboard-metrics.test.tsx` | **26 pass / 0 fail** (35 expect) |
| `bun test`（フル） | **1215 pass / 0 fail** (2957 expect, 40 files) |
| `bunx tsc --noEmit`（変更ファイル） | **新規エラー 0 件** |

> tsc 全体では既存エラー（`conductor.ts:201`, `daemon.ts:1558`,
> `daemon.test.ts:3870`）が出るが、これらは SESSION_STARTED の type narrowing
> 関連で本変更とは無関係。`rg 'dashboard-metrics|dashboard\.tsx|i18n\.ts'` で
> フィルタすると 0 件であることを確認済み。

## grep による消し漏れチェック

| コマンド | 結果 |
|---|---|
| `rg -n 'unifiedFive\|unifiedSeven' skills/cmux-team/` | **0 件** |
| `rg -n 'metrics_section_unified' skills/cmux-team/ docs/ README*.md` | **0 件** |
| `rg -n 'unifiedFive\|unifiedSeven\|metrics_section_unified'`（リポジトリ全体） | **0 件** |

## 逆方向 grep（残存していること）

| コマンド | 結果 |
|---|---|
| `rg -n 'unified5hUtilization\|unified7dUtilization' skills/cmux-team/manager/ \| wc -l` | **49 件**（plan の 30+ ヒット維持） |

ヘッダー描画 / throttle 判定 / proxy / schema は全て無傷。

## `git diff --stat`

```
 package-lock.json                                   |  4 ++--
 skills/cmux-team/manager/dashboard-metrics.test.tsx |  2 --
 skills/cmux-team/manager/dashboard-metrics.ts       | 20 --------------------
 skills/cmux-team/manager/dashboard.tsx              |  4 ----
 skills/cmux-team/manager/i18n.ts                    |  2 --
 5 files changed, 2 insertions(+), 30 deletions(-)
```

> `package-lock.json` の変更は本タスク開始時点で既に modified だった
> （worktree ベースラインに含まれる）。本タスクで意図的に変更したのは
> 上記 4 ファイルのみ。

## 完了条件チェック

- [x] grep がすべて 0 件
- [x] `bunx tsc --noEmit` で変更ファイルに新規エラー 0 件
- [x] `bun test` がすべて pass（1215 / 0）
- [x] ヘッダー側 `unified5hUtilization` / `unified7dUtilization` 参照は 49 件で不変
- [x] 変更は plan で指定された 4 ファイルに限定
- [x] commit / `.team/artifacts/` / summary.md は書いていない（Conductor の責務）
