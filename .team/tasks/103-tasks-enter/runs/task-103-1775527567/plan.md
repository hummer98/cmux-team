# Plan: Tasks タブ Enter キーでタスクドキュメント表示

## 概要

dashboard.tsx の Tasks タブで Enter 押下時に、選択中タスクの Markdown ファイルを glow（フルスクリーンページャー）で表示する。

## 変更ファイル

1. `skills/cmux-team/manager/daemon.ts` — `TaskSummary` に `filePath` フィールド追加
2. `skills/cmux-team/manager/dashboard.tsx` — Enter キーハンドラに tasks 分岐追加、ヘルプ表示更新

## 変更詳細

### 1. daemon.ts: TaskSummary に filePath を追加

**場所:** L21-30 `TaskSummary` interface

```typescript
export interface TaskSummary {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  closedAt?: string;
  abortedAt?: string;
  dependsOn: string[];
  baseBranch?: string;
  filePath?: string;  // 追加: タスクファイルのパス
}
```

**場所:** L605-614 `scanTasks` 内の `state.taskList` 生成

`combined` の元データ（`tasks: TaskMeta[]`）は `filePath` を持っているので、そのまま転記する。

### 2. dashboard.tsx: Enter キーハンドラの修正

**場所:** L995-1013 Enter ハンドラ

現在 `focusedArea !== "artifacts"` で return しているが、`focusedArea === "tasks"` の分岐を追加。

```typescript
Enter: (ctx) => {
  const currentState = ctx.state;
  // tasks タブ: 選択中タスクをビューアで開く
  if (currentState.focusedArea === "tasks") {
    const { taskList } = currentState.daemon;
    const selected = taskList[currentState.taskCursor];
    if (!selected?.filePath) return;
    openArtifactInViewer(app, selected.filePath, () => { /* resume処理 */ }).catch(...);
    return;
  }
  // artifacts タブ（既存）
  if (currentState.focusedArea !== "artifacts") return;
  // ... 既存コード
}
```

### 3. dashboard.tsx: ヘルプ表示の更新

**場所:** L897-901 tasks フォーカス時のキーバインド表示

```
ui.kbd("Enter"), ui.text("open"),
```
を既存の `↑/↓ scroll` と `ESC back` の間に追加。

## 既存の仕組み（そのまま再利用）

- `resolveMarkdownViewer()` (L111-119): CMUX_MD_VIEWER → glow → cat の優先順
- `openArtifactInViewer()` (L693-730): TUI 停止 → glow フルスクリーン → TUI 復帰
- 関数名は変更不要（内部実装は汎用的で artifact 固有のロジックなし）
