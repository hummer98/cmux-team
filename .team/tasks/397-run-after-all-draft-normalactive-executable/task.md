---
id: 397
title: run_after_all が draft 経由で間接デッドロックする（normalActive を executable ベースに修正）
priority: medium
created_by: surface:483
created_at: 2026-04-30T12:16:05.877Z
---

## タスク
## 背景

`filterRunAfterAllTasks` (`skills/cmux-team/manager/task.ts:472-509`) の `normalActive` 判定が `status === "ready"` だけを条件にしているため、**ready だが depends_on が未解決（特に依存先が draft）のタスク** が run_after_all を間接的にロックする。

## 再現シナリオ

```
T-A: status=ready, depends_on=[T-B]
T-B: status=draft     （Master が保留中）
T-C: status=ready, run_after_all=true
```

現状の挙動:
- `closedIds` に T-B は入らない（draft は `isTerminalStatus` 対象外）
- T-A は `filterExecutableTasks` で弾かれる（dep 未解決）→ 実行不能
- 一方 `filterRunAfterAllTasks` の `normalActive` は `status === "ready"` のみ判定 → T-A がカウントされる
- 結果: T-C は永久に発火しない（T-B を delete するか ready 化しない限り）

## 設計上の問題

`task.ts:469-470` のコメント:
> 条件: 通常タスク（run_after_all でない、かつ run_after_all タスクに depends_on しているものを除く）の ready + assigned が 0

この設計は「draft が後で ready 化されたら chain が繋がるから待つ」という保守的な意図に見えるが、実態として「draft で止まっているタスクが run_after_all を人質に取る」状態を生む。draft は Master の保留状態であり、いつ ready 化されるか保証がないため、run_after_all の発火条件として待つのは設計として弱い。

## 修正方針

`normalActive` を「実行中 or 即実行可能」のタスク集合に絞る:

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

これにより:
| 状態 | 修正後の挙動 |
|------|-------------|
| ready で dep 全て terminal | normalActive に入る → run_after_all をブロック |
| ready だが dep に draft あり | normalActive に入らない → ブロックしない |
| ready だが dep に ready/assigned あり | dep 自身が normalActive に入る（連鎖でブロック維持） |
| assigned | normalActive に入る → ブロック |

## 副作用（許容可能と判断）

- draft が後で ready 化されたとき、その時点でスキャンすると新たな ready chain と既存の run_after_all 後続が並走する可能性がある
- これは「draft で止めていた = 並走しても問題ない作業」と解釈できるため許容する
- 並走を避けたいユーザーは draft を delete するか --exclusive を使うべき

## 完了条件

- [ ] `filterRunAfterAllTasks` の `normalActive` フィルタを executable ベースに修正
- [ ] 新規テスト: ready で dep が draft のタスクが存在しても run_after_all が発火する
- [ ] 既存テスト: ready で dep が解決済みのタスクは run_after_all をブロックする（regression）
- [ ] 既存テスト: assigned タスクは run_after_all をブロックする（regression）
- [ ] `cd skills/cmux-team/manager && bun test --timeout 30000 task.test.ts daemon-*.test.ts` が green

## 関連

- T393: tokens.db migration FK 修正（独立タスク。この T394 とは無関係）
- run_after_all + exclusive の semantics は `docs/spec/07-state-machine.md` を参照

## やらないこと（スコープ外）

- draft の semantic 全体の見直し（保留 vs 予定の議論）
- depends_on 周りの可視化改善（dashboard で「stuck」を表示する等）
- run_after_all の名前変更や API 変更
