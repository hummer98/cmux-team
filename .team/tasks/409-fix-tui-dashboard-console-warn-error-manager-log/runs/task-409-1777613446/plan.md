# T409 実装計画 — dashboard 起動時の console.warn / console.error → manager.log redirect

## 1. 概要

dashboard モード（`cmux-team start` で起動する Manager TUI）で外部ライブラリや依存コードが
出力する `console.warn` / `console.error` が stderr 経由で TUI 描画バッファを貫通し、
ペイン上に残骸を残す問題への対応。

**採用方針: C 案（dashboard 起動時に console を monkey-patch）**

| 変更ファイル | 変更内容 |
|---|---|
| `skills/cmux-team/manager/logger.ts` | `log()` を internal helper に切り出し、新規に `warn()` / `error()` を export |
| `skills/cmux-team/manager/dashboard.tsx` | `startDashboard()` の `createNodeApp` 呼び出し**直前**に console を monkey-patch する helper を呼ぶ |
| `skills/cmux-team/manager/dashboard-console-redirect.ts`（新規） | monkey-patch ロジックを切り出した小モジュール（テスト容易性のため） |
| `skills/cmux-team/manager/dashboard-console-redirect.test.ts`（新規） | redirect helper の単体テスト 3 ケース |

`cmdStatus`（`cmux-team status` の一発出力モード）と `cmdStart` 内の preflight / direnv チェック等の
TUI 起動前段階は console.* がそのまま stderr に出る挙動を維持する（regression 防止）。

---

## 2. logger.ts の差分内容

### Before（現状）

```ts
export async function log(event: string, detail: string = ""): Promise<void> {
  const envRoot = process.env.PROJECT_ROOT;
  if (!envRoot && process.env.CMUX_TEAM_LOGGER_STRICT === "1") {
    throw new Error("logger: PROJECT_ROOT is not set ...");
  }
  const projectRoot = envRoot || process.cwd();
  const logDir = join(projectRoot, ".team/logs");
  const logFile = join(logDir, "manager.log");
  await mkdir(logDir, { recursive: true });
  const timestamp = localISOString();
  const line = `[${timestamp}] ${event} ${detail}`.trimEnd() + "\n";
  await appendFile(logFile, line);
}
```

### After（変更後）

`appendLine(level, event, detail)` を internal helper として切り出し、`log` / `warn` / `error` から呼ぶ。

```ts
type LogLevel = "info" | "warn" | "error";

async function appendLine(level: LogLevel, event: string, detail: string): Promise<void> {
  const envRoot = process.env.PROJECT_ROOT;
  if (!envRoot && process.env.CMUX_TEAM_LOGGER_STRICT === "1") {
    throw new Error(
      "logger: PROJECT_ROOT is not set but CMUX_TEAM_LOGGER_STRICT=1. " +
        "Wrap tests with createDummyProject() from test-project.ts, or pass setProjectRootEnv: true.",
    );
  }
  const projectRoot = envRoot || process.cwd();
  const logDir = join(projectRoot, ".team/logs");
  const logFile = join(logDir, "manager.log");
  await mkdir(logDir, { recursive: true });
  const timestamp = localISOString();
  // info の場合は prefix を挿入しない（既存ログの互換性維持）
  const levelPrefix = level === "info" ? "" : `[${level}] `;
  const line = `[${timestamp}] ${levelPrefix}${event} ${detail}`.trimEnd() + "\n";
  await appendFile(logFile, line);
}

export async function log(event: string, detail: string = ""): Promise<void> {
  return appendLine("info", event, detail);
}

export async function warn(event: string, detail: string = ""): Promise<void> {
  return appendLine("warn", event, detail);
}

export async function error(event: string, detail: string = ""): Promise<void> {
  return appendLine("error", event, detail);
}
```

### 行頭フォーマットの注意点

- 既存 `log()` 互換: `[2026-05-01T14:30:00+09:00] event_name detail...`（prefix なし）
- 新規 `warn()`: `[2026-05-01T14:30:00+09:00] [warn] event_name detail...`
- 新規 `error()`: `[2026-05-01T14:30:00+09:00] [error] event_name detail...`

`level === "info"` のときは prefix を挿入しないことで既存の `manager.log` 解析（`parseLogLine`
in dashboard.tsx:326 など）への破壊変更を避ける。`parseLogLine` は将来的に `[warn]` / `[error]`
を level として読むが、本タスクの scope 外（必要なら別タスク化）。

