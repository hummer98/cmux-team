# T401 Inspection Report

## Verdict: GO

## Summary

`buildPoolTokenRows` を `computeEffUtil` 経由に整列し、純粋ヘルパー `buildPoolTokenRowFromSnapshot(handle, snap, nowMs)` を `dashboard-metrics.ts` に export して `dashboard.tsx` から呼ぶ構造で、Metrics と CLI の表示乖離が構造的に解消されている。S1–S8 の全サブタスクが受け入れ条件・メソッド制約付きで実装され、touched files の `tsc --noEmit` はクリーン、関連 6 ファイルの個別 bun test は全 pass (`dashboard-metrics: 37 pass`、`token-format: 20 pass` 等)、CLI 等価性 (S6-d) と marker 描画 (S6-e/e2/f) のテストが受け入れ条件 (`@kddi` 想定 = `util_7d=0.97` + reset 通過 → 0% + `*` + 凡例) を fixture でカバー済み。

## Findings

1. **[minor] `package-lock.json` に T401 と無関係な差分が含まれている** — `git diff package-lock.json` で `version: 4.20.0 → 4.22.0` の sync が入っており、これは `main` の `3c34140 chore: release v4.22.0` を反映した結果であって T401 の実装に必要な変更ではない。`HEAD == main` なのでコミット時に worktree 全 add すると無関係差分が混入する。コミット前に `git restore package-lock.json` で除外することを推奨。

2. **[minor] テスト (f) の marker 不在検証は JSON エスケープ表現に依存** — `dashboard-metrics.test.tsx:682` の `expect(s).not.toContain("\"*\"")` は `JSON.stringify` した結果の `"*"` (with quotes) を検査しており、プレーンな `expect(s).not.toContain("*")` の方が直感的。同テスト内の `not.toContain("reset passed") / "reset 通過済み"` で凡例の不在も確認済みなので機能としては正しいが、実装の `ui.text("*", { dim: true })` を JSON 化した結果に依存している点は将来 stringify 形式が変わったときに検知力が下がる可能性がある。

3. **[minor / 範囲外] `util_5h=null` 時の CLI/Metrics 表示乖離 (D3) は本タスク範囲外** — design-review Finding 4 で指摘済み。本タスクスコープ判断としては妥当 (受け入れ条件は reset 通過ケースの一致が主目的) だが、cleanup として follow-up 起票を忘れないこと。impl-report の Issues Encountered 末尾でも認識済み。

## 検品観点別チェック結果

### 1. 計画充足（Critical）— PASS
- S1–S8 すべて実装済み (impl-report と diff の対応確認済み)。
- 変更対象ファイル 4 件すべて変更済み (`git diff --stat` で `dashboard-metrics.test.tsx +219 / dashboard-metrics.ts +42 / dashboard.tsx +13 -12 / i18n.ts +2`)。
- メソッド制約検証:
  - `grep -n "reset5hPassed: boolean\|reset7dPassed: boolean" dashboard-metrics.ts` → 42, 44 行目で hit (S2 ✓)
  - `grep -n "export function buildPoolTokenRowFromSnapshot" dashboard-metrics.ts` → 211 行目 (S3 ✓)
  - `grep "metrics_pool_marker_legend" dashboard-metrics.ts` → 298 行目 (S5 ✓)
  - `grep "metrics_pool_marker_legend" i18n.ts` → 825 (en) / 1639 (ja) の 2 hit (S1 ✓)
- 旧実装削除確認: `grep -n "snap?.util_5h ?? null" dashboard.tsx` → **0 件** (S4 ✓)。`grep -n "buildPoolTokenRowFromSnapshot" dashboard.tsx` → 2 件 (import + 呼び出し)。

### 2. Dead/Zombie Code（Major）— PASS
- 旧実装 (生 `snap?.util_5h` 直読み) は完全消滅。並行コードなし。
- `dashboard-metrics.ts` の新規 import (`computeEffUtil`, `UsageSnapshot`) は両方 `buildPoolTokenRowFromSnapshot` 内で使用。
- `dashboard.tsx` の `buildPoolTokenRowFromSnapshot` import は line 2083 で使用、`PoolTokenRow` 型も `const rows: PoolTokenRow[] = ...` で継続利用。
- テストファイル新規 import (`formatPerHandleUtilCell`, `formatUtil`, `UsageSnapshot`) は (d) テストおよび `snap()` ヘルパーで使用。

### 3. テスト（Critical）— PASS
- `dashboard-metrics.test.tsx`: **37 pass / 0 fail / 79 expect** (新規 7 tests を含む)
- `dashboard-issues.test.tsx`: 11 pass / 0 fail
- `token-format.test.ts`: 20 pass / 0 fail
- `token-store.test.ts`: 154 pass / 1 skip / 0 fail
- `token-cli.test.ts`: 39 pass / 9 skip / 0 fail
- `pool-cli.test.ts`: 4 pass / 0 fail
- CLI 等価性テスト (S6-d): 同 fixture で `formatPerHandleUtilCell({display5h:"0%", display7d:"91%", marker:"*"})` と `buildPoolTokenRowFromSnapshot({util5h:0, util7d:0.91, reset5hPassed:true})` の数値・フラグ・文字列レベル一致を確認済み (R2 反映)。
- Marker テスト (S6-e/e2/f): 5h reset 通過 / 7d reset 通過 (`@kddi-like`) / 全行通過なし の 3 ケースをカバー。

### 4. 設計原則（Major）— PASS
- **DRY/SSOT**: `computeEffUtil` が admit / throttle / CLI 表示 / Metrics 表示 の 4 箇所共有の唯一の実装になり、T390 原則を 4 箇所目に拡張完了。
- **純粋ヘルパー**: `buildPoolTokenRowFromSnapshot` は `daemon.tokenDb` への参照を持たず、`UsageSnapshot | null` を引数で受け取る pure 関数 (DB I/O 非依存)。fixture テストで等価性検証可能な構造になっている。

### 5. 統合（Critical）— PASS
- `dashboard.tsx:58` で `buildPoolTokenRowFromSnapshot` を import、`dashboard.tsx:2083` で `buildPoolTokenRowFromSnapshot(tok.handle, snap, now)` 呼び出し。`now = Date.now()` はループ前 1 回取得 (D7 メソッド制約遵守)。
- import パスは relative (`./dashboard-metrics`) で正しい。

### 6. 型エラーゼロ化 — touched files（Critical）— PASS
- `bunx tsc --noEmit -p skills/cmux-team/manager/tsconfig.json` で touched files (`dashboard-metrics.test.tsx / dashboard-metrics.ts / dashboard.tsx / i18n.ts`) に該当するエラー出力なし。
- プロジェクト全体の `tsc --noEmit` も exit=0。

## GO/NOGO 判定

- Critical: **0 件**
- Major: **0 件**
- Minor: **3 件** (うち 1 件は範囲外 follow-up 認識、1 件は無関係差分の混入注意、1 件はテスト表現スタイル)

→ **GO**

## Note (Conductor 向け申し送り)

- コミット前に `package-lock.json` の version bump (4.20.0 → 4.22.0) を `git restore package-lock.json` で除外推奨 (T401 と無関係)。
- `util_5h=null` 時の CLI/Metrics 表示乖離 (D3 / design-review Finding 4) は本タスク後に Master へ follow-up タスクの起票を忘れないこと。
