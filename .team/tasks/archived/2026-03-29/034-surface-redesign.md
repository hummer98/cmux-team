---
id: 034
title: "Surface管理の一新: 固定2x2レイアウト + タブベースサブエージェント"
priority: high
status: ready
created: 2026-03-29
---

## 概要

cmux-team の surface 管理を根本的に再設計する。

## 現状の問題
- Conductor / Agent は動的にペインを split して生成・close する
- surface 数が増減し管理が複雑

## 新設計

### 起動時の固定レイアウト（2x2）
- 左上ペインを split: Manager（TypeScript daemon）| Master（ユーザーセッション）
- 右上: Conductor-1（常駐 Claude セッション）
- 左下: Conductor-2（常駐 Claude セッション）
- 右下: Conductor-3（常駐 Claude セッション）
- この4ペイン（5 surface）は不動で close しない

### サブエージェントのタブ化
- Conductor がサブエージェントを呼び出す際、ペイン split ではなく Conductor のペインに新規タブとして surface を作成
- サブエージェント完了後もタブは Conductor が管理

### 同時実行制限
- Conductor が3つなので最大3タスク並列
- 4つ目以降のタスクは空き Conductor が出るまでキューイング（Manager が管理）

### タスク切替時のリセット
- 新しい task/todo を Conductor に割り当てる際:
  1. サブエージェントタブがあれば close
  2. Conductor の surface に `/clear` を送信
  3. 新しいタスクのプロンプトを送信

### タスク完了処理の責務移譲

現状 Manager が画面スクレイピングで Conductor の完了を検知し、タスクファイルを closed に移動している。
これを Conductor の責務に移譲する:

- **Conductor**: タスク完了時に自らファイルを `closed/` に移動（worktree 削除と同様）
- **Manager**: `closed/` の状態を監視して完了を検知（pull 型維持）
- **Manager**: Conductor のクラッシュ検知は引き続き Manager の責務（surface 消失で判定）

理由:
- 画面スクレイピングによる完了判定は不安定（interrupt を completed と誤判定する既知バグ）
- ファイル移動は決定論的操作であり、AI のセマンティック報告とは異なる
- worktree 削除と責務を揃える

## 影響範囲
- skills/cmux-team/SKILL.md（アーキテクチャ定義）
- skills/cmux-team/templates/（Manager, Conductor テンプレート）
- commands/start.md（起動コマンド）
- .team/scripts/spawn-team.sh（チーム起動スクリプト）
- .team/scripts/spawn-conductor.sh（Conductor 起動スクリプト）
- skills/cmux-team/manager/conductor.ts（完了判定・タスク移動ロジック）
- skills/cmux-team/manager/daemon.ts（monitorConductors の簡素化）

## Journal

- summary: 固定2x2レイアウト+タブベースサブエージェント管理に全面再設計。conductor.ts/daemon.ts/cmux.ts/schema.ts/main.ts/template.ts/SKILL.md/テンプレート/コマンドを更新。
- files_changed: 12
