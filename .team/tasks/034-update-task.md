---
id: 034
title: update-task にタスクライフサイクルガードを追加
priority: high
created_at: 2026-03-31T15:18:09.783Z
---

## タスク
## 背景

update-task は task-state.json の status を無条件に書き換える。実行中（assigned）のタスクの status や body を変更できてしまい、Conductor が作業中のタスク定義が変わるカオスが発生した。

## やること

### 1. update-task のステータス遷移ガード

cmdUpdateTask() に以下の検証を追加:

| 現在の status | 許可される変更 | 拒否すべき変更 |
|--------------|---------------|---------------|
| draft | ready に変更、body/title 更新 | — |
| ready（未 assign） | draft に戻す、body/title 更新 | — |
| assigned / running | **すべて拒否**（エラーメッセージで案内） | status 変更、body 更新 |
| closed | **すべて拒否** | 再 open（新タスクを作るべき） |

assigned かどうかは task-state.json の status フィールドで判定する。

### 2. --body / --title オプションの追加

現在 update-task は --status しか受け付けない。draft/ready 状態のタスクに限り body と title を更新できるようにする:

- --body: タスクファイルの frontmatter 以降を置換
- --title: frontmatter の title フィールドを更新

### 3. close-task のガード

assigned 状態のタスクを close する場合は --force フラグを要求する。通常の完了フロー（Conductor → close-task）では task-state.json が assigned のまま close されるため、Conductor からの close は許可する必要がある点に注意。

### 4. エラーメッセージ

拒否時のメッセージ例:
- 'Error: task 032 is assigned (running). Cannot update a running task. Create a new task instead.'
- 'Error: task 032 is closed. Cannot reopen a closed task. Use create-task to create a new one.'

## 対象ファイル

- skills/cmux-team/manager/main.ts（cmdUpdateTask, cmdCloseTask）
- テスト追加: skills/cmux-team/manager/daemon.test.ts または新規テストファイル

## 関連

- .claude/settings.json の PreToolUse hook（.team/tasks/ への Write/Edit ブロック）は防御の別レイヤー
- master.md テンプレートの禁止記述も別レイヤー
