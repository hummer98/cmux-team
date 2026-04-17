# タスク割り当て

## タスク内容

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


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-217-1776294106` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-217-1776294106
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-217-1776294106/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/217-cmux-team-trace-hook-signals/runs/task-217-1776294106
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/217-cmux-team-trace-hook-signals/runs/task-217-1776294106/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら:

1. セッション上に完了レポートを表示する（conductor-role.md「完了時の処理」ステップ 8 参照。設計判断・試行錯誤・自己判断・懸念・成果の勘所を簡潔に出力）
2. 完了通知を送信する:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
   ```
