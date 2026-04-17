# Implementer Report — T197 touched-files zero-errors rule

## Completed Tasks

- サブタスク 1: ja/inspector.md — touched-files ゼロ化ルール追加
- サブタスク 2: en/inspector.md — touched-files zero-errors rule 追加
- サブタスク 3: ja/implementer.md — エスケープバルブ追加
- サブタスク 4: en/implementer.md — escape valve 追加
- サブタスク 5: ja/planner.md — 既存エラー先読みセクション追加
- サブタスク 6: en/planner.md — pre-reading existing type errors 追加

## Files Changed

| # | File | Change Summary |
|---|------|----------------|
| 1 | `skills/cmux-team/templates/ja/inspector.md` | 「5. 統合」末尾の `TypeScript コンパイル` 箇条書きを削除。新セクション `### 6. 型エラーゼロ化 — touched files (Critical)` を挿入（検査手順・判定・禁止事項を含む） |
| 2 | `skills/cmux-team/templates/en/inspector.md` | Removed the final `TypeScript compilation` bullet of section 5. Inserted new `### 6. Zero Type Errors — touched files (Critical)` section |
| 3 | `skills/cmux-team/templates/ja/implementer.md` | VERIFY フェーズの TS 箇条書きに注記行を追加。`## 実装ルール` の直前に新セクション `## out-of-scope な既存型エラー発見時の手順`（ステップ 1〜3 + 禁止事項）を挿入 |
| 4 | `skills/cmux-team/templates/en/implementer.md` | Added a cross-reference bullet to VERIFY phase. Inserted new `## Handling Out-of-Scope Pre-existing Type Errors` (Steps 1–3 + Prohibited) before `## Implementation Rules` |
| 5 | `skills/cmux-team/templates/ja/planner.md` | `### 5. リスク` と Decision Log の間に新 `### 6. 既存型エラーの先読み`（6.1 / 6.2 の 2 表）を挿入。旧 `### 6. Decision Log` を `### 7. Decision Log` にリナンバリング |
| 6 | `skills/cmux-team/templates/en/planner.md` | Inserted new `### 6. Pre-reading Existing Type Errors` between Risks and Decision Log. Renumbered previous `### 6. Decision Log` to `### 7. Decision Log` |

## Section-Level Summary

### Inspector（ja/en 共通）

- **削除**: `### 5. 統合` の最終箇条書き「TypeScript コンパイル / TypeScript compilation」1 行のみ
- **新設**: `### 6. 型エラーゼロ化 — touched files (Critical)` / `### 6. Zero Type Errors — touched files (Critical)`
  - **ルール**: touched files に型エラーがあれば無条件で blocker（critical）
  - **検査手順**: `git diff main...HEAD --name-only -- '*.ts' '*.tsx'` で TOUCHED を抽出し、`bunx tsc --noEmit` を TOUCHED で grep。`if [ -n "$TOUCHED" ]` ガード付き
  - **判定**: 空 → pass / 1 行以上 → blocker / 例外: Implementer の impl-report に「cleanup タスク T<id> に分離済み」と記載があり `cmux-team show-task` で確認できる場合のみ pass
  - **禁止事項**: Minor 指摘への降格、件数ベース悪化判定での pass

### Implementer（ja/en 共通）

- **追記**: VERIFY フェーズに「触ったファイルについては下記の out-of-scope ハンドリング参照」の導線を追加（既存 `bun build` 行は温存）
- **新設**: `## out-of-scope な既存型エラー発見時の手順` / `## Handling Out-of-Scope Pre-existing Type Errors`
  - **ステップ 1**: 本タスクで直せるか評価（単純な型注釈・null チェック等で直るなら本タスクで対応）
  - **ステップ 2**: cleanup タスクへ分離（`cmux-team create-task --depends-on <id>` のコマンド例を本文に貼付）
  - **ステップ 3**: impl-report の `## Issues Encountered` に cleanup タスク ID・ファイルパス・エラー概要・分離判断の理由を明記
  - **禁止事項**: 起票なしで「out-of-scope」と称して無視すること／起票だけして impl-report に記載しないこと
- 配置: `## 実装ルール` / `## Implementation Rules` の直前（plan.md の指示通り）

### Planner（ja/en 共通）

- **新設**: `### 6. 既存型エラーの先読み` / `### 6. Pre-reading Existing Type Errors`
  - plan.md 作成時に `bunx tsc --noEmit | grep -E` で予定ファイル群の既存エラー状況を宣言するよう指示
  - `#### 6.1 本タスクのスコープで解消するエラー` / `Errors fixed within this task's scope`（3 列表: ファイル / エラー / 方針）
  - `#### 6.2 後続タスク（cleanup）に分離するエラー` / `Errors split into follow-up (cleanup) tasks`（4 列表: ファイル / エラー / 分離理由 / 予定 cleanup タスク名）
  - 該当なしの場合は「該当なし」/ "N/A" と明記
- **リナンバリング**: 旧 `### 6. Decision Log` → `### 7. Decision Log`（ja/en 両方）

## Verification Results

### git 差分

`git diff main --name-only` 出力（package-lock.json はタスク起動前からの既存の状態変化、本タスクでは未編集）:

```
package-lock.json
skills/cmux-team/templates/en/implementer.md
skills/cmux-team/templates/en/inspector.md
skills/cmux-team/templates/en/planner.md
skills/cmux-team/templates/ja/implementer.md
skills/cmux-team/templates/ja/inspector.md
skills/cmux-team/templates/ja/planner.md
```

`git diff main --name-only -- '*.ts' '*.tsx'` → 空（touched files に `.ts` / `.tsx` なし）

