# T253 実装計画: mainBranch 暗黙フォールバック削除 + fail-stop

> Rev2（Design Review 反映版）: 下流 `"main"` リテラルフォールバック（`conductor.ts` / `template.ts`）の同時撤去を追加、grep 検証強化、TDD 順序訂正、ドキュメント更新位置調整、CHANGELOG 影響範囲精緻化。

## 1. 概要

### 目的

`resolveMainBranch` の 4 番目のステップ（全自動検出失敗時に `{ branch: "main", source: "fallback" }` を返す挙動）を削除し、解決失敗時は `cmdStart` レベルで fail-stop（`process.exit(1)`）させる。併せて派生する暗黙フォールバック（`cmdConductor` の `|| "main"`、`DaemonState.mainBranch` の初期値 `"main"`、および **下流の `conductor.ts` / `template.ts` の `"main"` リテラルフォールバック**）を同じ方針で一括除去し、「state.mainBranch が空文字のまま下流に伝搬して `"main"` に強制変換される silent failure 経路」を根絶する。

### 背景

現状の挙動では main ブランチが存在しないプロジェクト（trunk / master / develop 等）や新規 repo（push 前）・shallow clone・detached HEAD 状態で `cmux-team start` が沈黙で成功し、そのまま `mainBranch = "main"` を信じて Conductor が worktree 作成・merge を行うため、以下のリスクがある:

- 存在しない `main` ブランチに向かって commit/merge が走り破綻する
- `origin/main` が存在しないリポジトリで `config-origin` 判定が常に失敗し `head-fallback` 経路へ流れるため、PR が意図しない branch に向く
- 失敗が事後ログ（`main_branch_fallback`）だけになりユーザーが気付かない

**加えて:** 上流 (`resolveMainBranch` / `DaemonState.mainBranch`) だけを修正しても、`launchConductor` → `initializeConductorSlots` → `assignTask` → `generateConductorTaskPrompt` の下流で `"main"` リテラルフォールバックが各所にあり、空文字が来ても全て `"main"` に強制変換される。上流だけの対応では silent failure を防げない。

### 影響範囲

- **`cmux-team start` 初回実行時の UX**: main ブランチ検出に失敗するプロジェクトでは `process.exit(1)` するようになる（破壊的変更）
- 既存プロジェクトで既に `.team/config.json` に `mainBranch` が永続化済みなら影響なし（T213 以降に起動した既存プロジェクトの大多数は該当）
- **新規プロジェクトで push 前**（origin 未設定 / shallow clone / detached HEAD）の場合は **要対応**（env `CMUX_TEAM_MAIN_BRANCH` または config での明示指定が必要）
- `MainBranchSource` 型から `"fallback"` が消える（外部利用箇所なし、内部のみ）
- `launchConductor` / `initializeConductorSlots` / `assignTask` / `generateConductorTaskPrompt` のシグネチャから `mainBranch` のデフォルト値 `"main"` が消える（required 引数化）。テストコード（`conductor.test.ts`）は既に明示で `"main"` を渡しているため影響なし

---

## 2. 変更ファイル一覧

| # | ファイル | 行範囲 | 変更サマリー |
|---|---------|--------|------------|
| 1 | `skills/cmux-team/manager/schema.ts` | 307-315 | `MainBranchSource` enum から `"fallback"` を削除 |
| 2 | `skills/cmux-team/manager/main-branch.ts` | 11-71 | `resolveMainBranch` が検出失敗時に `MainBranchResolutionError` を throw するよう変更。JSDoc 更新 |
| 3 | `skills/cmux-team/manager/main.ts` | 308-321 | `cmdStart` で `resolveMainBranch` を try/catch し、失敗時はユーザー向けエラーメッセージを `console.error` に出して `process.exit(1)` |
| 4 | `skills/cmux-team/manager/main.ts` | 1635-1660 | `cmdConductor` の `envMainBranch \|\| conductorConfig.mainBranch \|\| "main"` フォールバックを撤去。config.mainBranch 欠落時は fail-stop |
| 5 | `skills/cmux-team/manager/daemon.ts` | 93-95, 232 | コメント更新（「初期値は "main"...」→「cmdStart が fail-stop するため、設定前にこのフィールドが読まれることはない」）と `createDaemonState` 内の `mainBranch: "main"` を空文字 `""` に変更 |
| 6 | **`skills/cmux-team/manager/conductor.ts`** | **85-99** | **`launchConductor` の `(opts?.mainBranch ?? "main").trim() || "main"` を撤去。`opts.mainBranch` を required に変更し、`trim()` 後が空なら throw** |
| 7 | **`skills/cmux-team/manager/conductor.ts`** | **183-254** | **`initializeConductorSlots` の `mainBranch: string = "main"` デフォルト値を削除（required 引数化）** |
| 8 | **`skills/cmux-team/manager/conductor.ts`** | **258-262** | **`assignTask` の `mainBranch: string = "main"` デフォルト値を削除（required 引数化）** |
| 9 | **`skills/cmux-team/manager/template.ts`** | **160-190** | **`generateConductorTaskPrompt` の `const resolvedMainBranch = mainBranch ?? "main"` を撤去。`mainBranch` を required パラメータ化し、空文字なら throw する防御ガード追加** |
| 10 | **`skills/cmux-team/manager/template.ts`** | **（`generateConductorRolePrompt` 付近）** | **二重検出の防御ガード: `mainBranch` が空文字なら throw（cmdConductor 手動起動時の二重安全網）** |
| 11 | `skills/cmux-team/manager/main-branch.test.ts` | 101-110 | 既存「両方失敗で source=fallback branch=main」テストを「両方失敗で throw」テストに差し替え。追加テスト: エラーオブジェクトが `MainBranchResolutionError` インスタンスであり診断情報（stderr 等）を保持することの検証。**+ エッジケース（garbage prefix + HEAD 失敗 / 空 config + 両 git 失敗）** |
| 12 | `CLAUDE.md` | 628-642 | 「`mainBranch` の優先順位」セクションから fallback 記述を削除し、検出失敗時は fail-stop する旨を明記 |
| 13 | `docs/spec/05-install-and-infrastructure.md` | 424 | `mainBranch` の解決順位の説明から `fallback "main"` を削除し、fail-stop 挙動を記載 |
| 14 | `docs/spec/04-templates.md` | 444-445 | `{{BASE_BRANCH}}` の「未指定時は `config.mainBranch` → 検出値 → `"main"` の順でフォールバック」記述から `"main"` フォールバックを削除 |
| 15 | `CHANGELOG.md` | 3-4 | `[Unreleased]` に `### Changed` として破壊的変更の追記（T253） |

