# T397 実装計画書: filterRunAfterAllTasks の normalActive を executable ベースに修正

## 1. ゴール

`filterRunAfterAllTasks` の `normalActive` 判定を「ready で **かつ** depends_on が全て closed」を条件にする executable ベースに変更し、ready だが draft 等の依存先で未解決のタスクが run_after_all を間接ロックする問題を解消する。

## 2. 修正対象ファイル一覧

| ファイル | 行番号 | 種別 |
|---|---|---|
| `skills/cmux-team/manager/task.ts` | 468–494 | docstring + 実装修正 |
| `skills/cmux-team/manager/task.test.ts` | `describe("filterExecutableTasks", …)` 直後（388 行目以降の `describe("sortByPriority", …)` の手前付近に新 describe を追加） | 新規テスト追加 |

呼び出し元: `skills/cmux-team/manager/daemon.ts:2943` の 1 箇所のみ（`grep -rn filterRunAfterAllTasks --include='*.ts' skills/` で確認済み）。シグネチャ・返り値型は変更しないため、daemon.ts への変更は不要。

## 3. 修正内容（task.ts）

### 3.1 docstring の更新（468–470 行）

旧:
```ts
/**
 * run_after_all タスクの実行可否を判定
 * 条件: 通常タスク（run_after_all でない、かつ run_after_all タスクに depends_on しているものを除く）の ready + assigned が 0
 */
```

新:
```ts
/**
 * run_after_all タスクの実行可否を判定
 *
 * normalActive（= run_after_all をブロックする対象）は以下のいずれか:
 *   - assigned （現在アサイン中）
 *   - ready かつ depends_on が全て closed （= 即時 executable）
 *
 * ready でも depends_on が未解決（依存先が draft / ready / assigned 等で未 close）のタスクは、
 * 自身が executable ではないため normalActive にカウントしない。
 * これにより「draft 経由の間接デッドロック」（T397）を回避する。
 *
 * なお run_after_all タスク自身、および run_after_all に depends_on するタスクは normalActive から除外する。
 */
```

### 3.2 normalActive フィルタの修正（490–494 行）

旧:
```ts
const normalActive = tasks.filter(t =>
  !t.runAfterAll &&
  !dependsOnRunAfterAll.has(t.id) &&
  (t.status === "ready" || assignedIds.has(t.id))
);
```

新:
```ts
const normalActive = tasks.filter(t =>
  !t.runAfterAll &&
  !dependsOnRunAfterAll.has(t.id) &&
  (
    assignedIds.has(t.id) ||
    (t.status === "ready" && t.dependsOn.every(d => closedIds.has(d)))
  )
);
```

### 3.3 想定 diff 全体（参考）

```diff
 /**
- * run_after_all タスクの実行可否を判定
- * 条件: 通常タスク（run_after_all でない、かつ run_after_all タスクに depends_on しているものを除く）の ready + assigned が 0
+ * run_after_all タスクの実行可否を判定
+ *
+ * normalActive（= run_after_all をブロックする対象）は以下のいずれか:
+ *   - assigned （現在アサイン中）
+ *   - ready かつ depends_on が全て closed （= 即時 executable）
+ *
+ * ready でも depends_on が未解決（依存先が draft / ready / assigned 等で未 close）のタスクは、
+ * 自身が executable ではないため normalActive にカウントしない。
+ * これにより「draft 経由の間接デッドロック」（T397）を回避する。
+ *
+ * なお run_after_all タスク自身、および run_after_all に depends_on するタスクは normalActive から除外する。
  */
 export function filterRunAfterAllTasks(
   tasks: TaskMeta[],
   closedIds: Set<string>,
   assignedIds: Set<string>
 ): TaskMeta[] {
   const runAfterAllIds = new Set(
     tasks.filter(t => t.runAfterAll).map(t => t.id)
   );

   const dependsOnRunAfterAll = new Set(
     tasks.filter(t =>
       !t.runAfterAll && t.dependsOn.some(dep => runAfterAllIds.has(dep))
     ).map(t => t.id)
   );

-  const normalActive = tasks.filter(t =>
-    !t.runAfterAll &&
-    !dependsOnRunAfterAll.has(t.id) &&
-    (t.status === "ready" || assignedIds.has(t.id))
-  );
+  const normalActive = tasks.filter(t =>
+    !t.runAfterAll &&
+    !dependsOnRunAfterAll.has(t.id) &&
+    (
+      assignedIds.has(t.id) ||
+      (t.status === "ready" && t.dependsOn.every(d => closedIds.has(d)))
+    )
+  );

   if (normalActive.length > 0) return [];
   ...
 }
```

