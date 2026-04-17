# T217 実装計画書 — cmux-team trace-hooks サブコマンド

## 1. 概要

T216 で導入済みの `hook_signals` テーブル（`skills/cmux-team/manager/trace-store.ts`）に格納された hook 受信履歴を、CLI から検索・一覧表示するためのサブコマンド `cmux-team trace-hooks` を実装する。Master / 開発者が daemon の受信した全 hook シグナル（SESSION_STARTED / SESSION_ENDED / AGENT_DONE / ASK_USER / CONDUCTOR_DONE 等）を事後に追跡できるようにし、event bus の経路デバッグと障害解析を支える。

## 2. 変更対象ファイル

| ファイル | 変更内容 |
|---------|---------|
| `skills/cmux-team/manager/trace-store.ts` | `HookSignalRecord` 型と `getHookSignals(db, opts)` 関数を追加 |
| `skills/cmux-team/manager/trace-store.test.ts` | `getHookSignals` の unit test を 5 ケース追加 |
| `skills/cmux-team/manager/main.ts` | `cmdTraceHooks` 関数追加、`import` 追記、switch に `case "trace-hooks"` 追加、ヘッダコメント Usage 更新 |
| `skills/cmux-team/manager/i18n.ts` | `help_trace_hooks` を en / ja に追加、各 `help_main` の一覧に 1 行追記 |

**変更しないファイル:** daemon.ts / schema.ts / conductor.ts / hook 受信ロジックには一切手を入れない。書き込み側（`insertHookSignal`）は T216 で完成済み。

## 3. 実装詳細

### 3.1 trace-store.ts

#### 型定義（export）

```ts
export interface HookSignalRecord {
  id: number;
  timestamp: string;
  type: string;
  surface: string | null;
  pid: number | null;
  reason: string | null;
  source: string | null;
  question: string | null;
  task_run_id: string | null;
  payload_json: string;
}
```

- スキーマ（trace-store.ts:40-51）と 1:1 対応。既存 `TaskSessionRecord` と同様、列名は snake_case のまま。
- `id` は必須（SELECT * で必ず返る）。

#### 検索関数

```ts
export function getHookSignals(
  db: Database,
  opts: {
    surface?: string;
    type?: string;
    taskRunId?: string;
    limit?: number;
  }
): HookSignalRecord[];
```

**動作仕様:**

1. WHERE 条件を動的構築する（既存 `getTaskSessions` と同じパターン、trace-store.ts:97-126）。
   - `opts.type` 指定時: `type = $type`
   - `opts.surface` 指定時: `surface = $surface`（※呼び出し側で `surface:NNN` 形式に正規化済みであることを前提。関数内では正規化しない）
   - `opts.taskRunId` 指定時: `task_run_id = $taskRunId`
2. `ORDER BY id DESC`（新しい順）。
3. `LIMIT $limit`（デフォルト 50、明示指定があればそれを使う）。LIMIT は既存 `getTaskSessions` 同様インライン（プレースホルダではなく文字列結合）で OK。負値や非数値のチェックは main.ts 側で行う。
4. `stmt.all(params) as HookSignalRecord[]` で返す。

**テーブルがない場合の扱い:** `initDB` が必ず SCHEMA を実行するため、空配列を返す（エラーにしない）。

### 3.2 main.ts

#### import の追加

```ts
import {
  initDB,
  insertTaskSession,
  getSessionsForTask,
  getTaskSessions,
  getHookSignals,            // ← 追加
  type HookSignalRecord,     // ← 追加
} from "./trace-store";
```

※ 既存 import 形式（`main.ts:40`）を維持し、`import { ..., getHookSignals }` を追加する。`HookSignalRecord` は型のみ使うので `type` 付きで inline import。

#### 関数 `cmdTraceHooks`

場所: `cmdTraceTask` の直後（main.ts:3153 付近）に追加する。

