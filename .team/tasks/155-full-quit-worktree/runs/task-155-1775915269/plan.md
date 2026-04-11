# Plan: full_quit から worktree 削除を撤廃 + resume ログ改善

## 変更1: full_quit の worktree クリーンアップ削除

**対象ファイル**: `skills/cmux-team/manager/main.ts`
**対象行**: 342-357

削除するブロック:
```typescript
// 4. worktree をクリーンアップ
for (const [, conductor] of state.conductors) {
  if (conductor.worktreePath && existsSync(conductor.worktreePath)) {
    try {
      const { execFile: execFileCb } = require("child_process");
      const { promisify } = require("util");
      const execFileAsync = promisify(execFileCb);
      await execFileAsync("git", ["worktree", "remove", conductor.worktreePath, "--force"], { cwd: state.projectRoot });
      if (conductor.taskRunId) {
        await execFileAsync("git", ["branch", "-d", `${conductor.taskRunId}/task`], { cwd: state.projectRoot }).catch(() => {});
      }
    } catch (e: any) {
      await log("error", `worktree cleanup failed: path=${conductor.worktreePath} error=${e.message}`);
    }
  }
}
```

理由: full_quit は「チーム体制の停止」であり worktree のクリーンアップは Conductor の責務。assigned タスクの worktree を無条件削除すると再起動時の resume が失敗する。

## 変更2: resume_fallback_to_ready ログの詳細化

**対象ファイル**: `skills/cmux-team/manager/main.ts`
**対象行**: 443

現状:
```typescript
await log("resume_fallback_to_ready", `task_id=${taskId} reason=${!ts.sessionId ? "no_session_id" : "no_worktree"}`);
```

変更後:
```typescript
await log("resume_fallback_to_ready", `task_id=${taskId} reason=${!ts.sessionId ? "no_session_id" : "no_worktree"} worktreePath=${ts.worktreePath ?? "null"} sessionId=${ts.sessionId ? "present" : "absent"} taskRunId=${ts.taskRunId ?? "null"}`);
```

## 完了条件

- `bun build` が通ること（TypeScript エラーなし）
- full_quit ハンドラに worktree 関連コードがないこと
- resume ログに worktreePath, sessionId, taskRunId の情報が含まれること
