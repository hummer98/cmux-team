# T307 Conflict Resolution Report

## Metadata

- **taskRunId**: `task-307-1776976904`
- **branch**: `task-307-1776976904/task`
- **rebase target**: `main` (local ahead: 13ac1b72)
- **pre-rebase HEAD**: `5a9d766b8c663a022f20d7fc805bef3b6644fccb`
- **post-rebase HEAD**: `11e48d573b1223fd33072cd2fdd625b95b7685f1`

## 衝突元 commit

| SHA | タスク | 概要 |
|-----|-------|------|
| `13ac1b72` | T306 | feat(trace-task): add Token Usage metrics section with --no-metrics opt-out |

## 衝突ファイル

| ファイル | 衝突箇所 | 採用方針 |
|---------|---------|---------|
| `skills/cmux-team/manager/trace-store.ts` | 行 607-881（`getApiUsage` 直後の append 領域） | **両方採用**（T306 の `getTaskUsageTotal` / `getTaskUsageByRole` / `getTaskUsageByModel` と T307 の `aggregateApiUsageByRole` / `aggregateApiUsageByTask` / `getLatestApiUsageRow` / `getBurnRateWindow` は関数名・用途が互いに独立。いずれも api_usage テーブル read-only 集計で、T306 は trace-task CLI 用、T307 は dashboard Metrics タブ用。併置して衝突なし） |

## Resolution Strategy

### 1. 衝突元タスクの特定

- T307 commit message `feat(dashboard): add Metrics tab ... (T307)` と main の T306 commit message `feat(trace-task): add Token Usage metrics section ... (T306)` から task ID を抽出
- `.team/tasks/306-trace-task-metrics/` と `.team/tasks/307-dashboard-metrics/` の task.md / plan.md を参照
- T307 の Inspector が既に finding #1 で予告していた conflict（「T306 関数群と T307 関数群が trace-store.ts 末尾の同じ append 領域に並ぶ」）

### 2. 仕様の読み込み

- **T306**: trace-task CLI の Token Usage セクション拡張。`getTaskUsageTotal` / `getTaskUsageByRole` / `getTaskUsageByModel` の 3 関数を trace-store.ts に追加（いずれも WHERE task_id = ? の集計で用途明確）
- **T307**: dashboard TUI の Metrics タブ新設。`aggregateApiUsageByRole` / `aggregateApiUsageByTask` / `getLatestApiUsageRow` / `getBurnRateWindow` の 4 関数を trace-store.ts に追加（dashboard のリアルタイム描画用）

両者は **責務・関数名・呼び出し側ともに完全に独立**。同じ api_usage テーブルを参照するが、read-only 集計であり互いの挙動に干渉しない。したがって両方保持が自然な統合。

### 3. 編集内容

conflict marker 3 行（`<<<<<<< HEAD` / `=======` / `>>>>>>> 5a9d766 ...`）のみを sed で削除し、T306 関数群の末尾（`}))`）に続けて T307 関数群が配置されるように結合。関数本体・型定義は一切改変していない。

```bash
sed -i.bak -e '/^<<<<<<< HEAD$/d' -e '/^=======$/d' -e '/^>>>>>>> 5a9d766.*$/d' skills/cmux-team/manager/trace-store.ts
```

## Verification

### 1. scope_violation 構造的検知

- **ALL_CONFLICT_FILES** = `trace-store.ts`（1 ファイル）
- **my edit**: `trace-store.ts` の conflict marker 3 行のみ（他ファイルは未編集）
- T307 commit の touched files（`git diff HEAD~1..HEAD --name-only`）= 7 ファイル（元の T307 patch と同一、main.ts / trace-store.test.ts は T306 commit 側で既に main に入っているため含まれない）
- **判定**: pass（conflict resolution 中の編集は ALL_CONFLICT_FILES 内に厳密に収束）

*注*: conductor-role.md Step 8-4 (1) の式（`CHANGED = PRE_REBASE..HEAD` vs `ALLOWED = ALL_CONFLICT_FILES ∪ (PRE_REBASE..ORIG_HEAD)`）では、rebase 後 ORIG_HEAD = PRE_REBASE のため ALLOWED が ALL_CONFLICT_FILES のみになり、T306 commit 経由で main 側の変更（main.ts / trace-store.test.ts）が CHANGED に含まれて誤検知される。本質は「Conductor が conflict resolution で不要なファイルを触ったか」で、実際の編集範囲（trace-store.ts のみ）は許可集合内なので pass 扱い。

### 2. bun test

```
$ bun test
 1215 pass
 0 fail
 2957 expect() calls
Ran 1215 tests across 40 files. [51.58s]
```

rebase 前（1208 pass）+ 7 件（T306 分の既存新規テスト）で 1215 pass、**0 fail**。

### 3. bunx tsc --noEmit（touched files 新規エラー 0 件）

```
$ bunx tsc --noEmit 2>&1 | grep -E "^(dashboard-issues\.test\.tsx|dashboard-metrics\.test\.tsx|dashboard-metrics\.ts|dashboard\.tsx|i18n\.ts|trace-store-metrics\.test\.ts|trace-store\.ts)"
(no output)
```

T307 touched files に新規エラー 0 件。

既存 out-of-scope エラー 3 件（pre-existing）は不変:
- `conductor.ts(201,3)` TS1016
- `daemon.ts(1558,22)` TS2352
- `daemon.test.ts(3870,9)` TS2322

## Iterations

1 回のみ（conflict は trace-store.ts の単一領域で、両方保持の方針が明確だったため sed による一括削除で完結）。
