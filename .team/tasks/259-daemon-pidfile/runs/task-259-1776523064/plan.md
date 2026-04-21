# T259: daemon 多重起動を防止する (pidfile ロック) — 実装計画書

## 1. 現状分析

### 1.1 `cmdStart` の現状フロー（`skills/cmux-team/manager/main.ts:251`）

抜粋構造（行番号は HEAD = task-259 ブランチ時点）:

| 行 | ステップ | 備考 |
|----|---------|------|
| L254-257 | `CMUX_SOCKET_PATH` 環境変数チェック | cmux 内部から呼ばれているかの確認。fail-stop |
| L259-267 | `runPreflight(PROJECT_ROOT)` | 前提検証（bun / cmux / worktree base 等）。fail-stop |
| L269-282 | `checkDirenvAllowed` | .envrc fail-fast |
| L284-306 | `loadConfig` + `resolveLayout` + sleep/autoUpdate 解決 | config だけ読む。副作用なし |
| L308-321 | `resolveMainBranch` + `persistMainBranch` | config 書き出しが発生する（副作用あり） |
| L323 | **`createDaemon(PROJECT_ROOT, layout)`** | ここで `DaemonState` が作成される |
| L328-396 | watcher / infra / proxy 起動（副作用あり） | proxy は port を書き込む |
| L432-455 | `shutdown` 関数定義 | |
| L456-457 | `process.on("SIGINT", shutdown)` / `process.on("SIGTERM", shutdown)` | |
| L459-537 | `startDashboard` + `onReload` 定義 | |
| L539-691 | Conductor / Master spawn | |
| L702-729 | メインループ（`state.running`） | |
| L732-737 | `restartRequested` で `process.exit(42)` | 親（cmux-team.js または L471 の onReload ループ）が拾って再起動 |
| L739 | `await shutdown()` | 正常終了経路 |

**pidfile acquire 挿入位置**: **L267 と L269 の間**（preflight 成功後、direnv チェック前）。

- **preflight の後**にする理由: preflight 失敗で即 exit する場合に pidfile を作って残さない
- **direnv / resolveMainBranch の前**にする理由: これらは `.team/config.json` に書き込むため、多重起動時に競合を誘発する。早期に排他を取りたい
- **`createDaemon` より前**にする理由: T259 仕様書の指示通り。watcher / proxy 起動前にロックする

### 1.2 `shutdown` 関数の現状（L434-455）

`shutdown` は `cmdStart` スコープ内のローカル関数。呼び出し経路は 3 つ:

1. **`process.on("SIGINT", shutdown)`** / **`process.on("SIGTERM", shutdown)`**（L456-457）
2. **`startDashboard` の `onQuit` コールバック**（L503 `onQuit: () => { shutdown(); }`）
3. **`cmdStart` メインループ抜け後の正常終了**（L739 `await shutdown()`）

`shutdown` は冪等性が無く、最終で `process.exit(0)` する。

別経路として:

- **SHUTDOWN message handler**（`daemon.ts:1813-1818`）: `state.running = false` にするだけで `process.exit` しない。メインループ（L702）を抜けさせ、L739 の `shutdown()` に流す
- **`cmdStop`**（L1846）: `postMessage({type:"SHUTDOWN"})` するだけ。実際の shutdown 処理は daemon 側で行う
- **`onFullQuit`**（L504-536）: Master/Conductor/Agent を全部 close したあと `process.exit(0)`。ここは `shutdown()` を**呼ばず直接 exit** している（pidfile unlink を別途実装する必要あり）
- **`onReload`**（L462-501）: 再起動のため `process.exit(0)` する（L501）。こちらも shutdown 経由ではない

### 1.3 `onReload` 再起動ループの仕組み（L459-501）

```ts
onReload: async () => {
  unmountDashboard();
  const latestMainTs = findLatestMainTs();
  await log("daemon_reload");
  stopDaemon(state);                 // state.running = false + pidWatcher 停止
  state.fileWatcherAbort?.abort();
  // 親プロセスは生きたまま子 bun を spawn する
  const { execFileSync } = require("child_process");
  const MAX_RESTARTS = 10;
  let restarts = 0;
  while (restarts < MAX_RESTARTS) {
    let exitStatus = 0;
    try {
      execFileSync("bun", ["run", latestMainTs, "start"], {
        stdio: "inherit",
        env: process.env,
        cwd: process.cwd(),
      });
      break;                          // 正常終了
    } catch (e: any) {
      exitStatus = e.status ?? 1;
    }
    if (exitStatus === 42) { restarts++; continue; }
    break;
  }
  process.exit(0);
};
```

