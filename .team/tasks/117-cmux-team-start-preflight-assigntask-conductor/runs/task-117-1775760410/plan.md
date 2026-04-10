# 実装計画書: タスク 117

## 目的

`cmux-team start` に **preflight チェック** を導入し、git リポジトリでない等の致命的な環境不備を起動直後に検出して即 exit する。あわせて `daemon.ts` の assignTask 失敗時処理を見直し、**タスク側の準備失敗**（worktree 作成失敗など）で健全な Conductor を巻き込んで disconnected にしないよう影響を分離する。

これにより、`git init` 忘れのような単純ミスで 3 つの Conductor がすべて破壊されて詰むという現状を解消する。正常起動後の worktree 失敗でも、該当タスクのみ abort され、残りの Conductor はタスクを処理し続ける。

## 対象ファイルと変更内容

### 1. preflight チェック追加

#### 新規ファイル: `skills/cmux-team/manager/preflight.ts`

検証ロジックを独立モジュール化する。`main.ts` に inline すると start コマンドが肥大化し、単体テストも書けないため分離する。

**エクスポート API:**

```ts
export interface PreflightIssue {
  key: "not_git_repo" | "claude_not_found" | "bun_not_found" | "team_dir_not_writable";
  message: string;         // 1 行見出し（日本語）
  hint: string;             // 解決方法（複数行可）
  context?: string;         // 付加情報（例: カレントディレクトリパス）
}

export interface PreflightResult {
  ok: boolean;
  issues: PreflightIssue[];
}

/**
 * cmux-team start に必要な前提を検証する。
 * issues が 1 件でもあれば ok=false を返す。
 * プロセスの終了はしない（呼び出し側の責務）。
 */
export async function runPreflight(projectRoot: string): Promise<PreflightResult>;

/**
 * PreflightResult を整形して console.error に出力する。
 * ok=true の場合は何もしない。
 */
export function printPreflightIssues(result: PreflightResult): void;
```

**検証項目と実装方針:**

| key | 検証 | 実装 |
|-----|------|------|
| `not_git_repo` | projectRoot が git リポジトリ | `execFile("git", ["rev-parse", "--git-dir"], { cwd: projectRoot })` が rejects しないこと |
| `claude_not_found` | `claude` バイナリが PATH | `Bun.which("claude")` が `null` でないこと。`execFile("which", ...)` は最小化 Linux コンテナで `which` 自体が不在の環境があり誤検知するので採用しない。外部プロセス起動不要・bun test 実行速度にも寄与 |
| `bun_not_found` | `bun` バイナリが PATH | `Bun.which("bun")` が `null` でないこと |
| `team_dir_not_writable` | `projectRoot` 直下に書き込み可能 | `projectRoot` 直下に `.cmux-team-preflight-test` を `writeFile` → `unlink` で検査する。**`.team/` 自体は触らない**（作成は `initInfra` に完全委譲）。preflight が `mkdir(.team)` してしまうと「preflight 失敗で exit したのに空の `.team/` だけ残る」という不整合状態を生むため |

- どの検証も **try/catch で失敗を issue として積む** 方式で、途中で throw しない。`runPreflight` は全検証を必ず走り切る（「`git init` 忘れ」と「`claude` 未インストール」が同時にある場合、一度に両方提示するため）
- hint は **ユーザーが直接コピペして直せる形** に揃える。改行を含めて OK
- `printPreflightIssues` は CI でも読める ANSI なしの素直な整形にする（cmux のペイン幅狭い画面でも読めるように）
- `printPreflightIssues` の出力先は **`console.error`** を使う（`main.ts:191` の既存エラー出力パターンに揃える）。`process.stderr.write` は使わない

**出力例（`printPreflightIssues`）:**

