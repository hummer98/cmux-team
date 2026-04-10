---
id: 142
title: docs/spec/ を v3.35〜v3.38 の実装変更に同期
priority: medium
created_at: 2026-04-10T21:55:26.147Z
---

## タスク
## 概要

docs/spec/ の最終更新（7dfc8c3、2026-04-10）以降の実装変更を反映する。

## 対象コミット（20件、T124〜T141）

主な変更:
- T127: worktree .envrc 生成（OAuth トークン継承）
- T128: cmux-team resume コマンド（Conductor セッション復旧）
- T129: start 時にワークスペース名を起動フォルダ名に設定
- T130: Conductor/Agent spawn 時に CMUX_CLAUDE_HOOKS_DISABLED=1
- T131: artifacts add サブコマンド
- T132: Conductor --session-id で resume 可能に
- T133/T135: 5h レート制限の一時停止（閾値 95%→90%）
- T136: update-task --depends-on オプション
- T137: Manager サイドバーステータスのリアルタイム更新
- T139: spawn-master に CMUX_CLAUDE_HOOKS_DISABLED=1
- T140: artifacts open サブコマンド（Markdown ビューア）
- T141: SESSION_CLEAR で running Conductor を abort + idle リセット
- /clear 方式への復帰、resume 多重起動防止

## 更新が必要なファイル

### 01-skill-cmux-team.md（高）
- CLI サブコマンド表に resume, artifacts add, artifacts open を追加
- update-task に --depends-on オプションを記載
- CMUX_CLAUDE_HOOKS_DISABLED=1 の環境変数設定について記載

### 03-commands.md（高）
- resume, artifacts add, artifacts open コマンドの追加
- update-task --depends-on の追加
- spawn-agent/spawn-master の CMUX_CLAUDE_HOOKS_DISABLED 記載

### 05-install-and-infrastructure.md（高）
- レート制限閾値を 95% → 90% に修正
- 5h レート制限超過時のタスク実行一時停止を記載
- resume ロジック（sessionId, worktreePath, taskRunId）を記載
- Manager サイドバーステータスのリアルタイム更新を記載
- workspace 命名の自動設定を記載
- CMUX_CLAUDE_HOOKS_DISABLED の適用範囲拡大（Agent spawn, spawn-master）

### 00-project-overview.md（中）
- resume 機能の概要記載
- task-state.json の新フィールド（sessionId, worktreePath, taskRunId, conductorSlot）

### 02-skill-cmux-agent-role.md（中）
- CMUX_CLAUDE_HOOKS_DISABLED=1 環境変数の記載
- サイドバーステータスの言及

### 06-implementation-tasks.md（中）
- Phase 8（T127-T141）のセクション追加
- レート制限の改善候補を「一部実装済み」に更新

### 04-templates.md
- 変更不要

## 注意事項

- 実装コード（skills/cmux-team/manager/）を直接読んで正確な仕様を確認すること
- 既存の文体・構造を維持する
- 不明な点は推測で書かず「要確認」とする
