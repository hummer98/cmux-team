---
allowed-tools: Bash, Read, Glob, Grep
description: "チームの現在の状態を表示する"
---

# /team-status

チームの現在の状態を表示してください。

## 手順

1. .team/team.json を読む（なければ未初期化を案内）
2. .team/status.json を読む（Manager が更新している）
3. 以下を表示:
   - アーキテクチャ: 4-tier (Master → Manager → Conductor → Agent)
   - Manager の状態（surface, status）
   - 稼働中の Conductor 一覧（タスク、状態、Agent 数）
   - タスク状況（open/closed のファイル数）
   - 完了タスクの履歴は `.team/logs/manager.log` を参照（`grep task_completed`）
4. オプション: Manager が応答しているか cmux read-screen で簡易ヘルスチェック
5. .team/tasks/open/ と .team/tasks/closed/ のファイル数を表示

## 引数

なし
