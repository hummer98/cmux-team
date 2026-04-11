# タスク割り当て

## タスク内容

---
id: 154
title: TUI の Enter キーで mo + cmux browser open による Markdown 表示
priority: medium
created_at: 2026-04-11T13:23:56.613Z
---

## タスク
## 背景

dashboard.tsx の `openArtifactInViewer` は TUI を停止して同じ TTY 上で `mo` をフォアグラウンド実行している。`mo` はブラウザベースのビューアでサーバー起動後すぐプロセスが返るため、TUI が一瞬ちらついて即復帰するだけで実用にならない。

## やること

`openArtifactInViewer`（dashboard.tsx L746-783）を以下に書き換え:

1. **TUI を停止しない**（`app.stop()` / `app.start()` を削除）
2. `mo <filePath>` をバックグラウンドで実行（`Bun.spawn(["mo", filePath])`、await しない）
3. 少し待ってから `cmux browser open http://localhost:6275` で別 surface にブラウザペインを作成
4. `mo` が見つからない場合のフォールバックは `cmux browser open` を使わず、従来の `cat` フォールバックでよい

## 注意

- `mo` は既にサーバーが起動済みの場合、後続の `mo` 呼び出しはファイルを追加するだけ（同一ポート 6275）
- ブラウザ surface が既に存在する場合は `cmux browser navigate` で URL を更新するだけにする等の考慮があるとなおよい（ただし初期実装では毎回 open でも許容）
- `cmux markdown open` は mermaid 非対応なので使わないこと


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-154-1775913836` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-154-1775913836
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-154-1775913836/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/154-tui-enter-mo-cmux-browser-open-markdown/runs/task-154-1775913836
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/154-tui-enter-mo-cmux-browser-open-markdown/runs/task-154-1775913836/summary.md` に書き出す。

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
