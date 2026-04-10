# Inspection v2: docs/spec/ 同期結果

## 判定

**GO**

理由: 前回の Major（M-1: `{{OUTPUT_FILE}}` 誤参照）が Planner Template セクションから完全に除去され、実テンプレート `skills/cmux-team/templates/planner.md` と一致する記述に修正されている。Minor 5件のうち 4 件は反映済み、m-4（`cmux-team send TODO`）は diff-report.md に明示的にスコープ外として残置されており、前回 Inspector のコメント「本タスクのスコープ外として残す判断も OK」にも整合している。回帰も検出されず、plan.md §5 の完了条件はすべて満たされている。

---

## 前回指摘の解消状況

| 指摘 | 前回ステータス | 今回ステータス | 備考 |
|------|--------------|---------------|------|
| **M-1**: `04-templates.md` §Planner Template の `{{OUTPUT_FILE}}` 誤参照 | NOGO (Major) | ✅ **解消** | Planner セクション（L173-L202）から `{{OUTPUT_FILE}}` が完全に除去。docs 全体で `OUTPUT_FILE` 参照は 11 件残るが、実テンプレートが使っている 7 ロール（researcher / architect / design-reviewer / implementer / inspector / dockeeper / task-manager）と変数表・本文のみで、Planner には出現しない |
| **m-1**: 00 と 06 の status 値リスト不一致 | Minor | ✅ **解消** | 00-project-overview.md L86 を `draft/ready/assigned/closed/aborted/deleted/archived` に揃えた。`commands/team-archive.md:57` 実装とも一致 |
| **m-2**: 05 の `.claude/settings.local.json` 実装場所誤記 | Minor | ✅ **解消** | L140 を「Conductor が worktree を初期化する際には」に訂正し、`skills/cmux-team/manager/conductor.ts` を明示（実装 `conductor.ts:250-254` と一致） |
| **m-3**: `04-templates.md` 変数表に `{{BASE_BRANCH}}` 未掲載 | Minor | ✅ **解消** | L412 に `{{BASE_BRANCH}} | conductor-task | タスクの target ブランチ（未指定時は "main（デフォルト）"）` 行を追加。`template.ts:102` と一致 |
| **m-4**: 01 の `cmux-team send TODO` pre-existing な不正確さ | Minor | ⚠️ **スコープ外として残置** | diff-report.md §Minor 欄に「本ラウンドでは手を加えず次回 docs-sync ラウンドで扱う」と明記され、前回 Inspector のコメント「本タスクのスコープ外として残す判断も OK」に整合。判定の閾値は越えない |
| **m-5**: `04-templates.md` L3 の 4フェーズフロー記述から `implementer` が抜けている | Minor | ✅ **解消** | L3 が「うち planner, design-reviewer, implementer, inspector は4フェーズフロー用」に修正されている |

---

## 事実裏取り結果（Round 2）

| 確認項目 | 実コード / 実ファイル値 | docs/spec/ 記述値 | 一致 |
|---------|-----------------------|------------------|------|
| `grep -c OUTPUT_FILE docs/spec/04-templates.md`（全体） | 11（researcher/architect/design-reviewer/implementer/inspector/dockeeper/task-manager + 変数表） | —（除去対象は Planner セクションのみ、そこからは消えている） | ✅ |
| `grep OUTPUT_FILE` in Planner section L173-L202 | 0 | 0 | ✅ |
| `grep -c OUTPUT_FILE skills/cmux-team/templates/planner.md` | 0 | 0（参照なし） | ✅ |
| 04-templates.md L197-199 §出力 | 実テンプレート `planner.md:61-64` の2項目と整合 | `1. {{OUTPUT_DIR}}/plan.md に計画書を作成する（worktree 内には作成しない・git commit しない）` ／ `2. 作業ディレクトリ内には plan.md を作成しない（worktree 間の衝突防止）` | ✅ |
| 04-templates.md L202 §テンプレート変数 | `{{COMMON_HEADER}}`, `{{TASK_CONTENT}}`, `{{OUTPUT_DIR}}` | 同上 | ✅ |
| 04-templates.md L406 `{{OUTPUT_FILE}}` 使用ロール | 「planner を除く: researcher, architect, design-reviewer, implementer, inspector, dockeeper, task-manager」 | 同上 | ✅（誤読防止の補足も OK） |
| 04-templates.md L3 本文 | `全14個（うち planner, design-reviewer, implementer, inspector は4フェーズフロー用）` | 同上 | ✅ |
| 04-templates.md L412 `{{BASE_BRANCH}}` | 存在 | 存在 | ✅ |
| `skills/cmux-team/templates/conductor-task.md:34` `{{BASE_BRANCH}}` 使用 | 存在 | 変数表で参照済み | ✅ |
| `skills/cmux-team/manager/template.ts:102` `.replace(/\{\{BASE_BRANCH\}\}/g, ...)` | 存在 | 変数表の「未指定時は main（デフォルト）」記述と一致 | ✅ |
| 00-project-overview.md L86 status 値 | `draft/ready/assigned/closed/aborted/deleted/archived` | 同上 | ✅ |
| 06-implementation-tasks.md L142 status 値 | `draft/ready/assigned/closed/aborted/deleted/archived` | 同上 | ✅（00 と一致） |
| 05-install-and-infrastructure.md L140 `.claude/settings.local.json` 実装場所 | `skills/cmux-team/manager/conductor.ts` 明示 | 同上 | ✅ |
| `grep -rn settings.local.json skills/cmux-team/manager/` 結果 | `conductor.ts:250/252/254` のみ | 同上（Conductor フロー） | ✅ |

