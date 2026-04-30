# T302 実装レポート: assign 完了書き込み時に terminal status を尊重する（暫定ガード）

## 実装サマリ

plan.md の **方針 B** に従い、`__testApplyAssignCommit` helper を `daemon.ts` に新設し、
`scanTasks` 内の assign 完了書き込みブロックを helper 呼び出しに置換した。
テストは daemon.test.ts 末尾に `describe("T302 assign_skipped_terminal guard", ...)` を追加。

## 変更ファイル一覧

| ファイル | 実装前 行数 | 実装後 行数 | 差分 |
|---------|------------|------------|------|
| `skills/cmux-team/manager/daemon.ts` | 3447 | 3487 | +40 行 (実質 +52 / -12) |
| `skills/cmux-team/manager/daemon.test.ts` | 5061 | 5274 | +213 行 |

`git diff --stat HEAD`:

```
 skills/cmux-team/manager/daemon.test.ts | 213 ++++++++++++++++++++++++++++++++
 skills/cmux-team/manager/daemon.ts      |  64 ++++++++--
 2 files changed, 265 insertions(+), 12 deletions(-)
```

import 追加は無し（`isTerminalStatus` / `resetConductor` / `formatSurface` /
`log` / `loadTaskState` / `saveTaskState` は既存 import をそのまま再利用）。

## 実装詳細

### daemon.ts

- `scanTasks` 内 L2646-2657 付近の assign 完了書き込みブロック（`loadTaskState` →
  スプレッド → `saveTaskState`）を `__testApplyAssignCommit(state, task.id, updated)`
  呼び出しに置換。戻り値の `committed` が false なら `continue`。
- 新規 export 関数 `__testApplyAssignCommit` を `scanTasks` の直下に追加。
  - 返り値: `{ committed: boolean; reason?: "terminal"; currentStatus?: string }`
  - `ts[taskId]?.status` が `isTerminalStatus` を満たせば
    - `assign_skipped_terminal` ログを emit（`C[surface] task_id=<id>
      current_status=<s> taskRunId=<id>` 形式、logger.ts の `formatSurface(surface, "C")` 使用）
    - `resetConductor(updated, state.projectRoot, state.workspace ?? undefined)` で
      worktree cleanup + Conductor idle reset
    - `{ committed: false, reason: "terminal", currentStatus }` を返す
  - それ以外は従来通り `task-state.json` に `status: 'assigned'` + resume 情報を書き込み
    `{ committed: true }` を返す
- JSDoc に race の背景・副作用・`TODO(T303): remove after reducer migration` を明記。

### daemon.test.ts

`describe("T302 assign_skipped_terminal guard", ...)` を末尾に追加（5 ケース）:

1. **deleted race** — `task-state=deleted` + `worktreePath` 存在 →
   `committed=false`, `reason=terminal`, log に
   `assign_skipped_terminal` / `current_status=deleted` / `conductor_reset`,
   Conductor idle, `deletedAt` 保持 / `assignedAt` 未設定
2. **aborted race** — `task-state=aborted` + `worktreePath` 未設定 →
   `committed=false`, `reason=terminal`, Conductor idle
3. **closed race (regression guard)** — `task-state=closed` →
   `committed=false`, `reason=terminal`, Conductor idle
4. **ready normal** — `task-state=ready` → `committed=true`,
   `task-state.json` に `assigned` + `assignedAt` + `conductorSlot` +
   `taskRunId` + `sessionId` が書き込まれ、Conductor は `assigning` のまま
5. **undefined status (defensive)** — `task-state.json` に entry 無し →
   ガード不発動、`committed=true`, `assigned` が書き込まれる

plan.md 4.3 では 4 ケースだったが、terminal 状態 3 種（deleted/aborted/closed）の
分岐カバレッジを網羅するため、closed を独立ケースとして追加した（5 ケース）。

cmux 依存関数（`getPaneForSurface` / `listSiblingSurfaces` / `closeSurface`）は
`beforeEach` / `afterEach` で `spyOn` によりモック化。resetConductor 内の
`cmux tree` 実行が fake surface を見つけられず broken に昇格する事故を回避する。
conductor.test.ts `describe("resetConductor targetStatus オプション (T250)", ...)` と
同じパターン。

## 最終テスト結果

### 新規 T302 ケース（5 件）

```
bun test daemon.test.ts -t "T302 assign_skipped_terminal"
 5 pass
 159 filtered out
 0 fail
 34 expect() calls
Ran 5 tests across 1 file. [184.00ms]
```

### 既存テスト全体

```
bun test
 1088 pass
 0 fail
 2562 expect() calls
Ran 1088 tests across 36 files. [50.03s]
```

新規 5 ケースを含む全 1088 テストが pass。

## 型検査結果

```
bunx tsc --noEmit
```

出力エラーは 3 件（いずれも T302 実装以前から存在する既存エラー）:

- `conductor.ts(201,3): error TS1016: A required parameter cannot follow an optional parameter.`
- `daemon.test.ts(3870,9): error TS2322: Type '"new_session"' is not assignable to type '"startup" | "resume" | "clear" | "compact" | undefined'.`
- `daemon.ts(1546,22): error TS2352: Conversion of type 'string | undefined' ...`

`git stash` で実装を退避したベースラインでも同一の 3 件のみが出ることを確認済み
（本実装由来の新規エラーは 0 件）。

## plan.md から逸脱した点

### 1. テストに cmux 関数のモックを追加した

**plan.md 注意点の予告**:

> plan.md のテストサンプルでは `testDir` への `git init` をしていない
> （`git worktree remove` が失敗するが `resetConductor` の `cleanup_failed` 経路で
> 握りつぶされることを前提としている）。その前提が成立するか実装時に確認すること。

**検証結果と対応**:

- `git worktree remove` 失敗の握りつぶしは成立する。
- しかし `resetConductor` は冒頭で `cmux.getPaneForSurface` を呼び、fake surface
  （例: `surface:fake-c302`）は実 cmux tree には存在しないため `undefined` を返す。
  この結果 T251 の幽霊 Conductor 防止ロジックにより `surface_missing` として
  `broken` に倒れる。これだと plan.md の期待 `conductor.status === "idle"` が満たせない。
- したがって `getPaneForSurface` / `listSiblingSurfaces` / `closeSurface` の 3 つを
  `spyOn` でモックした（conductor.test.ts の T250 と同じ方針）。これで surface 存在
  扱いになり `idle` に倒れる挙動を検証できる。

### 2. テストケースを 4 から 5 に増やした

plan.md 4.3 は `deleted` / `aborted` / `ready` / `undefined status` の 4 ケース。
`isTerminalStatus` が 3 値（`closed` / `aborted` / `deleted`）を同一視する
ガード仕様なので、`closed` を独立ケースとして追加（regression guard 目的）。

### 3. ログアサート文言

plan.md サンプルでは `expect(log).toContain("conductor_reset")` とだけ書いて
いるが、実装中のログは `conductor_reset C[surface]` 形式。表記揺れ無く
そのまま contain で通る。

## 完了条件チェック

- [x] plan.md の指示通り daemon.ts / daemon.test.ts に実装
- [x] 既存 `bun test` が全 pass（1088 / 1088）
- [x] 新規テスト 5 ケースが pass（plan.md の 4 ケース + closed 追加 1 ケース）
- [x] `bunx tsc --noEmit` で新規エラー 0 件
- [x] impl-report.md を書き出し済み
