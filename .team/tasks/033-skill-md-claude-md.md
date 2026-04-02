---
id: 033
title: SKILL.md 分割: 開発情報を CLAUDE.md に統合し配布版を最小化
priority: high
created_at: 2026-03-31T15:02:18.072Z
---

## タスク
## 背景

SKILL.md（593行）が全セッション（Master含む）のコンテキストに読み込まれ、Master が知る必要のない内部情報を公開している。Master が CLI 失敗時にタスクファイルを直接 Write した事故の根本原因。

## 方針（確定済み）

### 設計判断

| # | 判断 | 決定 |
|---|------|------|
| 1 | 開発ドキュメントの置き場所 | **A. CLAUDE.md に統合**（重複削除で+200行程度、同期問題なし） |
| 2 | 配布版 SKILL.md の粒度 | **最小**（アーキテクチャ概要 + CLI 一覧のみ。master.md テンプレートに必要な情報は既にある） |
| 3 | Conductor 向け情報 | **A. conductor.md テンプレートに移す** |
| 4 | cmux-agent-role のタスク形式 | **削除して CLI 使用のみ記載** |

### 具体的な作業

#### Step 1: SKILL.md → CLAUDE.md への移動

以下を CLAUDE.md に統合（重複は削除、概要レベルに圧縮）:
- Manager プロトコル（§2, ~97行）
- 通信プロトコル（§5, ~43行）
- チーム状態管理（§6, ~36行）
- レイアウト戦略（§7, ~42行）
- エラーリカバリ（§9, ~24行）
- git worktree（§8 の概要のみ、詳細は conductor.md へ）

#### Step 2: Conductor プロトコルを conductor.md テンプレートに移動

SKILL.md §3（~95行）+ §8 の worktree 詳細手順を templates/conductor.md に移す。

#### Step 3: 配布版 SKILL.md を最小化

残すもの:
- アーキテクチャ概要（4層構造の図と責務表）
- CLI コマンド一覧
- トレース検索の使い方

削除するもの:
- タスクファイル形式（frontmatter 例）
- Master の行動原則（master.md テンプレートが担当）
- Manager/Conductor/Agent プロトコル詳細
- 通信プロトコル内部実装
- git worktree 手順
- チーム状態管理の json 例

#### Step 4: cmux-agent-role/SKILL.md からタスクファイル形式を削除

73-93行のフォーマット例を削除し、CLI の使い方のみ記載に変更。

#### Step 5: master.md テンプレートの .team/tasks/ 禁止記述を確認

先行修正済み（18行目）。整合性を確認。

## 関連

- .claude/settings.json に .team/tasks/ への Write/Edit ブロック hook 追加済み（防御層）
- templates/master.md の禁止記述を先行修正済み
