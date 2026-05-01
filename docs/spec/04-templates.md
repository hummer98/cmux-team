# Seed: Agent Prompt Templates

テンプレートは `skills/cmux-team/templates/{ja,en}/` に言語別で配置。各言語ディレクトリに全14個（うち planner, design-reviewer, implementer, inspector は4フェーズフロー用）。`CMUX_TEAM_LANG` もしくは config.json の `lang` で言語を切り替える（未設定時は `ja`）。
Conductor（または daemon）が spawn 時に変数を置換し、タスク中心フォルダ集約により `.team/tasks/TNNN-slug/runs/<taskRunId>/` 配下に書き出す。statusline はロール別にカスタムステータスバーを出し分ける（Master は open タスク数、Conductor は担当タスク、Agent は role 名など）。

---

## テンプレート一覧

| ファイル | ロール | 用途 |
|---------|-------|------|
| `common-header.md` | 全エージェント共通 | Agent メタデータ + 基本ルール |
| `master.md` | Master | ユーザー対話、タスク作成、進捗報告 |
| `manager.md` | Manager | daemon 補助（Claude セッション版、現在は daemon が主） |
| `conductor.md` | Conductor | フルプロトコル版テンプレート（`{{WORKTREE_PATH}}` 等のプレースホルダー使用） |
| `conductor-task.md` | Conductor | タスク割り当て用（シンプル版、タスク内容 + パス情報のみ） |
| `conductor-role.md` | Conductor | ロール定義版（パス情報を汎用参照に変更、タスク割り当て時に動的に受け取る） |
| `researcher.md` | Researcher | トピック調査 |
| `architect.md` | Architect | 技術設計 |
| `planner.md` | Planner | 計画立案（plan.md 作成） |
| `design-reviewer.md` | Design Reviewer | 設計レビュー（plan.md の品質判定） |
| `implementer.md` | Implementer | TDD 実装（RED→GREEN→REFACTOR→VERIFY） |
| `inspector.md` | Inspector | 検品（5観点で GO/NOGO 判定） |
| `dockeeper.md` | DocKeeper | ドキュメント同期 |
| `task-manager.md` | TaskManager | タスク監視・整理 |

---

## Common Header（全エージェント共通）

```markdown
[CMUX-TEAM-AGENT]
Role: {{ROLE_ID}}
Task: {{TASK_DESCRIPTION}}
Output: .team/output/{{ROLE_ID}}.md
Project: {{PROJECT_ROOT}}

## Instructions
- Write all findings/deliverables to the Output file above
- When done, just stop. Your supervisor will detect completion.
- If you encounter a decision point or blocker, create a task via CLI: `bun run "$MAIN_TS" create-task --title "issue title" --body "details"`
- Do NOT interact with other panes. Work independently.
- Language: Japanese (for documentation), English (for code)
```

**旧仕様からの変更:**
- `Signal: cmux wait-for -S "..."` 行は削除（完了シグナル廃止）
- `cmux set-status` 指示は削除（ステータス報告廃止）
- タスク作成は CLI 経由に変更（`$MAIN_TS` 環境変数で main.ts パスを参照）
- 完了時の指示を「When done, just stop. Your supervisor will detect completion.」に変更

### settings.json hook 一覧

`generateMasterSettings` / `generateConductorSettings` / `generateAgentSettings`（`skills/cmux-team/manager/main.ts`）が生成する Claude Code 用 settings.json の hook 一覧。

| hook | 役割 | Master | Conductor | Agent |
|---|---|---|---|---|
| `SessionStart` | `cmux-team send SESSION_STARTED` を呼び pid / sessionId を daemon へ通知（T407: Conductor / Agent では Manager 側で発行した pre-inject UUID と整合性チェック。`source=startup` の不一致は warn し hook 値で上書き） | ✅ | ✅ | ✅ |
| `UserPromptSubmit` | Master 専用 — proxy `/master-state` に `status: busy` を POST | ✅ | — | — |
| `PreToolUse` (Bash) | Conductor の `cmux-team send/send-key` 直接呼出を抑止 | — | ✅ | — |
| `Notification` | Claude Code native の通知（permission / idle 等）を Manager に集約 | ✅ | ✅ | ✅ |
| `StopFailure` (T392) | Claude Code 内部リトライが諦めた API エラー（rate_limit / authentication_failed / billing_error / server_error）を `cmux-team send STOP_FAILURE` で daemon へ通知 | ✅ | ✅ | ✅ |
| `Stop` | Master は proxy idle 通知 / Conductor & Agent は `detect-ask.sh`（AskUserQuestion 検出 / SESSION_IDLE 送信） | ✅ | ✅ | ✅ |
| `SessionEnd` | logout / prompt_input_exit / other を Manager に転送 | ✅ | ✅ | ✅ |
| `SessionEnd` (matcher=clear) | `/clear` 時に SESSION_CLEAR を送信 | — | ✅ | — |

