# Plan: Inspector/Implementer/Planner テンプレートに touched-files 型エラーゼロ化ルールを追加

## 1. 課題分析

### 現状の問題点
- Inspector の「5. 統合」に `bun build` / 型チェックの記述はあるが、**全体実行**でありプロジェクトに既存エラーが溜まっている場合に新規エラーが埋もれる。
- T187 で update-notifier を追加した際、TS7016 が新規発生していたにも関わらず「既存エラー群の一部」として扱われ（あるいは Minor 指摘に丸められ）NOGO に至らず pass してしまった。
- その結果、T190 のような専用クリーンアップタスクで遡及修正する羽目になった。
- Implementer が touched files 内で既存型エラーを発見しても、「スコープ外」として処理する正式な逃がし経路がないため、強引に pass させるか・タスクを止めるかの二択になってしまっている。
- Planner が事前に「これから触るファイルに既存エラーが何件あるか」を確認していないので、着手してから初めて状況を知ることになる。

### 根本原因
1. **判定単位の誤り**: Inspector が「全体のエラー件数差分」で判定しようとしていた（件数ベース悪化判定）ため、既存エラーが母数を大きくし新規 1 件が埋もれる。
2. **Implementer のエスケープバルブ欠如**: out-of-scope な既存エラーを後続タスクに逃がす手続きが無かったため、「見て見ぬふり」が発生しやすい構造だった。
3. **Planner の先読み欠如**: plan.md にエラー宣言欄がないので着手前の現状把握が制度化されていない。

### 影響範囲
- Inspector / Implementer / Planner × ja/en = **6 ファイル**
- 実装は `.md` テンプレートのみ修正（TypeScript コードは触らない）。

## 2. 技術アプローチ

### 核となるルール: touched-files zero-errors
Inspector は以下を「Critical / blocker」として必須化する。

```bash
# main からの差分で触った .ts / .tsx を抽出
TOUCHED=$(git diff main...HEAD --name-only -- '*.ts' '*.tsx' | tr '\n' '|' | sed 's/|$//')

if [ -n "$TOUCHED" ]; then
  bunx tsc --noEmit 2>&1 | grep -E "^($TOUCHED)"
fi
```

- 出力が空 → **pass**
- 1 行でもマッチ → **blocker (critical)**（ただしその行がすべて「cleanup タスクに分離済み」と Implementer が宣言している既存エラーなら例外扱いで pass）

### エスケープバルブ（Implementer 側）
touched files 内に out-of-scope な既存型エラーを発見した場合の標準手順:

1. まず本タスクの変更で直せるか評価する（単純な import 型追加や型注釈で直せる場合は本タスクで直す）。
2. スコープ外と判断したら cleanup タスクを起票する:
   ```bash
   cmux-team create-task \
     --title "cleanup: <元タスク名> で発見した既存型エラー修正" \
     --depends-on <current-task-id> \
     --status ready \
     --body "..."
   ```
3. impl-report に「cleanup タスク T<id> に分離」と対象ファイル・エラー内容を明記する。
4. Inspector はこの起票履歴を確認した上で当該行を pass 対象から除外する。

### 先読み（Planner 側）
plan.md 作成時に:

```bash
bunx tsc --noEmit 2>&1 | grep -E "^(<予定ファイル群>)"
```

を実行し、plan.md に次の 2 区分で宣言する。

- 「本タスクのスコープで解消するエラー」
- 「後続タスクに分離するエラー（cleanup タスク予定）」

### 代替案と却下理由
| 案 | 却下理由 |
|----|---------|
| 全体 `tsc --noEmit` ゼロ化を必須 | 既存エラー群のクリーンアップを全タスクに強制することになり非現実的 |
| エラーレベルで severity を分けて NOGO 閾値調整 | T187 のように「Minor 扱い」で新規エラーが埋もれる再発リスク |
| CI でブロック | 今回のスコープ外。まずテンプレートで合意形成するのが先 |

## 3. 変更対象ファイル

