# T277 実装計画書

## 1. 背景

T276 run #1（task-276-1776673135）で、daemon 自身が送った `/clear` 由来の `SESSION_IDLE` が `SESSION_CLEAR` より先着したことで、`daemon.ts:1937-1955` の **T232 R1 分岐** が `assigning → running` に遷移。直後に届いた `SESSION_CLEAR` が `running` 状態の user_clear handler（`daemon.ts:2119`）に落ち、task_id=276 が `reason=user_clear` で誤 abort された。R1 は本来「`SESSION_STARTED` が逆順遅着する race の保険」だったが、逆向きの race（`SESSION_IDLE` が `SESSION_CLEAR` より先着し window を早閉めする）を生み出していた。本タスクではこの R1 分岐を撤去し、assigning window の close を既存 3 経路（`SESSION_STARTED source=clear` / `SESSION_CLEAR` / timeout）に一本化する。

## 2. スコープ

### 変更する

- `skills/cmux-team/manager/daemon.ts` — `SESSION_IDLE` handler の R1 分岐（`conductor.status === "assigning" && conductor.taskRunId` 条件ブロック）を削除
- `skills/cmux-team/manager/daemon.test.ts` — R1 経路をカバーする既存 test の修正（新仕様：R1 発火しない）
- `skills/cmux-team/manager/schema.ts` / `daemon.ts` / `conductor.ts` — `sessionIdleAtInAssigning` フィールドの参照箇所
- `.team/artifacts/A014-conductor-state-machine.md` — R1 経路の記述（row 7 の削除または「撤去済み」注記、および Mermaid 図 L253-286 の更新）

### 変更しない

- `SESSION_STARTED source=clear` 正規経路（`daemon.ts:1455-1472`）— T232 メイン経路、そのまま維持
- `SESSION_CLEAR` の `assigning` 早期 break 経路（`daemon.ts:2079-2092`）— T232 の早期 break、そのまま維持
- `monitorConductors` の assigning timeout 経路（`daemon.ts:2778-2798`）— via=timeout fallback、そのまま維持
- `disconnected/starting/running → idle` などの SESSION_IDLE 他分岐（R1 分岐以外）— 影響なし
- `formatUserClearDecision` の `session_idle_at=...` 表示（`daemon.ts:236`）— フィールド撤去可否により変動（下記 §3 参照）
- **SESSION_ACTIVE 側 R1 経路（`daemon.ts:1825-1833`）は現状維持**
  - 理由 1: `generateConductorSettings`（`main.ts:1757-`）の Claude Code hook には SESSION_ACTIVE を送信する hook が定義されていない（SessionStart / Stop / SessionEnd / Notification のみ）
  - 理由 2: `cmux-team send SESSION_ACTIVE` CLI（`main.ts:1042, 1138`）からのみ発火可能で、運用フロー上は daemon が送ることはない
  - 結論: T276 と同種の race（SESSION_ACTIVE 先着 → R1 → user_clear 誤 abort）は理論上成立するが、現行 hook 設定では実害が極めて低い。T277 では SESSION_IDLE R1 のみ撤去し、SESSION_ACTIVE R1 は後日別タスクで扱う（撤去するなら同じ構造で対応可能）
  - 既存 test `daemon.test.ts:2360-2381`（SESSION_ACTIVE R1）は **そのまま pass する前提**

## 3. 変更方針

### 3.1 R1 分岐（SESSION_IDLE 側のみ）は **完全削除**（no-op 化ではなく）

理由:
- no-op 化（`else if` ブロックを残したまま body を空にする）はデッドコードを残し、意図が読めなくなる
- R1 は元々「SESSION_STARTED の逆順遅着保険」として追加されたが、逆向きの race を生む副作用の方が大きい。維持する意義はない
- `SESSION_STARTED` が本当に永遠に来ないケースは既存の `ASSIGNING_TIMEOUT_SEC` → `disconnected` → `DISCONNECT_TIMEOUT_SEC` → `forceCloseDisconnectedConductor` の 2 段 timeout が fallback として機能する

### 3.2 `sessionIdleAtInAssigning` フィールドは **削除する**

