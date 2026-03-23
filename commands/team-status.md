---
allowed-tools: Bash, Read, Glob, Grep
description: "チームの現在の状態を表示する"
---

# /team-status

チームの現在の状態を表示してください。

## 手順

1. .team/team.json を読む（なければ未初期化を案内）
2. 以下の真のソースから直接情報を取得して表示:
   - **Manager の状態**: `cmux read-screen --surface <manager-surface> --lines 5` で画面を確認
   - **稼働中の Conductor**: `cmux tree` でペイン構成を確認
   - **オープンタスク**: `ls .team/tasks/open/` でファイル一覧
   - **完了タスク履歴**: `grep task_completed .team/logs/manager.log`
   - **クローズ済みタスク数**: `ls .team/tasks/closed/ | wc -l`
3. アーキテクチャ: 4-tier (Master → Manager → Conductor → Agent)
4. Manager が応答しているか cmux read-screen で簡易ヘルスチェック

## 引数

なし
