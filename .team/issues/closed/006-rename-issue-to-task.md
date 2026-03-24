---
id: 6
title: ローカル issue を task にリネームし、issue は GitHub issue 専用とする
priority: medium
status: draft
created_at: 2026-03-24T00:00:00+09:00
---

## タスク

プロジェクト全体で「issue」と「task」の用語を明確に分離する。

- **task** = `.team/tasks/` 配下のローカルファイル（Manager が走査・Conductor に割り当てるもの）
- **issue** = GitHub issue（外部追跡・議論用）

### 変更内容

#### 1. ディレクトリリネーム

- `.team/issues/open/` → `.team/tasks/open/`
- `.team/issues/closed/` → `.team/tasks/closed/`
- 既存のタスクファイルもすべて移動

#### 2. コマンドのリネーム

- `commands/team-issue.md` → `commands/team-task.md`
- コマンド内の全パス・用語を `issue` → `task` に置換

#### 3. テンプレートの更新

| ファイル | 変更内容 |
|---------|---------|
| `templates/manager.md` | 走査パス `.team/issues/open/` → `.team/tasks/open/`、`issue` → `task` 全般 |
| `templates/master.md` | task 作成手順のパス・用語 |
| `templates/common-header.md` | ブロッカー時の task 作成パス |
| `templates/issue-manager.md` | ファイル名を `task-manager.md` にリネーム、内容の `issue` → `task` |
| `templates/implementer.md` | 設計不明時の task 作成パス |

#### 4. スキル SKILL.md の更新

| ファイル | 変更内容 |
|---------|---------|
| `skills/cmux-team/SKILL.md` | Master→Manager 通信パス、Master 行動原則、task ファイル形式、Manager ループプロトコル |
| `skills/cmux-agent-role/SKILL.md` | task 参照パス、task 作成手順 |

#### 5. コマンドの更新（パス・用語のみ）

| ファイル | 変更内容 |
|---------|---------|
| `commands/start.md` | Master の task 作成手順・パス |
| `commands/team-status.md` | task ディレクトリの参照パス |
| `commands/team-spec.md` | task 確認パス |
| `commands/team-design.md` | オープン task 参照 |
| `commands/team-review.md` | 指摘事項の task 作成パス |
| `commands/team-test.md` | テスト失敗時の task 作成パス |

#### 6. CLAUDE.md の更新

- リポジトリ構造の `issue-manager.md` → `task-manager.md`
- リポジトリ構造の `team-issue.md` → `team-task.md`
- テンプレート変数 `{{OPEN_ISSUES_LIST}}` → `{{OPEN_TASKS_LIST}}`
- 「issue 作成ガイドライン」セクションは **GitHub issue の話なので維持**（ただし「ローカル task とは別」と明記）

#### 7. status.json の更新

- `issue_id` → `task_id`
- `issues: { open: N, closed: N }` → `tasks: { open: N, closed: N }`

#### 8. docs/seeds/ の更新

| ファイル | 変更内容 |
|---------|---------|
| `docs/seeds/01-skill-cmux-team.md` | `.team/issues/open/` パス |
| `docs/seeds/02-skill-cmux-agent-role.md` | `.team/issues/open/` パス |
| `docs/seeds/03-commands.md` | `.team/issues/` パス |
| `docs/seeds/04-templates.md` | `.team/issues/open/` パス |
| `docs/seeds/06-implementation-tasks.md` | `.team/issues/` パス |

#### 9. 変更しないもの

- CLAUDE.md の「issue 作成ガイドライン」（GitHub issue の文脈）
- CLAUDE.md の「設計判断で迷ったら issue を作って」（GitHub issue の文脈）
- 「実際に動かして判明した issue（#12 のような）」（GitHub issue の文脈）

## 対象ファイル（全22ファイル）

**リネーム:**
- `.team/issues/` → `.team/tasks/`
- `commands/team-issue.md` → `commands/team-task.md`
- `skills/cmux-team/templates/issue-manager.md` → `skills/cmux-team/templates/task-manager.md`

**内容変更:**
- `skills/cmux-team/SKILL.md`
- `skills/cmux-agent-role/SKILL.md`
- `skills/cmux-team/templates/manager.md`
- `skills/cmux-team/templates/master.md`
- `skills/cmux-team/templates/common-header.md`
- `skills/cmux-team/templates/implementer.md`
- `commands/start.md`
- `commands/team-status.md`
- `commands/team-spec.md`
- `commands/team-design.md`
- `commands/team-review.md`
- `commands/team-test.md`
- `CLAUDE.md`
- `.team/status.json`
- `.team/prompts/master.md`
- `docs/seeds/01-skill-cmux-team.md`
- `docs/seeds/02-skill-cmux-agent-role.md`
- `docs/seeds/03-commands.md`
- `docs/seeds/04-templates.md`
- `docs/seeds/06-implementation-tasks.md`

## 完了条件

- ローカルタスクファイルの文脈で「issue」が使われていないこと
- GitHub issue の文脈では引き続き「issue」が使われていること
- Manager が `.team/tasks/open/` を正しく走査すること
- 全コマンド・テンプレートのパスが `.team/tasks/` を参照していること
