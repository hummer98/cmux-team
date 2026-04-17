---
id: 241
title: depends_on 親が abort/deleted になったら ready 子を draft に戻す
priority: medium
created_by: surface:47
created_at: 2026-04-17T10:37:41.686Z
---

## タスク
## 背景

現状、depends_on の親タスクが \`aborted\` / \`deleted\` になると、daemon の依存解決セットは closed と同等に扱うため、子タスクが自動的に assigned される。

該当箇所: \`daemon.ts:1728-1732\`

```typescript
const closed = new Set(
  Object.entries(taskState)
    .filter(([_, s]) => s.status === "closed" || s.status === "aborted" || s.status === "deleted")
    .map(([id]) => id)
);
```

親が予期せず中断されたのに子が前提崩れのまま自動起動するのは危険。人間の判断を挟みたい。

## 仕様

タスク X が `aborted` に遷移した瞬間、`depends_on` に X を含む open な子タスクを以下のルールで処理する:

| 子の状態 | 処理 |
|---|---|
| `draft` | 変更なし |
| `ready` | **`draft` に戻す** |
| `assigned` | 変更なし（既に走っている作業は止めない） |
| `closed` / `aborted` / `deleted` | 変更なし |

### 補足挙動

- 子タスクの journal に `parent_aborted: <parentTaskId>` を追記（理由追跡用）
- 複数 depends_on のうち **1 つでも abort** したら draft に戻す（AND 条件なので前提が崩れる）
- `deleted` も同様に扱う（`--journal` 付きで delete された場合も含む）
- TUI 側は既存の draft 表示をそのまま使う（特別対応不要）

### ログ

state 遷移時に `child_reverted_to_draft parent=<X> child=<Y> reason=parent_aborted` を記録。

## 影響範囲

子を `ready → draft` に戻すのは `abort` 側の責務として daemon 内で cascade する。以下の abort 経路すべてで cascade を走らせる:

1. TASK_ABORT メッセージ経由（明示 abort）
2. Conductor forced close 経路（`forceCloseDisconnectedConductor`）
3. user_clear 経路（`daemon.ts:1664` 近辺）
4. `assign_failed` 経路（`daemon.ts:1820` 近辺）
5. `deleted` 化する `delete-task` CLI 経路

共通関数として `cascadeAbortToChildren(state, parentTaskId)` を切り出し、各経路から呼び出す方針が素直。

## 実装タスク

1. `daemon.ts` に cascade 関数を実装
2. 上記 5 経路から呼び出す
3. テスト追加: `daemon.test.ts` で以下をカバー
   - 親 abort → 子 ready が draft に戻る
   - 親 abort → 子 assigned は維持
   - 親 delete → 子 ready が draft に戻る
   - 複数 depends_on のうち 1 つが abort でも draft に戻る
   - 孫世代（A → B → C）で A abort の際、B が ready なら draft、C は変化なし（B が draft になり closed でなくなるため C は待機続行）
4. ドキュメント更新: `CLAUDE.md` の「タスク間依存」「エラーリカバリ」セクションに cascade 挙動を明記

## 受け入れ条件

- 親が abort/deleted になった瞬間に、ready 子が自動で draft に戻る
- 子の journal / task body から理由が追跡できる
- 既存の正常系（親 closed → 子 assigned）に回帰なし

## 関連

- T239（cmux-team resume の cwd バグ）と同時リリースしてよい独立タスク
