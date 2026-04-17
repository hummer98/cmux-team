# Inspector Report — T197 Inspector/Implementer/Planner touched-files zero-errors rule

## Verdict: GO

## Summary

T197 の目的（Inspector/Implementer/Planner テンプレートに touched-files 型エラーゼロ化ルールを追加し、Implementer にエスケープバルブ、Planner に先読み手順を新設する）は 6 ファイル全てで plan.md 通りに実装されている。ja/en は完全対訳で片側更新漏れなし、既存セクション（GO/NOGO、TDD、Decision Log 等）の破壊もない。本タスク自体は `.md` のみの編集のため touched-files 型チェックの自己適用は構造的 pass（N/A）。

## 検品対象

```
skills/cmux-team/templates/en/implementer.md
skills/cmux-team/templates/en/inspector.md
skills/cmux-team/templates/en/planner.md
skills/cmux-team/templates/ja/implementer.md
skills/cmux-team/templates/ja/inspector.md
skills/cmux-team/templates/ja/planner.md
```

`package-lock.json` はタスク起動前からの pre-existing な変更であり、本検品のスコープ外（impl-report でも明記済み）。

## Findings

### 1. plan.md との整合性 — pass

#### inspector.md (ja) — サブタスク 1
- 旧 L43 の `- **TypeScript コンパイル**: bun build または型チェックでエラーがないか` が削除済み（`grep -n "TypeScript コンパイル" ja/inspector.md` で 0 件）
- `### 6. 型エラーゼロ化 — touched files (Critical)` が L44 に新設（plan.md §2「核となるルール」と完全一致）
- ルール / 検査手順（`TOUCHED` 抽出 + `if [ -n "$TOUCHED" ]` ガード + `bunx tsc --noEmit | grep`）/ 判定（空→pass / 1行→blocker / 例外: cleanup タスク分離）/ 禁止事項（Minor 丸め・件数ベース）すべて記載
- `### 5. 統合` 自体は他の既存箇条書き（エントリーポイント / import / 配線タスク等）が破壊されずに残存

#### inspector.md (en) — サブタスク 2
- 旧 L43 `- **TypeScript compilation**: No errors from bun build or type checking?` 削除済み
- `### 6. Zero Type Errors — touched files (Critical)` が L44 に新設
- "Empty output → pass" / "Any output line → blocker (critical)" / exception clause / Prohibited clauses すべて記載
- 「minor finding」への降格禁止・「count-based regression check」禁止が明記されている（plan.md 禁止事項と一致）

#### implementer.md (ja) — サブタスク 3
- L62 の `- TypeScript の場合: bun build または型チェックでコンパイルエラーがないことを確認` は残存（削除していない、plan.md D6 と一致）
- L63 に導線注記 `- 触ったファイルについて詳細は下記『out-of-scope な既存型エラー発見時の手順』を参照` が追加
- `## out-of-scope な既存型エラー発見時の手順` 新セクションが L65 に挿入され、`## 実装ルール`（L107）より前に配置
- ステップ 1（本タスクで直せるか評価）→ ステップ 2（`cmux-team create-task --depends-on <current-task-id>` の起票コマンド）→ ステップ 3（impl-report `## Issues Encountered` への明記）の 3 段構成
- impl-report に cleanup タスク明記のルール（対象ファイルパス・エラー概要・分離判断の理由）が列挙されている
- 禁止事項 2 項目（起票なしで「out-of-scope」と呼ぶこと／impl-report に記載せず起票だけで済ませること）が明記

#### implementer.md (en) — サブタスク 4
- L62 `- For TypeScript: confirm no compilation errors with bun build or type checking` 残存
- L63 に `- For touched files, see "Handling out-of-scope pre-existing type errors" below for details` 追加
- `## Handling Out-of-Scope Pre-existing Type Errors` が L65 に新設、`## Implementation Rules`（L107）より前
- Step 1 / Step 2（`cmux-team create-task --depends-on`）/ Step 3（impl-report documentation）/ Prohibited のすべてを記載
- ja 側と構造的に完全対訳

