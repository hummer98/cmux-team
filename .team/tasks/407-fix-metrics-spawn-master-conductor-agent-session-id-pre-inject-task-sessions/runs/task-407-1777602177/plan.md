# T407 実装計画書 (Rev 2): spawn (Conductor/Agent) で session_id pre-inject

## 概要

Conductor / Agent の新規セッション起動時に Manager 側で UUID v4 を発行し、`claude --session-id <UUID>` を渡す。
事前発行 UUID を CONDUCTOR_REGISTERED / AGENT_SPAWNED 経路で daemon に同梱通知し、`task_sessions` の起動行 (`event=assigned` / `event=agent_spawned`) に **空でない** UUID を書き込む。
trace-store の `WITH session_to_task` CTE を `event IN ('assigned','agent_spawned')` に拡張しつつ `session_id != ''` 防御を加え、Agent 由来 tool_use の `task_id` 解決経路を回復させる。
`task_sessions` は append-only に保ち、/clear / /compact 後の追従は task-state.json の sessionId 更新のみで吸収する。

## 改訂履歴 (Rev 1 → Rev 2)

- **C1 採用方針 A**: Master を本タスク scope から外す。`cmdLaunchMaster` の UUID pre-inject、`MasterRegisteredMessage` への sessionId 追加、影響表の Master 行をすべて削除。受け入れ条件 1 を `(Conductor/Agent)` に縮小。
- **C2 採用**: trace-store の 3 関数 CTE / JOIN に `session_id IS NOT NULL AND session_id != ''` 防御を追加。空 session_id 行が過去の Agent 起動に誤マッチする regression を防ぐための fixture を Step 2 に明記。
- **C3 採用**: daemon の CONDUCTOR_REGISTERED / AGENT_SPAWNED ハンドラで sessionId を採用するのは `state.sessionId` が未設定のときのみに限定。後着 `*_REGISTERED` で hook 確定済 sessionId を巻き戻さない。後着 mismatch ケース (`session_id_mismatch_at_register_late`) を warn ログ対象に追加し、対応する test (T-12) を新設。
- **C4 採用方針 A**: `task_sessions` は append-only を維持。`updateTaskSessionLatest` 経路は導入しない。/clear / /compact 後の追従は task-state.json の sessionId 更新のみで完結させる (既存 T203 経路)。/clear 後 hook が新 UUID を払い出した場合の `task_sessions` 行追加可否は本タスクのスコープ外として明記し、別タスク化候補として残す。
- **R1〜R6 反映**: 重複検出テスト (Step 2)、source=undefined の挙動明記 (Step 7)、`--resume` 確認のスコープ外明記、受け入れ条件 1 の文言修正、token-pool prefix の test 並列性明記 (Step 6)、metrics-cli e2e fixture の具体化 (Step 9)。

## 影響を受けるファイル一覧