```ts
async function cmdTraceHooks(): Promise<void> {
  if (hasHelpFlag()) showHelp(t("help_trace_hooks"));

  // --- オプション解析 ---
  const typeFilter = getArg("type");
  const taskRunFilter = getArg("task-run");
  const surfaceRaw = getArg("surface");
  const limitRaw = getArg("limit");
  const asJson = hasFlag("json");

  // limit は数値化、不正値はエラー
  let limit = 50;
  if (limitRaw !== undefined) {
    const n = Number(limitRaw);
    if (!Number.isFinite(n) || n <= 0) {
      console.error(`Error: --limit must be a positive number (got: ${limitRaw})`);
      process.exit(1);
    }
    limit = Math.floor(n);
  }

  // surface の正規化（"C[665]" / "665" / "surface:665" すべて受理）
  let surfaceFilter: string | undefined;
  if (surfaceRaw !== undefined) {
    surfaceFilter = normalizeSurfaceArgForHooks(surfaceRaw);
  }

  // --- DB アクセス ---
  const db = initDB(PROJECT_ROOT);
  const rows = getHookSignals(db, {
    type: typeFilter,
    surface: surfaceFilter,
    taskRunId: taskRunFilter,
    limit,
  });
  db.close();

  // --- JSON 出力 ---
  if (asJson) {
    // payload_json は文字列のまま残す（重いので decode しない）
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  // --- Tabular 出力 ---
  if (rows.length === 0) {
    console.log("No hook signals found.");
    return;
  }

  console.log("TIMESTAMP                      TYPE              SURFACE          PID       DETAIL");
  for (const r of rows) {
    const ts = (r.timestamp ?? "").padEnd(30).slice(0, 30);
    const type = (r.type ?? "").padEnd(17).slice(0, 17);
    const surface = formatSurfaceForHooks(r.surface).padEnd(16).slice(0, 16);
    const pid = (r.pid !== null ? String(r.pid) : "-").padEnd(9).slice(0, 9);
    const detail = buildHookDetail(r);
    console.log(`${ts} ${type} ${surface} ${pid} ${detail}`);
  }
}
```

#### surface 正規化ヘルパ（cmdTraceHooks 直前に配置）

```ts
/**
 * trace-hooks --surface 引数の正規化。
 * "surface:665" / "665" / "C[665]" / "A[719]" / "M[12]" など受理。
 * 数字 1 個以上が含まれていれば `surface:<数字>` に正規化し、
 * 取り出せない場合は原文を返して DB ミスマッチで 0 件になる。
 * （main.ts 既存の normalizeSurfaceArg は UUID→surface:NNN の cmux 逆引きを伴うため
 *  ここでは別名の軽量ヘルパとする）
 */
function normalizeSurfaceArgForHooks(raw: string): string {
  if (raw.startsWith("surface:")) return raw;
  const m = raw.match(/^[CAMUS]?\[?(\d+)\]?$/);
  if (m) return `surface:${m[1]}`;
  return raw;
}
```

#### 表示用ヘルパ

```ts
/** 表示用: DB 上の "surface:665" を "C[665]" 形式に寄せる（type から role を推定）。 */
function formatSurfaceForHooks(surface: string | null): string {
  if (!surface) return "-";
  const id = surface.startsWith("surface:") ? surface.slice(8) : surface;
  // ロール判定は他テーブル JOIN せず "S[...]" で十分（表示簡易化）
  // ※ 将来 type からロール推定が欲しくなったら別関数で対応
  return `S[${id}]`;
}

/** DETAIL カラムを組み立てる: 値のある reason/source/question/task_run_id を key=value で連結 */
function buildHookDetail(r: HookSignalRecord): string {
  const parts: string[] = [];
  if (r.source) parts.push(`source=${r.source}`);
  if (r.reason) parts.push(`reason=${r.reason}`);
  if (r.task_run_id) parts.push(`task_run=${r.task_run_id}`);
  if (r.question) {
    const q = r.question.length > 60 ? r.question.slice(0, 57) + "..." : r.question;
    parts.push(`question="${q}"`);
  }
  return parts.join(" ") || "-";
}
```

**surface ロール判定について:** `formatSurface(surface, role)` は role を引数に要求するが、`hook_signals` には role 列がない。JOIN で同時刻の `task_sessions.role` を引くことも可能だが、コスト対効果が低い。本計画では **表示上は `S[NNN]`（role 不明）で統一** する。より詳しい情報が必要な場合は `--json` で payload_json を読み取る運用とする。将来 role を記録したくなった場合は別タスクで schema にカラムを追加すればよい。

#### switch への追加

場所: main.ts:3488（`case "trace-task"` の直後）

```ts
  case "trace-task":
    await cmdTraceTask();
    break;
  case "trace-hooks":                      // ← 追加
    await cmdTraceHooks();                 // ← 追加
    break;                                 // ← 追加
  case "conductor":
    await cmdConductor();
    break;
```

#### ヘッダコメント Usage の追記

`main.ts:4-23` の JSDoc Usage 一覧に 1 行追加:

```
 *   ./main.ts trace-hooks [--type <T>] [--surface <s>] [--task-run <id>] [--limit <N>] [--json]
```

### 3.3 i18n.ts

#### en セクション（i18n.ts:410 の `help_trace_task` の直後）