補足:
- README.md / README.ja.md: 現時点で `mainBranch` / `fallback` への直接言及なし（grep 確認済み）。更新不要。ただし §9 で npm package description の Upgrade Notice に 1 行追加（optional）
- `schema.ts` から `"fallback"` を消すと TypeScript コンパイラが `main-branch.ts:70` を型エラーで指し示すため、この時点で該当箇所は機械的に検出される。ただし **`conductor.ts` / `template.ts` の `"main"` リテラルは型エラーにならない** ため、別途 grep + 手動修正が必要
- **`dashboard.tsx:335`** は `.team/config.json` を直接読む経路のため `state.mainBranch` の空文字化の影響は受けない（確認済み）。変更不要

---

## 3. 詳細設計

### 3.1 `resolveMainBranch` のシグネチャ変更

#### 推奨案: **例外を throw する**

```ts
// main-branch.ts
export class MainBranchResolutionError extends Error {
  readonly originHeadStderr?: string;
  readonly headStderr?: string;
  constructor(detail: { originHeadStderr?: string; headStderr?: string }) {
    super(
      "Failed to detect main branch: both `git symbolic-ref refs/remotes/origin/HEAD` " +
      "and `git symbolic-ref --short HEAD` failed.",
    );
    this.name = "MainBranchResolutionError";
    this.originHeadStderr = detail.originHeadStderr;
    this.headStderr = detail.headStderr;
  }
}

export async function resolveMainBranch(
  projectRoot: string,
  opts: ResolveMainBranchOptions = {},
): Promise<MainBranchResolution> {
  // 1. config 経路（従来どおり）
  // 2. origin/HEAD 経路（従来どおり、失敗時は stderr を保持）
  // 3. HEAD --short 経路（従来どおり、失敗時は stderr を保持）
  // 4. 全部失敗 → throw new MainBranchResolutionError({ ... })
}
```

**理由**:
- 戻り値型 `MainBranchResolution` は「必ず有効な branch + source を返す」という契約を維持できる。呼び出し側で `result.branch == null` を取り回さなくて済む
- `MainBranchSource` enum から `"fallback"` を削除でき、型レベルで「fallback が存在しない」保証ができる
- catch するのは `cmdStart` ただ 1 箇所で済む（T213 の callsite は `main.ts:312` のみ）
- 追加コンテキスト（`originHeadStderr` / `headStderr`）を Error のプロパティに持たせれば、ユーザーメッセージの原因説明に使える

#### 代替案: **`MainBranchResolution | null` を返す**

```ts
return null; // 全部失敗時
```

**trade-off**:
- ✅ 例外より軽量で、caller が `if (!result) { ... }` で網羅できる
- ✅ 型システムが「null チェック忘れ」を検出できる（`strictNullChecks` 有効なら）
- ❌ stderr 等の診断情報を返すには戻り値型が `{ resolution: ... | null, errors: {...} }` のような複合型になり、API が肥大化する
- ❌ 呼び出し側で `null` の扱いを忘れると silent failure になる（throw と比べて発見性が劣る）

#### 判断

**例外を throw する** を採用する。理由は (1) callsite が 1 箇所で try/catch のコストが小さいこと、(2) 診断情報（stderr）を自然にエラーオブジェクトに載せられること、(3) T213 既存の `AutoUpdateMode` 解決も同パターン（`resolveAutoUpdateMode` が throw → `cmdStart` で catch して exit 1）で一貫性があること。

なお `persistMainBranch` は引き続き branch 文字列を受け取る関数のまま据え置く。

### 3.2 エラーメッセージの正確な文面

`cmdStart` が失敗時に `console.error` に出力する内容:

```
Error: Failed to detect the project's main branch.

cmux-team は以下の順で main ブランチを解決します:
  1. .team/config.json の "mainBranch" フィールド
  2. git symbolic-ref refs/remotes/origin/HEAD
  3. git symbolic-ref --short HEAD

全て失敗しました。以下のいずれかで明示してください:

  (A) .team/config.json に追記:
      {
        "mainBranch": "<your-main-branch>"
      }

  (B) または環境変数で一時指定:
      CMUX_TEAM_MAIN_BRANCH=<your-branch> cmux-team start

考えられる原因:
  - 新規リポジトリで push 前 (origin/HEAD 未設定)
  - shallow clone で origin/HEAD が欠落
  - detached HEAD 状態
  - リモートが存在しない (git remote add origin ... 未実行)

診断情報:
  origin/HEAD stderr: <originHeadStderr 値>
  HEAD stderr:        <headStderr 値>
```

日本語メッセージを採用する理由: 既存の `resolveAutoUpdateMode` 失敗時のメッセージもエラー文言は英語混在の日本語（CLAUDE.md の「ドキュメント・コメント: 日本語」ポリシーに準拠）で書かれているため、同じトーンに揃える。

**診断情報の stderr 値フォーマット** (§6 step 5 で実装):
- `stderr` の改行 (`\n`) は `\\n` にエスケープして 1 行に収める（`origin_stderr=fatal: ref\nrefs/remotes/origin/HEAD\nis not a symbolic ref` のようにログ行が 3 行に割れるのを防ぐため）
- `trim()` で前後の空白は除去
- 空なら `(empty)` 文字列を出力

