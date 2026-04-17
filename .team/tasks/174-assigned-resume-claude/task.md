---
id: 174
title: assigned タスクの resume がシェルではなく Claude 入力に送られる問題を修正
priority: high
created_at: 2026-04-12T09:53:20.225Z
---

## タスク
## 問題

daemon 再起動時の assigned タスク resume において、`cmux-team resume <task-id>` コマンドが Conductor ペインのシェルで実行されず、既に起動済みの Claude セッションのチャット入力として送信されてしまう。

## 再現シーケンス

1. `cmux-team start` の boot フローで:
   - `initializeLayout` (daemon.ts:373) → `initializeConductorSlots` → `launchConductor` (conductor.ts:77)
   - launchConductor 内で `cmux send <surface> 'cmux-team conductor\n'` を実行し Claude セッションを起動 (conductor.ts:112)
2. その後 main.ts:414-473 で assigned タスクの resume 処理:
   - `cmux send <surface> 'export CMUX_SURFACE=...\n'` (main.ts:469)
   - `cmux send <surface> 'cmux-team resume <task-id>\n'` (main.ts:471)
3. この時点で Conductor ペインは Claude 起動済みなので、シェルコマンドではなく Claude のプロンプト入力に文字列が送られる

## 影響

- daemon 再起動時に assigned タスクが正しく resume されない
- Conductor の Claude に `cmux-team resume 169` のようなテキストが入力されるだけで、claude --resume によるセッション再開が行われない

## 修正方針

assigned タスクを boot シーケンスで先に判別し、該当 Conductor pane には最初から `cmux-team conductor` ではなく `cmux-team resume <task-id>` を送信する構造に変更する。

具体的には以下のいずれかを検討:

### 案 A: launchConductor に resume モードを追加

- `launchConductor(projectRoot, surface, paneId, opts?: { resumeTaskId?: string })` にオプションを追加
- resumeTaskId がある場合は `cmux-team conductor\n` の代わりに `cmux-team resume <task-id>\n` を送信
- main.ts の boot 順序を変更: initializeLayout の前に assigned タスクをロードし、Conductor スロットごとに resume 割当を決めてから起動

### 案 B: initializeConductorSlots にタスク割当を渡す

- スロット作成時に「この surface には task N を resume」と指示できる構造にする
- launchConductor はその割当に従って分岐

### 共通事項

- main.ts:414-473 の resume ブロック（既に Claude が起動した後に送信する方式）は削除する
- resume 情報（sessionId/worktreePath/taskRunId）が揃っているかのチェックは launch 前に行う
- resume 不可な場合は ready に戻す処理は維持

## 検証方法

1. タスクを1つ ready → assigned まで進める
2. daemon を `cmux-team stop` で落とす（assigned 状態のまま）
3. `cmux-team start` で再起動
4. 該当 Conductor ペインでシェル上 `cmux-team resume <task-id>` が実行され、Claude セッションが --resume で復元されることを確認
5. manager.log の `task_resumed` イベントの後、セッションが正常に動作していること

## 関連ファイル

- skills/cmux-team/manager/main.ts:414-473 (resume 送信ロジック)
- skills/cmux-team/manager/main.ts:915-982 (cmdResume 本体)
- skills/cmux-team/manager/conductor.ts:77-117 (launchConductor)
- skills/cmux-team/manager/daemon.ts:373-426 (initializeLayout)