## 4. 追加するテストケース（task.test.ts）

### 4.1 追加場所

`skills/cmux-team/manager/task.test.ts` には現状 `filterRunAfterAllTasks` の専用 describe ブロックが存在しない（grep で確認済み）。
新規に `describe("filterRunAfterAllTasks", …)` を追加する。配置は `describe("filterExecutableTasks", …)`（270–388 行）と `describe("sortByPriority", …)`（390 行〜）の間。

import への追加: 1–22 行目の import 文に `filterRunAfterAllTasks` を追加する。

### 4.2 共通ヘルパー

`filterExecutableTasks` の describe 内 `makeMeta`（271–287 行）と同じパターンを踏襲し、`runAfterAll` を引数で切り替えられるように拡張する:

```ts
const makeMeta = (
  id: string,
  status: string,
  opts: { dependsOn?: string[]; runAfterAll?: boolean; priority?: string } = {}
): TaskMeta => ({
  id,
  title: `task-${id}`,
  status,
  priority: opts.priority ?? "medium",
  dependsOn: opts.dependsOn ?? [],
  filePath: `/path/${id}.md`,
  fileName: `${id}.md`,
  createdAt: "",
  runAfterAll: opts.runAfterAll ?? false,
  exclusive: false,
});
```

### 4.3 テストケース一覧

完了条件 3 件（新規 1 + 既存挙動の regression 2 件）に加え、隣接コーナーケースを補強する。

| # | test description | 観点 |
|---|---|---|
| T1 | `ready でも depends_on が未解決（依存先が draft）の場合、run_after_all は発火する（T397 修正）` | **新規**。本タスクの再現シナリオそのもの |
| T2 | `ready で depends_on が解決済みの通常タスクが残っている間は run_after_all をブロックする` | **regression**: executable な normal task は引き続きブロック対象 |
| T3 | `assigned な通常タスクが残っている間は run_after_all をブロックする` | **regression**: assigned は依存解決有無に関わらずブロック |
| T4 | `通常タスクが全て closed になれば run_after_all が発火する` | 基本パス（regression） |
| T5 | `run_after_all 自身に depends_on するタスク（cleanup chain）は normalActive から除外され、run_after_all を阻害しない` | 既存 `dependsOnRunAfterAll` 除外ロジックの regression |
| T6 | `run_after_all タスクの depends_on が未解決の間は発火しない` | run_after_all 自身の依存チェック regression |
| T7 | `通常タスクが draft のみで他に何もない場合、run_after_all は発火する` | 「ready 化されていない draft」だけが残るケース |

### 4.4 各テストの最小コード例

