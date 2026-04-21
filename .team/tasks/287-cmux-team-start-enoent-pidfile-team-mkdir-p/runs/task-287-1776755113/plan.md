# T287 実装計画: `cmux-team start` が新規フォルダで ENOENT で落ちる — pidfile 取得前に `.team/` を mkdir -p

## 前提（現状コードの呼び出し順序）

`skills/cmux-team/manager/main.ts:cmdStart` は以下の順序で初期化を行う:

1. cmux 環境チェック（`CMUX_SOCKET_PATH` 確認） — L344-348
2. `runPreflight(PROJECT_ROOT)` — L354（git repo 検証等。**ここでは `.team/` を触らない**）
3. **T259: `acquireOrExit(pidFilePath, PROJECT_ROOT)`** — L365（`.team/daemon.pid` を `writeFile(..., {flag:"wx"})` で atomic 作成）
4. `checkDirenvAllowed` — L372
5. `loadConfig` / `resolveLayout` — L384-387
6. `resolveMainBranch`（T213 / T253）
7. `createDaemon` → `initInfra` — L468 / L480（ここで初めて `.team/tasks`, `.team/output`, `.team/prompts`, `.team/logs` が `mkdir(recursive:true)` される — `daemon.ts:532-535`）

### ENOENT が起こる箇所

```
ENOENT: no such file or directory, open '.../.team/daemon.pid'
    at acquirePidFile (pidfile.ts:96:13)   // writeFile(path, pid, {flag:"wx"})
    at acquireOrExit (pidfile.ts:154:11)
    at cmdStart (main.ts:366:9)
```

`daemon.ts:initInfra` が走る前、つまり `.team/` ディレクトリ自体が未作成のまま `writeFile(".team/daemon.pid", ...)` が実行されるため、fresh folder（`git init` 直後で `.team/` なし）では確実に失敗する。

### 既存の関連コード

- **`main.ts:29`**: `import { readFile, readdir, writeFile, mkdir, stat, unlink } from "fs/promises";` — **`mkdir` は既に import 済み**
- **`pidfile.ts:16`**: `import { writeFile, unlink, readFile } from "fs/promises";` — `mkdir` は未 import
- **`daemon.ts:initInfra`** L529-535: `.team/tasks|output|prompts|logs` を各モジュール側で `mkdir(..., {recursive:true})` する既存パターンあり
- **`main.ts:1557/1761/1831/1916`**: Conductor 起動周りでも `mkdirSync(join(projectRoot, ".team/prompts"), {recursive:true})` を各所で呼ぶ pattern が確立（各モジュールが書き込み前に自分で必要なディレクトリを作る）
- `pidfile.test.ts` は `mkdtemp` で事前に作成した tmp dir 上で全テストを走らせるため、`mkdir(dirname(path))` を追加しても既存 25 ケースは全て pass

## 案 A vs 案 B 比較

### 案 A: `main.ts:cmdStart` 内で `acquireOrExit` の直前に `mkdir(.team)` を追加

**差分スケッチ:**

```diff
--- a/skills/cmux-team/manager/main.ts
+++ b/skills/cmux-team/manager/main.ts
@@ -362,6 +362,11 @@ async function cmdStart(): Promise<void> {
   // preflight 成功後・副作用発生前（direnv / resolveMainBranch / createDaemon）に排他を取る。
   // 既に生きている cmux-team daemon があれば console.error + exit(1) する。
   // stale pidfile（死亡プロセス or PID 再利用）は自動的に上書きされる。
+  //
+  // T287: 新規フォルダでは .team/ 自体が未作成のため、pidfile 作成前に明示的に mkdir する。
+  // initInfra（daemon.ts）が走るのは createDaemon 後で、それより前に pidfile を取る必要がある。
   const pidFilePath = join(PROJECT_ROOT, ".team/daemon.pid");
+  await mkdir(join(PROJECT_ROOT, ".team"), { recursive: true });
   await acquireOrExit(pidFilePath, PROJECT_ROOT);
   await log("pidfile_acquired", `path=${pidFilePath} pid=${process.pid}`);
```

- import 変更: 不要（`mkdir` は L29 で既に import 済み）
- 影響行: main.ts のみ 1 行追加 + コメント数行

