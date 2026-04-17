# T213 実装計画 — Conductor マージ先ブランチのプロジェクト設定化

## 1. 概要

`.team/config.json` に `mainBranch` フィールドを導入し、Conductor が「main ブランチ」に暗黙依存している箇所を置換する。`cmux-team start` 時に未設定であれば `git symbolic-ref` で自動検出し config に永続化する。新テンプレート変数 `{{MAIN_BRANCH}}` を導入して conductor 系テンプレートに注入する。develop / master / 独自名の主ブランチ運用を可能にすることがゴール。

## 2. 事前調査結果

### 2.1 config 読み込みフロー

- 型定義: `skills/cmux-team/manager/main.ts:93-111` の `interface TeamConfig`
  - 現在のフィールド: `models`, `envrcHookPromptSkipped`, `layout`, `sleepPrevention`, `autoUpdate`
  - Zod スキーマ化はされておらず、純粋な TypeScript interface
- 読み込み関数: `skills/cmux-team/manager/main.ts:113-120` の `async function loadConfig()`
  - `.team/config.json` を `JSON.parse`、失敗時は空オブジェクト
- 呼び出し箇所:
  - `main.ts:331` — `cmdStart` の preflight 後、layout / sleepPrevention / autoUpdate 解決に使用
  - `main.ts:1375` — `cmdConductor`（各 Conductor プロセスが起動時にモデル解決のため読む）
  - `main.ts:1461, 1520, 1645` — その他のサブコマンド（`master`, `spawn-agent`, `run`）
- 初期生成: `skills/cmux-team/manager/daemon.ts:414-433` の `initInfra` 内で `models` + `envrcHookPromptSkipped` のデフォルト JSON を書き込む
- 部分 update の参考実装: `skills/cmux-team/manager/envrc-prompt.ts:68-85` の `silenceInConfig`
  - read → JSON.parse → フィールド追加 → 全体書き換え（`writeFile` + 末尾改行）
  - T213 の `mainBranch` 書き戻しはこの方式をそのまま踏襲する

### 2.2 テンプレート変数置換ロジック

- ファイル: `skills/cmux-team/manager/template.ts`
- 共通ユーティリティ: `resolveLocalizedDir(base)` → `ja`/`en` 切替（`locale` は `i18n.ts` で解決）
- `generateConductorRolePrompt(projectRoot)` — `template.ts:58-77`
  - 現在置換しているのは `{{PROJECT_ROOT}}` の 1 変数のみ
  - `cmdConductor` が Conductor プロセス起動時に呼ぶ（`main.ts:1358`）
- `generateConductorTaskPrompt(projectRoot, taskRunId, taskId, taskContent, worktreePath, outputDir, baseBranch?, taskDir?)` — `template.ts:79-120`
  - 既に 6 変数を置換: `TASK_CONTENT`, `WORKTREE_PATH`, `OUTPUT_DIR`, `PROJECT_ROOT`, `CONDUCTOR_ID`, `BASE_BRANCH`
  - `BASE_BRANCH` の既定値は `main（デフォルト）` / `main (default)` でハードコード（`template.ts:115`）← T213 で **ここも差し替える**
  - `assignTask` から呼ばれる（`conductor.ts:368-377`）
- 既存 `baseBranch` の取得元: `conductor.ts:316` — タスクファイル frontmatter の `base_branch:` 行を regex で抽出

### 2.3 テンプレート内の置換対象箇所

`grep` の結果、`main` が「マージ先 / 作業ブランチ」の意味で現れる箇所は以下:

| ファイル | 行 | 現在の文言 | 置換後 |
|---------|---|------------|-------|
| `skills/cmux-team/templates/ja/conductor-role.md` | 497 | `- main ブランチで作業する（worktree を使う）` | `- {{MAIN_BRANCH}} ブランチで作業する（worktree を使う）` |
| `skills/cmux-team/templates/en/conductor-role.md` | 448 | `- Work on the main branch (use worktree)` | `- Work on the {{MAIN_BRANCH}} branch (use worktree)` |
| `skills/cmux-team/templates/ja/conductor-task.md` | 13 | `main ブランチに直接変更を加えてはならない。` | `{{MAIN_BRANCH}} ブランチに直接変更を加えてはならない。` |
| `skills/cmux-team/templates/en/conductor-task.md` | 13 | `Do not make changes directly on the main branch.` | `Do not make changes directly on the {{MAIN_BRANCH}} branch.` |

**意味的な判断**:
- `conductor-role.md` 行 497/448 は「main で直接作業してはならない（禁止事項）」の文脈。ここは**プロジェクト全体**の主ブランチを指しているので `{{MAIN_BRANCH}}` が妥当（`{{BASE_BRANCH}}` はタスク個別設定のため不適）。
- `conductor-task.md` 行 13 は同種の禁止事項で、こちらも**プロジェクト全体**の主ブランチを指す。`{{MAIN_BRANCH}}` を採用。
- `conductor-task.md` 34行目の「成果を `{{BASE_BRANCH}}` にマージすること」は既に変数化済みで、タスク個別の base_branch を尊重する既存の意図と一致。ここは変更しない。ただし `template.ts` 側で baseBranch 未指定時のフォールバックを `config.mainBranch` に差し替える。

**対象外（今回は触らない）**:
- `skills/cmux-team/templates/{ja,en}/conductor.md` — 旧版テンプレート（`template.ts` から参照されない）。L19 と L277 に `main` ハードコードが残っているが、本タスクでは**置換せず deprecated 扱いとして spec 側に明記する**（design-review 指摘 4 / Step 8）。同時置換ではなく「deprecated 明記」を選んだ理由: (1) 最小変更優先、(2) `template.ts` からの参照がないため実害ゼロ、(3) 将来完全削除する際に一括で処理できる。
- `skills/cmux-team/templates/{ja,en}/conductor-role.md` 内の `git merge <...>` 例 — 具体的なタスク ブランチ名の例示であり `main` は出てこない。
- 仕様書に挙がっている `skills/cmux-team/templates/conductor-role.md` / `conductor-task.md`（ロケール無し版）は**存在しない**。ja/en の 2 ロケール分割が現状の構成なので、計 4 ファイルが対象。