```ts
describe("filterRunAfterAllTasks", () => {
  const makeMeta = (
    id: string,
    status: string,
    opts: { dependsOn?: string[]; runAfterAll?: boolean; priority?: string } = {}
  ): TaskMeta => ({
    id,
    title: `task-${id}`,
    status,
    priority: opts.priority ?? "medium",
    dependsOn: opts.dependsOn ?? [],
    filePath: `/path/${id}.md`,
    fileName: `${id}.md`,
    createdAt: "",
    runAfterAll: opts.runAfterAll ?? false,
    exclusive: false,
  });

  // T1: T397 本体
  test("ready でも depends_on が未解決（依存先が draft）の場合、run_after_all は発火する", () => {
    const tA = makeMeta("A", "ready", { dependsOn: ["B"] });
    const tB = makeMeta("B", "draft");
    const tC = makeMeta("C", "ready", { runAfterAll: true });
    const result = filterRunAfterAllTasks([tA, tB, tC], new Set(), new Set());
    expect(result.map(t => t.id)).toEqual(["C"]);
  });

  // T2: regression（依存解決済みの ready はブロック）
  test("ready で depends_on が解決済みの通常タスクが残っている間は run_after_all をブロックする", () => {
    const tA = makeMeta("A", "ready", { dependsOn: ["X"] });
    const tC = makeMeta("C", "ready", { runAfterAll: true });
    const result = filterRunAfterAllTasks([tA, tC], new Set(["X"]), new Set());
    expect(result).toHaveLength(0);
  });

  // T3: regression（assigned はブロック）
  test("assigned な通常タスクが残っている間は run_after_all をブロックする", () => {
    const tA = makeMeta("A", "ready");
    const tC = makeMeta("C", "ready", { runAfterAll: true });
    const result = filterRunAfterAllTasks([tA, tC], new Set(), new Set(["A"]));
    expect(result).toHaveLength(0);
  });

  // T4: 基本パス
  test("通常タスクが全て closed になれば run_after_all が発火する", () => {
    const tC = makeMeta("C", "ready", { runAfterAll: true });
    const result = filterRunAfterAllTasks([tC], new Set(["A", "B"]), new Set());
    expect(result.map(t => t.id)).toEqual(["C"]);
  });

  // T5: dependsOnRunAfterAll の除外
  test("run_after_all に depends_on するタスクは normalActive から除外される", () => {
    const tC = makeMeta("C", "ready", { runAfterAll: true });
    const tD = makeMeta("D", "ready", { dependsOn: ["C"] }); // cleanup chain
    const result = filterRunAfterAllTasks([tC, tD], new Set(), new Set());
    expect(result.map(t => t.id)).toEqual(["C"]);
  });

  // T6: run_after_all 自身の依存
  test("run_after_all タスクの depends_on が未解決なら発火しない", () => {
    const tC = makeMeta("C", "ready", { runAfterAll: true, dependsOn: ["X"] });
    // 通常タスクは無し、X はまだ closed ではない
    const result = filterRunAfterAllTasks([tC], new Set(), new Set());
    expect(result).toHaveLength(0);
  });

  // T7: draft のみ残るケース
  test("残っている通常タスクが draft のみなら run_after_all は発火する", () => {
    const tB = makeMeta("B", "draft");
    const tC = makeMeta("C", "ready", { runAfterAll: true });
    const result = filterRunAfterAllTasks([tB, tC], new Set(), new Set());
    expect(result.map(t => t.id)).toEqual(["C"]);
  });
});
```

> 注: `T2` は元仕様（`status === "ready"` のみで判定）でも修正後仕様でも同じ結果になるように、`closedIds = new Set(["X"])` を渡して「依存解決済みの ready」が残っている状態を作ることで、修正後の executable ベースでもブロックが効くことを確認する。

## 5. コメント更新

§3.1 で記載した通り、`task.ts:468-470` の docstring を新仕様に合わせて全面差し替え。
合わせて、normalActive の inline コメント（489 行目「通常タスク（run_after_all でも、run_after_all に依存するタスクでもない）の ready + assigned 数」）も更新する:

旧:
```ts
// 通常タスク（run_after_all でも、run_after_all に依存するタスクでもない）の ready + assigned 数
```

新:
```ts
// run_after_all をブロックする「実際に動く / 動ける」通常タスク
// （= assigned、もしくは ready かつ依存全 closed）。
// ready でも依存未解決のタスクは executable ではないのでカウントしない（T397）。
```

