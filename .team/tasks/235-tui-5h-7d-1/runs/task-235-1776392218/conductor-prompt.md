# タスク割り当て

## タスク内容

---
id: 235
title: TUI ヘッダー 5h/7d の間にスペース 1 つ分の間隔を開ける
priority: low
created_at: 2026-04-17T02:16:58.931Z
---

## タスク
## 目的

TUI ダッシュボードのヘッダーで、`5h` と `7d` の表示が隣接しているため視認性が悪い。両者の間にスペース 1 つ分の間隔を開けてほしい。

## 対象

`skills/cmux-team/manager/dashboard.tsx` のヘッダー描画箇所（`5h` / `7d` のラベルまたは件数表示が並んでいる部分）。

## 実装方針

- `5h` と `7d` の間に半角スペース 1 つを追加するだけの軽微な表示調整
- 他のヘッダー要素との間隔（既存の区切り方）とバランスが取れるよう配慮
- 幅が狭いターミナルで折り返しや崩れが起きないか確認

## 検証

- `cmux-team start` で daemon を起動して TUI を確認し、`5h` と `7d` が 1 スペース分離れて表示されること


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-235-1776392218` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-235-1776392218
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-235-1776392218/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/235-tui-5h-7d-1/runs/task-235-1776392218
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/235-tui-5h-7d-1/runs/task-235-1776392218/summary.md` に書き出す。

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