---

## `{{PROJECT_INSTRUCTIONS}}` プレースホルダ（T247 / T342）

全 overlay 対応ロール（researcher / architect / planner / design-reviewer / implementer / inspector / dockeeper / task-manager / **master / conductor**）のテンプレート冒頭（Agent ロールは `{{COMMON_HEADER}}` 直後、Master / Conductor はロール導入文の直後）に `{{PROJECT_INSTRUCTIONS}}` を 1 行で配置している。

**役割**:
- **Agent ロール (8 件)**: `cmux-team spawn-agent --prompt-file <path>` 実行時に、prompt-file 内のこのプレースホルダが `.team/agent-instructions/<role>.md` の内容で置換される
- **Master / Conductor (T342)**: daemon 起動時の `generateMasterPrompt(projectRoot)` / `generateConductorRolePrompt(projectRoot, mainBranch)` が `.team/prompts/master.md` / `.team/prompts/conductor-role.md` を生成する際に直接展開する（spawn-agent 経路は経由しない。`.expanded.md` も作らない — テンプレ → `.team/prompts/` の 1 段だけ）

overlay が無い場合は空文字に置換されるため、テンプレート側には常に残しておく。

**展開仕様**: `skills/cmux-team/manager/template.ts` の `expandProjectInstructions(projectRoot, role, content)` が担当:
- `{{PROJECT_INSTRUCTIONS}}` を含まない → そのまま返す (mode=noop)
- role エイリアス解決: `impl` → `implementer`、`reviewer` → `design-reviewer`
- role 不明 → 空文字置換 (mode=unknown-role、warn ログ)
- overlay 不在 / 空 → 空文字置換 (mode=empty)
- overlay 有り → `\n## <project_instructions_heading>\n\n<body>\n` ブロックに展開 (mode=applied)
- 置換は `lineRe = /\n\{\{PROJECT_INSTRUCTIONS\}\}\n/` の **最初の 1 件のみ**。これは `conductor-role.md` の heredoc サンプル内に literal として現れる `{{PROJECT_INSTRUCTIONS}}`（Agent 用 overlay placeholder）を保護するための仕様

**i18n**: 見出しは `project_instructions_heading` キー（ja: 「プロジェクト固有の追加指示」/ en: "Project-Specific Instructions"）。`formatProjectInstructionsBlock(body, locale)` が整形する。Master / Conductor も同じ見出しを流用する。

**Conductor 側の注意**: Conductor が heredoc で prompt-file を手組みする際は、quoted heredoc (`'AGENT_PROMPT'`) を使って `{{PROJECT_INSTRUCTIONS}}` を literal として保つ。`conductor-role.md` の先頭にこの注意書きが含まれており、conductor-role.md 自身の冒頭の `{{PROJECT_INSTRUCTIONS}}` だけが daemon 起動時に置換される（heredoc サンプル内のものは Agent 用 literal として保護される）。

**ロール enum** (`skills/cmux-team/manager/schema.ts`):

| 用途 | enum | 含むもの |
|---|---|---|
| spawn-agent --role が受け付ける | `AgentRole` | researcher / architect / planner / design-reviewer / implementer / inspector / dockeeper / task-manager（8 ロール） |
| overlay 系 CLI と generateMasterPrompt / generateConductorRolePrompt が受け付ける | `OverlayRole` | `AgentRole` 8 件 + master + conductor（10 ロール） |

```typescript
export const AgentRole = z.enum([
  "researcher", "architect", "planner", "design-reviewer",
  "implementer", "inspector", "dockeeper", "task-manager",
]);

export const OverlayRole = z.enum([
  ...AgentRole.options,
  "master", "conductor",
] as const);
```
エイリアス: `impl` → `implementer`、`reviewer` → `design-reviewer`（`AgentRole` / `OverlayRole` で共通）。

