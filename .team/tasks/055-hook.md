---
id: 055
title: ステートファイルを統一し hook で保護する
priority: high
created_at: 2026-04-03T07:58:11.318Z
---

## タスク
## 背景

現在の永続化ファイルがバラバラ:
- team.json — daemon が定期更新（conductor 情報含む）
- task-state.json — daemon + CLI が read-modify-write（ロックなし）
- .team/conductors/conductor.surface:* — マーカーファイル（conductor surface のリスト）

問題:
1. AI（Conductor/Agent）が team.json を直接 Edit/Write して壊す
2. daemon 再起動時に ConductorState（taskId, worktreePath 等）がメモリから失われる
3. task-state.json の concurrent write でデータ喪失の可能性
4. マーカーファイルと team.json で情報が重複

## ゴール

永続化を 2 ファイルに整理し、hook で AI からの直接編集をブロックする。

## 設計

### ファイル構成（2 ファイル）

| ファイル | 書き込み元 | 内容 |
|---------|-----------|------|
| team.json | daemon のみ | master/manager/conductor state（taskId, worktreePath, agents 含む） |
| task-state.json | daemon + CLI | タスク状態（draft/ready/assigned/closed） |

### 廃止

- .team/conductors/conductor.surface:* マーカーファイル — conductor surface は team.json で管理、生存確認は cmux tree で行う

### 保護（hook）

plugin.json の PreToolUse hook で team.json, task-state.json への Write/Edit をブロック:
- AI セッションからの直接編集を禁止
- daemon（TypeScript プロセス）は hook の影響を受けない
- CLI コマンド（create-task, update-task, close-task）経由の書き込みは許可される

### アトミック書き込み

team.json は既に tmp → rename 方式。task-state.json の saveTaskState() も同様に tmp → rename に変更する。

## 実装タスク

### 1. plugin.json に PreToolUse hook 追加
- Write/Edit ツールで team.json, task-state.json を対象とした場合にブロック
- ブロックメッセージで CLI コマンド使用を案内

### 2. daemon 再起動時の ConductorState 復元
- initializeLayout() で team.json の conductors 配列を読み込む
- 各 conductor を cmux.validateSurface() で生存確認
- 生存する conductor は taskId, taskRunId, worktreePath 等を復元して ConductorState を再構築
- 全滅の場合のみ新規スロット作成

### 3. マーカーファイル廃止
- conductor.ts の initializeConductorSlots() からマーカーファイル作成を削除
- daemon.ts の initializeLayout() からマーカーファイル読み取りを削除
- .gitignore の conductors/ 行はディレクトリ自体を削除

### 4. task-state.json のアトミック書き込み
- saveTaskState() を tmp → rename 方式に変更

## 注意

- team.json の conductors 配列の構造は現状のまま（schema.ts の ConductorState と一致）
- Conductor テンプレート（conductor-role.md 等）に team.json を直接編集しないよう注記があるか確認し、なければ追加