| # | パス | 変更概要 |
|---|------|---------|
| 1 | `skills/cmux-team/templates/ja/inspector.md` | 「5. 統合」の型チェック項目を分離し、「6. 型エラーゼロ化（touched-files）」セクションを新設 |
| 2 | `skills/cmux-team/templates/en/inspector.md` | 同上（英語版） |
| 3 | `skills/cmux-team/templates/ja/implementer.md` | 「out-of-scope な既存型エラー発見時の手順」セクションを新設 |
| 4 | `skills/cmux-team/templates/en/implementer.md` | 同上（英語版） |
| 5 | `skills/cmux-team/templates/ja/planner.md` | 「既存エラー先読み」セクションを新設し plan.md 記載項目に 2 区分追加 |
| 6 | `skills/cmux-team/templates/en/planner.md` | 同上（英語版） |

新規作成ファイル: なし
削除ファイル: なし

## 4. サブタスク分割

### サブタスク 1: inspector.md (ja) — touched-files ゼロ化ルール追加

- **対象ファイル**: `skills/cmux-team/templates/ja/inspector.md`
- **変更内容**:
  1. 43 行目の以下を削除:
     ```
     - **TypeScript コンパイル**: `bun build` または型チェックでエラーがないか
     ```
     （`### 5. 統合（Critical if 未接続）` セクション内の最終箇条書き）
  2. `### 5. 統合` の直後（新しい `### 6.` として）に下記セクションを挿入:

     ```markdown
     ### 6. 型エラーゼロ化 — touched files (Critical)

     **ルール**: 本タスクで触ったファイルに型エラーがあれば無条件で blocker（critical）。件数ベースでの「悪化なし」判定や Minor 扱いは禁止する。

     **検査手順**:

     ```bash
     TOUCHED=$(git diff main...HEAD --name-only -- '*.ts' '*.tsx' | tr '\n' '|' | sed 's/|$//')
     if [ -n "$TOUCHED" ]; then
       bunx tsc --noEmit 2>&1 | grep -E "^($TOUCHED)" || true
     fi
     ```

     **判定**:

     - 出力が空 → pass
     - 1 行でも出力される → **blocker (critical)**
     - ただし Implementer の impl-report に「該当ファイル・エラーは cleanup タスク T<id> に分離済み」と記載され、実際に `cmux-team show-task T<id>` で起票が確認できる場合のみ pass 扱いとする

     **禁止事項**:

     - 新規型エラーを「Minor 指摘」に丸めて pass させること
     - 全体の型エラー件数差分（件数ベース悪化判定）で pass 判断すること
     ```
- **完了条件**:
  - ja/inspector.md に `### 6. 型エラーゼロ化 — touched files (Critical)` 見出しが存在
  - 43 行目の `TypeScript コンパイル` 箇条書きは削除済み
- **検証コマンド**:
  ```bash
  grep -n "型エラーゼロ化 — touched files" skills/cmux-team/templates/ja/inspector.md
  grep -n "TypeScript コンパイル.*bun build" skills/cmux-team/templates/ja/inspector.md  # 0件であること
  ```

### サブタスク 2: inspector.md (en) — touched-files zero-errors rule 追加

- **対象ファイル**: `skills/cmux-team/templates/en/inspector.md`
- **変更内容**:
  1. 43 行目の以下を削除:
     ```
     - **TypeScript compilation**: No errors from `bun build` or type checking?
     ```
     （`### 5. Integration (Critical if disconnected)` セクション内の最終箇条書き）
  2. `### 5. Integration` の直後（新しい `### 6.` として）に下記セクションを挿入:

     ```markdown
     ### 6. Zero Type Errors — touched files (Critical)

     **Rule**: If any file touched by this task has type errors, it is an unconditional blocker (critical). Count-based "no regression" judgment and treating as "minor finding" are prohibited.

     **Inspection procedure**:

     ```bash
     TOUCHED=$(git diff main...HEAD --name-only -- '*.ts' '*.tsx' | tr '\n' '|' | sed 's/|$//')
     if [ -n "$TOUCHED" ]; then
       bunx tsc --noEmit 2>&1 | grep -E "^($TOUCHED)" || true
     fi
     ```

     **Judgment**:

     - Empty output → pass
     - Any output line → **blocker (critical)**
     - Exception: if the Implementer's impl-report documents "this file/error has been split into cleanup task T<id>" and `cmux-team show-task T<id>` confirms the task exists, treat as pass

     **Prohibited**:

     - Downgrading a newly introduced type error to "minor finding" to let it pass
     - Judging pass by global type-error count delta (count-based regression check)
     ```