**スコープ判断の見直し（Agent ロールだが本タスクで同時処理）**:
- `skills/cmux-team/templates/ja/inspector.md:51` および `en/inspector.md:51` の `TOUCHED=$(git diff main...HEAD --name-only ...)` ハードコード — 本来 Agent ロール（Conductor スコープ外）だが、1 行の置換で済むため、MAIN_BRANCH 導入と同じコミットで解消する（design-review 指摘 5）。
- **ただし `{{MAIN_BRANCH}}` 置換は採用しない**: inspector.md は Agent テンプレートで、`template.ts` の generator を経由しない（Conductor が実行時にテンプレートを読み Agent に渡す）。変数置換経路を追加すると本タスクのスコープが肥大化する。
- **採用する方針**: `main` を**ランタイム検出スクリプトに置換**する。`resolveMainBranch` と同じ origin/HEAD 検出を bash 1 行で行い、fallback を持たせる:
  ```bash
  BASE=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||' || echo main)
  TOUCHED=$(git diff "$BASE"...HEAD --name-only -- '*.ts' '*.tsx' | tr '\n' '|' | sed 's/|$//')
  ```
- これにより Inspector は Conductor からの明示引き渡し不要で、任意の main ブランチ運用に追従できる。Step 7 で実施。

### 2.4 自動検出ロジックの配置場所

- `cmux-team start` のエントリ: `main.ts:319` 付近の `cmdStart` 関数（line 320 以降 preflight）
- 現在の初期化順序: preflight → loadConfig → resolveLayout → sleepPrevention → autoUpdate → createDaemon → initInfra → ensureEnvrcHookPrompt → proxy/TUI 起動
- `mainBranch` 解決の配置候補:
  - **案 A**: `loadConfig()` 直後、`createDaemon` の前（layout と同じ層）
  - 案 B: `createDaemon` 内部（daemon state 初期化の一部として）
  - 案 C: `initInfra` 内部（config.json の初期生成と併せて）
- **採用: 案 A**。理由:
  1. `layout` / `autoUpdate` と同じ「CLI or config で解決 → daemon state に注入」パターンに揃えられる
  2. 自動検出時の config writeback が initInfra の default 生成と分離できる（既存 config を尊重する動きが明確）
  3. daemon spawn 前に失敗（git 未インストール等）しても fallback で済み、起動を阻害しない
- git コマンド実行の既存パターン:
  - `envrc-prompt.ts:22` — `promisify(execFile)` 経由で `direnv` を呼ぶ
  - `main.ts:71` — `execFileSync("npm", ...)` でグローバルパス取得
  - `conductor.ts:324` — `execFile("git", ["worktree", "add", ...])` で worktree 作成
  - `main.ts` 上部で `execFileAsync = promisify(execFile)` が既に定義されている（line 88）
  - → `resolveMainBranch` では `execFileAsync("git", ["symbolic-ref", ...], { cwd: projectRoot })` を使う

## 3. 設計判断

### 3.1 自動検出のタイミング

- `cmux-team start` の初期化フェーズで **1 回だけ** 実行する。
- 検出結果 `{ branch, source: "config" | "detected" | "fallback" }` を `DaemonState.mainBranch` に保持する。
- daemon 稼働中の再検出はしない（config に書き戻した値を後続の起動が読む前提）。

#### 初期化順序の固定（race の構造的排除）

design-review 指摘 2 への対応として、以下の順序を `cmdStart` で**必ず**守る:

```
preflight
  ↓
loadConfig()
  ↓
resolveMainBranch(PROJECT_ROOT, { configMainBranch: startConfig.mainBranch })
  ↓
persistMainBranch(PROJECT_ROOT, mainBranchResolution.branch)   ← source !== "config" のときのみ
  ↓
createDaemon() → state.mainBranch = mainBranchResolution.branch
  ↓
initializeConductorSlots()   ← この時点で config.json への writeback は完了している
```

この直列順序により、Conductor 子プロセスが `loadConfig()` する時点では必ず `config.mainBranch` が設定済み。

#### 二重防御（ベルト&サスペンダー）

順序固定だけでは将来のリファクタで壊れる可能性があるため、**env 注入**も併用する:

- `launchConductor`（`conductor.ts:104-108`）の `export CMUX_SURFACE=... CMUX_CLAUDE_HOOKS_DISABLED=1\n` に `CMUX_TEAM_MAIN_BRANCH=<branch>` を追加する。
- `cmdConductor`（`main.ts:1352`）は `CMUX_TEAM_MAIN_BRANCH` → `config.mainBranch` → `"main"` の三段フォールバックで解決する:
  ```ts
  const config = await loadConfig();
  const mainBranch = process.env.CMUX_TEAM_MAIN_BRANCH?.trim()
    || config.mainBranch
    || "main";
  ```
- これにより、たとえ順序が崩れても env がソースオブトゥルースとして機能する。既存の env ベース設定パターン（`CMUX_TEAM_POLL_INTERVAL`, `CMUX_TEAM_MAX_CONDUCTORS`）と一貫する。

#### `cmdConductor` の責務

- Conductor 子プロセスは **再検出しない**。env → config → `"main"` のフォールバック解決のみ。
- `"main"` fallback に達した場合は `log("main_branch_conductor_fallback", "reason=env_and_config_missing")` で警告。

### 3.2 config 書き込みの方式

- **部分 update（read-merge-write）** を採用。`envrc-prompt.ts:69-85` の `silenceInConfig` と同じパターン。
- 実装:
  ```ts
  async function persistMainBranch(projectRoot: string, branch: string): Promise<void> {
    const configPath = join(projectRoot, ".team/config.json");
    let config: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      try {
        const parsed = JSON.parse(await readFile(configPath, "utf-8"));
        if (parsed && typeof parsed === "object") config = parsed;
      } catch {}
    }
    config.mainBranch = branch;
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
  }
  ```
- 既存フィールド（`models`, `layout`, `autoUpdate` 等）は保持される。
- 他のフィールドと並行して書き込む race は発生しない（start 初期化は直列）。

### 3.3 「main ブランチへマージ」の置換方針