| ファイル | 現状 | 変更後 |
|---|---|---|
| `skills/cmux-team/manager/main.ts` (~L2467 `cmdConductor`) | claude を `--session-id` 無しで exec | UUID 発行 → `--session-id` flag 追加 → `registerSelf("conductor", surface, sessionId)` に渡す |
| `skills/cmux-team/manager/main.ts` (~L2710 `cmdSpawnAgent`) | `claudeCmd` に `--session-id` 無し。L3068 で `insertTaskSession({ session_id: "" })` ハードコード | UUID 発行 → `claudeCmd` に `--session-id <UUID>` 追加 → AGENT_SPAWNED POST に sessionId 同梱 → `insertTaskSession({ session_id: uuid, event: "agent_spawned" })` |
| `skills/cmux-team/manager/main.ts` (`cmdResume` ~L2555) | `claude --resume <id>` で再開 | 変更なし (`--resume` 経路で `--session-id` は付与しない) |
| `skills/cmux-team/manager/main.ts` (`registerSelf` ~L1642) | POST body は `{type, surface, timestamp}` のみ | optional `sessionId` を受け取り body に含める (Conductor 経路でのみ呼び出される) |
| `skills/cmux-team/manager/schema.ts` | `ConductorRegisteredMessage` / `AgentSpawnedMessage` に `sessionId` 無し | 両メッセージに `sessionId: z.string().optional()` 追加 (`MasterRegisteredMessage` は触らない) |
| `skills/cmux-team/manager/daemon.ts` (`CONDUCTOR_REGISTERED` / `AGENT_SPAWNED` ハンドラ) | message.sessionId を見ない。state.sessionId は SESSION_STARTED 受信まで undefined | `if (message.sessionId && !state.sessionId) state.sessionId = message.sessionId` を実装。既存値があり pre-inject UUID と異なる場合は warn (`session_id_mismatch_at_register_late`) を出して採用しない |
| `skills/cmux-team/manager/daemon.ts` (`SESSION_STARTED` ハンドラ ~L1673) | T203 の `updateTaskSessionId` 経路で task-state.json を update | `source === "startup"` 時に `prevSessionId === spawnedSessionId` を比較し、不一致なら warn (`session_id_mismatch_at_startup`) 出力後 hook 側で上書き。`source === undefined` は warn 無しで上書き (legacy 互換)。`task_sessions` テーブルは update しない |
| `skills/cmux-team/manager/main.ts` (L3993, L4491 `closed`/`aborted` 行 insert) | `session_id: conductor?.sessionId ?? ""` | 変更なし (in-memory state.sessionId が pre-inject により最初から空にならない) |
| `skills/cmux-team/manager/conductor.ts` (`assignTask` L546-558) | `session_id: conductor.sessionId ?? ""` | 変更なし (pre-inject 後は CONDUCTOR_REGISTERED 経路で state.sessionId が設定済み) |
| `skills/cmux-team/manager/trace-store.ts` (`countToolCallsByTask` / `firstEditPerTask` / `failureRateByTask`) | CTE: `WHERE event = 'assigned' AND task_id IS NOT NULL` | CTE: `WHERE event IN ('assigned','agent_spawned') AND task_id IS NOT NULL AND session_id IS NOT NULL AND session_id != ''`。さらに `LEFT JOIN session_to_task s2t ON h.session_id = s2t.session_id AND h.session_id != ''` で hook 側にも防御を追加 |
| `skills/cmux-team/manager/main.test.ts` / `daemon.test.ts` / `trace-store.test.ts` / `metrics-cli.test.ts` | UUID pre-inject の test 無し | 後述テスト計画通り追加 |
| `docs/spec/04-templates.md` / `docs/spec/11-metrics.md` / `CLAUDE.md` 該当箇所 | session_id を SessionStart hook で生成する説明のみ | pre-inject + hook update の両用に修正 (Conductor / Agent のみ。Master は触れない) |

## 実装ステップ

> TDD: 各ステップ先頭で「失敗するテストを足す → 実装で通す」順に進める。Step 数は 10 (Rev 1 と同じ粒度)。

### Step 1: schema 拡張テスト + 実装

- `schema.test.ts` に `ConductorRegisteredMessage` / `AgentSpawnedMessage` が `sessionId: string` を optional に受け入れる test を追加 (失敗 → 実装後 pass)。
- `schema.ts` の 2 メッセージに `sessionId: z.string().optional()` を追加。
- `MasterRegisteredMessage` は **scope 外** として一切触らない (改訂履歴 C1)。

### Step 2: trace-store の CTE 拡張 (failing → passing) + 防御条件 + 重複検出 fixture

- `trace-store.test.ts` (or 新規 `trace-store-metrics.test.ts`) に以下 fixture を追加:
  1. **(T-5)** agent_spawned 行のみ存在 (assigned 行なし) で `task_id` 解決成功する test (現行コードは fail)。
  2. **(R1) 重複検出**: 同 `task_id=Tn` に対し `(assigned, U_c)` と `(agent_spawned, U_a)` が併存し、hook_signals に `session_id=U_c, U_a` が 1 件ずつ → 結果 `(Tn, n=2)` であることを assert (二重カウントしない)。
  3. **(R1) 異常状態保護**: 同 session_id に複数 task_id が紐づく fixture で MIN(task_id) が決定論的に 1 つ返る assert。
  4. **(C2) 空 session_id 防御**: 空 session_id の `agent_spawned` 行 + 空 session_id の hook_signals を 1 件ずつ混ぜ、それらが集計から除外されることを assert (regression test)。