- **完了条件**:
  - en/inspector.md に `### 6. Zero Type Errors — touched files (Critical)` 見出しが存在
  - 43 行目の `TypeScript compilation` 箇条書きは削除済み
- **検証コマンド**:
  ```bash
  grep -n "Zero Type Errors — touched files" skills/cmux-team/templates/en/inspector.md
  grep -n "TypeScript compilation.*bun build" skills/cmux-team/templates/en/inspector.md  # 0件であること
  ```

### サブタスク 3: implementer.md (ja) — エスケープバルブ追加

- **対象ファイル**: `skills/cmux-team/templates/ja/implementer.md`
- **変更内容**:
  1. 62 行目の以下を残す（削除しない）:
     ```
     - TypeScript の場合: `bun build` または型チェックでコンパイルエラーがないことを確認
     ```
     ただしその後に「触ったファイルについて詳細は下記『out-of-scope な既存型エラー発見時』を参照」という 1 行注記を追加。
  2. `## 実装ルール` セクション（64-68 行目）の直前に下記セクションを新規挿入:

     ```markdown
     ## out-of-scope な既存型エラー発見時の手順

     touched files（本タスクで変更したファイル）内に out-of-scope と思われる既存の型エラーを発見した場合、以下の順で対応する。

     ### ステップ 1: 本タスクで直せるか評価
     - 単純な型注釈追加・import 型追加・null チェック追加で解消できるなら本タスクで直す
     - 直すと計画書のスコープを大きく逸脱する（別システム・別モジュールに波及する）場合のみステップ 2 へ

     ### ステップ 2: cleanup タスクに分離

     ```bash
     cmux-team create-task \
       --title "cleanup: <元タスク名> で発見した既存型エラー修正" \
       --depends-on <current-task-id> \
       --status ready \
       --body "$(cat <<'EOF'
     ## 発見経緯
     タスク T<current-id> の実装中、touched files 内に out-of-scope な既存型エラーを発見した。

     ## 対象
     - ファイル: <path>
     - エラー: <tsc 出力をそのまま貼る>

     ## 方針
     <どう直すかの案>
     EOF
     )"
     ```

     ### ステップ 3: impl-report への明記
     impl-report（{{OUTPUT_FILE}}）の `## Issues Encountered` セクションに以下を明記する:
     - 「cleanup タスク T<id> に分離」
     - 対象ファイルパス
     - エラー概要
     - 分離判断の理由

     Inspector はこの記載と `cmux-team show-task T<id>` の起票確認をもって、該当エラーを touched-files zero-errors チェックの例外として扱う。

     ### 禁止事項
     - cleanup タスク起票なしに既存エラーを「out-of-scope」と呼んで無視すること
     - impl-report に記載せず cleanup タスクだけ作って済ませること
     ```
- **完了条件**:
  - ja/implementer.md に `## out-of-scope な既存型エラー発見時の手順` 見出しが存在
  - `## 実装ルール` よりも前に配置されている
  - `cmux-team create-task --depends-on` の記述が存在
- **検証コマンド**:
  ```bash
  grep -n "out-of-scope な既存型エラー発見時の手順" skills/cmux-team/templates/ja/implementer.md
  grep -n "cmux-team create-task" skills/cmux-team/templates/ja/implementer.md
  ```

### サブタスク 4: implementer.md (en) — escape valve 追加

