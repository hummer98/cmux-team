# Design Review (Round 2): T247 overlay 機構

## Verdict
**Changes Requested**

## Summary

改訂版 plan.md は Round 1 で指摘した全項目（C1-C2 / M1-M5 / m1-m7 / Recommendation 8）を適切に反映している。特に `expandProjectInstructions` を単一正準関数として `template.ts` に集約した C1 対応、`config.ts` を新規抽出した C2/m7 対応、locale 対応（D7 → i18n.ts キー導入）による M1 対応、Conductor テンプレート冒頭への全ロール共通注意書き + `cmdSpawnAgent` での placeholder 欠落 warn ログによる M2 対応は、指摘の意図を正確に実装ステップに落とし込めている。D16-D18 が新設され設計判断のトレーサビリティも向上した。Decision Log は 18 項目、Risk は 8 項目、サブタスクは 16 項目に増え、全体として一貫性が高まった。

ただし、**Step 3 の `expandProjectInstructions` の置換式に具体的なバグがある**。「`\n{{PROJECT_INSTRUCTIONS}}\n` を regex で検索し、空なら `"\n"`、非空なら `"\n" + block` に置換」「`block` は `\n<heading>\n\n<body>\n`」の組み合わせは、テンプレートの通常の挿入パターン（前後に空行 1 つずつ = `\n\n{{PROJECT_INSTRUCTIONS}}\n\n`）に対して、**いずれの経路でも連続 `\n\n\n` を生成する**（詳細は後述 M6）。これは D6 の設計目標「空行 3 連続を発生させない」および 7.1 test 11 の assertion と矛盾するため、Implementer が Step 3 の記述通りに実装すると test が落ちる。Step 3 の replacement 式、または `formatProjectInstructionsBlock` の出力形（先頭 `\n` の有無）のどちらかを修正すれば解消する軽微な問題だが、スペック記述上は矛盾が残っているため Changes Requested とした。

それ以外は方向性に異論なし。M6 を修正すれば Implementer に渡して問題ないレベルに仕上がっている。

## Previous Issues Resolution

### Critical
- **C1（Step 3/Step 5 ロジック重複）** ✓ 反映済み
  - Step 3 で `expandProjectInstructions(projectRoot, roleRaw, content) → {expanded, mode}` を単一正準関数化。`mode: "noop" | "applied" | "empty" | "unknown-role"` の 4 値を返す設計も Recommendation 1 どおり
  - Step 6 の `cmdSpawnAgent` は `expandProjectInstructions` を呼ぶだけに変更。§4 Step 6 の「メソッド制約」欄に「展開ロジックは `expandProjectInstructions` の呼び出し 1 回に集約（C1）」「インライン展開禁止」と明記
  - サブタスク 8 にも同じ制約が書かれ、逸脱しないガードが二重にかかっている
- **C2（`loadConfig` が private）** ✓ 反映済み
  - D16 で「新規 `skills/cmux-team/manager/config.ts` に抽出」を明示。`TeamConfig` / `loadConfig` / `resolveLayout` / `resolveAutoUpdateMode` / `normalizeAutoUpdate` を全て移動
  - Step 4（新設）に API、変更点、検証方法を記載。Section 6.1 の touched files にも `config.ts` を追加
  - Step 9.2 の `loadSettingsItems` は `import { loadConfig } from "./config"` を使う形に変わっている

### Major
- **M1（locale 非依存）** ✓ 反映済み
  - D7 を locale 別見出し方式に書き直し。ja=`プロジェクト固有の追加指示`, en=`Project-Specific Instructions`。`i18n.ts` に `project_instructions_heading_*` キーを追加する旨を Step 5.6 に記載
  - `formatProjectInstructionsBlock(body, locale)` に locale 引数を追加（Step 2 の API / サブタスク 3 メソッド制約）
  - テスト 3, 4 で ja/en 両方の見出しを assert（7.1 test 3-4）
- **M2（Conductor 全 8 ロール保証）** ✓ 反映済み
  - Step 8 を新規に分離し、`conductor-role.md` / `conductor.md` の「Agent 起動手順」冒頭に全ロール共通 blockquote の挿入を指示。heredoc サンプル（impl/researcher）両方に `{{PROJECT_INSTRUCTIONS}}` を追加する旨も明記
  - Step 6（spawn-agent）で placeholder 欠落時に `project_instructions_missing_placeholder` warn ログを出す — M2 推奨案 (a)+(b) の両方を採用
  - 7.1 手動 E2E ステップ 10 で placeholder 欠落ログが出ることを検証
