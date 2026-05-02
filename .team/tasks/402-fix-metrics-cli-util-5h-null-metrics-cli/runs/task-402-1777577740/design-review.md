# T402 Design Review

## Verdict: Changes Requested

## Summary

`computeEffUtil` の意味（reset 通過 → 0 確定）を CLI/Metrics 双方の null 判定に伝播させ、両者を `"--"` 表記で揃える設計の方向性は妥当（D1〜D5、D7、D8 ともに技術的根拠がある）。ただし (1) D6 の placeholder 文字列 `"5h: --"` がラベル位置整合性を主張しているのに実文字数が `buildUtilizationBar` の出力と 1 文字ずれていること、(2) S3 (k) のテスト fixture が S4 で生成される実 row と論理矛盾しており「null と 0 共存」の受け入れ条件②検証が成立しないこと、の 2 点が CRITICAL チェックに直接抵触するため Changes Requested とする。

## Findings

### 1. **[Major]** D6 placeholder `"5h: --"` の文字数主張が誤りで、bar 行と縦に揃わない

**位置**: plan.md line 248、line 277（D6）

plan.md は以下のように主張している：

> ただし `"5h: --"` placeholder は左側ラベル位置が `buildUtilizationBar` の `"5h:  0%"` と微妙にずれる (`"5h: --"` は 7 文字、`"5h:  0%"` も 7 文字でちょうど同幅)。視覚的に揃う設計。

しかし実際の文字数を数えると:

| 文字列 | 実バイト数 |
|---|---|
| `"5h: --"` (1 space + 2 dashes) | **6 文字** |
| `"5h:  0%"` (2 spaces, `padStart(3)` 由来) | **7 文字** |

`buildUtilizationBar` (rate-limit-display.ts:110) は `${label}:${pct.toString().padStart(3)}% ${bar}` のフォーマットで `"5h:  0%"` (label + ":" + 3-padded pct + "%") の **先頭 7 文字** を生成する。

そのため、reset 通過軸が `"0% bar"` で描画され、もう一方の軸が `"5h: --"` placeholder で描画される行（受け入れ条件②の意図そのもの）では:

```
@kddi   5h:  0% ████████░░    7d: 91% ███...
@tayo   5h: --                7d: 50% ████░...
        ^^^^^^                ^^^^^^^
        6 文字                7 文字 → 1 文字ズレ
```

D6 メソッド制約「軸ラベルだけ揃える」「視覚的に揃う設計」と矛盾する。

**修正提案**: placeholder を `"5h:  --"` (label + ":" + " " + "  --") の 7 文字に揃える。すなわち `pct.toString().padStart(3)` と同じ位置に `" --"` を置く。

```ts
// "5h:  0% ███..." (bar あり) と "5h:  --" (placeholder) で先頭 7 文字を揃える
cells.push(ui.text("5h:  --", { dim: true }));
```

これに伴い D6 の表記と plan.md line 247-248 の主張を訂正する。

---

### 2. **[Major]** S3 (k) の fixture が S4 で生成される実 row と論理矛盾、CRITICAL チェック「両ケース共存検証」が成立しない

**位置**: plan.md line 140

> **(k)** `util5h=null + util7d=null + hasSnapshot=true (reset 通過済み)` の row を渡すと、出力文字列に reset 通過軸の `"0%"` bar と `"*"` マーカー、もう一方の軸の `"--"` placeholder の両方が含まれる。

この row は実装上 **生成不可能** かつ **テスト時に与えても 0% bar が出ない**:

- S4 後の `buildPoolTokenRowFromSnapshot` 式: `util5h = snap?.util_5h == null && !eff.reset5hPassed ? null : eff.effUtil5h`
  - reset5hPassed=true なら util5h=eff.effUtil5h=0 になる（null にならない）
  - 「util5h=null かつ reset5hPassed=true」は構造的に発生しない
- `buildPoolTokensSection` の bar 生成条件 (line 264-267): `r.hasSnapshot && r.util5h !== null` → util5h=null なら bar5h=null となり 0% bar が描画されない

つまり (k) を文字通り実装すると「reset 通過軸の `"0%"` bar」がそもそも出ず、両ケース共存を文字レベルで証明できない。

S3 (i) が正しく示している通り、**正しい fixture は `util5h=0 + util7d=null + hasSnapshot=true + reset5hPassed=true`** （または 5h/7d を入れ替えたもの）。

**修正提案**: S3 (k) を以下に書き換える:

> **(k)** `util5h=0 + util7d=null + hasSnapshot=true + reset5hPassed=true + reset7dPassed=false`（5h reset 通過、7d は純粋 null）の row を渡すと、出力文字列に 5h 軸の `"0%"` bar と末尾 `"*"` マーカー、7d 軸の `" --"` placeholder の三つが同一行内に含まれる。

これにより受け入れ条件②「『値がない』と『reset 通過で 0』が視覚的に区別できる」が同一行内 fixture で証明される（CRITICAL チェック「両ケース共存検証」を構造的に満たす）。

なお S7 line 220 で受け入れ条件②の論拠としても (k) を引いているため、両方訂正する必要がある。

---