理由:
- R1 分岐でしか書き込まれないフィールド（`conductor.ts:650` の reset でクリアされるだけ）
- R1 を撤去すれば書き込み元が消え、永続的に `undefined` になる dead field になる
- `formatUserClearDecision` の `session_idle_at=${conductor.sessionIdleAtInAssigning ?? "null"}` は常に `null` を出力するだけになるため、併せて削除してログ行を短くする
- schema の `sessionIdleAtInAssigning` 定義、conductor.ts の reset 代入、daemon.ts のコメントも連動削除

> **一緒に削除する理由（補足）**: T232/T261 関連の snapshot ログに影響するが、R1 の観測用フィールドなので R1 撤去と同時に消す方が整合的。残すと「R1 撤去の経緯」を知らないと誤解を生む。

### 3.3 `session_idle` ログ（assigning prev_status の場合）は残す

- `daemon.ts:1960-1963` の `session_idle` ログ（`session_idle_source_guess=${sourceGuess}` 付き）は **維持**
- assigning 中の SESSION_IDLE は「何もしない（status 変更なし）」で `session_idle` ログのみ残る挙動に変わる
- `guessSessionIdleSource` の `prev_status=assigning + clearSentAt 差分 <5000ms → clear_transient` 判定は引き続き有効で、事後解析に使える

## 4. 変更対象ファイルと箇所

### 4.1 `skills/cmux-team/manager/daemon.ts`

| 箇所 | 変更内容 |
|------|---------|
| L1937-1955（R1 分岐本体） | `else if (conductor.status === "assigning" && conductor.taskRunId) { ... }` ブロックを削除 |
| L236（formatUserClearDecision） | `session_idle_at=${conductor.sessionIdleAtInAssigning ?? "null"}` の行を削除 |
| L923 付近（コメント） | `sessionIdleAtInAssigning: ...` を列挙しているコメントから該当行を削除 |
| L1825-1833（SESSION_ACTIVE R1） | **変更なし**（§2「変更しない」参照。現行 hook 設定で発火しないため現状維持） |

### 4.2 `skills/cmux-team/manager/schema.ts`

| 箇所 | 変更内容 |
|------|---------|
| L250（コメント） | `sessionIdleAtInAssigning: SESSION_IDLE R1 保険経路で ...` 行を削除 |
| L255（schema 定義） | `sessionIdleAtInAssigning: z.string().datetime().optional(),` を削除 |

### 4.3 `skills/cmux-team/manager/conductor.ts`

| 箇所 | 変更内容 |
|------|---------|
| L507-508（コメント） | 現状: `// 保険経路として SESSION_IDLE / SESSION_ACTIVE でも assigning→running へ遷移させる` `// （daemon.ts 側）。60 秒経過で disconnected に倒す timeout もある。` → **SESSION_IDLE を除いた記述に修正**: `// 保険経路として SESSION_ACTIVE でも assigning→running へ遷移させる（daemon.ts 側、現行 hook では発火せず CLI 経由のみ）。` `// 60 秒経過で disconnected に倒す timeout もある。` |
| L650 | `conductor.sessionIdleAtInAssigning = undefined;` 行を削除 |

### 4.4 `skills/cmux-team/manager/daemon.test.ts`

| 箇所 | 変更内容 |
|------|---------|
| **L2337-2358** `test("R1: assigning + SESSION_IDLE(taskRunId あり) で running に遷移する")` | **削除し、新仕様 test に置き換える**（§5 Red 参照）。既存 describe `handleMessage: assigning → running 遷移 (T232)` の中に、新仕様「SESSION_IDLE では running に遷移しない」を検証する test を L2337 の位置に配置する。既存 assertion `expect(conductor.status).toBe("running")` は新仕様下で fail するため、新 test に置き換わる形で確実に削除する |
| L2360-2381 `test("R1: assigning + SESSION_ACTIVE(taskRunId あり) で running に遷移する")` | **変更なし**（§2「変更しない」参照。SESSION_ACTIVE R1 は残すためそのまま pass） |
| L3909-3938 `test("SESSION_IDLE(R1: assigning+taskRunId) で ...")` | 削除（L2337 置換と重複するため）または新仕様 test を一つに集約。実装段階で整理 |
| L4052-4102 `test("clearSentAt は team.json に書き出され ...")` | `sessionIdleAtInAssigning` に関する assertion（L4071, L4087, L4101）を削除。残り 3 フィールド（promptSentAt / promptBytes / sessionStartedClearAt）の永続化対象外 assertion はそのまま維持 |