### CMUX_TEAM_LOGGER_STRICT の共有

`appendLine` 内で 1 箇所だけチェックされるため自動的に warn / error にも適用される。

### import 影響

`logger.ts` の export を増やすだけなので既存 import（`import { log } from "./logger"`）には影響なし。

---

## 3. dashboard.tsx の差分内容

### 3.1 新規モジュール `dashboard-console-redirect.ts`

monkey-patch ロジックを単体テスト可能にするため小モジュールに切り出す。

```ts
// skills/cmux-team/manager/dashboard-console-redirect.ts

import { warn as logWarn, error as logError } from "./logger";

/**
 * dashboard 起動時に呼ばれ、`console.warn` / `console.error` を
 * `.team/logs/manager.log` への append にすり替える。
 *
 * 目的: Rezi/Ink TUI 描画中に依存コードが console.warn/error すると、
 * その出力が stderr 経由で TUI バッファを貫通してペイン上に残骸が残る。
 * dashboard モード中は stderr に書かず manager.log に流す。
 *
 * すり替え解除は不要 — dashboard プロセスは exit 時に消えるため。
 * テストからは返り値の `restore()` を呼んで原状復帰できる。
 */
export function installDashboardConsoleRedirect(): { restore: () => void } {
  const origWarn = console.warn;
  const origError = console.error;

  console.warn = (...args: unknown[]) => {
    void logWarn("console_warn", formatArgs(args));
  };
  console.error = (...args: unknown[]) => {
    void logError("console_error", formatArgs(args));
  };

  return {
    restore: () => {
      console.warn = origWarn;
      console.error = origError;
    },
  };
}

function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (a instanceof Error) return `${a.message}${a.stack ? "\n" + a.stack : ""}`;
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}
```

**設計メモ:**
- `void logWarn(...)`: console.warn / error は同期 API を期待するため、await せず fire-and-forget。
  失敗時は logger 内で throw されるが、すり替え後の原 console には fall through しない（catch しない）。
  これは「ログ書き込み失敗 = manager 全体の問題」とみなす方針（既存の `log()` 呼び出しでも同様の扱い）。
- `event` 名は `console_warn` / `console_error` で固定。詳細は detail 側に流す。
- 依存コードが `console.warn(new Error(...))` 形式で渡してくるケースに対応するため `formatArgs` で stack を保持。

### 3.2 dashboard.tsx の patch 位置

`startDashboard()`（dashboard.tsx:1448）の `createNodeApp` 呼び出し直前（**1463 行目の直前**）に
1 行追加するのが安全。`process.env.REZI_TERMINAL_SUPPORTS_OSC8 = "1"` の直後（1461 行目の直後）が
セマンティックに「TUI セットアップの一部」として揃う。

```diff
   // OSC 8 ハイパーリンクを有効化（ターミナル自動検出に依存せず明示的に設定）
   process.env.REZI_TERMINAL_SUPPORTS_OSC8 = "1";

+  // T409: console.warn / error を manager.log にリダイレクト。
+  // 依存ライブラリが stderr に書き込んで TUI 描画バッファを貫通する残骸を防ぐ。
+  // すり替え解除は不要（dashboard プロセスは exit 時に消える）。
+  installDashboardConsoleRedirect();
+
   const app = createNodeApp<AppState>({
```

### 3.3 import 追加（dashboard.tsx 冒頭）

```diff
   import { log } from "./logger";
+  import { installDashboardConsoleRedirect } from "./dashboard-console-redirect";
```

### 3.4 既存の `console.error` 呼び出し（dashboard.tsx:2424-2425）の扱い

```ts
console.error(t("dashboard_startup_failed", { message: e.message }));
console.error(t("dashboard_startup_hint"));
```

これらは `installDashboardConsoleRedirect()` 後・`app.start()` 失敗時の経路で、
すり替え後 console を呼ぶことになる → **正しく manager.log に流れる**。
TUI 起動失敗時にユーザーが stderr で気づけなくなる懸念はあるが、`cleanup()` 後の path のため
TUI バッファは既に解放済 → **必要なら `console.error` ではなく原 stderr に直接書くか、
restore() してから書く** 修正を検討する。本計画では **原状維持（manager.log に流す）** とし、
exit code を別経路で表現することで対応する。

> 補足: ユーザー体験として stderr に出ないと致命的になる場合は、
> `installDashboardConsoleRedirect()` の戻り値を保持して startup 失敗時に `restore()` を呼ぶ
> 1 行追加で吸収可能。実装段階で判断。

