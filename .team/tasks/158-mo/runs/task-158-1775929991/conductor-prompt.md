# タスク割り当て

## タスク内容

---
id: 158
title: mo ビューアで既存ブラウザを再利用する
priority: medium
depends_on: [157]
created_at: 2026-04-11T17:53:11.423Z
---

## タスク
## 背景

TUI から mo でファイルを開くたびに `cmux browser open` で新しいブラウザ split が作られてしまう。同一ワークスペース内に既にブラウザが開いていれば、そこに navigate するだけでよい。

## やること

`dashboard.tsx` の `openArtifactInViewer` 関数で:

1. ワークスペース内にブラウザ surface が存在するか確認（`cmux tree` や `cmux browser identify` 等で検出）
2. 既存ブラウザあり → `cmux browser <surface> goto <url>` で URL を変更（split 不要）
3. 既存ブラウザなし → 従来通り `cmux browser open <url>` で新規作成

## 参考

- `cmux browser open` — 新規ブラウザを開く
- `cmux browser <surface> goto <url>` — 既存ブラウザの URL を変更
- T157 で `?file=<id>` 付き URL の取得が実装される前提（depends-on 157）


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-158-1775929991` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-158-1775929991
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-158-1775929991/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/158-mo/runs/task-158-1775929991
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/158-mo/runs/task-158-1775929991/summary.md` に書き出す。

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
