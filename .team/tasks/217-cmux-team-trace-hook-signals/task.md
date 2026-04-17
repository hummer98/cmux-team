---
id: 217
title: cmux-team trace: hook_signals 履歴表示サブコマンド追加
priority: medium
created_at: 2026-04-15T17:42:48.010Z
depends_on: [216]
---

## タスク
## 背景
T216 で trace DB に hook_signals テーブルが追加される。
cmux-team trace でhookシグナルの履歴を検索・表示できるようにする。

## やること
- main.ts の cmdTraceTask（または新規 cmdTrace サブコマンド）を拡張
- 表示オプション案:
  - `cmux-team trace-hooks` — 直近N件のhookシグナル一覧
  - `cmux-team trace-hooks --surface C[665]` — surface絞り込み
  - `cmux-team trace-hooks --type SESSION_ENDED` — type絞り込み
  - `cmux-team trace-hooks --task T042` — task_id絞り込み（可能なら）
- 表示カラム: timestamp, type, surface, pid, reason/source/question など

## 依存
T216（hook_signalsテーブル追加）