- **単語レベル置換** を基本とする（フレーズ再構成はしない）。
- 対象は前述 2.3 の 4 箇所のみ。`main` という単語が「ブランチ名」の文脈で現れるケース。
- `conductor-role.md` / `conductor-task.md` で `{{MAIN_BRANCH}}` を使う。
- `conductor-task.md` 34行目の `{{BASE_BRANCH}}` は既存のまま（タスク個別設定を尊重）。
- 機械的な sed 置換は避ける。`git merge <branch>`, `.git/refs/remotes/origin/main`, `main.ts`, `main.log` 等も `main` を含むため、手動で該当行のみ Edit する。

#### conductor-role.md L9-15「プレースホルダ表記について」ブロックの更新（design-review 指摘 1）

現行の注意書きは「curly brace `{{...}}` で書いてよいのは `{{PROJECT_ROOT}}` のみ」と宣言しており、`{{MAIN_BRANCH}}` を追加するとこの宣言と矛盾する。Step 7 で ja/en 両方を明示的に更新する:

**対象ファイルと行**:
- `skills/cmux-team/templates/ja/conductor-role.md:15`
- `skills/cmux-team/templates/en/conductor-role.md:15`

**更新前（ja L15）**:
> **curly brace `{{...}}` で書いてよいのは `{{PROJECT_ROOT}}` のみ**（他の変数を curly brace で書くと runtime prompt にそのまま残り bash が失敗する）。

**更新後（ja L15）**:
> **curly brace `{{...}}` で書いてよいのは `{{PROJECT_ROOT}}` と `{{MAIN_BRANCH}}` のみ**（いずれも `template.ts:generateConductorRolePrompt` によって実値に置換される。他の変数を curly brace で書くと runtime prompt にそのまま残り bash が失敗する）。

**更新前（en L15）**:
> **Only `{{PROJECT_ROOT}}` may be written with curly braces `{{...}}`** — other variables written in curly braces will remain literally in the runtime prompt and cause bash to fail.

**更新後（en L15）**:
> **Only `{{PROJECT_ROOT}}` and `{{MAIN_BRANCH}}` may be written with curly braces `{{...}}`** — both are replaced with actual values by `template.ts:generateConductorRolePrompt`. Other variables written in curly braces will remain literally in the runtime prompt and cause bash to fail.

ja L11 および en L11 の「`{{PROJECT_ROOT}}` は実際の絶対パスに置換される」の説明文は、Step 7 で `{{MAIN_BRANCH}}` も併記する形に小規模に修正する（例: ja L11 → 「このロール定義で `{{PROJECT_ROOT}}` と `{{MAIN_BRANCH}}` は実値に置換される」）。

### 3.4 自動検出失敗ケース

検出関数 `resolveMainBranch(projectRoot, configMainBranch)` の挙動:

| ケース | 判定 | 戻り値 |
|--------|-----|--------|
| config に `mainBranch` が既に設定されている | そのまま返す | `{ branch: config.mainBranch, source: "config" }` |
| `git symbolic-ref refs/remotes/origin/HEAD` が成功 | stdout `refs/remotes/origin/main` から末尾セグメント抽出 | `{ branch: "main", source: "detected" }` |
| origin/HEAD 未設定（`fatal: ref refs/remotes/origin/HEAD is not a symbolic ref`） | 次の段へ | — |
| `git symbolic-ref --short HEAD` が成功 | stdout の trim 値を採用 | `{ branch: <HEAD>, source: "detected" }` |
| HEAD が detached（`fatal: ref HEAD is not a symbolic ref`） | 次の段へ | — |
| git 未インストール / 非 git ディレクトリ | catch | `{ branch: "main", source: "fallback" }` + `log("main_branch_fallback", ...)` |

- 検出コマンドはいずれも `execFileAsync("git", [...], { cwd: projectRoot })` で実行し、`catch` で次段へ進む。
- 例外の stderr は log に含める（ロギングポリシーに従い `log("error", ...)` ではなく `log("main_branch_detect_failed", "stderr=...")` のような情報ログ）。
- fallback 発動時は `log("main_branch_fallback", "reason=git_detect_failed stderr=...")` で警告レベル相当を明示。
- `source: "detected"` と `source: "fallback"` のどちらの場合も、呼び出し元で `persistMainBranch` を行う（次回以降の再検出を避けるため）。`source: "config"` の場合は既に config にあるので writeback しない。

### 3.5 {{MAIN_BRANCH}} と {{BASE_BRANCH}} の関係整理

- `{{MAIN_BRANCH}}`（新）: **プロジェクト全体**の主開発ブランチ。config.mainBranch で解決。Conductor 常駐プロンプト（conductor-role.md）と conductor-task.md の禁止事項で使用。
- `{{BASE_BRANCH}}`（既存）: **このタスク**のマージ先。タスクファイル frontmatter の `base_branch:` が優先、未指定時は `config.mainBranch` にフォールバック（T213 で挙動変更）。conductor-task.md の「成果物のマージ先」セクションで使用。
- フォールバックの変更:
  - 現在: `template.ts:115` で `baseBranch || (locale === "ja" ? "main（デフォルト）" : "main (default)")`
  - 変更後: `baseBranch || mainBranch`（`mainBranch` は必須引数として渡す）
  - 「(デフォルト)」の注記は削るか、呼び出し側で整形してから渡す。**採用: 注記を削り、値のみにする**（ユーザーが config で明示指定したブランチ名が「デフォルト」と表示されると混乱を招くため）。

## 4. 実装ステップ

### Step 1: schema.ts に config スキーマを追加

**変更ファイル**: `skills/cmux-team/manager/schema.ts`

- 既存の Zod スキーマ定義の末尾に以下を追加:
  ```ts
  export const MainBranchSource = z.enum(["config", "detected", "fallback"]);
  export type MainBranchSource = z.infer<typeof MainBranchSource>;

  export interface MainBranchResolution {
    branch: string;
    source: MainBranchSource;
  }
  ```
- `TeamConfig` は現状 `main.ts` 内の interface のため、そこに `mainBranch?: string` を追加する（schema.ts にも書くかは次の判断）:
  - 仕様書は「`schema.ts` の config スキーマに `mainBranch: z.string().optional()` を追加」と指示。
  - 現状 config の Zod スキーマは存在しないため、**最小変更**として:
    - `main.ts` の `interface TeamConfig` に `mainBranch?: string` を追加
    - schema.ts には `MainBranchSource` と `MainBranchResolution` の型のみ追加
  - 将来 config 全体を Zod 化するリファクタは別タスクに切り出す（スコープ外）。
