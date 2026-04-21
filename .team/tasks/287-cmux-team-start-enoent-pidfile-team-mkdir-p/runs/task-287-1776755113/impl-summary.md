# T287 実装サマリ — pidfile 取得前に `.team/` を mkdir -p

## 採用案

**案 B**: `pidfile.ts:acquirePidFile` 内で `await mkdir(dirname(path), {recursive:true})` を `writeFile(..., {flag:"wx"})` の前に実行。pidfile モジュール自身が自分の格納先を作る責務を持つ方向で解決。

## 変更ファイル一覧

| ファイル | 変更行数 | 内容 |
|---|---|---|
| `skills/cmux-team/manager/pidfile.ts` | +9 / -1 | import に `mkdir` / `dirname` を追加、`acquirePidFile` 先頭で `await mkdir(dirname(path), {recursive:true})` |
| `skills/cmux-team/manager/pidfile.test.ts` | +19 / -0 | `describe("acquirePidFile - missing parent directory", ...)` を 2 ケース追加 |

`git diff HEAD --stat` 出力:

```
skills/cmux-team/manager/pidfile.test.ts | 19 +++++++++++++++++++
skills/cmux-team/manager/pidfile.ts      |  9 ++++++++-
2 files changed, 27 insertions(+), 1 deletion(-)
```

plan.md が「`main.ts` は触らない」と明示しているとおり、`main.ts` / `daemon.ts` / 他モジュール / `CLAUDE.md` / `docs/spec/` への変更は無し。

## 具体的な差分

### `skills/cmux-team/manager/pidfile.ts`

```diff
-import { writeFile, unlink, readFile } from "fs/promises";
+import { writeFile, unlink, readFile, mkdir } from "fs/promises";
+import { dirname } from "path";
 import { execFile } from "child_process";
```

`acquirePidFile` 本体、`opts` デストラクチャ直後（`let attempt = 0` の前）:

```diff
   const psImpl = opts?.psCommandImpl ?? psCommand;
   const aliveImpl = opts?.isAliveImpl ?? realIsAlive;

+  // T287: pidfile の格納先（通常は <workspace>/.team/）が存在しない場合に備えて
+  // 先に recursive mkdir する。新規フォルダ（git init 直後で .team/ 未作成）で
+  // cmux-team start を実行すると、daemon.ts:initInfra より前に pidfile 取得が
+  // 走るため ENOENT になる問題（T287）への対処。recursive:true なので既存時は no-op。
+  await mkdir(dirname(path), { recursive: true });
+
   let attempt = 0;
   let lastLockedPid: number | null = null;
```

### `skills/cmux-team/manager/pidfile.test.ts`

happy path describe の**次**・`describe("acquirePidFile - existing alive cmux-team process", ...)` の**前**に挿入:

```ts
// --- Step 2.5: parent dir 不在から作成 (T287) --------------------------

describe("acquirePidFile - missing parent directory", () => {
  test(".team/ が未作成でも pidfile を作成できる（T287）", async () => {
    const nestedPath = join(testDir, ".team/daemon.pid");
    expect(existsSync(join(testDir, ".team"))).toBe(false);
    await acquirePidFile(nestedPath, testDir, { selfPid: 12345 });
    expect(existsSync(nestedPath)).toBe(true);
    const content = await readFile(nestedPath, "utf-8");
    expect(content).toBe("12345");
  });

  test("parent dir がすでに存在する場合は no-op（既存 pidfile テストが regression しない）", async () => {
    await acquirePidFile(pidFilePath, testDir, { selfPid: 12345 });
    const content = await readFile(pidFilePath, "utf-8");
    expect(content).toBe("12345");
  });
});
```

既存の `existsSync` / `readFile` import はそのまま流用可能だったため import 行の追加は不要。

## テスト結果サマリ

### `bun test pidfile.test.ts`

```
 25 pass
 0 fail
 34 expect() calls
Ran 25 tests across 1 file. [48.00ms]
```

新規 2 ケース（`.team/ が未作成でも pidfile を作成できる`、`parent dir がすでに存在する場合は no-op`）を含めて全 pass。

**注記**: plan.md では「既存 25 + 新規 2 = 27」と記載されていたが、実際の既存テスト数は 23 ケース。追加の 2 ケースと合わせて 25 ケース全 pass。既存ケースの regression 0 件。

### `bun test`（全体）

```
 854 pass
 0 fail
 2061 expect() calls
Ran 854 tests across 28 files. [44.49s]
```

全モジュール全 pass、新規 regression 0 件。

### `bunx tsc --noEmit`

3 件のエラーが出るが、**全て既存エラー**で今回の変更と無関係:

- `conductor.ts(201,3): error TS1016`
- `daemon.test.ts(3956,9): error TS2322`
- `daemon.ts(1597,22): error TS2352`

`git stash` で作業変更を退避した状態でも同じ 3 件が出ることを確認済み。**今回の変更による新規 TS エラー 0 件**。

## 完了条件チェック

- [x] `pidfile.ts` に Step 1（import）+ Step 2（`await mkdir(...)`）の変更が入っている
- [x] `pidfile.test.ts` に Step 3 の 2 ケース（`describe("acquirePidFile - missing parent directory", ...)`）が追加されている
- [x] `bun test pidfile.test.ts` 全 pass（失敗 0 件）
- [x] `bun test`（全体）全 pass（失敗 0 件、新規 regression 0 件）
- [x] `bunx tsc --noEmit` 新規エラー 0 件（既存 3 件は事前に存在するもの）
- [x] `main.ts` / `daemon.ts` / 他モジュール / `CLAUDE.md` / `docs/spec/` への変更なし
- [x] artifact 作成なし（Conductor 側で行う）

## 期待される振る舞い（plan.md 由来）

- 新規フォルダ（`git init` 直後、`.team/` 未作成）で `cmux-team start` を実行しても ENOENT が発生せず daemon 起動が進行
- 既存 `.team/` があるプロジェクトでの挙動は不変（recursive mkdir は冪等 no-op）
- 2 回目の `cmux-team start` は従来通り `PidFileLockedError` で fail-stop（T259 既存挙動）
- `release` 側 ENOENT 黙殺との対称性が改善（acquire は parent 自動作成 / release は不在許容）
