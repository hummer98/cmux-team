# T270 implementation summary

## 対象バグ

新規プロジェクトで初回 `cmux-team start` 実行時、`persistMainBranch` が
`.team/` を作成する前に `.team/config.json` へ writeFile しようとして ENOENT
で失敗する。

```
ENOENT: no such file or directory, open '<projectRoot>/.team/config.json'
  at async persistMainBranch (skills/cmux-team/manager/main-branch.ts:96:9)
  at async cmdStart (skills/cmux-team/manager/main.ts:316:11)
```

## 変更ファイル（diff 概要）

### `skills/cmux-team/manager/main-branch.ts`

- `fs/promises` の import に `mkdir` を追加
- `persistMainBranch` 関数の先頭で `.team/` を `mkdir(..., { recursive: true })` し、
  その結果を使って `configPath` を組み立てるように変更

```diff
-import { readFile, writeFile } from "fs/promises";
+import { readFile, writeFile, mkdir } from "fs/promises";
 ...
 export async function persistMainBranch(
   projectRoot: string,
   branch: string,
 ): Promise<void> {
-  const configPath = join(projectRoot, ".team/config.json");
+  const teamDir = join(projectRoot, ".team");
+  await mkdir(teamDir, { recursive: true });
+  const configPath = join(teamDir, "config.json");
   ...
 }
```

### `skills/cmux-team/manager/main-branch.test.ts`

`.team/` が無い状態で `persistMainBranch` を呼んでも ENOENT にならず
config.json が作成されることを検証する回帰テストを追加。

```diff
 describe("persistMainBranch", () => {
+  test(".team ディレクトリが無くても ENOENT にならず作成する (T270)", async () => {
+    await persistMainBranch(testDir, "main");
+    const parsed = JSON.parse(
+      await readFile(join(testDir, ".team/config.json"), "utf-8"),
+    );
+    expect(parsed).toEqual({ mainBranch: "main" });
+  });
```

## テスト結果

- `bun test main-branch.test.ts` — **15 pass / 0 fail**（新規 1 + 既存 14）
- `bun test`（全体） — **598 pass / 0 fail** across 25 files

既存テストは `.team/` 事前作成パターン（mkdir 呼び出し）を踏襲しているが、
mkdir が冪等（`recursive: true`）なので影響なし。

## 手動検証で確認した挙動

- `.team/` 未作成 → `persistMainBranch(tmpDir, "main")` 呼び出しで
  `tmpDir/.team/config.json` が `{"mainBranch":"main"}` として生成される
  （新規テストで自動検証）
- 既存 `.team/config.json` に `layout: "wide"` 等がある場合、
  `mainBranch` は上書き、他フィールドは保持される（既存テストが検証）
- 壊れた JSON の config.json があっても空オブジェクトから書き直す
  （既存テストが検証）

## 実装中に気づいた懸念事項

- `cmdStart` 全体の初期化順序（`resolveMainBranch` → `persistMainBranch` →
  `createDaemon`/`initInfra`）自体は変えていない。`initInfra` 側の責務を
  前倒しするアプローチは副作用が大きく、本タスクのスコープ外と判断した。
- 他にも `.team/` 不在で writeFile する箇所がないか念のため `rg` で確認推奨
  （今回は範囲を指示通り `main-branch.ts` のみに限定）。
