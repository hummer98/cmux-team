# Plan: SESSION_CLEAR で running Conductor のステータスをリセットする

## 概要

`daemon.ts` の `SESSION_CLEAR` ハンドラに `running` 状態の Conductor への対応を追加する。
ユーザーが手動で `/clear` を送信した場合、タスクを abort してConductor を idle にリセットする。

## 背景

- `assignTask()` が `/clear` を送信する時点では status は `idle` であり、`running` に設定されるのは全処理完了後
- したがって SESSION_CLEAR 到着時に `status === "running"` なら、それは必ずユーザー手動の `/clear`
- 既存の `forceCloseDisconnectedConductor()` が同様の abort パターンを実装済み

## 修正内容

### 変更ファイル: `skills/cmux-team/manager/daemon.ts`

**変更箇所: L669-679 の SESSION_CLEAR ハンドラ**

現在のコード:
```typescript
case "SESSION_CLEAR": {
  const conductor = findConductor(state, message.surface);
  if (conductor && (conductor.status === "disconnected" || conductor.status === "starting")) {
    // 既存リカバリロジック
  }
  // idle/running 時は何もしない（TUI チラつき防止）
  break;
}
```

修正後:
```typescript
case "SESSION_CLEAR": {
  const conductor = findConductor(state, message.surface);
  if (conductor && (conductor.status === "disconnected" || conductor.status === "starting")) {
    // 既存リカバリロジック（変更なし）
  }
  if (conductor && conductor.status === "running") {
    // ユーザー手動 /clear → タスク abort + idle リセット
    // forceCloseDisconnectedConductor と同パターン
    const taskId = conductor.taskId;
    if (taskId) {
      const ts = await loadTaskState(state.projectRoot);
      const current = ts[taskId];
      if (current?.status !== "closed" && current?.status !== "aborted" && current?.status !== "deleted") {
        const journal = `user_clear: surface=${conductor.surface} taskRunId=${conductor.taskRunId ?? "-"}`;
        ts[taskId] = { ...current, status: "aborted", abortedAt: new Date().toISOString(), journal };
        await saveTaskState(state.projectRoot, ts);
        await log("task_aborted", `task_id=${taskId} reason=user_clear`);
      }
    }
    if (conductor.pidWatcherInterval) {
      clearInterval(conductor.pidWatcherInterval);
      conductor.pidWatcherInterval = undefined;
    }
    await resetConductor(conductor, state.projectRoot);
  }
  // idle 時は何もしない（TUI チラつき防止）
  break;
}
```

### 変更しないもの

- 型定義（ConductorState, DaemonState）
- ダッシュボード（dashboard.tsx）
- 監視ロジック（monitorConductors）
- テストファイル（daemon.test.ts に SESSION_CLEAR テストは現在なし）

## 実装ポイント

1. `forceCloseDisconnectedConductor` のパターンを再利用（task-state abort + pidWatcher clear + resetConductor）
2. journal に `user_clear` を記録（disconnect_timeout と区別可能にする）
3. コメントの `// idle/running 時は何もしない` を `// idle 時は何もしない` に更新
4. 既存の `disconnected`/`starting` ハンドリングは一切変更しない

## 完了条件

- `bun run typecheck` が通ること
- SESSION_CLEAR ハンドラが running 状態の Conductor を abort + idle リセットすること
