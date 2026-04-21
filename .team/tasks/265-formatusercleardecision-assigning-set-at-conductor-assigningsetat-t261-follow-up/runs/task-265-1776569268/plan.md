# T265 実装計画: formatUserClearDecision の assigning_set_at を conductor.assigningSetAt 由来に修正する

## 1. 概要

T261 で追加された `user_clear_decision_snapshot` ログの `assigning_set_at` フィールドは、キー名と実体のセマンティクスが一致していない（Inspector Major 1）。`daemon.ts:233` は `conductor.startedAt`（Conductor **プロセス起動時刻** — `launchConductor` で set、assignTask では更新されない）を読んでおり、キー名から期待される「`status="assigning"` に遷移した時刻」とは別物になっている。T262 事例では 1h45m 前の値が出力され、調査時のノイズ源となった。

本タスクでは `ConductorState` にランタイム限定フィールド `assigningSetAt?: string` を追加し、`assignTask` で `conductor.status = "assigning"` と同じトランザクションで set、`resetConductor` で undefined に戻す。`formatUserClearDecision` は `conductor.startedAt` の代わりに `conductor.assigningSetAt` を読む。既存の判定ロジック（`elapsed_since_clear_sent` 等）には影響せず、ログの観測性改善のみが目的。永続化は行わない（既存の `promptSentAt` 等と同じ扱い — daemon 再起動後は undefined に戻る）。

## 2. 対象ファイルと変更点

### 2.1 `skills/cmux-team/manager/schema.ts` — ConductorState に `assigningSetAt` 追加

**場所**: `ConductorState` Zod スキーマ（行 204〜237）の「ランタイム限定（永続化しない）」コメントブロック（行 229〜236）。

**変更内容**:
```ts
// ランタイム限定（永続化しない — restoreConductors で undefined に戻る）:
//   - promptSentAt / promptBytes: assignTask でプロンプト送信完了時刻とサイズ
//   - sessionStartedClearAt: SESSION_STARTED(source=clear) で assigning → running 遷移した時刻
//   - sessionIdleAtInAssigning: SESSION_IDLE R1 保険経路で assigning → running に遷移した時刻
//   - assigningSetAt: assignTask が status="assigning" にセットした時刻（T265）
promptSentAt: z.string().datetime().optional(),
promptBytes: z.number().optional(),
sessionStartedClearAt: z.string().datetime().optional(),
sessionIdleAtInAssigning: z.string().datetime().optional(),
assigningSetAt: z.string().datetime().optional(),  // ← 追加
```

**注意**: 永続化しないため、`daemon.ts:updateTeamJson`（行 2758〜2784）と `daemon.ts:restoreConductor*`（行 920〜924 付近）には **触らない**。スキーマに field を追加するだけで optional になり、team.json の parse 互換性は維持される。

### 2.2 `skills/cmux-team/manager/conductor.ts:assignTask` — status=assigning 直前に assigningSetAt を set

**場所**: 行 442〜446（`conductor.status = "assigning"` の set 箇所）。

**変更前** (442-446):
```ts
// T232: /clear 送信直前に "assigning" を立てる。daemon 自身の /clear が
//       遅延して SESSION_CLEAR hook を発火しても、この状態窓で早期 return して
//       ユーザー手動 /clear と誤認しない（race condition の根治）。
conductor.status = "assigning";
notifyStateChanged("conductor.ts:assignTask:assigning-set");
```

**変更後**:
```ts
// T232: /clear 送信直前に "assigning" を立てる。daemon 自身の /clear が
//       遅延して SESSION_CLEAR hook を発火しても、この状態窓で早期 return して
//       ユーザー手動 /clear と誤認しない（race condition の根治）。
// T265: assigning にセットした正確な時刻を記録する（formatUserClearDecision
//       の assigning_set_at が参照する）。conductor.status と同じトランザクションで set。
conductor.status = "assigning";
conductor.assigningSetAt = new Date().toISOString();
notifyStateChanged("conductor.ts:assignTask:assigning-set");
```

**不変条件**: `conductor.status = "assigning"` と `conductor.assigningSetAt = ...` の間に他の呼び出し（await 等）を挟まない。両者は同期的に連続セットし、`notifyStateChanged` 発火までに両 field が揃っている状態を保証する。

### 2.3 `skills/cmux-team/manager/conductor.ts:resetConductor` — assigningSetAt を undefined に戻す

**場所**: 行 629〜635（T261 系フィールドの undefined クリア箇所）。