**spawn-agent への影響 (T342)**: `cmux-team spawn-agent --role master` / `--role conductor` は exit 1 で reject される（`requireSpawnableAgentRole` が "reserved for system prompt overlay" エラーを出す）。Master / Conductor は agent として spawn できず、overlay 専用ロールとして扱われる。

---

## Master Template

Master 固有のテンプレート。ユーザー対話・タスク作成・進捗報告のプロトコルを定義。

**主な内容:**
- タスク作成: `cmux-team create-task --title "..." --status draft|ready --body "..."`
- status 更新: `cmux-team update-task --task-id NNN --status ready`
- **やること**: ユーザーの指示をタスクに分解、進捗報告、Manager の健全性確認
- **やること（追加、T283）**: git **読み取り**（`status` / `log` / `diff` / `branch -v`）、git **ローカル同期**（`fetch origin` / `pull --ff-only origin <mainBranch>`）。特に PR が server で `gh pr merge` された後は `git fetch origin && git pull --ff-only origin <mainBranch>` で local を origin に追従させておく（次タスク worktree が stale origin から切られる事故を防ぐため）
- **やらないこと（デフォルト）**: 実装・テスト・リファクタリング・ファイル直接編集（`.team/tasks/` 以外）・git の**書き込み系操作**（`commit` / `branch <new>` / `merge` / `rebase` / `cherry-pick` 等）。ユーザーの明示指示があれば Master 自身が実行してよい
- **明示指示があっても禁止**: `.team/tasks/` 配下の直接編集（CLI 経由必須）・assigned タスクの編集・Conductor/Agent の直接起動・ポーリング・破壊的 git 操作（push, force-push, reset --hard 等）

**テンプレート変数:** `{{ROLE_ID}}`, `{{TASK_DESCRIPTION}}`, `{{PROJECT_ROOT}}`, `{{PROJECT_INSTRUCTIONS}}`（T342: Master 用テンプレート冒頭に配置）

---

## Conductor Templates（3種）

### conductor.md（フルプロトコル版・deprecated）

**非推奨** — 現行ランタイムは `conductor-role.md` + `conductor-task.md` を使用する。このファイルは歴史的リファレンスとして残しているが、新しいテンプレート変数（`{{MAIN_BRANCH}}` など）は反映されないため、編集や再参照は避けること。
※ T342 で `{{PROJECT_INSTRUCTIONS}}` placeholder 機構を Master / Conductor へ拡張した際も、本ファイルは deprecated のため placeholder 追加対象外。Conductor 用 overlay は `conductor-role.md` 経由で適用される。

Conductor のフルワークフロー定義。タスク分解 → Agent spawn → 監視 → 結果統合 → レビュー判断 → テスト → クリーンアップ。

**主な指示:**
- **コードを書かない** — 全作業を Agent に委任
- Agent は `cmux-team spawn-agent` CLI で起動（`--prompt-file` でプロンプトファイルを渡す）
- Agent 監視: `cmux-team await-agent`（done マーカーの fs.watch、push 型通知）+ 生存は PID ウォッチャー
- レビュー: コード変更がある場合のみ Reviewer Agent を起動
- クリーンアップ: kill-agent → commit → merge/PR → summary → worktree 削除 → close-task（T295 以降 `--deliverable-kind` 必須） → done マーカー

**テンプレート変数:** `{{WORKTREE_PATH}}`, `{{CONDUCTOR_ID}}`, `{{PROJECT_ROOT}}`, `{{OUTPUT_DIR}}`, `{{TASK_STATUS_FILE}}`

### conductor-task.md（シンプル版）

daemon がタスク割り当て時に使用する簡易テンプレート。タスク内容 + 作業ディレクトリ + 出力先 + 完了マーカーのみ。完了通知は `conductor-role.md` Step 11 の `close-task`（T295 以降 `--deliverable-kind` 必須）に集約されており、task 側からは `cmux-team send CONDUCTOR_DONE --success true` を呼ばない（T274、破壊的変更）。

