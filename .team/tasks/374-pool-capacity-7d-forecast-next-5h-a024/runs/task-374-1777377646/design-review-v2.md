# Design Review v2 — T374 plan.md 改訂版

## 1. Verdict

**Approved**

前回 review (round 1) の R1〜R6 はすべて plan 改訂版で適切に反映されており、新規の致命的問題は混入していない。実装着手して差し支えない。

## 2. Reflection check (R1〜R6)

| ID | 指摘内容 | 反映状況 | 反映箇所 |
|---|---|---|---|
| **R1** | Phase 順序を「拡張 → 切替 → 削除」に再配列（中間 Phase で tsc を通す） | **Done** | §3.1（Phase 3 時点の型: header 残す）/ §3.2（Phase 5.5 時点の型: header 削除）/ §9 Phase 3 で `forecast7d` / `nextCandidate` を追加（header 残置）/ Phase 5.5 を新設して header 削除。各 Phase 末に `bunx tsc --noEmit` の pass を明記（§9 Phase 1-7 ステップ末尾） |
| **R2** | A024 update をドキュメント更新スコープに含める | **Done** | スコープ表 F8 に `A024-pool-capacity-7d-forecast-gauge.md` への脚注追加を明示 / §8.4 で選択肢 A（artifact update）を採用し具体的な脚注本文を提示 / §10.2 で根拠（state を外部化原則）を明文化 / §11 受け入れチェックリストにも反映 / Phase 9 で実施 |
| **R3** | `buildBinRanges` を `(nowIso, timezone)` 引数の純関数化（代替案 b 推奨） | **Done** | §1.1 で `computePool7dForecast(tokens, nowIso, timezone?)` シグネチャ / §1.2 で `buildBinRanges(nowIso, timezone)` の純関数化 / §1.4 で `Intl.DateTimeFormat(..., { timeZone: timezone, hourCycle: "h23" })` を用い `setHours` を回避する実装を提示 / §7.1 の test で `TZ="UTC"` 直接注入 / DST safety テスト（`America/New_York` 3/8 シフト相当）を §7.1 / §10.4 に追加 |
| **R4** | `PeekedToken` に `util_7d` を追加 | **Done** | §2.1 で `util_7d: number \| null` を追加 / §2.2 で `peekNextToken` 戻り値が `{ handle, util_5h, util_7d }` / §2.3 で `admitCandidates` の戻り値 `effUtil7d` を return / §3.7 と §7.2 のテストでも util_7d を assert |
| **R5** | スパークライン境界値 / forecast 境界 reset の test.each 明示 | **Done** | §7.4 に `mapBarToSparkline` の test.each テーブル（[0, 12.4999, 12.5, 25, 37.5, 50, 62.5, 75, 87.5, 99.9999, 100, 150]）/ §7.1 Case 1 に「境界 reset (reset_7d_at が Day 1 binEnd=48h と一致) で off-by-one が起きない」テストを追加 |
| **R6** | §10.3 tsconfig 補足 / §6.1 `pool-cli.ts` 事前 grep | **Done** | §10.3 に `tsconfig.json: noUnusedLocals=false / noUnusedParameters=false` の明記 / §6.1 に `grep -rn "header\.\(capacity5hPct\|capacity7dPct\)\|summary\.header" pool-cli.ts token-cli.ts` の事前確認手順を追加 / §9 Phase 0 にも事前 grep を組み込み |

すべて Done（Partial / Not Done なし）。

## 3. Newly found issues

### N1. §7.4 の test.each テーブルに「87.5 → ▆」と書かれているが、後段コメントで自己訂正済み（軽微）

`§7.4` のテーブル該当行:

```ts
[87.5,    "▆"],   // [87.5, 100) は ▇ ではなく ▆？ → 確認: A024 ▇=[87.5,100) なので ▇ が正
```

コメントで「`▇` が正」と訂正されているため意図は明確だが、コードリテラルが `▆` のままなので、実装者が機械的に貼り付けると test が落ちる。実装時にリテラルを `▇` に直すこと。**A024 §TUI 表示「[87.5, 100): ▇」および §4.2 の `if (barPct < 100) return "▇"` と整合させる**。

致命度: 軽微（プロセス的に Phase 4 の test 実行で必ず即時露見する。設計には影響しない）。

### N2. §3.5 `loadPoolSummary` の `await buildSelectTokenPolicy(projectRoot)` の同期/非同期確認（軽微）

`buildSelectTokenPolicy` が現状 sync か async か未確認のまま `await` を付与している。実装着手時に該当関数のシグネチャを確認し、sync ならば `await` を外す（または Promise.resolve でラップ）。Phase 3 step 3 で吸収できる範囲。

致命度: 軽微（Phase 3 着手時の grep で即時解消する）。

### N3. Phase 5 で `dashboard.tsx` の legacy `buildPoolHeader` 参照削除を「Phase 5」に置いた整合性

§5.3 で「dashboard 旧経路 `buildPoolHeader` (dashboard.tsx:530) は **削除**」、§9 Phase 5 step 2 でも同様。Plan §9 Phase 5 step 2 の「`dashboard.tsx` 旧 `buildPoolHeader` (legacy) の参照を削除」が `pool-header-display.ts` 書き換えと同一 Phase に収まっているのは妥当。NOTE T363 で「描画経路から外した」と既述のため、削除のみで dashboard の動作差分はないはずだが、Phase 5 末の `bunx tsc --noEmit` で `dashboard.tsx` 内に未使用 import 等が残らないか確認する旨を Phase 5 step 5 の確認項目に **明示的に書いておくと安全**（tsconfig が noUnusedLocals=false なので tsc では出ないが、実装者がうっかり残すリスクはある）。

致命度: 軽微（既存方針との整合は取れているため改訂は不要、実装者への備忘のみ）。

## 4. その他の軽微チェック

- 計算式・bin 切り出し・スパークライン文字マッピング・色閾値・エッジケース 8 項目は前回同様 A024 と一対一で対応している。改訂版でも逸脱なし。
- 付録 A / B の数値（Case 1: `[108,108,71,71,71,100,100]` / Case 2: `[126,126,94,71,71,78,100]`）は前回手計算検証済み、改訂で変更なし。
- 「`bun test` 全体実行は禁忌」という CLAUDE.md ガードは Phase 8 で `for f in *.test.ts state-machine/*.test.ts dashboard-*.test.tsx` の個別 loop に従っており整合。
- `§9 Phase 5.5` の「`grep` で `summary.header` / `\.header\.capacity` がヒットしないこと」の最終確認手順は構造的に正しい。

## 5. Recommendations

なし（Verdict が Approved のため）。

実装時の備忘として以下のみ:

1. **N1**: `§7.4` の test.each テーブルで `[87.5, "▆"]` と書かれている箇所を実装時に `[87.5, "▇"]` に修正する。
2. **N2**: Phase 3 着手時に `buildSelectTokenPolicy` の sync/async を確認し、`§3.5` の `await` の要否を判断する。
3. **N3**: Phase 5 末で `dashboard.tsx` の `buildPoolHeader` 関連 import / helper が漏れなく削除されているか目視確認する。

---

## 受け入れ判定の根拠

R1〜R6 全項目 Done、新規問題 N1〜N3 はいずれも軽微（実装フェーズで自然に解消する範囲）。Phase 順序（R1）の修正により tsc 健全性が各 Phase 末で保証される構造に再配列されており、A024 整合（R2）も artifact 側の脚注更新がスコープに入った。TZ 注入（R3）は代替案 b（純関数 + 引数）で実装されており DST safety テストも組み込まれている。

総合: **Approved**。実装着手可。