**変更前** (629-635):
```ts
// T261: user_clear 判定用の snapshot フィールドも必ずクリアする。
//       stale 値で次の割当サイクルの判定を汚染しないため（Decision 記載の安全策）。
conductor.clearSentAt = undefined;
conductor.promptSentAt = undefined;
conductor.promptBytes = undefined;
conductor.sessionStartedClearAt = undefined;
conductor.sessionIdleAtInAssigning = undefined;
```

**変更後**:
```ts
// T261/T265: user_clear 判定用の snapshot フィールドも必ずクリアする。
//       stale 値で次の割当サイクルの判定を汚染しないため（Decision 記載の安全策）。
conductor.clearSentAt = undefined;
conductor.promptSentAt = undefined;
conductor.promptBytes = undefined;
conductor.sessionStartedClearAt = undefined;
conductor.sessionIdleAtInAssigning = undefined;
conductor.assigningSetAt = undefined;
```

### 2.4 `skills/cmux-team/manager/daemon.ts:formatUserClearDecision` — startedAt → assigningSetAt

**場所**: 行 233（`formatUserClearDecision` の `assigning_set_at` field 生成）。

**変更前**:
```ts
`assigning_set_at=${conductor.startedAt ?? "null"}`,
```

**変更後**:
```ts
`assigning_set_at=${conductor.assigningSetAt ?? "null"}`,
```

**意図**: キー名は `assigning_set_at` のまま維持する（ログ互換性優先。Inspector 推奨の `conductor_started_at` リネームは採用しない）。値の解決元だけを `conductor.startedAt` → `conductor.assigningSetAt` に差し替える。

## 3. テスト計画

### 3.1 新規テスト（合計 3 本）

#### T-a: `conductor.test.ts` — `assignTask 成功 → conductor.assigningSetAt が set される`

場所: `skills/cmux-team/manager/conductor.test.ts` の `describe("assignTask snapshot フィールド記録 (T261)", ...)` ブロック内（行 622〜693）に追加、または `describe("assignTask snapshot フィールド記録 (T265)", ...)` として新規 block。

要件:
- `fakeConductor()` で conductor を作り `assignTask` を呼ぶ
- `conductor.assigningSetAt` が ISO 8601 文字列で set されている
- `conductor.startedAt` とは別の値になっている（同時刻サンプリングで等しくなる可能性があるため `startedAt < assigningSetAt` の順序検証ではなく「assigningSetAt が set されていること」を assert する）
- `conductor.clearSentAt` より前の時刻になっている（`conductor.assigningSetAt <= conductor.clearSentAt`）

実装例:
```ts
test("assignTask 成功 → conductor.assigningSetAt が set され clearSentAt より前", async () => {
  await gitInitWithMain();
  await writeTaskFile("265a", "assigning-set-at");
  const conductor = fakeConductor();
  await assignTask(conductor, "265a", testDir, "main");

  expect(conductor.assigningSetAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(new Date(conductor.assigningSetAt!).getTime()).toBeLessThanOrEqual(
    new Date(conductor.clearSentAt!).getTime(),
  );
});
```

#### T-b: `conductor.test.ts` — `resetConductor → conductor.assigningSetAt が undefined に戻る`

場所: 既存 `describe("resetConductor ...)` ブロック（T261 フィールドクリアの検証と同じ場所）があれば合流、無ければ新 test を追加。

要件:
- 事前に `conductor.assigningSetAt = "2026-04-19T10:00:00.000Z"` を set
- `resetConductor(conductor, testDir, undefined, { targetStatus: "idle" })` を呼ぶ
- `conductor.assigningSetAt` が undefined に戻る

実装例:
```ts
test("resetConductor → conductor.assigningSetAt が undefined にクリアされる", async () => {
  const conductor: ConductorState = {
    surface: "surface:265r",
    startedAt: "2026-04-19T09:00:00.000Z",
    agents: [],
    status: "running",
    taskRunId: "task-265-r",
    taskId: "265r",
    assigningSetAt: "2026-04-19T10:00:00.000Z",
  };
  await resetConductor(conductor, testDir, undefined, { targetStatus: "idle" });
  expect(conductor.assigningSetAt).toBeUndefined();
});
```

#### T-c: `daemon.test.ts` — `formatUserClearDecision は assigning_set_at に conductor.assigningSetAt を使う（startedAt は参照しない）`

