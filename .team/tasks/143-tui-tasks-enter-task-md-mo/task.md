---
id: 143
title: TUI の Tasks パネルで Enter キーを押すと task.md を mo で開く
priority: medium
depends_on: [140]
created_at: 2026-04-10T22:04:43.638Z
---

## タスク
## 概要

TUI ダッシュボードの Tasks パネルでタスクを選択し Enter キーを押すと、そのタスクの task.md を Markdown ビューア（mo）で開けるようにする。

## 仕様

- **トリガー**: Tasks パネルでタスク選択中に Enter キー
- **開くファイル**: `.team/tasks/<id>-<slug>/task.md`
- **ビューア優先順位**: T140（artifacts open）と共通
  1. 環境変数 `CMUX_TEAM_MD_VIEWER` が設定されていればそのコマンドを使用
  2. デフォルト: `mo`
  3. `mo` が見つからなければ `cat` にフォールバック
- **起動方法**: `<viewer> <task-file-path>` で実行

## 実装場所

- `skills/cmux-team/manager/dashboard.tsx` — Tasks パネルのキーハンドラに Enter を追加
- ビューア解決ロジックは T140 で実装済みの関数（main.ts 内）を共通化して再利用すること

## 依存

- T140（artifacts open）のビューア解決ロジックを共通ユーティリティとして切り出す（まだ切り出されていなければ）
