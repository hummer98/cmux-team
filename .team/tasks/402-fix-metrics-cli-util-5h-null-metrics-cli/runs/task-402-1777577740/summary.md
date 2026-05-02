# T402 完了サマリー: util_5h=null 時の Metrics と CLI 表示揃え

## 概要

T401 のフォローアップ。`snap.util_5h=null` の場合に CLI と Metrics で表示が乖離していた問題（CLI は `"0%"`、Metrics は空欄）を解決し、両者で同じ視覚言語（`"--"` 表記）に統一した。同時に「値がない」と「reset 通過で 0」を視覚的に区別できる構造を導入した。

## 採用方針 (Decision Log 抜粋)

- **D1**: 案 B 派生 — CLI 既存の `formatUtil(null)="--"` パターンに Metrics 側を合わせ、reset 通過軸は CLI/Metrics ともに `"0%"` に統一
- **D5**: reset 通過時に元 `snap.util_*=null` だった軸も `0` 確定（`computeEffUtil` の意味と整合）
- **D6**: Metrics の placeholder は `"5h:  --"` / `"7d:  --"` (各 7 文字、`buildUtilizationBar` の `"5h:  0%"` 先頭 7 文字と同幅で縦揃え)
- **D4**: i18n キーは追加せず、`"--"` 文字列リテラルを CLI/Metrics 共通で直書き

## 完了したサブタスク

| # | 内容 | 結果 |
|---|------|------|
| S1 | `token-format.test.ts` に T402 RED ケース 3 件 (t1)(t2)(t3) を追加 | 3 件 fail (期待通り) |
| S2 | `formatPerHandleUtilCell` に `snap!.util_*==null && !eff.reset*Passed` 分岐実装 | 23/23 pass |
| S3 | `dashboard-metrics.test.tsx` に T402 RED ケース 5 件 (g)(h)(i)(j)(k) + CLI 等価性 1 件追加 | 3 件 fail (i)(j)(k) |
| S4 | `buildPoolTokenRowFromSnapshot` の null 判定変更 (reset 通過軸は 0 確定) | (i) GREEN |
| S5 | `buildPoolTokensSection` に軸単位 placeholder (dim `"5h:  --"`/`"7d:  --"`) 追加 | 45/45 pass |
| S6 | 関連 6 テストファイルの regression 確認 | 全 pass |
| S7 | 受け入れ条件 ①② が test レベルで証明されていることを確認 | OK |

## 変更ファイル

| パス | 変更内容 |
|------|---------|
| `skills/cmux-team/manager/token-format.ts` | `formatPerHandleUtilCell`: snap exists でも `util_*=null && !reset*Passed` のとき `"--"` を返す分岐を追加 |
| `skills/cmux-team/manager/dashboard-metrics.ts` | (a) `buildPoolTokenRowFromSnapshot` の `util*` 計算を「null かつ reset 未通過なら null、それ以外は `eff.effUtil*`」に変更。(b) `buildPoolTokensSection` の cells 構築で `bar` がない & `util*===null` の軸に dim `"5h:  --"`/`"7d:  --"` placeholder を描画 |
| `skills/cmux-team/manager/token-format.test.ts` | (t1)(t2)(t3) 3 ケース追加 |
| `skills/cmux-team/manager/dashboard-metrics.test.tsx` | (g)(h)(i)(j)(k) + CLI 等価性検証 1 件、計 6 ケース追加 |

新規作成・削除ファイルなし。i18n キー追加なし。

## テスト結果

```
token-format.test.ts:        23 pass / 0 fail
dashboard-metrics.test.tsx:  45 pass / 0 fail
token-cli.test.ts:           39 pass /  9 skip / 0 fail
pool-cli.test.ts:             4 pass / 0 fail
token-store.test.ts:        154 pass /  1 skip / 0 fail
dashboard-issues.test.tsx:   11 pass / 0 fail
```

`bunx tsc --noEmit` で touched files の型エラー 0 件。

## 受け入れ条件の達成

- ① 同じ snapshot を CLI と Metrics で表示した時に表現一致
  - `dashboard-metrics.test.tsx` の T402 CLI 等価性 test ケースで CLI `display5h="--"` と Metrics `util5h=null + formatUtil(null)="--"` の同期を fixture 共有で検証
- ② 「値がない」と「reset 通過で 0」が視覚的に区別できる
  - `dashboard-metrics.test.tsx (k)` (5h `util=0 + reset5hPassed=true`、7d `util=null + reset 未通過`) で同一行内に「5h `0%` bar + `*` マーカー」と「7d `7d:  --` placeholder」の三者共存を string assertion で検証

## 既存挙動への影響

- `@tayo` 系既存テスト (`token-cli.test.ts:821` / `pool-cli.test.ts:133`、`util_5h=0.02 + reset 通過`) は `util_5h ≠ null` のため引き続き `"0%"` 表示を維持
- snap exists + util_*=null は subscription token 登録直後の極短時間でのみ発生する稀なケース。grep `"0%"` で確認した範囲では既存テストへの破壊的影響なし

## 関連レビュー

- Phase 2 Design Review: Round 1 で Major 2 件 + Minor 3 件指摘 → Planner 再 spawn で全反映 → Round 2 で Approved
- Phase 4 Inspector: Critical 0 / Major 0 / Minor 1（コミット未作成、スコープ外）→ GO

## 関連参考

- T401 plan.md Decision Log D3 / inspection.md Note 3
- マージコミット / PR URL: 後段で埋める