`cmdConductor` 側の fail-stop メッセージ（Conductor プロセスが単独で起動された特殊系で、daemon が上がっていれば通常通らない経路）:

```
Error: config.mainBranch is not set. Start the daemon first with `cmux-team start` to resolve it, or set CMUX_TEAM_MAIN_BRANCH explicitly.
```

こちらは daemon 経由で config が永続化されているはずの前提を壊した不整合系なので、ユーザー誘導は最小限にとどめる。

### 3.3 `schema.ts` の `MainBranchSource` enum から `"fallback"` を削除

```diff
-export const MainBranchSource = z.enum(["config", "detected", "fallback"]);
+export const MainBranchSource = z.enum(["config", "detected"]);
```

`MainBranchResolution` インターフェースは変更不要（`source: MainBranchSource` のまま）。Zod enum から削除することで:
- `result.source === "fallback"` の参照はコンパイルエラーになる（型レベル保証）
- ログ出力 `main_branch_resolved branch=... source=config|detected` が 2 値に縮退する

`main-branch.ts:70` の `return { branch: "main", source: "fallback" }` は TypeScript が即エラーとして指摘する。これを `throw new MainBranchResolutionError(...)` に置き換える。

### 3.4 `main-branch.ts:69-70` と関連ログイベントの扱い

#### 削除

- `await log("main_branch_fallback", "reason=git_detect_failed")` → 削除
- `return { branch: "main", source: "fallback" }` → `throw new MainBranchResolutionError({ originHeadStderr, headStderr })` に置き換え

#### 維持

- `main_branch_detect_failed` ログ（step=origin_head / step=head）は従来どおり各 try/catch で出力する。失敗の過程が manager.log に残り、`cmdStart` 終了後も事後追跡できるようにする
- `main_branch_resolved branch=... source=<config|detected>` ログは成功経路のみで出力される（現状のまま）

#### 新規追加

- `cmdStart` の catch ハンドラで `main_branch_resolve_exit` ログを 1 行追加（`reason=detect_failed origin_stderr=<escaped> head_stderr=<escaped>` の key=value 形式）。`process.exit(1)` 前に manager.log へ記録してサポート診断に使う。stderr のエスケープは §3.2 のフォーマット規約に従う

### 3.5 `cmdConductor` の暗黙フォールバック除去

```diff
-  const envMainBranch = process.env.CMUX_TEAM_MAIN_BRANCH?.trim();
-  const mainBranch = envMainBranch || conductorConfig.mainBranch || "main";
-  if (!envMainBranch && !conductorConfig.mainBranch) {
-    await log(
-      "main_branch_conductor_fallback",
-      "reason=env_and_config_missing",
-    );
-  }
+  const envMainBranch = process.env.CMUX_TEAM_MAIN_BRANCH?.trim();
+  const mainBranch = envMainBranch || conductorConfig.mainBranch?.trim() || "";
+  if (!mainBranch) {
+    console.error(
+      "Error: config.mainBranch is not set and CMUX_TEAM_MAIN_BRANCH is empty. " +
+      "Run `cmux-team start` first to detect and persist the main branch, " +
+      "or set CMUX_TEAM_MAIN_BRANCH=<your-branch> explicitly.",
+    );
+    await log("conductor_main_branch_missing", "reason=env_and_config_missing");
+    process.exit(1);
+  }
```

`cmux-team start` 経由の通常起動では daemon が env (`CMUX_TEAM_MAIN_BRANCH`) を `launchConductor` から注入するため、このパスには通常到達しない。ユーザーが手動で `cmux-team conductor` を叩いた特殊系（T228 self-register の副作用で実行可能）での安全網として機能する。

### 3.6 `DaemonState.mainBranch` 初期値

`daemon.ts:232` の `mainBranch: "main"` を `mainBranch: ""` に変更し、JSDoc コメント（93-95）も更新する:

```diff
-  /** プロジェクトの主開発ブランチ（config.mainBranch で解決）。T213 で追加。
-   *  初期値は "main"。cmdStart が resolveMainBranch の結果で上書きする */
+  /** プロジェクトの主開発ブランチ（config.mainBranch で解決）。T213 で追加。
+   *  初期値は空文字。cmdStart が resolveMainBranch の結果で上書きする（T253 で
+   *  resolveMainBranch は失敗時に throw するため、設定前にこのフィールドが
+   *  Conductor 等に読まれることはない）。 */
```

**ただし初期値 `""` 単独では early-fail にならない。** 空文字が `state.mainBranch` に残ったまま `launchConductor` / `assignTask` / `generateConductorTaskPrompt` に伝搬した場合、それぞれの下流で `"main"` に強制変換される経路が存在するため、§3.7 の下流フォールバック撤去と **セットで** はじめて silent failure の隠蔽を防げる。`cmdStart` が必ず最初に走って `resolveMainBranch` → throw or 上書き のどちらかに到達する現設計でも、daemon 内の他経路（resume / 再初期化等）から空文字参照されるリスクを、下流 throw によって二重の防御網で潰す。

### 3.7 下流 `"main"` リテラルフォールバックの撤去（Rev2 追加）

`DaemonState.mainBranch = ""` にしても下流で `"main"` に強制変換される経路があると、T253 の設計目的（silent failure の根絶）を達成できない。以下 4 箇所をまとめて撤去する。

#### 3.7.1 `conductor.ts:95` — `launchConductor` の env 構築

```diff
-  const mainBranchEnv = (opts?.mainBranch ?? "main").trim() || "main";
+  const trimmed = opts?.mainBranch?.trim();
+  if (!trimmed) {
+    throw new Error(
+      "launchConductor: opts.mainBranch must be a non-empty string " +
+      "(T253: fail-stop when mainBranch is unresolved)",
+    );
+  }
+  const mainBranchEnv = trimmed;
```

