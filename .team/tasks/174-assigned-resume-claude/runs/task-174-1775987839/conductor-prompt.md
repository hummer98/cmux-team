# タスク割り当て

## タスク内容

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


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-174-1775987839` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-174-1775987839
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-174-1775987839/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/174-assigned-resume-claude/runs/task-174-1775987839
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/174-assigned-resume-claude/runs/task-174-1775987839/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら:

1. セッション上に完了レポートを表示する（conductor-role.md「完了時の処理」ステップ 8 参照。設計判断・試行錯誤・自己判断・懸念・成果の勘所を簡潔に出力）
2. 完了通知を送信する:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
   ```