**重要な観測**:

- **親プロセスが死なない**。`execFileSync` で子プロセスを `stdio:"inherit"` で起動し、子の終了を **同期的に待つ**。子が exit 42 を返すと親はリトライループに戻る
- つまり **pidfile には親の PID が書かれているが、親はシグナルを受け取らないブロッキング状態**。子が `cmdStart` を再度呼ぶと、その中で pidfile acquire が走り、親 PID を見て "alive" と判定して **fail-stop する**
- この問題を解決するには、`onReload` の中で **pidfile を一旦 release してから子を起動する** 必要がある。子の `cmdStart` で新しい PID で acquire され、子が終了（正常 or 42）すれば親が制御を取り戻す。親は L501 で `process.exit(0)` する
- もう一つの経路: `cmux-team.js` (ラッパー) からの exit 42 も同様。このときは親はシェル/cmux-team.js なので問題ないが、**`onReload` の親は自分自身**なので同ロジック内で pidfile 所有権を子に渡す必要がある

### 1.4 既存テストの書き方サンプル

- `bun:test` を使用（`import { describe, test, expect, beforeEach, afterEach } from "bun:test"`）
- 各テストごとに `mkdtemp(join(tmpdir(), "cmux-...-test-"))` で tmp dir を作る
- `afterEach` で `rm(testDir, { recursive: true, force: true })`
- 環境変数 `PROJECT_ROOT` をテスト内で設定・復元
- 純関数にはオプション引数で副作用（`git` コマンド等）を DI する（`main-branch.test.ts` の `git: async (args) => {...}` 参照）
- cmux 系の挙動は `__setIsAliveImpl` / `__setTreeImpl` で差し替え可能（`cmux.ts:217`）

## 2. 設計

### 2.1 `pidfile.ts` インターフェース

新規ファイル `skills/cmux-team/manager/pidfile.ts` を作成する。

```ts
import { log } from "./logger";

export interface AcquireOptions {
  /** リトライ回数（default 3） */
  retries?: number;
  /** リトライ間隔 ms（default 100） */
  retryIntervalMs?: number;
  /** 現在プロセスの pid を上書き（テスト用） */
  selfPid?: number;
  /** ps -p の代替実装（テスト用） */
  psCommand?: (pid: number) => Promise<string>;
  /** isAlive の代替実装（テスト用） */
  isAliveImpl?: (pid: number) => boolean;
}

/** pidfile が他プロセスに保持されている場合に throw する error クラス */
export class PidFileLockedError extends Error {
  constructor(public readonly existingPid: number, public readonly workspace: string) {
    super(
      `Error: daemon already running (pid=${existingPid}) at workspace=${workspace}. ` +
      `Run 'cmux-team stop' or kill ${existingPid} first.`
    );
    this.name = "PidFileLockedError";
  }
}

/**
 * pidfile を atomic に取得する。
 * - 存在しない: 新規作成
 * - 存在 & 生きてる & cmux-team 関連: PidFileLockedError
 * - 存在 & dead or 別プロセス: stale とみなし削除 → 再作成
 * - EEXIST race: 指定回数までリトライ
 */
export async function acquirePidFile(
  path: string,
  workspace: string,
  opts?: AcquireOptions,
): Promise<void>;

/** pidfile を削除する。存在しない場合は no-op。例外を握りつぶさず log だけは残す */
export async function releasePidFile(path: string): Promise<void>;

/** プロセス生存チェック（`cmux.isAlive` と同じだが、循環依存を避けるため複製。または cmux.ts から re-export） */
export function isAlive(pid: number): boolean;

/**
 * `ps -p <pid> -o command=` を叩き、出力を返す（trim 済み）。
 * 失敗（プロセス不在・ps コマンド不在）時は空文字を返す。
 * Windows は ps が無いためスキップ: 出力は常に空文字。
 */
export async function psCommand(pid: number): Promise<string>;

/** ps 出力に "main.ts" もしくは "cmux-team" が含まれれば真 */
export function looksLikeCmuxTeamProcess(psOutput: string): boolean;
```