**代替案**: `opts.mainBranch` を required (non-optional) に型変更。この場合 `launchConductor(projectRoot, surface, { mainBranch })` 形式の呼び出しが強制され、コンパイル時に呼び出し漏れを検出できる。ただし現状の呼び出し元（`initializeConductorSlots` 内 2 箇所、resume 分岐）は既に `{ mainBranch }` を明示で渡しているため影響なし。

**判断**: `opts` を required オブジェクトに変更 + ランタイム空文字チェックの両建て（型とランタイムの二重保険）。型シグネチャは `opts: { resumeTaskId?: string; mainBranch: string }` に変更する。

#### 3.7.2 `conductor.ts:190` — `initializeConductorSlots` のデフォルト引数

```diff
 export async function initializeConductorSlots(
   projectRoot: string,
   conductors: Map<string, ConductorState>,
   count: number = 3,
   daemonSurface?: string,
   resumePlan?: ResumePlanItem[],
   layout: LayoutMode = "wide",
-  mainBranch: string = "main",
+  mainBranch: string,
 ): Promise<ResumeAssignment[]> {
```

関数冒頭で空文字チェック（防御的ガード）:

```ts
if (!mainBranch.trim()) {
  throw new Error(
    "initializeConductorSlots: mainBranch must be a non-empty string " +
    "(T253: fail-stop when mainBranch is unresolved)",
  );
}
```

テスト側 (`conductor.test.ts`) は既に明示で `"main"` を渡している（レビュー確認済み: L132, L184, L224, L243）ため、デフォルト値削除による回帰は発生しない。

#### 3.7.3 `conductor.ts:262` — `assignTask` のデフォルト引数

```diff
 export async function assignTask(
   conductor: ConductorState,
   taskId: string,
   projectRoot: string,
-  mainBranch: string = "main",
+  mainBranch: string,
 ): Promise<ConductorState> {
```

同じく冒頭で空文字ガードを追加。

#### 3.7.4 `template.ts:174-175` — `generateConductorTaskPrompt`

```diff
-  // T213: 呼び出し側は state.mainBranch を渡す想定。未指定時は "main" にフォールバック
-  const resolvedMainBranch = mainBranch ?? "main";
+  // T253: mainBranch は required。空文字なら fail-stop（silent failure 防止）
+  if (!mainBranch || !mainBranch.trim()) {
+    throw new Error(
+      "generateConductorTaskPrompt: mainBranch must be a non-empty string " +
+      "(T253: fail-stop when mainBranch is unresolved)",
+    );
+  }
+  const resolvedMainBranch = mainBranch;
```

`mainBranch` 引数の型も `string | undefined` から `string` に変更（required 化）。呼び出し元は `daemon.ts` の `assignTask` 経由のみで、既に `state.mainBranch` を渡している。

#### 3.7.5 `generateConductorRolePrompt` の防御ガード（二重検出）

`cmdConductor` 手動起動時に `generateConductorRolePrompt` が直接呼ばれる経路がある。§3.5 の `cmdConductor` での fail-stop に加え、`template.ts` の関数入口でも空文字チェックを追加し、二重安全網にする:

```ts
// generateConductorRolePrompt の入口
if (!mainBranch || !mainBranch.trim()) {
  throw new Error(
    "generateConductorRolePrompt: mainBranch must be a non-empty string",
  );
}
```

#### 3.7.6 daemon 側の経路確認

`daemon.ts:901`（`launchConductor` 呼び出し）と `daemon.ts:1932`（`assignTask` 呼び出し）は `state.mainBranch` を渡している。§3.6 で state 初期値を `""` にした後、これらの経路に空文字が流れた場合は下流 throw で即検出される（T253 の設計意図）。`cmdStart` が最初に走って throw or 上書きに到達する現設計では通常到達しないが、将来的に daemon が再初期化される経路を追加した場合も防御される。

#### 3.7.7 `dashboard.tsx:335` は影響なし

`dashboard.tsx:335` は `.team/config.json` を直接読み、`cfg.mainBranch ?? "(unresolved)"` のように表示専用にフォールバックしている。`state.mainBranch` の空文字化の影響は受けない。plan.md では明示的に「変更不要」と記録しておく。

---

## 4. TDD テスト計画

### 追加・変更するテスト (`skills/cmux-team/manager/main-branch.test.ts`)

#### 置換: 101-110 行の「両方失敗で source=fallback」テスト

```ts
test("両方失敗なら MainBranchResolutionError を throw する (T253)", async () => {
  const fn = resolveMainBranch(testDir, {
    git: async (args) => {
      const e: any = new Error("git not found");
      e.stderr =
        args[1] === "refs/remotes/origin/HEAD"
          ? "fatal: ref refs/remotes/origin/HEAD is not a symbolic ref\n"
          : "fatal: ref HEAD is not a symbolic ref\n";
      throw e;
    },
  });
  await expect(fn).rejects.toThrow(MainBranchResolutionError);
});

test("MainBranchResolutionError は stderr を保持する (T253)", async () => {
  let caught: MainBranchResolutionError | undefined;
  try {
    await resolveMainBranch(testDir, {
      git: async (args) => {
        const e: any = new Error("boom");
        e.stderr =
          args[1] === "refs/remotes/origin/HEAD"
            ? "origin-stderr-fixture"
            : "head-stderr-fixture";
        throw e;
      },
    });
  } catch (e) {
    caught = e as MainBranchResolutionError;
  }
  expect(caught).toBeInstanceOf(MainBranchResolutionError);
  expect(caught?.originHeadStderr).toContain("origin-stderr-fixture");
  expect(caught?.headStderr).toContain("head-stderr-fixture");
});
```

#### 追加エッジケーステスト（Rev2 で採用）

