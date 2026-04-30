# T387 実装計画書: run_after_all drain 判定で depends_on を再帰的に遡って draft/aborted をブロッカー扱い

## 1. 対象ファイル一覧

### 実装対象
- `skills/cmux-team/manager/task.ts`
  - 修正箇所: `filterRunAfterAllTasks` (現 `task.ts:472-509`)
  - 追加: ローカルヘルパー関数 `isBlockedByDeadDep`（`filterRunAfterAllTasks` 内のクロージャとして実装）

### テスト対象
- `skills/cmux-team/manager/task.test.ts`
  - 既存 `describe("filterExecutableTasks")` (行 270-388) と `describe("sortByPriority")` (行 390-) の間に `describe("filterRunAfterAllTasks")` ブロックを新規追加
  - import 文 (行 5-21) に `filterRunAfterAllTasks` を追記

### 変更しないファイル
- `skills/cmux-team/manager/daemon.ts:2767`（呼び出し側）— 戻り値型 `TaskMeta[]` は変わらないので無修正で動く
- `skills/cmux-team/manager/task.ts:443` `filterExecutableTasks` — タスク本文「関連」セクションの通り対象外（直接の closed 判定で十分）

---

## 2. 現状分析

### TaskMeta 型 (task.ts:11-32)

```ts
export interface TaskMeta {
  id: string;
  title: string;
  status: string;          // "draft" | "ready" | "assigned" | "closed" | "aborted" | "deleted" 等
  priority: string;
  dependsOn: string[];     // ← TS フィールド名は dependsOn（snake_case の depends_on は frontmatter / CLI 専用）
  runAfterAll: boolean;
  exclusive: boolean;
  filePath: string;
  fileName: string;
  createdAt: string;
  baseBranch?: string;
  taskDir?: string;
  kind?: string;
  createdBy?: string;
}
```

→ TaskMeta 型では **`dependsOn` (camelCase)** を使う。タスク本文と仕様文書では `depends_on` という表現が出てくるが、これは frontmatter / CLI フラグの命名であって、TS コードでは `dependsOn`。

### 既存 `filterRunAfterAllTasks` (task.ts:472-509)

```ts
export function filterRunAfterAllTasks(
  tasks: TaskMeta[],
  closedIds: Set<string>,
  assignedIds: Set<string>
): TaskMeta[] {
  const runAfterAllIds = new Set(tasks.filter(t => t.runAfterAll).map(t => t.id));
  const dependsOnRunAfterAll = new Set(
    tasks.filter(t => !t.runAfterAll && t.dependsOn.some(dep => runAfterAllIds.has(dep))).map(t => t.id)
  );

  // ← ここの判定が「直接の status のみ」を見ている
  const normalActive = tasks.filter(t =>
    !t.runAfterAll &&
    !dependsOnRunAfterAll.has(t.id) &&
    (t.status === "ready" || assignedIds.has(t.id))
  );

  if (normalActive.length > 0) return [];

  // 通常タスク完了 → run_after_all のうち実行可能なものを返す
  return tasks.filter(t => {
    if (!t.runAfterAll) return false;
    if (t.status !== "ready") return false;
    if (assignedIds.has(t.id)) return false;
    if (t.dependsOn.length > 0 && !t.dependsOn.every(dep => closedIds.has(dep))) return false;
    return true;
  });
}
```

### 関連既存関数

- `filterExecutableTasks` (task.ts:443) — 通常タスク用、修正対象外
- `cascadeAbortToChildren` (task.test.ts:425) — 親 aborted で子 ready を draft 化する FSM。タスク本文では「aborted を含めるのは cascade 漏れバグの保険」と明記
- `isBlockedByDeadDep` 相当の関数: **存在しない**（`grep -rn "isBlockedByDeadDep"` で 0 件確認済み）。重複実装の懸念なし

### 呼び出し側 (daemon.ts:2754-2768)

`openTasksList = tasks.filter(t => !isTerminalStatus(t.status))` で `closed` / `aborted` / `deleted` を除外したものを渡す。

→ daemon 経由では aborted な親タスクが `tasks` に含まれない。`isBlockedByDeadDep` 内で `byId.get(depId)` が undefined を返し「削除済み扱い」で continue する。**aborted 検出は単体テスト・将来の呼び出し側変更に対する保険として機能**する（タスク本文の意図と整合）。本実装で daemon 側を変更する必要はない。

---

