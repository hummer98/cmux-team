# Design Review (Iteration 2): T413 — {{PROJECT_COMMON_INSTRUCTIONS}} placeholder + _common.md overlay

## Verdict

**Approved**

Iteration 1 で挙げた Major 2 件 / Minor 5 件すべてに plan 内で明示的に対応されており、新たに発生した Critical / Major は無し。改訂ポイントを `M1 / M2 / m1 / m2 / m4` のラベルで plan 内に紐付けてあり、レビュー追跡性も向上している。Implementer に渡して TDD で進めて差し支えない状態。

---

## Iteration 1 Findings の解決状況

- **1. (Major) 展開順序の決定確定 (M1)** — ✅
  - 判断 3 内に「展開順序の確定: `role → common`」を独立節として追加（plan.md:78-87）。
  - 実装スケッチの `expandPromptOverlays` も `expandProjectInstructions` を**先**に呼び `expandProjectCommonInstructions` を後に呼ぶ順で確定（plan.md:121-123）。
  - test (W) の文言が「`role → common` 順による common body 内 literal `{{PROJECT_INSTRUCTIONS}}` の保護」に書き換えられ、整合（plan.md:408）。
  - §補足 6 で「Implementer はこの順序を絶対に変更しないこと（変更すると test (W) が落ちる）」と保守時の地雷を明記（plan.md:465）。

- **2. (Major) test (J) 訂正 (M2)** — ✅
  - §5 のテスト (J) は ~~取り消し線~~ 表記のうえ「**改訂ポイント M2**: test (8) は `OVERLAY_ROLES.length` を動的参照しているため enum 拡張で自動追従する。**更新不要**」と書き換え（plan.md:391）。
  - §3 Step 8 にも「**(8) は更新不要** (動的参照)」「**(18) は要修正**」の二者を分離して明記（plan.md:338-339）。
  - §4 影響範囲表でも「test (8) は `OVERLAY_ROLES.length` を動的参照しているため自動追従。test (18) のみ末尾要素ハードコードを修正」と再確認（plan.md:357）。

- **3. (Minor) テンプレ件数 20 で確定 (m1)** — ✅
  - §3 Step 5 で「**計 20 ファイルで確定**。`spec 04-templates.md:136` の T342 注記により `conductor.md (ja/en)` は deprecated として placeholder 追加対象外」と確定（plan.md:249）。「Implementer / Reviewer 側で再確認」の保留表現は削除済み。

- **4. (Minor) ja heading 確定 (m2)** — ✅
  - 判断 4 で「ja `## プロジェクト共通の追加指示` / en `## Project Common Instructions`」と確定（plan.md:134）。
  - 「共通 vs 固有」「追加指示」の語尾を per-role と揃える対称性、および「同種 overlay の片方だと一目で気づきにくい」という根拠を 2 行で記述（plan.md:136-137）。

- **5. (Minor) CLI test 形式確定 (m4)** — ✅
  - §3 Step 6 で「既存 `agent-instructions.test.ts` には subprocess shell test は存在せず、関数を直接 import して呼ぶスタイル。本タスクでも同パターン（関数直叩き）で書く。subprocess test は導入しない」と確定（plan.md:289-292）。
  - §5 末尾でも「`grep -n "subprocess\|Bun.spawn" agent-instructions.test.ts` で 0 件確認済み — plan iteration 2」と確認方法を残している（plan.md:414）。
  - test (Y) は `cmdSpawnAgent` が export されていない場合の縮退手段（`requireSpawnableAgentRole("common")` 直接呼び）も明記（plan.md:297）。

- **6. (Minor) log format 消費側確認の §4 追記** — ✅
  - §3 Step 6 に消費側 grep 結果を直接書き込み（「現時点では `main.ts:2971, 3190, 3194` 内の log 発行箇所のみで、metrics / dashboard / 外部 parser 側に grep 消費は無い」）（plan.md:286）。
  - §4 影響範囲表の `spawn_agent_expand` 行に「**消費側確認**: 実装直前に `grep -rn "spawn_agent_expand" skills/ bin/ --include="*.ts" --include="*.tsx"` を実行し...」と再確認手順をチェックポイント化（plan.md:358）。

- **7. (Minor 任意) YAGNI 評価条件の追記 (m3)** — ✅
  - §補足 3 を「**`expandPromptOverlays` の API 設計と共通化トリガー（m3）**」として再構成し、「**3 軸目 placeholder が追加された時点で `formatBlock(body, locale, headingKey)` 化する**を後続タスク用の判断トリガーとしてここに残す」と確定（plan.md:462）。
  - §5 TDD step 9 でも REFACTOR 段階のチェック観点として再掲（plan.md:432）。

---

## Strengths