### 4.5 `.team/artifacts/A014-conductor-state-machine.md`

| 箇所 | 変更内容 |
|------|---------|
| L28 付近（本文の R1 説明） | 「`SESSION_IDLE / SESSION_ACTIVE` のいずれか」から `SESSION_IDLE` を外し、「`SESSION_STARTED(source=clear)` または `SESSION_ACTIVE`」等に修正（SESSION_ACTIVE は現行 hook 発火なしの注記を付与） |
| L61 row 7（`assigning → running via SESSION_IDLE`） | 行を削除または「T277 で撤去」の取消線付き注記 |
| **L253-286 Mermaid 図（stateDiagram-v2）** | L266 `assigning --> running : SESSION_STARTED(source=clear) / ACTIVE / IDLE (taskRunId 有)` から `IDLE` を外して `SESSION_STARTED(source=clear) / ACTIVE (taskRunId 有)` に修正。row 7 削除と整合させ、図と表の乖離を防ぐ |

> A014 更新は運用アーティファクトなので、本タスクの主目的ではないが cascade 影響範囲として明示する。Mermaid 図と本文の両方を同時更新し、row 7 撤去と図の記述が一致する状態にする。

### 4.6 docs/spec/ および CLAUDE.md

- grep 結果: R1 / sessionIdleAtInAssigning / T232 / T261 への言及なし
- **変更不要**

## 5. 実装ステップ（TDD）

### Red: 新仕様の test を追加 / 既存 R1 test を削除

既存の `describe("handleMessage: assigning → running 遷移 (T232)")` 内 L2337-2358 を削除し、新仕様 test に置き換える:

```ts
test("SESSION_IDLE(assigning+taskRunId) で R1 は発火しない — status は assigning のまま (T277)", async () => {
  const state = await createDaemon(testDir);
  const conductor: ConductorState = {
    surface: "surface:277a",
    startedAt: new Date().toISOString(),
    agents: [],
    status: "assigning",
    taskRunId: "task-277-a",
    taskId: "277a",
  };
  state.conductors.set(conductor.surface, conductor);

  await handleMessage(state, {
    type: "SESSION_IDLE",
    surface: conductor.surface,
    pid: 77701,
    timestamp: new Date().toISOString(),
  });

  // status は assigning のまま（R1 発火しない）
  expect(conductor.status).toBe("assigning");
  // session_idle ログは出る（観測用）
  const logContent = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
  expect(logContent).toMatch(/session_idle C\[277a\]/);
  // assigning_window_close via=SESSION_IDLE は出ない
  expect(logContent).not.toMatch(/assigning_window_close C\[277a\] via=SESSION_IDLE/);
  // conductor_running via=SESSION_IDLE も出ない
  expect(logContent).not.toMatch(/conductor_running C\[277a\] via=SESSION_IDLE/);
});
```

続けて T276 race 再現 regression test を追加（`promptSentAt` を設定して T276 事例を忠実再現）:

