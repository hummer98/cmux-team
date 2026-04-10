# Inspection: docs/spec/ 同期結果

## 判定

**NOGO**

理由: Major 1件（04-templates.md §Planner Template の出力記述が実テンプレート `planner.md` に存在しないステップを参照しており、記述の信頼性を損なう）

ただし NOGO 事項は限定的で、他の主要項目はすべて plan.md §5 の完了条件を満たしている。Implementer は §Planner Template の §出力 と §テンプレート変数 を実テンプレートに合わせて修正すれば GO に転換可能。

---

## 検品サマリ

- 変更ファイル数: 7（plus package-lock.json は plan で許可済み）
- 総変更行数: **159 insertions, 51 deletions**（`git diff --stat docs/spec/`）
- 確認項目数: 18
- Critical findings: 0 件
- Major findings: 1 件
- Minor findings: 5 件

---

## 事実裏取り結果

| 確認項目 | 実コード値 | docs/spec/ 記述値 | 一致 |
|---------|-----------|------------------|------|
| `package.json` version | `3.31.0` | `3.31.0`（05 L50） | ✅ |
| `.claude-plugin/plugin.json` version | `3.31.0` | `3.31.0`（05 L24） | ✅ |
| `commands/` 実ファイル数 | 6（artifact, docs-sync, master, team-archive, team-spec, team-task） | 全6コマンド（03 L5） | ✅ |
| `skills/` 実ディレクトリ | cmux-agent-role, cmux-team, dockeeper（3個） | dockeeper 追記済み（06 L11, 03 L141） | ✅ |
| `templates/` 実ファイル数 | 14（architect, common-header, conductor*, design-reviewer, dockeeper, implementer, inspector, manager, master, planner, researcher, task-manager） | 全14個（04 L3, 06 L98） | ✅ |
| `main.ts` サブコマンド数 | 17（start, send, status, stop, spawn-conductor, spawn-agent, agents, kill-agent, create-task, update-task, close-task, abort-task, delete-task, trace, conductor, spawn-master, artifacts） | 17サブコマンド（05 L83） | ✅ |
| `queue.ts` 物理存在 | **なし**（queue.test.ts のみ残存） | ディレクトリ構成から削除済み（05 L82-100） | ✅ |
| `.team/queue/` 物理存在 | **なし** | 00 §Per-Project State から削除済み | ✅ |
| `.gitignore` 実装内容（daemon.ts:197） | `output/\nprompts/\ndocs-snapshot/\nlogs/\nqueue/\nconductors/\nmaster.surface\ntask-state.json\ntasks/*.status.json\n` | 同一順序で記述（05 §.team/.gitignore） | ✅ |
| `assignedAt` フィールド | task.ts:25, daemon.ts:26/635/662 | 05 §TUI L161, 06 §Phase 7 反映済み | ✅ |
| close-task `--force` + CONDUCTOR_DONE | main.ts:1437/1448/1471-1477 | 01 L78, 05 L118 反映済み | ✅ |
| abort-task 挙動（停止→worktree削除→aborted→再起動） | main.ts:1548-1610 | 01 L79, 05 L119 反映済み | ✅ |
| delete-task draft/ready 制限 + journal | main.ts:1629/1645 | 01 L80, 05 L120 反映済み | ✅ |
| update-task 必須引数（status/title/body のいずれか） | main.ts:1353-1356 | 01 L77 反映済み | ✅ |
| spawn-conductor `--direction right\|down` | main.ts:996-1003 | 01 L72, 05 L112 反映済み | ✅ |
| `CMUX_CLAUDE_HOOKS_DISABLED=1` + `--settings` 注入 | main.ts:783, 794, 900 | 05 L39 反映済み | ✅ |
| `.claude/settings.local.json` worktree コピー | conductor.ts:250-254 | 05 L140 反映済み（※実装場所は conductor.ts、daemon.ts ではない） | ⚠️ Minor |
| `planner.md` の `{{OUTPUT_DIR}}` 使用 | planner.md:63 | 04 L198, 04 L409 反映済み | ✅ |
| `planner.md` の `{{OUTPUT_FILE}}` 使用 | **不在**（grep で 0件） | 04 L199, 04 L202 で参照されている | ❌ Major |
| `task-state.json` status 値 | manager 内: draft/ready/assigned/closed/aborted/deleted（task.ts:24, daemon.ts:661） + team-archive で archived（commands/team-archive.md:57） | 00 L86: `draft/ready/assigned/closed/aborted/deleted` ／ 06 L142: `draft/ready/assigned/closed/aborted/deleted/archived` | ⚠️ Minor（00 と 06 で不一致） |

---

## Findings

### Critical（ブロッカー）

なし。

### Major

