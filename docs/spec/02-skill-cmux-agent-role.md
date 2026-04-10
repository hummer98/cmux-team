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

`Output:` 行の表記は固定だが、実際の出力先は Conductor が spawn 時に展開する `OUTPUT_DIR` に依存する。タスク中心フォルダ集約（`.team/tasks/TNNN-slug/runs/<taskRunId>/`）が導入されたため、現行ではこのタスク実行ディレクトリ配下に成果物が書かれる。

**完了したら停止するだけ。報告は不要。上位が監視する。**

**環境変数:** Agent は `CMUX_CLAUDE_HOOKS_DISABLED=1` が設定された状態で起動される。これにより cmux ラッパーの hook（Plugin hooks）が無効化され、Manager が生成する `conductor-settings.json` の hook のみが適用される。

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

判断が必要な事項、ブロッカー、発見事項がある場合にタスクを作成:

```bash
# タスク作成は CLI で行う（ID 自動採番・task-state.json 更新を一括実行）
cmux-team create-task --title "タイトル" --body "詳細"

# 依存関係や別ブランチ向けの応用例
cmux-team create-task --title "実装" --depends-on "081,082" --status ready
cmux-team create-task --title "hotfix" --base-branch develop --status ready
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

Manager daemon の状態を確認するには CLI を使う:

```bash
# ダッシュボード表示（Master / Conductors / Tasks / Log）
cmux-team status

# ログ末尾を多めに表示
cmux-team status --log 20
```

**出力内容**: daemon の稼働状態、Master surface、稼働中 Conductor 一覧（タスクタイトル付き）、open/closed タスク数、manager.log 末尾。

`cmux read-screen` でダッシュボードの TUI を読む必要はない。`status` コマンドが同じ情報を返す。

### 8. トレース検索

過去の API リクエスト履歴を検索できる:

```bash
# タスクに関連するトレースを表示
cmux-team trace --task <task-id>

# 全文検索
cmux-team trace --search "keyword"

# 特定トレースの詳細（リクエスト/レスポンス本文含む）
cmux-team trace --show <trace-id>
```

### 9. Artifact 出力

作業中に以下に該当する知見が生まれた場合、Artifact として `.team/artifacts/` に保存する:

- 調査結果（複数の選択肢の比較、技術的な発見）→ type: research
- 設計判断（なぜその方法を選んだか）→ type: decision
- セッション要約（重要な発見・学び）→ type: session

**手順:**

1. 採番: `ls .team/artifacts/ 2>/dev/null | grep -oE '^A[0-9]+' | sort | tail -1` で最大番号 + 1
2. ファイル作成: `.team/artifacts/Axxx-<slug>.md`
3. フロントマター必須: id, type, title, created, author
4. フロントマター任意: updated, task, tags

```yaml
---
id: A001
type: research
title: "タイトル"
created: <ISO 8601>
author: <自分のロール ID>
task: <関連タスク ID>
tags: [tag1]
---
```

**判断基準**: output ファイル（`.team/output/`）に書く成果物とは別に、後のセッションで参照される価値のある知見があれば Artifact にする。すべての作業に Artifact が必要なわけではない。

### 10. 言語ルール

- ドキュメント・コメント: 日本語
- コード: 英語