### grep 完了条件（全 pass）

| 検証項目 | コマンド | 結果 |
|---------|---------|------|
| ja/inspector 新 6 章存在 | `grep -n "型エラーゼロ化 — touched files" ja/inspector.md` | L44 にヒット |
| ja/inspector 旧 TS 箇条書き削除 | `grep -n "TypeScript コンパイル.*bun build" ja/inspector.md` | 0 件 |
| en/inspector 新 6 章存在 | `grep -n "Zero Type Errors — touched files" en/inspector.md` | L44 にヒット |
| en/inspector 旧 TS 箇条書き削除 | `grep -n "TypeScript compilation.*bun build" en/inspector.md` | 0 件 |
| ja/implementer 新セクション存在 | `grep -n "out-of-scope な既存型エラー発見時の手順" ja/implementer.md` | L65 にヒット |
| ja/implementer `## 実装ルール` 順序 | 新セクション L65 < 実装ルール L107 | OK（前に配置） |
| en/implementer 新セクション存在 | `grep -n "Handling Out-of-Scope Pre-existing Type Errors" en/implementer.md` | L65 にヒット |
| en/implementer `## Implementation Rules` 順序 | 新セクション L65 < Implementation Rules L107 | OK |
| ja/implementer cleanup タスク起票コマンド | `grep -n "cmux-team create-task" ja/implementer.md` | L76 にヒット |
| en/implementer cleanup タスク起票コマンド | `grep -n "cmux-team create-task" en/implementer.md` | L76 にヒット |
| ja/planner 新 6 章存在 | `grep -n "### 6. 既存型エラーの先読み" ja/planner.md` | L53 にヒット |
| ja/planner Decision Log リナンバリング | `grep -n "### 7. Decision Log" ja/planner.md` | L75 にヒット |
| ja/planner 6.1/6.2 両表存在 | `grep -n "6.1 本タスクのスコープで解消\|6.2 後続タスク" ja/planner.md` | L63, L68 にヒット |
| en/planner 新 6 章存在 | `grep -n "### 6. Pre-reading Existing Type Errors" en/planner.md` | L53 にヒット |
| en/planner Decision Log リナンバリング | `grep -n "### 7. Decision Log" en/planner.md` | L75 にヒット |
| en/planner 6.1/6.2 両表存在 | `grep -n "6.1 Errors fixed\|6.2 Errors split" en/planner.md` | L63, L68 にヒット |

### 既存アンカー残存確認（破壊なし）

- ja/inspector.md: `GO/NOGO 判定基準` 1 件
- en/inspector.md: `GO/NOGO Criteria` 1 件
- ja/implementer.md: `## TDD サイクル` 1 件
- en/implementer.md: `## TDD Cycle` 2 件（見出しと本文内の言及）
- ja/planner.md: `Decision Log` 1 件（`### 7.`）
- en/planner.md: `Decision Log` 1 件（`### 7.`）

### 「件数ベース悪化判定」既存文言の再確認

plan.md §1 で「存在しなかった」と報告された件について、`git show main:` で main 側を再 grep:

- ja/inspector.md（main）に `件数ベース` / `Minor 指摘に丸める` → 0 件（plan.md 通り）
- en/inspector.md（main）に `count-based regression` / `downgrade.*minor` → 0 件（plan.md 通り）

よって本タスクで**新規に禁止事項として追加**したのが正しい挙動であり、plan.md の記述と整合する。

## touched-files 型チェック自己適用

`.md` のみ変更のため該当 0 件、N/A。本タスクは `skills/cmux-team/templates/{ja,en}/*.md` 6 ファイルのみを編集しており、`.ts` / `.tsx` は一切触っていない。

```bash
git diff main --name-only -- '*.ts' '*.tsx'
# → 空
```

Inspector が新ルール `### 6. 型エラーゼロ化 — touched files` を本タスクに自己適用した場合、`TOUCHED` 変数が空となり `if [ -n "$TOUCHED" ]` ガードが false となって `bunx tsc --noEmit` は実行されず、構造的に pass となる。これは「.md-only タスクを不当にブロックしない」ことの実地確認にもなる。

したがって cleanup タスク起票は不要（--depends-on cleanup タスクは起票していない）。

## Issues Encountered

なし。

## 未解決事項・懸念

### R4（plan.md リスク）: `cmux-team create-task --depends-on` の実装確認について

plan.md の R4 に「`--depends-on` 未実装の場合は Implementer が実行時にエラー遭遇する可能性」が記載されているが、本タスクは **テンプレートの文面を編集するのみ**で、実際に `create-task --depends-on` を呼び出してはいない（呼び出すのは将来 touched-files ルールを適用した別タスクの Implementer）。

したがって本タスクのスコープでは `--depends-on` の実装有無確認は**不要**と判断した。テンプレート記載の `--depends-on <current-task-id>` は将来実装前提のプレースホルダとして機能する。

plan.md §7 Decision Log の D7 で「Decision Log 側で注記＋未実装なら本文記載でフォールバック」とあるが、今回の plan.md 自体にはこの補足注記が明示されていないため、将来 cleanup フローを実地で適用する際に未実装エラーに遭遇する可能性は残る。これは Inspector 時に確認しても良いし、別途 Observation として記録しても良い観点（本タスクでは修正しない）。

### ja/en 並行更新の対比表チェックリスト適用状況

plan.md §5 の「ja/en 並行更新の対比」表は、編集中に左右ペアで参照しながら進めた（サブタスク 1&2 → 3&4 → 5&6 の順で各ペアをセットで完了）。片側更新漏れは検出されなかった。