```
❌ cmux-team start: 前提チェックに失敗しました

  ✗ git リポジトリではありません
    /Users/yamamoto/git/KDG-discord-listner

    解決方法:
      cd /Users/yamamoto/git/KDG-discord-listner
      git init
      git add -A && git commit -m "Initial commit"

  ✗ claude バイナリが見つかりません

    解決方法:
      https://docs.claude.com/en/docs/claude-code/overview を参照して
      Claude Code をインストールしてください
```

#### 変更: `skills/cmux-team/manager/main.ts`

**修正箇所:** `cmdStart()` 関数（`main.ts:174-` 付近）

**変更内容:**

- import 文に `import { runPreflight, printPreflightIssues } from "./preflight";` を追加
- `cmdStart()` 内、現状の cmux 環境チェック（`main.ts:189-193`）直後、`createDaemon(PROJECT_ROOT)` 呼び出し（`main.ts:195`）の**前**に preflight 実行を挟む

**挿入コード:**

```ts
  // --- preflight チェック ---
  // daemon 起動前に前提を検証し、失敗時は即 exit
  // （daemon / Master / Conductor を spawn した後で失敗すると
  //  中途半端なプロセスが残るため、spawn する前に止める）
  const preflight = await runPreflight(PROJECT_ROOT);
  if (!preflight.ok) {
    printPreflightIssues(preflight);
    process.exit(1);
  }
```

- log 出力は敢えてしない（daemon_started 前なので `.team/logs/manager.log` もまだ使えるか怪しい上、ユーザーは stderr を見る）
- **注意:** 既存の `!process.env.CMUX_SOCKET_PATH` チェックは残す。これは preflight とは別次元（cmux 環境外での誤起動防止）

### 2. assignTask エラー影響分離

#### 変更: `skills/cmux-team/manager/conductor.ts`

**目的:** `assignTask` の失敗を「タスク側」と「Conductor 側」に型で区別できるようにする。

**修正箇所:** `conductor.ts:199-332`（`assignTask` 関数全体）

**型定義追加（ファイル上部、`sleep` 関数の下あたり）:**

```ts
/**
 * assignTask 失敗時の分類
 * - "task": タスク固有の問題（worktree 作成失敗、タスクファイル不備など）
 *   → 該当タスクを abort、Conductor は idle のまま
 * - "conductor": Conductor 側の問題（cmux send 失敗、surface 不在など）
 *   → Conductor を disconnected にする
 */
export type AssignFailureKind = "task" | "conductor";

export class AssignTaskError extends Error {
  constructor(
    public readonly kind: AssignFailureKind,
    public readonly reason: string,
    public readonly cause?: unknown
  ) {
    super(reason);
    this.name = "AssignTaskError";
  }
}
```

**戻り値型の変更:**

現状: `Promise<ConductorState | null>` で `null` が失敗を表す → 失敗理由を呼び出し側で判定できない。

**案 A（推奨）**: 成功時のみ `ConductorState` を返し、失敗時は `AssignTaskError` を throw する。daemon 側で `try/catch` して kind で分岐。

```ts
export async function assignTask(
  conductor: ConductorState,
  taskId: string,
  projectRoot: string
): Promise<ConductorState>
```

- 破壊的変更だが、`assignTask` の呼び出し元は `daemon.ts:654` の 1 箇所と `conductor.ts:467`（`spawnConductor` 内）の 1 箇所のみ。両方を同時修正すれば安全
- 例外を型で返すことで、呼び出し側の `if (updated)` 分岐が `try/catch (e: AssignTaskError)` に置き換わり、分類ロジックを type-safe にできる

**関数内の分類箇所:**

1. **タスクファイル不在**（`conductor.ts:234-237`）
   ```ts
   if (!taskContent) {
     throw new AssignTaskError("task", `task file not found: id=${taskId}`);
   }
   ```
   → 現状は `log` して `return null` だが、log は呼び出し側に任せ、ここでは throw だけ

2. **git worktree add 失敗**（`conductor.ts:246-248`）
   ```ts
   try {
     await execFile("git", ["worktree", "add", worktreePath, "-b", branch], {
       cwd: projectRoot,
     });
   } catch (e: any) {
     throw new AssignTaskError("task", `git worktree add failed: ${e.message}`, e);
   }
   ```
   → これが Problem 2 の直撃ポイント。明示的に `"task"` に分類