## 3. 実装ステップ

### Step 1. `task.ts:472` `filterRunAfterAllTasks` の修正

`runAfterAllIds` / `dependsOnRunAfterAll` を計算した直後に以下を追加し、`normalActive` の filter 条件に `&& !isBlockedByDeadDep(t)` を加える:

```ts
export function filterRunAfterAllTasks(
  tasks: TaskMeta[],
  closedIds: Set<string>,
  assignedIds: Set<string>
): TaskMeta[] {
  const runAfterAllIds = new Set(tasks.filter(t => t.runAfterAll).map(t => t.id));
  const dependsOnRunAfterAll = new Set(
    tasks.filter(t => !t.runAfterAll && t.dependsOn.some(dep => runAfterAllIds.has(dep))).map(t => t.id)
  );

  // すべてのタスクを id で引けるマップ（クロージャで再利用）
  const byId = new Map(tasks.map(t => [t.id, t]));

  /**
   * ready タスクが「進む見込みのない依存」を持つかを BFS で再帰的に判定する。
   * 循環参照は visited Set で防ぐ。
   */
  const isBlockedByDeadDep = (task: TaskMeta): boolean => {
    const visited = new Set<string>();
    const queue: string[] = [...task.dependsOn];
    while (queue.length > 0) {
      const depId = queue.shift()!;
      if (visited.has(depId)) continue;
      visited.add(depId);
      const dep = byId.get(depId);
      if (!dep) continue;                                      // 削除済み: 既存挙動を踏襲し無視
      if (dep.status === "draft" || dep.status === "aborted") return true;  // ブロッカー
      if (dep.status === "closed") continue;                   // 解消済み、これより上は辿らない
      // ready / assigned はさらに上を辿る
      queue.push(...dep.dependsOn);
    }
    return false;
  };

  const normalActive = tasks.filter(t =>
    !t.runAfterAll &&
    !dependsOnRunAfterAll.has(t.id) &&
    (t.status === "ready" || assignedIds.has(t.id)) &&
    !isBlockedByDeadDep(t)            // ← 追加: チェーン上に draft/aborted があれば除外
  );

  if (normalActive.length > 0) return [];

  // 後続（return tasks.filter(...)）は変更なし
  return tasks.filter(t => {
    if (!t.runAfterAll) return false;
    if (t.status !== "ready") return false;
    if (assignedIds.has(t.id)) return false;
    if (t.dependsOn.length > 0 && !t.dependsOn.every(dep => closedIds.has(dep))) return false;
    return true;
  });
}
```

### Step 1 の設計判断ポイント

- **`isBlockedByDeadDep` は filterRunAfterAllTasks 内のローカル関数** — 他で再利用しないので export 不要。`byId` をクロージャで共有することで関数 signature をシンプルに保てる
- `filterExecutableTasks` には触れない（タスク本文「関連」で明確に範囲外と宣言されている）
- 後段の `return tasks.filter(...)` ブロック（実際に run_after_all を返す部分）は無修正。run_after_all 自身の `dependsOn` は `closedIds` で直接判定しており、この判定にチェーン遡及は不要（タスク本文の「実装方針」も `normalActive` の判定のみを修正対象としている）

### Step 2. テストの追加（次節 §4 参照）

### Step 3. 動作確認（§6 参照）

---

## 4. テストケース

### 追加先
`skills/cmux-team/manager/task.test.ts` の **行 388-390 の間**（`describe("filterExecutableTasks")` ブロック直後、`describe("sortByPriority")` ブロック直前）に新規 `describe("filterRunAfterAllTasks (T387)")` を追加。

### import 修正（行 5-21）
```ts
import {
  parseTaskMeta,
  filterExecutableTasks,
  filterRunAfterAllTasks,         // ← 追加
  sortByPriority,
  // ... 既存のまま
} from "./task";
```

### setup ヘルパー
既存の `describe("filterExecutableTasks")` (行 271-287) や `describe("cascadeAbortToChildren")` (行 426-437) と同じパターンの `makeMeta` ローカル関数を新 describe 内に定義する。共有ヘルパー化はしない（既存スタイルに合わせる）。

```ts
const makeMeta = (
  id: string,
  status: string,
  dependsOn: string[] = [],
  runAfterAll: boolean = false,
): TaskMeta => ({
  id,
  title: `task-${id}`,
  status,
  priority: "medium",
  dependsOn,
  runAfterAll,
  exclusive: false,
  filePath: `/path/${id}.md`,
  fileName: `${id}.md`,
  createdAt: "",
});
```