```ts
test("origin/HEAD が garbage prefix で次段へ流れ、HEAD も失敗すれば throw (T253)", async () => {
  const fn = resolveMainBranch(testDir, {
    git: async (args) => {
      if (args[1] === "refs/remotes/origin/HEAD") {
        return "unexpected/prefix/foo\n"; // prefix 不一致で次段へ
      }
      const e: any = new Error("boom");
      e.stderr = "head-failed";
      throw e;
    },
  });
  await expect(fn).rejects.toThrow(MainBranchResolutionError);
});

test("空 configMainBranch + 両 git 失敗 → throw (T253)", async () => {
  const fn = resolveMainBranch(testDir, {
    configMainBranch: "",  // 空文字は自動検出へフォールスルー
    git: async () => {
      const e: any = new Error("x");
      e.stderr = "";
      throw e;
    },
  });
  await expect(fn).rejects.toThrow(MainBranchResolutionError);
});

test("空白のみ configMainBranch + 両 git 失敗 → throw (T253)", async () => {
  const fn = resolveMainBranch(testDir, {
    configMainBranch: "   \n",
    git: async () => {
      const e: any = new Error("x");
      e.stderr = "";
      throw e;
    },
  });
  await expect(fn).rejects.toThrow(MainBranchResolutionError);
});
```

#### 保持（既存のまま）

- `configMainBranch が指定されていれば source=config で即返す`
- `configMainBranch が空文字なら自動検出へフォールスルー`
- `configMainBranch が空白・改行のみなら自動検出へフォールスルー`
- `origin/HEAD 成功時は末尾セグメントを抽出する`
- `origin/HEAD の出力が refs/remotes/origin/ プレフィックスを含まなければ次段へ`
- `origin/HEAD 失敗・HEAD 成功で source=detected に HEAD 名を採用`
- `persistMainBranch` の 3 ケース（新規作成・既存フィールド保持・壊れた JSON）

### `conductor.ts` / `template.ts` の変更に対するテスト（Rev2 追加）

既存 `conductor.test.ts` は明示で `"main"` を渡しているため、デフォルト値削除による回帰は発生しない。追加で以下の「空文字入力 → throw」テストを含める:

```ts
// conductor.test.ts に追加
test("launchConductor は mainBranch が空文字なら throw する (T253)", async () => {
  await expect(
    launchConductor(projectRoot, "surface:100", { mainBranch: "" }),
  ).rejects.toThrow(/mainBranch must be a non-empty string/);
});

test("launchConductor は mainBranch が空白のみなら throw する (T253)", async () => {
  await expect(
    launchConductor(projectRoot, "surface:100", { mainBranch: "  \n" }),
  ).rejects.toThrow(/mainBranch must be a non-empty string/);
});
```

`template.test.ts` が存在しない場合は追加しないでよい（`template.ts` の throw はコンパイル時に required 引数で検出されるため、型での保証が主経路）。

### 型レベルテスト（コンパイル時保証）

`MainBranchSource` から `"fallback"` を削除した後、`tsc --noEmit`（もしくは Bun test のコンパイル時チェック）で `main-branch.ts` / `daemon.ts` / `dashboard.tsx` / `logger.ts` 等の他ファイルに残留参照がないことを確認。

**注意:** `"main"` リテラルフォールバック（`?? "main"` / `|| "main"` / `= "main"`）は型エラーにならない。§7 の grep 検査で機械的に検出する必要がある。

### テスト実行コマンド

```bash
cd skills/cmux-team/manager && bun test main-branch
cd skills/cmux-team/manager && bun test conductor
```

補助:

```bash
cd skills/cmux-team/manager && bun test                              # 全テスト
cd skills/cmux-team/manager && bun test main-branch.test.ts 2>&1 | grep -E "(pass|fail|error)"
```

---

## 5. ドキュメント更新

### 5.1 `CLAUDE.md` の「`mainBranch` の優先順位」セクション (628-642)

#### 修正前

```md
1. **`CMUX_TEAM_MAIN_BRANCH` 環境変数** — `cmdConductor` 起動時に env から取得（daemon が `launchConductor` で注入）
2. **`.team/config.json` の `mainBranch`** — `cmdStart` 時に解決・永続化された値
3. **`"main"` フォールバック** — env も config も未設定の場合

`cmdStart` 実行時は以下の順で `mainBranch` を決定する（config が既にあればそれを優先）:

1. `.team/config.json` に `mainBranch` があればそれを採用（source=`config`）
2. なければ `git symbolic-ref refs/remotes/origin/HEAD` で検出（source=`detected`）
3. 検出も失敗すれば `"main"` にフォールバック（source=`fallback`）

source が `config` 以外の場合のみ結果を `.team/config.json` に書き戻し、`main_branch_resolved branch=<name> source=<config|detected|fallback>` をログ出力する。初回起動後は常に config 経路が使われる。
```

#### 修正後

```md
1. **`CMUX_TEAM_MAIN_BRANCH` 環境変数** — `cmdConductor` 起動時に env から取得（daemon が `launchConductor` で注入）
2. **`.team/config.json` の `mainBranch`** — `cmdStart` 時に解決・永続化された値

env も config も未設定の場合は fail-stop する（T253 で旧 `"main"` フォールバックを削除）。

`cmdStart` 実行時は以下の順で `mainBranch` を決定する（config が既にあればそれを優先）:

1. `.team/config.json` に `mainBranch` があればそれを採用（source=`config`）
2. なければ `git symbolic-ref refs/remotes/origin/HEAD` で検出（source=`detected`）
3. それも失敗すれば `git symbolic-ref --short HEAD` で検出（source=`detected`）
4. 全て失敗した場合は **`process.exit(1)` し**、`.team/config.json` への明示指定を促すエラーメッセージを stderr に出力する

source が `config` 以外の場合のみ結果を `.team/config.json` に書き戻し、`main_branch_resolved branch=<name> source=<config|detected>` をログ出力する。初回起動後は常に config 経路が使われる。
```

### 5.2 `docs/spec/05-install-and-infrastructure.md:424`

