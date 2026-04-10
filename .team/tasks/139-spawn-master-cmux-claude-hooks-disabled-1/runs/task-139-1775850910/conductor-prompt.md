# タスク割り当て

## タスク内容

---
id: 139
title: spawn-master に CMUX_CLAUDE_HOOKS_DISABLED=1 を追加
priority: high
created_at: 2026-04-10T19:55:10.654Z
---

## タスク
## 問題

`cmdLaunchMaster()` (main.ts L1006) で `CMUX_CLAUDE_HOOKS_DISABLED=1` が設定されていないため、Master の claude プロセスが cmux ラッパー経由で起動された際に Notification hooks が注入され、cmux 通知がバンバン飛ぶ。

Conductor（L886）、resume（L970）、spawn-agent（L1117）には設定済みだが、spawn-master だけ漏れている。

## 修正

main.ts の `cmdLaunchMaster()` 内、L1014 の後に1行追加:

```typescript
process.env.CMUX_CLAUDE_HOOKS_DISABLED = "1";
```

他の起動コマンド（conductor, resume, spawn-agent）と同じパターンに揃える。


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-139-1775850910` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-139-1775850910
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-139-1775850910/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/139-spawn-master-cmux-claude-hooks-disabled-1/runs/task-139-1775850910
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/139-spawn-master-cmux-claude-hooks-disabled-1/runs/task-139-1775850910/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら、最後に:
```bash
cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
```
