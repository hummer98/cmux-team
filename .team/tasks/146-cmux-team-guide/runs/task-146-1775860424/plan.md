# 実装計画: cmux-team-guide スキル (T146)

## 概要

`skills/cmux-team-guide/SKILL.md` を新規作成する。配布先ユーザーが cmux-team の使い方を質問したときに Claude Code が回答できるようにするガイドスキル。

## 作成するファイル

`skills/cmux-team-guide/SKILL.md` — 1ファイルのみ

## SKILL.md の構成（アウトライン）

### YAML frontmatter
- name: cmux-team-guide
- description: トリガー条件を含む（cmux-team の使い方、概念、操作、トラブルシューティングの質問）

### 本文セクション

1. **概要** — 4層アーキテクチャの簡潔な説明（Master → Manager → Conductor → Agent）
2. **インストール・起動** — npm install, cmux-team start/stop
3. **タスク管理** — create-task, update-task, close-task, abort-task, restart-task, delete-task
4. **CLI コマンド一覧** — 全サブコマンドとオプションの表
5. **スラッシュコマンド** — /master, /team-spec, /team-task, /team-archive, /artifact, /docs-sync
6. **TUI ダッシュボード** — 見方、キーボードショートカット
7. **進捗確認** — cmux-team status の読み方
8. **Artifacts** — 作成・参照方法
9. **トラブルシューティング** — Trust 確認、レート制限、Conductor クラッシュ等
10. **git worktree** — 仕組みと注意点

### サイズ目標

約200-300行。コンテキスト消費を抑えつつ十分な情報量を確保。

## 蒸留のポイント

- ユーザーが「使い方」を聞いたときに答えられる内容に絞る
- 内部実装詳細（daemon のコード、テンプレート変数、ロギングポリシー）は除外
- CLI コマンドは実際の i18n.ts の help テキストと docs/spec を照合
