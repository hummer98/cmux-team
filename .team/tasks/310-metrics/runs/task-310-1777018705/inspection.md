# T310 Inspection Report

Status: GO

## 1. 受け入れ条件対応表

| # | 受け入れ条件 | 判定 | 根拠 |
|---|-------------|------|------|
| 1 | Metrics タブで ↑/↓ でスクロールできる | ✓ | `dashboard.tsx:1559-1561`（Up: `Math.max(offset-1, 0)`）/ `dashboard.tsx:1594-1596`（Down: 単純加算、描画側 clamp） |
| 2 | g で先頭、G で末尾にジャンプできる | ✓ | `dashboard.tsx:1715-1717`（g: offset=0）/ `dashboard.tsx:1730-1734`（G: `buildMetricsRows` を呼んで `maxOffset = max(0, rows.length - METRICS_VISIBLE_LINES)`） |
| 3 | 画面下端にあっても role/task 別ランキングが全件見られる | ✓ | `METRICS_VISIBLE_LINES = 30`（`dashboard.tsx:58`）＋ `G` ハンドラで末尾まで到達可能。`buildMetricsRows` の最大行数（caption + rate-limit + unified + role + task の合計）が 30 行を超えても scroll で全行閲覧可能 |
| 4 | footer のキーヒントに scroll 操作が表示される | ✓ | `dashboard.tsx:1472-1473` に `ui.kbd("↑/↓") ui.text("scroll")` / `ui.kbd("g/G") ui.text("top/bottom")` を先頭追加 |
| 5 | `bun test` / typecheck 通過 | ✓ | `bun test`: 1215 pass / 0 fail / 40 files。`bunx tsc --noEmit`: 新規エラー 0 件（pre-existing 3 件のみ残存）|

## 2. diff 精読結果

### 2-1. 変更ファイル一覧

| ファイル | 変更内容 | 判定 |
|----------|----------|------|
| `skills/cmux-team/manager/dashboard.tsx` | +29 / -1 行 | 計画通り |
| `skills/cmux-team/manager/dashboard-issues.test.tsx` | +1 行（`metricsScrollOffset: 0` 追加） | 型整合のため必要（impl-report.md §2 に理由あり） |
| `package-lock.json` | version 4.5.1 → 4.6.0 | `4336f56` リリースコミットの残差分。機能変更なし、無害 |

予期せぬ変更なし。

### 2-2. Step 別コード品質チェック

| Step | 観点 | 判定 | 備考 |
|------|------|------|------|
| 1 | `METRICS_VISIBLE_LINES` が既存定数と同じ書式・値 | ✓ | `dashboard.tsx:58` に `const METRICS_VISIBLE_LINES = 30;` を追加。`LOG_VISIBLE_LINES` / `JOURNAL_VISIBLE_LINES` と同値 |
| 2 | 型定義と初期値の両方に追加されているか | ✓ | 型: `dashboard.tsx:432` / 初期値: `dashboard.tsx:1211` |
| 3 | `Math.min(offset, max(0, total - VISIBLE))` で clamp | ✓ | `dashboard.tsx:1388-1397` に IIFE で実装。`startIdx = Math.min(state.metricsScrollOffset, Math.max(0, total - METRICS_VISIBLE_LINES))`、`endIdx = Math.min(startIdx + METRICS_VISIBLE_LINES, total)` |
| 4 | Up で `Math.max(offset-1, 0)`、Down で単純加算 | ✓ | Up: `dashboard.tsx:1559-1561`、Down: `dashboard.tsx:1594-1596`。Down は描画側で clamp される前提で単純加算（plan (A) 案） |
| 5 | g で offset=0、G で `buildMetricsRows` を呼んで maxOffset 算出 | ✓ | g: `dashboard.tsx:1715-1717` / G: `dashboard.tsx:1730-1734`（`buildMetricsRows(s.metricsData, s.metricsError)` を呼び `Math.max(0, rows.length - METRICS_VISIBLE_LINES)`） |
| 6 | footer に `↑/↓ scroll` / `g/G top/bottom` を metrics 分岐に追加 | ✓ | `dashboard.tsx:1471-1473`（metrics 分岐の先頭） |
| 7 | `loadMetricsData` / 1s polling で `metricsScrollOffset` に触れていない | ✓ | `loadMetricsData`（`dashboard.tsx:1840-1921`）内のすべての `app.update` ブロックで `metricsScrollOffset` は一切書き換えていない（grep で全参照を確認） |

## 3. テスト実行結果

### 3-1. typecheck

コマンド: `cd skills/cmux-team/manager && bunx tsc --noEmit`

結果: エラー 3 件（すべて pre-existing で impl-report.md §3 に記載あり）

1. `conductor.ts(201,3)` TS1016 — required param が optional param の後
2. `daemon.test.ts(3870,9)` TS2322 — SESSION_STARTED source リテラル不一致
3. `daemon.ts(1558,22)` TS2352 — SESSION_STARTED 型変換警告

**本タスク由来の新規エラーは 0 件**。

### 3-2. unit test

コマンド: `cd skills/cmux-team/manager && CMUX_TEAM_LOGGER_STRICT=1 bun test`

結果:
```
1215 pass
0 fail
2957 expect() calls
Ran 1215 tests across 40 files.
```

## 4. 総合判定

Status: **GO**

- 受け入れ条件 5 項目すべて満たしている
- plan.md の Step 1〜7 すべてが想定通りに実装されている
- 予期せぬ変更なし（dashboard-issues.test.tsx の 1 行追加は型整合のため必須）
- typecheck は pre-existing エラーのみ、新規エラー 0
- 1215 件のテストが全件通過

### 付記（実害なしの既知事項）

- **overshoot offset**: Down 連打で `metricsScrollOffset` が `rows.length` を超え得るが、描画側 `Math.min` で clamp されるため画面は末尾貼り付きで問題なし。↑ 1 回または `G` 押下で即座に範囲内へ復帰する。plan (A) 案採用の意図通り。
- 手動 UI 確認（`cmux-team start` 経由）は Inspector スコープ外（検品観点として指示されていない）だが、code 上の state 遷移と既存 journal/log 実装との整合性から、受け入れ条件の挙動はコード上で担保されていると判断する。