```ts
  help_trace_hooks: `
cmux-team trace-hooks -- display hook signal history received by the daemon

Usage:
  cmux-team trace-hooks [options]

Options:
  --type <TYPE>          filter by hook type (e.g. SESSION_STARTED, SESSION_ENDED,
                         SESSION_IDLE, SESSION_CLEAR, AGENT_STARTED, AGENT_DONE,
                         ASK_USER, CONDUCTOR_DONE)
  --surface <surface>    filter by surface (accepts "surface:665", "665", "C[665]")
  --task-run <id>        filter by task_run_id (e.g. "task-217-1776294106")
  --limit <N>            max rows to display (default: 50, newest first)
  --json                 emit JSON array instead of tabular output

Examples:
  cmux-team trace-hooks
  cmux-team trace-hooks --type SESSION_ENDED --limit 20
  cmux-team trace-hooks --surface C[665]
  cmux-team trace-hooks --task-run task-217-1776294106 --json

Notes:
  - Reads from .team/traces/traces.db (hook_signals table)
  - Rows are ordered by id DESC (newest first)
  - DETAIL column shows non-null reason/source/question/task_run_id
  - question is truncated to 60 chars; use --json to see full payload
`,
```

#### en `help_main`（i18n.ts:534 直後）に 1 行追加:

```
  cmux-team trace-task <task-id>              display session history for a task
  cmux-team trace-hooks                        display hook signal history    ← 追加
  cmux-team conductor                          launch Conductor (auto-resolves proxy)
```

#### ja セクション（i18n.ts:942 の `help_trace_task` の直後）

```ts
  help_trace_hooks: `
cmux-team trace-hooks -- daemon が受信した hook シグナル履歴を表示

Usage:
  cmux-team trace-hooks [options]

Options:
  --type <TYPE>          hook type で絞り込み（SESSION_STARTED / SESSION_ENDED /
                         SESSION_IDLE / SESSION_CLEAR / AGENT_STARTED / AGENT_DONE /
                         ASK_USER / CONDUCTOR_DONE など）
  --surface <surface>    surface で絞り込み（"surface:665" / "665" / "C[665]" 受理）
  --task-run <id>        task_run_id で絞り込み（例: "task-217-1776294106"）
  --limit <N>            最大表示件数（デフォルト: 50、新しい順）
  --json                 tabular の代わりに JSON 配列を出力

Examples:
  cmux-team trace-hooks
  cmux-team trace-hooks --type SESSION_ENDED --limit 20
  cmux-team trace-hooks --surface C[665]
  cmux-team trace-hooks --task-run task-217-1776294106 --json

Notes:
  - .team/traces/traces.db の hook_signals テーブルから読み込みます
  - id DESC（新しい順）で並びます
  - DETAIL カラムには reason/source/question/task_run_id のうち値があるものだけ表示
  - question は 60 文字で truncate されます。完全なデータは --json を使用
`,
```

#### ja `help_main`（i18n.ts:1054 直後）に 1 行追加:

```
  cmux-team trace-task <task-id>              タスクのセッション履歴を表示
  cmux-team trace-hooks                        hook シグナル履歴を表示    ← 追加
  cmux-team conductor                          Conductor 起動（proxy 自動解決）
```

## 4. TDD 手順

### Step 1 — Red: getHookSignals のテストを追加

`skills/cmux-team/manager/trace-store.test.ts` に新規 describe ブロックを追加する:

