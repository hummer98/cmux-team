# T094: ダッシュボードTasksのアイテム行全体をクリック可能にする

## 背景

ダッシュボード TUI の Tasks セクションで、現在はセパレータ（`─ Tasks N open ──`）部分のみが `ui.button` でクリック可能。各タスクアイテム行は `ui.row()` で描画されておりクリックに反応しない。

## 修正方針

### 1. タスク行を `ui.button` でラップ

`buildTaskRow()` の返り値を `ui.button` でラップし、行全体をクリック可能にする。

**変更箇所**: `dashboard.tsx` 730-738行付近（`visibleTasks.map` 内）

**動作**: クリックで `focusedArea: "tasks"` + `taskCursor` をクリックした行のインデックスに設定。すでに tasks にフォーカス中なら、カーソルを移動するだけ。

### 2. セパレータのクリックハンドラ統合

セパレータ（761-769行）は `ui.button` のまま残す。各タスク行が個別にクリック可能になったため、セパレータクリックは引き続きフォーカス移動のみの役割を果たす（削除不要）。

### 3. 実装詳細

`visibleTasks.map` のコールバック内で:

```tsx
const globalIdx = taskStartIdx + i;
const isSelected = globalIdx === state.taskCursor;
const cursorStyle = tasksFocused && isSelected ? { style: { underline: true } } : undefined;
const row = buildTaskRow(task, assignedTaskIds.has(task.id), repoUrl, cursorStyle);

return ui.button({
  id: `task-${task.id}`,
  label: row,  // ui.button の label に ui.row を渡す（rezi-ui は対応している）
  px: 0,
  dsVariant: "ghost",
  focusable: false,
  onPress: () => {
    try {
      app.update((s) => ({
        ...s,
        focusedArea: "tasks",
        taskCursor: globalIdx,
      }));
    } catch {}
  },
});
```

**注意点**:
- `ui.button` の `label` に `ui.row` コンポーネントを渡せるか要確認。rezi-ui の API 仕様次第で、label は文字列のみの可能性がある
- その場合は、`buildTaskRow()` 自体を `ui.button` ベースに書き換える（行全体をボタンにする）

### 4. フォールバック案

`ui.button` の `label` が文字列のみの場合:
- `buildTaskRow()` の返り値を `ui.row` → `ui.button` に変更し、`onPress` コールバックを引数で受け取るようにする

## 対象ファイル

- `skills/cmux-team/manager/dashboard.tsx`

## 完了条件

- タスク行全体がクリック可能
- クリックでタスクにフォーカス + カーソル移動
- 既存のキーボード操作（↑/↓）が引き続き動作
- セパレータクリックも引き続き動作
