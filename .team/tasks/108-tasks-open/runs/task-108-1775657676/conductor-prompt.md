# タスク割り当て

## タスク内容

---
id: 108
title: ダッシュボード Tasks の並び順を修正: open上位 + 新しい順
priority: high
created_at: 2026-04-08T14:14:36.219Z
---

## タスク
## バグ概要

Tasks の並び順が期待と異なる。ready タスクが上に来ない。

## 現状

open タスク（draft/ready/assigned）を priority 順でソートしているのみ。同一 priority 内の順序は不定。

## 期待する並び順

1. **open タスク**（status が closed/aborted でないもの）が上
   - open 内は **created_at の降順**（新しいものが上）
2. **closed タスク**が下
   - closed 内は **closedAt の降順**（最近閉じたものが上）← 現状通り

priority によるソートは廃止し、作成日時の新しい順にする。

## 修正箇所

- skills/cmux-team/manager/daemon.ts（L598-605 付近）

```typescript
// 修正後
const openTasks = [...openTasksList]
  .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
```

## テスト

daemon.test.ts に taskList の並び順テストを追加すること。


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-108-1775657676` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-108-1775657676
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-108-1775657676/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/108-tasks-open/runs/task-108-1775657676
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/108-tasks-open/runs/task-108-1775657676/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら、最後に:
```bash
cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
```