- **対象ファイル**: `skills/cmux-team/templates/en/implementer.md`
- **変更内容**:
  1. 62 行目の以下を残す（削除しない）:
     ```
     - For TypeScript: confirm no compilation errors with `bun build` or type checking
     ```
     ただしその後に「For touched files, see "Handling out-of-scope pre-existing type errors" below for details」の 1 行を追加。
  2. `## Implementation Rules` セクション（64-68 行目）の直前に下記セクションを新規挿入:

     ```markdown
     ## Handling Out-of-Scope Pre-existing Type Errors

     If you discover a pre-existing type error that seems out-of-scope within touched files (files changed by this task), proceed in the following order.

     ### Step 1: Evaluate whether this task can fix it
     - If it can be resolved with a simple type annotation, type import, or null check → fix in this task
     - Only if fixing it would significantly exceed the plan's scope (spilling into different systems/modules), proceed to Step 2

     ### Step 2: Split into a cleanup task

     ```bash
     cmux-team create-task \
       --title "cleanup: fix pre-existing type errors found in <original task name>" \
       --depends-on <current-task-id> \
       --status ready \
       --body "$(cat <<'EOF'
     ## Discovery Context
     Found out-of-scope pre-existing type errors in touched files during task T<current-id>.

     ## Target
     - File: <path>
     - Error: <paste tsc output>

     ## Approach
     <how to fix>
     EOF
     )"
     ```

     ### Step 3: Document in impl-report
     In the `## Issues Encountered` section of your impl-report ({{OUTPUT_FILE}}), explicitly record:
     - "Split into cleanup task T<id>"
     - Target file path
     - Error summary
     - Rationale for the split

     The Inspector will treat the listed errors as exceptions to the touched-files zero-errors check when this documentation and `cmux-team show-task T<id>` both confirm the split.

     ### Prohibited
     - Calling a pre-existing error "out-of-scope" without filing a cleanup task
     - Filing a cleanup task without documenting it in the impl-report
     ```
- **完了条件**:
  - en/implementer.md に `## Handling Out-of-Scope Pre-existing Type Errors` 見出しが存在
  - `## Implementation Rules` よりも前に配置されている
- **検証コマンド**:
  ```bash
  grep -n "Handling Out-of-Scope Pre-existing Type Errors" skills/cmux-team/templates/en/implementer.md
  grep -n "cmux-team create-task" skills/cmux-team/templates/en/implementer.md
  ```

### サブタスク 5: planner.md (ja) — 既存エラー先読みセクション追加

- **対象ファイル**: `skills/cmux-team/templates/ja/planner.md`
- **変更内容**:
  1. `## 計画書に含めるべき項目` の 6 セクション（1〜6）の後、`### 7. 既存型エラーの先読み` を新規追加。現在の `### 6. Decision Log` の**前**に挿入する（順序: 1〜5、新6、旧6→新7）。
     -> 要するに Decision Log をラストに温存するため、新セクションは Risks と Decision Log の間に入れる。

     ```markdown
     ### 6. 既存型エラーの先読み

     本タスクで触る予定のファイル群（`3. 変更対象` で列挙したファイル）について、着手前に既存の型エラー状況を確認する。

     ```bash
     bunx tsc --noEmit 2>&1 | grep -E "^(<予定ファイル群 pipe 区切り>)" || true
     ```

     結果を下記 2 区分で plan.md に明示する:

     #### 6.1 本タスクのスコープで解消するエラー
     | ファイル | エラー | 方針 |
     |---------|-------|------|
     | ... | ... | ... |

     #### 6.2 後続タスク（cleanup）に分離するエラー
     | ファイル | エラー | 分離理由 | 予定 cleanup タスク名 |
     |---------|-------|---------|---------------------|
     | ... | ... | ... | ... |

     どちらにも該当がない（＝予定ファイルが `.ts` / `.tsx` を含まない、または既存エラーが存在しない）場合は「該当なし」と明記する。
     ```

  2. 既存の `### 6. Decision Log` 見出しを `### 7. Decision Log` にリナンバリングする。
  3. `## 出力` / `## 作業ルール` セクションはそのまま温存。