`mainBranch` の説明行から `> fallback "main"` を削除し、「全自動検出失敗時は fail-stop する（T253）」を追記する。`main_branch_resolved` ログの source も `<config|detected|fallback>` → `<config|detected>` に修正。

対象箇所の修正案:

```diff
-- `mainBranch` — プロジェクトの主開発ブランチ名（T213）。... 解決順位は env `CMUX_TEAM_MAIN_BRANCH` > `config.mainBranch` > `git symbolic-ref refs/remotes/origin/HEAD` による自動検出 > fallback `"main"`。`cmux-team start` は解決結果を `main_branch_resolved branch=<name> source=<config|detected|fallback>` としてログ出力し、source が `config` 以外の場合のみ `.team/config.json` に書き戻す（初回起動後は常に `config` 経路）。...
+- `mainBranch` — プロジェクトの主開発ブランチ名（T213 で追加、T253 で暗黙フォールバック撤廃）。... 解決順位は env `CMUX_TEAM_MAIN_BRANCH` > `config.mainBranch` > `git symbolic-ref refs/remotes/origin/HEAD` による自動検出 > `git symbolic-ref --short HEAD` による自動検出。**全て失敗した場合は `cmux-team start` が `process.exit(1)` し、`.team/config.json` への明示指定を促すエラーメッセージを stderr に出力する**。`cmux-team start` は解決結果を `main_branch_resolved branch=<name> source=<config|detected>` としてログ出力し、source が `config` 以外の場合のみ `.team/config.json` に書き戻す（初回起動後は常に `config` 経路）。...
```

### 5.3 `docs/spec/04-templates.md:444`

`{{BASE_BRANCH}}` の説明から `"main"` フォールバック記述を削除:

```diff
-| `{{BASE_BRANCH}}` | conductor-task | タスクの target ブランチ（未指定時は `config.mainBranch` → 検出値 → `"main"` の順でフォールバック） |
+| `{{BASE_BRANCH}}` | conductor-task | タスクの target ブランチ（未指定時は `config.mainBranch` → 検出値の順で解決。全て失敗時は T253 の fail-stop により cmdStart が exit するためここに到達しない） |
```

### 5.4 `CHANGELOG.md` への破壊的変更追記

`[Unreleased]` 直下に `### Changed` セクションを追加:

```md
## [Unreleased]

### Changed

- **BREAKING: `mainBranch` の暗黙 `"main"` フォールバックを削除し、解決失敗で fail-stop するように変更（T253）**。従来は `config.mainBranch` / `git symbolic-ref refs/remotes/origin/HEAD` / `git symbolic-ref --short HEAD` の 3 段検出が全て失敗した場合に `{ branch: "main", source: "fallback" }` を暗黙で返していた。このフォールバックは、main ブランチが存在しないプロジェクト（trunk / master / develop 等）や新規 repo（push 前）・shallow clone・detached HEAD 状態で worktree 作成が沈黙で壊れる原因となっていた。`resolveMainBranch` を `MainBranchResolutionError` を throw するよう変更、`MainBranchSource` enum から `"fallback"` を削除、`cmdStart` で catch してユーザーに `.team/config.json` の明示指定を促すエラーメッセージを stderr に出した上で `process.exit(1)`。併せて下流の `cmdConductor` の `|| "main"` 暗黙フォールバック、`DaemonState.mainBranch` の初期値 `"main"`、`conductor.ts` の `launchConductor` / `initializeConductorSlots` / `assignTask` のデフォルト引数 `mainBranch: string = "main"`、`template.ts` の `generateConductorTaskPrompt` の `?? "main"` も同時に撤去した。**影響範囲:** 既存プロジェクトで `.team/config.json` に `mainBranch` が永続化済みの場合（T213 以降に起動した既存プロジェクトの大多数）は影響なし。**新規プロジェクトで push 前**（origin 未設定 / shallow clone / detached HEAD）の場合は要対応 — `.team/config.json` に `mainBranch` を明示するか、`CMUX_TEAM_MAIN_BRANCH=<branch> cmux-team start` で env 指定する。
```

### 5.5 README の Upgrade Notice（optional, Rev2 追加提案）

現状 README.md / README.ja.md には `mainBranch` への直接言及がないが、`**BREAKING:**` リリースであることを新規ユーザーが見落とさないよう、README に 1 行の Upgrade Notice を追加することを推奨:

```md
> **Upgrade Notice (v3.55.0):** 新規プロジェクトで初めて `cmux-team start` を叩く場合、origin を設定していない or push 前の repo では `mainBranch` の自動検出に失敗して fail-stop します。`.team/config.json` に `mainBranch` を明示するか、`CMUX_TEAM_MAIN_BRANCH=<branch> cmux-team start` で環境変数指定してください（T253）。
```

README への追記は optional だが、npm package description にも 1 行同様の注意書きを追加することで、npmjs.com ページから発見しやすくする。実装タスクとしては別コミットで対応してもよい。

---

## 6. 実装順序（TDD）

**TDD 方針（Rev2 訂正）:**
- 厳密な test-first を採る。テスト追加を先に行い、その後コード変更で緑にする
- schema / main-branch の変更後の状態は「新テスト緑、旧テスト赤」になる（「新旧両赤」ではない）
- `"main"` リテラルフォールバックは型エラーにならないため、`conductor.ts` / `template.ts` の撤去は grep + 明示的なステップで担保
- ドキュメント更新は **全テスト緑の後** に実施する（意図しない挙動でテストが赤のままドキュメントだけ先行するリスクを防ぐ）

### 手順