- **改訂トレーサビリティ**: M1 / M2 / m1 / m2 / m4 のラベルを plan 内の各該当箇所に直接埋め込んでいるため、Iteration 1 → 2 の差分がレビューしやすい。
- **展開順序の根拠が「コード仕様レベル」で書かれている**: 判断 3「なぜ role → common 順なのか」の節が `lineRe` の最初の 1 件マッチ性質まで踏み込んで根拠化しており、Implementer / 後続レビュアーが結論だけでなく**設計理由**を再構成できる。test (W) との整合も同じ理屈で説明されているため一読で繋がる。
- **既存 conductor-role.md の heredoc literal 罠に対する事前防御**: Iteration 1 Notes での指摘「conductor-role.md には heredoc 内 literal `{{PROJECT_INSTRUCTIONS}}` が複数ある」が Step 5 末尾の「**重要**: ... `{{PROJECT_COMMON_INSTRUCTIONS}}` placeholder は**冒頭の独立行 (line 7-8 付近) に 1 か所だけ**置くこと」として実装指示に取り込まれている（plan.md:267）。
- **テストインベントリの ID 化と受入条件の相互参照**: テスト (A)〜(W) の 23 ケースが §5 で番号付けされ、§6 受入条件表で `(L)(N)(U)` のように cell 単位で参照されているため、「どの受入条件がどのテストで担保されるか」が表形式で追える。
- **`OVERLAY_ROLES.length` の動的参照 / ハードコード分離が明示**: test (J) を削除した代わりに「(8) は動的参照で自動追従、(18) のみハードコード修正」を §3 Step 8 / §4 / §5 の 3 か所で重複明記しており、Implementer が読み落とす確率を下げている。

---

## Findings

### Critical

(該当なし)

### Major

(該当なし)

### Minor

**n1. Step 6 の line 番号「3174 付近」は実 line 3181**

§3 Step 6 の説明文「通常 cmux パス line 3174 付近の expanded.md 書き出しブロック」（plan.md:282）は、grep で確認すると実際の `expandProjectInstructions` 呼び出しは `main.ts:3181` にある（§4 影響範囲表では `3190/3194` の log 発行 line を出している）。「付近」表記なので致命的ではないが、§4 と数値が揃っていないのは混乱の元。

**何を**: Step 6 の「line 3174 付近」を「line 3181 付近」に揃える、または「§4 と同じ `2968 / 3181` 付近」と参照表記に変える。

**なぜ**: Implementer が grep ベースで該当箇所を探すとき、§3 と §4 で違う数値が並ぶと「3174 付近」のソース箇所を探して時間を使う可能性がある。

**n2. `expandPromptOverlays` の戻り値型が `...` で省略**

判断 3 のスケッチ（plan.md:120）の戻り値型が `Promise<{ expanded: string; commonMode: ...; roleMode: ... }>` と省略表記。Implementer は具象化が必要 (`commonMode: "noop" | "empty" | "applied"` / `roleMode: "noop" | "unknown-role" | "empty" | "applied"` 相当)。これは plan のスケッチであることを断っているので大きな問題ではないが、`expandProjectInstructions` 側に `unknown-role` mode が**残る**ことが §補足注で明示されているのと整合する形にしておくと親切。

**何を**: 判断 3 のスケッチ末尾に「`commonMode: "noop" | "empty" | "applied"`、`roleMode: "noop" | "unknown-role" | "empty" | "applied"`（unknown-role は role 側のみ発火）」と 1 行コメントを追加。

**なぜ**: Step 4 実装時に Implementer が一瞬「common にも unknown-role を入れるのか？」で迷うのを防ぐ。判断 3 末尾の注 (plan.md:127) で言葉では書かれているので冗長ではあるが、型情報の確定は有益。

---

## Recommendations

(Approved につき省略。Implementer は plan.md を sole source of truth として TDD で進めて差し支えない。)

---

## Notes

- **`locale` の参照について**: Step 4 スケッチで `formatProjectCommonInstructionsBlock(body, locale)` の `locale` が引数定義されていないが、これは既存 `expandProjectInstructions` (`template.ts:144`) と同じパターンで、`template.ts:10` の `import { locale, t } from "./i18n";` を経由して module-top で参照される設計。Implementer は既存パターンに従うため問題なし（混乱しないよう、念のため記録）。
- **既存実装の確認結果**: `expandProjectInstructions` 呼び出しは `main.ts:108 / 2968 / 3181` の 3 か所、log 発行は `2971 / 3190 / 3194` の 3 か所で、Iteration 2 plan §4 と一致。Step 6 の "2 経路 (opencode + cmux)" という枠組みも正確。
- **改訂で broken していないか**: Iteration 1 で確認した Strengths（既存 T247/T342 設計の対称踏襲、scope 内外の明示、`requireSpawnableAgentRole` 防御、テスト網羅 12+）は Iteration 2 でも全て維持されており、規模も増している（テスト 23 ケースに増加）。
- **後続タスク候補**: Iteration 1 の指摘どおり、`_common.md` の文面執筆（観察箱の性格 / log policy / 決定論原則 等の集約）は本タスク完了後の後続として残る。本 plan は配管のみに集中しているため、後続着手のタイミングで CLAUDE.md / docs/spec 横断の重複統合タスクとして起票する想定で良い。
- **plan 自体のサイズ**: 466 行。Iteration 1 から大幅に増えているが、改訂ポイントの根拠付けと test inventory 充実によるもので、冗長性ではなく構造化の結果。Implementer 向け instruction としても読みやすい。