3. **プロンプト生成失敗**（`conductor.ts:281-290` の `generateConductorTaskPrompt`）
   → 既存は try/catch なしで throw が伝播。そのまま catch して `"task"` 扱いに

4. **`cmux.send` / `cmux.sendKey` 失敗**（`conductor.ts:294-305`）
   → Conductor surface 不在の徴候なので `"conductor"` に分類
   ```ts
   try {
     await cmux.send(conductor.surface, "/clear");
     await sleep(500);
     await cmux.sendKey(conductor.surface, "return");
     await sleep(2000);
     await cmux.send(conductor.surface, `${promptFile} を読んで...`);
     await sleep(500);
     await cmux.sendKey(conductor.surface, "return");
   } catch (e: any) {
     throw new AssignTaskError("conductor", `cmux send failed: ${e.message}`, e);
   }
   ```

5. **`cmux.renameTab` 失敗**（`conductor.ts:308-310`）— **修正必須**
   → 非致命的（タブ名は表示用）。現状 try/catch が**無い**ため、関数末尾の catch-all でキャッチされ、新ロジックでは `AssignTaskError("task", ...)` にラップされてタスクが abort される。タブ名更新の失敗でタスクが吹き飛ぶのは明らかに誤り。以下のように **明示的に握りつぶして log のみ** にする:
   ```ts
   try {
     await cmux.renameTab(conductor.surface, `[${num}] ♦ T${taskId} ${shortTitle}`);
   } catch (e: any) {
     await log("error", `renameTab failed: surface=${conductor.surface} ${e.message}`);
   }
   ```
   これは CLAUDE.md のロギングポリシー「冪等な後処理（`renameTab` 等）は握りつぶし可」と整合。**この修正を忘れると「renameTab 失敗でタスクが即 abort」という新しい悪い挙動を混入させるため、実装項目として必須**

6. **想定外の例外**（関数末尾の catch all）
   → 既存の `catch (e: any)` ブロック（`conductor.ts:328-331`）を残し、`AssignTaskError` はそのまま re-throw、それ以外は `new AssignTaskError("task", ...)` でラップ（保守的に task 側にフォールバック）

**関数末尾の catch 再構成:**

```ts
  } catch (e: any) {
    if (e instanceof AssignTaskError) throw e;
    // 想定外エラーはタスク側に寄せる（Conductor を守る）
    throw new AssignTaskError("task", `assignTask unexpected error: ${e.message}`, e);
  }
```

※ log 出力は呼び出し側（daemon）に移譲する（呼び出し側が kind 別に詳細 log するため）

#### 変更: `skills/cmux-team/manager/daemon.ts`

**修正箇所 1:** `daemon.ts:594`（`scanTasks` 宣言行）

**変更内容:**

- `async function scanTasks(...)` → `export async function scanTasks(...)` に変更する（1 語追加）
- 目的: `daemon.test.ts` から直接呼び出して統合テストを可能にする
- 影響範囲: `grep -rn "scanTasks" skills/cmux-team/manager/ --include="*.ts"` で daemon.ts 内部以外に参照なし → 影響ゼロ

**修正箇所 2:** `daemon.ts:643-674`（`scanTasks` 内の assignTask 呼び出しループ）

**変更内容:**

1. `conductor.ts` から `AssignTaskError` を import
2. `task.ts` から（必要なら）helper を import。必要なら `markTaskAborted(projectRoot, taskId, journal)` を task.ts に新設してそれを使う
3. `assignTask` 呼び出しを `try/catch` に変更

**変更後コード案:**