- **完了条件**:
  - ja/planner.md に `### 6. 既存型エラーの先読み` が存在
  - Decision Log が `### 7.` にリナンバリングされている
  - `6.1 本タスクのスコープで解消するエラー` と `6.2 後続タスク（cleanup）に分離するエラー` の両表が含まれる
- **検証コマンド**:
  ```bash
  grep -n "### 6. 既存型エラーの先読み" skills/cmux-team/templates/ja/planner.md
  grep -n "### 7. Decision Log" skills/cmux-team/templates/ja/planner.md
  ```

### サブタスク 6: planner.md (en) — prereview existing type errors 追加

- **対象ファイル**: `skills/cmux-team/templates/en/planner.md`
- **変更内容**:
  1. `## Items to Include in the Plan` の 6 セクションの順序を変更:
     - 旧 `### 6. Decision Log` を `### 7. Decision Log` にリナンバリング
     - 新 `### 6. Pre-reading existing type errors` を新規挿入（現在の 5. Risks と旧 6. Decision Log の間）

     ```markdown
     ### 6. Pre-reading Existing Type Errors

     Before starting, check the existing type-error state for all files planned to be touched (listed in `3. Change Targets`).

     ```bash
     bunx tsc --noEmit 2>&1 | grep -E "^(<pipe-joined planned files>)" || true
     ```

     Then declare results in plan.md under the following two sections:

     #### 6.1 Errors fixed within this task's scope
     | File | Error | Approach |
     |------|-------|----------|
     | ... | ... | ... |

     #### 6.2 Errors split into follow-up (cleanup) tasks
     | File | Error | Reason for split | Planned cleanup task title |
     |------|-------|------------------|---------------------------|
     | ... | ... | ... | ... |

     If neither applies (planned files contain no `.ts` / `.tsx`, or no pre-existing errors exist), explicitly state "N/A".
     ```

  2. 既存 `### 6. Decision Log` を `### 7. Decision Log` にリネーム。

- **完了条件**:
  - en/planner.md に `### 6. Pre-reading Existing Type Errors` が存在
  - Decision Log が `### 7.` にリナンバリングされている
- **検証コマンド**:
  ```bash
  grep -n "### 6. Pre-reading Existing Type Errors" skills/cmux-team/templates/en/planner.md
  grep -n "### 7. Decision Log" skills/cmux-team/templates/en/planner.md
  ```

## 5. ja/en 並行更新の対比

| 変更内容 | ja 側 | en 側 |
|---------|------|------|
| inspector 「5. 統合」末尾の TS 箇条書き削除 | 43 行目 「**TypeScript コンパイル**: ...」 | 43 行目 「**TypeScript compilation**: ...」 |
| inspector に新 6 章追加 | `### 6. 型エラーゼロ化 — touched files (Critical)` | `### 6. Zero Type Errors — touched files (Critical)` |
| inspector 判定の pass 条件文言 | 「出力が空 → pass」「1行でも → blocker (critical)」 | "Empty output → pass" / "Any output line → blocker (critical)" |
| inspector 例外条件 | 「cleanup タスク T<id> に分離済み」記載＋`cmux-team show-task` 確認 | "split into cleanup task T<id>" documentation + `cmux-team show-task` confirmation |
| inspector 禁止事項 | 「Minor 指摘に丸める」「件数ベース悪化判定」 | "downgrade to minor finding" / "count-based regression check" |
| implementer 62 行目の注記追加 | 「詳細は下記『out-of-scope な既存型エラー発見時』を参照」 | "see 'Handling out-of-scope pre-existing type errors' below" |
| implementer に新セクション追加 | `## out-of-scope な既存型エラー発見時の手順` | `## Handling Out-of-Scope Pre-existing Type Errors` |
| implementer ステップ 1 | 「本タスクで直せるか評価」 | "Evaluate whether this task can fix it" |
| implementer ステップ 2 | 「cleanup タスクに分離」+ create-task コマンド | "Split into a cleanup task" + create-task command |
| implementer ステップ 3 | 「impl-report への明記」 | "Document in impl-report" |
| implementer 禁止事項 | 「起票なしに『out-of-scope』と呼ばない」 | "Don't call out-of-scope without filing" |
| planner 新 6 章 | `### 6. 既存型エラーの先読み` | `### 6. Pre-reading Existing Type Errors` |
| planner 6.1 / 6.2 表 | 「本タスクのスコープで解消するエラー」「後続タスク（cleanup）に分離するエラー」 | "Errors fixed within this task's scope" / "Errors split into follow-up (cleanup) tasks" |
| planner リナンバリング | 旧 `### 6. Decision Log` → `### 7. Decision Log` | Same |