#### M-1. `docs/spec/04-templates.md` §Planner Template — 実テンプレートに存在しない `{{OUTPUT_FILE}}` 記述

- **ファイル**: `docs/spec/04-templates.md` L197-202
- **問題**:
  ```
  ## 出力
  1. `{{OUTPUT_DIR}}/plan.md` に計画書を作成する（worktree 内には作成しない・git commit しない）
  2. `{{OUTPUT_FILE}}` には実行ログ・サマリのみを書く  ← 実テンプレートに存在しない

  **テンプレート変数:** `{{COMMON_HEADER}}`, `{{TASK_CONTENT}}`, `{{OUTPUT_DIR}}`, `{{OUTPUT_FILE}}`
                                                                          ^^^^^^^^^^^^^^^ 実テンプレートで未使用
  ```
- **根拠**:
  - `skills/cmux-team/templates/planner.md` 全文 を grep した結果、`{{OUTPUT_FILE}}` は **0件**（`grep -c OUTPUT_FILE planner.md` = 0）
  - 実 planner.md L61-65 の §出力 は以下の2項目のみ:
    1. `{{OUTPUT_DIR}}/plan.md` に計画書を作成する
    2. 作業ディレクトリ内には plan.md を作成しない（worktree 間の衝突防止）
  - 実 planner.md は **OUTPUT_FILE への書き出しを一切行わない**
  - 旧 docs（HEAD 版）の `2. {{OUTPUT_FILE}} にも同じ内容をコピー` を、Implementer が「実行ログ・サマリのみを書く」に書き換えて残してしまった結果、実テンプレートにない仕様が docs に残っている
- **Fix Required**:
  - L197-200 §出力 を以下に修正:
    ```
    ## 出力
    1. `{{OUTPUT_DIR}}/plan.md` に計画書を作成する（worktree 内には作成しない・git commit しない）
    2. 作業ディレクトリ内には plan.md を作成しない（worktree 間の衝突防止）
    ```
  - L202 のテンプレート変数行を以下に修正:
    ```
    **テンプレート変数:** `{{COMMON_HEADER}}`, `{{TASK_CONTENT}}`, `{{OUTPUT_DIR}}`
    ```
  - L406 の変数表 `{{OUTPUT_FILE}} | 全 Agent ロール | 出力ファイルパス` の「全 Agent ロール」表現は事実上「OUTPUT_FILE を使用する Agent ロール（researcher/architect/design-reviewer/implementer/inspector/dockeeper/task-manager の 7 個）」を指すため、planner を含意してはいけない（planner は OUTPUT_DIR のみ使用）。誤読を避けるため記述を「OUTPUT_FILE を使用するロール（planner を除く Agent ロール）」等に補足するのが望ましい

### Minor

#### m-1. `00-project-overview.md` と `06-implementation-tasks.md` の status 値リスト不一致

- **ファイル**:
  - `docs/spec/00-project-overview.md` L86: `status: draft/ready/assigned/closed/aborted/deleted`
  - `docs/spec/06-implementation-tasks.md` L142: `(draft/ready/assigned/closed/aborted/deleted/archived)`
- **問題**: 00 には `archived` がなく、06 にはある
- **根拠**:
  - manager daemon 内部: `draft/ready/assigned/closed/aborted/deleted`（`task.ts:24`、`daemon.ts:661` の `status: 'assigned'`、`main.ts:1455/1538/1589/1646` 等）
  - `archived` は `commands/team-archive.md:57` の **`/team-archive` スラッシュコマンド経由でのみ** 設定される
  - したがって両方とも嘘ではないが、表記が file 間で揃っていない
- **Fix Recommended**: 00 L86 を `draft/ready/assigned/closed/aborted/deleted/archived` に揃える（または 06 から archived を外す）。「Master 経由で /team-archive を実行すると archived 状態になる」旨の補足脚注も望ましい

#### m-2. `05` Manager Daemon の `.claude/settings.local.json` コピー記述

- **ファイル**: `docs/spec/05-install-and-infrastructure.md` L140
- **問題**: 「daemon は ... worktree 作成時には `.claude/settings.local.json` をワークツリー側にコピーし」と書かれているが、実装は `skills/cmux-team/manager/conductor.ts:250-254`（Conductor の worktree 作成フロー）
- **根拠**: `grep -rn "settings.local.json" skills/cmux-team/manager/` → conductor.ts のみマッチ
- **Fix Recommended**: 「Conductor の worktree 初期化時に」と表現を変更、または「daemon が起動する Conductor は worktree 作成時に」と Conductor の責務である旨を明示

#### m-3. `04-templates.md` 変数表に `{{BASE_BRANCH}}` が未掲載

