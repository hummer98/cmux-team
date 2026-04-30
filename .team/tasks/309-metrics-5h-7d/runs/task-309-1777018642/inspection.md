# T309 Inspection Report

## 判定: GO

## 検品結果

### 1. plan 準拠

`git diff` を plan.md と突き合わせた結果、4 ファイルすべて指示通りの削除のみで一致:

- **dashboard-metrics.ts** (-20 行): `MetricsData` interface から `unifiedFive` / `unifiedSeven` + JSDoc 4 行、および描画ブロック（`// ── 上段追加: unified 5h / 7d ──` 〜 `}` まで 16 行）を削除。他の変更なし
- **dashboard.tsx** (-4 行): L1830-1831（fallback 側）と L1871-1872（通常パス）の `unifiedFive:` / `unifiedSeven:` 代入行のみ削除。右辺 `daemon.rateLimit?.unified5hUtilization` への参照は行ごと消えるが、他所の参照は別系統で保持されている
- **i18n.ts** (-2 行): en（L786 相当）と ja（L1569 相当）の `metrics_section_unified` を同時削除
- **dashboard-metrics.test.tsx** (-2 行): `makeData()` フィクスチャから `unifiedFive: 0.4,` / `unifiedSeven: 0.2,` を削除

`git diff --stat` は `4 files changed, 28 deletions(-)`（挿入行ゼロ）で、plan の期待通り。

### 2. 禁止事項

- `rg -n 'unified5hUtilization|unified7dUtilization' skills/cmux-team/manager/ | wc -l` → **49 件**（impl-report 記載と完全一致、plan 作成時点から不変）
- `git diff --name-only | grep -v -E 'dashboard-metrics|dashboard\.tsx|i18n\.ts'` → **空**（変更は 4 ファイルに限定）
- `main.ts` / `daemon.ts` / `rate-limit-display.ts` / `rate-limit-persistence*.ts` / `proxy.ts` / `schema.ts` / `dashboard.tsx` の L1226 付近（throttle indicator）は一切触られていない

### 3. 消し漏れ

すべての grep で 0 件を確認:

| コマンド | 結果 |
|---|---|
| `rg -n 'unifiedFive\|unifiedSeven' skills/cmux-team/` | **0 件** |
| `rg -n 'metrics_section_unified' skills/cmux-team/ docs/ README*.md` | **0 件** |
| `rg -n 'unifiedFive\|unifiedSeven\|metrics_section_unified'`（リポジトリ全体） | **0 件** |

孤立参照・docs / テンプレート / CHANGELOG への取り残しなし。

### 4. テスト

- `bun test skills/cmux-team/manager/dashboard-metrics.test.tsx`: **26 pass / 0 fail** (35 expect, 75ms)
- `bun test`（フル）: **1215 pass / 0 fail** (2957 expect, 40 files)
- `bunx tsc --noEmit 2>&1 | rg 'dashboard-metrics|dashboard\.tsx|i18n\.ts'` → **0 件**（変更ファイルに新規型エラーなし）

### 5. 品質

- **dashboard-metrics.ts の削除跡**: 削除箇所（旧 L317-331）の前後（L311 `}` → 空行 → L313 `// ── 中段: ロール別集計 ──`）は、他セクション（「中段」「下段」）と同じ「直前ブロック閉じ → 空行 1 本 → 次セクションコメント」パターンに収まっており、不自然な空行・残余なし
- **i18n キーセット整合**: en (L783-L800) と ja (L1565-L1582) のキー列を突合、両サイドとも `metrics_section_rate_limit` → `metrics_section_role` → `metrics_section_task` の並びで一致。`metrics_section_unified` は両方で削除済み、片側欠損なし
- **他の `metrics_*` キー**（label / empty / caption 類）は無傷で、arg 互換性を保っている

## Fix Required

なし（GO）。

## 所見・追加の観察

- impl-report.md 注記の通り、`package-lock.json` は worktree 開始時点で既に modified だったベースラインに由来し、`git diff --name-only` / `--stat` には現在現れていない（おそらく途中で revert/clean されたか bun 側で再同期された）。本タスクの変更 4 ファイルに混入していない点は確認済み
- `utilizationColor` ヘルパーは `dashboard-metrics.ts` 内の他 2 箇所（burn rate 着色など）で生存しており、残置は妥当
- フルテスト実行時に `cmux-team issue search abc` 系のハンドリングエラーログが混じるが、これは個別テスト内の異常系検証で、`0 fail` の結果に影響なし
- 目視確認（dashboard 起動して Metrics タブ確認）は Inspector の作業境界外のため未実施。コード・型・テスト・grep の全ゲートは通過しているため、レビュー観点では GO で問題ない