**利点:**
- 変更範囲が最小（main.ts 1 ファイルのみ）
- 「pidfile 取得前に `.team/` を作る」という意図が cmdStart の文脈で明示される
- pidfile モジュールの責務を変えないため、pidfile テストは一切変更不要

**欠点:**
- 「pidfile を取るためには `.team/` が先に無ければならない」というドメイン知識が呼び出し側に漏れる（leaky abstraction）
- `acquirePidFile` / `acquireOrExit` を将来他の文脈（e2e、別 CLI、test harness）から呼ぶ場合にも呼び出し側で毎回 mkdir が必要
- `releasePidFile` が ENOENT を無視する（pidfile.ts:134-141）対称性と食い違う：「release は parent 不在を黙って許すのに acquire は許さない」

### 案 B: `pidfile.ts:acquirePidFile` 内で `mkdir(dirname(path), {recursive:true})` を `writeFile` 前に追加

**差分スケッチ:**

```diff
--- a/skills/cmux-team/manager/pidfile.ts
+++ b/skills/cmux-team/manager/pidfile.ts
@@ -13,7 +13,8 @@
  *   - ps 取得失敗（空文字）時は保守的に "alive cmux-team" 扱いとし fail-stop
  *     （誤って稼働中の daemon を潰さないため）
  */
-import { writeFile, unlink, readFile } from "fs/promises";
+import { writeFile, unlink, readFile, mkdir } from "fs/promises";
+import { dirname } from "path";
 import { execFile } from "child_process";
 import { promisify } from "util";
 import { isAlive as realIsAlive } from "./cmux";
@@ -88,6 +89,12 @@ export async function acquirePidFile(
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

- import 変更: `mkdir` を fs/promises から、`dirname` を path から追加
- 影響行: pidfile.ts に mkdir 1 行 + import 更新 2 箇所

**利点:**
- **責務のカプセル化**: pidfile モジュールが自分の格納先を自分で用意する。呼び出し側は「pidfile が必要 → `acquirePidFile` を呼ぶ」だけで完結
- 既存コードベースのパターンと整合: `daemon.ts:initInfra`（自分の `.team/tasks` 等を作る）、`main.ts:1557` 等（Conductor 周りの `.team/prompts` 作成）と同じく、各モジュールが書き込み前に自分で mkdir する
- `releasePidFile` が ENOENT を無視する対称性と整合（acquire 側は parent 作成、release 側は不在許容、どちらも呼び出し側に親ディレクトリ存在を要求しない）
- 将来 `acquirePidFile` を別文脈（e2e テスト、将来の CLI サブコマンド）から呼ぶときも parent dir 不在を気にしなくてよい
- テスト追加で `.team/` 未作成ケースを pidfile.test.ts の単体テストでカバーできる（統合テスト不要）

**欠点:**
- 変更箇所が 2 ファイル（pidfile.ts 本体 + pidfile.test.ts にテスト追加）
- `acquirePidFile` 呼び出しごとに `dirname(path)` の stat 1 回が追加発生（性能影響は無視可能、start は 1 回のみ実行）

## 採用案: **案 B**

以下 4 点で案 B を採用する:

1. **責務分離**: pidfile モジュールが自分の格納先を作る方がカプセル化として正しい。呼び出し側（main.ts）が pidfile の内部事情（`.team/` 先行作成が必要）を知る必要が無くなる。
2. **既存パターンとの整合**: `daemon.ts:initInfra` や各種 `mkdirSync(.team/prompts, {recursive:true})` と同じ方針（各モジュールが書き込み前に自分で mkdir）で、本リポジトリ内の「構造的正しさを優先」原則（CLAUDE.md）に合致。if/else の継ぎ足しではなく、各モジュールの責務を明確化する方向で解決する。
3. **テスト容易性**: pidfile.test.ts が既に `mkdtemp` ベースで単体完結しているため、「`.team/` 未作成から acquire 成功」ケースを同じ枠組みで追加できる。案 A だと統合テストレベルになり優先度低（task.md にも「`main.ts` 側で修正した場合、該当箇所の責務は統合テストレベル（優先度低）」と明記）。
4. **release との対称性**: `releasePidFile` は ENOENT を黙って許容する設計（pidfile.ts:134-141）。acquire 側も parent dir 不在を許容（自動作成）する方が対称で、呼び出し側が「release は許されるが acquire は許されない」という非対称を覚えなくて済む。

## 実装手順

### Step 1: `pidfile.ts` の import 追加

ファイル: `skills/cmux-team/manager/pidfile.ts`

- L16 を差し替え:
  - before: `import { writeFile, unlink, readFile } from "fs/promises";`
  - after: `import { writeFile, unlink, readFile, mkdir } from "fs/promises";`
- L17 の直前に `import { dirname } from "path";` を追加（`execFile` import の上）

### Step 2: `acquirePidFile` 先頭で parent dir を作成

ファイル: `skills/cmux-team/manager/pidfile.ts`

`acquirePidFile` 本体（L80-132）内、`opts` のデストラクチャ（L85-89）直後、`let attempt = 0` の前に以下を挿入:

```ts
// T287: pidfile の格納先（通常は <workspace>/.team/）が存在しない場合に備えて
// 先に recursive mkdir する。新規フォルダ（git init 直後で .team/ 未作成）で
// cmux-team start を実行すると、daemon.ts:initInfra より前に pidfile 取得が
// 走るため ENOENT になる問題（T287）への対処。recursive:true なので既存時は no-op。
await mkdir(dirname(path), { recursive: true });
```

### Step 3: `pidfile.test.ts` に「parent dir 不在から acquire 成功」テスト追加

ファイル: `skills/cmux-team/manager/pidfile.test.ts`

Step 2 の happy path（L67-82 の `describe("acquirePidFile - happy path", ...)`）と Step 3 の間（L96 の `describe("acquirePidFile - existing alive cmux-team process", ...)` の前）に以下の describe block を追加:

```ts
// --- Step 2.5: parent dir 不在から作成 (T287) --------------------------

