# T406 実装計画

## 1. 修正の概要

`task_sessions` テーブルの `event='agent_spawned'` 行が `session_id=""` のまま放置され、`hook_signals.session_id` (Agent 自身が確定した sessionId) と join できないせいで Agent 由来 tool_use が `countToolCallsByTask` / `firstEditPerTask` / `failureRateByTask` の集計から全件抜ける既存バグを修正する。

採用方針は task.md で確定済みの **(i)**:

- Agent SESSION_STARTED 受信時に、対応する `agent_spawned` 行を **後追いで UPDATE** し session_id を埋める
- 上記 3 関数の `WITH session_to_task AS (...)` CTE を `event IN ('assigned','agent_spawned')` に拡張し、空文字 session_id 行は WHERE で除外する

T403 と共通化しうる `resolveTaskIdBySurface` 系 helper の切り出しは **本タスクスコープ外**。本タスクは `task_sessions` の正常化のみに閉じる。

## 2. 変更ファイル一覧

| ファイル | 変更概要 |
|---|---|
| `skills/cmux-team/manager/trace-store.ts` | (a) 新規 helper `updateAgentSpawnedSessionId(db, surface, sessionId)` を追加、(b) `countToolCallsByTask` / `firstEditPerTask` / `failureRateByTask` の CTE を `event IN ('assigned','agent_spawned')` + `session_id != ''` に拡張 |
| `skills/cmux-team/manager/daemon.ts` | Agent surface の SESSION_STARTED ハンドラ（1839 付近）から、`agent.sessionId` 反映の直後に `updateAgentSpawnedSessionId` を呼び、対応する `agent_spawned` 行を UPDATE する |
| `skills/cmux-team/manager/trace-store.test.ts` | (a) 新 helper の単体テスト、(b) 3 関数が `agent_spawned` 経由で task_id 解決できることを直接検証するテスト |
| `skills/cmux-team/manager/daemon.test.ts` | Agent SESSION_STARTED 受信時に DB の `agent_spawned` 行が UPDATE されることを検証するテスト |
| `skills/cmux-team/manager/metrics-aggregate.test.ts` | `aggregateMetricsByTask` に Agent 由来 tool_use が含まれるフィクスチャを追加する e2e ケース（既存テストの拡張） |

`main.ts:3058-3078` の `insertTaskSession({ session_id: "" })` は **据え置く**。空文字で挿入し、後で UPDATE で埋める二段構成は意図通り（spawn 時点で Agent の sessionId は未確定）。

## 3. 新規 helper 関数の signature と実装方針

### `updateAgentSpawnedSessionId`

```ts
/**
 * T406: Agent SESSION_STARTED 受信時に呼ばれ、対応する task_sessions の
 * agent_spawned 行（session_id="" で挿入されたもの）を UPDATE して
 * Agent の sessionId を埋める。
 *
 * 同一 surface に対して複数回呼ばれても idempotent
 * （session_id != '' の WHERE 条件で再 UPDATE が起きない）。
 *
 * @returns 更新行数（0 = まだ agent_spawned 行が存在しない / 既に埋め済み）
 */
export function updateAgentSpawnedSessionId(
  db: Database,
  surface: string,
  sessionId: string,
): number;
```

実装:

```ts
export function updateAgentSpawnedSessionId(
  db: Database,
  surface: string,
  sessionId: string,
): number {
  if (!surface || !sessionId) return 0;
  const stmt = db.prepare(`
    UPDATE task_sessions
       SET session_id = $sessionId
     WHERE event = 'agent_spawned'
       AND surface = $surface
       AND (session_id IS NULL OR session_id = '')
  `);
  const r = stmt.run({ $surface: surface, $sessionId: sessionId });
  return Number(r.changes);
}
```

ポイント:

- `WHERE surface = $surface` で対象を 1 行に絞る（`agent_spawned` は spawn ごとに 1 行）
- `(session_id IS NULL OR session_id = '')` で **idempotent**（resume / clear で SESSION_STARTED が再着しても 2 回目以降は no-op）
- 戻り値は呼び出し側のログ用（`r.changes`）