1. **テスト先行追加**: `main-branch.test.ts` に新テスト（throw 検証 + stderr 保持検証 + エッジケース 3 種）を追加。この時点では旧テスト（両方失敗で source=fallback）が残っているため、新テストは実装前なので赤
2. **schema.ts を編集**: `MainBranchSource` enum から `"fallback"` を削除 → `bun tsc --noEmit` でコンパイルエラー箇所を洗い出す（`main-branch.ts:70` が型エラーで指摘される）
3. **main-branch.ts を編集**: `MainBranchResolutionError` クラスを追加 → 4 段目を throw に変更 → JSDoc 更新。この時点で新テスト緑、旧テスト赤
4. **旧テストを削除**: `bun test main-branch` で新テストを含む全テストが緑になることを確認
5. **main.ts:cmdStart を編集**: `resolveMainBranch` を try/catch し、失敗時は `console.error` + `process.exit(1)` + `main_branch_resolve_exit` ログ（stderr のエスケープは §3.2 フォーマットに従う）
6. **main.ts:cmdConductor を編集**: `|| "main"` を削除し、config.mainBranch が空なら fail-stop
7. **daemon.ts を編集**: `createDaemonState` の `mainBranch: "main"` を `""` に変更、JSDoc コメント更新
8. **【Rev2 追加】下流 `"main"` リテラルフォールバックの撤去**:
   - `conductor.ts:95` の `launchConductor` で `opts.mainBranch` を required 化 + 空文字 throw ガード
   - `conductor.ts:190` の `initializeConductorSlots` のデフォルト引数 `= "main"` を削除、関数冒頭で空文字 throw ガード追加
   - `conductor.ts:262` の `assignTask` のデフォルト引数 `= "main"` を削除、関数冒頭で空文字 throw ガード追加
   - `template.ts:174` の `generateConductorTaskPrompt` の `?? "main"` を削除、`mainBranch` を required 化 + 空文字 throw ガード追加
   - `template.ts` の `generateConductorRolePrompt` に同じ空文字 throw ガードを追加（二重検出）
9. **【Rev2 追加】conductor.test.ts に空文字入力テスト追加**: `launchConductor` への空文字 `""` / 空白 `"  "` 入力で throw することを検証
10. **全テスト実行**: `cd skills/cmux-team/manager && bun test` で回帰がないこと確認
11. **grep 検証**: §7 の全コマンドで残留ないこと確認（リテラルフォールバック含む）
12. **【Rev2 位置変更】ドキュメント更新**: 全テスト緑かつ grep 通過後に、CLAUDE.md, docs/spec/05-install-and-infrastructure.md, docs/spec/04-templates.md, CHANGELOG.md を修正。README Upgrade Notice (§5.5) は optional で同時またはフォローアップ
13. **手動 smoke test**（オプション）: 空ディレクトリで `cmux-team start` を実行し、fail-stop メッセージが期待通り出ることを確認。既存 config あり / env 明示での正常系も確認

---

## 7. 検証手順

### 自動テスト

```bash
cd skills/cmux-team/manager && bun test main-branch
cd skills/cmux-team/manager && bun test conductor
cd skills/cmux-team/manager && bun test                          # 全テスト
cd skills/cmux-team/manager && bun tsc --noEmit                  # 型チェック（MainBranchSource 削除漏れ検出）
```

期待: 全テスト緑、型エラーなし。

### 残留チェック

```bash
# "fallback" が残っていないこと
rg 'source=fallback' skills/cmux-team/manager/
rg 'source.*fallback' skills/cmux-team/manager/main-branch.ts
rg 'main_branch_fallback' skills/cmux-team/manager/

# MainBranchSource enum からの削除が反映されているか
rg '"fallback"' skills/cmux-team/manager/schema.ts
rg 'MainBranchSource.*fallback' skills/cmux-team/

# ドキュメント側の残留
rg 'source=fallback|fallback.*main|"main" フォールバック' CLAUDE.md docs/spec/ README.md README.ja.md
```

**【Rev2 追加】リテラルフォールバック検査:**

```bash
# "main" への暗黙フォールバック（?? "main" / || "main"）が残っていないこと
rg '\?\? "main"' skills/cmux-team/manager/
rg '\|\| "main"' skills/cmux-team/manager/

# 関数デフォルト引数 = "main" が残っていないこと
rg 'mainBranch.*string\s*=\s*"main"' skills/cmux-team/manager/
```

期待:
- 上記 3 コマンドは **実装完了時点で 0 件**（テストファイル `conductor.test.ts` 等の `"main"` **リテラル引数**は許容 — これらは `?? "main"` / `= "main"` の形ではなく関数呼び出し時の `launchConductor(..., { mainBranch: "main" })` の形なので上記 regex に引っかからない）
- 既存 `"main"` 文字列参照（CHANGELOG.md の「T253 で撤廃」言及、テストの期待値として `"main"` を渡している箇所）は OK

### 手動 E2E テスト

```bash
# 1. 正常系: 既に mainBranch が config に永続化されている既存プロジェクト
cd /tmp/existing-project-with-config
cmux-team start
# → 通常起動、main_branch_resolved branch=<x> source=config ログ

# 2. 異常系: mainBranch 未検出プロジェクト（新規・push 前）
cd $(mktemp -d)
git init
cmux-team start
# → Error: Failed to detect... メッセージが stderr に出て exit 1
# → .team/config.json は作られない（または存在しても壊されない）

# 3. env 救済: 環境変数での明示
cd $(mktemp -d)
git init
CMUX_TEAM_MAIN_BRANCH=trunk cmux-team start
# → trunk として起動成功、config に永続化される

# 4. 【Rev2 追加】空文字 env の挙動
cd /tmp/existing-project-with-config
CMUX_TEAM_MAIN_BRANCH= cmux-team start
# → env の trim 後が空文字なので config 経路にフォールスルー、
#   既存 config があれば正常起動 / なければ自動検出 → 失敗時 fail-stop

# 5. 【Rev2 追加】壊れた config（mainBranch: "" が書かれている）
cd $(mktemp -d)
git init
mkdir -p .team
echo '{"mainBranch": ""}' > .team/config.json
cmux-team start
# → config.mainBranch?.trim() で空になり自動検出経路に入る。
#   git が失敗する新規 repo では fail-stop する
```

---

## 8. リスクと緩和策

