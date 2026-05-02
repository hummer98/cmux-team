# T402 Design Review (Round 2)

## Verdict: Approved

## Summary

前回 Changes Requested で指摘した Major 2 件・Minor 3 件すべてが正しく反映されている。特に CRITICAL であった (1) D6 placeholder の 7 文字幅統一と (2) S3 (k) fixture の `util5h=0 + util7d=null + reset5hPassed=true` 化が plan 全体に整合した形で訂正されており、受け入れ条件②「null と 0 の視覚的区別」を同一行内 fixture で証明できる構造になった。本筋の技術判断 (D1〜D8) は前回 Approved 相当のままで、新規 Critical 指摘なし。

## Findings

### Major 1: D6 placeholder 文字数 — 反映済み ✓

`"5h:  --"` (2 spaces, 7 文字) が次のすべての箇所で統一されている:

- 採用方針節: line 67 `dim "5h:  --"`
- 変更対象節 (3.テーブル): line 86 / 88 で `"5h:  --"` placeholder
- S3 サンプル: line 140 / 141 で `"5h:  --"` / `"7d:  --"`
- S5 サンプルコード: line 175 (コメント) / 178 (`ui.text("5h:  --", { dim: true })`) / 183 (`"7d:  --"`)
- S5 メソッド制約: line 188 `"5h:  --"` / `"7d:  --"` (各 7 文字) と `buildUtilizationBar` の `"5h:  0%"` 先頭 7 文字との対応を明記
- S7 受け入れ条件②: line 220 `Metrics dim "5h:  --" (bar なし、先頭 7 文字幅)` / line 222 `7d "7d:  --" placeholder`
- リスク節: line 260 `"5h:  --" placeholder (label + ":" + " " + " --" = **7 文字**)` と `"5h:  0%"` の先頭幅一致を再確認
- D2: line 285 `ui.text("5h:  --", { dim: true })`
- D6: line 289 採用結論で `"5h:  --"` (7 文字) を明示、`"5h: --"` (6 文字) は 1 文字ズレで却下と記述

`"5h: --"` (single space, 6 chars) の旧誤記は D6 の対比文脈以外には残っていない。

### Major 2: S3 (k) fixture 訂正 — 反映済み ✓

- S3 (k) (line 141): `util5h=0 + util7d=null + hasSnapshot=true + reset5hPassed=true + reset7dPassed=false` に書き換え済み。「5h 軸の `"0%"` bar と末尾 `"*"` マーカー、7d 軸の `"7d:  --"` placeholder の三つが同一行内に含まれる」と明記され、受け入れ条件② (両ケース共存) が同一行内 fixture で構造的に証明可能になっている。
- S7 受け入れ条件② (line 222): `S3 (k) (util5h=0 + util7d=null + reset5hPassed=true) で同一行内に...三者が共存` と論拠も同期して訂正済み。
- 「util5h=null + reset5hPassed=true」という生成不可能な fixture は plan 全体から消えている。

### Minor 3: S5 メソッド制約の論証追記 — 反映済み ✓

S5 メソッド制約 (line 189) に以下の論証が追記されている:

> S4 の判定式により `util5h=null` ⇔ `snap.util_5h==null && !reset5hPassed`、`util7d=null` ⇔ `snap.util_7d==null && !reset7dPassed`。両軸とも null になるとき `hasSnapshot = snap !== null && (util5h !== null || util7d !== null) = false` が必ず成立し、line 277 の no data 経路で吸収される。よって本ループ内で「両軸 placeholder」を出力する分岐は不要 (防御的に書かないこと)。

実装者が防御的な不要分岐を書くリスクが構造的に潰されている。

### Minor 4: ケース表 (6) 追加 — 反映済み ✓

ケース表 (line 36) に case (6) が追加されている:

> (6) snap exists + util_5h=null + util_7d=数値 + 5h reset 通過 stale | exists, util_5h=null, util_7d=数値 | true | `"0%"` + `*` (5h) / 数値% (7d) | `0% bar` + 数値 bar + `*` | reset 通過軸は 0 確定、他軸は通常表示

line 38 で「(6) は片軸 null + 他軸数値 + 片軸 reset 通過の混合ケースで、D5 「reset 通過軸は元 null でも 0」を適用する代表例」と明示的に D5 への参照を加えており、ケース表と Decision Log の対応が読みやすくなった。

### Minor 5: grep 結果一覧表 — 反映済み ✓

リスク節 (line 232-239) に grep `"0%"` の結果一覧表が追加されている:

```
skills/cmux-team/manager/pool-cli.test.ts:133  → @tayo (util_5h=0.02, reset 通過) — 影響なし
skills/cmux-team/manager/token-cli.test.ts:821 → 同上
skills/cmux-team/manager/dashboard-metrics.test.tsx:621-622 → CLI 等価性検証 — 影響なし
skills/cmux-team/manager/token-format.test.ts:143/171 → util_5h=数値 — 影響なし
```

D3 の grep 主張が plan 内で自己完結し、実装者が独立に再確認する必要がなくなった。

## Recommendations

なし。前回指摘した 5 件はすべて反映済みで、本筋の設計判断 (D1〜D8) も維持されており、新規 Critical 指摘も発見されなかった。実装フェーズ (S1〜S7) に進んで問題ない。
