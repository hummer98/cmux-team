# タスク割り当て

## タスク内容

---
id: 157
title: mo ビューアでファイル指定URLを使い直接フォーカスする
priority: medium
created_at: 2026-04-11T17:33:54.413Z
---

## タスク
## 背景

TUI の Tasks パネルで Enter を押して mo で Markdown を開くと、ファイルリストの一番上が表示されてしまい、対象ファイルにフォーカスが当たらない。

## 原因

dashboard.tsx:756-758 で mo 起動後に `http://localhost:6275` を固定で開いているため。

## 修正方法

`mo file.md --json` の出力に `?file=<id>` 付きの URL が含まれる:

```json
{
  "files": [{"url": "http://localhost:6275/?file=fc461902", ...}]
}
```

この URL を `cmux browser open` に渡せば対象ファイルが直接表示される。

## 修正箇所

`skills/cmux-team/manager/dashboard.tsx` の `openArtifactInViewer` 関数（754-759行付近）:

- `Bun.spawn(["mo", filePath])` → `Bun.spawn(["mo", filePath, "--json"], { stdout: "pipe" })`
- stdout から JSON をパースし `files[0].url` を取得
- `cmux browser open` にそのファイル固有 URL を渡す
- JSON パース失敗時は既存のフォールバック（`http://localhost:6275`）を使う


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-157-1775928834` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-157-1775928834
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-157-1775928834/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/157-mo-url/runs/task-157-1775928834
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/157-mo-url/runs/task-157-1775928834/summary.md` に書き出す。

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