describe("acquirePidFile - missing parent directory", () => {
  test(".team/ が未作成でも pidfile を作成できる（T287）", async () => {
    // testDir/.team はまだ存在しない状態から acquire する
    const nestedPath = join(testDir, ".team/daemon.pid");
    expect(existsSync(join(testDir, ".team"))).toBe(false);
    await acquirePidFile(nestedPath, testDir, { selfPid: 12345 });
    expect(existsSync(nestedPath)).toBe(true);
    const content = await readFile(nestedPath, "utf-8");
    expect(content).toBe("12345");
  });

  test("parent dir がすでに存在する場合は no-op（既存 pidfile テストが regression しない）", async () => {
    // これは従来の happy path と等価だが、mkdir が冪等であることを明示的に保証
    await acquirePidFile(pidFilePath, testDir, { selfPid: 12345 });
    const content = await readFile(pidFilePath, "utf-8");
    expect(content).toBe("12345");
  });
});
```

### Step 4: 変更なし確認

- `main.ts` は**触らない**（L364-366 の `pidFilePath` / `acquireOrExit` 呼び出しはそのまま）
- 他の `acquirePidFile` / `acquireOrExit` 呼び出し箇所は無い（grep で確認済み）

## 検証手順

### ユニットテスト

```bash
cd skills/cmux-team/manager
bun test pidfile.test.ts
```

**期待:** 既存 25 ケース + 新規 2 ケース = 27 ケース全 pass

### 型検査

```bash
cd skills/cmux-team/manager
bunx tsc --noEmit
```

**期待:** 新規エラー 0 件（`mkdir` / `dirname` は標準 API なので型追加変更なし）

### 再現シナリオ（fresh folder での手動検証）

```bash
cd /tmp
rm -rf test-cmux-team-fresh
mkdir test-cmux-team-fresh && cd test-cmux-team-fresh
git init
cmux  # cmux セッション内で
cmux-team start --layout 16x9
```

**期待:**
- ENOENT が発生せず daemon 起動が進行
- `.team/` ディレクトリが作成される
- `cat .team/daemon.pid` で daemon の PID が読める
- daemon / Master / Conductor が起動

### 既存フォルダでの冪等性確認

既存 `.team/` がある worktree（例: 本 worktree）で:

```bash
cmux-team start   # 正常起動すること
cmux-team start   # 2 回目は pidfile_locked で fail-stop（既存挙動不変）
```

**期待:**
- 1 回目: 正常起動
- 2 回目: `PidFileLockedError` でユーザーフレンドリーなメッセージ + `log("pidfile_locked", ...)` + exit 1（T259 の既存挙動そのまま）

### 全体テスト

```bash
cd skills/cmux-team/manager
bun test
```

**期待:** 既存テストが全て pass し、新規 regression なし

## テスト追加方針

案 B に伴い **`pidfile.test.ts` にユニットテスト 2 ケースを追加**（Step 3 参照）:

1. **"`.team/` が未作成でも pidfile を作成できる（T287）"**: fresh folder 相当の条件を単体で再現。`testDir/.team` が存在しないことを `existsSync` で先に確認してから `acquirePidFile(testDir/.team/daemon.pid, testDir)` を呼び、pidfile が正しく作成されていることを検証。
2. **"parent dir が既に存在する場合は no-op"**: mkdir の冪等性を明示的に保証し、既存 happy path との regression 検知を強化（`recursive: true` の挙動が将来変わっても検知できる）。

統合テスト（`main.ts` レベル）は追加しない。task.md にも「`main.ts` 側で修正した場合、該当箇所の責務は統合テストレベル（優先度低）」と明記されており、今回は単体テストで責務が閉じている。

## 影響範囲

### 直接の呼び出し箇所

- `main.ts:365`: `acquireOrExit(pidFilePath, PROJECT_ROOT)` — 挙動変更なし（parent dir 自動作成が追加されるのみ）
- 他に `acquirePidFile` / `acquireOrExit` を呼んでいる箇所は無い（`rg "acquire(PidFile|OrExit)"` で確認済み）

### テストへの影響

- `pidfile.test.ts` の既存 25 ケース: 全て `mkdtemp` で pre-existing tmp dir 上で動くため、追加された `mkdir(dirname(path), {recursive:true})` は no-op で regression 0 件
- `daemon.test.ts` / `main.test.ts` / その他: `.team/` を事前に作ってから走らせているため影響なし

### 並行起動への影響

- `writeFile({flag:"wx"})` による O_CREAT|O_EXCL atomic ロックは不変
- `mkdir({recursive:true})` は POSIX で冪等・並列安全（既存ディレクトリで EEXIST を自動吸収）
- 2 プロセスが同時に `acquirePidFile` を呼んでも、mkdir は両方成功、`writeFile({flag:"wx"})` の時点で一方だけが勝ち、他方は EEXIST → stale 判定経路に入る（既存挙動）

### ログ / メトリクスへの影響

- `pidfile_acquired` / `pidfile_locked` / `pidfile_release_failed` のログイベントは不変
- mkdir 失敗時（EACCES 等の fatal）は `writeFile` が投げていた throw と同等に伝播する（`acquireOrExit` 側は PidFileLockedError 以外を throw する既存パス）

### 他プロジェクトへの影響

- npm publish 後、グローバルインストール済みの cmux-team が新規フォルダで start するときに ENOENT が消える
- 既に `.team/` が初期化済みのプロジェクト（mado / Dear 等）は挙動変更なし

## リスク / 開放点

### リスク

- **低**: mkdir が recursive で冪等なため regression はほぼ無い
- **低**: `dirname(path)` が絶対パスでも相対パスでも正しく動く（Node.js 標準 API）
- **低**: parent dir 作成時の EACCES（write 不可）は従来 `writeFile` が同様に throw していたため、error 経路は不変。preflight で git repo を検証済みなので通常は到達しない

### 開放点

- `acquirePidFile` 呼び出しごとに `dirname(path)` の stat 1 回が追加発生するが、start は 1 回のみの呼び出しなので性能影響は無視可能（マイクロ秒オーダー）
- より厳格にしたい場合は、mkdir 失敗時にも `log("pidfile_acquire_mkdir_failed", ...)` を別イベントで emit する選択肢もあるが、fatal error は catch しないのが現状のポリシー（throw を上位に投げて exit 1）なので今回は追加しない
- Windows 対応: `dirname` は win32 でも正しく動作するが、pidfile.ts はもともと `ps` コマンド経由の stale 判定で platform=win32 なら空文字を返す既存コード（L48）があり、本質的に unix 向け。mkdir の挙動自体は Windows でも OK

### 既存の関連ドキュメント更新

- 不要: CLAUDE.md L119 付近「多重起動防止（pidfile ロック — T259）」節は本修正で記述内容が変わらない（ロック取得のタイミング・pidfile の意味論は不変）
- 不要: `docs/spec/` 配下の該当記述は実装仕様レベルの記載で、mkdir の有無は含まれていない
