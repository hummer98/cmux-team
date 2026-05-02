# T402 検品レポート: util_5h=null 時の Metrics と CLI 表示揃え

## Verdict: GO

## Summary

plan.md S1〜S7 が実装ファイル 4 件 (token-format.ts / dashboard-metrics.ts + 各 test) に反映され、関連 6 テストファイルが個別実行で全 pass、touched files の `bunx tsc --noEmit` も型エラー 0 件。受け入れ条件 ①「CLI / Metrics 表現一致」と ②「null と reset 通過 0 の視覚的区別」は S1 (t1)(t3) と S3 (g)(j)(k) のテストで証明されており、@tayo 系既存出力 (`util_5h=0.02 + reset 通過 → "0%"`) も維持されている。Critical / Major / Minor いずれも 0 件。

## Findings

1. **[minor] git diff main...HEAD が空 (commit 未作成)** — 実装は worktree 上の未コミット変更として存在（`git status` で `M` 4 ファイル + package-lock.json）。これは impl-report.md 末尾の状況と一致しており、検品では `git status` ベースの作業ツリー検証で計画充足を確認済み。コミットは Conductor 側で行う前提のため検品スコープ外。
2. **[informational] 計画充足の検証** — メソッド制約 grep がすべて期待件数で hit:
   - `token-format.ts:66` `snap!.util_5h == null && !eff.reset5hPassed` ✓
   - `token-format.ts:70` `snap!.util_7d == null && !eff.reset7dPassed` ✓
   - `dashboard-metrics.ts:219` `snap?.util_5h == null && !eff.reset5hPassed ? null : eff.effUtil5h` ✓
   - `dashboard-metrics.ts:221` `snap?.util_7d == null && !eff.reset7dPassed ? null : eff.effUtil7d` ✓
   - `dashboard-metrics.ts:296` `ui.text("5h:  --", { dim: true })` / `:301` `ui.text("7d:  --", { dim: true })` ✓
   - 旧経路 (`formatUtil(0)="0%" for util=null`) はソース上から消滅。
3. **[informational] Dead/Zombie code** — 旧 / 新分岐の並行なし、両軸 null + hasSnapshot=true 用の防御分岐なし (構造上 `hasSnapshot=false` 経路で吸収される設計を採用)。
4. **[informational] テスト結果** — 6 ファイル全 pass:
   - token-format.test.ts: 23 pass / 0 fail
   - dashboard-metrics.test.tsx: 45 pass / 0 fail
   - token-cli.test.ts: 39 pass / 9 skip / 0 fail
   - pool-cli.test.ts: 4 pass / 0 fail
   - token-store.test.ts: 154 pass / 1 skip / 0 fail
   - dashboard-issues.test.tsx: 11 pass / 0 fail
   受け入れ条件 ② は `dashboard-metrics.test.tsx (k)` (`util5h=0 + util7d=null + reset5hPassed=true + reset7dPassed=false`) で「5h `0%` bar + `*` マーカー」と「7d `7d:  --` placeholder」の同一行内共存を string assertion で証明 (lines 828-849)。
5. **[informational] 設計原則整合** —
   - D6: placeholder 文字幅検証 — `"5h:  --"` / `"7d:  --"` / `"5h:  0%"` がそれぞれ 7 文字 (`wc -c` で確認済み)、bar 行と縦揃え。
   - D5: reset 通過軸は元 null でも `effUtil=0` を採用する `computeEffUtil` の意味と整合。
   - D4: CLI / Metrics で `"--"` 文字列リテラルを共有 (i18n 化なし)。
6. **[informational] 統合チェック** — `formatPerHandleUtilCell` の呼び出し元 (`token-cli.ts` / `pool-cli.ts`) のテストが pass、`buildPoolTokenRowFromSnapshot` / `buildPoolTokensSection` の呼び出し元 (`dashboard-metrics.test.tsx` / `dashboard-issues.test.tsx`) も pass。
7. **[informational] 型エラーゼロ化** — touched 4 ファイル (`token-format.ts/test.ts`, `dashboard-metrics.ts/test.tsx`) について `bunx tsc --noEmit` を実行し、対象ファイル発の型エラー 0 件。
8. **[informational] T402 特有チェック** —
   - S3 (k) fixture が plan 最終形 (`util5h=0 + util7d=null + reset5hPassed=true + reset7dPassed=false`) と完全一致 (`dashboard-metrics.test.tsx:828-849`)。
   - 両軸 null + hasSnapshot=true の防御分岐は不在 (S5 ループ内に該当条件分岐なし)。
   - 既存 `@tayo` 系テスト (`token-cli.test.ts:821` / `pool-cli.test.ts:133`) は `util_5h=0.02 ≠ null` で reset 通過のケースのため、本変更の影響を受けず引き続き `"0%"` 表示を維持 (テスト pass で確認)。

## 判定

- Critical: 0 件
- Major: 0 件
- Minor: 1 件 (コミット未作成 — スコープ外)

→ **GO** (Critical 0 件 AND Major 2 件以下を満たす)