```ts
for (const task of allExecutable) {
  const idleConductor = [...state.conductors.values()].find(c => c.status === "idle");
  if (!idleConductor) {
    await log("throttled", `task_id=${task.id} no_idle_conductor`);
    break;
  }

  assignedIds.add(task.id);

  let updated: ConductorState | null = null;
  try {
    updated = await assignTask(idleConductor, task.id, state.projectRoot);
  } catch (e: unknown) {
    if (e instanceof AssignTaskError) {
      if (e.kind === "task") {
        // タスク側の問題 → 該当タスクを abort し Conductor は idle のまま
        const ts = await loadTaskState(state.projectRoot);
        ts[task.id] = {
          ...ts[task.id],
          status: "aborted",
          abortedAt: new Date().toISOString(),
          journal: `assign_failed: ${e.reason}`,
        };
        await saveTaskState(state.projectRoot, ts);
        // assignedIds は下の sync で次回 tick に openTasksList から外れる
        assignedIds.delete(task.id); // ローカル Set のため実質 no-op（allExecutable はループ突入前に確定、次 tick で assignedIds 再構築）。意図の明示として残す
        await log(
          "task_aborted",
          `task_id=${task.id} title=${task.title} journal_summary=assign_failed: ${e.reason}`
        );
        // 次のタスクへ。idle Conductor はそのまま維持
        continue;
      }
      // e.kind === "conductor" → 従来通り disconnected
      idleConductor.status = "disconnected";
      idleConductor.disconnectedAt = new Date().toISOString();
      await log(
        "conductor_disconnected",
        `surface=${idleConductor.surface} reason=assign_failed kind=conductor task_id=${task.id} detail=${e.reason}`
      );
      assignedIds.delete(task.id);
      continue;
    }
    // AssignTaskError 以外の想定外例外は最悪ケースとして conductor を落とす
    await log("error", `assignTask unexpected: task_id=${task.id} ${(e as Error).message}`);
    idleConductor.status = "disconnected";
    idleConductor.disconnectedAt = new Date().toISOString();
    assignedIds.delete(task.id);
    continue;
  }

  if (updated) {
    state.conductors.set(updated.surface, updated);
    const ts = await loadTaskState(state.projectRoot);
    ts[task.id] = {
      ...ts[task.id],
      status: 'assigned',
      assignedAt: new Date().toISOString(),
    };
    await saveTaskState(state.projectRoot, ts);
  }
}
```

**重要な変更点:**

- `e.kind === "task"` の場合、**Conductor の status を触らない**（idle のまま）
- タスクを `aborted` 状態にし、journal に原因を記録
- `continue` でループを継続し、**次のタスクを同じ idle Conductor に割り当てることができる**
- ログは既存 `task_aborted` 形式（`task_id=`, `title=`, `journal_summary=` キー）と **完全一致** させる。`dashboard.tsx:277-282` のパーサが `task_id=(\S+)` / `title=(.+?)(?:\s+\w+=|$)` / `journal_summary=(.+)` を正規表現で抽出しており、このキーを含めないと dashboard 側で常に固定文字列 "aborted" にフォールバックしてユーザーは原因を画面上で確認できない（本タスクの見える化目的と矛盾する）
- 既存 abort-task 実装（`main.ts:1543`, `main.ts:1595`）と同じ形式: `task_id=${task.id} title=${task.title} journal_summary=assign_failed: ${e.reason}`
- `conductor_disconnected` 側のログキー（`surface=`, `reason=`, `kind=`, `task_id=`, `detail=`）は既存 dashboard パーサの対象外なのでそのままで OK

#### 変更: `skills/cmux-team/manager/conductor.ts` の別呼び出し元（spawnConductor 内）

**修正箇所:** `conductor.ts:439-470` 付近（`spawnConductor`）

`spawnConductor` 内で `assignTask` を呼んでいる箇所も戻り値が変わるため修正。現状:

```ts
return await assignTask(conductor, taskId, projectRoot);
```

→ 変更後:

```ts
try {
  return await assignTask(conductor, taskId, projectRoot);
} catch (e) {
  if (e instanceof AssignTaskError) {
    await log("error", `spawnConductor assignTask failed: kind=${e.kind} ${e.reason}`);
    return null;
  }
  throw e;
}
```

