# T397 検品結果

## 判定

**GO**

`filterRunAfterAllTasks` の `normalActive` フィルタは plan.md §3.2 の定義「`assigned OR (ready AND deps 全 closed)`」通りに修正されており、追加 7 テスト（T1〜T7）も plan.md §4.4 と完全一致。`bun test`（294/294 pass）と `tsc --noEmit`（exit=0）両方 green。スコープ逸脱なし。

## 各検品観点の確認結果

### 1. 計画書（plan.md）通りの実装か

| 項目 | 確認結果 |
|---|---|
| docstring（`task.ts:468-480`） | plan.md §3.1 の新仕様文面と完全一致（normalActive 定義 / 「draft 経由の間接デッドロック」言及 / cleanup chain 除外言及） |
| `normalActive` フィルタ式（`task.ts:501-508`） | plan.md §3.2 の式（`assignedIds.has(t.id) \|\| (t.status === "ready" && t.dependsOn.every(d => closedIds.has(d)))`）と完全一致 |
| inline コメント（`task.ts:498-500`） | plan.md §5 の新コメント（「実際に動く / 動ける」通常タスク、T397 注釈付き）と完全一致 |
| 追加テスト T1〜T7 | plan.md §4.4 のコード例と一字一句同じ。配置も `filterExecutableTasks` describe と `sortByPriority` describe の間（`task.test.ts:391-464`）で plan.md §4.1 通り |
| import 追加 | `filterRunAfterAllTasks` を `task.test.ts:8` に追加。plan.md §4.1 通り |

### 2. 実装の正しさ

- `normalActive` の論理式は「`assignedIds.has(t.id) || (t.status === "ready" && t.dependsOn.every(d => closedIds.has(d)))`」となっており、「assigned OR (ready AND deps 全 closed)」を正確に表現。
- T397 再現シナリオ（T-A=ready+deps=[T-B], T-B=draft, T-C=ready+runAfterAll）は T1 として収録され、`expect(result.map(t => t.id)).toEqual(["C"])` で T-C 発火を確認。実テスト pass。
- regression: T2（ready+deps closed の通常タスクはブロック）/ T3（assigned はブロック）/ T5（cleanup chain）/ T6（run_after_all 自身の依存未解決）すべて pass。既存挙動が壊れていない。
- 既存の `dependsOnRunAfterAll` 除外ロジックも保持されており、T5 で確認済み。

### 3. テスト品質

- 7 ケースは観点が重複なく、新規（T1）/ regression（T2, T3, T5, T6）/ 基本パス（T4）/ コーナー（T7）をバランスよくカバー。
- 各 `expect` は観点と一致。`toEqual(["C"])` でブロック解除時、`toHaveLength(0)` でブロック時、と意図が読みやすい。
- ヘルパー `makeMeta` は `filterExecutableTasks` describe の `makeMeta`（`task.test.ts:271-287`）と同じパターンで `runAfterAll` opt 拡張のみ。命名規則・構造ともに整合。
- describe 命名 `filterRunAfterAllTasks` は対象関数と同名で既存規約と一致。

### 4. 検証コマンドの再実行（自分で実行した結果）

```
$ cd skills/cmux-team/manager && bun test --timeout 30000 task.test.ts daemon.test.ts
bun test v1.3.13 (bf2e2cec)

 294 pass
 0 fail
 874 expect() calls
Ran 294 tests across 2 files. [24.18s]
```

```
$ bun test --timeout 30000 task.test.ts -t "filterRunAfterAllTasks"
 7 pass
 100 filtered out
 0 fail
 7 expect() calls
Ran 7 tests across 1 file. [34.00ms]
```

```
$ bunx tsc --noEmit
（出力なし、EXIT=0）
```

→ impl-result.md の主張（294 pass / 874 expects / 24.87s, tsc green）と完全一致。所要時間は 24.18s と僅かに短い差はあるが pass/fail カウント・expects 数は同一。

### 5. スコープ逸脱の確認

```
$ git diff --stat
 package-lock.json                     |  4 +-
 skills/cmux-team/manager/task.test.ts | 76 +++++++++++++++++++++++++++++++++++
 skills/cmux-team/manager/task.ts      | 20 +++++++--
 3 files changed, 95 insertions(+), 5 deletions(-)
```

- 変更ファイルは指示通り `package-lock.json` / `task.ts` / `task.test.ts` の 3 つのみ。
- `package-lock.json` の差分は version `4.20.0 → 4.21.0` の 2 行のみ（worktree bootstrap 由来、本タスクと無関係。指示通り許容）。
- `task.ts` の変更箇所は docstring（468-479 行）/ inline コメント（498-500 行）/ `normalActive` フィルタ（501-508 行）に限定。シグネチャ・他関数への波及なし。
- `task.test.ts` の変更は import 1 行追加 + describe ブロック 1 個（76 行）追加のみ。既存テストの改変なし。
- 計画外のリファクタリング・dependent file の変更なし。

### 6. 影響範囲（grep 再確認）

```
$ grep -rn filterRunAfterAllTasks --include='*.ts' skills/
skills/cmux-team/manager/daemon.ts:22       (import)
skills/cmux-team/manager/daemon.ts:2943     (呼び出し)
skills/cmux-team/manager/task.ts:481        (定義)
skills/cmux-team/manager/task.test.ts:*     (新規テスト)
```

- 呼び出し元は `daemon.ts:2943` のみ。シグネチャ `(tasks, closedIds, assignedIds) => TaskMeta[]` は不変なので daemon.ts 側の修正不要。
- `daemon.test.ts`（187 件）は今回の修正後も全 pass で regression なし。

## minor 指摘 / 推奨改善

なし。plan.md 通りの忠実な実装で、コメントの typo・命名揺れもなし。

## 結論

完了条件チェックリスト 6 項目すべて確認できた。**GO**。