- `trace-store.ts` の 3 関数 CTE を以下に変更:
  ```sql
  WITH session_to_task AS (
    SELECT session_id, MIN(task_id) AS task_id
    FROM task_sessions
    WHERE event IN ('assigned','agent_spawned')
      AND task_id IS NOT NULL
      AND session_id IS NOT NULL AND session_id != ''
    GROUP BY session_id
  )
  SELECT ...
  FROM hook_signals h
  LEFT JOIN session_to_task s2t
    ON h.session_id = s2t.session_id
    AND h.session_id != ''
  ```
- CTE 直前のコメントを更新し「2 events を採用する根拠 + `session_id != ''` 防御の根拠」を 3-4 行で記載 (空 session_id の過去 backfill 不要分との誤マッチ回避)。

### Step 3: registerSelf に sessionId 同梱 (Conductor の POST 拡張)

- `daemon.test.ts` に以下 test 追加:
  - `CONDUCTOR_REGISTERED` の handler が `message.sessionId` を受けて `conductor.sessionId` にセットする (state.sessionId が未設定のとき)。
  - `state.sessionId` が既存で `message.sessionId` と異なるとき、`session_id_mismatch_at_register_late` warn ログ出力 + state.sessionId 維持 (採用しない)。
  - **(T-12 新設)** SESSION_STARTED → CONDUCTOR_REGISTERED (sessionId 異なる) の順序で state.sessionId が hook 側のまま維持される。
- `registerSelf(role, surface, sessionId?)` に optional 引数を足し、POST body に同梱。Conductor 経路 (`cmdConductor`) のみ sessionId を渡す。
- daemon の CONDUCTOR_REGISTERED ハンドラに以下を実装:
  ```typescript
  if (message.sessionId) {
    if (!state.sessionId) {
      state.sessionId = message.sessionId;
    } else if (state.sessionId !== message.sessionId) {
      logger.warn("session_id_mismatch_at_register_late", { ... });
      // 採用しない
    }
  }
  ```

### Step 4: AGENT_SPAWNED に sessionId 同梱

- `daemon.test.ts` に AGENT_SPAWNED handler が message.sessionId を受けて `agent.sessionId` にセットする test を追加。後着 mismatch ケース (T-12 同等) も AGENT_SPAWNED 経路で確認。
- `daemon.ts` の AGENT_SPAWNED ハンドラ内 `conductor.agents.push({...})` に Step 3 と同じ条件分岐 (`!agent.sessionId` の場合のみ採用、既存と異なる場合は warn) を追加。

### Step 5: cmdConductor で UUID pre-inject

- `main.test.ts` に「`cmux-team conductor` がモック claude exec に `--session-id <UUID>` を渡す」test を追加 (`execFileSync` を spy/モック化)。
  - **(T-11)** UUID 形式が RFC 4122 v4 (`crypto.randomUUID()` 出力) であることのフォーマット assertion。
- `cmdConductor` に `const sessionId = crypto.randomUUID();` を追加し、claudeArgs に `"--session-id", sessionId` を別 arg として並べ、`registerSelf("conductor", surface, sessionId)` に渡す。
- 注意: `cmdResume` には `--session-id` を渡さない (`--resume` 経路はそのまま)。
- `cmdLaunchMaster` は **触らない** (改訂履歴 C1)。

### Step 6: cmdSpawnAgent で UUID pre-inject + AGENT_SPAWNED の sessionId 同梱 + insert UUID

- `main.test.ts` に以下 fixture を追加:
  1. **(T-1)** `cmdSpawnAgent` が `claudeCmd` に `--session-id <UUID>` を含み、AGENT_SPAWNED POST と `insertTaskSession` の session_id に同 UUID を渡す test (`cmux.send` / `postMessage` を spy)。
  2. **(R5) token-pool prefix 並列性**: `tokenInjected=true` (inline env prefix あり) と `tokenInjected=false` (prefix なし) の 2 fixture でいずれも `--session-id` が claude binary 引数として正しく付与されることを assert。
- `cmdSpawnAgent` に `const sessionId = crypto.randomUUID();` を追加し:
  - `claudeFlags.push("--session-id", sessionId)` を別 arg で追加 (token prefix の前)。UUID は v4 のため shell metacharacter は含まれず escape 不要。
  - `postMessage({ type: "AGENT_SPAWNED", ..., sessionId })` に追記。
  - L3068 の `insertTaskSession({ session_id: "" })` を `session_id: sessionId` に置換。