---

## 新規 findings

なし。Round 2 で反映された修正はすべて pin-point で行われており、前回 GO だった項目を壊していない。

### 細部観察（非ブロッカー）

- **04-templates.md L198 の括弧書き**: 実テンプレート `planner.md:63` は `1. {{OUTPUT_DIR}}/plan.md に計画書を作成する` とだけ書かれているのに対し、docs 側は `1. {{OUTPUT_DIR}}/plan.md に計画書を作成する（worktree 内には作成しない・git commit しない）` と括弧書きを追加している。L199 の内容（「作業ディレクトリ内には `plan.md` を作成しない」）と意味的に重複はあるものの、docs/spec/ は外部向け仕様ドキュメントとして「なぜ OUTPUT_DIR 配下か」の意図を明示する観点では害なし。**修正推奨ではない**（意図的な補足）

---

## 回帰チェック結果

| 観点 | 結果 | 備考 |
|------|-----|------|
| 前回 GO だった項目の保持 | ✅ 問題なし | `git diff docs/spec/` は +161 / -52（前回 +159 / -51）で差分は Round 2 のピンポイント修正のみ |
| スコープ遵守 | ✅ 問題なし | `git status --short` は `docs/spec/*.md`（7個）+ `package-lock.json`（plan 許可済み）のみ |
| バージョン番号の一貫性 | ✅ 問題なし | `package.json` / `.claude-plugin/plugin.json` / 05 plugin.json 例 / 05 package.json 例 すべて `3.31.0` |
| 相互参照の整合（01 CLI 表 ⇔ 05 CLI 表 ⇔ 04 テンプレート数） | ✅ 問題なし | 両者 17 サブコマンド + 14 テンプレートで一致 |
| task-state.json status 値の file 間整合 | ✅ 解消 | 00 L86 と 06 L142 が `draft/ready/assigned/closed/aborted/deleted/archived` で完全一致（Round 1 の Minor m-1 が解消） |
| docs/spec/ 内の新たなリンク切れ・矛盾 | ✅ なし | 7ファイル横断で相互参照の破壊を検知せず |
| 既存 Markdown 構造の保持 | ✅ 問題なし | 見出しレベル・表形式・コードブロック境界が破壊されていない。diff は論理単位ごとに hunk 分割 |
| CLAUDE.md との重複回避 | ✅ 問題なし | ロギングポリシー・プロンプト編集ルールは docs/spec/ に重複記載されていない |

---

## plan.md §5 完了条件の達成状況

| # | 条件 | 結果 |
|---|------|------|
| 1 | `docs/spec/` の 7 ファイルが T116 までの変更を反映 | ✅ 達成 |
| 2 | `diff-report.md` が `.team/tasks/118-docs-spec-t107/runs/task-118-1775760657/diff-report.md` に存在 | ✅ 存在（Inspector round 1 反映セクション付き） |
| 3 | `git diff docs/spec/` がレビュー可能な粒度 | ✅ 節単位 hunk で分割 |
| 4 | バージョン番号 `3.31.0` が 05 に反映 | ✅ 達成 |
| 5 | `/docs-sync` と `dockeeper` が 01 および 03 に反映 | ✅ 達成 |
| 6 | タスク中心フォルダ集約が 00 および 05 に反映 | ✅ 達成 |
| 7 | 新規 CLI（`abort-task`, `delete-task`, `spawn-conductor`）が 01 および 05 に追加 | ✅ 達成 |
| 8 | diff-report.md の「要確認」項目がすべて確認または保留の判断済み | ✅ 全項目判断済み |
| 9 | 06 の実装タスク状況が T116 時点を反映 | ✅ 達成 |

---

## 結論

前回 NOGO の根拠だった Major 1 件（Planner Template の `{{OUTPUT_FILE}}` 誤参照）は完全に解消され、実テンプレート `skills/cmux-team/templates/planner.md` と整合する記述になった。Minor 5 件のうち 4 件（m-1/m-2/m-3/m-5）は反映済み、残る m-4（`cmux-team send TODO`）は pre-existing な不正確さで、前回 Inspector レポートに「本タスクのスコープ外として残す判断も OK」と明記されていた項目で、かつ diff-report.md に残置根拠が記録されている。

回帰は検出されず、`docs/spec/` の 7 ファイル以外への波及もない。plan.md §5 の完了条件 9 項目すべてを満たしている。

**判定: GO** — Implementer の差分をそのまま merge 可能。
