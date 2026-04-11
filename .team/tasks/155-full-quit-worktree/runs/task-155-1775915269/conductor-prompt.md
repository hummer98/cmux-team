# タスク割り当て

## タスク内容

---
id: 155
title: full_quit から worktree 削除を撤廃する
priority: high
created_at: 2026-04-11T13:47:49.105Z
---

## タスク
## 背景

full_quit（cmux-team stop）の worktree クリーンアップ（main.ts:342-357）が assigned タスクの worktree も無条件に削除しており、再起動時の resume が失敗する原因になっている（Dear T108 で発生）。

そもそも full_quit は「チーム体制の停止」であり「作業の破棄」ではない。worktree のクリーンアップは Conductor がタスク完了時に行う責務であり、full_quit で重複して行う意味がない。

## やること

- main.ts の full_quit ハンドラ内の worktree クリーンアップブロック（342-357行付近）を削除する
  - `// 4. worktree をクリーンアップ` コメントから始まるブロック全体
  - git worktree remove と git branch -d の処理

## やらないこと

- resume ロジック自体の変更（それは別の問題）
- Conductor 側の worktree クリーンアップの変更（正常動作している）

## 補足: ログ改善

resume_fallback_to_ready のログに詳細情報を追加する:
- sessionId の有無
- worktreePath の値
- existsSync の結果

現状は reason が no_session_id or no_worktree の二択だが、worktreePath が何だったかが分からない。以下のようにする:

```
resume_fallback_to_ready task_id=108 reason=no_worktree worktreePath=/path/to/worktree sessionId=present taskRunId=task-108-xxx
```



## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-155-1775915269` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-155-1775915269
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-155-1775915269/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/155-full-quit-worktree/runs/task-155-1775915269
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/155-full-quit-worktree/runs/task-155-1775915269/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら、最後に:
```bash
cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
```
