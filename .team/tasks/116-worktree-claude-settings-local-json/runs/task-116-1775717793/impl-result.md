# Task 116 実装結果: worktree 作成時に `.claude/settings.local.json` をコピー

## 変更ファイル

- `skills/cmux-team/manager/conductor.ts`

## 変更内容

### 1. import 修正 (L7, L8)

**before:**
```ts
import { readFile, mkdir, readdir, rm, stat } from "fs/promises";
import { join, relative } from "path";
```

**after:**
```ts
import { readFile, mkdir, readdir, rm, stat, copyFile } from "fs/promises";
import { join, relative, dirname } from "path";
```

- `fs/promises` に `copyFile` を追加
- `path` に `dirname` を追加

### 2. 追加コードブロック (L250-L262)

`assignTask` 関数内、`git worktree add` 直後 (L246-L248) と npm install ブロック (L263-) の間に挿入:

```ts
    // .claude/settings.local.json を worktree にコピー
    // （untracked なので worktree に含まれないが、Agent 起動時に必要）
    const settingsSrc = join(projectRoot, ".claude/settings.local.json");
    if (existsSync(settingsSrc)) {
      const settingsDst = join(worktreePath, ".claude/settings.local.json");
      await mkdir(dirname(settingsDst), { recursive: true })
        .then(() => copyFile(settingsSrc, settingsDst))
        .then(() => log("settings_copied_to_worktree", `worktree=${worktreePath}`))
        .catch(async (e: any) => {
          await log("error", `settings copy failed: worktree=${worktreePath} ${e.message}`);
        });
    }
```

## 検証結果

### 型チェック (`bunx tsc --noEmit`)

- `conductor.ts` については **型エラーなし**
- `dashboard.tsx` に 2 件の型エラーが出るが、これは**既存の問題**（stash 状態で同じエラーが出ることを確認済み）。本タスクの変更とは無関係

```
dashboard.tsx(342,5): error TS2322: Type '"unstyled"' is not assignable to type 'WidgetVariant | undefined'.
dashboard.tsx(862,11): error TS2322: Type '"unstyled"' is not assignable to type 'WidgetVariant | undefined'.
```

### 既存テスト (`bun test`)

```
 48 pass
 0 fail
 105 expect() calls
Ran 48 tests across 4 files. [479.00ms]
```

**全 48 テスト pass**。`daemon.test.ts` / `proxy.test.ts` / `queue.test.ts` / `task.test.ts` ともに問題なし。

### git diff 要約

- `conductor.ts` のみ変更
- import 2 行修正（`copyFile`, `dirname` を追加）
- `assignTask` 内の worktree add 直後に 13 行のコピーブロックを追加
- 合計 +13 行 / -2 行、計 +15 行 / -2 行の変更

```diff
@@ -4,8 +4,8 @@
 import { execFile as execFileCb } from "child_process";
 import { promisify } from "util";
 import { existsSync } from "fs";
-import { readFile, mkdir, readdir, rm, stat } from "fs/promises";
-import { join, relative } from "path";
+import { readFile, mkdir, readdir, rm, stat, copyFile } from "fs/promises";
+import { join, relative, dirname } from "path";

@@ -247,6 +247,19 @@ export async function assignTask(
       cwd: projectRoot,
     });

+    // .claude/settings.local.json を worktree にコピー
+    // （untracked なので worktree に含まれないが、Agent 起動時に必要）
+    const settingsSrc = join(projectRoot, ".claude/settings.local.json");
+    if (existsSync(settingsSrc)) {
+      const settingsDst = join(worktreePath, ".claude/settings.local.json");
+      await mkdir(dirname(settingsDst), { recursive: true })
+        .then(() => copyFile(settingsSrc, settingsDst))
+        .then(() => log("settings_copied_to_worktree", `worktree=${worktreePath}`))
+        .catch(async (e: any) => {
+          await log("error", `settings copy failed: worktree=${worktreePath} ${e.message}`);
+        });
+    }
+
     // worktree ブートストラップ
     if (existsSync(join(worktreePath, "package.json"))) {
```

## 実装方針の確認

- [x] plan.md の指示通り `assignTask` 関数の `git worktree add` 直後・npm install ブロック前に挿入
- [x] 既存の npm install の `.catch()` スタイルに合わせたエラーハンドリング
- [x] `existsSync` ガードで settings ファイル不在時は早期 return（ログなし）
- [x] `.claude/` ディレクトリが無い可能性があるため `mkdir(dirname, {recursive:true})` で先に作成
- [x] ログイベント名は CLAUDE.md のポリシーに沿って `settings_copied_to_worktree`（状態変化）/ `error`（失敗）
- [x] fatal にしない（コピー失敗しても `assignTask` は続行）
- [x] テンプレートには触っていない（本タスクは conductor.ts のみ）

## 完了条件チェックリスト

- [x] `conductor.ts` の import 2 行が修正されている
- [x] `assignTask` 関数の worktree add 直後・npm install 前にコピーブロックが追加されている
- [x] 既存テストが全て pass する (48 pass / 0 fail)
- [ ] 手動動作確認（E2E）→ 別途 Conductor 側で確認
- [ ] manager.log に `settings_copied_to_worktree` が記録される → 別途 E2E で確認

## 注記

- **コミットは未実施**。指示通り Conductor 側で最終コミットを行うため、実装のみで停止。
- `package-lock.json` の変更は `bun install` によるものだが、今回のタスクとは無関係。必要に応じて Conductor 側で除外/コミット判断をお願いします。