### daemon.ts 側の呼び出し点

`skills/cmux-team/manager/daemon.ts:1840-1858` の Agent surface 分岐内、`agent.sessionId = message.sessionId` を行う直後に挿入:

```ts
if (agent) {
  // T203: Agent も同様に最新 sessionId を反映
  if (message.sessionId) agent.sessionId = message.sessionId;
  agent.pid = message.pid;
  agent.status = "running";
  agent.lastApiError = undefined;
  spawnAgentPidWatcher(state, c, agent, message.pid);

  // T406: agent_spawned 行（session_id="" で挿入された）に Agent の sessionId を埋める。
  // 既に埋まっていれば no-op（resume / clear で再着しても OK）。
  if (message.sessionId) {
    try {
      const db = initDB(state.projectRoot);
      const changed = updateAgentSpawnedSessionId(db, message.surface, message.sessionId);
      db.close();
      if (changed > 0) {
        await log(
          "task_session_agent_session_id_set",
          `${formatPair(c.surface, message.surface, "C", "A")} session_id=${message.sessionId} rows=${changed}`,
        );
      }
    } catch (e: any) {
      await log("error", `agent_spawned session_id update failed: ${e?.message ?? e}`);
    }
  }

  notifyStateChanged("daemon.ts:handleMessage:session-started-agent");
  // ...既存ログ
}
```

注意:

- `initDB`/`db.close()` の都度 open はリポジトリ既存パターン（`main.ts:3063` 同様）に合わせる。Manager 全体で DB を持ち回る共有変数は採らない
- guard は `message.sessionId` truthy のみ。`prevSessionId !== message.sessionId` 等の差分判定は不要（helper 側で session_id 空の行のみ更新するため、Agent の sessionId 反映と DB UPDATE のセマンティクスがズレない）
- 失敗時は warn のみ（task_session の write は best-effort）。Agent 動作自体は止めない

## 4. CTE 修正の具体的 diff

`skills/cmux-team/manager/trace-store.ts` の 3 箇所:

### 4.1 `countToolCallsByTask` (1178-1194 行付近)

```diff
   const stmt = db.prepare(`
     WITH session_to_task AS (
       SELECT session_id, MIN(task_id) AS task_id
       FROM task_sessions
-      WHERE event = 'assigned' AND task_id IS NOT NULL
+      WHERE event IN ('assigned', 'agent_spawned')
+        AND task_id IS NOT NULL
+        AND session_id IS NOT NULL
+        AND session_id != ''
       GROUP BY session_id
     )
     SELECT s2t.task_id AS task_id, h.tool_name AS tool_name, COUNT(*) AS n
     FROM hook_signals h
     LEFT JOIN session_to_task s2t USING (session_id)
     ...
