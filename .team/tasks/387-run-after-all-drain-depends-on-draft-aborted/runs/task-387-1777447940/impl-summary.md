# T387 実装サマリー

## 変更ファイル

### `skills/cmux-team/manager/task.ts`
- `filterRunAfterAllTasks` (行 472-) に以下を追加:
  - `byId: Map<string, TaskMeta>` の構築（クロージャで再利用）
  - `isBlockedByDeadDep(task)` ローカル関数（BFS でチェーンを遡及、`visited` で循環防止、`closed` は終端、削除済み依存は無視）
  - `normalActive` の filter 条件に `&& !isBlockedByDeadDep(t)` を追加
- 後段の `return tasks.filter(...)`（run_after_all 自身の依存判定）は無修正

### `skills/cmux-team/manager/task.test.ts`
- import に `filterRunAfterAllTasks` を追加
- `describe("filterRunAfterAllTasks (T387)")` ブロックを `filterExecutableTasks` 直後に新規追加

## 追加したテスト数

7 テスト

| # | 内容 | 期待 |
|---|---|---|
| 1 | T1=draft, T2=ready→T1, T3=run_after_all (再現) | T3 が drain で返る |
| 2 | T1=draft, T2=ready→T1（run_after_all 不在） | 空配列 |
| 3 | 2 段間接 draft 依存（T3→T2→T1=draft） | T4 が drain で返る |
| 4 | aborted 依存（cascade 漏れ保険） | T3 が drain で返る |
| 5 | 循環参照（T1↔T2） | 無限ループせず空配列 |
| 6 | closed のみのチェーン（既存挙動） | 空配列（T2 が normalActive に残る） |
| 7 | 削除済み依存（byId に無い） | 空配列（既存挙動を維持） |

## 動作確認結果

### 実装前のテスト失敗（plan.md の予測通り）

```
107 tests across 1 file (task.test.ts)
104 pass, 3 fail
```

fail したテスト:
- テスト 1（再現）
- テスト 3（2 段間接）
- テスト 4（aborted）

テスト 2, 5, 6, 7 は plan.md §4 の通り現状実装でも pass（ブロッカー検出が必要ない / 無限ループしない / 既存挙動）。

### 実装後

```
bun test --timeout 30000 task.test.ts
107 pass, 0 fail
207 expect() calls
```

### manager 全テスト（個別ファイル loop）

CLAUDE.md「`bun test` 全体実行禁忌」遵守。62 ファイル全て green:

```
*.test.ts (54 ファイル) ... PASS
state-machine/*.test.ts (3 ファイル) ... PASS
dashboard-*.test.tsx (4 ファイル) ... PASS
=== summary: 62 pass, 0 fail (files) ===
```

### TypeScript 型チェック

```
bunx tsc --noEmit
exit=0
```

新規エラー 0 件。

## 設計判断

- **`isBlockedByDeadDep` は `filterRunAfterAllTasks` 内のローカル関数**。他に再利用しないため export 不要。`byId` をクロージャで共有して signature を簡潔に保つ
- **後段の run_after_all 返却部分は無修正**。run_after_all 自身の `dependsOn` は `closedIds` で直接判定しており、チェーン遡及は不要（タスク本文・plan.md と一致）
- **`filterExecutableTasks` には触れない**。タスク本文「関連」セクションで明確に範囲外と宣言されている

## 懸念点

特になし。

- daemon 側 (`daemon.ts:2767`) の呼び出しは `TaskMeta[]` を渡し戻り値も `TaskMeta[]` のままで、signature 変更なし
- 既存呼び出し（task.ts 単体テスト以外）は `openTasksList` で `closed`/`aborted`/`deleted` を除外したものを渡すため、`isBlockedByDeadDep` 内の `if (!dep) continue` ルートが実行される。これは意図通り（既存挙動踏襲＝drain ブロック維持）
- aborted 検出ロジックは daemon 経由では実質発火しないが、cascade 漏れの保険・単体テスト・将来の呼び出し側変更に対する safety net として機能（タスク本文と整合）
