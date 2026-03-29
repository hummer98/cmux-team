---
id: 1774711264
title: 仕様書（docs/seeds/ + .team/specs/）を現状の実装に同期
priority: medium
created_at: 2026-03-28T20:38:52.287Z
---

## タスク
## 目的

docs/seeds/ と .team/specs/ の仕様書が現状の実装と乖離している。実装をソースオブトゥルースとして仕様書を更新する。

## 対象ファイル

### docs/seeds/（設計シードドキュメント）
- 00-project-overview.md
- 01-skill-cmux-team.md
- 02-skill-cmux-agent-role.md
- 03-commands.md
- 04-templates.md
- 05-install-and-infrastructure.md
- 06-implementation-tasks.md

### .team/specs/
- requirements.md
- fixed-layout-conductor-reuse.md

## 作業手順

1. 現状の実装を読み取る（skills/, commands/, templates/, manager/ 配下のコード）
2. 各仕様書と実装の差分を洗い出す
3. 実装に合わせて仕様書を更新する

## 特に乖離が予想される点

- Manager が TypeScript daemon になった（元はClaude セッション）
- タスク管理: tasks/ フラット構造 + task-state.json の導入
- 固定2x2レイアウト + Conductor スロット制（3台）
- create-task CLI による即時実行フロー（TODO廃止）
- TUI ダッシュボード（Ink ベース）の追加
- プロキシサーバーによる API レート制限対策
- spawn-conductor.sh のテンプレートベースプロンプト生成

## 注意

- 実装が正。仕様書を実装に合わせる（逆ではない）
- 将来の構想・未実装機能は削除するか「未実装」と明記
- 日本語で記述