※ `spawnConductor` は現状、起動時の 1 回の fallback パスで使われる程度。戻り値 `null` の仕様は変えない

**log 方針の一貫性について:** plan の基本方針は「`assignTask` の log 出力は呼び出し側に移譲する」だが、`spawnConductor` は戻り値 `null` 仕様を維持するため詳細情報（`kind`, `reason`）を呼び出し側に渡せない。したがって **`spawnConductor` 経路に限り kind に関係なく内部で log する**。daemon 側のメインパス（`scanTasks` のループ）でのみ kind で分岐したログを出す、という二層構造になる。これは意図的な例外であり齟齬ではない

## エラー分類ロジック

判定方法は **`AssignTaskError` のカスタム型** で明示する（メッセージ文字列 grep は避ける）。

| エラー発生元 | kind | 理由 |
|------------|------|------|
| タスクファイル不在 | `task` | タスクが壊れているだけで Conductor は無事 |
| `git worktree add` 失敗 | `task` | 典型的に「git 未初期化」「ブランチ名衝突」「ディスク満杯」。いずれも Conductor は無事 |
| `generateConductorTaskPrompt` 失敗 | `task` | テンプレート生成エラー = タスク情報が不十分 |
| `cmux.send` / `sendKey` 失敗 | `conductor` | surface が死んでいる徴候 |
| `execFile("npm", ["install"])` 失敗 | 既存ロジック維持（catch して log のみ、throw しない） | 警告扱い、assignTask 全体は成功させる |
| `cmux.renameTab` 失敗 | **握りつぶし（log のみ）**（新規 try/catch 追加が必須） | タブ名は装飾、機能に影響なし。catch-all に捕まると task abort されてしまうので必ず個別 try/catch |
| 想定外例外（catch all） | `task`（保守的） | Conductor を巻き込まない方を優先 |

## 型定義の変更

1. `AssignTaskError` クラスを `conductor.ts` に追加（export）
2. `AssignFailureKind = "task" | "conductor"` を export
3. `assignTask` の戻り値型を `Promise<ConductorState | null>` → `Promise<ConductorState>`（失敗時は throw）
4. `daemon.ts` の import に `AssignTaskError` を追加

**注意:** `schema.ts` には触らない（`ConductorState` 自体は変えない）

## テスト戦略

### 新規テストファイル: `skills/cmux-team/manager/preflight.test.ts`

`bun test` 用の単体テスト。既存の `daemon.test.ts` の流儀に合わせて `mkdtemp` で一時ディレクトリを作成する。

**テストケース:**

| ケース | 期待動作 |
|-------|---------|
| git リポジトリ内で実行 | `ok: true`, `issues: []`（ただし git 以外の検証は環境依存のため、少なくとも `not_git_repo` が含まれないことを検証） |
| 非 git ディレクトリで実行 | `ok: false`, `issues` に `not_git_repo` が含まれる |
| `projectRoot` への書き込み不可（`chmod 555`） | `ok: false`, `issues` に `team_dir_not_writable` が含まれる（macOS/Linux のみ、CI 環境次第でスキップ可）。**検証は `projectRoot` 直下の `.cmux-team-preflight-test` で行い、`.team/` は一切作らない** |
| 複数項目同時失敗 | 全 issue が配列に積まれる（途中で throw していない） |
| `printPreflightIssues` に空結果を渡す | 何も出力しない |
| preflight 実行後に `.team/` が存在しない | preflight 単独では `.team/` を作らないことを検証（`initInfra` との責務分離確認） |

**検証の注意:**

- `claude_not_found` / `bun_not_found` は CI 環境に依存するためテストしない（または `Bun.which` をモックして検証）
- `execFile` の stub は不要。実際に `git rev-parse` を走らせればよい（bun test は速い）
- `Bun.which("claude")` は bun runtime の PATH 参照を使うため、`process.env.PATH = ""` を一時的に設定することでテスト可能

