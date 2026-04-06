# T096: ダッシュボードTasksスクロールバグ修正 — 実装計画

## バグ原因分析

### 根本原因: `daemon.ts` の `taskList` 生成ロジックが合計件数を5件に制限している

**該当コード**: `skills/cmux-team/manager/daemon.ts:603`

```typescript
const maxItems = Math.max(5, openTasks.length);
const combined = [...openTasks, ...closedTasks.slice(0, maxItems - openTasks.length)];
```

このロジックの意図は「open タスクを全て表示 + 残り枠で closed タスクを表示（最低5件）」だが、**open タスクが5件以下の場合、合計が常に5件で打ち止め**になる。

例:
- open 3件 + closed 20件 → `maxItems = max(5, 3) = 5` → combined = 3 + 2 = **5件**
- open 8件 + closed 20件 → `maxItems = max(5, 8) = 8` → combined = 8 + 0 = **8件**

ダッシュボード側のスクロールロジック（`dashboard.tsx:752-758`）自体は正常。`taskCursor` は `taskList.length - 1` まで動けるが、そもそも `taskList` が5件しかないためスクロールが5件で止まって見える。

### ダッシュボード側の補足的問題: `TASK_VISIBLE_LINES = 5` のハードコード

**該当コード**: `skills/cmux-team/manager/dashboard.tsx:23`

```typescript
const TASK_VISIBLE_LINES = 5;
```

ビューポートが5行固定のため、`taskList` の件数上限を増やしても一度に5件しか見えない。Journal（30行）や Log（30行）と比較して著しく少ない。ただしこれは直接の原因ではなく、スクロール自体は正しくビューポートを追従するため、根本原因の修正が先。

## 修正方針

### 1. `daemon.ts` の `taskList` 件数上限を撤廃（必須修正）

`maxItems` の計算を変更し、全 open タスク + 直近 closed タスクを十分に含めるようにする。

**変更前** (`daemon.ts:603`):
```typescript
const maxItems = Math.max(5, openTasks.length);
const combined = [...openTasks, ...closedTasks.slice(0, maxItems - openTasks.length)];
```

**変更後**:
```typescript
const MAX_CLOSED_DISPLAY = 20;
const combined = [...openTasks, ...closedTasks.slice(0, MAX_CLOSED_DISPLAY)];
```

ポイント:
- open タスクは全件表示（制限なし）
- closed タスクは直近20件まで表示（無制限にするとリストが肥大化するため上限を設ける）
- 合計件数の人為的な上限（`maxItems = 5`）を撤廃

### 2. `dashboard.tsx` の `TASK_VISIBLE_LINES` を増やす（UX 改善）

**変更前** (`dashboard.tsx:23`):
```typescript
const TASK_VISIBLE_LINES = 5;
```

**変更後**:
```typescript
const TASK_VISIBLE_LINES = 15;
```

ポイント:
- 15行にすることで、多数タスクのある状況でも十分な一覧性を確保
- Journal/Log の30行よりは少ないが、Tasks セクションは中間パネルなのでバランスを考慮
- 将来的にはターミナル高さに応じた動的計算も検討できるが、今回はシンプルに固定値を増やす

## 修正手順

1. `skills/cmux-team/manager/daemon.ts:603` を編集
   - `maxItems` の計算を削除
   - `combined` の構成を `[...openTasks, ...closedTasks.slice(0, 20)]` に変更
2. `skills/cmux-team/manager/dashboard.tsx:23` を編集
   - `TASK_VISIBLE_LINES` を `5` → `15` に変更
3. 動作確認

## テスト方針

1. **5件超のタスクが存在する状態**で `cmux-team start` を実行し、ダッシュボードの Tasks セクションを確認
   - 6件以上のタスクが表示されること
   - `T` キーでフォーカスし、↑/↓キーで全タスクをスクロールできること
2. **open タスク 0件 + closed タスク 20件超**の状態で確認
   - closed タスクが最大20件表示されること
3. **open タスク 20件超**の状態で確認
   - 全 open タスクが表示されること（上限なし）
4. スクロール時にカーソル選択（下線表示）がビューポートに追従すること