- **ファイル**: `docs/spec/04-templates.md` L403-421（Agent ロール固有変数表）
- **問題**: `conductor-task.md` テンプレートが `{{BASE_BRANCH}}` を使用しており（`grep BASE_BRANCH skills/cmux-team/templates/conductor-task.md` で `{{BASE_BRANCH}}` を確認）、`template.ts:102` で substitution も行われているが、04-templates.md の変数表に登録されていない
- **根拠**: 旧 HEAD 版にも同変数は未掲載のため pre-existing だが、本タスク（実装と sync）の機会だったため指摘
- **Fix Recommended**: 変数表に `| `{{BASE_BRANCH}}` | conductor-task | タスクの target ブランチ（未指定時は "main（デフォルト）"） |` を追加

#### m-4. `01-skill-cmux-team.md` `cmux-team send TODO` の記述（pre-existing）

- **ファイル**: `docs/spec/01-skill-cmux-team.md` L70
- **問題**: `cmux-team send TODO` (`--content` 必須) と書かれているが、`main.ts` には `TODO` メッセージ種別が **存在しない**（`grep TODO skills/cmux-team/manager/main.ts` で 0 件、`schema.ts` の QueueMessage discriminated union にも未登録）
- **根拠**: 旧 HEAD 版から残存している既存の不正確な記述。本タスクのスコープでは Implementer が手をつけていないが、実装と乖離しているため検品観点 §1「事実整合性」として記録
- **Fix Recommended（任意・本タスク外でも可）**: TODO 行を削除する。TODO メッセージは廃止済み

#### m-5. `04-templates.md` 「うち planner, design-reviewer, inspector は4フェーズフロー用」の記述

- **ファイル**: `docs/spec/04-templates.md` L3
- **問題**: 4フェーズフローは planner → design-reviewer → implementer → inspector の 4 個だが、`implementer` が抜けている
- **根拠**: 旧 HEAD 版にも同様の表現があり pre-existing。Implementer が「全13→全14」のみ修正しているため見落とし
- **Fix Recommended（任意）**: 「うち planner, design-reviewer, implementer, inspector は4フェーズフロー用」に修正

---

## Fix Required（NOGO の場合の最小修正項目）

Implementer に再修正を依頼する項目（Major のみ。Minor は任意）:

1. **`docs/spec/04-templates.md` L197-202** §Planner Template §出力 の修正
   - `2. {{OUTPUT_FILE}} には実行ログ・サマリのみを書く` を **削除** し、`2. 作業ディレクトリ内には plan.md を作成しない（worktree 間の衝突防止）` に置換（実 `planner.md:64` と一致させる）
   - L202 の `**テンプレート変数:** `{{COMMON_HEADER}}`, `{{TASK_CONTENT}}`, `{{OUTPUT_DIR}}`, `{{OUTPUT_FILE}}`` から `{{OUTPUT_FILE}}` を削除

上記 1 件を修正すれば NOGO → GO に転換可能。

---

## Observations（良かった点）

- **バージョン番号の一貫性**: 3.31.0 が `package.json`、`.claude-plugin/plugin.json`、`docs/spec/05` の plugin.json/package.json 例で完全一致
- **plan §3 マトリクスの網羅性**: 7 ファイル全てに更新が入っており、plan で「要」とした項目はほぼ全て反映されている（Major 1 件除く）
- **実コード裏取りの精度**: spawn-conductor の `--direction` 値、abort-task のフロー、close-task の `--force` + CONDUCTOR_DONE、update-task の必須引数バリデーションなど、CLI 表の記述が実装と一致している
- **`queue.ts` 削除の反映**: 旧 docs に残存していた `queue.ts` / `.team/queue/` の記述が漏れなく削除され、メッセージング section が「HTTP プロキシ受け口」へ置き換わっている
- **workspace 分離の説明**: 01 §3 と 05 §Manager Daemon の両方で記述され、CLAUDE.md の「cmux API 使用上の注意」と整合
- **`/docs-sync` と dockeeper スキルの追加**: 03 §/docs-sync 新規セクション、01 のスラッシュコマンド表、06 の Phase 1.1 完了項目に一貫して追加されている
- **タスク中心フォルダ集約の表現**: 00 のディレクトリツリー、05 のメッセージング、04 のテンプレート出力先で同じ用語（`tasks/TNNN-slug/runs/<taskRunId>/`）を使っており用語統一されている
- **既存 Markdown 構造の保持**: table 形式・節見出しレベル・コードブロック区切りが破壊されておらず、`git diff` がレビュー可能な粒度で hunk 化されている
- **スコープ遵守**: `git status --short` で変更されているファイルは `docs/spec/*.md`（7個）と `package-lock.json`（plan で許可済み）のみで、それ以外には触れていない
- **CLAUDE.md との重複回避**: ロギングポリシー、プロンプト編集ルール等は docs/spec/ に重複記載されていない