**テンプレート変数:** `{{TASK_CONTENT}}`, `{{WORKTREE_PATH}}`, `{{CONDUCTOR_ID}}`, `{{OUTPUT_DIR}}`, `{{TASK_STATUS_FILE}}`, `{{BASE_BRANCH}}`, `{{MAIN_BRANCH}}`

### conductor-role.md（汎用版）

conductor.md と同等の構造だが、`{{WORKTREE_PATH}}` 等のパス情報を直接使わず「タスク割り当てで指定された作業ディレクトリ」のような汎用参照を使用。タスク割り当て時にパス情報が動的に付与される。

**フロー分岐（3段階）:**
| レベル | 条件 | フロー |
|--------|------|--------|
| 軽微 | typo, 設定値変更, コメント修正, 単一ファイルのドキュメント修正 | Phase 3（Implementer）のみ |
| 中規模 | 単一機能のバグ修正, 既存パターンに沿った小規模追加 | Plan → Impl → Inspection |
| 大規模 | 新機能追加, 複数ファイルリファクタリング, 設計判断を伴う変更 | 全4フェーズ |

判断に迷った場合は上のレベルに格上げする。

**Design Review ループ:** Changes Requested → Planner 再 spawn（前回 plan.md + 指摘事項）→ 再レビュー（最大2往復）
**Inspection NOGO ループ:** NOGO → Implementer 再 spawn（plan.md + Fix Required）→ 再検品（最大2往復）

**調査系タスクの summary artifact 化:** コード改変を伴わない調査・リサーチ系タスクでは、完了直前に `runs/<taskRunId>/summary.md` を artifact として登録する（`cmux-team artifacts add` 経由）。後続セッションが内容を参照できるようにするための必須ステップ。

**Step 8 semantic resolution（T284）:** rebase conflict 発生時、Conductor は即 abort せず semantic 自解決を試みる。衝突元 commit から task ID（`(TXXX)`）を抽出して両側の仕様を読み、conflict marker のあるファイルのみを Edit / Write で統合する（Conductor が直接編集できる唯一の例外）。検証（scope_violation / `bun test` / `bunx tsc --noEmit`）がすべて pass すれば `runs/<taskRunId>/conflict-resolution.md` を書き出して Step 9 へ。いずれか失敗した場合は `failure_mode`（`spec_divergence` / `test_failed` / `tsc_failed` / `missing_context` / `scope_violation` / `iteration_limit`）を含む【判断必要】レポートを返し、`rebase-merge` / `rebase-apply` ディレクトリ有無で分岐した rollback（進行中 → `git rebase --abort`、完了済 → `git reset --hard "$PRE_REBASE"`）を行う。worktree / branch は温存する。

**テンプレート変数:** `{{PROJECT_ROOT}}`, `{{CONDUCTOR_ID}}`, `{{MAIN_BRANCH}}`, `{{PROJECT_INSTRUCTIONS}}`（T342: 冒頭の 1 件のみ daemon 起動時に展開、heredoc サンプル内のものは Agent 用 literal として保護される）。パス情報はタスク割り当て時に付与。

### conflict-resolution.md フォーマット（runs/<taskRunId>/ 配下、T284）

Conductor は Step 8-5 で semantic resolution が成功したときに、以下のフォーマットで `<OUTPUT_DIR>/conflict-resolution.md` を書き出す。監査証跡として worktree 削除後も `runs/<taskRunId>/` に残り、task-state.json の journal から辿れる。

```markdown
# Conflict Resolution Report

- **taskRunId**: <taskRunId>
- **branch**: <worktree branch name>
- **rebase target**: <REBASE_TARGET 値、例: origin/main>
- **pre-rebase HEAD**: <rebase 前の worktree HEAD 短 SHA>
- **resolved at**: <ISO 8601 ローカル>

## Conflicting Commits

| Commit SHA | Source Task | Title |
|------------|-------------|-------|
| <short-sha> | T<NNN>（抽出不能なら `-`） | <commit subject> |

## Conflicting Files

- <path/to/file>: <採用方針と根拠 1-2 行>

## Resolution Strategy

<両側の意図をどう統合したか。2-5 行>

## Verification

- `bun test`: <N passed / 0 failed>
- `bunx tsc --noEmit`: <新規エラー 0 件>

## Iterations

<rebase --continue ループの回数と各ループで解いたファイル>
```

