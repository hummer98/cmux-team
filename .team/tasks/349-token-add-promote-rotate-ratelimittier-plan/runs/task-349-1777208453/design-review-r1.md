# Design Review (Round 1)

## Verdict
**Changes Requested**

## Summary

全体として TDD の進め方・実装ステップ粒度・既存テスト改修ポイントの洗い出しがよく整理されており、Implementer が plan.md だけで進められる完成度に近い。`PLAN_MAP` 重複排除のために `PLAN_BY_NAME` と `resolvePlanForRegistration` を新設するアーキテクチャは構造的に正しく、新仕様（rateLimitTier 取得失敗時のみ prompt）にも自然にハマる。`cmdTokenRotate` を scope 外とした §3.4 の判断と根拠も納得できる。

ただし 1 点、**rateLimitTier は取得できたが PLAN_MAP に該当エントリが無い**境界条件の挙動が明記されておらず、ここを Implementer が独自判断すると「rateLimitTier 行ログを出した直後に plan prompt が出る」UX になり得る。タスク本文「rateLimitTier 取得失敗時のみ prompt」というルールに対する解釈差を埋める明文化が必要。その他は粒度の小さな整合修正（推奨レベル）。

## Strengths

- **責務分離が明確**: rateLimitTier→plan 解決を `resolvePlanForRegistration` 1 関数に集約し、`cmdTokenAdd` / `cmdTokenPromote` の本体から分岐ロジックを引き剥がしている。CLAUDE.md「決定論的なものはコードで、判断が必要なものは AI で」の精神とも整合。
- **重複排除の設計が筋が通っている**: `PLAN_MAP`（tier→plan/ratio）と `PLAN_BY_NAME`（plan 名→plan/ratio）が同一の値オブジェクトを参照する構造で、ratio 値の真実は PLAN_MAP に一本化される。
- **既存テストへの波及を網羅している**: §5 で `manual 経路成功` / `R-promote-2` / `R-promote-8` / `R-promote-9` / `R-promote-10` を全部リストアップし、それぞれに「plan 空 Enter 1 つ追加」という具体的な改修内容まで踏み込んでいる。Implementer が見落とすリスクが低い。
- **rotate の scope 外判断が透明**: §3.4 で「rotate には source=2 が存在しない / plan 更新は rotate の責務外 / capacity 訂正は set-plan が既にある」と 3 つの根拠を立て、PR description にも書く方針。レビュー時に再議論されにくい。
- **不正値再入力の理由づけ**: §3.3 で「probe を通過した後の prompt なので exit 1 にすると 8s タイムアウトをやり直しになる UX 問題」を明示。エスケープハッチ（空 Enter→unknown）も設計済み。
- **EOF 安全性**: readline mock の「`askAnswers.shift() ?? ""`」と整合する形で「空文字 → unknown 確定 → ループ脱出」を採用しており、テスト・実機（Ctrl+D）双方で破綻しない。
- **`Hint:` メッセージの整合**: §3.5 で「条件式 `if (plan === "unknown")` は変更不要、新 prompt で確定すれば自動的に通らない」と既存実装がそのまま再利用できる点をきちんと押さえている。

## Issues / Recommendations

- **[必須]** **`rateLimitTier` は取得できたが `PLAN_MAP` に該当エントリが無い**境界条件の挙動を §3.6 に追記してください。
  現実装の `rateLimitTier ? PLAN_MAP[rateLimitTier] : undefined` は **tier はあるが値が undefined**（未知の tier 名）のケースで `planEntry === undefined` になり、現状コードでは `plan="unknown"` で確定します。一方 plan.md の `resolvePlanForRegistration` は `fromTier` が undefined なら `promptManualPlan` に落ちる設計のため、**「rateLimitTier 行ログが出る + その直後 plan prompt も出る」という新しい UX** が発生し得ます。タスク本文「`rateLimitTier` 取得失敗時のみ prompt 表示」は「`rateLimitTier` が無い場合のみ」とも「`rateLimitTier` 由来の plan が解決できない場合のみ」とも読めるため、どちらを採るか plan.md で明文化が必要です。
  - 推奨: 後者（PLAN_MAP に無い tier も prompt 表示対象）を採用しつつ、§3.6 に「`rateLimitTier` ありかつ `PLAN_MAP[rateLimitTier]` が `undefined` の場合は **rateLimitTier 行ログを出さず prompt のみ表示**」と書き、`resolvePlanForRegistration` 内で「fromTier がある場合のみログ出力責務をどこかに置く」もしくは「ログ表示も helper に内包する」を選んでください。テストには「未知 tier `"default_claude_max_50x"` 等を投入 → prompt が出る」を 1 ケース足すと安心です。
  - 別解: 前者（rateLimitTier が undefined の場合のみ）を採るなら、`resolvePlanForRegistration` の分岐条件を「`rateLimitTier === undefined` のときのみ prompt」に変更し、`rateLimitTier` ありで `PLAN_MAP` ヒットしない場合は `unknown` に落とす（既存挙動維持）と明記してください。

