# タスク割り当て

## タスク内容

---
id: 106
title: close-task に CONDUCTOR_DONE メッセージ送信を追加
priority: high
created_at: 2026-04-07T09:17:45.064Z
---

## タスク
## バグ概要

`cmux-team close-task` 実行後、Manager に CONDUCTOR_DONE メッセージが送信されないため、Conductor が running のまま stuck する。

KDG-SHOWCASE プロジェクトで実際に発生。T004 が closed なのに Conductor-1 が running のまま解放されなかった。

## 原因

`cmdCloseTask()`（main.ts:1389-1436）に CONDUCTOR_DONE メッセージ送信が欠落している。
`cmdAbortTask()` には実装されている（main.ts:1536-1543）のに close-task にはない。

## 修正内容

`cmdCloseTask()` の `saveTaskState` 後に CONDUCTOR_DONE メッセージを送信する。abort-task の実装（L1536-1543）を参考に:

```typescript
// close-task 完了時に daemon へ通知
await postMessage({
  type: 'CONDUCTOR_DONE',
  surface: conductor.surface,
  success: true,
  timestamp: new Date().toISOString(),
});
```

Conductor surface の特定は team.json から taskId で逆引きする（abort-task と同様のロジック）。

## 対象ファイル

- skills/cmux-team/manager/main.ts（cmdCloseTask 関数）


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-106-1775553465` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-106-1775553465
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-106-1775553465/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/106-close-task-conductor-done/runs/task-106-1775553465
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/106-close-task-conductor-done/runs/task-106-1775553465/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら、最後に:
```bash
cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
```
