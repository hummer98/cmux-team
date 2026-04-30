# T398 — 実装による変更ファイル一覧

worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-398-1777552095`

## 変更ファイル

| ファイル | 種別 | 変更内容 | 追加 / 削除 行 |
|----------|------|----------|----------------|
| `skills/cmux-team/manager/daemon.ts` | modified | `scanTasks` の Exclusive lock guard 直後に `run_after_all lock guard` を挿入。`dispatchTargets` 切替方式 (採用案 ii)。`for (const task of allExecutable)` を `for (const task of dispatchTargets)` に変更。log event: `run_after_all_lock_active task_ids=<csv> pending_normal=<n>` | +21 / -1 |
| `skills/cmux-team/manager/daemon-run-after-all-lock.test.ts` | new | TC1〜TC5 (T398 lock guard の単体/統合テスト)。`createTask` ヘルパーは新ファイルに自前コピー（循環依存・export 拡大を避ける） | +287 / -0 |
| `docs/spec/07-state-machine.md` | modified | 新節 `## 5. dispatch ガード (run_after_all / exclusive)` を `## 5. 段階計画` の前に挿入。既存 §5 を §6 にリナンバリング (`### 5.1 T302 脚注` → `### 6.1 T302 脚注`)。新節は §5.1 throttle / §5.2 Exclusive lock / §5.3 run_after_all lock / §5.4 各 flag semantics 比較 を含む | +50 / -2 |
| `CLAUDE.md` | modified | タスク属性表 `run_after_all: true` 行に「assigned 中は normal の新規 assignment を停止するが、他の `run_after_all` とは並走可」を追記 | +1 / -1 |

> 補足: `package-lock.json` も `git status` 上は M だが、これは worktree 起動時点で既に変更済みであり本タスクの touch ではない。

## 実装方針メモ

- 採用案 (ii) `dispatchTargets` 切替: `executable.length > 0 && assignedRunAfterAllTaskIds.size > 0` のとき `dispatchTargets = runAfterAllExecutable` に絞り込み、normal を抑止しつつ他の RAA は並走させる。
- defense-in-depth として `!t.exclusive` フィルタ付き。exclusive guard が先に return するため exclusive を二重カウントしない。
- ドキュメント節番号は plan §4.1 で予想された「§6」ではなく `## 5. dispatch ガード` として `## 5. 段階計画` の手前に挿入。既存 §5 を §6 に shift して連番を維持（plan §4.1 末尾「節番号衝突がないか確認すること」の指示通り、grep で現状構成を確認したうえで判断）。

## テスト結果

```
$ bun test --timeout 30000 task.test.ts daemon-*.test.ts
112 pass / 0 fail / 232 expect() calls

$ bun test --timeout 30000 daemon.test.ts
187 pass / 0 fail / 667 expect() calls

$ bunx tsc --noEmit  (skills/cmux-team/manager)
errors: 0
```

新規 5 テスト (TC1〜TC5) は全 green、既存テストの regression なし。