### Step 7: SESSION_STARTED 整合性チェック + warn ログ + source=undefined 動線

- `daemon.test.ts` に以下 fixture を追加:
  1. **(T-8) 一致**: pre-inject UUID == hook の session_id → warn 無し・通常動作。
  2. **(T-9) 不一致**: pre-inject UUID != hook の session_id (source=startup) → `session_id_mismatch_at_startup` warn ログ 1 件 + state.sessionId は hook 側で上書き (hook 信頼方針)。
  3. **(R2) source=undefined** (legacy hook 経路): warn 無しで上書き = legacy 互換動作。
  4. **保険**: state.sessionId が undefined のまま SESSION_STARTED が届いた場合 (POST 順序逆転) は warn 無しで hook 側 UUID を採用。
- `daemon.ts` の SESSION_STARTED ハンドラに以下分岐を追加:
  - `source === "startup"` かつ state.sessionId 既存 && hook 側と異なる → warn + 上書き。
  - `source === "clear"` / `"compact"` / `"resume"` → 既存 T203 経路で state.sessionId 上書き (mismatch 判定なし)。
  - `source === undefined` → warn 無し上書き (legacy)。

### Step 8: task_sessions は append-only 維持 (mutation 経路を入れない)

> Rev 1 の Step 8 (`updateTaskSessionLatest` 経路追加) は **削除**。本タスクでは task_sessions テーブルへの UPDATE 経路を導入しない (改訂履歴 C4)。

- /clear / /compact 後の追従は task-state.json の sessionId 更新のみ (既存 T203 経路) で完結。
- pre-inject により agent_spawned / assigned 行は最初から正しい UUID で書かれるので、本タスク目的 (Agent 由来 tool_use の task_id 解決) は達成済み。
- `task_sessions` テーブルは append-only 不変性を保つため、CTE の `GROUP BY session_id` で複数 session_id を解決可能。`MIN(task_id)` で session_id ごとに 1 task_id へ集約 (R1 で test 済)。
- /clear が起きた後の `task_sessions` 行追加可否は **本タスクスコープ外** として「スコープ外」セクションに明記 (現状 pre-inject UUID で agent_spawned 行が確実に埋まれば本タスク目的は達成。/clear 後の新 UUID を `task_sessions` に追加する設計は別タスクで判断)。

### Step 9: 既存テスト regression + e2e (R6)

- 既存の resume テスト (T203 由来) が引き続き pass することを確認 (T-7 として明記)。
- `metrics-cli.test.ts` に **(R6) e2e fixture** を追加:
  - `agent_spawned` 行 (session_id=非空) + `hook_signals` (PRE_TOOL_USE / POST_TOOL_USE, session_id=同一) + `api_usage` (任意 token) の組合せで、metrics CLI 出力の以下 4 軸すべてが task_id を解決して集計されることを assert:
    1. tool counts (`countToolCallsByTask`)
    2. first edit (`firstEditPerTask`)
    3. failure rate (`failureRateByTask`)
    4. token usage (api_usage 集計)
  - 既存「unattached」表示が新 fixture で 0 件にならないこと (空 session_id 行が混ざる別 fixture で regression を含む) を確認。

### Step 10: ドキュメント追従

- `docs/spec/07-state-machine.md` に Conductor / Agent の pre-inject 経路を反映 (1-2 段落)。Master は触れない。
- `docs/spec/11-metrics.md` に「Agent 由来 tool_use の task_id 解決経路 (CTE 拡張 + `session_id != ''` 防御)」を追記。
- `CLAUDE.md` 該当箇所に pre-inject + hook update の両用挙動を反映。
- `--resume` には `--session-id` を渡さない方針 + `task_sessions` append-only 不変性を明文化。

## 整合性チェックの設計詳細

### 事前発行 UUID の保持先

**結論: in-memory state (daemon 側) に保持する。** 既存の `ConductorState.sessionId` / `AgentState.sessionId` をそのまま使う。