> **Implementer は上記表を左右同時にチェックリストとして使うこと。片方だけ更新してもう片方を忘れるのが最大の NG。**

## 6. リスク

### R1: 既存テンプレートの他セクションを壊す
- **影響**: inspector の「1〜5」「GO/NOGO 判定基準」「出力」や implementer の「TDD サイクル」や planner の「Decision Log」を誤って削除すると、既存ロール動作が破綻
- **対策**: `## 実装ルール` / `## Implementation Rules` など「アンカーとなる見出し」の**直前**に挿入する形にする。既存行の削除は inspector 43 行目の 1 行のみに限定する。
- **検証**: 変更前後の行数差分と grep で「既存キーワード」が全て残存することを確認

### R2: ja/en の片側更新漏れ
- **影響**: 英語版ユーザーだけ古いルールで動作してしまう
- **対策**: 本計画の「ja/en 並行更新の対比」表を Implementer のチェックリストとして使う。サブタスク 1&2, 3&4, 5&6 はそれぞれペアで完了させる（単体 close 禁止）
- **検証**: `diff <(sed -n '/### 6./,/### 7./p' ja/planner.md) <(sed -n '/### 6./,/### 7./p' en/planner.md | ...)` のような対比で見落としを検知

### R3: tsc コマンドが Bun プロジェクトで通らない
- **影響**: `bunx tsc --noEmit` が動かないと Inspector のチェックが実行不能
- **対策**: 既存 implementer/inspector にも `bun build` or 型チェックの記述が既にあり、プロジェクト内で動作することは前提条件。今回はその前提を踏襲する
- **検証**: 実装フェーズで `cd skills/cmux-team/manager && bunx tsc --noEmit` を 1 回試すのは任意の確認項目

### R4: cleanup タスクの `--depends-on` オプションが未実装
- **影響**: Implementer が create-task しようとしてオプションエラーが出る
- **対策**: 現状 `cmux-team create-task` の `--depends-on` 実装を確認すべき。**未実装なら本タスク範囲外として Decision Log に記載し、Implementer サブタスク 3/4 の記述は `# TODO: --depends-on 未実装の場合は本文中に "depends on T<id>" と明記する` というフォールバック記述を添える**
- **検証**: 実装フェーズで `bun run skills/cmux-team/manager/main.ts create-task --help` を実行して `--depends-on` の有無を確認する

### R5: 触ったファイルに `.ts` / `.tsx` が含まれない場合の扱い
- **影響**: `.md` のみ触るタスクでは TOUCHED が空になり `grep -E "^()"` が全行マッチしうる
- **対策**: inspector の検査手順に `if [ -n "$TOUCHED" ]; then ... fi` のガードを入れる（計画書の記述にも既に含めた）

## 7. Decision Log

