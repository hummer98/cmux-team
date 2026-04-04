---
id: 056
title: 各サブコマンドに --help オプションを追加
priority: medium
created_at: 2026-04-03T13:45:24.606Z
---

## タスク
## 背景

cmux-team の各サブコマンド（create-task, update-task, close-task, status, spawn-agent 等）にはヘルプ表示機能がない。主な利用者は AI（Conductor/Agent/Master）なので、AI がコマンドの使い方を自己解決できるよう、各コマンドに --help|-h オプションを追加する。

## 要件

- 全サブコマンドで `--help` または `-h` を指定するとヘルプを表示して終了
- ヘルプは AI が読んで正しくコマンドを組み立てられるよう、以下を含む:
  - コマンドの目的（1行）
  - 全オプションの説明（必須/任意、型、デフォルト値）
  - 使用例（2-3パターン）
  - 注意事項（あれば）

## 対象サブコマンド一覧

main.ts の switch 文から列挙:

1. `start` — daemon 起動 + Master spawn
2. `send` — キューにメッセージ送信
3. `status` — ステータス表示
4. `stop` — graceful shutdown
5. `spawn-agent` — Agent 起動
6. `agents` — 稼働中エージェント一覧
7. `kill-agent` — Agent 停止
8. `create-task` — タスク作成
9. `update-task` — タスク更新
10. `close-task` — タスク完了
11. `trace` — トレース検索・表示
12. `conductor` — Conductor 起動（内部用）
13. `launch-master` — Master 起動（内部用）
14. `restart-conductor` — Conductor 再起動
15. `reset-conductor` — Conductor リセット
16. `artifacts` — アーティファクト管理

## 実装方針

- 各 `cmd*` 関数の冒頭で `--help` / `-h` を検出し、ヘルプ文字列を出力して `process.exit(0)`
- ヘルプ文字列はテンプレートリテラルで関数内に直接記述（別ファイルにしない）
- 共通のヘルプ検出ヘルパーを用意すると良い: `if (hasFlag('help') || hasFlag('h')) { ... }`

## ヘルプ出力フォーマット例

```
cmux-team create-task — タスクを作成する（ID 自動採番）

Usage:
  cmux-team create-task --title <title> [options]

Options:
  --title <text>      タスク名（必須）
  --body <text>       タスクの詳細説明（任意）
  --priority <level>  優先度: high | medium | low（デフォルト: medium）
  --status <status>   初期ステータス: draft | ready（デフォルト: draft）

Examples:
  # 基本的なタスク作成（draft 状態）
  cmux-team create-task --title "バグ修正" --body "ログインページの500エラーを修正"

  # すぐに実行（ready 状態で作成 → Manager が自動検出）
  cmux-team create-task --title "テスト追加" --priority high --status ready --body "認証モジュールのユニットテストを追加"

  # body を省略（タイトルのみ）
  cmux-team create-task --title "README 更新" --status ready

Notes:
  - ID は自動採番（.team/tasks/ 内の既存ファイルから最大値+1）
  - status=ready で作成すると Manager に自動通知される
  - タスクファイルは .team/tasks/<id>-<slug>.md に生成される
```