#### planner.md (ja) — サブタスク 5
- `### 6. 既存型エラーの先読み` が L53 に新設、`### 5. リスク` と旧 Decision Log の間に正しく配置（plan.md D4 と一致）
- `bunx tsc --noEmit 2>&1 | grep -E "^(<予定ファイル群 pipe 区切り>)" || true` の事前確認コマンド記載
- `#### 6.1 本タスクのスコープで解消するエラー`（3 列表: ファイル / エラー / 方針）
- `#### 6.2 後続タスク（cleanup）に分離するエラー`（4 列表: ファイル / エラー / 分離理由 / 予定 cleanup タスク名）
- 該当なしの場合の「該当なし」記載ルールが明記
- 旧 `### 6. Decision Log` が `### 7. Decision Log` にリナンバリング（L75）
- `## 出力` / `## 作業ルール` セクションはそのまま温存

#### planner.md (en) — サブタスク 6
- `### 6. Pre-reading Existing Type Errors` が L53 に新設
- `#### 6.1 Errors fixed within this task's scope` / `#### 6.2 Errors split into follow-up (cleanup) tasks` の両表あり
- "If neither applies ..., explicitly state 'N/A'" の該当なし処理あり
- 旧 `### 6. Decision Log` → `### 7. Decision Log` にリナンバリング済み（L75）

### 2. touched-files 型チェック自己適用（Critical / 新ルール） — pass

```bash
TOUCHED=$(git diff main --name-only -- '*.ts' '*.tsx')
echo "touched .ts/.tsx files: '$TOUCHED'"
# → touched .ts/.tsx files: ''
```

本タスクは `.md` テンプレート 6 ファイルのみを編集しており、`.ts` / `.tsx` は 0 件。新 `### 6. 型エラーゼロ化 — touched files` を自己適用すると `if [ -n "$TOUCHED" ]` ガードが false となり `bunx tsc --noEmit` は実行されない。構造的に pass。

これは新ルールが「`.md`-only タスクを不当にブロックしない」ことの実地確認でもあり、plan.md §8 の「結論: 該当なし（N/A）」とも完全に整合。

### 3. ja/en 対訳整合性 — pass

| 対比項目 | ja | en | 整合 |
|---------|-----|-----|------|
| inspector 旧 TS 箇条書き削除 | 43 行目削除 | 43 行目削除 | OK |
| inspector 新 6 章見出し | `型エラーゼロ化 — touched files (Critical)` | `Zero Type Errors — touched files (Critical)` | OK |
| inspector 検査手順のシェル | 同一コード | 同一コード | OK |
| inspector 判定 | 空→pass / 1行→blocker / 例外 | Empty→pass / Any→blocker / Exception | OK |
| inspector 禁止事項 | Minor 丸め・件数ベース | downgrade to minor / count-based regression | OK |
| implementer L62 既存行 | 温存 | 温存 | OK |
| implementer L63 注記行追加 | あり | あり | OK |
| implementer 新セクション見出し | `## out-of-scope な既存型エラー発見時の手順` | `## Handling Out-of-Scope Pre-existing Type Errors` | OK |
| implementer 配置位置 | `## 実装ルール` 直前 | `## Implementation Rules` 直前 | OK |
| implementer ステップ数 | 3 | 3 | OK |
| implementer 禁止事項数 | 2 | 2 | OK |
| planner 新 6 章見出し | `### 6. 既存型エラーの先読み` | `### 6. Pre-reading Existing Type Errors` | OK |
| planner 6.1 表構造 | 3 列 | 3 列 | OK |
| planner 6.2 表構造 | 4 列 | 4 列 | OK |
| planner Decision Log リナンバリング | 旧 6 → 新 7 | 旧 6 → 新 7 | OK |

片側更新漏れは検出されなかった。plan.md §5「ja/en 並行更新の対比」表の各行と完全一致。

### 4. 既存セクション破壊チェック — pass

- **ja/inspector.md**: `## GO/NOGO 判定基準`（L68）、`## 出力`（L73）、検査観点 1〜5（L16-42）すべて残存
- **en/inspector.md**: `## GO/NOGO Criteria`（L68）、`## Output`（L73）、criteria 1〜5 残存
- **ja/implementer.md**: `## TDD サイクル`（L22）、RED/GREEN/REFACTOR/VERIFY 4 フェーズ、`## テスト基盤がない場合のフォールバック`、`## 実装ルール`、`## 出力` すべて残存
- **en/implementer.md**: `## TDD Cycle`、4 phases、fallback section、`## Implementation Rules`、`## Output` 残存
- **ja/planner.md**: 検査項目 1〜5（L11-51）、サブタスクカテゴリ・制約、リスク、`### 7. Decision Log`（旧 6 からリナンバリング）、`## 出力`、`## 作業ルール` 残存
- **en/planner.md**: 同等の構造で残存