## 6. 検証コマンド

```bash
# ユニットテスト
cd skills/cmux-team/manager && bun test --timeout 30000 task.test.ts daemon.test.ts

# 型チェック
cd skills/cmux-team/manager && bunx tsc --noEmit
```

`bun test` 全体実行は CLAUDE.md ガイドライン（O(N²) 級劣化）により禁止。上記のように対象ファイルを絞って実行する。

なお完了条件には `daemon-*.test.ts` と書かれているが、リポジトリ実体は `daemon.test.ts` の 1 ファイルのみ（`ls skills/cmux-team/manager/daemon*.test.ts` で確認済み）。Glob `daemon-*.test.ts` はマッチ 0 件になるため、明示的に `daemon.test.ts` を指定する。

## 7. 影響範囲調査

`grep -rn filterRunAfterAllTasks --include='*.ts' skills/` の結果:

```
skills/cmux-team/manager/daemon.ts:22       (import)
skills/cmux-team/manager/daemon.ts:2943     (呼び出し: state-update path)
skills/cmux-team/manager/task.ts:472         (定義)
```

- 呼び出し元は `daemon.ts:2943` の 1 箇所のみ。
- シグネチャ `(tasks, closedIds, assignedIds) => TaskMeta[]` は不変。返り値型・要素も `runAfterAll: true && status: ready && deps closed && !assigned` で従来同様。
- 変更されるのは「**ブロック判定**」の側だけ（normalActive を厳しめにすると発火しやすくなる方向）。daemon.ts の利用側ロジック（runAfterAllExecutable を executable にマージ）への影響なし。

`run_after_all` / `runAfterAll` を含む既存テスト:
- `task.test.ts` の `describe("createTaskProgrammatic run_after_all conflict (T300)", …)`（1028 行〜）は **作成時の conflict 判定** のテストで、`filterRunAfterAllTasks` には触れない。影響なし。
- `parseTaskMeta — exclusive`（520 行〜）も meta 解釈のテストで影響なし。

## 8. やらないこと（再確認）

- draft の semantic 全体の見直しは行わない（draft なタスクが「将来的に ready 化されるかもしれない」ことは run_after_all のロックには無関係、というのが本修正の立場）。
- depends_on の可視化やデッドロック検知 UI の追加は行わない。
- `run_after_all` / `runAfterAll` の rename・API 変更は行わない。
- `filterExecutableTasks` 側の挙動は変更しない（既に依存解決済みのみ executable とする実装になっている）。

## 9. 完了条件チェックリスト（タスク本文の再掲）

- [ ] `filterRunAfterAllTasks` の `normalActive` フィルタを executable ベース（assigned OR (ready AND deps closed)）に修正
- [ ] 新規テスト T1: ready で dep が draft のタスクが存在しても run_after_all が発火する
- [ ] 既存挙動 regression T2: ready で dep が解決済みのタスクは run_after_all をブロックする
- [ ] 既存挙動 regression T3: assigned タスクは run_after_all をブロックする
- [ ] `cd skills/cmux-team/manager && bun test --timeout 30000 task.test.ts daemon.test.ts` が green
- [ ] `bunx tsc --noEmit` が green

## 10. 想定実装ステップ（Implementer 向け）

1. `task.ts` の docstring（468–470）と `normalActive` フィルタ（490–494）を §3 に従って書き換え。
2. `task.ts:489` の inline コメントを §5 に従って書き換え。
3. `task.test.ts` の import に `filterRunAfterAllTasks` を追加。
4. `task.test.ts` に §4.4 のテストブロック（T1–T7）を追加。
5. `cd skills/cmux-team/manager && bun test --timeout 30000 task.test.ts daemon.test.ts` を実行し green を確認。
6. `bunx tsc --noEmit` で型エラー無しを確認。
7. コミット・PR 作成は cmux-team の通常フローに従う。
