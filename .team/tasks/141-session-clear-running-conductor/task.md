---
id: 141
title: SESSION_CLEAR で running Conductor のステータスをリセットする
priority: high
created_at: 2026-04-10T20:22:04.613Z
---

## タスク
## 問題

running 状態の Conductor に手動で `/clear` を送信しても、TUI 上でステータスがリセットされない。

`daemon.ts` L669-679 の `SESSION_CLEAR` ハンドラが `disconnected` / `starting` のみを対象とし、`running` を無視しているため。

## 調査結果

`assignTask()` が `/clear` を送信する時点（conductor.ts L362）では status はまだ `idle` であり、`running` に設定されるのは全処理完了後の L397。

したがって **`SESSION_CLEAR` 到着時に `status === "running"` なら、それは必ずユーザー手動の `/clear`** であり、Manager の `assignTask()` 由来ではない。`assigning` ステータスの追加は不要。

## 修正

`daemon.ts` の `SESSION_CLEAR` ハンドラ（L669-679）に `running` ケースを追加:

```typescript
case "SESSION_CLEAR": {
  const conductor = findConductor(state, message.surface);
  if (conductor && (conductor.status === "disconnected" || conductor.status === "starting")) {
    // 既存リカバリロジック（変更なし）
  }
  if (conductor && conductor.status === "running") {
    // ユーザー手動 /clear → タスク abort + idle リセット
    await handleConductorDone(state, conductor, /* success */ false);
  }
  break;
}
```

`handleConductorDone()` が既に abort 処理（タスク状態更新・worktree クリーンアップ・Conductor リセット）を担っているので、それを再利用する。journal に `user_clear` 等の理由を記録すること。

## 影響範囲

- `daemon.ts` の SESSION_CLEAR ハンドラ **1箇所のみ**
- 型定義・ダッシュボード・監視ロジックの変更は不要