```ts
import { initDB, insertHookSignal, getHookSignals } from "./trace-store";

describe("trace-store: getHookSignals (T217)", () => {
  let tmpDir: string;
  let db: Database;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "cmux-team-getHookSignals-test-"));
    db = initDB(tmpDir);

    // fixture: 4 件挿入（type / surface / task_run_id を散らす）
    insertHookSignal(db, { type: "SESSION_STARTED", surface: "surface:100", pid: 1, source: "startup", timestamp: "2026-04-16T10:00:00.000Z" });
    insertHookSignal(db, { type: "SESSION_ENDED",   surface: "surface:100", pid: 1, reason: "completed", timestamp: "2026-04-16T10:01:00.000Z" });
    insertHookSignal(db, { type: "SESSION_STARTED", surface: "surface:200", pid: 2, source: "conductor", taskRunId: "task-217-xxx", timestamp: "2026-04-16T10:02:00.000Z" });
    insertHookSignal(db, { type: "AGENT_DONE",      surface: "surface:300", pid: 3, reason: "completed", timestamp: "2026-04-16T10:03:00.000Z" });
  });

  afterEach(async () => {
    try { db.close(); } catch {}
    await rm(tmpDir, { recursive: true, force: true });
  });

  test("全件取得（オプション無し） — id DESC で最大 50 件", () => {
    const rows = getHookSignals(db, {});
    expect(rows.length).toBe(4);
    // 新しい順
    expect(rows[0].type).toBe("AGENT_DONE");
    expect(rows[3].type).toBe("SESSION_STARTED");
    expect(rows[3].surface).toBe("surface:100");
  });

  test("type フィルタ", () => {
    const rows = getHookSignals(db, { type: "SESSION_STARTED" });
    expect(rows.length).toBe(2);
    expect(rows.every(r => r.type === "SESSION_STARTED")).toBe(true);
  });

  test("surface フィルタ", () => {
    const rows = getHookSignals(db, { surface: "surface:100" });
    expect(rows.length).toBe(2);
    expect(rows.every(r => r.surface === "surface:100")).toBe(true);
  });

  test("task_run_id フィルタ", () => {
    const rows = getHookSignals(db, { taskRunId: "task-217-xxx" });
    expect(rows.length).toBe(1);
    expect(rows[0].type).toBe("SESSION_STARTED");
    expect(rows[0].surface).toBe("surface:200");
  });

  test("limit + ORDER BY id DESC", () => {
    const rows = getHookSignals(db, { limit: 2 });
    expect(rows.length).toBe(2);
    expect(rows[0].type).toBe("AGENT_DONE");      // 最新
    expect(rows[1].type).toBe("SESSION_STARTED"); // 2番目に新しい（surface:200）
    expect(rows[1].surface).toBe("surface:200");
  });
});
```

この状態で `bun test skills/cmux-team/manager/trace-store.test.ts` を実行 → `getHookSignals is not a function` で **Red**。

### Step 2 — Green: getHookSignals を実装

`trace-store.ts` に上記 3.1 の型と関数を追加 → test 通過を確認。

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-217-1776294106
bun test skills/cmux-team/manager/trace-store.test.ts
```

### Step 3 — Green: CLI サブコマンドを実装

1. `i18n.ts` に `help_trace_hooks` を en / ja で追加、`help_main` に 1 行追記
2. `main.ts` に import 追加、`cmdTraceHooks` と 2 つのヘルパ関数を追加、switch に case 追加、JSDoc Usage 更新
3. 既存の main.test.ts / 型チェックを通す:

```bash
bun test skills/cmux-team/manager/main.test.ts
bunx tsc --noEmit -p skills/cmux-team/manager/tsconfig.json 2>/dev/null || bunx tsc --noEmit
```

### Step 4 — 手動 E2E 確認

```bash
# 1) ヘルプ
bun skills/cmux-team/manager/main.ts trace-hooks --help
bun skills/cmux-team/manager/main.ts --help | rg trace-hooks

