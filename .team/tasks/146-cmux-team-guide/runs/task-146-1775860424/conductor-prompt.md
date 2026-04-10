# タスク割り当て

## タスク内容

---
id: 146
title: cmux-team-guide スキルを追加（配布先向けヘルプ・仕様ナレッジ）
priority: medium
created_at: 2026-04-10T22:33:44.596Z
---

## タスク
## 概要

配布先のユーザーが cmux-team の使い方や仕様について質問したとき、Claude Code が回答できるようにする guide スキルを追加する。claude-code-guide と同様のパターン。

## 背景

現状、配布先では以下の知識ソースが不足している:
- SKILL.md はエージェント向けのロール定義で、ユーザー向けヘルプではない
- commands/*.md は実行時にしか読まれない
- docs/spec/ はリポジトリにあるが plugin に含まれない
- CLAUDE.md は開発者向けで配布されない

## 作成するファイル

`skills/cmux-team-guide/SKILL.md`

### トリガー

- 「cmux-team の使い方」「タスクの作り方」「Conductor とは」等の質問
- 「cmux-team help」「チーム機能について」
- cmux-team の概念・操作・トラブルシューティングに関する質問

### 蒸留元

以下のソースから、ユーザー向けの情報を蒸留して SKILL.md に凝縮する:

1. `docs/spec/00-project-overview.md` — 4層アーキテクチャ、設計原則
2. `docs/spec/01-skill-cmux-team.md` — CLI サブコマンド、タスク管理
3. `docs/spec/03-commands.md` — スラッシュコマンド一覧
4. `docs/spec/05-install-and-infrastructure.md` — インストール、インフラ構成
5. `README.ja.md` — ユーザー向け説明
6. `CLAUDE.md` の関連セクション — リポジトリ構造、テスト方法、コーディング規約

### 含めるべき内容

- **概要**: 4層アーキテクチャ（Master → Manager → Conductor → Agent）の説明
- **インストール・起動**: `npm install -g`, `cmux-team start`, `cmux-team stop`
- **タスク管理**: create-task, update-task, close-task, abort-task, restart-task, delete-task の使い方
- **CLI コマンド一覧**: 全サブコマンドとオプション
- **スラッシュコマンド**: /master, /team-spec, /team-task, /team-archive, /artifact
- **TUI ダッシュボード**: 見方、操作方法
- **進捗確認**: cmux-team status の読み方
- **Artifacts**: 作成・参照方法
- **トラブルシューティング**: よくある問題と対処法（Trust 確認、レート制限、Conductor クラッシュ等）
- **git worktree**: 仕組みと注意点

### 含めないもの（開発者向け）

- 内部実装詳細（daemon のコードレベルの説明）
- テンプレート変数仕様
- コーディング規約
- ロギングポリシー

## 注意

- SKILL.md のサイズは適切に保つ（コンテキスト消費を抑える）
- 実装の現状を正確に反映する（docs/spec と実コードの両方を確認）
- 日本語で記述


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-146-1775860424` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-146-1775860424
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-146-1775860424/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/146-cmux-team-guide/runs/task-146-1775860424
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/146-cmux-team-guide/runs/task-146-1775860424/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら、最後に:
```bash
cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
```