場所: `describe("handleMessage: user_clear_decision_snapshot (T261)", ...)` ブロック（行 3757〜3836）の末尾、または `describe(... (T265))` として新 block を追加。

要件:
- `startedAt` と `assigningSetAt` を異なる値で set（例: `startedAt="2026-04-19T10:00:00.000Z"`, `assigningSetAt="2026-04-19T11:00:00.000Z"`）
- `SESSION_CLEAR` を handleMessage に流し、`user_clear_decision_snapshot` ログを取得
- `assigning_set_at=2026-04-19T11:00:00.000Z` が出ている（＝ `assigningSetAt` 由来）
- `assigning_set_at=2026-04-19T10:00:00.000Z` が出ていない（＝ `startedAt` を参照していないことの negative 検証）

実装例:
```ts
test("formatUserClearDecision の assigning_set_at は conductor.assigningSetAt 由来（startedAt 非参照）", async () => {
  const state = await createDaemon(testDir);
  const startedAt = "2026-04-19T10:00:00.000Z";
  const assigningSetAt = "2026-04-19T11:00:00.000Z";
  const clearSentAt = "2026-04-19T11:00:00.100Z";
  const receivedAt = "2026-04-19T11:00:02.100Z";
  const conductor: ConductorState = {
    surface: "surface:265f",
    startedAt,
    assigningSetAt,
    agents: [],
    status: "assigning",
    pid: 12345,
    taskRunId: "task-265-f",
    taskId: "265f",
    clearSentAt,
  };
  state.conductors.set(conductor.surface, conductor);

  await handleMessage(state, {
    type: "SESSION_CLEAR",
    surface: conductor.surface,
    timestamp: receivedAt,
  });

  const logContent = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
  expect(logContent).toMatch(/assigning_set_at=2026-04-19T11:00:00\.000Z/);
  expect(logContent).not.toMatch(/assigning_set_at=2026-04-19T10:00:00\.000Z/);
});
```

### 3.2 既存テストへの影響

既存の T261 テストは `assigning_set_at=<値>` の具体値にアサートしていない（regex は `.*decision_reason=...` で吸収している）ため、**既存 11 本（daemon 9 本 + conductor 2 本）は影響なし**で pass するはず。

チェックポイント:
- `daemon.test.ts:3757` `user_clear_decision_snapshot (T261)` → `.*decision_reason=daemon_assign_clear` / `.*prompt_bytes=42 decision_reason=running_with_taskid` で通す — 影響なし
- `daemon.test.ts:3838` `assigning_window_close` → `assigning_set_at` を参照していない — 影響なし
- `daemon.test.ts:3933` `session_idle_source_guess` → 同上 — 影響なし
- `daemon.test.ts:4020` `T261 フィールド永続化` → `clearSentAt` のみ assert、他 4 field は undefined — `assigningSetAt` も同じく undefined になるはず（永続化しないため）。**追加で `expect(serialized.assigningSetAt).toBeUndefined()` と `expect(parsed.assigningSetAt).toBeUndefined()` を足してもよい**（任意 — 永続化しない契約を明示する）。
- `conductor.test.ts:622` `assignTask snapshot フィールド記録 (T261)` → `clearSentAt`/`promptSentAt`/`promptBytes` のみ assert — 影響なし

### 3.3 実行確認

- `cd skills/cmux-team/manager && bun test` 全通過（現状 597 pass → T-a / T-b / T-c 3 本追加で 600 pass 想定）
- TypeScript エラーが touched files（`schema.ts` / `conductor.ts` / `daemon.ts`）で 0 件であること

## 4. リスク・注意点

### 4.1 race condition の扱い

`conductor.status = "assigning"` と `conductor.assigningSetAt = ...` の間に他の await を挟むと、SESSION_CLEAR hook が先着したときに `assigningSetAt === undefined` で snapshot が出る可能性がある。対策: 両者を **同期的に連続セット** し、`notifyStateChanged` より前で必ず両方 set する（実装箇所 2.2 参照）。

ただし、実害は小さい — assigningSetAt が undefined でも `formatUserClearDecision` は `"null"` を出すだけで、`decision_reason` や `elapsed_since_clear_sent` の判定ロジックには影響しない（キー名 mismatch を修正するタスクなので、"null" のほうが現状の 1h45m 前よりも誤読しづらい）。

### 4.2 永続化しない契約の維持

