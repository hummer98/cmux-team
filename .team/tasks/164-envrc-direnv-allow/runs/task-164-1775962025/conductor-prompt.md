# タスク割り当て

## タスク内容

---
id: 164
title: 補足: .envrc 追記後に direnv allow を促すメッセージを表示
priority: medium
depends_on: [162]
created_at: 2026-04-12T02:35:05.971Z
---

## タスク
## 背景（T162 の補足）

T162 で `.envrc` に `CMUX_CLAUDE_HOOKS_DISABLED=1` を追記する機能を実装したが、追記しただけでは環境変数は現セッションに反映されない。ユーザーが明示的に以下のアクションを取る必要がある:

1. 現在の cmux セッションを exit
2. シェルで `direnv allow` を実行して .envrc を承認
3. `cmux-team start` を再実行

これを案内しないと、ユーザーは「追記したのに hooks が効いている」と混乱する。

## やること

T162 で `.envrc` への追記を行った直後（回答 Y の分岐）に、以下のメッセージを stdout に表示する:

\`\`\`
.envrc に CMUX_CLAUDE_HOOKS_DISABLED=1 を追記しました。
反映には以下の手順が必要です:

  1. 現在のセッションを exit
  2. シェルで: direnv allow
  3. cmux-team start を再実行

（direnv が未導入の場合は手動で source .envrc または環境変数設定が必要です）
\`\`\`

### 実装上の注意

- T162 内部で `direnv allow` を自動実行する想定（タスク本文より）だが、**現在起動中のシェルプロセスには direnv の変更は反映されない**。これは direnv の仕組み上避けられない
- よって「追記 + direnv allow」の後も「exit して再起動してください」のメッセージが必要
- direnv 未導入の場合のケースも案内する

## 完了条件

- T162 が完了しており、`.envrc` 追記成功時にユーザーに exit→direnv allow→再起動を促すメッセージが表示される
- direnv 未導入の場合は手動 source の案内も出る

## 依存

T162 の実装完了後に着手すること（自動的に assigned 待機）。


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-164-1775962025` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-164-1775962025
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-164-1775962025/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/164-envrc-direnv-allow/runs/task-164-1775962025
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/164-envrc-direnv-allow/runs/task-164-1775962025/summary.md` に書き出す。

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