- **テスト観点**: 既存の `schema.test.ts` / `daemon.test.ts` が壊れないこと。型追加のみなのでビルド成功で OK。

### Step 2: resolveMainBranch 関数の追加 + ユニットテスト

**変更ファイル**: `skills/cmux-team/manager/main.ts`（関数追加）+ 新規 `skills/cmux-team/manager/main-branch.ts`（関数本体、テスタビリティのため分離）

- 新規ファイル `main-branch.ts`:
  ```ts
  import { execFile } from "child_process";
  import { promisify } from "util";
  import { existsSync } from "fs";
  import { readFile, writeFile } from "fs/promises";
  import { join } from "path";
  import { log } from "./logger";
  import type { MainBranchResolution } from "./schema";

  const execFileAsync = promisify(execFile);

  export interface ResolveMainBranchOptions {
    configMainBranch?: string;
    git?: (args: string[]) => Promise<string>;  // テスト用 mock
  }

  export async function resolveMainBranch(
    projectRoot: string,
    opts: ResolveMainBranchOptions = {}
  ): Promise<MainBranchResolution> {
    // design-review 指摘 8: 空文字 / 改行のみは自動検出にフォールスルー
    const cfg = opts.configMainBranch?.trim();
    if (cfg) {
      return { branch: cfg, source: "config" };
    }
    const git = opts.git ?? (async (args) => {
      const { stdout } = await execFileAsync("git", args, { cwd: projectRoot });
      return stdout.trim();
    });
    // 1. origin/HEAD
    try {
      const out = await git(["symbolic-ref", "refs/remotes/origin/HEAD"]);
      // 例: "refs/remotes/origin/main" → "main"
      const m = out.match(/^refs\/remotes\/origin\/(.+)$/);
      if (m) return { branch: m[1], source: "detected" };
    } catch (e: any) {
      // design-review 指摘 9: ロギングポリシー `*_failed` パターンに揃える
      await log("main_branch_detect_failed", `step=origin_head stderr=${e?.stderr ?? ""}`);
    }
    // 2. HEAD
    try {
      const out = await git(["symbolic-ref", "--short", "HEAD"]);
      if (out) return { branch: out, source: "detected" };
    } catch (e: any) {
      await log("main_branch_detect_failed", `step=head stderr=${e?.stderr ?? ""}`);
    }
    // 3. fallback
    await log("main_branch_fallback", "reason=git_detect_failed");
    return { branch: "main", source: "fallback" };
  }

  export async function persistMainBranch(projectRoot: string, branch: string): Promise<void> {
    const configPath = join(projectRoot, ".team/config.json");
    let config: Record<string, unknown> = {};
    if (existsSync(configPath)) {
      try {
        const parsed = JSON.parse(await readFile(configPath, "utf-8"));
        if (parsed && typeof parsed === "object") config = parsed as Record<string, unknown>;
      } catch {}
    }
    config.mainBranch = branch;
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
  }
  ```
- **テスト観点**: 新規 `main-branch.test.ts` を作成
  - config 指定あり → source=config
  - `git` mock で `origin/HEAD` 返却 → source=detected, branch=main
  - `git` mock で `origin/HEAD` 失敗・HEAD 成功 → source=detected, branch=develop
  - 全て失敗 → source=fallback, branch=main
  - `persistMainBranch` で既存フィールド保持を確認

### Step 3: cmdStart への統合

**変更ファイル**: `skills/cmux-team/manager/main.ts`（行 330 付近）

- `loadConfig()` 後、`createDaemon` の前に追加:
  ```ts
  const startConfig = await loadConfig();
  let layout: LayoutMode;
  // ...（既存）

  // main branch 解決
  const { resolveMainBranch, persistMainBranch } = await import("./main-branch");
  const mainBranchResolution = await resolveMainBranch(PROJECT_ROOT, {
    configMainBranch: startConfig.mainBranch,
  });
  if (mainBranchResolution.source !== "config") {
    await persistMainBranch(PROJECT_ROOT, mainBranchResolution.branch);
  }
  await log("main_branch_resolved", `branch=${mainBranchResolution.branch} source=${mainBranchResolution.source}`);
  ```
- `createDaemon` に `mainBranch` を渡すか、`state.mainBranch = mainBranchResolution.branch;` で代入する。
- **テスト観点**: 手動 E2E
  - クリーン状態で `cmux-team start` → config.json に mainBranch=main が書き込まれる
  - `.team/config.json` に `{"mainBranch": "develop"}` を手書きしてから start → config 優先
  - 既存の daemon test を壊さないこと

### Step 4: DaemonState への mainBranch 追加

**変更ファイル**: `skills/cmux-team/manager/daemon.ts`

- `DaemonState` interface (line 39-92) に追加:
  ```ts
  /** プロジェクトの主開発ブランチ（config.mainBranch で解決）。T213 で追加 */
  mainBranch: string;
  ```
- `createDaemon(projectRoot, layout)` のシグネチャを `createDaemon(projectRoot, layout, mainBranch)` に変更するか、`cmdStart` 側で `state.mainBranch = ...` を直接代入する。
- **採用: 直接代入**（最小変更）。`createDaemon` は初期値 `"main"` で state を作り、`cmdStart` が `state.mainBranch = mainBranchResolution.branch` で上書きする。
- **テスト観点**: `daemon.test.ts` の `createDaemon` 呼び出しが影響を受けないこと。

### Step 5: template.ts の generateConductorRolePrompt / generateConductorTaskPrompt 更新

**変更ファイル**: `skills/cmux-team/manager/template.ts`

- `generateConductorRolePrompt(projectRoot, mainBranch)` に第 2 引数追加:
  ```ts
  export async function generateConductorRolePrompt(
    projectRoot: string,
    mainBranch: string
  ): Promise<string> {
    // ...
    let content = await readFile(join(templateDir, "conductor-role.md"), "utf-8");
    content = content
      .replace(/\{\{PROJECT_ROOT\}\}/g, projectRoot)
      .replace(/\{\{MAIN_BRANCH\}\}/g, mainBranch);
    // ...
  }
  ```
