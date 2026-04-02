---
id: 032
title: SKILL.md を分割し Master に不要な情報を配布版から除外する
priority: high
created_at: 2026-03-31T14:58:41.760Z
---

## タスク
## 背景

SKILL.md（593行）が全セッション（Master含む）のコンテキストに読み込まれており、Master が知る必要のない内部情報（タスクファイル形式、Manager/Conductor/Agent のプロトコル詳細、worktree 操作手順等）を公開している。これが原因で Master が CLI 失敗時にタスクファイルを直接 Write するという指示外動作を引き起こした。

## 問題

- SKILL.md にタスクファイルの YAML frontmatter 形式が記載されている（80-96行）
- Manager プロトコル全体（98-195行）、Conductor プロトコル（196-298行）、worktree 手順（425-481行）等、全層の内部実装が Master のコンテキストに入る
- 開発リポジトリの CLAUDE.md としては必要だが、配布版スキルとしては不要な情報が大量

## やること

### 1. SKILL.md の役割を再定義

- 配布版 SKILL.md: Master が読むための最小限の情報（アーキテクチャ概要 + CLI コマンド一覧のみ）
- 開発ドキュメント: 全層プロトコルの詳細は CLAUDE.md または docs/ に移動

### 2. 配布版 SKILL.md から除外すべき情報

- タスクファイル形式（frontmatter の例）→ CLI が抽象化している
- Manager プロトコル詳細（daemon の内部実装）→ Master は知る必要なし
- Conductor プロトコル詳細（Agent spawn 方法等）→ conductor.md テンプレートが担当
- Agent プロトコル → cmux-agent-role/SKILL.md が担当
- git worktree の作成・削除手順 → Conductor の責務
- 通信プロトコルの内部実装詳細

### 3. 配布版 SKILL.md に残すべき情報

- アーキテクチャ概要（4層構造の図と責務表）
- CLI コマンド一覧（create-task, update-task, status 等）
- 進捗確認方法（cmux-team status）
- レイアウト概要（2x2構成の概念のみ）
- トレース検索の使い方

### 4. cmux-agent-role/SKILL.md のタスクファイル形式も確認

73-93行にタスクファイル形式の例がある。Agent は create-task CLI を使うので、フォーマット詳細は不要。CLI の使い方だけ残す。

## 関連

- master.md テンプレートには既に CLI 使用の指示がある
- conductor.md テンプレートに Conductor 固有のプロトコルを移動する想定
- .claude/settings.json に .team/tasks/ への Write/Edit ブロック hook を追加済み（防御層）
