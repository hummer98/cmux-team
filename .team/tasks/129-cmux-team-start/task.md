---
id: 129
title: cmux-team start 時にワークスペース名を起動フォルダ名に設定
priority: high
created_at: 2026-04-10T13:14:21.359Z
---

## タスク
## 問題
cmux-team start を実行すると、cmux のワークスペース一覧で表示されるタイトルが「cmux-team start」（コマンド名そのまま）になってしまう。

## 期待動作
ワークスペースのタイトルを起動時のフォルダ名（パスではなくフォルダ名のみ、例: cmux-team）にする。

## 修正方法

### 1. cmux.ts に renameWorkspace 関数を追加

```typescript
export async function renameWorkspace(title: string, workspace?: string): Promise<void> {
  const args = ["rename-workspace"];
  if (workspace) args.push("--workspace", workspace);
  args.push(title);
  await execFile("cmux", args).catch(() => {});
}
```

### 2. main.ts の cmdStart() で、daemon タブタイトル設定の直後にワークスペース名を設定

場所: main.ts 393行目付近（`// Conductor スロット作成` の前）

```typescript
// ワークスペース名を起動フォルダ名に設定
const folderName = basename(PROJECT_ROOT);
await cmux.renameWorkspace(folderName, state.workspace);
```

basename は path モジュールから import する（既に import 済みの場合はそのまま使用）。
