# タスク割り当て

## タスク内容

---
id: 218
title: cmux-team-investigate スキルにhookシグナル追跡手段を明記
priority: medium
created_at: 2026-04-15T17:42:57.389Z
depends_on: [217]
---

## タスク
## 背景
T216/T217 で trace DB の hook_signals テーブルと cmux-team trace-hooks コマンドが追加される。
調査用スキル（cmux-team-investigate）にこの追跡手段を記載する。

## やること
- .claude/skills/cmux-team-investigate/SKILL.md を更新
- 追記内容:
  - hook_signals テーブルの存在と用途
  - `cmux-team trace-hooks` コマンドでのhookシグナル追跡方法
  - 「どのhookが実際に発火したか」を調べる手順

## 依存
T217（trace-hooks コマンド追加）


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-218-1776295267` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-218-1776295267
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-218-1776295267/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/218-cmux-team-investigate-hook/runs/task-218-1776295267
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/218-cmux-team-investigate-hook/runs/task-218-1776295267/summary.md` に書き出す。

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