### 既存ファイル拡張: `skills/cmux-team/manager/daemon.test.ts`

**前提: `scanTasks` を export する**

`scanTasks` は現状 `daemon.ts:594` で非 export（`async function scanTasks(...)`）のため、`daemon.test.ts` から直接呼べない。本タスクで **`scanTasks` を `export async function scanTasks(...)` に変更する**（1 行の差分）。

- `grep -rn "scanTasks" skills/cmux-team/manager/ --include="*.ts"` で確認する限り、`scanTasks` の参照は `daemon.ts` 内部のみで、他モジュールから import されていない → export 化による影響はゼロ
- 既存 `daemon.test.ts` は `loadTasks`, `filterExecutableTasks`, `saveTaskState` 等を直接 import して単体検証している流儀と整合する
- この変更を plan に明記する理由: 実装者が「`scanTasks` がテストから触れない → 統合テストはスキップ」と判断して手動 E2E だけに依存するリスクを避けるため（design-review Major 2 指摘）

**追加テストケース（scanTasks の assignTask エラー分離）:**

1. **統合テスト**: 実際に `scanTasks` を呼び、worktree 作成を失敗させる（git 未初期化の一時ディレクトリ）
2. **単体テスト**: `assignTask` を直接呼び、kind を検証する

**方針: 両方実装する。** `scanTasks` の export 化により統合テストも実装可能。

**`assignTask` 単体テスト（新規 `conductor.test.ts` を作成）:**

```ts
test("assignTask: taskファイル不在はtask kind", async () => {
  const conductor = createFakeConductor();
  try {
    await assignTask(conductor, "999", testDir);
    expect.unreachable();
  } catch (e) {
    expect(e).toBeInstanceOf(AssignTaskError);
    expect((e as AssignTaskError).kind).toBe("task");
  }
});

test("assignTask: git worktree add 失敗はtask kind", async () => {
  // testDir を git init しないまま、タスクファイルだけ用意
  const conductor = createFakeConductor();
  try {
    await assignTask(conductor, "001", testDir);
    expect.unreachable();
  } catch (e) {
    expect(e).toBeInstanceOf(AssignTaskError);
    expect((e as AssignTaskError).kind).toBe("task");
    expect((e as AssignTaskError).reason).toContain("git worktree add");
  }
});
```

- `cmux.send` / `sendKey` の mock が必要。`conductor` kind のテストは cmux モジュールを stub する必要があり複雑なので **task kind のテストに注力**し、conductor kind はコードレビューで確認する方針でよい

**`daemon.test.ts` の `scanTasks` 統合テスト:**

- 既存の scanTasks テストがあればそれに合わせる
- git 未初期化の testDir + ready タスク 1 件 + fake idle conductor 1 件 → `scanTasks` 後、タスクが `aborted` 状態、Conductor が `idle` のまま、を検証

**実装順序の都合で、`conductor.test.ts` の新規追加を推奨。** `cmux.send` が発火する前（git worktree add 段階）で失敗させればモック不要でテストできる。

### テストに含めないこと

- `cmux-team start` の end-to-end（cmux 環境依存、既存方針通り手動 E2E）
- 実際に `bun run main.ts start` を走らせる統合テスト（`CLAUDE.md` 記載の手動テスト手順で検証）

## 変更の影響範囲とリスク

### 影響範囲

| ファイル | 種類 | 影響 |
|---------|------|------|
| `skills/cmux-team/manager/preflight.ts` | 新規 | なし（新規追加のみ） |
| `skills/cmux-team/manager/preflight.test.ts` | 新規 | なし |
| `skills/cmux-team/manager/main.ts` | cmdStart に preflight 呼び出しを追加 | preflight 失敗時のみ exit 挙動変化 |
| `skills/cmux-team/manager/conductor.ts` | `assignTask` 戻り値型変更 + `AssignTaskError` 追加 + `spawnConductor` catch | 破壊的 API 変更だが内部関数 |
| `skills/cmux-team/manager/daemon.ts` | `scanTasks` を export 化 + assignTask ループ分岐変更 | エラー時の挙動変化（Conductor 巻き込み停止）。export 化は他モジュール未参照のため影響ゼロ |
| `skills/cmux-team/manager/conductor.test.ts` | 新規 | なし |
| `skills/cmux-team/manager/daemon.test.ts` | テスト拡張 | なし |

