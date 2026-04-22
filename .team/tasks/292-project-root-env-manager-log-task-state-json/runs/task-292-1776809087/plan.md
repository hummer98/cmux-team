# T292 実装計画 — テスト隔離: ダミープロジェクト + PROJECT_ROOT env で manager.log / task-state.json 汚染を防ぐ

- taskRunId: `task-292-1776809087`
- Worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-292-1776809087`
- 対象: `skills/cmux-team/manager/`
- 作成日: 2026-04-22 JST
- 作成者: planner-1 (T292)

---

## 1. 現状調査サマリー

### 1.1 PROJECT_ROOT / cwd / `.team/` リテラル参照の洗い出し

#### 実装側（production code）

| file:line | 用途 | env 未設定時の挙動 | 分類 |
|---|---|---|---|
| `logger.ts:67` | `const projectRoot = process.env.PROJECT_ROOT \|\| process.cwd();` | **cwd() に `.team/logs/manager.log` を append** ← **汚染の主原因** | fallback |
| `template.ts:29` | `findTemplateDir()` で `projectRoot/skills/cmux-team/templates` を探索 | cwd() fallback（テンプレ探索のみ → 読み取り） | fallback (read-only) |
| `main.ts:89-103` | `findProjectRoot()` — env → `.team/` を祖先方向に探索 → cwd() | cwd() fallback。daemon 起動経路では `main.ts:125` で `process.env.PROJECT_ROOT = PROJECT_ROOT` を設定済み | fallback (entry point) |
| `main.ts:673` | `cwd: process.cwd()` — child_process spawn の cwd | そのまま cwd() — テストで影響小 | subprocess cwd |
| `main.ts:2007 / 2100 / 2155` | 追加の entry 関数で `process.env.PROJECT_ROOT = PROJECT_ROOT` を設定 | — | entry point |
| `main.ts:4408` | `filePath.startsWith("/") ? filePath : join(process.cwd(), filePath)` | CLI 引数の相対パス解釈のみ | cli arg |

- `task.ts` / `daemon.ts` / `conductor.ts` / `master.ts` / `rate-limit-persistence.ts` 等は `projectRoot: string` を **関数引数で受け取る**。直接 env を読む箇所はない。
- production で `log()` を呼び出すモジュールは 25 ファイル・**530 箇所**。全てが `logger.ts:67` の解決ロジックに依存するため、テスト中に `PROJECT_ROOT` が未設定だと一括で repo 汚染する。
- production daemon 本体は `cmdStart` 等の entry で必ず env を設定してからサブシステムを起動するため、`logger.ts` の cwd fallback は事実上「テスト実行時の落とし穴」として残っているだけ。

**結論**: 汚染の主経路は `logger.ts:67` の 1 点に集約される。ここを締めればほぼ全ての経路を封じられる。`template.ts:29` は read-only なので副作用なし。

#### テスト側

`grep "process.env.PROJECT_ROOT"` で 11 ファイルヒット（下記 1.2 で詳細）。うち `main.test.ts` は spawn する child に env を渡すだけで、テストプロセス自身の env は触らない（= 自身は汚染源にならない）。

### 1.2 既存テストファイル 33 本の現状分類

`grep -c` による自動分類を手検証した結果:

| # | カテゴリ | 件数 | ファイル | 汚染リスク |
|---|---|---|---|---|
| A | env mutation で PROJECT_ROOT を override している + mkdtemp も使う | 10 | conductor, daemon, envrc-prompt, eventBus.trace, logger, main-branch, master, proxy, queue, rate-limit-persistence | **低** — 既に安全側 |
| B1 | mkdtemp で tmpRoot を作るが PROJECT_ROOT を触らない（**かつ `.team/` リテラルを参照**） | 4 | task, trace-store, pidfile, preflight | **高** — logger.log 副作用で repo へ書き込み |
| B2 | mkdtemp で tmpRoot を作るが `.team/` リテラルを参照しない | 7 | agent-instructions, cmux, direnv-check, gh-cache-cli, gh-cache-store, gh-cache-sync, worktree-base | **中** — 呼び出した production コードが log() を叩くと汚染 |
| B3 | spawn env 方式（自プロセスの env は触らない） | 1 | main | **低** — 子プロセス経由のみ |
| C | mkdtemp も使わず `.team/` も触らない純粋 unit | 11 | classify-stop, eventBus, exec-error, gh-cache-auth, gh-cache-format, gh-cache-repo, git-sync, layout-restore, rate-limit-display, schema, statusline | **低** — log() を呼ばない前提 |

合計: 10 + 4 + 7 + 1 + 11 = **33** ✓

### 1.3 代表的汚染経路（再現例）

- **task.test.ts** `markTaskAborted (T290)` ブロック: tmpRoot で `saveTaskState/loadTaskState` を呼ぶが、`markTaskAborted` 内部で `await log("task_aborted", ...)`（`task.ts:514`）が発火。`logger.ts:67` は `process.env.PROJECT_ROOT` 未設定なので `process.cwd()` = worktree root の `.team/logs/manager.log` に append。
  - 実際 T290 マージ前にこの経路で 4454 行が混入した。
- **preflight.test.ts** / **pidfile.test.ts** も同様に、内部で `log()` を呼ぶ production 関数を叩く瞬間に汚染。
- **trace-store.test.ts** は `log()` を直接は呼ばないが、もし `trace-store.ts` 側に log() 追加が入ると汚染開始 → 予防的に helper 化が妥当。

### 1.4 既存 helper の有無

- `paths.ts` はパスユーティリティのみで tmp/project 関連は無し。
- 共通の test helper は現状**存在しない**。各テストが個別に `mkdtemp` + env mutation を手書きしている。

---

## 2. 設計方針

### 2.1 ヘルパー API (TypeScript, pseudo-code)

新規ファイル `skills/cmux-team/manager/test-project.ts`:

```typescript
import { mkdtemp, rm, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

/**
 * 事前生成するサブディレクトリ。必要なければ opts.subdirs で上書き可能。
 * daemon 系テストで頻出するものを既定値に含める。
 */
export const DEFAULT_SUBDIRS = [
  "logs",       // logger.ts が manager.log を書く
  "tasks",      // task.ts が readdir
  "task-state", // （file 化されているが親 dir は .team 直下）
  "conductors",
  "output",
  "queue",
  "prompts",
] as const;

export interface DummyProjectOptions {
  prefix?: string;                  // mkdtemp 用 (default: "cmux-team-test-")
  subdirs?: readonly string[];      // 事前 mkdir する .team/ 以下の相対パス
  setProjectRootEnv?: boolean;      // default true: process.env.PROJECT_ROOT を上書き
  seedTeamJson?: boolean;           // default false: 空 team.json を配置
}

export interface DummyProject {
  readonly root: string;            // tmp dir 絶対パス
  readonly teamDir: string;         // <root>/.team
  ensureSubdir(rel: string): Promise<string>;
  dispose(): Promise<void>;
}

export async function createDummyProject(
  opts: DummyProjectOptions = {},
): Promise<DummyProject>;

/** RAII 風 scope helper — fn の開始前に create, 終了時に必ず dispose */
export async function withDummyProject<T>(
  fn: (p: DummyProject) => Promise<T>,
  opts?: DummyProjectOptions,
): Promise<T>;
```

**実装スケッチ**:

```typescript
export async function createDummyProject(opts = {}) {
  const prefix = opts.prefix ?? "cmux-team-test-";
  const subdirs = opts.subdirs ?? DEFAULT_SUBDIRS;
  const setEnv = opts.setProjectRootEnv ?? true;

  const root = await mkdtemp(join(tmpdir(), prefix));
  const teamDir = join(root, ".team");
  await mkdir(teamDir, { recursive: true });
  for (const sub of subdirs) {
    await mkdir(join(teamDir, sub), { recursive: true });
  }
  if (opts.seedTeamJson) {
    await writeFile(join(teamDir, "team.json"), '{"phase":"init","masters":[],"conductors":[]}');
  }

  const savedEnv = process.env.PROJECT_ROOT;
  if (setEnv) process.env.PROJECT_ROOT = root;

  let disposed = false;
  return {
    root,
    teamDir,
    async ensureSubdir(rel: string) {
      const p = join(teamDir, rel);
      await mkdir(p, { recursive: true });
      return p;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      try {
        await rm(root, { recursive: true, force: true });
      } finally {
        if (setEnv) {
          if (savedEnv !== undefined) process.env.PROJECT_ROOT = savedEnv;
          else delete process.env.PROJECT_ROOT;
        }
      }
    },
  };
}
```

### 2.2 env override 方式 — `process.chdir` を使わない理由

- bun test はファイル単位で **別プロセスの worker** として並列実行される。`process.env` を書き換えても他 worker には影響しない。
- **同一プロセス内**（同一ファイル内）の test は順次実行される — `beforeEach` / `afterEach` で env を書き換える既存パターンは安全。
- `process.chdir(dir)` は **同一プロセス内の全 import コードに影響**。特に async I/O が走行中に chdir すると `cwd()` が race し、さらに bun の内部実装に依存して予測不能な挙動になる（テスト要件にも明記）。→ 採用しない。
- したがって `createDummyProject` は **env 上書き一択**。

### 2.3 teardown / dispose の確実性

- `dispose()` 内で `rm` が失敗しても env は必ず復元する（try/finally）。
- `rm(..., { force: true })` + `recursive: true` で open fd 等があっても失敗しない。
- `disposed` フラグで二重 dispose を no-op 化（テストの afterEach と withDummyProject の finally で両方呼ばれるケースに備える）。
- helper 自身に対する test（`test-project.test.ts`）で「dispose 後に env が復元される」「二重 dispose が安全」「rm 失敗時も env が復元される」を検証する。

### 2.4 実装側（logger.ts）の扱い

**採用: 段階的な 2 層防御**

- **Layer 1 (必須・Step C)**: 全 33 テストを helper 経由で `PROJECT_ROOT` を必ず設定させる。これだけで汚染は封じられる（`logger.ts:67` の cwd fallback が発火しない）。
- **Layer 2 (optional・Step B)**: logger.ts に **strict モード**を追加し、`CMUX_TEAM_LOGGER_STRICT=1` 環境変数が立っている状態で `PROJECT_ROOT` が未設定かつ `.team/` が cwd に無い場合に **throw**（もしくは NoOp でスキップ）。これを bun test の `preload` で常時 ON にすれば、将来 helper を使い忘れたテストが追加されても CI で気付ける。
  - Layer 2 は **Step C 完了後に導入**する。未完了状態で入れると既存テストが落ちる。
  - production daemon は `CMUX_TEAM_LOGGER_STRICT` を設定しないため影響なし（entry で env を設定する前の早期 log 呼び出しが無いことを併せて確認する。現状は `main.ts:125` が先頭近くで set するので大半の log() より前。未設定時の早期 log があれば strict の代わりに warn に倒す）。

production の cwd fallback 自体は後方互換のため残す（破壊的変更を避ける、作業範囲の境界 §5）。

---

## 3. 段階的実装ステップ（TDD 前提）

各ステップ終了時に `cd skills/cmux-team/manager && bun test` が pass することを保証する。

### Step A — ヘルパー実装 (+ ヘルパー自身のテスト)

1. **A-1 [test-first]** `skills/cmux-team/manager/test-project.test.ts` を書く
   - `createDummyProject()` が一意な tmp dir を返す
   - `.team/<DEFAULT_SUBDIRS>` が全て mkdir されている
   - `process.env.PROJECT_ROOT` が root に書き換わる
   - `dispose()` 後、root が削除される + env が元の値に復元される
   - 2 並行でインスタンスを作っても互いに干渉しない（root path が異なる、ただし env は後勝ち — 同一プロセス内並行は想定しない旨 docstring 明記）
   - `seedTeamJson: true` で `.team/team.json` が生成される
   - `withDummyProject(fn)` が例外を投げても dispose される（try/finally）
   - 二重 `dispose()` が no-op
2. **A-2** `test-project.ts` を実装（上記 pseudo-code 準拠）
3. **A-3** 他のテストは変更しない。
4. **確認**: `bun test` 全 pass（33 既存 + `test-project.test.ts`）。
5. **コミット単位**: Step A 全体で 1 commit。

**ロールバック**: 失敗したら `test-project.ts` / `test-project.test.ts` を削除するだけで完全に戻せる。

### Step C（先に実施）— 33 テスト migration をグループ分けで実行

Step B（logger strict）は **C 完了後** に入れる。C をグループ単位の commit に分けることで bisect しやすくする。

#### C-1: 既存 env mutation テストの helper 置換（10 本）

対象: conductor, daemon, envrc-prompt, eventBus.trace, logger, main-branch, master, proxy, queue, rate-limit-persistence

- 各ファイルの `beforeEach` / `afterEach` を以下のように書き換え:
  ```typescript
  // before:
  beforeEach(async () => {
    testDir = await mkdtemp(...);
    process.env.PROJECT_ROOT = testDir;
    await mkdir(join(testDir, ".team/..."), { recursive: true });
  });
  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    delete process.env.PROJECT_ROOT;
  });
  // after:
  let project: DummyProject;
  beforeEach(async () => {
    project = await createDummyProject({
      subdirs: [...], // そのファイルで必要なものだけ
      seedTeamJson: true, // daemon.test.ts のみ
    });
  });
  afterEach(async () => {
    await project.dispose();
  });
  ```
- テスト本体で `testDir` を参照していた箇所は `project.root` に置換。
- `logger.test.ts` の「PROJECT_ROOT 遅延評価」テスト（L112-151）は helper 経由では env 強制設定が邪魔なので、`setProjectRootEnv: false` で helper を使うか、従来パターンを残す。→ logger.test.ts は **一部 custom を保持**する旨コメントを書く。
- **コミット単位**: ファイル 1 本 = 1 commit（10 commit）。各 commit 後に `bun test` 実行。
- **ロールバック**: 失敗したファイルだけ `git revert`。

#### C-2: 未 override + `.team/` 参照ありのテスト migration（4 本）

対象: task, trace-store, pidfile, preflight

- これらは helper 導入で **初めて汚染が止まる**グループ。優先度が高い。
- 既存の `tmpRoot = await mkdtemp(...)` を `project = await createDummyProject(...)` に置き換え、`tmpRoot` 参照を `project.root` に。
- `process.env.PROJECT_ROOT` を明示的には設定していなかったため、helper 側が自動設定する（`setProjectRootEnv: true` 既定）。
- **コミット単位**: ファイル 1 本 = 1 commit（4 commit）。
- **検証ポイント**: 各 commit 後に `git status .team/` がクリーンであることを手動確認（Step D の自動化前の暫定手段）。

#### C-3: `.team/` リテラル無しの mkdtemp テスト（7 本）

対象: agent-instructions, cmux, direnv-check, gh-cache-cli, gh-cache-store, gh-cache-sync, worktree-base

- これらは `.team/` に直接触らないが、内部で production コードを呼ぶ過程で `log()` が発火し得る（特に gh-cache 系）。
- **予防的に helper 化**する。ただし `setProjectRootEnv: true` のみ使い、既存の mkdtemp ロジックはそのまま残す（構造変更を最小化）:
  ```typescript
  // 最小介入パターン:
  let project: DummyProject;
  beforeEach(async () => {
    project = await createDummyProject({ subdirs: ["logs"] });
    // 既存の mkdtemp(...) もそのまま維持
    testDir = await mkdtemp(...);
  });
  afterEach(async () => {
    await rm(testDir, { ... });
    await project.dispose();
  });
  ```
- もしくはテスト本体を `project.root` ベースに書き換える。ファイルごとに判断。
- **コミット単位**: ファイル 1 本 = 1 commit（7 commit）。

#### C-4: main.test.ts（1 本）

- 自プロセスの env は触らず、子プロセス spawn に `env: { ...process.env, PROJECT_ROOT: testDir }` を渡している。自プロセスに関しては helper 化不要だが、**子プロセスが書き込む先を tmp dir に閉じる** だけでなく、**親プロセス側で log() が叩かれない保証** は必要。
- 対応: 親テストの beforeEach で `createDummyProject({ setProjectRootEnv: true })` を入れ、親自身も tmpdir を向かせる（既存の `testDir` は子プロセス用、`project.root` は親の保険）。
- **コミット単位**: 1 commit。

#### C-5: 純粋 unit (11 本)

対象: classify-stop, eventBus, exec-error, gh-cache-auth, gh-cache-format, gh-cache-repo, git-sync, layout-restore, rate-limit-display, schema, statusline

- `.team/` を一切触らず、production コードの log() も呼ばない（schema 等）テスト群。
- **原則、変更不要**。ただし `log()` を間接的に叩く可能性を念のため確認:
  - `exec-error.test.ts` — `exec-error.ts` の関数を呼ぶ。内部で log() なし（確認済みで扱う想定、Step C-5 着手時に最終確認）。
  - 他も同様に確認。
- 間接呼び出しが判明した場合は C-3 相当の最小介入 helper 化を適用する。
- **コミット単位**: もし変更があれば 1 commit でまとめる。

#### C 全体の完了条件

- 全 33 テスト pass
- `git status skills/cmux-team/manager/` 内の変更は対象ファイル + `test-project.ts` + `test-project.test.ts` のみ
- 適宜 `.team/logs/manager.log` / `.team/task-state.json` / `.team/tasks/*` / `.team/conductors/*` / `.team/output/*` / `.team/queue/*` の git diff がクリーンであることを手動確認

### Step B — logger.ts strict モード（optional・C 完了後）

1. **B-1 [test-first]** `logger.test.ts` に:
   - `CMUX_TEAM_LOGGER_STRICT=1` かつ `PROJECT_ROOT` 未設定のとき `log()` が throw（or NoOp）することを検証するテストを追加
   - 逆に strict OFF (既定) では従来通り cwd fallback で動くことも確認（後方互換テスト）
2. **B-2** `logger.ts` の `log()` 先頭で strict チェックを実装:
   ```typescript
   const strict = process.env.CMUX_TEAM_LOGGER_STRICT === "1";
   const projectRoot = process.env.PROJECT_ROOT;
   if (!projectRoot) {
     if (strict) throw new Error("logger: PROJECT_ROOT unset under strict mode");
     // 後方互換: cwd fallback
     return fallbackToCwd(event, detail);
   }
   ```
3. **B-3** `skills/cmux-team/manager/package.json` の test script を:
   ```json
   "test": "CMUX_TEAM_LOGGER_STRICT=1 bun test"
   ```
   に更新する（helper を使っていない新規テストが将来追加された瞬間に赤になる）。
4. **確認**: 全テスト pass（strict 下でも helper が env を設定するので緑）。
5. **コミット単位**: Step B 全体で 1〜2 commit。
6. **ロールバック**: strict フラグを読まないよう revert。

### Step D — 汚染検出 CI ガード（optional）

- **D-1** `scripts/verify-test-no-pollution.sh`（or `.ts`）を追加:
  ```bash
  #!/usr/bin/env bash
  set -euo pipefail
  git_status_before=$(git status --porcelain .team/)
  cd skills/cmux-team/manager && bun test
  cd - >/dev/null
  git_status_after=$(git status --porcelain .team/)
  if [ "$git_status_before" != "$git_status_after" ]; then
    echo "ERROR: .team/ was polluted by tests"
    diff <(echo "$git_status_before") <(echo "$git_status_after") || true
    exit 1
  fi
  ```
- **D-2** `package.json` に `"test:clean": "bash scripts/verify-test-no-pollution.sh"` を追加（optional）。
- **D-3** GitHub Actions がある環境では CI workflow で `test:clean` を呼ぶ。
- **コミット単位**: 1 commit。
- 実装コストが軽ければ含める。重ければ見送る（タスク本文も「任意」扱い）。

---

## 4. 受け入れ条件チェックリスト

| # | 条件 | 検証方法 |
|---|---|---|
| 1 | `bun test` 実行後、`.team/logs/manager.log` に 1 bit の変更もない | `git diff .team/logs/manager.log` が空 |
| 2 | `.team/task-state.json` に変更が入らない | `git diff .team/task-state.json` が空 |
| 3 | `.team/tasks/` / `.team/conductors/` / `.team/output/` / `.team/queue/` に変更・untracked が無い | `git status .team/` が clean（対象ディレクトリ限定で確認） |
| 4 | `cd skills/cmux-team/manager && bun test` が全 pass | 33 既存 + `test-project.test.ts` 緑 |
| 5 | `tsc --noEmit` で新規エラー 0（pre-existing 3 件は許容） | `bunx tsc --noEmit` の件数が従来と変わらない |
| 6 | `test-project.ts` / `test-project.test.ts` が追加され、汚染経路のあるテストから参照される | `rg "createDummyProject\|withDummyProject" skills/cmux-team/manager/*.test.ts` で helper 使用箇所が確認できる |
| 7 | (Step B 実施時) `CMUX_TEAM_LOGGER_STRICT=1 bun test` が pass | package.json の test script で実行 |
| 8 | (Step D 実施時) `bash scripts/verify-test-no-pollution.sh` が pass | スクリプト実行 |

---

## 5. リスクと回避策

| リスク | 影響 | 回避策 |
|---|---|---|
| env 復元漏れ（dispose 前に throw） | 後続テストが前テストの env を引き継ぎ、意図しない tmpdir へ書き込む | `dispose()` を try/finally で囲み、rm 失敗でも env は必ず復元 |
| tmpdir rm 失敗（open fd 残り） | tmp dir リーク — テスト結果には影響なし | `{ recursive: true, force: true }` + `.catch(() => {})` で best-effort |
| bun parallel worker で env 衝突 | 実害なし（worker は別プロセス）だが設計上の懸念 | docstring に「同一プロセス内並行テストは未対応」と明記。必要なら `node:test` の context API 相当のラッパを将来検討 |
| Step C 中途段階で mixed state（helper 化済み vs 未済） | 汚染が部分的に残る | ファイル単位で commit 分割、bisect で犯人特定可能。最重要な C-2（task/trace-store/pidfile/preflight）を最初に片付ける |
| 既存の `process.env.PROJECT_ROOT = testDir` を手書きしたテストとの二重管理 | env が正しく復元されない可能性 | helper 化時に直書きパターンを完全削除する（grep で 0 件確認） |
| Step B 導入で未対応テストが赤化 | CI 破綻 | Step B は Step C 完了後にのみ実施。C 完了条件を機械的に確認する（`rg "process\.env\.PROJECT_ROOT" skills/cmux-team/manager/*.test.ts` で helper 経由だけになっていること） |
| logger strict モードが production の早期 log を殺す | daemon 起動失敗 | strict は env で opt-in、production は未設定 → 既定の cwd fallback 動作を維持。`main.ts:125` の env 設定が早期実行されることを確認 |
| `logger.test.ts` の「PROJECT_ROOT 遅延評価」テストが helper と競合 | 当該ファイルだけ特殊対応が必要 | helper の `setProjectRootEnv: false` オプションを使うか、当該 describe ブロックだけは直書きパターンを残す |
| trace-store の SQLite ファイル ハンドルが rm を阻害（Windows のみ） | CI で rm 失敗 | 本プロジェクトは macOS / Linux のみ想定。現時点では問題なし |

---

## 6. 作業範囲の境界

**やること**:

- `skills/cmux-team/manager/test-project.ts` 新規追加
- `skills/cmux-team/manager/test-project.test.ts` 新規追加
- 汚染経路のある `*.test.ts` を helper 経由に書き換え（最大 22 本、最小 4 本）
- (optional) `logger.ts` への strict モード追加 + `package.json` test script 更新
- (optional) `scripts/verify-test-no-pollution.sh`

**やらないこと**:

- production daemon の起動経路（`main.ts:findProjectRoot`, `cmdStart` 等）の破壊的変更
- `process.chdir` ベースの分離（bun parallel worker 下で非安全のため）
- `logger.ts` の cwd fallback の **削除**（後方互換性を壊す / daemon 起動経路に影響）
- `task.ts` / `daemon.ts` / `conductor.ts` 等 production コードの projectRoot 解決ロジック変更
- CI 設定（GitHub Actions 等）の大規模書き換え — Step D は軽量スクリプト追加のみ
- 既存の `paths.ts` への統合（import graph が広がるため、test 専用ファイルは独立させる）

**後続タスク候補（本タスクでは扱わない）**:

- helper を `skills/cmux-team/manager/test-helpers/` 以下にパッケージ化して他種 helper も束ねる
- Jest / vitest 互換の fixture API への抽象化
- trace-store / rate-limit-persistence のテスト用 in-memory モードの導入

---

## 付録 A. テストファイル移行チェックリスト

Step C の進捗を追跡するための checklist（plan では書くのみ、実装者が進捗を埋める）:

- [ ] C-1: conductor.test.ts
- [ ] C-1: daemon.test.ts
- [ ] C-1: envrc-prompt.test.ts
- [ ] C-1: eventBus.trace.test.ts
- [ ] C-1: logger.test.ts（一部直書き残しの可否を先に判断）
- [ ] C-1: main-branch.test.ts
- [ ] C-1: master.test.ts
- [ ] C-1: proxy.test.ts
- [ ] C-1: queue.test.ts
- [ ] C-1: rate-limit-persistence.test.ts
- [ ] C-2: task.test.ts ★優先（汚染再現経路）
- [ ] C-2: trace-store.test.ts
- [ ] C-2: pidfile.test.ts
- [ ] C-2: preflight.test.ts
- [ ] C-3: agent-instructions.test.ts
- [ ] C-3: cmux.test.ts
- [ ] C-3: direnv-check.test.ts
- [ ] C-3: gh-cache-cli.test.ts
- [ ] C-3: gh-cache-store.test.ts
- [ ] C-3: gh-cache-sync.test.ts
- [ ] C-3: worktree-base.test.ts
- [ ] C-4: main.test.ts
- [ ] C-5: 11 本の純粋 unit テスト（変更要否の最終確認のみ）

## 付録 B. `createDummyProject` のデフォルト subdirs 設計根拠

`DEFAULT_SUBDIRS` に含める基準:

1. `logger.ts` が書き込む `.team/logs/` — **必須**
2. `task.ts` が readdir する `.team/tasks/` — daemon/task テストで必須
3. `.team/task-state.json` は**ファイル**なので親ディレクトリの `.team/` が mkdir されていれば OK（明示的な subdir 不要）
4. `conductor` 系テストで参照される `.team/conductors/`, `.team/output/`, `.team/queue/`, `.team/prompts/` — 既存テストの beforeEach の mkdir パターンから抽出

含めないもの:
- `.team/artifacts/` — artifact.ts テストは個別の describe で作る方針
- `.team/agent-instructions/` — 同上
- `.team/sessions/`, `.team/specs/`, `.team/traces/`, `.team/masters/`, `.team/hook_signals/` — 使用頻度が低いため各テストで `ensureSubdir` 明示的に作らせる
- `.team/archive/` — team-archive コマンドでのみ使用

これにより「既定値で 9 割のテストが動き、特殊系は opts.subdirs 明示」という API になる。