| リスク | 影響度 | 緩和策 |
|-------|--------|-------|
| 既存プロジェクトで config 未設定 → 初回起動が失敗する | 中 | エラーメッセージで `.team/config.json` への明示指定と env 救済策を提示。T213 以降起動したプロジェクトは config 永続化済みなので該当は限定的 |
| **【Rev2】新規プロジェクトで push 前 / shallow clone / detached HEAD で fail-stop** | 中 | エラーメッセージで救済策（config 明示 / env 変数）を具体的に提示。CHANGELOG と README の Upgrade Notice で事前告知 |
| `cmdConductor` 手動起動時の fail-stop がユーザー操作を阻害する | 低 | 通常経路は daemon → `launchConductor` で env 注入されるため通常通らない。手動起動特殊系のみで、メッセージで daemon 起動を促す |
| テスト環境の git が shallow clone で `origin/HEAD` を欠損 → CI で fail-stop する | 低 | テストは `git: async (...) => ...` スタブを使って git 呼び出しを抑止している。実 git 依存のテストは現状なし |
| ドキュメント乖離（grep 漏れ） | 低 | §7 検証手順の grep コマンド 6 種（リテラルフォールバック 3 種 + fallback 参照 3 種）で残留を機械的にチェック |
| `DaemonState.mainBranch` の初期値を `""` にすると早期参照で空文字が伝搬する | 低 | cmdStart が resolveMainBranch → fail-stop or 上書き のどちらかに必ず到達するため、通常は `state.mainBranch = ""` のまま他経路に出る窓は存在しない |
| **【Rev2 新規】`state.mainBranch = ""` が下流に伝搬するリスク** | 中 → 低 | §3.7 の下流フォールバック撤去（`conductor.ts` × 3 箇所 + `template.ts` × 2 箇所）により、空文字が伝搬した場合は下流で throw され silent failure が防げる。`cmdStart` 前の参照 + 下流 throw で二重防御 |
| **【Rev2 新規】`conductor.test.ts` のデフォルト引数削除の影響** | 低 | テストは既に明示で `"main"` を渡している（L132, L184, L224, L243 で確認済み）。型エラーで検出可能 |
| **【Rev2 新規】daemon 再初期化経路で state.mainBranch が空文字のまま参照** | 低 | cmdStart は毎回最初に実行されるため通常到達しない。将来的な再初期化経路でも §3.7 の下流 throw で即検出される |

---

## 9. 破壊的変更の告知

### バージョニング判断

#### 推奨: **マイナーバージョンアップ（3.54.1 → 3.55.0）**

**理由**:
- cmux-team は `0.x` を出て `3.x` に入っており semver を適用しているが、CHANGELOG の過去傾向を見ると T213（初回 `mainBranch` 導入）や T242（worktree base origin/HEAD 優先）といった同レベルの挙動変更も minor で出している
- 影響を受けるのは「config.mainBranch が未設定かつ `git symbolic-ref` が両方失敗する」ケース — 既存プロジェクトでは config 永続化済みで影響なし、**新規プロジェクトで push 前の特殊系のみが fail-stop する**
- エラーメッセージで救済パス（config 編集 or env 変数）が明示されるため、被害は「起動失敗 → 1 回の手作業」で収束する

#### 代替: **メジャーバージョンアップ（3.54.1 → 4.0.0）**

**trade-off**:
- ✅ Semver に厳密に従えば「動いていた初回起動が動かなくなる」は major
- ❌ 直近の 3.x で T242 / T230 / T229 など同レベルの破壊的構造変更を minor で出しているため、プロジェクト慣習から浮く
- ❌ 4.0.0 に上げるなら他の懸案（MasterState 配列化の旧 key 廃止等）とまとめる方が自然

#### 判断

**マイナーバージョンアップ（3.55.0）** を推奨。ただし CHANGELOG の該当エントリ冒頭に `**BREAKING:**` マーカーを付け、README や skill の該当箇所も同時更新することで「minor で破壊的変更を出したが告知は強く」する慣習に準拠する（既存の T250 / T242 / T229 も同じパターン）。

### CHANGELOG 告知ポイント

- `### Changed` セクションに `**BREAKING: ...（T253）**` 形式で記載（上述 5.4 案）
- 1 行目で「何が変わったか」「旧挙動」「新挙動」を端的に書く
- **【Rev2 精緻化】影響範囲は「多くは影響なし」ではなく「既存プロジェクト（config 永続化済み）は影響なし、新規プロジェクトで push 前なら要対応」と明記する**
- 救済策（`.team/config.json` への明示 or env 変数）を本文に含める
- 下流フォールバック（`conductor.ts` / `template.ts`）の同時撤去も明記（silent failure 根絶の意図が伝わるように）
- 関連 CLI 動作に変更がないことを明記

### リリース時のアナウンス

- npm publish 時の `release` skill 経由で release タスクを起票し、Conductor が自動でリリース作業を実行
- CHANGELOG の `**BREAKING:**` マーカーが含まれるリリースは、GitHub Release の body でも冒頭にピン留めして強調
- **【Rev2 追加】npm package description または README に Upgrade Notice を追加**して、新規プロジェクトで push 前の repo では config / env の明示が必要なことを npmjs.com ページから見える形にする（§5.5）

---

## 10. 作業境界の再確認

- 本タスクは計画のみ。コード変更は本 plan.md を受けて Implementer が実施する
- 本 plan.md 以外のファイルは書かない
- 実装時は「6. 実装順序」の TDD フローを厳守（テストを先に書く、schema の型エラーで上流残留を機械的に検出する、**下流リテラルフォールバックは grep + 明示ステップで担保する**）
- 実装完了後は「7. 検証手順」の grep（fallback 参照 3 種 + リテラルフォールバック 3 種の計 6 コマンド）を全て通過させる
- ドキュメント更新は **全テスト緑 + grep 通過後** に実施し、テストが赤のままドキュメントが先行するリスクを防ぐ