- **M3（Settings タブ refresh 戦略）** ✓ 反映済み
  - D17 で「`state.activeTab === "settings"` の時のみ loadSettingsItems を refresh で実行」かつ「`switchTab("settings")` で 1 回 trigger」と明記（Recommendation 4 どおり案 (a)）
  - Step 9.2 の「refresh 戦略」欄にも具体的な挙動を記述
- **M4（readFile race/障害）** ✓ 反映済み
  - D18 と Step 6 の try/catch で `project_instructions_read_failed` ログ + 元 `promptFile` fallback を明記
  - Risk R8（Settings 初回レンダリング race）も追加され、読み取り失敗時の挙動が UX 視点で検討されている
- **M5（touched files 漏れ）** ✓ 反映済み
  - Section 6.1 に `config.ts`（新規・C2/m7）、`agent-instructions.test.ts`（新規）、`agent-instructions.ts`（新規）、`i18n.ts` を追加。8 ファイル記載で漏れなし

### Minor
- **m1（`.expanded.md` 命名）** ✓ 反映済み — R2 に「現行 basename は `${AGENT_ID}-${role}-${timestamp}` で衝突しない」を追記
- **m2（連続空行）** △ **部分反映（M6 参照）** — D6 で「空行 3 連続を発生させない」を目標として記載し、Step 3 に replacement 式の詳細を書き、test 11 で assertion を追加した点は良い。しかし **Step 3 の replacement 式自体にバグがあり目標を達成できない**（下記 M6）
- **m3（`S/s` キーバインド）** ✓ 反映済み — D4 に「小文字 `s` は `focusedArea === "artifacts"` 時のみ、大文字 `S` は case-sensitive なので衝突しない」を注記
- **m4（heredoc quoted）** ✓ 反映済み — Step 8.2 に「quoted heredoc (`'AGENT_PROMPT'`) を推奨する注記を近隣に入れる」を追記
- **m5（非対称 role 処理）** ✓ 反映済み — D8 に「`set-agent-instructions` はユーザー入力入口でミス検出が価値、`spawn-agent` は自動生成で既存動作を壊さない」の非対称理由を追記
- **m6（`.team/.gitignore`）** ✓ 反映済み — Section 2.5 で現状を記載、Step 11 を「確認済: 変更不要」で閉じる形に更新
- **m7（`TeamConfig` の扱い）** ✓ 反映済み — C2 の解決と一体で、`config.ts` に `TeamConfig` interface も移動する旨を D16 と Step 4 で明示

### Recommendation 8（事前 tsc ベースライン）
✓ 反映済み — Section 6.2 に Planner 実行時点（2026-04-18）の `bunx tsc --noEmit` 結果が 0 行であることを記録。Implementer 向けの検証コマンドも提示されている

## New Issues Found

### Critical
なし

### Major

#### M6. Step 3 の replacement 式が D6 の設計目標と矛盾（連続 `\n\n\n` を生成する）

Step 3 のスペック:
- `formatProjectInstructionsBlock` 戻り値（body あり）: `\n<heading>\n\n<body.trimEnd()>\n`（Step 2 仕様）
- regex: `/\n{{PROJECT_INSTRUCTIONS}}\n/`
- 置換: block が空なら `"\n"`、非空なら `"\n" + block`

Step 7 で挿入するテンプレート: `\n\n{{PROJECT_INSTRUCTIONS}}\n\n`（前後空行 1 つずつ）

**経路検証**:

ケース 1（body なし / mode=empty）:
- 入力: `A\n\n{{PROJECT_INSTRUCTIONS}}\n\nB`（`A`, `B` は前後の本文）
- regex が `\n{{PROJECT_INSTRUCTIONS}}\n` に match（中央の `\n{{PLACEHOLDER}}\n`）
- 残余 = `A\n` + (match consumed) + `\nB`
- 置換 `"\n"` を代入 → `A\n` + `\n` + `\nB` = `A\n\n\nB`
- **結果: `\n\n\n` が発生**（3 連続改行 = 2 blank lines）→ **test 11 の `/\n\n\n+/` 0 件 assertion が失敗**