既存行の削除は inspector.md L43 の 1 行（TypeScript 箇条書き）のみに限定されており、plan.md §リスク R1 の対策（「既存行の削除は inspector 43 行目の 1 行のみに限定する」）と一致。

### 5. `git diff --stat` サマリ（参考） — 期待通り

```
skills/cmux-team/templates/en/implementer.md | 43 ++++++++++++++++++++++++++++
skills/cmux-team/templates/en/inspector.md   | 25 +++++++++++++++-
skills/cmux-team/templates/en/planner.md     | 24 +++++++++++++++-
skills/cmux-team/templates/ja/implementer.md | 43 ++++++++++++++++++++++++++++
skills/cmux-team/templates/ja/inspector.md   | 25 +++++++++++++++-
skills/cmux-team/templates/ja/planner.md     | 24 +++++++++++++++-
6 files changed, 180 insertions(+), 4 deletions(-)
```

- implementer の ja/en はどちらも +43 / -0（既存行を一切削除していない、注記追加と新セクション挿入のみ）— plan.md D6 と一致
- inspector の ja/en はどちらも +25 / -1（TS 箇条書き 1 行削除 + 新 6 章挿入）— plan.md R1 と一致
- planner の ja/en はどちらも +24 / -1（Decision Log 見出しリナンバリングで 1 行置換 + 新 6 章挿入）
- ja/en の差分サイズが完全対称（43/25/24 行）である点も対訳整合性の傍証

## Minor Observations（非 blocker）

### M1: Planner `6.1` 表ヘッダーの ja/en 表記揺れ（参考情報）

- ja 側 `6.1` 表の列は「ファイル / エラー / 方針」の 3 列
- en 側 `6.1` 表の列は「File / Error / Approach」の 3 列
- 列数・順序ともに一致しており問題なし。翻訳品質も自然。

### M2: impl-report R4 懸念について（参考情報）

impl-report「未解決事項・懸念」欄に、plan.md §リスク R4（`cmux-team create-task --depends-on` の実装有無）について「本タスクはテンプレート文面編集のみのためスコープ外と判断」と記載されている。これは以下の理由で Inspector として妥当と判断:

1. 本タスクの成果物はテンプレート文面であり、実際に `--depends-on` を呼び出すのは将来別タスクの Implementer
2. plan.md §7 D7 の Decision Log では「未実装なら本文記載でフォールバック」と decision されており、テンプレート本文に `--depends-on <current-task-id>` を placeholder として記載する選択は D7 の第 1 分岐（実装されていれば使う / されていなければ本文内で depends-on を明記してフォールバック）と矛盾しない

ただし、将来 cleanup フローを実地適用する際に `--depends-on` 未実装のままだと Implementer がエラーに遭遇する可能性は残る。これは本タスクのスコープ外だが、T197 クローズ後に Master が別途確認することを推奨する（任意）。

## Fix Required

**なし**（NOGO ではないため）

## 判定根拠

- **Critical**: 0 件
- **Major**: 0 件
- **Minor / 参考情報**: 2 件（M1, M2 — どちらも実装品質への影響なし）

GO/NOGO 判定基準（Critical 0 件 AND Major 2 件以下）に従い **GO**。

## 完了条件チェックリスト（plan.md §9）

- [x] サブタスク 1〜6 すべて完了
- [x] 6 ファイル全ての変更が `git diff --name-only` で確認できる
- [x] ja/en 対比表の各行がチェック済み（ペアで完了している）
- [x] `grep -n "件数ベース\|Minor 指摘に丸める\|count-based regression\|downgrade to minor finding" skills/cmux-team/templates/{ja,en}/inspector.md` で禁止事項として明記されている
- [x] `grep -n "cmux-team create-task" skills/cmux-team/templates/{ja,en}/implementer.md` で起票コマンドが存在
- [x] `grep -n "既存型エラーの先読み\|Pre-reading Existing Type Errors" skills/cmux-team/templates/{ja,en}/planner.md` で新セクションが存在
- [x] 既存の inspector/implementer/planner の他セクションが破壊されていないこと
- [x] Inspector 自己適用: 本タスクは `.md` のみ編集のため touched-files 型エラーは構造的に 0

すべてクリア。検品合格。