```

### 4.2 `firstEditPerTask` (1219-1234 行付近)

```diff
   const stmt = db.prepare(`
     WITH session_to_task AS (
       SELECT session_id, MIN(task_id) AS task_id
       FROM task_sessions
-      WHERE event = 'assigned' AND task_id IS NOT NULL
+      WHERE event IN ('assigned', 'agent_spawned')
+        AND task_id IS NOT NULL
+        AND session_id IS NOT NULL
+        AND session_id != ''
       GROUP BY session_id
     )
     ...
```

### 4.3 `failureRateByTask` (1257-1281 行付近)

```diff
   const stmt = db.prepare(`
     WITH session_to_task AS (
       SELECT session_id, MIN(task_id) AS task_id
       FROM task_sessions
-      WHERE event = 'assigned' AND task_id IS NOT NULL
+      WHERE event IN ('assigned', 'agent_spawned')
+        AND task_id IS NOT NULL
+        AND session_id IS NOT NULL
+        AND session_id != ''
       GROUP BY session_id
     )
     ...
```

`session_id != ''` を必ず加える理由:

- 修正前 (event='assigned' のみ): assigned 行は当初から session_id が確定状態でしか入らないため不要だった
- 修正後 (event IN (...)): `agent_spawned` 行は **insert 時 session_id=""** で入る（spawn 時点で未確定）。SESSION_STARTED の UPDATE が来る前のレース状態では空文字で残っている可能性があるので、空文字行は CTE から除外して、対応する `hook_signals` 行は task_id=NULL（unattached）として正しく集計に表れるようにする
- WHERE で除外しない場合、`hook_signals.session_id IS NULL` と空文字 join がぶつかり集計が破壊される恐れがある（Bun SQLite の挙動依存だが、保険として明示する）

## 5. テスト追加方針

### 5.1 `trace-store.test.ts`

新 describe ブロックを 1 つ追加:

```ts
describe("trace-store: updateAgentSpawnedSessionId (T406)", () => {
  // a. session_id="" の agent_spawned 行に対して helper 呼び出し → session_id が埋まる
  // b. 既に session_id 埋まっている行は no-op（changes=0）
  // c. surface 不一致は no-op
  // d. event != 'agent_spawned' 行（assigned 等）は触らない
  // e. 同 surface に複数 agent_spawned 行があっても全部埋める（resume 時の安全側）
});
```

さらに 3 関数のテスト 1 個ずつを追加:

```ts
describe("trace-store: 3 関数が agent_spawned 経由で task_id 解決する (T406)", () => {
  // フィクスチャ:
  //   1) Conductor: insertTaskSession({ event: 'assigned', task_id: 'T200',
  //      session_id: 'sess-cond', surface: 'surface:200' })
  //   2) Agent spawn: insertTaskSession({ event: 'agent_spawned',
  //      task_id: 'T200', session_id: '', surface: 'surface:300', role: 'planner' })
  //   3) Agent SESSION_STARTED 後を再現:
  //      updateAgentSpawnedSessionId(db, 'surface:300', 'sess-agent')
  //   4) hook_signals: PRE_TOOL_USE Edit を session_id='sess-agent' で 1 件
  //   5) hook_signals: POST_TOOL_USE Edit (success=false) を sess-agent で 1 件
  //
  // 期待値:
  //   - countToolCallsByTask → [{ task_id: 'T200', tool_name: 'Edit', n: 1 }]
  //   - firstEditPerTask     → [{ task_id: 'T200', first_edit_ts: <ts> }]
  //   - failureRateByTask    → [{ task_id: 'T200', total: 1, failures: 1 }]
  //
  // 追加: session_id="" のままの agent_spawned 行に対する hook_signals は
  //       task_id=NULL に倒れることも確認（unattached の正しい振る舞い）
});
```

### 5.2 `daemon.test.ts`

既存の `describe("Agent SESSION_STARTED (T195)")` ブロック（1030 行付近）の隣に新規テスト 1 個:

```ts
test("T406: Agent SESSION_STARTED 受信で task_sessions の agent_spawned 行に session_id が埋まる", async () => {
  // 事前条件: Conductor 登録 + spawn-agent 経由相当で task_sessions に
  //   agent_spawned 行（session_id="", task_id="T999", surface="surface:300"）を直接 insert
  // 投入: SESSION_STARTED { surface:"surface:300", sessionId:"sess-xyz", pid }
  // 検証:
  //   - getTaskSessions(db, { event: 'agent_spawned' }) で session_id="sess-xyz" になっている
  //   - 同じメッセージを再送しても session_id は変わらない（idempotent）
});
```

### 5.3 `metrics-aggregate.test.ts`

既存 `describe("aggregateMetricsByTask (T379)")` の `test("task lifecycle + tool calls + api_usage を 1 タスク分まとめる")` を拡張せず、**追加テスト** を 1 件入れる（既存テストは Conductor のみのケースとして残す）:

```ts
test("T406: agent_spawned 行（session_id 後埋め）経由で Agent の tool_use も合算される", async () => {
  // - events.jsonl: assigned + completed
  // - task_sessions: assigned (Conductor sess-c) + agent_spawned (Agent sess-a)
  //   ※ agent_spawned は最初 session_id="" で insert → updateAgentSpawnedSessionId
  // - hook_signals: Conductor sess-c から PRE_TOOL_USE Read 1件、
  //                 Agent     sess-a から PRE_TOOL_USE Edit 2件 / POST失敗 1件
  // - 期待: r.tool_calls.Edit === 2 / r.tool_calls.Read === 1
  //         r.tool_call_total === 3 / r.tool_failure_rate ≈ 0.x
});
```

## 6. backfill 判断

**判断: 実施しない。**

理由:

1. **稼働中 DB**: SESSION_STARTED が次に Agent から飛んだタイミングで `updateAgentSpawnedSessionId` が呼ばれ、過去 spawn 分の `agent_spawned` 行も自然に埋まる（idempotent なので副作用なし）。Agent が再起動 / resume すれば SESSION_STARTED が来るので、活きている Agent はほぼ取り戻せる。
2. **fresh DB**: そもそも問題が起きない。
3. **既に終了した Agent の過去 metrics**: backfill ロジックを書くなら「`agent_spawned` 行の `surface` から `hook_signals.session_id` の最頻値を逆引きする」等のヒューリスティクスが必要で、確実性が下がる（Agent surface 再利用が起きると誤紐付けする）。**過去 metrics の正確性向上 vs 誤紐付けリスク** を秤にかけて、実施しない。
4. **観測される影響範囲**: T406 リリース後に過去データを集計した場合、過去の `agent_spawned`（session_id="" のまま）を起点とする Agent tool_use は引き続き `task_id=NULL`（unattached）に倒れる。これは「過去そうだった」という事実を保つだけで、新規バグを生まない。
5. T406 仕様上の受け入れ条件は「**新規 hook 到来時** Agent 由来 tool_use の task_id が解決される」であり、backfill は条件外。

将来的に `cmux-team` admin CLI として `cmux-team trace-backfill --since ...` 形式で別タスク化する余地はあるが、本タスクスコープでは扱わない。本判断は plan.md の本節と CTE 拡張時の SQL コメントに残す。

## 7. 想定される副作用・既存テストへの影響

| 観点 | 評価 |
|---|---|
| 既存 `metrics-aggregate.test.ts` (3 テスト + 1 重複セッション) | **green のまま**。`agent_spawned` 行を持たないフィクスチャなので CTE 拡張の影響なし。 |
| 既存 `metrics-aggregate.test.ts:324` "session_id 重複で二重カウントされない" | **green のまま**。assigned 同士の重複 / `MIN(task_id)` 集約は維持。 |
| 既存 `trace-store.test.ts:270` "base_* 未指定時は NULL" (`event: 'agent_spawned'`) | **green のまま**。session_id="" の挿入を直接 expect していないので CTE 拡張の影響なし。 |
| `getSessionsForTask` / `getTaskSessions` | UPDATE で `session_id` が変わるが、これらは event/task_id ベースで取り出すので意味的破壊なし。むしろ trace 詳細表示で「Agent の session_id が見える」改善になる。 |
| Conductor の SESSION_STARTED ハンドラ (1779-1812) | 触らない。`updateTaskSessionId` は引き続き Conductor 用の経路として残る。 |
| `agent_spawned` 行が複数になる場合（resume 等） | helper の WHERE で `surface` 単位に絞るので、同 surface に複数 `agent_spawned` 行があれば全行が同じ session_id で埋まる。Agent surface に同時に 2 つ以上の Agent が紐づくことはないため安全。 |
| Bun test 実行時間 | 追加テスト 4 〜 5 件、各 < 50ms 想定。既知のハング条件には該当しない（CLAUDE.md の `bun test` 全体実行禁忌は維持）。 |

リスク:

- `surface` 列で WHERE する以上、`task_sessions.surface` がインデックス無しなら数百〜数千行で線形スキャン。現状 `agent_spawned` 行は数百件オーダー（597 件実測）であり実用上問題なし。将来肥大化する場合は `(event, surface)` 複合 index を追加する別タスクで対応。

## 8. TDD のステップ順序

順序は **trace-store 層 → daemon 層 → e2e** で 1 関数ずつ。各ステップで red → green を確認、別ステップに混ぜない。

### Step 1: helper 単体（trace-store 層）

1. `trace-store.test.ts` に `describe("updateAgentSpawnedSessionId (T406)")` を追加し全ケース失敗を確認 (Red)
2. `trace-store.ts` に `updateAgentSpawnedSessionId` を実装 (Green)
3. `bun test --timeout 30000 skills/cmux-team/manager/trace-store.test.ts` 単体 green

### Step 2: CTE 拡張（trace-store 層）

1. `trace-store.test.ts` に「3 関数が `agent_spawned` 経由で task_id 解決する」テストを追加 → Red（既存 CTE では task_id=NULL になる）
2. `countToolCallsByTask` / `firstEditPerTask` / `failureRateByTask` の CTE 3 箇所を `event IN ('assigned','agent_spawned')` + `session_id != ''` に拡張 (Green)
3. `bun test --timeout 30000 skills/cmux-team/manager/trace-store.test.ts` 単体 green

### Step 3: daemon 統合（daemon 層）

1. `daemon.test.ts` に「Agent SESSION_STARTED で agent_spawned 行が UPDATE される」テストを追加 → Red
2. `daemon.ts` の Agent SESSION_STARTED ハンドラに `updateAgentSpawnedSessionId` 呼び出しを追加 (Green)
3. `bun test --timeout 30000 skills/cmux-team/manager/daemon.test.ts` 単体 green

### Step 4: e2e（metrics-aggregate）

1. `metrics-aggregate.test.ts` に「Agent 由来 tool_use 合算」テストを追加。Step 2 / 3 が完了していれば最初から Green（後付けで保護網として機能）
2. `bun test --timeout 30000 skills/cmux-team/manager/metrics-aggregate.test.ts` 単体 green

### Step 5: 関連テストの一括確認

CLAUDE.md の禁忌（`bun test` 全体実行）に従い、影響範囲のファイルのみ順次実行:

```bash
cd skills/cmux-team/manager
for f in trace-store.test.ts trace-store-metrics.test.ts trace-store-projection.test.ts \
         metrics-aggregate.test.ts metrics-snapshot.test.ts metrics-cli.test.ts \
         metrics-stats.test.ts metrics-compare.test.ts metrics-e2e.test.ts metrics-health.test.ts \
         daemon.test.ts main.test.ts; do
  bun test --timeout 30000 "$f"
done
```

全 green を確認した後にコミット。

### コミット粒度

- commit 1: `feat(trace-store): add updateAgentSpawnedSessionId helper (T406)`
- commit 2: `fix(trace-store): include agent_spawned in session_to_task CTE (T406)`
- commit 3: `fix(daemon): backfill agent_spawned session_id on SESSION_STARTED (T406)`
- commit 4: `test(metrics): cover Agent-originated tool_use in aggregateMetricsByTask (T406)`

各 commit が独立に red→green を経るので、`git bisect` も効く。

## 受け入れ条件チェックリスト

- [ ] 新規 hook 到来時、Agent 由来 tool_use の task_id が `countToolCallsByTask` で解決される（Step 2 + Step 3 + Step 4 のテストで担保）
- [ ] `task_sessions` の `agent_spawned` 行に session_id が必ず埋まる（Step 3 のテストで担保）
- [ ] 既存 3 関数のテストが Agent 由来フィクスチャを含み green（Step 2 のテストで担保）
- [ ] backfill しない判断と理由を明記（本 plan.md §6）