| ID | 検討事項 | 結論 | 理由 |
|----|---------|------|------|
| D1 | 全体 `tsc --noEmit` ゼロ化を Inspector の基準にするか | 却下、touched files 限定にする | 既存エラーが溜まっているプロジェクトで全タスクに一斉クリーンアップを強制すると現実的に回らない。一方で touched files 限定ならタスク粒度でゼロを維持でき漸進的にエラーを潰せる |
| D2 | cleanup タスク起票の承認フローを設けるか | 設けない（Implementer の判断で即起票） | タスク分離の判断を挟むと流れが止まる。誤起票は後で close-task で無効化できるのでリスクが低い |
| D3 | Inspector の例外扱い（cleanup に分離済みエラー）を Critical → Minor に降格するか | 降格せず「例外として pass」 | 降格すると「Minor 指摘で見逃し」の再発リスクが戻る。例外は明示的な cleanup タスク起票＋impl-report 記載の 2 点セットを要件化することで安全性を担保 |
| D4 | planner の新セクションを Decision Log の後に置くか前に置くか | 前（Risks と Decision Log の間） | Decision Log は常にラストセクションという一貫性を保つため |
| D5 | inspector の「5. 統合」内の TS 項目を削除するか残すか | 削除（新 6 章に集約） | 重複が混乱を生む。TS 関連は 1 箇所に集約 |
| D6 | implementer の 62 行目の TS 記述を削除するか | 削除せず注記追加 | 既存の TDD サイクル VERIFY フェーズの説明として機能しており、そのまま残した上で新セクションへの導線を張るのが最小影響 |
| D7 | `--depends-on` 未実装の場合どうするか | Decision Log 側で注記＋実装時に確認、未実装なら本文記載でフォールバック | R4 参照 |

## 8. 本タスクで触る予定のファイル群の既存型エラー状況

本タスクは `.md` テンプレート 6 ファイルのみを編集する。`.ts` / `.tsx` は一切触らない。

```bash
git diff main...HEAD --name-only -- '*.ts' '*.tsx'
# → 空
bunx tsc --noEmit 2>&1 | grep -E "^()"
# → TOUCHED が空のため、Inspector 検査手順の if ガードによりこのコマンドは実行されない
```

**結論: 該当なし（N/A）**

本タスク自体が touched-files zero-errors ルールに対して自己適用すると、「触った `.ts` / `.tsx` が 0 ファイル」のため Inspector の型チェックは自動 pass となる見込み。これは新ルールが `.md`-only タスクを不当にブロックしないことの確認にもなる。

### 6.1 本タスクのスコープで解消するエラー
| ファイル | エラー | 方針 |
|---------|-------|------|
| (該当なし) | - | - |

### 6.2 後続タスク（cleanup）に分離するエラー
| ファイル | エラー | 分離理由 | 予定 cleanup タスク名 |
|---------|-------|---------|---------------------|
| (該当なし) | - | - | - |

## 9. 完了条件（本タスク全体）

- [ ] サブタスク 1〜6 すべて完了
- [ ] 6 ファイル全ての変更が `git diff --name-only` で確認できる
- [ ] ja/en 対比表の各行がチェック済み（ペアで完了している）
- [ ] `grep -n "件数ベース\|Minor 指摘に丸める\|count-based regression\|downgrade to minor finding" skills/cmux-team/templates/{ja,en}/inspector.md` で該当行が存在し、禁止事項として明記されている
- [ ] `grep -n "cmux-team create-task" skills/cmux-team/templates/{ja,en}/implementer.md` で起票コマンドが存在
- [ ] `grep -n "既存型エラーの先読み\|Pre-reading Existing Type Errors" skills/cmux-team/templates/{ja,en}/planner.md` で新セクションが存在
- [ ] 既存の inspector/implementer/planner の他セクション（GO/NOGO 判定基準、TDD サイクル、Decision Log など）が破壊されていないこと
- [ ] Inspector 自己適用: 本タスクは `.md` のみ編集のため touched-files 型エラーは構造的に 0（上記 §8 で確認済み）

## 10. 実装順序の推奨

並列化可能だが、以下の順で進めると全体整合性を取りやすい:

1. サブタスク 1 → 2（inspector ja/en）: 新ルールの「定義側」を先に固める
2. サブタスク 3 → 4（implementer ja/en）: inspector 側と呼応する「執行側」の手順を整備
3. サブタスク 5 → 6（planner ja/en）: 最上流の「先読み」要件を追加

各ペアはセットでコミットする（ja だけ・en だけでの中間コミットは禁止）。
