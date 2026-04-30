# T333 Inspection Report

## Verdict

**GO**

## Summary

`cmux-team delete-task --force` 実装は plan.md / design-review.md の指針に忠実に従っており、FSM 拡張・CLI ガード・i18n・テスト網羅性すべてが impl-report の主張通り pass する。R1〜R6 のレビュー指摘も適切に取り込まれている。スコープ外で `package-lock.json` の差分（`@opencode-ai/sdk` 追加）が混入しているが本実装には影響なし（Minor、PR 段階で対応推奨）。

## Verification Results

### 1. 仕様適合性

#### FSM 拡張
- ✓ `events.ts:108` — `TaskFsmEvent.DELETE` に `force?: boolean` 追加（`{ type: "DELETE"; force?: boolean }`）
- ✓ `task-fsm.ts:111-127` — `case "DELETE"` の分岐は仕様通り:
  - `state === "draft" || state === "ready"` → `deleted` + `log` + `cascade_children`
  - `event.force && (state === "closed" || state === "aborted")` → `deleted` + `log(detail=force=true prev=${state})`、cascade なし
  - その他 → `noop(state)`
- ✓ `state === "deleted"` は `task-fsm.ts:38` の terminal state guard で先に処理される（force でも noop）
- ✓ `state === "assigned"` は分岐対象外で noop（FSM レイヤで保証）

#### CLI レイヤ
- ✓ `cmdDeleteTask` (main.ts:4303-4388) で `forceFlag = hasFlag("force")` 取得（L4315）
- ✓ status guard が以下の順序:
  1. L4326 `assigned` → reject（"is assigned (running). Use abort-task ..."）
  2. L4331 `deleted` → reject（"already deleted."）
  3. L4336 `closed | aborted` + `!force` → reject（"already {status}. Use --force to delete a {status} task."）
- ✓ `applyTaskEvent` 呼出は L4354 で `event: { type: "DELETE", force: forceFlag }`
- ✓ R1 適用済み: L4367 `usedForce = forceFlag && (currentStatus === "closed" || currentStatus === "aborted")` で log（L4370）/ OK 出力（L4387）にマーカ付与を closed/aborted 起点に限定

#### ヘルプ・ドキュメント
- ✓ `main.ts:22` ヘッダコメントに `[--force]` 追記
- ✓ `i18n.ts:466-489` (en) — Options / Examples / Notes に `--force` 追記
- ✓ `i18n.ts:1259-1282` (ja) — 同等の日本語訳追記

### 2. テスト網羅性

#### FSM テスト（`fsm.test.ts:712-824`）
- ✓ T1 `closed + DELETE (force=false) → closed (noop)` (L727)
- ✓ T2 `closed + DELETE (force=true) → deleted + log(force=true)、cascade なし` (L737)
- ✓ T3 `aborted + DELETE (force=false) → aborted (noop)` (L754)
- ✓ T4 `aborted + DELETE (force=true) → deleted + log(force=true)、cascade なし` (L764)
- ✓ T5 `assigned + DELETE (force=true) → assigned` (L780)
- ✓ T6 `deleted + DELETE (force=true) → deleted (terminal state guard)` (L790、独立テスト)
- ✓ R2-1 `draft + DELETE (force=true) → deleted (cascade あり、detail なし)` (L803)
- ✓ R2-2 `ready + DELETE (force=true) → deleted (同上)` (L815)
- ✓ test 数: HEAD 111 / main 103 = +8 件、impl-report の主張と一致
- ✓ 既存 deleted-終端ループ・assigned + DELETE (force=false) regression は引き続き pass

#### CLI テスト（`main.test.ts:803-855`）
- ✓ C1 `closed + force なし → reject (exit 1, "already closed" + "--force" / state 不変)` (L804)
- ✓ C2 `closed + --force → deleted + TASK_UPDATED 1 件` (L816)
- ✓ C3 `aborted + --force → deleted` (L827)
- ✓ C4 `assigned + --force → reject (exit 1, "is assigned" + R4 not.toContain("Use --force") / state 不変)` (L837)
- ✓ C5 `deleted + --force → reject (exit 1, "already deleted" + R4 not.toContain("Use --force"))` (L849)
- ✓ `setupTeamDir` / `runCli` / `receivedMessages` ヘルパー使用は既存パターンに完全に沿っている

