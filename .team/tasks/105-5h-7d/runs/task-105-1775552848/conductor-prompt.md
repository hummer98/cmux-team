# タスク割り当て

## タスク内容

---
id: 105
title: ダッシュボード 5h/7d レート表示の色を個別化しダークカラーに変更
priority: medium
created_at: 2026-04-07T09:07:28.818Z
---

## タスク
## 概要

5h/7d のレート制限表示について2点修正:

### 1. 色の個別化
現在 5h と 7d が同じ色で表示されている。問題がある方（utilization が高い方）だけ警告色にし、もう一方は通常色のままにする。

例:
- 5h: 18%（通常色）  7d: 85%（警告色）
- 5h: 92%（警告色）  7d: 30%（通常色）

それぞれ独立して閾値判定すること。

### 2. ダークカラー化
現在の色がどぎつい（明るすぎる）。ダークトーンに変更する。
- 通常: ダークグリーン系
- 警告（>70%）: ダークイエロー/アンバー系
- 危険（>90%）: ダークレッド系

rgb() で指定できるはずなので適切なダークカラーを選定すること。

## 対象ファイル

- skills/cmux-team/manager/dashboard.tsx（buildRateLimitDisplay 付近）


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-105-1775552848` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-105-1775552848
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-105-1775552848/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/105-5h-7d/runs/task-105-1775552848
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/105-5h-7d/runs/task-105-1775552848/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら、最後に:
```bash
cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
```
