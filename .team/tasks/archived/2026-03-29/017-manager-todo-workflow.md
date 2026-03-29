---
id: 017
title: Manager に Todo ワークフローを追加（[PLAN_UPDATE] を置換）
priority: high
status: ready
created_at: 2026-03-25T07:00:00Z
---

## タスク

Manager テンプレートの `[PLAN_UPDATE]` 機構を廃止し、Claude Code ネイティブの Todo（TaskCreate/TaskUpdate）を使った軽量ワークフローを追加する。

### 背景

現在の `[PLAN_UPDATE]` は「タスク完了後のフックアクション」として誤った概念で実装されている。
本来の意図は、Manager が Todo リストで作業を管理し、Conductor に実行させること。

### 変更内容

#### 1. Manager テンプレート (`templates/manager.md`)

- `[PLAN_UPDATE]` 関連セクション（plan 機能、plan の形式、plan の永続化、plan の実行タイミング、§4.5）を削除
- 以下の Todo ワークフローを追加:

**Master からの TODO 追加:**
- Master が `[TODO] <内容>` メッセージを送信
- Manager は Claude Code の TaskCreate で自身の TODO リストに追加
- Conductor を `spawn-conductor.sh` で起動して実行
- 完了したら TaskUpdate で done にする

**TASK と TODO の違い:**
- TASK: `.team/tasks/open/` にファイル作成、draft → ready フロー、ユーザー承認あり。正式な開発作業向け
- TODO: ファイル不要、Manager の Claude Code セッション内で TaskCreate/TaskUpdate で管理、即時実行。軽微な作業向け

#### 2. Master プロンプト (`master.md` テンプレートおよび `.team/prompts/master.md`)

- `[PLAN_UPDATE]` の送信手順を削除
- `[TODO]` メッセージの送信手順を追加:
  ```
  cmux send --surface ${MANAGER_SURFACE} "[TODO] git worktree prune で残存 worktree を整理して"
  ```

#### 3. `.team/plans/` ディレクトリ

- 不要になるが、既存ファイルは削除しない（後方互換）

## 対象ファイル

- `skills/cmux-team/templates/manager.md`
- `.team/prompts/manager.md`
- `.team/prompts/master.md`
- `commands/start.md`（Master テンプレート生成部分に [TODO] の記述があれば更新）

## 完了条件

- Manager テンプレートから `[PLAN_UPDATE]` が削除されていること
- `[TODO]` メッセージを受けて TaskCreate → Conductor 起動 → TaskUpdate のフローが記述されていること
- Master プロンプトに `[TODO]` の使い方が記載されていること