# 2) 実プロジェクトで実行（.team/traces/traces.db が存在する前提）
bun skills/cmux-team/manager/main.ts trace-hooks --limit 5
bun skills/cmux-team/manager/main.ts trace-hooks --type SESSION_ENDED
bun skills/cmux-team/manager/main.ts trace-hooks --surface C[665]  # エスケープ要: 'C[665]'
bun skills/cmux-team/manager/main.ts trace-hooks --json --limit 1 | bunx jq .
```

### Step 5 — Refactor

- 出力カラム幅を定数に括り出すかは判断で任せる。初版ではインラインで可
- 重複するまで抽出しない（YAGNI）

## 5. 受け入れ基準

以下が全て成立すれば完了:

1. **unit test** — `bun test skills/cmux-team/manager/trace-store.test.ts` が T216 既存 3 ケース + T217 新規 5 ケース、計 8 ケース通る
2. **型チェック** — `bunx tsc --noEmit` がエラー 0 件
3. **ヘルプ表示** — `cmux-team trace-hooks --help` で en/ja ロケール別 help_trace_hooks が出る
4. **help_main** — `cmux-team --help` 出力の中段に `cmux-team trace-hooks` 行が 1 行追加されている
5. **CLI 実行例（デフォルト）:**

   ```
   $ cmux-team trace-hooks --limit 3
   TIMESTAMP                      TYPE              SURFACE          PID       DETAIL
   2026-04-16T10:03:00.000Z       AGENT_DONE        S[300]           3         reason=completed
   2026-04-16T10:02:00.000Z       SESSION_STARTED   S[200]           2         source=conductor task_run=task-217-xxx
   2026-04-16T10:01:00.000Z       SESSION_ENDED     S[100]           1         reason=completed
   ```

6. **CLI 実行例（type フィルタ）:**

   ```
   $ cmux-team trace-hooks --type SESSION_STARTED
   TIMESTAMP                      TYPE              SURFACE          PID       DETAIL
   2026-04-16T10:02:00.000Z       SESSION_STARTED   S[200]           2         source=conductor task_run=task-217-xxx
   2026-04-16T10:00:00.000Z       SESSION_STARTED   S[100]           1         source=startup
   ```

7. **CLI 実行例（--json）:**

   ```
   $ cmux-team trace-hooks --json --limit 1
   [
     {
       "id": 4,
       "timestamp": "2026-04-16T10:03:00.000Z",
       "type": "AGENT_DONE",
       "surface": "surface:300",
       "pid": 3,
       "reason": "completed",
       "source": null,
       "question": null,
       "task_run_id": null,
       "payload_json": "{...}"
     }
   ]
   ```

8. **surface 正規化** — `--surface 665`, `--surface surface:665`, `--surface C[665]` がいずれも同一行を返す
9. **0 件時** — `No hook signals found.` が出る（非 JSON モード）。JSON モードでは `[]` を出力
10. **不正 --limit** — `--limit abc` や `--limit 0` は `Error: --limit must be a positive number` で exit 1

## 6. リスク・懸念

| 懸念 | 内容 | 緩和策 |
|------|------|--------|
| **SQL インジェクション** | LIMIT をインライン文字列結合にしている | main.ts 側で `Number(limitRaw)` → `Math.floor` で数値化し、非数値・非正数はエラー終了。`getHookSignals` はさらに内部で `Number()` の結果を使わず `opts.limit ?? 50` を直接埋めるため、main.ts の検証を信頼する（既存 `getTaskSessions` と同等の扱い） |
| **DB スキーマ未作成** | `initDB` は常に `CREATE TABLE IF NOT EXISTS` を実行するため、hook_signals テーブル未作成のまま `SELECT` になるケースはない。空 DB なら空配列を返す | 追加対応不要 |
| **surface 表示が "S[...]" のみ** | role 不明のため Conductor / Agent の区別が付かない | 本タスクでは対応しない。必要なら別タスクで hook_signals に role 列を追加する、もしくは task_sessions と JOIN する。plan には **意図的に "S[...]" 統一と明記**  |
| **question カラムの大量出力** | hook で送られた質問本文が長い場合にターミナルが崩れる | 60 文字で truncate + `...` suffix。完全版が必要なときは `--json` で payload_json を展開する運用 |
| **既存 `normalizeSurfaceArg` との重複** | main.ts:206- に cmux 逆引き付き normalizeSurfaceArg があるが、trace-hooks は DB 検索だけで UUID 逆引きが不要なため別名の軽量ヘルパ（`normalizeSurfaceArgForHooks`）を定義する | 重複は 10 行程度で許容。`normalizeSurfaceArg` に合流させると UUID→tree 呼び出しで DB 検索が遅くなるため分離する |
| **大量レコード** | hook_signals は GC なしで膨張する（CLAUDE.md "hook_signals GC" セクション参照）。全件取得はコストが大きい | `LIMIT 50` デフォルト + ORDER BY id DESC で新しい順に絞る。ユーザーが `--limit 100000` を渡した場合は自己責任 |
| **i18n 記述漏れ** | `t("help_trace_hooks")` 呼び出しで en / ja どちらかの定義が漏れるとランタイムで fallback する | TDD で en/ja の両方を同時編集し、`cmux-team trace-hooks --help` を CMUX_TEAM_LOCALE 切替で 2 回叩く |
| **E2E 不要の判断** | 起動中 daemon への接続を伴わない読み取り専用コマンドなので E2E は不要。`trace-task` と同等の扱い（`main.test.ts` にテストはない） | 変更不要。既存方針に準拠 |

## 7. Implementer 向け注意

- **書き込みは行わない**: `insertHookSignal` は T216 で完成済み。本タスクは **読み取り side のみ**。
- **trace-task パターンに合わせる**: `cmdTraceTask` の構造（オプション→DB open→整形→close）を踏襲。DB は use after close。
- **コメント最小**: 既存の `getTaskSessions` 同様、関数上に JSDoc コメントは書かない（1 行で十分）。
- **フォーマッタ**: 出力カラム幅の定数化は初版では不要。3 箇所以上ドリフトしたらリファクタ。
- **`i18n.ts` のインデント**: en / ja ブロックは 2 空白。`help_trace_task` の既存書式をコピペ → 内容差し替えが安全。
