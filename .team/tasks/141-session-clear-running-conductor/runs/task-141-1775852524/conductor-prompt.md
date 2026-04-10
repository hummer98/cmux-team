# タスク割り当て

## タスク内容

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


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-141-1775852524` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-141-1775852524
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-141-1775852524/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/141-session-clear-running-conductor/runs/task-141-1775852524
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/141-session-clear-running-conductor/runs/task-141-1775852524/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら、最後に:
```bash
cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
```