---

## 4. テスト戦略

### 4.1 テストファイル

新規: `skills/cmux-team/manager/dashboard-console-redirect.test.ts`

`startDashboard` 全体は Rezi の TTY を要求し test 環境で起動が難しい。本 PR では
**redirect helper 単体に対するテスト** で十分にカバレッジを取る方針を採用。

### 4.2 共通セットアップ

```ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFile } from "fs/promises";
import { join } from "path";
import { createDummyProject, type DummyProject } from "./test-project";
import { installDashboardConsoleRedirect } from "./dashboard-console-redirect";

let project: DummyProject;
let restore: () => void = () => {};
let stderrChunks: string[];
let origStderrWrite: typeof process.stderr.write;

beforeEach(async () => {
  project = await createDummyProject({ prefix: "cmux-console-redirect-" });
  // process.env.PROJECT_ROOT は createDummyProject が自動セット

  // stderr capture
  stderrChunks = [];
  origStderrWrite = process.stderr.write.bind(process.stderr);
  // @ts-ignore - 簡略化のため緩い型で受ける
  process.stderr.write = (chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8"));
    return true;
  };
});

afterEach(async () => {
  restore();
  process.stderr.write = origStderrWrite;
  await project.dispose();
});

async function readManagerLog(): Promise<string> {
  try {
    return await readFile(join(project.root, ".team/logs/manager.log"), "utf-8");
  } catch {
    return "";
  }
}

// fire-and-forget な void logWarn(...) が完了するのを待つ helper
async function flushAsyncLog(): Promise<void> {
  // append は microtask + await mkdir / appendFile なので 1 tick では足りない
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setImmediate(r));
  }
}
```

### 4.3 テストケース

#### Case 1: `console.warn` で manager.log に `[warn]` 行が追記される

```ts
test("console.warn 後 manager.log に [warn] 行が追記される", async () => {
  ({ restore } = installDashboardConsoleRedirect());

  console.warn("test warning message");
  await flushAsyncLog();

  const content = await readManagerLog();
  expect(content).toMatch(/\[warn\] console_warn test warning message/);
});
```

#### Case 2: redirect 状態で stderr が空である（残骸防止の主要テスト）

```ts
test("redirect 中は stderr に何も書き出されない", async () => {
  ({ restore } = installDashboardConsoleRedirect());

  console.warn("warn 残骸");
  console.error("error 残骸");
  await flushAsyncLog();

  // すり替え時は console.warn/error が直接 stderr.write を呼ばないため空
  expect(stderrChunks.join("")).toBe("");
});
```

#### Case 3: restore 後（CLI 一発呼び出しモード相当）は console.warn が stderr に出る

```ts
test("restore 後は console.warn が stderr に流れる（regression）", async () => {
  const { restore: doRestore } = installDashboardConsoleRedirect();
  doRestore();
  // 以後 restore() は no-op で良い（afterEach で 2 回呼ばれても OK）

  console.warn("after restore");

  expect(stderrChunks.join("")).toContain("after restore");
});
```

### 4.4 logger.ts の warn / error テスト追記

`skills/cmux-team/manager/logger.test.ts` に追記:

```ts
describe("logger - warn / error level", () => {
  test("warn() は [warn] prefix 付きで manager.log に append する", async () => {
    process.env.PROJECT_ROOT = tmpdirA;
    const { warn } = await import("./logger");
    const event = `${SENTINEL}_warn1`;
    await warn(event, "from=warn-test");

    const content = await readFile(join(tmpdirA, ".team/logs/manager.log"), "utf-8");
    expect(content).toContain(`[warn] ${event}`);
    expect(content).toContain("from=warn-test");
  });

  test("error() は [error] prefix 付きで manager.log に append する", async () => {
    process.env.PROJECT_ROOT = tmpdirA;
    const { error } = await import("./logger");
    const event = `${SENTINEL}_error1`;
    await error(event, "from=error-test");

    const content = await readFile(join(tmpdirA, ".team/logs/manager.log"), "utf-8");
    expect(content).toContain(`[error] ${event}`);
  });

  test("log() は従来通り prefix なしで append する（互換）", async () => {
    process.env.PROJECT_ROOT = tmpdirA;
    const event = `${SENTINEL}_info_compat`;
    await log(event, "from=info-compat");

    const content = await readFile(join(tmpdirA, ".team/logs/manager.log"), "utf-8");
    // prefix なし行であること（[warn] / [error] が event と timestamp の間に居ない）
    expect(content).toMatch(new RegExp(`\\] ${event} from=info-compat`));
    expect(content).not.toMatch(new RegExp(`\\] \\[warn\\] ${event}`));
    expect(content).not.toMatch(new RegExp(`\\] \\[error\\] ${event}`));
  });
});
```

