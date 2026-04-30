# T387 Summary — run_after_all drain 判定で depends_on を再帰的に遡って draft/aborted をブロッカー扱い

## 完了したサブタスク

1. **Phase 1 (Plan)** — Planner Agent が `plan.md` を作成（実装方針・テストケース 7 つ・エッジケースを整理）
2. **Phase 3 (Implementation)** — Implementer Agent が TDD で実装（テスト先行 → 実装 → 全 pass 確認）
3. **Phase 4 (Inspection)** — Inspector Agent が独立検品し **GO** 判定

## 変更ファイル

| ファイル | 増減 | 概要 |
|----------|------|------|
| `skills/cmux-team/manager/task.ts` | +25 / -2 | `filterRunAfterAllTasks` に `byId` Map と `isBlockedByDeadDep` クロージャを追加。`normalActive` の filter 条件に `&& !isBlockedByDeadDep(t)` を追加 |
| `skills/cmux-team/manager/task.test.ts` | +76 / -0 | `describe("filterRunAfterAllTasks (T387)")` ブロック新規追加。再現 / 直接 draft / 2 段間接 / aborted / 循環 / closed のみ / 削除済み依存 の 7 テスト |

合計 **+101 / -2 行 / 2 ファイル**。

## 実装ロジック

`ready` または `assigned` タスクが drain ブロッカー (`normalActive`) に含まれるかの判定で、`dependsOn` チェーンを BFS で再帰的に遡る:

- チェーン上に `draft` または `aborted` のタスクが存在する → ブロッカーから除外（その ready は進む見込みがない）
- 循環参照は `visited` Set で防止
- `closed` は終端（解消済み、それ以上辿らない）
- 削除済み依存（`byId` に無い）は無視（既存挙動踏襲）

## テスト結果

### `task.test.ts` 単体

```
107 pass / 0 fail / 207 expect() calls
```

追加 7 テストすべて pass、既存 `filterExecutableTasks` / `cascadeAbortToChildren` / `sortByPriority` のデグレなし。

### manager 全テスト個別実行（CLAUDE.md「bun test 全体実行禁忌」遵守）

```
62 files green / 0 fail
*.test.ts (54) + state-machine/*.test.ts (3) + dashboard-*.test.tsx (4)
```

### TypeScript 型チェック

```
bunx tsc --noEmit  → exit 0, errors 0
```

## 設計判断

- **`isBlockedByDeadDep` は `filterRunAfterAllTasks` 内のローカル関数として実装**。他で再利用しないので export 不要。`byId` をクロージャ共有することで関数 signature をシンプルに保つ
- **`filterExecutableTasks` には触れない**（タスク本文「関連」セクションで明確に範囲外と宣言されている）
- **後段の run_after_all 返却部分は無修正**（自身の `dependsOn` は `closedIds` で直接判定、チェーン遡及は不要）
- **TaskMeta 型 signature 変更なし**、daemon.ts:2754-2768 呼び出し側も無修正で互換

## 試行錯誤

- **Inspector Agent が初回 spawn 時に @tayo トークンの月次上限（401 認証エラー）でハング** → kill-agent で停止し再 spawn したところ @saki トークンで正常完了。token pool による自動切り替えが機能した

## 懸念・残課題

- **aborted 検出ロジックは daemon 経由では実質発火しない**（daemon は `openTasksList` で `aborted` を除外）。これは cascade 漏れバグの保険・単体テスト・将来の呼び出し側変更に対する safety net として機能する（タスク本文の意図と整合）
- 上記以外の懸念事項なし

## マージコミット / PR

- **PR**: https://github.com/hummer98/cmux-team/pull/46
- **commit**: `035ea05` `fix(manager): run_after_all drain で depends_on チェーン上の draft/aborted をブロッカー扱い (T387)`
- **branch**: `task-387-1777447940/task` (origin に push 済み)