`assigningSetAt` は **ランタイム限定**（`promptSentAt` 等と同じ扱い）。daemon 再起動時に stale な `assigningSetAt` が残ると、再起動直後に user_clear が来た場合に誤った値を出す可能性がある。対策:
- `updateTeamJson` の conductors シリアライズ（daemon.ts:2758〜2784）に `assigningSetAt` を **追加しない**
- `restoreConductor*`（daemon.ts:907〜932）にも追加しない
- `Zod ConductorState` に optional field として残すだけ（parse 時に team.json に存在しなくても undefined になる）

上記を守ることで、既存の「runtime only」4 field と同じ挙動を保証できる。

### 4.3 テストの時刻比較

`assigningSetAt <= clearSentAt` の順序検証を strict（`<`）ではなく non-strict（`<=`）で書く。同一 ms 内で両方 set される可能性があり、CI の時計精度に依存するため。

### 4.4 Inspector Minor 2/3 は非対応

タスク本文「非スコープ」の通り、以下は本 PR では対応しない:
- Minor 2（impl-report のテスト数字ずれ）— impl-report 側の修正のみで本修正対象外
- Minor 3（positive/negative 合流テスト）— 仕様許容範囲内
- キー名 `conductor_started_at` へのリネーム案 — 後方互換優先で採用しない

### 4.5 ドキュメント影響（なし）

CLAUDE.md や docs/spec/ に `assigning_set_at` の field 意味論を書いた箇所は無い（`grep` で検出 0 件）。実装コメントの `// T261` に `T265` を追加する程度で、docs 側の追従は不要。

## 5. TDD 手順

以下の順で実装し、各ステップで該当テストが pass することを確認する。

### Step 1: 型追加（schema.ts）

1. `schema.ts` の `ConductorState` に `assigningSetAt: z.string().datetime().optional()` を追加
2. `bun test` を走らせ、既存 597 本が引き続き pass することを確認（schema 追加のみでは振る舞い変化なし）

### Step 2: assignTask で assigningSetAt を set（テスト先行 → 実装）

1. **Red**: `conductor.test.ts` にテスト T-a（`assignTask 成功 → conductor.assigningSetAt が set される`）を追加。テストは `expect(conductor.assigningSetAt).toMatch(...)` で fail する。
2. **Green**: `conductor.ts:444` 付近に `conductor.assigningSetAt = new Date().toISOString()` を追加（`conductor.status = "assigning"` の直後、`notifyStateChanged` より前）。
3. **Verify**: テスト T-a が pass。既存 11 本も pass。

### Step 3: resetConductor で undefined にクリア（テスト先行 → 実装）

1. **Red**: `conductor.test.ts` にテスト T-b（`resetConductor → conductor.assigningSetAt が undefined に戻る`）を追加。事前 set した `assigningSetAt` が残ったままで fail する。
2. **Green**: `conductor.ts:635` 付近の T261 クリアブロックに `conductor.assigningSetAt = undefined;` を追加。
3. **Verify**: テスト T-b が pass。既存テストも pass。

### Step 4: formatUserClearDecision で assigningSetAt を参照（テスト先行 → 実装）

1. **Red**: `daemon.test.ts` にテスト T-c（`formatUserClearDecision の assigning_set_at は conductor.assigningSetAt 由来`）を追加。現状は `startedAt` を出すので `expect(...).toMatch(/assigning_set_at=2026-04-19T11:00:00\.000Z/)` で fail する。
2. **Green**: `daemon.ts:233` の `conductor.startedAt` → `conductor.assigningSetAt` に差し替え。
3. **Verify**: テスト T-c が pass。既存 T261 テスト 9 本も pass。

### Step 5: 全体検証

1. `cd skills/cmux-team/manager && bun test` で全 600 本 pass（想定）
2. `tsc --noEmit`（または `bun tsc --noEmit`）相当で TypeScript エラーが touched files で 0 件
3. `rg "conductor\.startedAt" skills/cmux-team/manager/daemon.ts | rg assigning_set_at` で取りこぼしが無いことを確認（この grep は 0 件のはず）

### Step 6: インスペクタ引き渡し前の最終チェック

- `conductor.ts` の `conductor.status = "assigning"` と `conductor.assigningSetAt = ...` が **同期的に連続** していること（間に await が無いこと）を改めて確認
- 永続化していないこと（`updateTeamJson` と `restoreConductor*` に `assigningSetAt` が出てこないこと）を `rg "assigningSetAt" skills/cmux-team/manager/daemon.ts` で確認 — **期待結果: `formatUserClearDecision` 1 件のみ**（行 233）