**リトライ戦略**:
- `writeFile(path, pid, { flag: 'wx' })` で atomic に作成（`wx` = O_CREAT|O_EXCL）
- EEXIST が出たら: 既存 pidfile を read → PID を解釈 → alive かつ cmux-team なら `PidFileLockedError` を throw
- alive だが ps 出力が cmux-team らしくない、または read 時点で既に消えていた場合: stale → `unlink` → 再試行
- retries 回リトライして、毎回 EEXIST ならば最後に `PidFileLockedError`

**stale 判定**:
1. `isAlive(pid)` が false → stale（優先）
2. `isAlive(pid)` が true でも `ps -p` 出力に "main.ts" も "cmux-team" も含まない → stale（pid 再利用）
3. `ps -p` が失敗 or 空文字 → `isAlive` の結果だけで判定（保守的に alive なら alive）

### 2.2 `main.ts` への変更点

#### A. `cmdStart` 冒頭（L267-269 の間）に pidfile acquire を挿入

```ts
// --- T259: pidfile による多重起動防止 ---
const pidFilePath = join(PROJECT_ROOT, ".team/daemon.pid");
// .team ディレクトリは preflight で保証済み（存在しなければ preflight が失敗する）。
// acquire 時に `mkdir -p` は不要だが、念のため防御コードを入れてもよい。
try {
  await acquirePidFile(pidFilePath, PROJECT_ROOT);
} catch (e) {
  if (e instanceof PidFileLockedError) {
    console.error(e.message);
    await log("pidfile_locked", `existing_pid=${e.existingPid} workspace=${PROJECT_ROOT}`);
    process.exit(1);
  }
  throw e;
}
await log("pidfile_acquired", `path=${pidFilePath} pid=${process.pid}`);
```

#### B. `shutdown` 関数（L434-455）に unlink を追加

```ts
const shutdown = async () => {
  stopDaemon(state);
  state.fileWatcherAbort?.abort();
  state.fileWatcherAbort = null;
  updateCaffeinate(false);
  if (state.workspace) {
    await cmux.clearStatus("claude_code", state.workspace);
  }
  if (state.rateLimit) {
    try { await persistRateLimit(PROJECT_ROOT, state.rateLimit); }
    catch (e: any) { await log("rate_limit_persist_failed", `shutdown: ${e.message}`); }
  }
  await log("daemon_stopped");
  await updateTeamJson(state);
  await releasePidFile(pidFilePath);      // ★ 追加
  process.exit(0);
};
```

#### C. `onFullQuit`（L504-536）にも unlink を追加

L535 の `await updateTeamJson(state)` の直後・`process.exit(0)` の直前に:

```ts
await releasePidFile(pidFilePath);
process.exit(0);
```

#### D. `restartRequested` / `onReload` 経路に unlink を追加

**L732-737 の restartRequested ブロック**:

```ts
if (state.restartRequested) {
  unmountDashboard();
  await log("daemon_auto_restart");
  await updateTeamJson(state);
  await releasePidFile(pidFilePath);     // ★ 追加: 子 daemon が acquire できるようにする
  process.exit(42);
}
```

**L462-501 の `onReload` 内**: 親が pidfile を先に release → 子 bun 起動 → 子が新 PID で acquire。子が exit 42 を返したらリトライループ内で子は再度 acquire → release を繰り返す。親自身は L501 の `process.exit(0)` の直前には既に pidfile を持っていないので unlink 不要。ただし**子起動直前**に必ず release する:

```ts
onReload: async () => {
  unmountDashboard();
  const latestMainTs = findLatestMainTs();
  await log("daemon_reload");
  await log("daemon_reload_target", latestMainTs);
  stopDaemon(state);
  state.fileWatcherAbort?.abort();
  state.fileWatcherAbort = null;

  // ★ 追加: 所有権を子に渡す前に必ず release
  await releasePidFile(pidFilePath);

  const { execFileSync } = require("child_process");
  // ... 既存の restart ループ ...
  process.exit(0);
};
```

#### E. `cmdStop`（L1846-1853）に保険の unlink を追加

Manager が何らかの理由で shutdown handler を実行できずに死んだ場合の保険。SHUTDOWN を送信して daemon の shutdown を待ったうえで、pidfile が残っていれば削除する:

```ts
async function cmdStop(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_stop"));
  await postMessage({ type: "SHUTDOWN", timestamp: new Date().toISOString() });
  console.log("SHUTDOWN sent");

  // ★ 追加: daemon の shutdown 完了を短時間待ち、pidfile が残っていれば掃除
  //   daemon 側が unlink するのが正規ルートなので、ここは保険
  const pidFilePath = join(PROJECT_ROOT, ".team/daemon.pid");
  const MAX_WAIT_MS = 5000;
  const start = Date.now();
  while (Date.now() - start < MAX_WAIT_MS) {
    if (!existsSync(pidFilePath)) return;
    await sleep(200);
  }
  // タイムアウト: pidfile が残っていたら stale 判定して unlink
  try {
    const pid = parseInt((await readFile(pidFilePath, "utf-8")).trim(), 10);
    if (!isNaN(pid) && !isAlive(pid)) {
      await releasePidFile(pidFilePath);
      await log("pidfile_cleanup_after_stop", `stale_pid=${pid}`);
    }
  } catch {}
}
```

### 2.3 auto-restart との整合（擬似コード）

```
親 Start (PID=100)
  acquirePidFile      → daemon.pid = "100"
  ... daemon 稼働 ...
  state.restartRequested = true
    OR onReload 発火
  releasePidFile       → daemon.pid 削除
  execFileSync("bun", ["run", latestMainTs, "start"])  （子をブロッキング）
     子 Start (PID=200)
       acquirePidFile   → daemon.pid = "200"
       ... 子 daemon 稼働 ...
       子 state.restartRequested = true
       releasePidFile   → daemon.pid 削除
       process.exit(42)
     ← 親の execFileSync が例外で戻り、exit_status=42 を検出、再ループ
  execFileSync("bun", ...)
     子' Start (PID=300)
       acquirePidFile   → daemon.pid = "300"
       ... 正常終了 → shutdown() → releasePidFile → exit(0)
     ← 親の execFileSync が正常復帰、break
  process.exit(0)
```

**不変条件**: 「pidfile の内容」と「生きている daemon プロセス」は 1:1 対応するか、pidfile が不在。過渡的に「pidfile 不在だが daemon 稼働中」の状態は許容する（fail-stop されるのはこの瞬間の他 start だけ）。

### 2.4 `ps -p` 実装方針

```ts
export async function psCommand(pid: number): Promise<string> {
  if (process.platform === "win32") return "";
  try {
    const { stdout } = await execFileAsync(
      "ps", ["-p", String(pid), "-o", "command="],
      { timeout: 2000 },
    );
    return stdout.trim();
  } catch {
    return "";   // プロセス不在・タイムアウト・ps 不在のいずれも空文字で扱う
  }
}

export function looksLikeCmuxTeamProcess(psOutput: string): boolean {
  if (!psOutput) return false;
  return psOutput.includes("main.ts") || psOutput.includes("cmux-team");
}
```

- **macOS** (`ps -p <pid> -o command=`): `/usr/bin/bun run /path/to/main.ts start` のような行を返す
- **Linux** (procps `ps -p <pid> -o command=`): 同様。BusyBox では `-o` サポートが弱い可能性があるが、ヘッダが付くか全体が空になる程度で「cmux-team らしさ」の判定にはほぼ影響しない
- **失敗時**: 空文字を返し、呼び出し側で「`isAlive` が true でも ps が空なら stale と判定」のロジックに流す（→ pid 再利用誤検知対策）

## 3. TDD 実装ステップ（テストファースト）

新規テストファイル: `skills/cmux-team/manager/pidfile.test.ts`

### Step 1: `isAlive` / `looksLikeCmuxTeamProcess` の単体テスト → 実装

- テスト:
  - `isAlive(process.pid)` → `true`
  - `isAlive(4194303)` → `false`（架空 PID）
  - `looksLikeCmuxTeamProcess("")` → `false`
  - `looksLikeCmuxTeamProcess("bun run ..main.ts start")` → `true`
  - `looksLikeCmuxTeamProcess("node /some/other/script.js")` → `false`
  - `looksLikeCmuxTeamProcess("npx cmux-team start")` → `true`
- 実装: `pidfile.ts` にこれら関数を export

### Step 2: `acquirePidFile` の happy path → 実装

