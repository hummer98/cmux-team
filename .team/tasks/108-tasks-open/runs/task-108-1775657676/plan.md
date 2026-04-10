# 実装計画: ダッシュボード Tasks の並び順を修正

## 1. 修正対象のコード特定

**ファイル**: `skills/cmux-team/manager/daemon.ts` L598-600

### 現在のコード

```typescript
const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
const openTasks = [...openTasksList]
  .sort((a, b) => (priorityOrder[a.priority] ?? 1) - (priorityOrder[b.priority] ?? 1));
```

open タスクを `priority`（high → medium → low）でソートしている。同一 priority 内の順序は不定。

## 2. 具体的な変更内容

### daemon.ts L598-600

priority ソートを廃止し、`createdAt`（ISO 8601 文字列）の降順にソートする。

```typescript
const openTasks = [...openTasksList]
  .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
```

**変更点**:
- `priorityOrder` の定義（L598）を削除
- ソート基準を `priority` → `createdAt` 降順（新しいものが上）に変更

**`closedTasks` のソート（L601-603）は変更不要** — 既に `closedAt` / `abortedAt` 降順で正しい。

## 3. テスト計画

### daemon.test.ts に追加するテストケース

`describe("taskList の並び順")` ブロックを新設し、以下のテストを追加する。

#### テスト 3-1: open タスクは createdAt 降順で並ぶ

```typescript
test("open タスクは createdAt の降順で並ぶ", async () => {
  // created_at が異なる3つのタスクを作成（createTask を時間差で呼ぶか、
  // created_at を明示的に指定）
  // → taskList の open 部分が新しい順に並ぶことを検証
});
```

**ポイント**: `createTask` ヘルパーに `createdAt` オプションを追加し、任意の ISO 8601 日時を指定できるようにする。

#### テスト 3-2: open タスクが closed タスクより上に来る

```typescript
test("open タスクが closed タスクより上に並ぶ", async () => {
  // open タスクと closed タスクを混在させて作成
  // → taskList で open が全て上、closed が全て下に並ぶことを検証
});
```

#### テスト 3-3: priority はソート順に影響しない

```typescript
test("priority はソート順に影響しない", async () => {
  // low priority で新しいタスク、high priority で古いタスクを作成
  // → 新しい low が古い high より上に来ることを検証
});
```

### テスト実装の前提

daemon.ts の taskList 構築ロジックはプライベート関数（`tick()` 内）のため、直接テストが難しい。以下のいずれかのアプローチを取る:

**推奨: ソートロジックを関数として抽出**

```typescript
// task.ts または daemon.ts に追加
export function sortOpenTasksByCreatedAt(tasks: TaskMeta[]): TaskMeta[] {
  return [...tasks].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}
```

これにより単体テストが容易になる。ただし、タスク指示では daemon.ts の L598-605 の修正のみが指定されているため、**インライン修正 + createTask ヘルパーの拡張によるテスト** を優先する。

### createTask ヘルパーの変更

```typescript
async function createTask(
  id: string,
  slug: string,
  opts: {
    status?: string;
    priority?: string;
    dependsOn?: string[];
    content?: string;
    createdAt?: string;  // 追加
  } = {}
): Promise<void> {
  const {
    status = "ready",
    priority = "medium",
    dependsOn,
    content = "テストタスク",
    createdAt = new Date().toISOString(),  // 変更
  } = opts;

  let yaml = `---
id: ${id}
title: ${slug}
priority: ${priority}
created_at: ${createdAt}`;
  // ...
}
```

### テストの実行方法

taskList の構築をテストするため、ソートロジックを `task.ts` に `sortOpenTasksByCreatedAt` として切り出してエクスポートし、テストから直接呼ぶ。

## 4. 影響範囲の確認

| 影響箇所 | 影響内容 | リスク |
|---------|---------|-------|
| ダッシュボード表示 | open タスクの表示順が priority 順 → 作成日時順に変わる | 低: UI 表示のみ |
| タスク実行順序 | **変更なし** — `sortByPriority` は `executable` のソートに使われており、そちらは今回の変更対象外 | なし |
| closed タスクの表示 | **変更なし** — closedAt 降順のまま | なし |
| `sortByPriority` 関数 | **変更なし** — 実行可能タスクのソート（L589）は引き続き priority ベース | なし |

**重要**: タスクの**実行優先順位**（`sortByPriority`）は変更しない。変更するのは**ダッシュボード表示の並び順**のみ。
