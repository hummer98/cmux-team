# Seed: cmux-agent-role Skill（サブエージェント行動規範）

## File: `skills/cmux-agent-role/SKILL.md`

## Purpose

Conductor によって起動されたサブエージェント（Agent）の行動規範。
出力プロトコル、タスク作成方法、作業境界、daemon ステータス取得方法を定義する。

## Frontmatter

```yaml
---
name: cmux-agent-role
description: >
  Activated when running as a cmux-team sub-agent.
  Triggers: .team/team.json exists AND current session was spawned by Conductor
  (detect via: initial prompt contains "[CMUX-TEAM-AGENT]" marker).
  Provides: output protocol, task creation, inter-agent coordination.
---
```

## Content Sections（実装済み）

### 1. エージェント識別

起動時にマーカー付きプロンプトを受け取る:
```
[CMUX-TEAM-AGENT]
Role: <role-id>
Task: <タスク内容>
Output: .team/output/<role-id>.md
```

**完了したら停止するだけ。報告は不要。上位が監視する。**

### 2. 出力プロトコル

すべての成果物は指定された出力ファイルに書き込む:
```markdown
# Output: <role-id>
## Task
<元のタスク内容>
## Findings
<構造化された結果>
## Recommendations
<該当する場合>
## Tasks Raised
- See .team/tasks/NNN-*.md
```

ルール:
- インクリメンタルに書き込む
- 明確な Markdown 構造を使用
- 読んだファイル、実行したコマンドへの参照を含める
- 明示的な指示がない限り、プロジェクト外のファイルに書き込まない

### 3. 作業境界

- 割り当てられた git worktree の範囲内で作業
- worktree 外のファイルを直接変更しない
- 共有データは `.team/` ディレクトリを通じてやり取り

### 4. タスク作成

判断が必要な事項、ブロッカー、発見事項がある場合に CLI でタスクを作成:

```bash
bun run .team/manager/main.ts create-task --title "タイトル" --body "詳細"
```

タスク形式:
```markdown
---
id: NNN
title: <簡潔なタイトル>
type: decision|blocker|finding|question
raised_by: <role-id>
created_at: <ISO タイムスタンプ>
---
## Context
<経緯>
## Options
1. <選択肢 A>
2. <選択肢 B>
## Recommendation
<推奨案>
```

### 5. 他エージェントとの連携

サブエージェント同士は直接通信しない。すべての連携:
- `.team/` 内の共有ファイル
- Conductor（cmux 経由）

他エージェントの成果が必要な場合:
- `.team/output/<other-role>.md` が存在すれば読む
- 存在しない場合は `blocker` タイプのタスクを作成

### 6. ロール別ガイドライン

| ロール | 主な責務 |
|--------|---------|
| **Researcher** | 事実の収集、ソース引用。設計判断はしない |
| **Architect** | リサーチャー出力を読んで設計。Mermaid ダイアグラム使用 |
| **Reviewer** | 要件・設計に照らし合わせてチェック。Approved / Changes Requested |
| **Implementer** | design.md に厳密に従いコード実装。スコープ外リファクタ禁止 |
| **Tester** | 要件を検証するテスト作成・実行。失敗はタスク起票 |
| **DocKeeper** | docs/ を現在の状態に反映。簡潔かつ正確に |
| **TaskManager** | タスク監視・分類・要約。ブロッカーのフラグ |

### 7. daemon ステータス取得

```bash
# ダッシュボード表示
bun run .team/manager/main.ts status

# ログ末尾を多めに表示
bun run .team/manager/main.ts status --log 20
```

`cmux read-screen` でダッシュボードの TUI を読む必要はない。`status` コマンドが同じ情報を返す。

### 8. 言語ルール

- ドキュメント・コメント: 日本語
- コード: 英語

## 旧仕様からの変更点

- **`cmux set-status` / `cmux wait-for -S` は廃止**: Agent はステータス報告も完了シグナルも送らない。完了したら停止するだけ
- **タスク作成は CLI 経由**: `bun run main.ts create-task` で ID 自動採番 + task-state.json 更新
- **`tasks/open/` / `tasks/closed/` は廃止**: フラット構造 `tasks/` + `task-state.json`
