# Design Review (Round 2)

## Verdict
**Approved**

## Round 1 必須項目の対応状況

### [必須1] `rateLimitTier` あり / `PLAN_MAP` 未ヒットの境界条件明文化 → **解決済み**

- §3.6.2 で「前者 / 後者」2 解釈を表で対比し、「Planner の判断: 後者を採用する」を明記。理由 3 点（タスクの真の目的、新料金プラン追加への耐性、escape hatch）も記載。
- §3.6.3 で「`rateLimitTier` 行ログは `PLAN_MAP[rateLimitTier]` が undefined でない場合のみ出す。**未知 tier の場合は出さない**」と出力責務まで明文化。
- §3.6.1 で「ログ出力責務は `resolvePlanForRegistration` helper に内包する」と決め、§3.2 のコード例にも `if (fromTier) { console.log("  rateLimitTier: ...") ... } else { console.log("") ... promptManualPlan }` の形で具体化。
- §3.6.4 で T6（未知 tier `default_claude_max_50x` → prompt 経由で `max-x20` 確定 + `consoleLogs` に未知 tier ログが含まれないこと）を新設。
- §8 完了基準にも「rateLimitTier 由来の plan が解決できない場合（undefined または未知 tier）のみ新 prompt が出る」を反映。

### [必須2] `Found credential:` ログレイアウトと prompt の視認性 → **解決済み**

- §3.6.1 で「`Found credential:` ブロックと prompt の間の空行も helper の責務」と明文化。
- §3.6.3 のログレイアウト図で `console.log("")` による空行を明示。
- §3.2 のコード例で `promptManualPlan` 呼び出し直前に `console.log(""); // Found credential: ブロックと prompt の間の空行` と注記付きで実装。
- §4 Step 1 T2 で「`organizationId:` 行と plan prompt 行の間に空行が入っていることを assert」、§5「Found credential: レイアウトの assert 方針」で正規表現または index 検証の具体例を示し、readline mock が prompt を捕捉しないケースのフォールバック方針（空行 entry 単独 assert）まで踏み込んで記述。

## Summary

Round 1 の 2 つの必須項目はいずれも **§3.6 の小節分割（3.6.1〜3.6.4）と T6 新設** で構造的に解決されている。特に「ログ出力責務を helper に内包する」設計判断（§3.6.1）が秀逸で、未知 tier 境界条件・空行挿入・rateLimitTier 行ログの三つを一箇所で扱える形になり、CLAUDE.md「決定論的なものはコードで」の精神とも整合している。後者解釈（未知 tier も prompt 対象）の採用根拠（§3.6.2）も明快で、Implementer が独自判断する余地が残っていない。

推奨項目もすべて適切に処理されている: §3.2 step 3 の `validPlans` 差し替えは「**本タスクでは採用しない**」と明示的に判断し、理由 3 点と将来対応コミットメッセージまで提示（推奨どおり scope creep を回避）。テスト名 `"wrong-plan"` 統一、エラーメッセージ部分一致方針、Hint 非表示の二重 assert（`set-plan` + `Hint:`）、§5 末尾の「plan prompt スキップ」誤読防止の表現統一注記、いずれも反映済み。

新たな矛盾・副作用は見当たらない。冒頭の `<!-- Revision 2: design-review-r1.md 反映 -->` コメントも明示されており、改訂の追跡性も担保されている。Implementer が plan.md だけで TDD 順に進められる完成度に到達している。

## 残課題
（Approved のため特になし）

## Notes

- §3.2 step 3 を「optional・本タスクでは採用しない」と明示しつつ、§3.2 末尾の「将来対応」項に分離コミットのコミットメッセージ案 `refactor(token): unify plan map between set-plan and add/promote` まで書いた点は、後続タスクへの引き継ぎとして秀逸。
- §5「Found credential: レイアウトの assert 方針」で readline mock が prompt 文字列を捕捉するか否かで assertion をフォールバックする旨を書いた点は、Implementer が実装中に readline mock の実装詳細を確認する手間を予期した親切な設計。
- §7 リスク表に「未知 tier で誤って `unknown` 確定してしまう（後者解釈の取りこぼし）」が追加され、T6 が検証手段として紐付いている。Round 1 で指摘した「Implementer が独自判断する余地」が完全に塞がれた。
- §8 完了基準の最後の項「PR description に rotate scope 外 / 未知 tier 後者解釈 / `validPlans` を残した理由を §3.4 / §3.6.2 / §3.2 から要約して記載」は、PR レビュー時の説明コストを下げる仕組みとして有効。
- 強いて挙げれば §3.6.3 のログレイアウト図で「`fromTier` が **無い**場合」の経路に `→ plan: ...` 行が表示されないことが暗黙だが、§3.2 のコード例（`if (fromTier) { console.log... return; }` で if 内のみ rateLimitTier 行を出す）と組み合わせれば一意に決まるので Implementer の解釈差は発生しない。明文化は不要レベル。