- テスト: 空ディレクトリで `acquirePidFile(path, ws)` を呼ぶと `path` に `process.pid` の文字列が書かれている
- テスト後半: `releasePidFile(path)` すると `existsSync(path)` が false
- 実装: `writeFile(path, String(pid), { flag: "wx" })`

### Step 3: 既存 pidfile（生存中）→ fail-stop

- テスト: 予め pidfile に `process.pid` を書いておく → `acquirePidFile` が `PidFileLockedError` を throw し `error.existingPid === process.pid`
- `isAliveImpl` と `psCommand` を DI して「alive かつ cmux-team らしい」状態を作る

### Step 4: 既存 pidfile（stale = dead）→ 上書き成功

- テスト: pidfile に `4194303`（架空 PID）を書いておく → `isAliveImpl: () => false` を DI → `acquirePidFile` は例外を吐かず、pidfile は新しい `process.pid` で上書きされる

### Step 5: 既存 pidfile（pid 再利用: alive だが ps 出力が cmux-team ではない）→ 上書き成功

- テスト: `isAliveImpl: () => true` かつ `psCommand: () => Promise.resolve("-zsh")` を DI → stale 判定で上書き成功

### Step 6: EEXIST race のリトライ

- テスト: まず pidfile に `4194303` (dead) を書く → `acquirePidFile` を呼ぶが、`writeFile` の fake 実装で最初の 1 回だけ EEXIST を投げて 2 回目で成功させる（あるいは `retries: 3, retryIntervalMs: 10` で自然にリトライさせる）
- 検証: リトライ後に pidfile が `process.pid` で書かれている

### Step 7: EEXIST が上限回数続く → PidFileLockedError

- テスト: `isAliveImpl: () => true`、`psCommand: () => "bun run main.ts"`（常に cmux-team らしい） → リトライしても acquire できず `PidFileLockedError`
- 検証: `error.existingPid` が正しい、`error.workspace` が正しい

### Step 8: `releasePidFile` の単体テスト

- 不在のパスに対して呼んでも例外を投げない（no-op）
- 存在するパスに対して呼ぶと削除される

### Step 9: `cmdStart` への統合（smoke）

- 既存 `main.test.ts` は `cmdStart` 全体を起動しない（小さな export のみをテスト）ため、regression は起きにくい。
- 追加: `pidfile.test.ts` の末尾に integration: 実際に 2 つの Bun subprocess で `bun run main.ts start` を並行起動し、2 番目が exit 1 で即死することを確認する。重いので `describe.skip` にし、`BUN_TEST_E2E=1` 環境変数で有効化する（既存 `e2e.ts` の慣行に合わせる）

### Step 9-alt: `cmdStart` の pidfile 挿入ポイントの間接検証

重い E2E を避ける方針なら、以下で十分:

- `main.ts` から **pidfile 挿入ロジックを切り出した小さな関数**（例: `runPidfileAcquire(projectRoot, log)`）を export
- 単体テストで「PidFileLockedError が投げられたら console.error + exit(1) を呼ぶ」を spy で検証
- `cmdStart` 本体は変更行数を最小にし、コール順序は目視レビューで確認

### Step 10: shutdown 経路のユニットテスト

- `releasePidFile` が shutdown 経路全て（SIGINT / SIGTERM / SHUTDOWN message / onFullQuit / restartRequested / onReload）で呼ばれるか、**シグナルハンドラ登録段階を部分的に抽出**して検証。もしくは grep / 目視レビュー + CHANGELOG で担保

### Step 11: auto-restart 結合テスト（オプション）

- Bun で 2 段 subprocess を spawn し、親 `onReload` がテスト用の分岐を経由して子を exec するか試す。実装リスクが高いため **今回は手動テストで確認**する（既存の E2E テストは自動化されていない）

## 4. 影響範囲

### 4.1 変更ファイル一覧