### 4.5 テスト実行コマンド

```bash
cd skills/cmux-team/manager
bun test --timeout 30000 dashboard-console-redirect.test.ts
bun test --timeout 30000 logger.test.ts
```

CLAUDE.md の制約により全体 `bun test` 実行は禁忌。**個別ファイル指定** で実行する。

---

## 5. 受け入れ条件チェックリスト

実装完了時に以下が全て満たされていること:

- [ ] `skills/cmux-team/manager/logger.ts` に `warn(event, detail)` / `error(event, detail)` が export されている
- [ ] `log()` / `warn()` / `error()` の append 経路が共通 helper に集約されている（重複 mkdir/appendFile なし）
- [ ] `warn()` の出力行が `[<timestamp>] [warn] <event> <detail>` 形式
- [ ] `error()` の出力行が `[<timestamp>] [error] <event> <detail>` 形式
- [ ] `log()` の出力行は **既存形式と完全互換**（prefix なし）
- [ ] `CMUX_TEAM_LOGGER_STRICT=1` のチェックが warn / error にも適用される
- [ ] `skills/cmux-team/manager/dashboard-console-redirect.ts` が新規作成されている
- [ ] `installDashboardConsoleRedirect()` が `{ restore: () => void }` を返す
- [ ] `dashboard.tsx` の `startDashboard()` 内、`createNodeApp` 呼び出し直前で
      `installDashboardConsoleRedirect()` が呼ばれている
- [ ] dashboard.tsx 冒頭に `installDashboardConsoleRedirect` の import が追加されている
- [ ] redirect 中: `console.warn(...)` / `console.error(...)` が stderr に書かれず manager.log に流れる
- [ ] redirect 中: `console.log(...)` の挙動は変更されない（patch 対象外）
- [ ] `cmux-team status`（`cmdStatus`）等の CLI 一発モードでは redirect が起動しない
      （= dashboard モード以外で `console.warn` が従来通り stderr に出る）
- [ ] 新規テストファイル `dashboard-console-redirect.test.ts` の 3 ケースが pass
- [ ] `logger.test.ts` の追加 3 ケースが pass
- [ ] `bun test --timeout 30000 dashboard-console-redirect.test.ts logger.test.ts` で他テストへの regression なし
- [ ] 既存の `log()` 呼び出し約 N 箇所（`grep -rn 'from \"./logger\"' skills/cmux-team/manager`）が全て従来通り動作

---

## 6. 想定リスク・補足

### 6.1 fire-and-forget な console.warn の順序保証

`console.warn = (...) => { void logWarn(...) }` は同期返却するが、実際の append は async。
複数連続呼び出しの順序は **logger 内 `appendFile` の sequencing に依存**。Bun の `appendFile`
は基本的に呼び出し順を保つが、並行 microtask が割り込む可能性はある。本タスクの目的（残骸防止）
には影響しないため許容する。

### 6.2 dashboard 起動失敗時 (line 2424) の console.error の挙動

すり替え後の console.error が呼ばれる → manager.log に流れる。stderr に出ないため、ユーザーが
TUI 起動失敗を直接画面で見られない可能性がある。実装時に動作確認し、必要なら `restore()` を
catch 内で先に呼んでから console.error する 1 行追加で対応する（簡単なフォールバック）。

### 6.3 parseLogLine（dashboard.tsx:326）への影響

dashboard 自身が manager.log を読み戻して journal タブに表示する経路（`parseLogLine`）が
新フォーマット `[warn] event` を `event` として誤認識する可能性。実装時に `parseLogLine` の
ロジックを確認し、必要なら `[warn]` / `[error]` を level として吸い上げる小修正を入れる
（既に `parseLogLine` は level を返す signature `{ time, event, detail, level }` を持つので
拡張余地あり）。本タスクの scope を超える場合は別タスクとして切り出す。

### 6.4 テストでの async flush の不確実性

`flushAsyncLog()` の `setImmediate` 5 回が flaky になる場合は、`installDashboardConsoleRedirect`
側で `Promise<void>` を内部 array に push して `await drainPending()` 的な hook を export する
案も検討。初版では setImmediate ループで進める。