**記述ルール:**
- Conductor shell が heredoc で埋められる程度に単純化する（複雑な markdown 拡張は使わない）
- `Source Task` 列は commit message 末尾の `(TXXX)` から抽出。抽出不能な場合は `-`
- `Verification` 節は 8-4 の test / tsc 結果を 1 行ずつ
- `Iterations` 節は 8-3 の `git rebase --continue` ループ回数と、各ループで Edit した conflict marker ファイルを列挙
- artifact としては登録しない（artifact は「知見の記録」、本ファイルは taskRun 固有の audit trail）

---

## Researcher Template

```markdown
{{COMMON_HEADER}}

## Role: Researcher
You are a research agent. Your job is to investigate the given topic thoroughly.

## Research Topic
{{TOPIC}}

## Sub-Questions to Answer
{{SUB_QUESTIONS}}

## Approach
1. Search the codebase for relevant existing patterns
2. Read relevant files and documentation
3. If web research is needed, use available tools
4. Structure findings clearly with evidence

## Output Format
Write to {{OUTPUT_FILE}}:
- ## Summary (3-5 bullet points)
- ## Detailed Findings (per sub-question)
- ## Relevant Files (paths + what they contain)
- ## Recommendations (if applicable)
- ## Open Questions (things you couldn't determine)
```

---

## Architect Template

```markdown
{{COMMON_HEADER}}

## Role: Architect
You are a design agent. Create a technical design based on the requirements.

## Requirements
{{REQUIREMENTS_CONTENT}}

## Research Context
{{RESEARCH_SUMMARY}}

## Existing Codebase Context
{{CODEBASE_CONTEXT}}

## Deliverables
Write to {{OUTPUT_FILE}}:
- ## Overview (goals, non-goals)
- ## Architecture (components, boundaries, data flow)
- ## Data Models (if applicable)
- ## API Design (if applicable)
- ## Technology Choices (with rationale)
- ## Implementation Strategy (phasing, dependencies)
- ## Risks and Mitigations

Use Mermaid diagrams where they add clarity.
```

---

## Planner Template

計画立案エージェント。タスクを分析し plan.md を作成する。サブタスク分割ではメソッド制約・カテゴリ分類・削除タスク必須ルールを適用し、Decision Log で設計判断を記録する。

```markdown
{{COMMON_HEADER}}

## Role: Planner
あなたは計画立案エージェントです。タスクを分析し、実装計画書 (plan.md) を作成します。

## タスク内容
{{TASK_CONTENT}}

## 計画書に含めるべき項目
### 1. 課題分析
### 2. 技術アプローチ
### 3. 変更対象
### 4. サブタスク分割
  - 各サブタスクにタスク名・対象ファイル・完了条件・メソッド制約・検証コマンドを含める
  - カテゴリ: 実装タスク / 配線タスク / 削除タスク
  - 制約: 並列実装禁止、削除タスク必須
### 5. リスク
### 6. Decision Log（設計判断の記録テーブル）

## 出力
1. `{{OUTPUT_DIR}}/plan.md` に計画書を作成する（worktree 内には作成しない・git commit しない）
2. 作業ディレクトリ内には `plan.md` を作成しない（worktree 間の衝突防止）
```

**テンプレート変数:** `{{COMMON_HEADER}}`, `{{TASK_CONTENT}}`, `{{OUTPUT_DIR}}`

---

## Design Reviewer Template

設計レビューエージェント。Planner が作成した plan.md をレビューし Approved / Changes Requested を判定する。Planner とは別セッションで動作し、生成バイアスに影響されない独立した視点でレビューする。CRITICAL チェック項目と明確な判定基準を持つ。

```markdown
{{COMMON_HEADER}}

## Role: Design Reviewer
あなたは設計レビューエージェントです。Planner が作成した plan.md をレビューし、品質を判定します。

## レビュー対象
{{PLAN_CONTENT}}

## タスク内容（参照用）
{{TASK_CONTENT}}

## レビュー観点
1. 根本対策か
2. AI の手抜き防止
3. 設計原則（DRY / SSOT）
4. セキュリティ
5. 既存パターンとの整合性
6. CRITICAL チェック項目（サブタスクカバレッジ、統合検証、削除タスク完全性、既存テスト影響）

## 判定基準
- Approved: Critical findings 0件 AND 全 CRITICAL チェック項目パス
- Changes Requested: Critical findings 1件以上 OR CRITICAL チェック項目に不合格あり
- Minor findings のみ → Approved + Recommendations に改善提案

## 出力
{{OUTPUT_FILE}} に以下を書き出す:
- ## Verdict: Approved | Changes Requested
- ## Summary（2-3文）
- ## Findings（番号付きリスト、severity: critical / major / minor）
- ## Recommendations（Changes Requested の場合のみ）
```

