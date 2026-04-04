---
id: 078
title: assigned タスクの編集禁止ルールを Master テンプレートと CLAUDE.md に追加
priority: high
created_at: 2026-04-04T14:03:23.947Z
---

## タスク
## 目的

assigned（実行中）のタスクファイルを Master が編集しても、Conductor は起動時のプロンプトで動いているため反映される保証がない。無意味な操作を防ぐルールを明記する。

## 変更内容

### 1. skills/cmux-team/templates/master.md

「やらないこと」セクションに以下を追加:
- assigned 状態のタスクファイルを編集してはならない。Conductor は起動時に受け取ったプロンプトで動いており、タスクファイルの途中変更は反映されない
- 方針変更が必要な場合は abort-task で中止してから新しいタスクを作成する

### 2. CLAUDE.md

Manager プロトコルまたはチーム状態管理セクション付近に以下を追記:
- assigned タスクのファイル編集は禁止。Conductor は起動時のプロンプトのスナップショットで動作するため、タスクファイルの変更は実行中の作業に反映されない
- 変更が必要な場合: abort-task → 新タスク作成

## 確認ポイント
- templates/master.md の「やらないこと」に assigned 編集禁止が含まれること
- CLAUDE.md に同等の記述があること