```ts
test("daemon /clear 由来 SESSION_IDLE が SESSION_CLEAR より先着しても task が abort されない (T277 regression)", async () => {
  const state = await createDaemon(testDir);
  const clearSentAt  = "2026-04-20T17:18:58.000Z";
  const promptSentAt = "2026-04-20T17:18:58.200Z"; // clearSentAt + 200ms（T276 事例を忠実再現）
  const idleAt       = "2026-04-20T17:19:00.000Z"; // clearSentAt + 2s → source_guess=clear_transient
  const clearAt      = "2026-04-20T17:19:01.000Z";
  const startedAt    = "2026-04-20T17:19:03.000Z";

  const conductor: ConductorState = {
    surface: "surface:277b",
    startedAt: "2026-04-20T17:18:57.000Z",
    agents: [],
    status: "assigning",
    taskRunId: "task-277-b",
    taskId: "277b",
    clearSentAt,
    promptSentAt,
  };
  state.conductors.set(conductor.surface, conductor);

  // ① SESSION_IDLE 先着（R1 が発火しない → assigning 維持）
  await handleMessage(state, { type: "SESSION_IDLE", surface: conductor.surface, pid: 77702, timestamp: idleAt });
  expect(conductor.status).toBe("assigning");

  // ② SESSION_CLEAR 後着（status=assigning なので daemon_assign_clear で早期 break）
  await handleMessage(state, { type: "SESSION_CLEAR", surface: conductor.surface, pid: 77702, timestamp: clearAt });
  expect(conductor.status).toBe("assigning"); // まだ assigning のまま

  // ③ SESSION_STARTED(source=clear) で正規経路 → running
  await handleMessage(state, { type: "SESSION_STARTED", surface: conductor.surface, pid: 77702, source: "clear", timestamp: startedAt });
  expect(conductor.status).toBe("running");

  // task_aborted reason=user_clear が出ていないこと
  const logContent = await readFile(join(testDir, ".team/logs/manager.log"), "utf-8");
  expect(logContent).not.toMatch(/task_aborted.*reason=user_clear/);
  expect(logContent).toMatch(/session_clear_expected .*reason=daemon_assign_clear/);
  // source_guess=clear_transient が記録される（T276 事例の忠実再現を assertion で担保）
  expect(logContent).toMatch(/session_idle_source_guess=clear_transient/);
});
```

### Green: R1 分岐と `sessionIdleAtInAssigning` フィールドを削除

- §4.1-§4.4 の削除・修正を実施
- 既存 T232 test（SESSION_STARTED 経路 L2306-2334、SESSION_ACTIVE R1 L2360-2381）と T261 timeout test（L3940-3962）が pass することを確認

### Refactor: ログ表現の整理

- `session_idle_at=...` snapshot フィールド削除に伴い、`user_clear_decision_snapshot` ログ 1 行が短くなる
- 関連コメント（`//   - sessionIdleAtInAssigning: ...` 等）を削除

## 6. 検証観点（タスク本文「検証」の 4 項目を test で担保）

| タスク本文の検証項目 | 担保する test |
|-------------------|-------------|
| ① T276 と同様の race（daemon /clear 後 SESSION_IDLE が SESSION_CLEAR より先着）を再現し、abort されない | §5 Red 新 test 2 件目（regression test、`source_guess=clear_transient` を assertion に含む） |
| ② SESSION_STARTED source=clear が正常到達するケースで window close が動作 | 既存 L3871-3907 test（変更なし、そのまま pass） |
| ③ SESSION_STARTED が永遠に来ないケースで timeout 経路が disconnected に倒す | 既存 L3940-3962 test（変更なし、そのまま pass） |
| ④ 既存の T232 / T261 関連 test が pass | §4.4 修正後の全 test suite、および T263 以降の test に影響なし。SESSION_ACTIVE R1 test（L2360-2381）もそのまま pass |

## 7. 後方互換性の確認

### 破壊的変更

- **`ConductorState.sessionIdleAtInAssigning` フィールドの撤去**: ランタイム限定フィールドで team.json に永続化されないため、daemon 再起動後の互換性問題は発生しない
- **`user_clear_decision_snapshot` ログの列減少**: `session_idle_at=` フィールドが消える。ログ grep する運用スクリプトがあれば影響あり（repo 内には該当なし）
- **`assigning_window_close via=SESSION_IDLE` / `conductor_running via=SESSION_IDLE(taskRunId=)` ログが出なくなる**: 監視・アラート設定で該当ログを待っているものがあれば影響あり

### 壊れない挙動

- T232 メイン経路（`SESSION_STARTED source=clear` → running）: 変更なし
- T232 SESSION_CLEAR 早期 break（daemon_assign_clear）: 変更なし
- T232 R1 SESSION_ACTIVE 経路（`daemon.ts:1825-1833`）: 変更なし（§2「変更しない」）
- T261 `user_clear_decision_snapshot` 出力（`session_idle_at` 以外のフィールド）: 変更なし
- disconnected/starting/running 分岐の SESSION_IDLE 挙動: 変更なし
- Agent surface の SESSION_IDLE（`agent_done`）: 変更なし