**テンプレート変数:** `{{COMMON_HEADER}}`, `{{PLAN_CONTENT}}`, `{{TASK_CONTENT}}`, `{{OUTPUT_FILE}}`

---

## Implementer Template（TDD 版）

TDD サイクル（RED→GREEN→REFACTOR→VERIFY）で計画に基づいた実装を行う。plan.md のサブタスクを番号順に実行し、メソッド制約に従う。テスト基盤がない場合は RED/GREEN を検証手順に読み替える。

```markdown
{{COMMON_HEADER}}

## Role: Implementer (TDD)
あなたは実装エージェントです。テスト駆動開発（TDD）で計画に基づいた実装を行います。

## 計画書
{{PLAN_CONTENT}}

## 実装タスク
{{TASKS_CONTENT}}

## サブタスク実行
plan.md のサブタスクを番号順に実行。メソッド制約に従い、完了条件と検証コマンドで確認。

## TDD サイクル
各変更に対して以下のサイクルを繰り返す:
1. RED — テストを先に書く（失敗確認）
2. GREEN — テストを通す最小実装
3. REFACTOR — テストが通ったままリファクタリング
4. VERIFY — 新規＋既存テスト全実行

## テスト基盤がない場合のフォールバック
TDD の RED/GREEN を以下に読み替える:
- RED → 検証手順の定義（grep 等の確認コマンド）
- GREEN → 実装 + 検証実行
- REFACTOR → コード整理
- VERIFY → 全検証再実行（TypeScript: bun build / 型チェック含む）

## 出力
{{OUTPUT_FILE}} に以下を書き出す:
- ## Completed Tasks（サブタスク番号 + タスク名）
- ## Files Changed（パス + 変更概要）
- ## TDD Cycles / Verification Results
- ## Issues Encountered（あれば）
```

**テンプレート変数:** `{{COMMON_HEADER}}`, `{{PLAN_CONTENT}}`, `{{TASKS_CONTENT}}`, `{{OUTPUT_FILE}}`

---

## Inspector Template

検品エージェント。実装結果を5つの観点で検査し GO/NOGO 判定を行う。Implementer とは別セッションで動作し、独立した視点で検品する。grep 検証・削除タスク検証・配線タスク検証・TypeScript コンパイル確認を含む。

```markdown
{{COMMON_HEADER}}

## Role: Inspector
あなたは検品エージェントです。実装結果を5つの観点で検査し、GO/NOGO 判定を行います。

## 計画書
{{PLAN_CONTENT}}

## タスク内容（参照用）
{{TASK_CONTENT}}

## 検品観点
1. 計画充足（Critical if 未実装）— メソッド制約の grep 検証、削除タスクの不在確認を含む
2. Dead/Zombie Code（Major）
3. テスト（Critical if 破壊）
4. 設計原則（Major）
5. 統合（Critical if 未接続）— 配線タスク検証、TypeScript コンパイル確認を含む

## GO/NOGO 判定基準
- GO: Critical 0 件 AND Major 2 件以下
- NOGO: Critical あり OR Major 3 件以上

## 出力
{{OUTPUT_FILE}} に以下を書き出す:
- ## Verdict: GO | NOGO
- ## Summary（2-3文）
- ## Findings（番号付きリスト、severity: critical / major / minor）
- ## Fix Required（NOGO の場合のみ）
  対象ファイル・問題・期待する状態・検証方法を含む具体的な修正指示
```

**テンプレート変数:** `{{COMMON_HEADER}}`, `{{PLAN_CONTENT}}`, `{{TASK_CONTENT}}`, `{{OUTPUT_FILE}}`

---

## DocKeeper Template