### 3. テスト実行

- ✓ `bun test skills/cmux-team/manager/state-machine/fsm.test.ts` → **184 pass / 0 fail / 344 expect()**
- ✓ `bun test skills/cmux-team/manager/main.test.ts -t "delete-task"` → **7 pass / 0 fail / 23 expect()**
- ✓ `bun test skills/cmux-team/manager/main.test.ts -t "TASK_UPDATED"` → **28 pass / 0 fail / 77 expect()**
- impl-report の主張する数値と完全一致。

### 4. TypeScript

- ✓ `bunx tsc -p skills/cmux-team/manager/tsconfig.json --noEmit` → エラー 0 件（出力なし）

### 5. 手動 smoke test

- ✓ ja（デフォルト）: `--force` 行・Examples・Notes が `delete-task --help` に表示される
- ✓ en (`LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8`): `--force` 行・Examples・Notes が表示される

### 6. ガードレール遵守

- ✓ `grep -nE 'taskState\[.*\]\s*='` → 0 件
- ✓ `grep -n 'saveTaskState('` → 0 件
- ✓ state mutation は `applyTaskEvent({ type: "DELETE", force: forceFlag })` 経由のみ
- ✓ EventBus 直接呼出 / hook shell 分岐ロジック追加なし（変更ファイルが state-machine/main/i18n/test に限定されており該当なし）

### 7. R1〜R6 取り込み

- ✓ **R1** — main.ts:4367 で `usedForce` を closed/aborted 起点限定に絞り、reducer 側 detail とセマンティクス一致
- ✓ **R2** — fsm.test.ts:803-823 に draft/ready + force=true の 2 テスト追加（cascade あり、detail なし）
- ✓ **R3** — 実装変更なし（既存 task_deleted 二重 emit パターン維持、impl-report で明示）
- ✓ **R4** — main.test.ts:842, 854 で `expect(r.stderr).not.toContain("Use --force")` を C4/C5 に追加
- ✓ **R5** — 実装変更なし（`currentStatus === undefined` は 3 段ガードを素通りし store 側 prev=draft フォールバックで通常削除、既存挙動と整合）
- ✓ **R6** — fsm.test.ts:790 を独立テストとして追加（既存「deleted は終端 state」ループとは別）。コメントで衝突回避の意図も明示

## Findings

### Critical (NOGO トリガ)

なし

### Major

なし

### Minor

#### M1. `package-lock.json` のスコープ外変更

- 観測: `git diff main -- package-lock.json` で `@opencode-ai/sdk` への依存追加と関連 entries（cross-spawn, isexe, path-key, shebang-command 等）が含まれる
- `package.json` 自体には差分なし。`git status` でも uncommitted な作業ツリー変更として残っている
- 本タスクの実装内容（FSM / CLI / i18n / テスト）には影響しないが、PR 化前にこの差分を別途処理するか説明を加えることを推奨
- インスペクションの判定上は GO を妨げない（コードの正当性・テスト・型検査いずれも独立に pass しており、本実装の検証結果は変わらない）

## 結論

実装は plan.md・design-review.md の方針に忠実で、R1〜R6 もすべて取り込まれている。FSM・CLI 両層でのテスト 13 件追加（FSM 8 + CLI 5）はすべて pass、TypeScript エラーなし、ガードレール grep invariant 0 件、en/ja 両ヘルプで `--force` 表示確認済み。コード品質・既存パターンとの一貫性も高い。

`package-lock.json` のスコープ外差分のみ Minor 指摘として残るが、本実装の正当性に影響しないため **GO**。PR 段階で当該差分を切り離すか別タスクとして扱うことを推奨する。
