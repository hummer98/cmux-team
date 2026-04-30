# T307 Summary — Dashboard に Metrics タブ追加

## ゴール

T305 の `api_usage` テーブルを dashboard TUI で可視化し、バーンレート（レート制限到達までの projected 秒数）・ロール別消費・タスク別消費を 1 秒間隔でリアルタイム観測できる Metrics タブを追加する。

## 完了したサブタスク

plan.md の (1) 〜 (12) 全て完了（11 は静的検証＋Inspector 検品で代替、実環境確認は本番運用で担保）。

## 変更ファイル

### 新規（3 件）

| パス | 内容 |
|------|------|
| `skills/cmux-team/manager/dashboard-metrics.ts` | Metrics タブ純粋 build 関数群（264 行） |
| `skills/cmux-team/manager/dashboard-metrics.test.tsx` | 純粋関数ユニットテスト（26 件） |
| `skills/cmux-team/manager/trace-store-metrics.test.ts` | 集計関数ユニットテスト（14 件） |

### 変更（4 件）

| パス | 変更概要 |
|------|---------|
| `skills/cmux-team/manager/trace-store.ts` | 4 集計関数（`aggregateApiUsageByRole` / `aggregateApiUsageByTask` / `getLatestApiUsageRow` / `getBurnRateWindow`）+ 3 型を末尾に append |
| `skills/cmux-team/manager/dashboard.tsx` | AppState に metrics 3 フィールド追加、loadMetricsData、metricsInterval lifecycle、キーバインド `6` / `M`、Tab rotation、タブボタン、rendering 分岐、footer ヘルプ |
| `skills/cmux-team/manager/i18n.ts` | `metrics_*` ラベル 25 キーを en/ja 両方追加 |
| `skills/cmux-team/manager/dashboard-issues.test.tsx` | `makeState()` に metricsData / metricsError / metricsLastLoadedMs 初期値を追加 |

## 検証結果

- `bun test`: **1208 pass / 0 fail**（既存 1168 + 新規 40）
- `bunx tsc --noEmit`: T307 touched files に新規エラー 0 件（既存 out-of-scope 3 件: conductor.ts:201 / daemon.ts:1558 / daemon.test.ts:3870）
- `grep` 検証: `"metrics"|metricsData|metricsError` が dashboard.tsx に 23 箇所、`switchTab("metrics")` が 3 箇所

## Design Review Recommendations 反映

- **Rec #1 (major)** DB 接続戦略: `loadMetricsData` で `daemon.traceDb` を reuse（open/close せず、同一プロセス multi-reader 活用）
- **Rec #2 (minor)** 0 除算・null 入力テスト: `computeProjectedToLimit` / `computeRiskLevel` の edge case を 10 ケース追加
- **Rec #4 (minor)** grep 検証の具体値固定: impl-report / inspect-report で実測値を記載
- **Rec #5 (minor)** Rate limit caption: `from: <role>/<surface> (<age>s ago)` を Metrics タブ上段に表示
- **Rec #6 (minor)** proxy idle fallback: `PROXY_IDLE_THRESHOLD_SEC = 60` で「proxy idle? last seen Ns ago」表示（burn rate 0 との区別）

## Inspector Verdict

**GO** — Critical 0, Major 0, Minor 3（rebase conflict 予告 / impl-report の軽微な表記ズレ 2 件）

## 残課題（out-of-scope）

- plan §6.2 の cleanup タスク 3 件（`conductor.ts(201,3)` / `daemon.ts(1558,22)` / `daemon.test.ts(3870,9)`）は未起票。T307 のスコープ外で、別タスクとして後日起票予定。
- Inspector finding #1: T306 (main に含まれる `getTaskUsageTotal` 等) と T307 の trace-store.ts 末尾 append が衝突する可能性。Step 8 の semantic resolution で対応する。

## マージコミット / PR

（完了処理 Step 9 で決定、後段更新）
