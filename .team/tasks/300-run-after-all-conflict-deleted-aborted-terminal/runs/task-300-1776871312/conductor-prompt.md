# タスク割り当て

## タスク内容

---
id: 300
title: run_after_all conflict チェックが deleted/aborted を terminal として扱っていない
priority: medium
created_at: 2026-04-22T15:21:52.370Z
---

## タスク
## 現象

deleted な `--run-after-all` タスクが存在するとき、新規 `--run-after-all` タスクの作成が `RUN_AFTER_ALL_CONFLICT` で拒否される。aborted も同様と見られる。

## 原因

`skills/cmux-team/manager/task.ts:783-798` の競合チェックが `t.status !== "closed"` のみで terminal 判定している。`scanTasks`（`daemon.ts:2507,2511`）側は `closed | aborted | deleted` の 3 つを terminal 扱いしているため、この 1 箇所だけ規則がずれている。

```ts
// 現状（task.ts:788）
const conflict = tasks.find(
  (t) =>
    t.runAfterAll &&
    t.status !== "closed" &&
    !(exclusive && t.exclusive),
);
```

## 修正方針

terminal 判定をスキャン側に揃える。`aborted` と `deleted` も除外する:

```ts
const conflict = tasks.find(
  (t) =>
    t.runAfterAll &&
    t.status !== "closed" &&
    t.status !== "aborted" &&
    t.status !== "deleted" &&
    !(exclusive && t.exclusive),
);
```

可能なら `isTerminalStatus(status)` のようなヘルパを切り出し、`scanTasks` の `closed` Set 構築（daemon.ts:2505-2509）と `openTasksList` フィルタ（daemon.ts:2511）と conflict チェック（task.ts:788）で共有し、terminal 状態の規則が 3 箇所でずれないようにする。

## 対象ファイル

- `skills/cmux-team/manager/task.ts`（conflict チェック本体）
- `skills/cmux-team/manager/daemon.ts`（ヘルパ共有する場合）
- `skills/cmux-team/manager/task.test.ts`（deleted/aborted run_after_all が conflict にならないテスト追加）

## 確認手順

1. deleted な run_after_all タスクがある状態で、新規 run_after_all タスクが作成できること
2. aborted な run_after_all タスクがある状態で、新規 run_after_all タスクが作成できること
3. 既存テスト（ready/assigned な run_after_all がある場合は従来通り conflict）が引き続き通ること


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-300-1776871312` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-300-1776871312
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-300-1776871312/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/300-run-after-all-conflict-deleted-aborted-terminal/runs/task-300-1776871312
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/300-run-after-all-conflict-deleted-aborted-terminal/runs/task-300-1776871312/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
