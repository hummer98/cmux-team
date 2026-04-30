# タスク割り当て

## タスク内容

---
id: 314
title: cmux-team status の open カウントから aborted/deleted を除外
priority: medium
created_by: surface:969
created_at: 2026-04-24T20:02:34.640Z
---

## タスク
## 症状

`cmux-team status` の Tasks セクションが次のように表示される:

```
─ Tasks ───────────────────────────────────────────────────
  open: 9  closed: 298
```

しかし実稼働中のタスクは 0 件で、open にカウントされている 9 件はすべて過去にクラッシュした **aborted** / 統合された **deleted** の残骸タスク。UX として「進行中タスクがある」と誤認される。

## 原因

`skills/cmux-team/manager/main.ts:1361-1362`:

```ts
const closedCount = tasks.filter(t => t.status === "closed").length;
const openCount = tasks.length - closedCount;
```

`open = total - closed` という引き算で算出しているため、`aborted` / `deleted` が open に混入する。

## `TaskStatus` の 6 値（`state-machine/events.ts:17-23`）

| status | 分類 |
|--------|------|
| `draft` | **open**（未昇格） |
| `ready` | **open**（assignable） |
| `assigned` | **open**（進行中） |
| `closed` | closed |
| `aborted` | **それ以外**（中断済み） |
| `deleted` | **それ以外**（削除済み） |

## 修正方針

`cmdStatus` の集計を明示的な allowlist に変更する:

```ts
const OPEN_STATUSES = new Set<string>(["draft", "ready", "assigned"]);
const openCount = tasks.filter(t => OPEN_STATUSES.has(t.status)).length;
const closedCount = tasks.filter(t => t.status === "closed").length;
const abortedCount = tasks.filter(t => t.status === "aborted").length;
// deleted は通常非表示でよい
```

表示フォーマット案（aborted が 0 件なら省略）:

```
─ Tasks ───────────────────────────────────────────────────
  open: 0  closed: 298  aborted: 7
```

または:

```
─ Tasks ───────────────────────────────────────────────────
  open: 0  closed: 298
  (aborted: 7 historical)
```

どちらが読みやすいかは Conductor の判断でよい。重要なのは **open が進行中 (draft/ready/assigned) のみをカウントする**こと。

## 変更対象

- `skills/cmux-team/manager/main.ts` の `cmdStatus()` L1358-1364 付近
- `TaskStatus` の import が必要なら `state-machine/events.ts` から追加（文字列リテラルの Set でも可）

## 受け入れ条件

- `cmux-team status` で aborted / deleted が open にカウントされない
- 実稼働タスク 0 件のときに `open: 0` と表示される
- aborted 件数が 0 のときに余計な行が出ない（0 表示は許容、ただし冗長にしない）
- 既存 closed カウントは従来通り
- `bun test` / typecheck 通過

## 補足

- ゴミ掃除機能（aborted の自動アーカイブ等）は**別タスク**。ここではカウント表示の修正に限定する
- tasks-tab（dashboard）側の集計で同じ問題がないかは別途確認（スコープ外）


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-314-1777060954` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-314-1777060954
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-314-1777060954/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/314-cmux-team-status-open-aborted-deleted/runs/task-314-1777060954
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/314-cmux-team-status-open-aborted-deleted/runs/task-314-1777060954/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