ケース 2（body あり / mode=applied, ja locale）:
- block = `\n## プロジェクト固有の追加指示\n\n<body>\n`
- 置換 = `"\n" + block` = `\n\n## プロジェクト固有の追加指示\n\n<body>\n`
- 入力: `A\n\n{{PROJECT_INSTRUCTIONS}}\n\nB` → 残余 `A\n` + 置換 + `\nB`
- 結果: `A\n\n\n## プロジェクト固有の追加指示\n\n<body>\n\nB`
- **結果: 見出し前に `\n\n\n`（3 連続改行）が発生**

どちらの mode でも「空行 3 連続を発生させない」（D6）が破綻している。test 11 は `empty` ケースを明示的に assert するので、Implementer が Step 3 をそのまま実装するとテストが落ちる。

**修正案**（いずれか 1 つ）:

(a) 置換結果から余分な `\n` を取り除く: 
- 空: `"\n"` → **`""`**（regex が `\n{{X}}\n` を消した代わりに何も足さず、surround の `\n\n` を 1 つ消費して `\n\n` が残るのではなく `A\n \nB` → `A\n\nB` になる）
- 非空: `"\n" + block` → **`block`**（block 先頭の `\n` だけで十分、余計な `\n` を追加しない）

(b) `formatProjectInstructionsBlock` の戻り値から先頭 `\n` を除く:
- body あり: `<heading>\n\n<body>\n`（先頭 `\n` なし）
- 置換: 空=`""`、非空=`"\n" + block`

いずれの案でも結果は:
- `A\n\nB`（空 / 1 blank line 維持） ✓
- `A\n\n<heading>\n\n<body>\n\nB`（非空 / 前後 1 blank line） ✓
- `/\n\n\n+/` は 0 マッチ ✓

plan.md §3 D6、§4 Step 2 API、§4 Step 3 の replacement 式の 3 箇所を整合させて記述する必要がある。

### Minor

#### m8. `project_instructions_heading` の i18n キー設計がステップ内で微妙に揺れている

D7 は「`project_instructions_heading_ja` / `project_instructions_heading_en` キー」と 2 キー方式で記述、Step 5.6 は「`project_instructions_heading`: ja=..., en=...」と 1 キー + locale 値の標準 i18n パターンで記述。どちらも意図は同じだが、Implementer が混乱する可能性がある。

**推奨**: Step 5.6 の 1 キー方式（`t("project_instructions_heading")` で locale 解決）に統一し、D7 の記述も「`i18n.ts` に `project_instructions_heading` キーを追加（ja/en 両 locale に訳）」に揃える。

#### m9. `expandProjectInstructions` の locale 取得経路が暗黙

Step 3 の API シグネチャに `locale` 引数がなく、`formatProjectInstructionsBlock(body, locale)` を呼ぶときの locale は `template.ts` 内から暗黙的に解決される想定。Recommendation 2 で「template.ts:8 と同じ」と触れられているが、plan.md 本文ではこの依存関係が明記されていない。

**推奨**: Step 3 の「仕様」欄に「locale は `template.ts` トップレベルで `i18n.ts` から import した `locale` export を使う」旨を 1 行追加する。

#### m10. サブタスク 2/7/8 の `main.ts` 同時編集リスク

サブタスク 2（config 抽出 by main.ts imports 差し替え）、7（CLI コマンド追加）、8（`cmdSpawnAgent` 修正）はいずれも `main.ts` を編集する。§8 の依存関係記述では 2 と 7 は並列可とされているが、並列で実行すると merge conflict が起きうる。

**推奨**: §8 に「サブタスク 2, 7, 8 は同一ファイル（main.ts）を編集するため、並列ではなく 2 → 7 → 8 の順で逐次実行する」旨を明記する。単一 Implementer 運用なら問題ないが、念のため。

#### m11. `openArtifactInViewer` の汎用性前提

Step 9.5 で「Enter: overlay 行なら `openArtifactInViewer` で overlay ファイルを開く」としているが、この関数名は元々 `.team/artifacts/` を対象にした命名と読める。overlay は `.team/agent-instructions/` 配下なので、関数が「任意のパスを受け取って外部ビューアで開く」汎用関数か、artifacts 専用かで挙動が変わる可能性がある。

**推奨**: Step 9.5 に「`openArtifactInViewer` が任意のファイルパスを外部ビューアで開ける汎用関数であることを着手時に確認し、そうでなければ `openInViewer` 相当の汎用ヘルパーにリファクタする」の一文を追加、または該当箇所で汎用関数化を Step 4 相当のサブタスクに分離する。

## Recommendations

Changes Requested のため、以下を plan.md に反映してから Implementer に渡すことを推奨する。