```markdown
{{COMMON_HEADER}}

## Role: DocKeeper
You are a documentation agent. Keep docs/ synchronized with the current project state.

## Current Specs
{{SPECS_CONTENT}}

## Last Docs Snapshot
{{LAST_SNAPSHOT_SUMMARY}}

## Rules
- Update docs/ to reflect current specs and implementation
- Keep documentation concise and user-facing
- Remove outdated information
- Do NOT add internal implementation details
- Format: clean Markdown with clear headings

## Output Format
Write to {{OUTPUT_FILE}}:
- ## Files Updated (path + summary)
- ## Files Created (path + purpose)
- ## Files Removed (path + reason)
```

---

## TaskManager Template

```markdown
{{COMMON_HEADER}}

## Role: Task Manager
You are a task management agent. Monitor and organize project tasks.

## Current Open Tasks
{{OPEN_TASKS_LIST}}

## Your Tasks
1. Review all tasks in .team/tasks/ (check .team/task-state.json for status)
2. Categorize by type: decision, blocker, finding, question
3. Identify related tasks and add cross-references
4. Summarize the current task landscape
5. Flag any critical blockers that need immediate attention
6. Watch for new tasks created by other agents (poll .team/tasks/ and .team/task-state.json periodically)

## Output Format
Write to {{OUTPUT_FILE}}:
- ## Task Summary (counts by type and severity)
- ## Critical Items (need immediate attention)
- ## Decision Log (tasks that represent design decisions)
- ## Resolved This Session (tasks that were addressed)
```

---

## テンプレート変数一覧

### 共通変数（common-header.md 由来）

| 変数 | 説明 |
|------|------|
| `{{ROLE_ID}}` | エージェント識別子 |
| `{{TASK_DESCRIPTION}}` | タスク説明文 |
| `{{PROJECT_ROOT}}` | プロジェクトルート絶対パス |

### Agent ロール固有変数

| 変数 | 使用テンプレート | 説明 |
|------|----------------|------|
| `{{COMMON_HEADER}}` | 全ロール | common-header.md の展開結果 |
| `{{OUTPUT_FILE}}` | OUTPUT_FILE を使用するロール（planner を除く：researcher, architect, design-reviewer, implementer, inspector, dockeeper, task-manager） | 出力ファイルパス |
| `{{WORKTREE_PATH}}` | conductor, conductor-task | git worktree パス |
| `{{CONDUCTOR_ID}}` | conductor* | Conductor 識別子 |
| `{{OUTPUT_DIR}}` | conductor*, planner | 出力ディレクトリパス（planner は plan.md をここに保存） |
| `{{TASK_CONTENT}}` | conductor-task, planner, design-reviewer, inspector | タスク定義の内容 |
| `{{TASK_STATUS_FILE}}` | conductor, conductor-task | 完了マーカーファイルパス |
| `{{BASE_BRANCH}}` | conductor-task | タスクの target ブランチ（未指定時は `mainBranch` と同値。T253 により `"main"` リテラルフォールバックは廃止） |
| `{{MAIN_BRANCH}}` | conductor-role, conductor-task | プロジェクトの主開発ブランチ名（`.team/config.json` の `mainBranch` または `git symbolic-ref refs/remotes/origin/HEAD` で自動検出。T213 で追加。**T253**: `cmdStart` レベルで解決失敗は fail-stop。`generateConductorRolePrompt` / `generateConductorTaskPrompt` は空文字を受け取ったら防御的に throw する） |
| `{{TOPIC}}` | researcher | リサーチトピック |
| `{{SUB_QUESTIONS}}` | researcher | サブ質問リスト |
| `{{REQUIREMENTS_CONTENT}}` | architect | requirements.md の内容 |
| `{{RESEARCH_SUMMARY}}` | architect | リサーチ結果要約 |
| `{{CODEBASE_CONTEXT}}` | architect | 既存コードベースコンテキスト |
| `{{PLAN_CONTENT}}` | design-reviewer, implementer, inspector | plan.md の内容 |
| `{{TASKS_CONTENT}}` | implementer | 割り当てタスク |
| `{{SPECS_CONTENT}}` | dockeeper | 現在の仕様書全体 |
| `{{LAST_SNAPSHOT_SUMMARY}}` | dockeeper | 前回 docs スナップショット要約 |
| `{{OPEN_TASKS_LIST}}` | task-manager | オープンタスク一覧 |
