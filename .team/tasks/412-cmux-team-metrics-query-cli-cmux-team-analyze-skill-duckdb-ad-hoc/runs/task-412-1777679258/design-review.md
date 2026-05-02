## Verdict: Approved

## Summary

T412 plan.md は受入条件 6 件を全て対応するサブタスクへ分解し、構造的解決（SQL を runtime として外部化、storage 層は不変）と既存パターン（`runFooCli` 契約・`runWithAbort`・`Bun.which`・i18n の en/ja 両 namespace・`cmdMetrics` 内 `if (sub === "...")` 分岐）への整合が一貫している。Decision Log 15 件で代替案の却下理由が明示されており、エッジケース・リスクも `traces.db` / `events.jsonl` / snapshot dir 不在時の view skip 含めて網羅されている。Critical findings 0 件、CRITICAL チェック項目（サブタスクカバレッジ / 統合検証 / 削除完全性 / 既存テスト影響）すべて pass。後段は minor recommendations のみ。

## Findings

### F1 [minor] `read_json` の glob 0 件挙動が S2 内検証に委ねられている
- plan.md §2.5 / S2 自身が「`read_json` が glob 0 件を許容するかを確認 → 不可なら view 作成を条件付きにする」と検証ポイントとして明示している。S2 完了条件「dir 不在時は view 作成 skip + warn」と合わせて実装フェーズで吸収できるため計画として許容範囲だが、glob 0 件の挙動に関する事前情報があれば S2 ステップが短縮される。

### F2 [minor] `--format tsv` の `.separator` 注入経路が CLI dot-command と SQL の境界をまたぐ
- S3 の format → flag 表で `tsv` を `-list` + `.separator "\t"` の事前注入と定義している。`.separator` は DuckDB CLI の dot-command（SQL ではない）であり、stdin に書く全文の **先頭行**（init SQL より前）に置く必要がある。あるいは代替案として `-csv -separator "\t"` を採用する方が文法上の境界線がきれいになる。実装時に後者を選ぶ判断材料を S3 完了条件に書き足してもよい。

### F3 [minor] `--format table` の DuckDB version 要件がエラーメッセージに含まれていない
- D11 で `-box` を第一候補としたが、`-box` は DuckDB 0.10+ でのみ有効。§2.6 の install 案内には version 要件が無い。`brew install duckdb` で取得される最新版は問題ないが、古い manual install のユーザーが `--format table` で詰まる可能性がある。エラーメッセージか help_metrics_query に「DuckDB 0.10+ 推奨」を 1 行追記すると親切。

### F4 [minor] `--sql` と stdin 同時指定の挙動がテスト網羅から漏れている
- §5.2 で「`--sql` を優先、stdin は無視（usage に明記）」とあるが、S7 のテストケース 1〜7 にこの挙動の assert が含まれていない。S7 のケース 1（arg parse）に「`--sql` + stdin 同時指定で `--sql` 優先」を 1 ケース足すと実装の偶発的退行を防げる。

### F5 [minor] i18n 辞書整合性テストの確認漏れ
- S6 の検証は `grep -n 'help_metrics_query' i18n.ts` が 2 件 hit のみ。既存 i18n に en/ja 全キー網羅性をチェックするテストがある場合、片方の namespace だけ追加した状態だと既存テストが落ちる可能性がある。S6 完了条件に「`bunx tsc --noEmit` および既存 i18n test を per-file 実行して通すこと」を 1 行足しておくと安全。

### F6 [minor] S8 recipe の動作確認結果の記録先が曖昧
- S8 完了条件「6 本通して 0 exit を確認した record を計画書に残す」とあるが、計画書（plan.md）は planning フェーズの成果物で、実装後に追記するのは整合性上やや不自然。S11 のように `.team/output/` 系または review コメントに記録する方針へ統一すると後段の追跡がしやすい（S11 自身も「`.team/output/planner.md` の補足セクション、または review 時の comment」と書いており、これを再利用すればよい）。

### F7 [minor] CRITICAL チェックは全て pass しているが「既存テストへの影響」記述の根拠
- §5.1 で「既存 `metrics-cli.test.ts` には影響なし（module 分離）」とあり、main.ts の if 分岐追加・i18n.ts の key 追加が既存テストに影響しないという主張は妥当。確認のため、実装時に `cd skills/cmux-team/manager && for f in metrics-cli.test.ts main-*.test.ts i18n*.test.ts; do bun test --timeout 30000 "$f"; done` を S5-S6 完了条件の検証コマンドに追加することを推奨。

## Recommendations

Approved のため必須の修正指示はなし。F1-F7 は実装時に back-fill すれば足りる範囲（テストケース追加・エラーメッセージ 1 行加筆・記録先の表記統一）。実装フェーズで以下を意識すれば品質がさらに上がる：

1. **S3**: `--format tsv` を `-csv -separator "\t"` で実装する案を第一候補にし、`-list` + `.separator` 案は fallback とする（dot-command と SQL の境界が混ざらないため）
2. **S6**: i18n テストがあれば per-file で通すことを完了条件に追加
3. **S7**: テストケースに「`--sql` + stdin 同時指定で `--sql` 優先」を追加
4. **S8**: recipe 動作確認の record 先を S11 と同じ `.team/output/` 配下に統一
5. **§2.6 / help_metrics_query**: 「DuckDB 0.10+ 推奨」を 1 行追記