- **[必須]** **`Found credential:` ログのレイアウトが prompt 表示時に整合しないリスク**を §3.6 のサンプルレイアウトで取り扱ってください。
  現状コードでは `Found credential:` ログ出力後に `rateLimitTier` 行ログ（条件付き）→ `display name` prompt の順序です。新仕様で rateLimitTier 無し時に `Found credential:` の中身が **`organizationId:` 1 行のみ** になり、続けて plan prompt がそのまま出ます。これ自体は崩れではないですが、§3.6 のサンプルでは `\nFound credential:\n  organizationId: ...\nplan (...): ` のように `Found credential:` ブロックの中に prompt が「ぶら下がる」形に見えます。実コードでは `console.log` の改行 + `rl.question` のプロンプト出力の関係で、視認性が悪くなる可能性があります。
  - 推奨: `Found credential:` ブロックと plan prompt の間に明示的な空行を入れる（`console.log("")` を 1 行追加）か、§3.6 のサンプルどおり改行を含めることを Implementer 向けに明記してください。
  - 推奨: T2（manual + 空 Enter）で `consoleLogs` の冒頭が `"Found credential:"` で始まることを assert する、と §7 にあるので、合わせて「`organizationId:` 行と plan prompt 行の間に空行が入っていることを `consoleLogs` で確認」も足すと回帰検出が効きます。

- **[推奨]** **§3.2 の `validPlans` → `PLAN_BY_NAME` 差し替えは scope creep の可能性**があります。
  タスク本文「やらないこと: set-plan 自体の挙動変更」は挙動を制約していますが、`set-plan` の内部実装に手を入れるかどうかは Implementer の判断次第です。挙動不変な refactor 自体は健全ですが、本タスクは「prompt 追加」が主目的であり、set-plan 改修は別タスク（または同じ PR の独立コミット）にすると差分レビューが楽になります。
  - 推奨: §3.2 のステップ 3 を「optional」と明示し、Implementer が時間に余裕があれば実施、なければ `validPlans` を残したまま放置でも OK と書いてください。コミット粒度も「`feat(token): ...` と `refactor(token): unify plan map ...` を分ける」運用が望ましい旨を §6 に追記。

- **[推奨]** **§4 と §5 で T3 のテスト名が表記揺れ**しています。§4 Step 1 では `"wrong-plan"` / §5 表では `"wrong"` と書かれていますが、これは同じテスト T3 を指しているはずです。実装時にどちらが正なのか迷うので片方に統一してください（`"wrong-plan"` のほうが「不正値」が明示的なので推奨）。

- **[推奨]** **§5 の表現「plan prompt スキップ」が誤解を招く**。
  R-promote-2 / R-promote-8 / R-promote-9 / R-promote-10 の改修で「回答列に空 Enter（plan prompt スキップ）を 1 つ追加」と書かれていますが、空 Enter は「plan を unknown として確定する入力」であり「prompt スキップ」ではありません。Implementer が「prompt が出ないように回答列をいじる」と誤読しないよう、表現を「plan prompt に空 Enter を返す回答を追加（plan=unknown 確定）」に揃えてください。

- **[推奨]** **`promptManualPlan` のエラーメッセージ文言を §3.2 と §7 で統一**してください。
  §3.2 のコード例では `"Error: pro / max-x5 / max-x20 のいずれかを入力してください（空 Enter で unknown）"`、§7 のリスク表では `"pro / max-x5 / max-x20 のいずれかを入力してください"` と末尾の `（空 Enter で unknown）` の有無が揺れています。テストの assertion とコードがズレないよう、テスト側も「`pro / max-x5 / max-x20 のいずれか` を含む」など部分一致で書く方針を §5 に明示するとよいです。

- **[推奨]** **`Hint:` メッセージ非表示テストの追加**。
  §4 Step 1 の T5a で「ヒント文が出ない」を assert する方針ですが、これは新仕様の「prompt で plan 確定 → ヒント出ない」を初めて検証する重要ケースです。assert は `expect(consoleLogs.join("\n")).not.toContain("set-plan")` だけでなく `not.toContain("Hint:")` も併用すると意図が明確になります。

- **[推奨]** **`set-plan` 改修を採用する場合の追加テスト**。
  §3.2 ステップ 3 で `validPlans` を `PLAN_BY_NAME` に差し替える場合、`PLAN_BY_NAME[planArg]?.ratio` 参照に書き換える際に「`planArg` が `undefined` のとき」と「`PLAN_BY_NAME[planArg]` が `undefined` のとき」の Type Narrowing が現状の `validPlans[planArg]` と微妙に違います（前者は `string | undefined` index、後者は `Record<string, ...>` index）。挙動不変であることを保証するために、`set-plan` の既存 3 テスト全てが pass することを Step 5 のチェックポイントに含めてください（§4 では「token-cli.test.ts 全体が green」と書かれているので実質カバーされていますが、明示すると安全）。

## Notes

- §3.5 の「`cmdTokenAdd` 完了メッセージ にヒント文は無い」「本タスクでも追加しない」判断は妥当です。`cmdTokenPromote` の Hint は auto-discover→正規 handle 移行という固有文脈で出てくるものであり、`add` は最初から正規 handle なので必要性が薄い。
- §3.4 の rotate scope 外判断は強く支持します。仮に将来 rotate でも plan 訂正したくなった場合は、`set-plan` 経由 or 別タスク `cmdTokenSetPlan` 拡張で対応する方針が DRY に沿います。
- §7 の「`for (;;)` で EOF 後 await が hang する懸念 → 空文字を unknown として抜ける設計を採る」は実装上の堅牢性として優れており、reject 投げ等の複雑化を避けて妥当です。
- 既存 `R-promote-1` (L704) は rateLimitTier=default_claude_max_20x なので回答列改修不要、という §5 の判定は正しいです。同様に T7 / T8 も同じ理由で改修不要。
- §6 のコミットメッセージ案 `feat(token): plan prompt for unknown rateLimitTier (T349)` は適切。ただし上記 [推奨] のとおり `validPlans` 差し替えを行う場合は別コミットに分けることを推奨します。
- リスク §7 の「Implementer 向けチェックリスト」（§8）が完了基準として機能していて、Reviewer も同じ表で確認できる構造になっているのは良い設計。