### 3. **[Minor]** S5 メソッド制約の「両軸とも null かつ hasSnapshot=true は構造上発生しない」根拠の不足

**位置**: plan.md line 187

> `c.row.hasSnapshot=false` 行 (line 277-284 の handle 全体 no data 表示) は変更せず別経路で処理される。両軸とも null かつ hasSnapshot=true は構造上発生しない (`hasSnapshot` 定義より) ため、両軸とも placeholder という状況は出ない。

S4 後の式から導出すると確かに正しいが、plan.md ではその論証が省略されている。実装者が `buildPoolTokensSection` を直接修正する際、`else if (c.row.util5h === null)` の分岐で「両軸 null + hasSnapshot=true」が来た場合の挙動を防御的に書きたくなる可能性がある（不要な分岐が混入する原因）。

**修正提案**: S5 メソッド制約に以下の論証を追記:

> S4 の判定式により `util5h=null` ⇔ `snap.util_5h==null && !reset5hPassed`、`util7d=null` ⇔ `snap.util_7d==null && !reset7dPassed`。両軸とも null になるとき `hasSnapshot = snap !== null && (util5h !== null || util7d !== null) = false` が必ず成立し、line 277 の no data 経路で吸収される。よって本ループ内で「両軸 placeholder」を出力する分岐は不要。

---

### 4. **[Minor]** D5 で「片軸 null + 同軸 reset 通過 + 他軸 0」のケース表が plan に記載されていない

ケース表 (plan.md line 28-37) は (1)〜(5) のみで、reset 通過軸が null の元値を持つ「(3) snap exists + util_5h=null + util_7d=null + 5h reset 通過 stale」しか触れていない。実際の S3 (i) は `util_7d=null` で 7d reset 未到達のケースだが、`util_7d=0.5` 等の「片軸数値 + 他軸 null + reset 通過」の挙動が plan のケース表で **明示されていない**。

D5 の「reset 通過軸は元 null でも 0」という判断ロジックは正しいが、**「snap exists + util_5h=null + util_7d=0.5 + 5h reset 通過 stale」のような混合ケース** が plan の表から読めない。

**修正提案**: ケース表に下記を追加:

| (6) | snap exists + util_5h=null + util_7d=数値 + 5h reset 通過 stale | exists, util_5h=null, util_7d=数値 | true | `"0%"` + `*` (5h) / 数値% (7d) | `0% bar` + 数値 bar + `*` | reset 通過軸は 0 確定、他軸は通常表示 |

---

### 5. **[Minor]** D3 の grep 確認が plan 内で未実施

plan.md line 229:

> grep で `"0%"` を期待する側は存在しない (CLAUDE.md「機械可読される可能性」は仮想的、実装で grep する箇所は無い)。

実際に grep すると:

```
skills/cmux-team/manager/pool-cli.test.ts:133  expect(tayoLine).toContain("0%");      → @tayo (util_5h=0.02, reset 通過) — 影響なし
skills/cmux-team/manager/token-cli.test.ts:821 expect(tayoLine).toContain("0%");      → 同上
skills/cmux-team/manager/dashboard-metrics.test.tsx:621-622                            → @kddi-like CLI 等価性検証 — 影響なし
skills/cmux-team/manager/token-format.test.ts:143/171                                  → util_5h=数値 のケース — 影響なし
```

すべて util_5h が **数値** のテストで `null` ケースではないため、本タスクの破壊的変更（snap exists + util_*=null → `"--"`）の影響を受けない。リスク節 line 240-243 でも同主旨が確認されているが、grep 一覧表自体が plan に書かれていないため、実装者が独立に再確認する必要が出る。

**修正提案**: リスク節 line 226-230 に grep 結果サマリを追記。

## Recommendations

実装前に以下を反映してください。テスト構造の根幹（S3 (k) の fixture）と視覚整合の根幹（D6 placeholder 文字幅）の 2 点が訂正されないと、実装後にやり直しが発生します。

1. **D6 placeholder 文字列を `"5h:  --"` / `"7d:  --"` (各 7 文字、bar 行の `"5h:  0%"` と先頭幅一致) に変更し、plan.md line 247-248 の文字数記述を訂正**。S5 のサンプルコード (line 173-181) も `ui.text("5h:  --", { dim: true })` / `ui.text("7d:  --", { dim: true })` に書き換える。
2. **S3 (k) を `util5h=0 + util7d=null + hasSnapshot=true + reset5hPassed=true + reset7dPassed=false` の row に書き換え**、同一行内で「0% bar + マーカー + null placeholder」の三者共存を検証する形にする。S7 line 220 の論拠記述も合わせて訂正。
3. **S5 メソッド制約に「両軸 null + hasSnapshot=true は構造上発生しない」の論証を追記**（finding 3）。
4. **plan.md ケース表 (line 28-37) に「片軸 null + 他軸数値 + 片軸 reset 通過」のケースを追加**（finding 4）。
5. **リスク節 line 229 の grep 確認結果を一覧表として明記**（finding 5）。

これらを反映した上で再 review を依頼してください。実装方針自体（CLI/Metrics 双方を `"--"` 表記で統一、reset 通過軸は元 null でも 0 確定）は維持で問題ありません。