### テスト 1: 再現テスト（T1=draft, T2=ready depends T1, T3=run_after_all ready → T3 が drain OK）

```ts
test("ready 依存元が draft なら drain 通過し run_after_all が返る (再現)", () => {
  const t1 = makeMeta("1", "draft");
  const t2 = makeMeta("2", "ready", ["1"]);
  const t3 = makeMeta("3", "ready", [], true);
  const result = filterRunAfterAllTasks([t1, t2, t3], new Set(), new Set());
  expect(result.map(t => t.id)).toEqual(["3"]);
});
```

### テスト 2: 直接 draft 依存（T1=draft, T2=ready depends T1 → T2 はブロック扱いだが run_after_all がない）

```ts
test("draft に依存する ready のみで run_after_all が無い場合は空配列", () => {
  const t1 = makeMeta("1", "draft");
  const t2 = makeMeta("2", "ready", ["1"]);
  // run_after_all なし
  const result = filterRunAfterAllTasks([t1, t2], new Set(), new Set());
  expect(result).toEqual([]);
});
```

> 補足: タスク本文のテスト 2 は「T2 はブロック扱い」を直接的に検証する記述だが、`filterRunAfterAllTasks` の返り値は run_after_all のリストなので、run_after_all 不在ケースは「空配列が返る（drain 自体は OK だが対象なし）」という形で観測する。「T2 がブロック扱いされた」ことは run_after_all 入りケース（テスト 1）で間接的に検証される。

### テスト 3: 2 段間接 draft（T1=draft, T2=ready depends T1, T3=ready depends T2, T4=run_after_all ready）

```ts
test("2 段間接の draft 依存もチェーン遡及で検出して drain 通過", () => {
  const t1 = makeMeta("1", "draft");
  const t2 = makeMeta("2", "ready", ["1"]);
  const t3 = makeMeta("3", "ready", ["2"]);
  const t4 = makeMeta("4", "ready", [], true);
  const result = filterRunAfterAllTasks([t1, t2, t3, t4], new Set(), new Set());
  expect(result.map(t => t.id)).toEqual(["4"]);
});
```

### テスト 4: aborted 依存（保険ケース）

```ts
test("aborted 依存も draft と同様に drain 通過させる (cascade 漏れの保険)", () => {
  const t1 = makeMeta("1", "aborted");
  const t2 = makeMeta("2", "ready", ["1"]);
  const t3 = makeMeta("3", "ready", [], true);
  const result = filterRunAfterAllTasks([t1, t2, t3], new Set(), new Set());
  expect(result.map(t => t.id)).toEqual(["3"]);
});
```

### テスト 5: 循環参照（不正データでも infinite loop しない）

```ts
test("循環参照していても無限ループせず空配列を返す", () => {
  const t1 = makeMeta("1", "ready", ["2"]);
  const t2 = makeMeta("2", "ready", ["1"]);
  const t3 = makeMeta("3", "ready", [], true);
  // T1, T2 は循環、いずれも draft/aborted ではないので normalActive に残る
  // → drain ブロックされ T3 は返らない（hang しないこと自体が検証対象）
  const result = filterRunAfterAllTasks([t1, t2, t3], new Set(), new Set());
  expect(result).toEqual([]);
});
```

> 検証ポイントは「終了する」こと。`expect(result)` は副次的観測。`bun test --timeout 30000` でタイムアウト守りも兼ねる。

### テスト 6: closed のみのチェーン（既存挙動維持）

```ts
test("closed のみのチェーンならブロッカーなし、T2 は normalActive に残り drain ブロック (既存挙動)", () => {
  const t1 = makeMeta("1", "closed");
  const t2 = makeMeta("2", "ready", ["1"]);
  const t3 = makeMeta("3", "ready", [], true);
  // closedIds に "1" を含めて呼ぶ（実環境で closed タスクは closedIds 経由で渡る）
  const result = filterRunAfterAllTasks([t1, t2, t3], new Set(["1"]), new Set());
  expect(result).toEqual([]);  // T2 が normalActive に残るので drain ブロック
});
```

> 補足: daemon では `openTasksList` から `closed` 状態タスクが除外されるため実環境では `tasks` に t1 が居ないが、ここでは「`isBlockedByDeadDep` が closed を見たときに `continue` で正しく処理する」ことを直接検証する。