| 保持先候補 | 採否 | 理由 |
|---|---|---|
| **in-memory state** (採用) | ✓ | spawn 時 POST → state.sessionId に格納 → SESSION_STARTED 受信時に同フィールドと比較するだけで済む。daemon 再起動時は state 全体が消えるが、その時点で対象も再 spawn されているので問題にならない |
| `team.json` 直書き | ✗ | (1) team.json は daemon 所有物で並行書き込み race を起こす。(2) 「daemon が書く・他は読む」責務分割を破壊。(3) crash recovery で UUID 復元する要件は本タスクスコープ外 |
| 一時ファイル `.team/spawned-sessions/<surface>` | ✗ | 余計な GC ライフサイクルを増やす |

### POST の流れ (race を扱った版)

```
cmux-team conductor / spawn-agent
    │ 1. crypto.randomUUID() で UUID 発行
    │ 2. claude args に `--session-id <UUID>` 追加
    │ 3. POST {CONDUCTOR_REGISTERED, AGENT_SPAWNED} に sessionId 同梱
    ▼
daemon (CONDUCTOR_REGISTERED / AGENT_SPAWNED ハンドラ)
    │ if (message.sessionId && !state.sessionId) {
    │   state.sessionId = message.sessionId;  ← 「事前発行 UUID」の基準値
    │ } else if (message.sessionId && state.sessionId !== message.sessionId) {
    │   logger.warn("session_id_mismatch_at_register_late", ...);
    │   // 既存 (hook 側) を採用、message.sessionId は採用しない
    │ }
    ▼ (Claude 起動)
SessionStart hook (source=startup) → SESSION_STARTED
    │ if (state.sessionId === undefined) {
    │   state.sessionId = message.sessionId;  // POST 順序逆転の保険、warn なし
    │ } else if (source === "startup" && state.sessionId !== message.sessionId) {
    │   logger.warn("session_id_mismatch_at_startup", ...);
    │   state.sessionId = message.sessionId;  // hook 信頼で上書き
    │ } else if (source === undefined) {
    │   state.sessionId = message.sessionId;  // legacy 互換、warn なし
    │ }
    ▼ (以降の /clear / /compact)
SessionStart hook (source=clear|compact) → SESSION_STARTED
    │ 既存 T203 経路: task-state.json の sessionId update のみ。
    │ task_sessions テーブルは触らない (append-only 維持)。
```

### 整合性チェックの判定対象

| ケース | warn | state.sessionId の扱い |
|---|---|---|
| `*_REGISTERED` 受信時、state.sessionId 未設定 → message.sessionId あり | なし | 採用 (基準値として記録) |
| `*_REGISTERED` 受信時、state.sessionId 既存 && message.sessionId と一致 | なし | 既存維持 |
| `*_REGISTERED` 受信時、state.sessionId 既存 && message.sessionId と異なる | `session_id_mismatch_at_register_late` | **既存維持** (hook 側信頼) |
| SESSION_STARTED `source=startup`、state.sessionId 未設定 | なし | 採用 (POST 順序逆転の保険) |
| SESSION_STARTED `source=startup`、一致 | なし | 既存維持 |
| SESSION_STARTED `source=startup`、不一致 | `session_id_mismatch_at_startup` | hook 側で上書き |
| SESSION_STARTED `source=clear`/`compact`/`resume` | なし | hook 側で上書き (正規動作) |
| SESSION_STARTED `source=undefined` (legacy) | なし | hook 側で上書き |

## テスト計画 (受け入れ条件との対応)