### 1. §3 D6 / §4 Step 2 / §4 Step 3 を三者整合に修正（M6）

以下のいずれかに決定し、3 箇所を整合させる:

**案 A（推奨）**: `formatProjectInstructionsBlock(body, locale)` は body あり時に `\n<heading>\n\n<body.trimEnd()>\n` を返す（現状の Step 2 どおり）。**Step 3 の replacement 式を以下に変更**:

- block が空 → 置換文字列は `""`
- block が非空 → 置換文字列は `block`（`"\n" + block` ではなく）

**案 B**: `formatProjectInstructionsBlock` の戻り値から先頭 `\n` を除き `<heading>\n\n<body.trimEnd()>\n` とする。Step 3 の replacement 式（`"\n"` / `"\n" + block`）は現状維持。

どちらの案でも §7.1 test 11（`/\n\n\n+/` 0 件）を pass し、body あり時も連続 `\n\n\n` を発生させない。

### 2. §4 Step 5.6 と §3 D7 の i18n キー記述を統一（m8）

`i18n.ts` に `project_instructions_heading` キー（1 つ）を追加し、ja/en それぞれの locale で訳文を定義する、という標準 i18n パターンに統一する。D7 の「`project_instructions_heading_ja` / `project_instructions_heading_en`」記述を「`project_instructions_heading`（locale 別訳）」に修正。

### 3. §4 Step 3 の locale 取得経路を明記（m9）

Step 3 の「仕様」欄に 1 行追加: 「locale は `template.ts` トップで `import { locale } from "./i18n"` して参照する」。

### 4. §8 にサブタスク 2/7/8 の逐次実行制約を明記（m10）

「サブタスク 2, 7, 8 は同一ファイル `main.ts` を編集するため、並列ではなく 2 → 7 → 8 の順で逐次実行する」を追記。

### 5. §4 Step 9.5 に `openArtifactInViewer` 汎用性の確認を追加（m11）

Enter キー挙動実装前に関数が任意パスを扱えるか確認し、必要に応じて汎用ヘルパーに改名・抽出する旨を追記。

## Final Verification

検証観点の網羅性再確認（タスク要件 + Round 1 追加項目）:

| 検証観点 | plan の対応 | Round 2 評価 |
|---------|-----------|-------------|
| 8 ロール全テンプレート(ja/en)に `{{PROJECT_INSTRUCTIONS}}` 含有 | §7 表 1 / Step 7 末尾 shell loop | ✓ 十分 |
| overlay あり時に展開される | §7 表 2 / §7.2 手動 E2E ステップ 5 / test 12 | ✓ 十分 |
| overlay なし時に余分な空行/`{{...}}` 残骸なし | §7 表 3 / §7.1 test 11 | △ M6 修正が必要（現状 test 11 が fail） |
| CLI get/set/delete/list の round-trip | §7 表 4 / §7.1 test 5 / §7.2 ステップ 1-3 | ✓ 十分 |
| CLI が未知 role 名を拒否 | §7 表 5 / §7.1 test 10 / Step 5.2 の exit 1 | ✓ 十分 |
| TUI Settings タブで一覧・内容表示 | §7 表 6 / §7.2 ステップ 4 | ✓ 手動検証前提で十分 |
| Settings read-only | §7 表 7 / Step 9.7 footer | ✓ 十分 |
| `.team/agent-instructions/` が git 管理対象 | §7 表 8 / Step 11 確認済 | ✓ 十分 |
| CLI 出力 (list) が人間可読 | §7 表 9 / D13 | ✓ 十分 |
| placeholder 欠落 warn ログ（M2 新規） | §7 表 10 / §7.2 ステップ 10 | ✓ 十分 |
| locale 別見出し（M1 新規） | §7 表 11 / §7.1 test 3-4 / §7.2 ステップ 9 | ✓ 十分 |
| 連続空行 assertion（Recommendation 6 新規） | §7.1 test 11 | △ M6 修正後に有効化される |
| 設定抽出後の既存 test（M5 派生） | Step 4 完了条件 / §6.2 ベースライン 0 件 | ✓ 十分 |

**総評**: 検証計画は Round 1 指摘を全面反映しており、網羅性・具体性ともに実装/検品に耐える水準。M6（Step 3 replacement 式のバグ）を修正すれば、test 11 が本来の assertion として機能し、連続空行検証もカバーされる。M6 以外に新たな盲点は見当たらない。
