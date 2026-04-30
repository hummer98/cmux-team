---
id: 387
title: run_after_all drain 判定で depends_on を再帰的に遡って draft/aborted をブロッカー扱い
priority: high
created_by: surface:141
created_at: 2026-04-29T07:32:20.199Z
---

## タスク
## 問題

`filterRunAfterAllTasks` (`skills/cmux-team/manager/task.ts:472`) の `normalActive` 判定が、ready タスクの **直接の status のみ** を見ているため、以下のシナリオで `run_after_all` タスクが永久に drain 通過しない:

- T1: `draft`（ユーザーが ready 昇格してない、放置されている）
- T2: `ready`, `depends_on T1`
- T3: `run_after_all`, `ready`

T2 は `ready` なので `normalActive` に含まれ → drain ブロック → T3 が永久に走らない。
だが T1 が `draft` のままなので T2 自体も永久に assign されない（デッドロック）。

実害として既に発生中。

## 期待する挙動

`ready` タスクの `depends_on` チェーンを再帰的に遡り、チェーン上に `draft` または `aborted` のタスクが存在すれば、その ready タスクは「進む見込みがない」として `normalActive` から除外する。

→ T3（run_after_all）が drain 判定を通過して実行される。

なお `aborted` を含めるのは cascade 漏れバグの保険（原理的には cascade で子も aborted 化されるため depends_on 先が aborted な ready は存在しないはず）。

## 実装方針

### 対象ファイル

- `skills/cmux-team/manager/task.ts:472` `filterRunAfterAllTasks`

### ロジック

```ts
// すべてのタスクを id で引けるマップ
const byId = new Map(tasks.map(t => [t.id, t]));

// ready タスクが「ブロックされた依存」を持つか判定（BFS、循環防止）
function isBlockedByDeadDep(task: TaskMeta): boolean {
  const visited = new Set<string>();
  const queue: string[] = [...task.dependsOn];
  while (queue.length > 0) {
    const depId = queue.shift()!;
    if (visited.has(depId)) continue;
    visited.add(depId);
    const dep = byId.get(depId);
    if (!dep) continue;  // 削除済みは無視（既存挙動）
    if (dep.status === "draft" || dep.status === "aborted") return true;
    if (dep.status === "closed") continue;  // 解消済み、これより上は辿らない
    // ready / assigned はさらに上を辿る
    queue.push(...dep.dependsOn);
  }
  return false;
}

const normalActive = tasks.filter(t =>
  !t.runAfterAll &&
  !dependsOnRunAfterAll.has(t.id) &&
  (t.status === "ready" || assignedIds.has(t.id)) &&
  !isBlockedByDeadDep(t)  // ← 追加
);
```

### エッジケース

- 循環参照: `visited` Set で防止（既存の create-task が循環を許すかは別問題、ここでは安全に止める）
- depends_on 先が削除済み（map にない）: 無視（既存挙動を踏襲）
- depends_on chain 上の中間ノードが ready: そのノードはさらに depends_on を辿る
- assigned: assigned は進行中なのでブロッカーではない（チェーン辿りは継続）

## テスト

`skills/cmux-team/manager/task.test.ts` または `tasks-status.test.ts` に追加:

1. **再現テスト**: T1=draft, T2=ready depends T1, T3=run_after_all ready → T3 が `filterRunAfterAllTasks` の戻り値に含まれる
2. **直接 draft 依存**: T1=draft, T2=ready depends T1 → T2 はブロック扱い
3. **2 段間接 draft**: T1=draft, T2=ready depends T1, T3=ready depends T2, T4=run_after_all ready → T4 drain OK
4. **aborted 依存**: T1=aborted, T2=ready depends T1, T3=run_after_all ready → T4 drain OK（保険ケース）
5. **循環**: T1=ready depends T2, T2=ready depends T1（不正データだが）→ infinite loop しない
6. **closed のみのチェーン**: T1=closed, T2=ready depends T1, T3=run_after_all ready → T2 は normalActive に残り T3 はブロック（既存挙動を維持）
7. **依存先削除済み**: T2=ready depends "T999"（存在しない）→ 既存挙動（normalActive に残る）

## 動作確認

修正後、実環境で:

1. `cmux-team status` で run_after_all task が drain ブロックされているか確認
2. 修正適用 → bun test で全テスト pass
3. 該当 run_after_all task が assign されることを確認

## 関連

- 既存の `filterExecutableTasks` (task.ts:443) は通常タスクの実行可否判定であり、`depends_on` の **直接の closed** だけ見れば十分（依存元が draft でも、その draft が ready 化された時点で次の判定が走るため）。今回の修正は `filterRunAfterAllTasks` の drain 判定に閉じる。
- 設計原則: state を外部化（task-state.json + Task FSM）。drain 判定は外部 state を pull で観測するのみ。

## Definition of Done

- [ ] `filterRunAfterAllTasks` で depends_on チェーンを再帰的に遡る実装が入っている
- [ ] 上記テスト 1〜7 が追加され pass する
- [ ] 既存テスト全 pass（`cd skills/cmux-team/manager && for f in *.test.ts state-machine/*.test.ts dashboard-*.test.tsx; do bun test --timeout 30000 "$f"; done`）
- [ ] PR 作成