| 受け入れ条件 | 対応テスト |
|---|---|
| 1. spawn 時 task_sessions の `assigned` / `agent_spawned` 行に session_id が空でなく埋まる (Conductor/Agent) | (T-1) `cmdSpawnAgent` が `--session-id <UUID>` で起動し `insertTaskSession({session_id: <UUID>, event: "agent_spawned"})` を呼ぶ。<br>(T-2) `cmdConductor` が `--session-id <UUID>` で claude を起動し CONDUCTOR_REGISTERED に sessionId が乗る。 |
| 2. /clear / /compact 後 SESSION_STARTED で task-state.json の sessionId が新 UUID に追従する (task_sessions は append-only 維持) | (T-4) /clear シナリオ: SESSION_STARTED(source=clear, sessionId=U2) を受信し task-state.json の sessionId が U2 に更新される。`task_sessions` テーブルは UPDATE されないことを assert。 |
| 3. countToolCallsByTask が Agent 由来 tool_use を task_id 解決する | (T-5) fixture: `task_sessions` に `event=agent_spawned, task_id=T123, session_id=U_a` のみ + `hook_signals` に session_id=U_a の PRE_TOOL_USE → 集計結果 `task_id=T123, n=1`。<br>(T-6) `firstEditPerTask` / `failureRateByTask` も Agent 行のみで解決する。 |
| 4. T203 の /clear 後 resume 不能問題が再発しない | (T-7) 既存 resume テスト (main.test.ts / daemon.test.ts) が pass し続けることを CI で確認。 |
| 5. 整合性チェックの warn ログが不一致時のみ | (T-8) 一致: warn 無し。<br>(T-9) `source=startup` 不一致: `session_id_mismatch_at_startup` 1 件 + state.sessionId は hook 側で上書き。<br>(T-12 新設) SESSION_STARTED → CONDUCTOR_REGISTERED (sessionId 異なる) 後着順序で `session_id_mismatch_at_register_late` warn + state.sessionId は hook 側のまま維持される。 |

追加で:

- (T-10) `cmdResume` には `--session-id` が **付かない**ことの test (`--resume <id>` 経路の純度を担保)。
- (T-11) UUID 形式が RFC 4122 v4 (`crypto.randomUUID()` 出力) であることのフォーマット assertion (Step 5 / Step 6 内)。
- (R1) 重複検出 / 異常状態保護 fixture (Step 2)。
- (R5) token-pool prefix 並列 fixture (Step 6, `tokenInjected=true/false` の 2 fixture)。
- (R6) metrics-cli e2e fixture (Step 9, 4 軸集計 + unattached regression)。
- (R2) `source=undefined` legacy 互換 fixture (Step 7)。
- (C2 regression) 空 session_id 行が集計から除外される fixture (Step 2)。

## エッジケース・懸念

### `--resume` 経路

`cmdResume` は既存 session を再開するため `--session-id` を付与しない。`task-state.json.sessionId` から取得した既存 ID を `--resume` に渡すのが現行動作。本タスクで触らない。

`--resume` で Claude が新 UUID を払い出すかは **本タスクスコープ外** (R3)。観測されたら artifact 化して別タスクで対応する。

### 既存 task_sessions 行 (backfill)

スコープ外。fresh hook 到来時から正しく解決される。既存の空 session_id 行は **C2 の `session_id != ''` 防御**により集計対象から自動除外される。CLI 表示で「unattached」として可視化済 (`countToolCallsByTask` の null 行)。本タスク完了後、空 session_id 行の残量が線形減衰することを metrics CLI で確認すれば足りる。

### hook 順序 (POST 順序逆転 race)

- AGENT_SPAWNED は cmdSpawnAgent で Claude 起動より前に POST 済 (T244)。
- CONDUCTOR_REGISTERED は cmdConductor の `registerSelf()` で claude exec より前に POST 済 (T228)。
- **通常順序**: SESSION_STARTED が届いた時点で state.sessionId は pre-inject UUID で埋まっている。
- **逆順序 (queue 詰まり等)**: SESSION_STARTED が先 → state.sessionId に hook 側 UUID 設定 → 後着 `*_REGISTERED` が pre-inject UUID 提示 → C3 修正により採用しない (warn のみ)。これにより hook 側で確定済 sessionId を pre-inject に巻き戻すリスクを排除。
- 後着 mismatch の有無を実機で観測する step は本タスクに含めない (T-12 で構造的に防げているため)。

### UUID 衝突可能性

`crypto.randomUUID()` は v4 (122 bit ランダム)。年間 10^9 spawn でも衝突は 10^-18 オーダー。`--session-id` で同 UUID を意図的に渡しても Claude CLI は同 ID で記録するだけ。defensive な検証は本タスクで加えない (実機で衝突観測されたら別タスク)。

### 子プロセスへの flag 伝播の確実性

