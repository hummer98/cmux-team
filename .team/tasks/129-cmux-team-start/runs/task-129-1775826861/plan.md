# 実装計画: cmux-team start 時にワークスペース名を起動フォルダ名に設定

## 概要

`cmux-team start` 実行時、cmux のワークスペースタイトルが「cmux-team start」（コマンド名）になる問題を修正。起動フォルダ名（例: `cmux-team`）に設定する。

## 変更対象ファイル

1. `skills/cmux-team/manager/cmux.ts` — `renameWorkspace` 関数を追加
2. `skills/cmux-team/manager/main.ts` — `cmdStart()` 内でワークスペース名を設定

## 変更詳細

### 1. cmux.ts: renameWorkspace 関数追加

`renameTab` 関数の直後（88行目付近）に追加:

```typescript
export async function renameWorkspace(title: string, workspace?: string): Promise<void> {
  const args = ["rename-workspace"];
  if (workspace) args.push("--workspace", workspace);
  args.push(title);
  await execFile("cmux", args).catch(() => {});
}
```

- 既存の `renameTab` と同じパターン（失敗時は catch で握りつぶし — 冪等な後処理のため許容）

### 2. main.ts: cmdStart() にワークスペース名設定を追加

393行目の daemon タブタイトル設定の直後、395行目の Conductor スロット作成の前に挿入:

```typescript
// ワークスペース名を起動フォルダ名に設定
const folderName = basename(PROJECT_ROOT);
await cmux.renameWorkspace(folderName, state.workspace);
```

import 文の変更:
```typescript
// 変更前
import { join, dirname } from "path";
// 変更後
import { join, dirname, basename } from "path";
```

## リスク

- 低リスク。`renameWorkspace` は失敗しても catch で無視するため、既存動作に影響なし
- `cmux rename-workspace` コマンドが存在しない場合も catch で安全に無視される