### リスク

1. **`assignTask` の戻り値型を変える破壊的変更**
   - リスク: 呼び出し漏れで実行時クラッシュ
   - 対策: grep で `assignTask(` の全呼び出しを列挙（現状 `daemon.ts:654` と `conductor.ts:467` の 2 箇所）して両方同時修正。bun の型チェックでも検出可能
2. **想定外エラーを "task" に寄せる保守的挙動**
   - リスク: 本来 Conductor 側の問題が「タスク側」に誤分類され、disconnected されずに詰まる可能性
   - 対策: log に `detail=${e.reason}` を必ず残し、ユーザーが `.team/logs/manager.log` で原因を追えるようにする。また、将来的に `conductor` kind に移動すべきエラーが見つかったら都度分類ロジックを追加する
3. **preflight の git 検証が GitHub Actions 等の shallow clone 環境で誤検知**
   - リスク: shallow clone でも `.git/` は存在するので `git rev-parse --git-dir` は成功するはず。問題なし
4. **書き込み権限テストが `projectRoot` を汚す**
   - リスク: preflight が `projectRoot/.cmux-team-preflight-test` を書いて残すと DirtyCommit 対象に
   - 対策: 必ず `unlink` まで実行、catch でクリーンアップを保証。ファイル名に `.cmux-team-preflight-test` とドットプレフィックスを付けることで万一残っても `.gitignore` パターン（`.*`）で拾えるようにする。`.team/` は preflight では**一切触らない**（`initInfra` に委譲）
5. **タスク側失敗が「一過性」の場合の扱い**
   - 例: git worktree のブランチが一時的に使われている等、リトライで成功するケース
   - 現状案では即 `aborted` にしてしまうが、これは妥協として受け入れる（シンプルさ優先、ユーザーは `create-task` で再投入できる）
   - 将来の改善案として `retry_count` を task state に追加してもよい（今回のスコープ外）

### 互換性

- `task-state.json` のスキーマ変更なし
- `.team/` 下のファイル構造変更なし
- CLI インターフェース変更なし（`cmux-team start` の引数は同じ）
- ログフォーマットは `task_aborted reason=assign_failed` 形式を新規追加するだけで既存形式は維持

## 実装順序

TDD で進める。各ステップで `bun test` がグリーンであることを確認してから次へ。

1. **preflight モジュール実装**
   1. `preflight.test.ts` を先に書く（git/non-git、複数項目失敗、print 出力）
   2. `preflight.ts` を実装し、テストをグリーンに
   3. `main.ts` の `cmdStart` に preflight 呼び出しを追加
   4. 手動で `cd /tmp && mkdir foo && cd foo && cmux-team start` 相当を想定して動作確認（実行可能な場合）

2. **AssignTaskError 型の導入**
   1. `conductor.ts` の上部に `AssignTaskError` クラスと `AssignFailureKind` 型を追加・export
   2. `assignTask` 関数の全失敗点を `throw new AssignTaskError(kind, reason)` に書き換え
   3. **`conductor.ts:310` の `cmux.renameTab` 呼び出しを try/catch で包む**（catch-all に捕まって task abort されないため。Minor 3 対応）
   4. 関数末尾の catch all を「`AssignTaskError` は re-throw、それ以外は task 分類でラップ」に
   5. 戻り値型を `Promise<ConductorState>` に変更