| ファイル | 変更内容 |
|---------|---------|
| `skills/cmux-team/manager/pidfile.ts` | **新規**: `acquirePidFile` / `releasePidFile` / `PidFileLockedError` / `isAlive` / `psCommand` / `looksLikeCmuxTeamProcess` |
| `skills/cmux-team/manager/pidfile.test.ts` | **新規**: 上記のユニットテスト |
| `skills/cmux-team/manager/main.ts` | `cmdStart` 冒頭に acquire、`shutdown` / `onFullQuit` / `restartRequested` / `onReload` / `cmdStop` に release |
| `CHANGELOG.md` | 「daemon 多重起動を防止する pidfile ロック」項目追加 |
| `CLAUDE.md`（プロジェクトルート） | 「Manager プロトコル（内部実装）」セクションに pidfile の記述を追加（任意だが推奨） |
| `docs/spec/05-install-and-infrastructure.md` | `.team/daemon.pid` ファイルの意味を追記（必要に応じて） |

### 4.2 既存テストで影響を受ける可能性

- `main.test.ts`: `cmdStart` を直接呼ばず個別関数を import して test しているため、pidfile 挿入による regression リスクは低い。要目視チェック
- `daemon.test.ts`: `createDaemon` を単体で呼ぶため、pidfile ロジックに触れない
- それ以外: `cmdStart` を外から起動するテストは存在しない

### 4.3 ドキュメント更新の要否

- **CLAUDE.md**: 「Manager プロトコル」セクションに 1-2 行で「`.team/daemon.pid` による多重起動防止」を記載すると future-you に親切
- **docs/spec/**: `00-project-overview.md` の設計原則「決定論的なものはコードで」の具体例として追記できるが、必須ではない

## 5. リスクと代替案

### 5.1 Windows 非対応の `ps -p`

- cmux-team は macOS/Linux 前提（cmux 自体が tmux ライクな Unix 依存）。Windows 対応は現状ロードマップ外
- `psCommand` は `process.platform === "win32"` で空文字を返す設計なので、`ps` が無い環境でも `isAlive(pid)` だけで判定が続行できる（誤検知は若干上がるが fail-safe 側）

### 5.2 NFS 等で `O_EXCL` が atomic にならない問題

- `.team/` はプロジェクトルート内のローカルディスクに作られる前提。NFS 上で daemon を動かすケースは考えにくい
- 完全対策としては hard link trick（tmpfile → link → stat の link count）があるが、リスクに対して過剰。現状は **local disk 前提で割り切る**と明記

### 5.3 CI での並列テスト

- `pidfile.test.ts` 自体は `mkdtemp` で独立 tmp dir を使うため、並列実行で衝突しない
- `process.pid` を使う test は問題ないが、**DI した `isAliveImpl` / `psCommand` で決定論化**する
- 実 PID の衝突を避けるため、`isAlive(4194303)` の行は OS 依存。`/proc/sys/kernel/pid_max` が大きい Linux では存在する可能性があるが、現実的には極低確率

### 5.4 `cmux-team.js` ラッパー側の exit 42 ループとの二重管理

- `cmux-team.js` と `main.ts:onReload` は **両方に auto-restart ループ**がある。通常はどちらか一方しか発火しない（`cmux-team.js` は start 時、`onReload` は dashboard reload 時）
- どちらのループでも「親は exit 42 を返さない（cmux-team.js）／exit(0) で抜ける（onReload）」ため、pidfile 所有権は必ず子 → 親の順に戻る。干渉はしない想定

### 5.5 SIGKILL / crash で pidfile が残るケース

- 仕様書の通り許容する。次回起動時の stale チェック（`isAlive` false → unlink → 再作成）で自動掃除される

### 5.6 `onReload` で release → exec 子 → 親復帰 の間に別プロセスが cmux-team start を叩く race

- 現実的には極小。仮に刺さっても child が `PidFileLockedError` で即死するだけで、親子とも壊れない
- 完全対策が必要なら「onReload は release せず、子に `--inherit-pidfile` 引数で親 PID を渡す」設計もあり得るが、複雑性が見合わない。**今回は素直に release→exec の順で割り切る**

---

## 完了条件（再掲チェックリスト）

- [ ] 同一 `.team/` に対して 2 回目の `cmux-team start` が fail-stop (exit 1) で止まる
- [ ] stale pidfile が次回起動時に自動掃除される
- [ ] 正常な SIGTERM / `cmdStop` / `onFullQuit` で pidfile が削除される
- [ ] auto-restart ループ（exit 42）で連続再起動が可能
- [ ] 既存の `main.test.ts` / `daemon.test.ts` を壊さない
- [ ] 新規 `pidfile.test.ts` で Step 1-8 のテストが pass