- Conductor: `cmdConductor` は `execFileSync("claude", [...])` で flag を直接渡す → 確実。
- Agent: `cmdSpawnAgent` は `cmux.send(surface, claudeCmd + "\n")` でシェルに **文字列**として送る経路。`--session-id <UUID>` を flat join で別 arg として並べる (UUID は v4 のため shell metacharacter 不含、escape 不要)。

### token-pool / inline env prefix との順序

`tokenPrefix` (T371) は `CLAUDE_CODE_OAUTH_TOKEN="$CMUX_CLAUDE_TOKEN"` を claude の前に置く inline env prefix。`--session-id` は claudeFlags の中 (claude binary 引数) なので順序衝突は発生しない。Step 6 で `tokenInjected=true/false` の 2 fixture を持って regression を防ぐ (R5)。

### settings.json 経由の hook 配布

`generateAgentSettings` / `generateConductorSettings` は SessionStart hook で `cmux-team send SESSION_STARTED --from-stdin --surface ${CMUX_SURFACE}` を仕込む (T203)。stdin から `session_id` が届く前提は変わらず、本タスクは hook 設定を **触らない**。

### 背景: `--session-id` フラグの実機確認内容

質問 3 (Reviewer) への回答:

- **(a) 確認済**: `claude --session-id <UUID>` 起動 → SessionStart hook の `session_id` が同 UUID で届く。
- **(b)(c) 本タスクスコープ外**: `/clear` 後の新 UUID 払い出し挙動 / `--resume + --session-id` 同時指定の挙動は本タスクで扱わない。観測されたら artifact 化して別タスクで対応 (R3 と整合)。

## スコープ外 (明記)

- **Master の pre-inject** — `task_sessions` に Master 起動行が存在しないため、pre-inject の効用が in-memory state.sessionId のみで集計に効かない。本タスクから完全除外 (C1 採用方針 A)。Master の sessionId を集計に活かす後続タスクが必要なら別 issue で議論。
- **`task_sessions` テーブルへの UPDATE 経路導入** — append-only 不変性を維持 (C4 採用方針 A)。`updateTaskSessionLatest` は導入しない。
- **/clear 後に新 UUID で `task_sessions` 行を追加するか** — 本タスク範囲では pre-inject により最初の起動行が確実に埋まれば目的達成。/clear 後の hook が新 UUID を払い出す場合の `agent_spawned` / `assigned` 行追加可否は、実機確認結果 (R3 と一括) を踏まえて別タスクで判断。
- **T403 との共通 helper (`resolveTaskIdBySurface`) の切り出し** — issue #48 の別タスクで扱う。
- **既存 DB の backfill** — fresh hook 到来時から正しく解決される。空 session_id 行は C2 の防御で集計から自動除外。
- **issue #48 の tool_uses 派生テーブル本体** — 後続タスク。
- **UUID 衝突に対する defensive 検証** — 実機観測待ち。
- **`--session-id` を `--resume` 経路にも適用するか** — 現状は付けない方針。resume が新 UUID を払い出す挙動が観測されたら別タスクで再評価 (R3)。
- **POST 順序逆転の実例観測** — 構造的に T-12 で防げているため、現行 manager.log の `master_session_started_fallback` 観測有無は本タスクで触らない (Reviewer 質問 4)。

## 完了条件 (再掲)

- 新規 spawn 時、`task_sessions` の **`assigned` / `agent_spawned` 行** に session_id が空でなく埋まる (Conductor/Agent) ✓ (Step 3, 4, 5, 6 で担保) — R4 反映の文言修正
- /clear / /compact 後、SESSION_STARTED で task-state.json の sessionId が新 UUID に追従する (`task_sessions` は append-only 維持) ✓ (Step 7, 8 で担保) — C4 反映
- countToolCallsByTask / firstEditPerTask / failureRateByTask が Agent 由来 tool_use を task_id 解決する ✓ (Step 2 で担保) — C2 反映で空 session_id 行誤マッチも防止
- T203 が解消した /clear 後 resume 不能問題が再発しない ✓ (Step 9 既存テスト pass)
- 整合性チェックの warn ログが不一致時のみ出力される (`session_id_mismatch_at_startup` / `session_id_mismatch_at_register_late` の 2 種、`source=undefined` は warn 無し legacy 互換) ✓ (Step 3, 4, 7 で担保) — C3, R2 反映