3. **assignTask 単体テスト追加**
   1. `conductor.test.ts` を新規作成（`daemon.test.ts` のヘルパー流儀に合わせる）
   2. タスクファイル不在ケース → `task` kind
   3. git 未初期化ケース → `task` kind（testDir を `git init` せずに構築）
   4. bun test がグリーンになることを確認

4. **daemon.ts の呼び出し元修正**
   1. `import { AssignTaskError } from "./conductor";` を追加
   2. **`scanTasks` を `export async function` に変更**（Major 2 対応、テストから直接呼ぶため）
   3. `scanTasks` 内の assignTask 呼び出しを try/catch 構造に書き換え
   4. kind 別分岐とログ出力を追加。**ログフォーマットは既存 `task_aborted` と完全一致させる**（`task_id=`, `title=`, `journal_summary=` キーを含める）
   5. 既存の `daemon.test.ts` がグリーンであることを確認
   6. `daemon.test.ts` に `scanTasks` 統合テスト（git 未初期化 + ready タスク → `aborted` 状態、Conductor `idle` 維持）を追加

5. **spawnConductor の呼び出し元修正**
   1. `conductor.ts` の `spawnConductor` 内の assignTask 呼び出しを try/catch でラップし `null` を返すよう維持

6. **統合的な確認**
   1. `bun test` 全体グリーン確認
   2. `bunx tsc --noEmit`（もし設定があれば）で型チェック
   3. 手動 E2E: `cmux-team start` が正常ケースで起動することを確認（既存の cmux-team ワークスペースで実行）
   4. 手動 E2E: `/tmp` 直下で `cmux-team start` して preflight が失敗メッセージを出すことを確認
   5. 手動 E2E: 正常起動後に壊れたタスク（存在しないブランチ名指定など）を投入し、該当タスクが abort されて他の Conductor が生き残ることを確認

## 完了条件

- `preflight.ts`, `preflight.test.ts`, `conductor.test.ts` が追加されている
- `main.ts` に preflight 呼び出しが入っている
- `preflight.ts` は `Bun.which()` を使用し、書込テストは `projectRoot` 直下の `.cmux-team-preflight-test` で行い `.team/` を作成しない
- `printPreflightIssues` は `console.error` を使用
- `conductor.ts` に `AssignTaskError` が追加され、`assignTask` が kind 付きで throw するようになっている
- `conductor.ts:310` の `cmux.renameTab` が個別 try/catch で包まれている
- `daemon.ts` の `scanTasks` が `export` され、`AssignTaskError` を受けて `task` と `conductor` で分岐している
- `task_aborted` ログが既存フォーマット（`task_id=`, `title=`, `journal_summary=` キー）と一致している
- `bun test` が全てグリーン
- 手動 E2E で「git 未初期化ディレクトリでの起動失敗」「正常起動後の worktree 失敗で Conductor が生き残る」の両方が確認できる
- 手動 E2E: dashboard で `task_aborted` が `journal_summary` 付きで正しく描画されることを確認

## 参考: 該当ソース位置サマリ

| 論点 | ファイル | 行 |
|-----|---------|-----|
| `cmdStart` 入口 | `skills/cmux-team/manager/main.ts` | 174-193 |
| preflight 挿入位置 | `skills/cmux-team/manager/main.ts` | 193-195 の間 |
| `assignTask` 本体 | `skills/cmux-team/manager/conductor.ts` | 199-332 |
| `git worktree add` 呼び出し | `skills/cmux-team/manager/conductor.ts` | 246-248 |
| `cmux.send` 呼び出し | `skills/cmux-team/manager/conductor.ts` | 294-305 |
| `assignTask` 呼び出し元（daemon） | `skills/cmux-team/manager/daemon.ts` | 654 |
| 失敗時の disconnected 化（修正対象） | `skills/cmux-team/manager/daemon.ts` | 665-673 |
| `assignTask` 呼び出し元（spawnConductor） | `skills/cmux-team/manager/conductor.ts` | 467 |
| 既存テスト構造参考 | `skills/cmux-team/manager/daemon.test.ts` | 全体 |