- `generateConductorTaskPrompt` のシグネチャに `mainBranch` を **末尾 optional** として追加（design-review 指摘 7）:
  - **採用**: 末尾 optional。位置引数の中央挿入は読みづらく、将来さらに引数を追加した際に順序を把握しにくいため。
  - `undefined` が渡されたケースは `mainBranch ?? "main"` でフォールバック。実運用では呼び出し側（`conductor.ts:368`）が必ず `state.mainBranch` を渡す想定。
  - 呼び出し箇所は `conductor.ts:368` の 1 箇所のみなので影響小。
  - 変更後のシグネチャ:
    ```ts
    generateConductorTaskPrompt(
      projectRoot,
      taskRunId,
      taskId,
      taskContent,
      worktreePath,
      outputDir,
      baseBranch?,
      taskDir?,
      mainBranch?,       // ← 末尾に追加
    )
    ```
- 置換ロジックの更新:
  ```ts
  const resolvedMainBranch = mainBranch ?? "main";
  content = content
    .replace(/\{\{TASK_CONTENT\}\}/g, taskContent)
    .replace(/\{\{WORKTREE_PATH\}\}/g, worktreePath)
    .replace(/\{\{OUTPUT_DIR\}\}/g, join(projectRoot, outputDir))
    .replace(/\{\{PROJECT_ROOT\}\}/g, projectRoot)
    .replace(/\{\{CONDUCTOR_ID\}\}/g, taskRunId)
    .replace(/\{\{MAIN_BRANCH\}\}/g, resolvedMainBranch)
    .replace(/\{\{BASE_BRANCH\}\}/g, baseBranch || resolvedMainBranch);
  ```
- **テスト観点**: `daemon.test.ts:258` が `generateConductorRolePrompt` / `generateConductorTaskPrompt` を import してテストしているため、テスト側のモック呼び出しも更新が必要。テスト内容を確認して修正範囲を特定する。

### Step 6: 呼び出し側の更新

**変更ファイル**:
- `skills/cmux-team/manager/conductor.ts`（`assignTask` 内の呼び出し + `launchConductor` の env 注入）
- `skills/cmux-team/manager/main.ts`（`cmdConductor` 内の呼び出し）
- `skills/cmux-team/manager/daemon.ts`（`assignTask` 呼び出し側）
- `skills/cmux-team/manager/conductor.test.ts`（`assignTask` モック呼び出しの引数追加）

**事前影響調査**:

| 呼び出し箇所 | 影響 | 対応 |
|-------------|------|------|
| `daemon.ts:1256` `assignTask(idleConductor, task.id, state.projectRoot)` | シグネチャ拡張で要更新 | 4 引数目に `state.mainBranch` を追加 |
| `conductor.test.ts:62, 80, 95` `assignTask(conductor, "id", testDir)` | 3 箇所とも 3 引数 | 4 引数目に `"main"`（ダミー）を追加。テストはいずれも file-not-found / worktree-add 失敗のケースで、template 経路に到達しないため dummy で十分 |
| `main.ts:1358` `generateConductorRolePrompt(PROJECT_ROOT)` | シグネチャ拡張で要更新 | env / config から `mainBranch` を解決し第 2 引数に渡す |
| `main.ts:1419-1483` `cmdResume` | **影響なし** — `claude --resume` で既存セッションを復元するため `generateConductorRolePrompt` / `generateConductorTaskPrompt` を呼ばない（design-review 指摘 6） | 変更不要 |
| `daemon.test.ts:258` | モック呼び出しの引数追加 | `mainBranch = "main"` を追加 |

**コード変更**:

- `conductor.ts:368-377` の `generateConductorTaskPrompt` 呼び出しに `mainBranch` を渡す:
  ```ts
  promptFile = await generateConductorTaskPrompt(
    projectRoot,
    taskRunId,
    taskId,
    taskContent,
    worktreePath,
    outputDir,
    baseBranch,
    taskDir,
    mainBranch,          // ← 末尾 optional 引数として追加
  );
  ```
- `conductor.ts:268` の `assignTask` シグネチャを `assignTask(conductor, taskId, projectRoot, mainBranch)` に拡張。`daemon.ts:1256` と `conductor.test.ts` 3 箇所を更新。

- `conductor.ts:104-108` の `launchConductor` 内 env 注入（§3.1「二重防御」に対応）:
  ```ts
  // 2. 環境変数をシェルに焼き付け
  //    CMUX_SURFACE: cmdConductor / cmdResume が読み取る（必須）。hook も参照する
  //    CMUX_CLAUDE_HOOKS_DISABLED: 統一（旧 spawnSingleConductor のみ欠落していた）
  //    CMUX_TEAM_MAIN_BRANCH: T213 で追加。race 回避のベルト&サスペンダー（§3.1 参照）
  const mainBranchEnv = opts?.mainBranch ?? "main";  // 呼び出し元（initializeConductorSlots）から渡す
  await cmux.send(
    surface,
    `export CMUX_SURFACE=${surface} CMUX_CLAUDE_HOOKS_DISABLED=1 CMUX_TEAM_MAIN_BRANCH=${mainBranchEnv}\n`
  );
  ```
  - `launchConductor` の `opts` に `mainBranch?: string` を追加。
  - `initializeConductorSlots` は `state.mainBranch` を渡す（Step 4 で daemon state に格納）。

- `main.ts:1358` の `cmdConductor` 内の呼び出し（env → config → "main" の三段フォールバック）:
  ```ts
  const config = await loadConfig();
  const mainBranch = process.env.CMUX_TEAM_MAIN_BRANCH?.trim()
    || config.mainBranch
    || "main";
  if (mainBranch === "main" && !process.env.CMUX_TEAM_MAIN_BRANCH && !config.mainBranch) {
    await log("main_branch_conductor_fallback", "reason=env_and_config_missing");
  }
  const rolePromptFile = await generateConductorRolePrompt(PROJECT_ROOT, mainBranch);
  ```

- **テスト観点**: `daemon.test.ts` / `conductor.test.ts` の既存テストが壊れないこと、手動 E2E で `.team/prompts/conductor-role.md` に `{{MAIN_BRANCH}}` 置換後の値（例: `main`, `develop`）が反映されること。

