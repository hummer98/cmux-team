# T307 Inspect Report — Dashboard に Metrics タブ追加

## Verdict: GO

## Summary

plan.md のサブタスク (1)〜(12) は全て実装されており、Design Review Recommendations (#1/#2/#4/#5/#6) も過不足なく反映されている。`bun test` 1208 pass / 0 fail、touched files の tsc エラー 0 件、Rec #1 の `daemon.traceDb` 再利用・Rec #2 の 0 除算 / null 入力テスト・Rec #5 の caption・Rec #6 の `PROXY_IDLE_THRESHOLD_SEC=60` fallback まで実装コードに grep で確認できた。Critical 0 件・Major 0 件、Minor 3 件のみで GO 判定。

## Findings

### 1. [minor] merge-base が T305 (e0c2d63) で main (T306 = 13ac1b7) に追いついていない

- HEAD は T305、main は T306 (trace-task の Token Usage セクション追加、`getTaskUsageTotal` / `getTaskUsageByRole` / `getTaskUsageByModel` を `trace-store.ts` / `main.ts` / `trace-store.test.ts` に追加)。
- worktree の `trace-store.ts` には T306 関数群が存在しないため、`git diff main -- skills/cmux-team/manager/trace-store.ts` では T306 関数群が **削除扱い**で出る。ただし T307 patch 自体は merge-base (e0c2d63) に対して **純粋に append-only**（末尾に 4 集計関数を追加するのみ、既存関数は触っていない）。
- 影響: Conductor Step 8 の rebase で main=T306 に乗せ換える際、`trace-store.ts` / `main.ts` / `trace-store.test.ts` に対して T306 の append と T307 の append が同じ領域（`getApiUsage` の直後）に並ぶため、3-way merge で **conflict が発生する可能性が高い**。T284 の Step 8 semantic resolution で T306 関数群を保持したまま T307 関数群を併置するように resolve すれば解消する想定。
- T307 実装自体の欠陥ではないため minor 扱いだが、Step 8 担当者への引き継ぎ情報として記録する必要あり。

### 2. [minor] impl-report の既存テスト件数表記が実測と若干ズレ

- impl-report: 「dashboard-issues.test.tsx の既存 12 テスト全て green」
- 実測: `bun test dashboard-issues.test.tsx` → **11 pass / 0 fail**
- impl-report 下段の内訳セクションでは「dashboard-issues 11」と正しく記述されているため typo と推測。機能には影響なし。

### 3. [minor] impl-report の i18n キー数表記が実測と若干ズレ

- impl-report: 「i18n ラベル 22 キー（metrics_*）を en/ja 両方追加」
- 実測: `grep -c 'metrics_' i18n.ts` → **50 行**（= 25 キー × 2 言語）。dashboard-metrics.ts / dashboard.tsx から参照する全キー (`metrics_tab_title` 〜 `metrics_header_cache`) が en/ja 両方に揃っており、欠落なし。
- 表記揺れのみで rendering・翻訳には影響なし。

### 4. [minor] plan §6.2 の cleanup タスク 3 件が未起票

- plan §6.2 は `conductor.ts(201,3)` TS1016 / `daemon.ts(1558,22)` TS2352 / `daemon.test.ts(3870,9)` TS2322 を別タスクに分離する想定で `conductor-ts-ts1016-cleanup` / `daemon-session-started-narrowing-cleanup` / `daemon-test-session-source-cleanup` という予定タスク名を記載。
- Inspector からは cleanup タスクが実際に起票されたかは verify 不可。T307 のスコープ外で、既存エラーは T305 以前からある out-of-scope であることは確認済。
- フォローアップとして `cmux-team create-task --status draft` で cleanup タスク 3 件を起票するのが望ましい（T307 本体に含める必要はない）。

## Verification Details

### 1. 計画充足 (pass)

`git status` + ファイル内容確認により plan.md の subtask (1)〜(12) 全ての実装を確認:

| subtask | 確認方法 | 結果 |
|---|---|---|
| (1) trace-store 4 集計関数 | `grep -n "^export function" trace-store.ts` 末尾 4 件 | ✓ aggregateApiUsageByRole / aggregateApiUsageByTask / getLatestApiUsageRow / getBurnRateWindow |
| (2) trace-store-metrics.test.ts | `bun test trace-store-metrics.test.ts` | ✓ 14 pass |
| (3) dashboard-metrics.ts 純粋関数 | 新規ファイル Read | ✓ MetricsData + 5 関数 (buildMetricsRows / buildProgressBar / formatBurnRate / computeProjectedToLimit / computeRiskLevel) |
| (4) dashboard-metrics.test.tsx | `bun test dashboard-metrics.test.tsx` | ✓ 26 pass |
| (5) AppState 3 フィールド | `grep -nE 'metricsData\|metricsError\|metricsLastLoadedMs' dashboard.tsx` | ✓ 型定義・initialState 共に反映 |
| (6) loadMetricsData (Rec #1) | dashboard.tsx:1812-1893 Read | ✓ `daemon.traceDb` を reuse (open/close なし) |
| (7) metricsInterval lifecycle | dashboard.tsx:1163 module-scope / 1895-1909 start/stop / 2108-2111 cleanup | ✓ spinnerInterval と別 handle |
| (8) キーバインド + Tab rotation | dashboard.tsx:1586 ("6") / 1598 (M) / 1588 (rotation 配列末尾) | ✓ 3 箇所 |
| (9) タブボタン + rendering 分岐 + footer | dashboard.tsx:1360-1366 ボタン / 1384-1385 rendering / 1458-1465 focusedArea footer / 1473 global M キー | ✓ 4 箇所すべて反映 |
| (10) i18n 22 キー (実測 25) | i18n.ts 780-804 / 1559-1583 | ✓ en/ja 揃い |
| (11) 手動動作確認 | Implementer 未実施、Inspector へ委譲と宣言 | △ 静的検証で interval 管理・rendering 分岐は確認、実環境確認は本番運用で担保 |
| (12) makeState 拡張 | dashboard-issues.test.tsx:64-67 | ✓ 3 フィールド初期値 + 11 既存テスト green |

### 2. Dead / Zombie Code (pass)

- 不要な並行実装なし (他ファイルに `metricsData` / `getLatestApiUsageRow` 類似実装なし)
- import 未使用なし (`buildMetricsRows` / `MetricsData` / 4 集計関数は全て dashboard.tsx で使用されている)
- 古い参照なし

### 3. テスト (pass)

```
$ bun test
 1208 pass / 0 fail / 2921 expect() calls / 40 files [50.83s]
```

- 既存 1168 件 green 維持、新規 40 件 (trace-store-metrics 14 + dashboard-metrics 26) 全て pass
- impl-report の「1208 pass / 0 fail」と一致

### 4. 設計原則 (pass)

- dashboard-metrics.ts は Rezi `ui.row` / `ui.column` / `ui.text` のみで構成、`useState` / `useEffect` / daemon state 参照なし → **純粋関数モジュール** ✓
- loadMetricsData は try/catch で stale-while-error を実装 (1885-1891): `metricsError` のみ差し替え、`metricsData` は前回値を保持 ✓
- metricsInterval は module-scope (dashboard.tsx:1163) で spinnerInterval (別変数) と混同されていない ✓
- cleanup() で metricsInterval を確実に停止 ✓

### 5. 統合 (pass)

- `buildMetricsRows` import: dashboard.tsx:50 ✓
- AppState 新フィールド initializer: initialState / createNodeApp 内 (dashboard.tsx:1206-1208) + dashboard-issues.test.tsx makeState 拡張 ✓
- タブボタン (tab-metrics) / rendering 分岐 / focusedArea footer / global footer の M キー → **4 箇所全て実装** ✓
- i18n キーは dashboard-metrics.ts で使用される 23 種類 (metrics_tab_title 含む) が en/ja 揃って存在 ✓

### 6. 型エラーゼロ化 — touched files (pass)

```
$ bunx tsc --noEmit | grep -E "(dashboard-issues\.test\.tsx|dashboard\.tsx|i18n\.ts|trace-store\.ts|dashboard-metrics\.test\.tsx|dashboard-metrics\.ts|trace-store-metrics\.test\.ts)"
(no output → CLEAN)
```

T307 が touched したファイル 7 本に tsc 新規エラー 0 件。

pre-existing out-of-scope 3 件 (plan §6.2 で cleanup タスク化予定):

- `conductor.ts(201,3)` TS1016 — T307 で触っていない
- `daemon.ts(1558,22)` TS2352 — 同上
- `daemon.test.ts(3870,9)` TS2322 — 同上

### 7. Design Review Recommendations (pass)

| Rec | 反映確認 grep / 実測 | 判定 |
|---|---|---|
| #1 (major) DB 接続戦略 | `grep -n "daemon\.traceDb" dashboard.tsx` → 1814 行目で reuse、1798-1806 にコメントで根拠記述 | ✅ |
| #2 (minor) 0 除算 / null 入力テスト | `dashboard-metrics.test.tsx` の `describe("computeProjectedToLimit (Rec #2)")` (4 test) + `describe("computeRiskLevel (Rec #2)")` (6 test) = **10 ケース** | ✅ |
| #4 (minor) grep 検証の具体値 | `grep -nE '"metrics"\|metricsData\|metricsError' dashboard.tsx \| wc -l` = **23** (impl-report 宣言値と一致) / `grep -nE 'switchTab\("metrics"\)' dashboard.tsx \| wc -l` = **3** | ✅ |
| #5 (minor) caption `from: role/surface (age)` | i18n.ts `metrics_caption_from: "from: {role}/{surface} ({age}s ago)"` (en) / `"from: {role}/{surface} ({age}秒前)"` (ja) + dashboard-metrics.test.tsx の `"Rec #5: ..."` テスト | ✅ |
| #6 (minor) proxy idle fallback | `grep -n "PROXY_IDLE_THRESHOLD" dashboard-metrics.ts` → 65 行目 `const PROXY_IDLE_THRESHOLD_SEC = 60;` + 191 行目で閾値判定 + test 3 件 | ✅ |

## Fix Required

（GO 判定のため不要）