### 実装直前の最終確認チェックリスト

Green 開始直前に以下を実行し、撤去対象の参照が残っていないことを再確認する:

```bash
# sessionIdleAtInAssigning が schema / daemon / conductor / test の 4 ファイル以外に残っていないか
git grep -n "sessionIdleAtInAssigning"

# session_idle_at= ログ文字列の参照箇所
# 期待: daemon.ts:236（削除対象）と daemon.test.ts の regex wildcard 内（`.*` で吸収）以外に該当なし
git grep -n "session_idle_at="

# SESSION_IDLE R1 関連ログ pattern が残っていないか
git grep -n "assigning_window_close.*SESSION_IDLE"
git grep -n "conductor_running.*via=SESSION_IDLE"
```

## 8. リスクと緩和策

| # | リスク | 影響度 | 緩和策 |
|---|-------|------|------|
| 1 | `SESSION_STARTED source=clear` が本当に欠落するケース（Claude Code hook の漏れ等）で、R1 保険がなくなると assigning 状態で stuck する | 中 | 既存の `ASSIGNING_TIMEOUT_SEC`（60s）→ disconnected → `DISCONNECT_TIMEOUT_SEC`（300s）→ forced close が fallback。Conductor 単位で timeout 発動する設計なので T277 撤去後も安全側に倒れる |
| 2 | 削除した R1 test が他 test の fixture や setup に依存している場合の影響 | 低 | §4.4 で該当箇所（L2337-2358, L3909-3938, L4071/4087/4101）を明示。describe ブロックは残し、test 単位で置き換え／削除する |
| 3 | A014 の state machine 表・本文・Mermaid 図と実装の乖離が残る | 低 | §4.5 で row 7 / L28 / Mermaid L253-286 を同時更新する方針を明示 |
| 4 | `formatUserClearDecision` の列削減でログ解析ツールが壊れる | 低 | ログは debug 用途で外部システム連携なし。列順は key=value 形式なので key 欠落に耐性あり |
| 5 | 新 regression test が fragile（タイムスタンプ依存） | 低 | ISO 8601 固定値 + `handleMessage` 直呼びで時刻を完全制御。monitorConductors を呼ばないため flaky にならない |
| 6 | SESSION_ACTIVE R1 を残したことで将来同種の事故が起きる | 低 | 現行 hook では発火しない（CLI 経由のみ）。将来 hook に SESSION_ACTIVE を追加する際は同時に R1 撤去を検討する運用メモを A014 に残す |

## 9. 完了条件

- [ ] `daemon.ts:1937-1955` の SESSION_IDLE R1 分岐削除
- [ ] `daemon.ts:1825-1833` の SESSION_ACTIVE R1 分岐は **変更なし**（§2「変更しない」）
- [ ] `schema.ts` の `sessionIdleAtInAssigning` フィールド削除
- [ ] `conductor.ts:507-508` のコメントから SESSION_IDLE 記述を除外
- [ ] `conductor.ts:650` の `sessionIdleAtInAssigning = undefined` 削除
- [ ] `daemon.ts:formatUserClearDecision` の `session_idle_at=` 列削除
- [ ] `daemon.test.ts:2337-2358` の既存 R1 SESSION_IDLE test を新仕様 test に置き換え
- [ ] `daemon.test.ts:2360-2381` の SESSION_ACTIVE R1 test は変更なしで pass
- [ ] `daemon.test.ts:3909-3938` の R1 test 整理（新仕様 test と重複するなら削除）
- [ ] T276 race 再現 regression test 追加（`promptSentAt` 設定で `source_guess=clear_transient` を assertion）
- [ ] 永続化 test（L4052-4102）から `sessionIdleAtInAssigning` assertion 削除
- [ ] `bun test` 全 pass
- [ ] `.team/artifacts/A014-conductor-state-machine.md` の row 7 / L28 / Mermaid L253-286 を更新
- [ ] §7 末尾の git grep チェックリストを Green 開始直前に実行し、想定外の参照が残っていないことを確認