### Step 7: テンプレートの文言置換

**変更ファイル**（計 6 ファイル、8 箇所の edit）:

| # | ファイル | 行 | 変更種別 | 現在の文言 → 置換後 |
|---|---------|---|---------|-------------------|
| 1 | `skills/cmux-team/templates/ja/conductor-role.md` | L11 | 説明文の小修正 | 「このロール定義で `{{PROJECT_ROOT}}` は実際の絶対パスに置換される」→「このロール定義で `{{PROJECT_ROOT}}` と `{{MAIN_BRANCH}}` は実値に置換される」 |
| 2 | `skills/cmux-team/templates/ja/conductor-role.md` | L15 | curly brace 注意書き | §3.3 の ja 版更新後文言に置換 |
| 3 | `skills/cmux-team/templates/ja/conductor-role.md` | L497 | 禁止事項 | `- main ブランチで作業する（worktree を使う）` → `- {{MAIN_BRANCH}} ブランチで作業する（worktree を使う）` |
| 4 | `skills/cmux-team/templates/en/conductor-role.md` | L11 | 説明文の小修正 | `{{PROJECT_ROOT}} is replaced with an actual absolute path` → `{{PROJECT_ROOT}} and {{MAIN_BRANCH}} are replaced with actual values` |
| 5 | `skills/cmux-team/templates/en/conductor-role.md` | L15 | curly brace 注意書き | §3.3 の en 版更新後文言に置換 |
| 6 | `skills/cmux-team/templates/en/conductor-role.md` | L448 | 禁止事項 | `- Work on the main branch (use worktree)` → `- Work on the {{MAIN_BRANCH}} branch (use worktree)` |
| 7 | `skills/cmux-team/templates/ja/conductor-task.md` | L13 | 禁止事項 | `main ブランチに直接変更を加えてはならない。` → `{{MAIN_BRANCH}} ブランチに直接変更を加えてはならない。` |
| 8 | `skills/cmux-team/templates/en/conductor-task.md` | L13 | 禁止事項 | `Do not make changes directly on the main branch.` → `Do not make changes directly on the {{MAIN_BRANCH}} branch.` |

#### inspector.md のランタイム検出化（design-review 指摘 5 / §2.3 参照）

| # | ファイル | 行 | 変更種別 |
|---|---------|---|---------|
| 9 | `skills/cmux-team/templates/ja/inspector.md` | L51 | bash スクリプトの main ハードコード解消 |
| 10 | `skills/cmux-team/templates/en/inspector.md` | L51 | 同上 |

**変更内容（両ロケール共通）**:

```diff
- TOUCHED=$(git diff main...HEAD --name-only -- '*.ts' '*.tsx' | tr '\n' '|' | sed 's/|$//')
+ BASE=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||' || echo main)
+ TOUCHED=$(git diff "$BASE"...HEAD --name-only -- '*.ts' '*.tsx' | tr '\n' '|' | sed 's/|$//')
```

- `{{MAIN_BRANCH}}` テンプレ変数は使わない。理由: inspector.md は Agent テンプレで `template.ts` 経由の substitution がないため、runtime 検出のほうが変更コストが低い。
- fallback `|| echo main` により origin/HEAD 未設定でも動作。

#### 置換時の注意

- `main` の単語置換（`:%s/main/.../g`）ではなく **該当行のみ** 手動 Edit。
- 機械的な sed 置換は避ける。`git merge <branch>`, `main.ts`, `main.log` 等も `main` を含むため。

#### テスト観点

- 置換後に `cmux-team start` で `.team/prompts/conductor-role.md` / conductor-task.md を生成し、`{{MAIN_BRANCH}}` が値に置き換わっていることを `cat` で確認。未置換のまま `{{MAIN_BRANCH}}` が残っていたらバグ。
- inspector.md は generator を通らないため、テンプレートそのものに `{{MAIN_BRANCH}}` が残らないこと（ランタイム検出スクリプトに置き換わっていること）を確認。

### Step 8: CLAUDE.md と docs/spec/04-templates.md 更新

**変更ファイル**:
- `CLAUDE.md`
- `docs/spec/04-templates.md`

#### CLAUDE.md の変更

1. **「テンプレート変数仕様 > Conductor 変数」テーブル**に追加:
   ```
   | `{{MAIN_BRANCH}}` | conductor-role, conductor-task | プロジェクトの主開発ブランチ（config.mainBranch で解決） |
   ```

2. **新規セクション「プロジェクト設定（.team/config.json）」を「レイアウト戦略」直後に追加**（短く、設定例 + 優先順位のみ）:
   ```markdown
   ## プロジェクト設定（.team/config.json）

   | フィールド | 型 | 説明 |
   |---------|---|------|
   | `models` | object | ロール別モデル指定 |
   | `layout` | "wide" \| "16x9" | レイアウトモード |
   | `mainBranch` | string | Conductor のマージ先ブランチ（未設定なら起動時に自動検出） |
   | `autoUpdate` | "off" \| "notify" \| "task" | 自動更新モード |
   | `sleepPrevention` | boolean | スリープ抑制 |

   **mainBranch の優先順位**: env `CMUX_TEAM_MAIN_BRANCH` > `config.mainBranch` > `git symbolic-ref refs/remotes/origin/HEAD` 自動検出 > `"main"` フォールバック。
   ```

3. **「git worktree（概要）」セクションの文言**: `main ブランチは常に無傷` は一般的な文脈なので変更しない（単なる説明文）。

#### docs/spec/04-templates.md の変更（design-review 指摘 3）

具体的に以下 4 箇所を更新:

| 行 | 現在 | 変更後 |
|---|-----|-------|
| L71-82 付近（「conductor.md（フルプロトコル版）」セクション冒頭） | — | **追記**: `**※ このテンプレートは現在 `template.ts` から参照されておらず、deprecated 扱いです（2026-04 時点）。conductor-role.md / conductor-task.md を参照してください）**` — design-review 指摘 4 への対応 |
| L82 | `**テンプレート変数:** {{WORKTREE_PATH}}, {{CONDUCTOR_ID}}, {{PROJECT_ROOT}}, {{OUTPUT_DIR}}, {{TASK_STATUS_FILE}}` | （deprecated なので変更しない） |
| L88 | `**テンプレート変数:** {{TASK_CONTENT}}, {{WORKTREE_PATH}}, {{CONDUCTOR_ID}}, {{OUTPUT_DIR}}, {{TASK_STATUS_FILE}}` | `**テンプレート変数:** {{TASK_CONTENT}}, {{WORKTREE_PATH}}, {{CONDUCTOR_ID}}, {{OUTPUT_DIR}}, {{TASK_STATUS_FILE}}, {{BASE_BRANCH}}, {{MAIN_BRANCH}}` — 既存脱落していた `{{BASE_BRANCH}}` も補正 |
| L108 | `**テンプレート変数:** {{PROJECT_ROOT}}, {{CONDUCTOR_ID}}（パス情報はタスク割り当て時に付与）` | `**テンプレート変数:** {{PROJECT_ROOT}}, {{MAIN_BRANCH}}, {{CONDUCTOR_ID}}（パス情報はタスク割り当て時に付与）` |
| L414 | `\| {{BASE_BRANCH}} \| conductor-task \| タスクの target ブランチ（未指定時は "main（デフォルト）"） \|` | `\| {{BASE_BRANCH}} \| conductor-task \| タスクの target ブランチ（未指定時は config.mainBranch にフォールバック） \|` |

加えて L414 付近の変数定義テーブルに `{{MAIN_BRANCH}}` 行を追加:
```
| `{{MAIN_BRANCH}}` | conductor-role, conductor-task | プロジェクトの主開発ブランチ（config.mainBranch で解決。未設定時は起動時自動検出） |
```

#### 旧版 conductor.md の扱い（design-review 指摘 4）

- `skills/cmux-team/templates/{ja,en}/conductor.md` は本タスクで**置換しない**。
- 代わりに `docs/spec/04-templates.md` L71（conductor.md セクション冒頭）に deprecated 注記を追加し、spec と実装の乖離を回避する。
- 完全削除は将来の別タスク（例: T220+）で扱う。

#### テスト観点

- docs の lint / リンク切れなし。
- `cat docs/spec/04-templates.md | grep MAIN_BRANCH` で新変数が言及されていることを確認。

## 5. 確認ポイントとの対応

| # | 確認ポイント | 満たし方 |
|---|------------|---------|
| 1 | 既存プロジェクト（main ブランチ）: 起動時に自動検出され config に `"mainBranch": "main"` が書き込まれる | Step 2 の `resolveMainBranch` が `git symbolic-ref refs/remotes/origin/HEAD` → `main` を検出 → Step 3 で `persistMainBranch` 経由で config.json に書き込み → `log("main_branch_resolved", "branch=main source=detected")` |
| 2 | develop ブランチ運用: `.team/config.json` に `"mainBranch": "develop"` を手動設定すると Conductor プロンプトに反映される | Step 2 で `configMainBranch="develop"` なら即 `source=config` で返し、writeback せず。Step 5/6 で `{{MAIN_BRANCH}}` が `develop` に置換される。`.team/prompts/conductor-role.md` に `develop ブランチで作業する` が出力される |
| 3 | origin/HEAD 未設定: フォールバックが動き警告ログが出る | Step 2 で `origin/HEAD` 失敗 → `HEAD` 失敗（detached 想定）または成功 → 両方失敗時 `log("main_branch_fallback", "reason=git_detect_failed")` + `log("main_branch_resolved", "source=fallback")` |
| 4 | 後方互換性: 既存の `.team/config.json` に `mainBranch` がなくても正常動作する | Step 2 で `configMainBranch` が undefined なら自動検出へ進む。`TeamConfig.mainBranch` を optional にしているため TypeScript の型エラーなし。既存の `initInfra` のデフォルト config にも `mainBranch` は含めない（start 時に自動検出で書き込まれる） |

## 6. リスク / 懸念

### 6.1 既存テストへの影響（design-review 指摘 10）

本タスクのシグネチャ変更で影響を受けるテストファイルを grep で実地調査した結果:

| ファイル | 行 | 呼び出し | 影響 | 対応 |
|---------|---|----------|------|------|
| `skills/cmux-team/manager/daemon.test.ts` | L258 | `generateConductorRolePrompt` / `generateConductorTaskPrompt` import + モック | 型エラー | モック呼び出しに `mainBranch = "main"` を追加 |
| `skills/cmux-team/manager/conductor.test.ts` | L62 | `assignTask(conductor, "999", testDir)` | 3 引数 → 4 引数 | 末尾に `"main"` を追加 |
| `skills/cmux-team/manager/conductor.test.ts` | L80 | `assignTask(conductor, "42", testDir)` | 同上 | 同上 |
| `skills/cmux-team/manager/conductor.test.ts` | L95 | `assignTask(conductor, "999", testDir)` | 同上 | 同上 |

- `conductor.test.ts` の 3 ケースはいずれも file-not-found / worktree-add 失敗の早期 throw パスで、`generateConductorTaskPrompt` に到達しない。dummy `"main"` で十分。
- `main-branch.test.ts` は新規追加（Step 2）。
- **対策**: テスト内容を確認してから Step 5 → Step 6 を順に実行する。

### 6.2 `baseBranch` フォールバックの動作変更

- 既存テンプレート `conductor-task.md` 34 行目は `{{BASE_BRANCH}}` を使っており、現状のフォールバックは `"main（デフォルト）"` という日本語注記付き文字列。T213 後は `mainBranch`（注記無し）になる。
- ユーザーが `config.mainBranch` を設定している場合、conductor-task プロンプト内の表示から「デフォルト」の文言が消える → 「自動的に main 以外が選ばれている」ことに気付きにくい可能性。
- **対策**: `main_branch_resolved` ログを必ず出す + CLAUDE.md に config フィールドとしてドキュメント化。Conductor は config に追従するだけで、ユーザーへの明示は Master / TUI ダッシュボードの責務。

### 6.3 Conductor 子プロセスと daemon の writeback race（design-review 指摘 2）

**リスクの本質**: `cmdStart` が `persistMainBranch` を呼ぶ前に Conductor が起動するケース、または `loadConfig()` 結果がキャッシュされるケースで、Conductor の role prompt が誤って `main` で生成される可能性。

**対策（ベルト&サスペンダー、§3.1 参照）**:

1. **初期化順序の固定** — `resolveMainBranch → persistMainBranch → createDaemon → initializeConductorSlots` の順を `cmdStart` で厳守する。これにより `config.json` への writeback は Conductor 起動前に確実に完了する。

2. **env 注入** — `launchConductor` が `export CMUX_TEAM_MAIN_BRANCH=<branch>` をシェルに焼き付ける。`cmdConductor` は env → config → `"main"` の三段フォールバック。env が第一ソースなので、たとえ順序が将来崩れても Conductor は正しい値を取得できる。

3. **フォールバック到達時のログ** — `main_branch_conductor_fallback` イベントで env / config 両方未設定の異常状態を記録。

これにより race は**構造的に排除**される（順序 + env の二重防御）。

### 6.4 `git symbolic-ref` の stderr 情報

- ロギングポリシー（CLAUDE.md「必ずログすべきイベント」）で「外部コマンド失敗時は stderr を含める」と明記されている。
- **対策**: `main-branch.ts` の catch 節で `e.stderr` を文字列化して log に含める（上記 Step 2 のサンプルコード参照）。

### 6.5 非 git ディレクトリでの起動

- cmux-team は git リポジトリ前提（worktree 作成のため）だが、preflight チェックの範囲は要確認。
- **対策**: `resolveMainBranch` は自動検出失敗時に `"main"` へ fallback するため、非 git 環境でもクラッシュしない。ただし preflight でそもそも止まる想定。

### 6.6 `configMainBranch` に不正値が入っているケース

- 手書きされる可能性があるため、`""`（空文字）や改行込みの文字列が入る可能性。
- **対策**: `resolveMainBranch` で `configMainBranch?.trim()` を検証し、空文字なら自動検出へ進む。バリデーションは最小限（Zod 化は別タスク）。

### 6.7 スコープクリープ

- 仕様書の「非対象」で CLI サブコマンド追加（`cmux-team config set main-branch <name>`）は除外されている。
- **対策**: Step 8 で CLAUDE.md に「手動で config.json を編集する」という運用を明記。CLI は追加しない。

## 7. 実装順序（推奨）

1. Step 1（schema 型追加） — ブロッカー少、最初
2. Step 2（main-branch.ts + テスト） — 独立した関数、TDD 可能
3. Step 5（template.ts シグネチャ変更） — Step 6 の準備
4. Step 6（呼び出し側更新） — Step 5 とセット
5. Step 3（cmdStart 統合） — 上記完了後
6. Step 4（DaemonState 拡張） — Step 3/6 とセット
7. Step 7（テンプレート文言置換） — 並行可能だが最後の方が安全
8. Step 8（ドキュメント更新） — 最後
9. 手動 E2E テスト:
   - clean で `cmux-team start` → config に mainBranch=main 書き込み確認
   - config に `"mainBranch": "develop"` 手書き → prompts/conductor-role.md に `develop ブランチで作業する` 確認
   - `git symbolic-ref` をわざと壊して fallback 動作確認（別リポジトリ or `git remote remove origin`）

## 8. Revision History

### v2 (2026-04-16) — design-review.md フィードバックへの対応

design-review.md の Changes Requested（Critical 2件 + Minor 8件）に対応して plan.md を更新。

| # | 指摘 (Severity) | 対応箇所 | 対応内容 |
|---|----------------|---------|---------|
| 1 | conductor-role.md の curly brace 注意書き未更新 (Critical) | §3.3 / Step 7 #1,2,4,5 | ja/en 両ロケールの L11, L15 を更新対象に追加。更新後文言を §3.3 に明記 |
| 2 | daemon → Conductor の mainBranch 伝達 race (Critical) | §3.1 / §6.3 / Step 6 | 初期化順序固定 + env 注入（`CMUX_TEAM_MAIN_BRANCH`）の二重防御。`cmdConductor` は env → config → `"main"` の三段フォールバック |
| 3 | docs/spec/04-templates.md 更新箇所が曖昧 (Minor) | Step 8 | L71（deprecated 注記）/ L88（`{{BASE_BRANCH}}` 脱落補正 + `{{MAIN_BRANCH}}` 追加）/ L108（`{{MAIN_BRANCH}}` 追加）/ L414（`{{BASE_BRANCH}}` 説明を `config.mainBranch` フォールバックに書き換え）を個別に列挙 |
| 4 | 旧版 conductor.md の扱い (Minor) | §2.3 / Step 8 | (a) deprecated 明記案を採用。04-templates.md L71 に注記を追加し、spec と実装の乖離を解消。置換は行わない（本タスクスコープ外） |
| 5 | inspector.md:51 の main ハードコード (Minor) | §2.3 / Step 7 #9,10 | 同コミットで解消する方針を採用。ただし `{{MAIN_BRANCH}}` ではなく**ランタイム検出スクリプト**に置換（inspector.md は generator 非経由のため）。`git symbolic-ref refs/remotes/origin/HEAD` + fallback `echo main` |
| 6 | cmdResume の影響調査欠落 (Minor) | Step 6 | 事前影響調査テーブルに「cmdResume: 影響なし — claude --resume で既存セッション復元、role prompt 再生成しない」と明記 |
| 7 | `generateConductorTaskPrompt` のシグネチャ順序 (Minor) | Step 5 | `mainBranch` を末尾 optional 引数に変更。`mainBranch ?? "main"` でフォールバック保障 |
| 8 | `resolveMainBranch` の入力検証 (Minor) | Step 2 サンプルコード | `const cfg = opts.configMainBranch?.trim(); if (cfg) return ...` に修正。空文字 / 改行のみは自動検出にフォールスルー |
| 9 | `main_branch_detect_step` のイベント名 (Minor) | Step 2 サンプルコード | `main_branch_detect_failed step=origin_head` / `step=head` に改名。ロギングポリシーの `*_failed` パターンに準拠 |
| 10 | `conductor.test.ts` への影響調査欠落 (Minor) | §6.1 / Step 6 事前影響調査 | grep 実施結果を plan に記載: L62 / L80 / L95 の 3 箇所が `assignTask(conductor, "id", testDir)` の 3 引数呼び出し。末尾に `"main"` ダミーを追加（早期 throw パスで template 到達しないため dummy で十分） |
