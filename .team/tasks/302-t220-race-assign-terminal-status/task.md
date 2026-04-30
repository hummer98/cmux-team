---
id: 302
title: T220 race 修正: assign 完了書き込み時に terminal status を尊重する（暫定ガード）
priority: high
created_at: 2026-04-23T01:45:00.791Z
---

## タスク
## 背景

~/git/Dear で T220 を delete した直後に Conductor への assign が走り、`task-state.json` の status が `deleted → assigned → aborted` と上書きされた事象が発生（2026-04-23 09:53 のログ参照）。`deletedAt` がセットされているのに `status: "aborted"` のまま残り、TUI の Tasks リストから消えない不整合状態になった。

## 原因

`skills/cmux-team/manager/daemon.ts:2698-2709`（scanTasks の assign 完了書き込み）が、現 status を一切確認せずに `status: 'assigned'` をスプレッド上書きしている：

```ts
const ts = await loadTaskState(state.projectRoot);
ts[task.id] = {
  ...ts[task.id],          // ← 既存スプレッド
  status: 'assigned',      // ← deleted/aborted/closed を無条件上書き
  assignedAt: new Date().toISOString(),
  worktreePath: updated.worktreePath,
  taskRunId: updated.taskRunId,
  conductorSlot: updated.surface,
  sessionId: updated.sessionId,
};
await saveTaskState(state.projectRoot, ts);
```

`assignTask` は worktree 作成 → /clear → プロンプト送信 と複数の非同期 I/O を含むため、その途中で `delete-task`（main.ts:3964）が割り込むと race が発生する。`delete-task` 側の「assigned なら拒否」ガードもこの時点では status=ready のまま通過してしまう。

## 修正内容

**暫定ガード（最小修正）**: `daemon.ts:2698` の書き込み直前に、現 status を確認して terminal（`deleted` / `aborted` / `closed`）なら：

1. `task-state.json` への書き込みをスキップ
2. 作成済みの worktree / branch を cleanup（`git worktree remove --force` + `git branch -D`）
3. Conductor を `assigning` から `idle` にリセット（既に送った `/clear` + プロンプトが空セッションを開始するだけで済む）
4. ログ: `assign_skipped_terminal task_id=<id> current_status=<s>`

`task.ts` の `isTerminalStatus` がそのまま使える。

**位置付け**: 構造的解決は T303（reducer 置換）で行うが、それまでの間 race を塞ぐ安全網。reducer 置換完了時に削除予定。

## 対象ファイル

- `skills/cmux-team/manager/daemon.ts` (L2698-2709 周辺)
- 単体テスト: 既存 `daemon.test.ts` に「terminal status の上書きを skip」ケースを追加

## 受け入れ条件

- 既存 bun test pass
- 新規テスト: assign 完了直前に task-state を `deleted` に書き換えた状態で `scanTasks` が assign 書き込みを skip し、worktree が cleanup されることを確認