### テスト 7: 削除済み依存（依存先 ID が tasks/byId に無い）

```ts
test("依存先タスクが削除済み（byId に無い）なら無視して既存挙動を維持", () => {
  const t2 = makeMeta("2", "ready", ["999"]);  // T999 は存在しない
  const t3 = makeMeta("3", "ready", [], true);
  const result = filterRunAfterAllTasks([t2, t3], new Set(), new Set());
  // T2 は normalActive に残る → drain ブロック → T3 は返らない（既存挙動）
  expect(result).toEqual([]);
});
```

---

## 5. 注意点・エッジケース

| 観点 | 対応 |
|------|------|
| **循環参照防止** | `visited: Set<string>` で BFS 訪問済みノードをスキップ。タスク本文のテスト 5 がこれを検証 |
| **削除済み依存（map に無い）** | `if (!dep) continue` で既存挙動を踏襲（normalActive に残す＝drain ブロック維持）。テスト 7 で検証 |
| **closed のチェーン** | `if (dep.status === "closed") continue` でそれより上は辿らない（closed は解消済み）。テスト 6 で検証 |
| **assigned/ready の中間ノード** | dead dep ではないので `queue.push(...dep.dependsOn)` で更に上を辿る。テスト 3 で検証 |
| **deleted ステータス** | daemon の `openTasksList` 段階で除外されるので tasks に含まれない。`byId` に居なければ `if (!dep) continue` で既存挙動 |
| **TaskMeta フィールド名** | TS では `dependsOn`（camelCase）。frontmatter / CLI flag は `depends_on` / `--depends-on`。テストの `makeMeta` も `dependsOn` を使う |
| **describe 内 makeMeta の重複** | 既存の `filterExecutableTasks` / `cascadeAbortToChildren` と同様に describe ローカルで定義。共通化はしない |
| **呼び出し側 daemon.ts の変更** | 不要。戻り値型は `TaskMeta[]` のまま |
| **`filterExecutableTasks` への波及** | 触らない（タスク本文「関連」セクション参照） |

---

## 6. 動作確認手順

### 6.1 単体テスト

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-387-1777447940/skills/cmux-team/manager
bun test --timeout 30000 task.test.ts
```

→ 追加した 7 テストケース全て pass、既存 `filterExecutableTasks` / `cascadeAbortToChildren` 等のテストもデグレなし。

### 6.2 manager 全テスト（CLAUDE.md 既知の注意点を遵守）

> ⚠️ `bun test` の引数なし全体実行は禁忌（O(N²) 級劣化で 13 分以上ハング、`.team/artifacts/A021-research.md` 参照）。**ファイルを 1 つずつ実行する形式を必ず使う。**

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-387-1777447940/skills/cmux-team/manager
for f in *.test.ts state-machine/*.test.ts dashboard-*.test.tsx; do
  bun test --timeout 30000 "$f"
done
```

→ 全ファイル green。

### 6.3 実環境での再現確認（任意）

修正前の状態で `cmux-team status` を実行し、以下のシナリオが drain block されていることを確認:
- T1=draft, T2=ready depends T1, T3=run_after_all ready

修正適用後、同じ task-state で T3 が assign 可能 (`pendingTasks` に含まれる) ことを確認。

---

## 7. Definition of Done（タスク本文より転記）

- [ ] `filterRunAfterAllTasks` で depends_on チェーンを再帰的に遡る実装が入っている
- [ ] 上記テスト 1〜7 が追加され pass する
- [ ] 既存テスト全 pass（`cd skills/cmux-team/manager && for f in *.test.ts state-machine/*.test.ts dashboard-*.test.tsx; do bun test --timeout 30000 "$f"; done`）
- [ ] PR 作成

---

## 設計判断サマリー

タスク本文に実装ロジックがほぼ完全に提示されているため Planner は基本的に追従する。Planner として確認・確定した点は以下の 3 点:

1. **TaskMeta フィールド名は `dependsOn` (camelCase)** — frontmatter / CLI の `depends_on` (snake_case) と混同しないこと
2. **`isBlockedByDeadDep` 相当は未実装** — `grep -rn` で 0 件、重複実装の懸念なし
3. **`isBlockedByDeadDep` は `filterRunAfterAllTasks` 内のローカル関数として実装** — 他に再利用しないため export 不要、`byId` をクロージャ共有で signature を簡潔に保つ
