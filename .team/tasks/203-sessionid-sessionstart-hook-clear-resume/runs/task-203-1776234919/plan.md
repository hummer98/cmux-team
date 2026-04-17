# T203 実装計画: sessionId を SessionStart hook 経由で一元化

## 1. 概要

Conductor/Agent の sessionId を **SessionStart hook 入力 JSON 経由** で daemon に届ける方式に一本化する。`cmux-team send --from-stdin` を type 付きで呼べるよう拡張し、Claude Code hook の JSON をそのまま parse して `SESSION_STARTED` メッセージに合成する。cmdConductor の `crypto.randomUUID()` + `CONDUCTOR_SESSION` + `--session-id` 系を全撤去し、Claude 自身が発行する session-id を hook 経由で追従する。これにより `/clear` 後も daemon が常に最新 sessionId を持ち、`cmux-team resume` が破棄済み UUID を指すことがなくなる。

**重要:** 本タスクでは、hook の `matcher` を `startup` から全 source 許容（空文字）に変更することが必須であり、さらに `/clear` 起因の SESSION_STARTED を受信した daemon が task-state.json も同時更新する補足ロジックを入れる（レビュー指摘 C1 / C3 に対応）。

## 2. 設計判断

### 2.1 SessionStart hook 入力 JSON のフィールド名（確定）

Claude Code 公式 docs (code.claude.com/docs/en/hooks) で以下を確認:

```json
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../*.jsonl",
  "cwd": "/Users/...",
  "hook_event_name": "SessionStart",
  "source": "startup",
  "model": "claude-sonnet-4-6",
  "agent_type": "Explore"   // 任意
}
```

`source` の値は `"startup" | "resume" | "clear" | "compact"` の 4 種。本タスクで利用するのは `session_id` と `source` のみ。それ以外のフィールドはログ目的で受信できるが state には入れない。

### 2.2 source フィールドによる条件分岐 — **全 source で追従**

| source | 挙動 |
|--------|------|
| `startup` | 新 sessionId を state に反映（初回起動） |
| `resume` | そのまま反映（hook 入力の session_id は resume 先と同一のはずなので no-op 扱いで安全） |
| `clear` | **本タスクの主目的**。新 sessionId で上書き |
| `compact` | 念のため反映（Claude Code 側で新 session に切り替わる可能性を想定） |

**理由:** daemon は「常に最新の sessionId を持っていたい」だけであり、source でフィルタする意味がない。フィルタは早過ぎる最適化になり、将来の hook 仕様変更でリグレッションを埋め込む可能性がある。`source` はログにそのまま記録する（`session_started source=clear session_id=xxx`）ことで、resume 失敗が再発した際の原因追跡を容易にする。

### 2.2.1 `matcher` の設定（C1 対応）

**Claude Code の SessionStart hook は `matcher` に "startup"/"resume"/"clear"/"compact" のちょうど 1 値を指定する。部分一致もワイルドカードもサポートされない。** したがって現行の `matcher: "startup"` では `/clear`（source=clear）や `/compact` で hook が発火せず、本タスクの根本目的が達成できない。

**方針:** Agent / Conductor どちらの SessionStart hook も `matcher: ""`（空文字＝全 source 許容）に変更する。これは既存の Stop hook (`main.ts:1083`) で動作実績がある表記。代替として 4 entry（startup / resume / clear / compact）に分割することも可能だが、冗長で保守コストが高いため採用しない。

### 2.3 `--from-stdin` 拡張のシグネチャ（C2 対応）

**type 引数の有無でパスを分岐する:**

| 呼び出し形式 | 挙動 |
|------------|------|
| `cmux-team send --from-stdin`（type 省略） | 既存パス。stdin を QueueMessage として Zod validate（T189 SESSION_STOP forwarder が使う） |
| `cmux-team send SESSION_STARTED --from-stdin --surface S --pid P` | 新パス。stdin を Claude Code hook 入力として parse し、引数 (`--surface`, `--pid`) と合成して `SessionStartedMessage` を組み立てる |

**判定ロジック（C2 対応）:**

T189 SESSION_STOP forwarder は `main.ts:1041` で `cmux-team send --from-stdin`（type 引数なし）として呼ばれるため、`process.argv.slice(2) === ["send", "--from-stdin"]` となり `args[1] === "--from-stdin"` が truthy になる。素朴に `if (args[1])` で判定すると新パスに誤って入り、hook JSON でない stdin を Claude Code hook 入力として parse しようとして T189 forwarder が壊れる。

そこで discriminator は **`--` で始まる args[1] を type とみなさない** よう正規化する:

```ts
if (hasFlag("from-stdin")) {
  const raw = await readStdin();
  // C2: args[1] が "--xxx" 系フラグのときは type 未指定とみなす（旧パス）
  const typeArg = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
  if (typeArg) {
    // 新パス: hook JSON として parse し type 別に組み立てる
    message = buildMessageFromHookInput(typeArg, raw, {
      surface: requireArg("surface"),
      pid: Number(requireArg("pid")),
      now,
    });
  } else {
    // 既存パス: stdin を QueueMessage として扱う (T189 互換)
    // 既存の空文字 conductorId 正規化・SESSION_STOP surface チェックはそのまま
    message = QueueMessageSchema.parse(preprocessStdinObject(JSON.parse(raw)));
  }
  await postMessageAndExit(message);
  return;
}
```

**対応 type は初期実装で `SESSION_STARTED` のみ。** 将来必要になれば `SESSION_ENDED` / `SESSION_CLEAR` / `SESSION_STOP` にも拡張できるよう、`buildMessageFromHookInput(type, raw, opts)` を純関数として切り出し、`main` モジュールから export して単体テスト可能にする。未対応 type を渡された場合は明示的に `console.error` + `exit(1)` で fail-fast させる（silent に旧パスへフォールバックしない）。

### 2.4 schema.ts の SessionStartedMessage 拡張

現在の定義 (`schema.ts:39-45`):

```ts
SessionStartedMessage = z.object({
  type: z.literal("SESSION_STARTED"),
  surface: z.string(),
  pid: z.number(),
  sessionId: z.string().optional(),
  timestamp: z.string().datetime(),
});
```

`sessionId` はすでに optional なので **schema 変更は不要**。
観測性のため `source: z.enum(["startup","resume","clear","compact"]).optional()` を追加する。ログに `source=clear` が出ると原因追跡が劇的に楽になる。追加してもメッセージ受信側（daemon）にとっては optional なので後方互換を壊さない。

### 2.5 ConductorSessionMessage 削除と古いメッセージ残存リスク（M1 対応）

**新 CLI から CONDUCTOR_SESSION を送信する経路は物理的に消える**ため、新環境で古いメッセージが daemon に届くことは起こらない（古い CLI と新 daemon が共存するケースのみ該当）。古い CLI が届けた CONDUCTOR_SESSION は schema 削除により Zod `discriminatedUnion` の parse 失敗となり、proxy.ts の `/api/messages` ハンドラ（`proxy.ts:226-233`）で HTTP 400 を返す。現状この catch は silent（ログに残らない）であることは事実として把握しているが、本タスクのスコープ内では **旧送信経路自体が消える** ためこの silent reject が実問題になることはない。

**方針:** schema から `ConductorSessionMessage` を削除して `discriminatedUnion` からも除外する。daemon.ts の `case "CONDUCTOR_SESSION":` は schema 削除と同時に削除するため、TypeScript のコンパイルエラーで漏れを炙り出せる。`.team/queue/incoming/` への file-based queue dispatcher は現状 runtime には存在しない（`rg "queue/incoming|readQueueMessages" skills/cmux-team/manager` は e2e テストのみヒット）ため、物理的にも古いメッセージが残存することはない。

> 任意改善（本タスクスコープ外として最小限のコメントで明記）: `proxy.ts:231` の silent catch に validation 失敗ログを追加すると将来の schema 変更で助けになる。ただし本タスクでは対象外とする。

### 2.6 source=startup の 2 重通知問題

**1 Conductor プロセスにつき startup hook は 1 回のみ発火する**（Claude Code が起動直後に 1 回呼ぶ）。本タスクで matcher を空文字に変更しても発火回数は増えない。複数 Conductor が同時に startup を送るとしても surface が異なるため daemon state は干渉しない。したがって 2 重通知シナリオは実在しない。

## 3. 変更ファイル一覧

| # | ファイル | 変更内容 |
|---|---------|---------|
| 1 | `skills/cmux-team/manager/main.ts:686-716` | `--from-stdin` ハンドラ拡張 (type 引数時に hook 形式として解釈)。**C2 対応の discriminator 正規化を含む** |
| 2 | `skills/cmux-team/manager/main.ts:1071-1080` | Agent SessionStart hook を stdin pipe 方式に変更。**matcher: "startup" → "" に変更 (C1)** |
| 3 | `skills/cmux-team/manager/main.ts:1129-1138` | Conductor SessionStart hook を stdin pipe 方式に変更。**matcher: "startup" → "" に変更 (C1)**。`--conductor-id "$CONDUCTOR_ID"` 引数は schema 対応フィールドが無いため削除 (m2) |
| 4 | `skills/cmux-team/manager/main.ts:1189-1270` (cmdConductor) | `crypto.randomUUID()` 生成・`CONDUCTOR_SESSION` POST・`--session-id` 引数を撤廃 |
| 5 | `skills/cmux-team/manager/main.ts:831-838` | send case の `CONDUCTOR_SESSION` 削除 |
| 6 | `skills/cmux-team/manager/main.ts:845` | Usage 文字列から `CONDUCTOR_SESSION` 削除 |
| 7 | `skills/cmux-team/manager/daemon.ts:742-795` | SESSION_STARTED ハンドラで `conductor.sessionId / agent.sessionId = message.sessionId` 更新を追加。**C3 対応: Conductor が taskId を持つ場合 task-state.json の sessionId も同時更新する**。ログ detail に `session_id=... source=...` を追加 |
| 8 | `skills/cmux-team/manager/daemon.ts:811-827` | `case "CONDUCTOR_SESSION"` ハンドラ削除 |
| 9 | `skills/cmux-team/manager/daemon.ts:1295-1296` | `spawnPidWatcher` 内のコメントを「SessionStart hook で上書き」に書き換え |
| 10 | `skills/cmux-team/manager/schema.ts:39-45` | `SessionStartedMessage` に `source` optional を追加 |
| 11 | `skills/cmux-team/manager/schema.ts:105-110` | `ConductorSessionMessage` 定義削除 |
| 12 | `skills/cmux-team/manager/schema.ts:117-132` | QueueMessage `discriminatedUnion` から除外 |
| 13 | `skills/cmux-team/manager/schema.ts:139` | `ConductorSessionMessage` type export 削除 |
| 14 | `skills/cmux-team/manager/proxy.ts:246-266` | Agent 用 `agent.sessionId = sessionId` state mutation 削除。ヘッダ取得自体は trace 用に残す（変数未使用になれば併せて整理） |
| 15 | `skills/cmux-team/manager/conductor.ts:271, 280` | コメント「CONDUCTOR_SESSION メッセージで後から設定される」→「SessionStart hook で後から設定される」に書き換え |
| 16 | `skills/cmux-team/manager/conductor.ts:470, 557` | 「sessionId は初回起動時に発行済み」コメントを「SessionStart hook で最新値に追従」旨に書き換え |
| 17 | ~~`skills/cmux-team/manager/i18n.ts`~~ | **実 grep で CONDUCTOR_SESSION の参照なし（no-op）** (m1)。作業対象外 |
| 18 | `skills/cmux-team/manager/main.test.ts` | `buildMessageFromHookInput` 単体テスト追加。既存 SessionStart hook regression テストに `matcher === ""` / `--from-stdin` を含むことの assert 追加。**T189 forwarder 互換性回帰テスト（args=[send, --from-stdin] → 旧 QueueMessageSchema パスへ）を追加 (C2)**。**余分な引数が無視されることの buildMessageFromHookInput テスト (m3) を追加** |
| 19 | `skills/cmux-team/manager/daemon.test.ts` | SESSION_STARTED で `conductor.sessionId` / `agent.sessionId` 更新テスト追加。**C3 対応: assigned タスクに対する /clear シミュレーションで task-state.json.sessionId が更新されるテストを追加** |
| 20 | `docs/spec/01-skill-cmux-team.md:70` | **(M2 追加)** CLI メッセージ種別一覧から `CONDUCTOR_SESSION` を削除 |
| 21 | `docs/spec/05-install-and-infrastructure.md:163, 221, 250` | sessionId の記述を新方針に書き換え、メッセージ種別一覧から `CONDUCTOR_SESSION` 削除 |
| 22 | `docs/spec/06-implementation-tasks.md:229, 263` | T132 関連記述を撤回し本タスクを追記 |

### 追加発見 (Read 時に確認した項目)

- **i18n.ts** に `CONDUCTOR_SESSION` の参照なし（`rg 'CONDUCTOR_SESSION' skills/cmux-team/manager/i18n.ts` で 0 件確認済み）。plan #17 は no-op として記録のみ残す
- **docs/spec/01-skill-cmux-team.md:70** の CLI 一覧に `CONDUCTOR_SESSION` が残存（M2 で指摘された項目）
- **docs/spec/05-install-and-infrastructure.md:221** にもメッセージ種別一覧があり `CONDUCTOR_SESSION` が書かれている
- **daemon.test.ts:990-1045** の既存 T195 Agent SESSION_STARTED テストの直後に本タスクの新 describe を追加するのが自然

## 4. 実装ステップ（TDD）

### Step 1: schema 変更とテスト追加（純粋変更）
1. `schema.ts` — `SessionStartedMessage` に `source` optional enum を追加
2. `schema.ts` — `ConductorSessionMessage` を削除、`discriminatedUnion` から除外、type export も削除
3. `bun test` でコンパイル通過確認。既存テストが CONDUCTOR_SESSION に依存していないことを検証（失敗する場合は次 Step で該当箇所を修正）

### Step 2: `buildMessageFromHookInput` を純関数化 + テスト追加（C2 対応含む）

**Red:**
1. `main.test.ts` に `describe("buildMessageFromHookInput")` を追加
   - 正常: `SESSION_STARTED` + `source=startup` を含む hook JSON → `{ type, surface, pid, sessionId, source, timestamp }`
   - `source=clear` の場合も同様に pass される
   - hook JSON に `session_id` が無い場合 → `sessionId: undefined`（後方互換）
   - **余分な引数（`--conductor-id` 等）が渡されても無視されてメッセージに入らない (m3)**
   - hook JSON が無効 → throw
   - 未対応 type → throw
2. `main.test.ts` に **C2 回帰テスト** を追加: `describe("cmdSend --from-stdin discriminator")`
   - `process.argv = ["bun", "main", "send", "--from-stdin"]` で stdin に SESSION_STOP 相当の JSON を流したとき、新パス（hook 解釈）ではなく旧パス（QueueMessageSchema parse）に入ることを検証
   - 具体的には `args[1] === "--from-stdin"` でも `typeArg === undefined` に正規化される点を assert するユニットテスト、または旧パスの動作が維持されることを確認するテストを追加する

**Green:**
3. `main.ts` に `export function buildMessageFromHookInput(type, rawJson, opts)` を実装
4. `cmdSend` の `--from-stdin` 分岐に **`const typeArg = args[1] && !args[1].startsWith("--") ? args[1] : undefined;`** を追加し、typeArg の有無で新パス / 旧パスを切り替える
5. 既存の SESSION_STOP forwarder 経路 (type 無し) のテストが引き続き pass することを確認

### Step 3: daemon SESSION_STARTED で sessionId 更新 + task-state.json 同期更新（C3 対応）

**Red:**
1. `daemon.test.ts` — `describe("SESSION_STARTED で sessionId 更新 (T203)")` を追加
   - Conductor surface に SESSION_STARTED + sessionId=X を送ると `conductor.sessionId === "X"`
   - 2 回目に sessionId=Y を送ると `conductor.sessionId === "Y"` に上書き（/clear シナリオ）
   - sessionId 無しメッセージでは `conductor.sessionId` が既存値のまま（後方互換）
   - Agent 分岐にも同等テスト
2. **C3 対応テスト** を同 describe に追加
   - 事前条件: `loadTaskState` / `saveTaskState` が fake 化可能、あるいは test 用 projectRoot を作成
   - Conductor `c` が `taskId=T999`, `status="running"`, 旧 sessionId `U1` を持つ状態で、`task-state.json[T999] = { status: 'assigned', sessionId: 'U1', ... }`
   - SESSION_STARTED(sessionId=`U2`, source=`clear`) を handleMessage に流す
   - 事後条件: `conductor.sessionId === "U2"` かつ `loadTaskState(root)[T999].sessionId === "U2"`
   - 既存 sessionId と同一の場合は saveTaskState を呼ばない（書き込みノイズを避ける）ことも確認

**Green:**
3. `daemon.ts:742-795` の SESSION_STARTED ハンドラを修正:
   ```ts
   // Conductor 分岐
   const prevSessionId = conductor.sessionId;
   if (message.sessionId) conductor.sessionId = message.sessionId;
   conductor.pid = message.pid;
   conductor.disconnectedAt = undefined;
   notifyStateChanged("daemon.ts:handleMessage:session-started-conductor");
   spawnPidWatcher(state, conductor, message.pid);

   // C3: assigned タスクに対する /clear シミュレーションで task-state.json も同時更新
   if (
     message.sessionId &&
     prevSessionId !== message.sessionId &&
     conductor.taskId
   ) {
     try {
       const ts = await loadTaskState(state.projectRoot);
       const cur = ts[conductor.taskId];
       if (cur && cur.status === "assigned" && cur.sessionId !== message.sessionId) {
         ts[conductor.taskId] = { ...cur, sessionId: message.sessionId };
         await saveTaskState(state.projectRoot, ts);
         await log(
           "task_session_updated",
           `${formatSurface(message.surface, "C")} task_id=${conductor.taskId} session_id=${message.sessionId} source=${message.source ?? "-"}`
         );
       }
     } catch (e: any) {
       await log("error", `task-state update failed on session_started: ${e?.message ?? e}`);
     }
   }

   await log(
     "session_started",
     `${formatSurface(message.surface, "C")} pid=${message.pid} session_id=${message.sessionId ?? "-"} source=${message.source ?? "-"}`
   );
   ```
4. Agent 分岐にも同様に `if (message.sessionId) agent.sessionId = message.sessionId;` を追加し、ログ detail に `session_id=... source=...` を追加する（Agent 側は task-state.json 同期は不要 — assignTask が Conductor に対して記録しているため）
5. `notifyStateChanged` は既存呼び出しを流用

### Step 4: hook コマンドを stdin pipe 方式に変更（C1 対応含む）

**Red:**
1. `main.test.ts` の既存 regression テスト (`既存の SessionStart / Stop / SessionEnd hook が残存している` 系)
   - `settings.hooks.SessionStart[0].matcher === ""` を assert（Agent / Conductor 双方）
   - `settings.hooks.SessionStart[0].hooks[0].command` が `--from-stdin` と `--surface` を含むことを assert
   - Conductor 側の command には不要な `--conductor-id` が **含まれない** ことを assert（m2 対応）

**Green:**
2. `main.ts:1073` (Agent `generateAgentSettings`) の変更:
   - `matcher: "startup"` → `matcher: ""`
   - command を以下に変更:
     ```
     bash -c 'cmux-team send SESSION_STARTED --from-stdin --surface "${surface}" --pid "$PPID" 2>/dev/null || true'
     ```
3. `main.ts:1131` (Conductor `generateConductorSettings`) の変更:
   - `matcher: "startup"` → `matcher: ""`
   - command を以下に変更（`--conductor-id` は削除 — surface で特定可能）:
     ```
     bash -c 'cmux-team send SESSION_STARTED --from-stdin --surface "${CMUX_SURFACE}" --pid "$PPID" 2>/dev/null || true'
     ```
4. Claude Code の hook 実行は stdin に JSON を渡し、`bash -c` は stdin を子プロセスに継承する

### Step 5: cmdConductor から sessionId 自己生成を撤去
1. `main.ts:1216-1235` — `crypto.randomUUID()` + `fetch(...)` POST ブロックを全削除
2. `main.ts:1249` — `claudeArgs.push("--session-id", sessionId);` を削除
3. `main.ts:831-838` — `case "CONDUCTOR_SESSION":` を削除
4. `main.ts:845` — Usage 文字列の `CONDUCTOR_SESSION` を削除
5. `daemon.ts:811-827` — `case "CONDUCTOR_SESSION":` を削除
6. `daemon.ts:1295-1296` のコメントを書き換え
7. `proxy.ts:246-266` — `if (agent && !agent.sessionId) agent.sessionId = sessionId;` を含む state mutation ブロックを削除。ヘッダ取得と trace/ログ用の `sessionId` 変数は残すが、削除後に unused になる場合は変数ごと整理する
8. `conductor.ts:271, 280` — コメント修正
9. `conductor.ts:470, 557` — コメント修正
10. `bun test` で全テスト pass を確認

### Step 6: 仕様書の同期更新（M2 対応含む）
1. `docs/spec/01-skill-cmux-team.md:70` — メッセージ種別一覧から `CONDUCTOR_SESSION` を削除
2. `docs/spec/05-install-and-infrastructure.md:163` — resume 条件周辺の前後文脈の整合性を確認
3. `docs/spec/05-install-and-infrastructure.md:221` — メッセージ種別一覧から `CONDUCTOR_SESSION` を削除
4. `docs/spec/05-install-and-infrastructure.md:250` — 文言を以下に書き換え:
   > `sessionId` は Claude 自身が発行する。Claude Code の SessionStart hook (`source: startup|resume|clear|compact`) 経由で daemon に届き、`/clear` や `/compact` で新 session が開始されるたびに最新値に更新される。task-state.json への反映は (a) assignTask 時点で `scanTasks` が書く経路と、(b) /clear で新 sessionId を受信したときに daemon の SESSION_STARTED ハンドラが `assigned` 状態のエントリを in-place 更新する経路の 2 つがある。
5. `docs/spec/06-implementation-tasks.md:229, 263` — T132 の記述を撤回マーク付きで残し「T203 で SessionStart hook 方式に再設計」を追記

### Step 7: 手動 E2E 検証
1. `skills/cmux-team/manager` 内で `bun test` を全 pass 確認
2. 型チェック（該当コマンドがあれば）
3. `cmux-team start` → タスク割り当て → Conductor ペインで `/clear` を実行 → `.team/logs/manager.log` に `session_started source=clear session_id=<UUID2>` が記録されることを確認
4. `.team/task-state.json` を cat し、該当 assigned タスクの `sessionId` が UUID2 に更新されていることを確認（C3 の fix を前提に期待される）
5. `cmux-team stop` → `cmux-team start` で再起動 → `cmux-team resume <task-id>` が成功することを確認

## 5. テスト計画

### 5.1 単体テスト (bun test)

**`main.test.ts`:**
- `buildMessageFromHookInput("SESSION_STARTED", json, opts)` の純関数テスト
  - 正常: session_id + source を含む hook JSON → SessionStartedMessage
  - `source=clear` で渡す正常系
  - session_id 無し → sessionId: undefined
  - **余分な引数（opts 外の値）が無視されることを確認 (m3)**
  - 無効 JSON → throw
  - 未知の type 指定 → throw
- **C2 回帰テスト**: `cmdSend --from-stdin` の discriminator で args[1] が `--from-stdin` のとき typeArg 未定義扱いとなり旧パスへ落ちる
- Agent/Conductor settings generator regression
  - `SessionStart[0].matcher === ""`（Agent / Conductor 双方）(C1)
  - `SessionStart[0].hooks[0].command` に `--from-stdin` と `--surface` が含まれる
  - Conductor command に `--conductor-id` が **含まれない** (m2)
  - 既存テスト (`既存の SessionStart / Stop / SessionEnd hook が残存している`) の assert 数維持

**`daemon.test.ts`:**
- `describe("SESSION_STARTED で sessionId 更新 (T203)")`
  - Conductor 分岐で sessionId が state に反映される
  - 二回目に別 sessionId を送ると上書きされる（/clear シナリオ）
  - sessionId 無しメッセージで既存値が保たれる
  - Agent 分岐で agent.sessionId が更新される
  - **C3: assigned タスクを持つ Conductor に対して /clear 相当の SESSION_STARTED(sessionId=U2) を流すと task-state.json.sessionId が U2 に更新される**
  - **C3: 同一 sessionId を受信した場合は task-state.json を書き換えない（冪等性）**
- 既存 `Agent SESSION_STARTED (T195)` テストが継続 pass すること

### 5.2 回帰テスト

- `bun test` 全件 pass
- **SESSION_STOP forwarder (main.ts:1039-1041) が引き続き `cmux-team send --from-stdin` で動作すること — C2 回帰テストとして明示**
- PreToolUse hook テスト (§4.2) の `cmux-team send SESSION_STARTED passes` 等の文字列 assert が破壊されないこと
- CONDUCTOR_SESSION を送信する古い CLI が共存した場合: daemon は schema reject で proxy HTTP 400 (silent) を返す。新 CLI から送信経路は消えるため実害なし

### 5.3 E2E（手動）

1. 実装 branch で worktree を立ち上げ → `cmux-team start`
2. タスク A を割り当て → Conductor が起動 → `.team/logs/manager.log` で `session_started source=startup session_id=<UUID1>` を確認
3. Conductor ペインで `/clear` → `.team/logs/manager.log` で `session_started source=clear session_id=<UUID2>` が記録されること、**かつ `.team/task-state.json` の該当タスクの sessionId が UUID2 に更新されていること** (C3 前提)
4. `cmux-team stop` → `cmux-team start` → resume が成功し `No conversation found` エラーが出ないこと
5. cmux-team 自身の `.team/` での dogfood 動作確認

## 6. 影響範囲・リスク

### 影響範囲
- **Conductor 起動シーケンス**: `--session-id` 引数がなくなり Claude 側で session が発行される。初回は SessionStart hook が届くまで `conductor.sessionId` は undefined。resume 経路は assignTask 時点の最新値を記録するため問題なし。
- **daemon の pidWatcher 経路**: spawnPidWatcher のコメント更新のみ。挙動は変わらない。
- **proxy ログ**: Agent 側の proxy session-id state 反映を削除する。trace DB 書き込みと log は残すため観測性は維持される。
- **既存 queue メッセージ**: runtime の file-based queue dispatcher は存在しない。proxy 経由で届いた古い CONDUCTOR_SESSION は Zod reject → HTTP 400 silent で捨てられる。

### リスク

| リスク | 対策 |
|------|------|
| hook command に `--from-stdin` を付けても stdin が `bash -c` 経由で子プロセスに届かない環境がある | bash の標準仕様上は届くが、macOS/Linux 双方で手動 E2E 検証する。万一動かない場合は `cat | cmux-team send ...` 形式に変更 |
| `matcher: ""` を Agent/Conductor の SessionStart に指定したとき Claude Code が受け付けない | 既存 Stop hook (`main.ts:1083`) が既に `matcher: ""` で動作している実績があるので問題ない。main.test.ts の regression で固定 |
| **/clear → SessionStart hook 到達までの間に `scanTasks` 直後の task-state.json が古い sessionId を保持する race** | **C3 対応: daemon の SESSION_STARTED ハンドラで `assigned` 状態のエントリを補足更新する。これにより hook 到達遅延があっても最終的に task-state.json は最新値に収束する** |
| SessionStart hook が何らかの理由で発火しない (CMUX_CLAUDE_HOOKS_DISABLED=1 環境で自作 settings が無視される等) | `--settings` で明示的に渡しているため CMUX_CLAUDE_HOOKS_DISABLED=1 は cmux ラッパー hook のみ無効化する。自作 settings.json は効く想定（既存実装の前提）。実地で動作確認 |
| trace DB 側で session_id が欠落する | proxy.ts の sessionId 変数自体は残し、trace 書き込みには引き続き使う。本タスクは state mutation のみ削除 |
| 古い CONDUCTOR_SESSION 参照がどこかに残り build failure | TypeScript で schema を削除するので全参照がコンパイルエラーで炙り出される。安全 |
| proxy.ts の silent catch が今後の schema 変更で debug 困難になる | 本タスクでは対象外として記録のみ（M1 のメモ）。将来的に `log("queue_message_invalid", ...)` 追加を別タスクで検討 |

### 非リスク
- 後方互換性: 旧 CLI ↔ 新 daemon の混在は zod reject + silent 400 で skip されるだけ。破壊的変更は OK。
- Master session: Master は SessionStart hook を設定していない (grep で確認済み) ため影響なし。

## 7. 非目標（このタスクではやらない）

タスク指示書より:
- `cmdResume` の cwd 問題 (`main.ts:1338` で worktreePath を使う件) は別タスクで扱う
- KDG-discord-listner の task 030 の個別救済（ユーザー判断で ready 戻し or close）
- トレース DB の session_id 記録変更（trace 側は proxy 経由のまま）

本計画で追加する非目標:
- Master/Manager 自身の SessionStart hook 追加（現状 hook は設定されておらず、本タスクの資源では対象外）
- `cmux-team send --from-stdin` 拡張の Generic 化（SESSION_STARTED 以外の type 対応）は必要になった時点で段階的に追加する
- proxy.ts `/api/messages` の silent catch に validation ログを追加する改修（M1 レビュー指摘の任意改善）

## 8. 変更履歴（Design Review 反映）

初版 plan.md は Design Reviewer から **Changes Requested** を受けた。本リビジョン (rev2) で以下を反映した。

### Critical（全て反映）

- **C1 — SessionStart hook matcher が "startup" のまま**
  Agent (`main.ts:1073`) / Conductor (`main.ts:1131`) の `matcher: "startup"` を `matcher: ""`（全 source 許容）に変更することを 2.2.1 / Step 4 / 変更ファイル一覧 #2, #3 / テスト計画に追加した。これが無いと `/clear` で hook が発火せず本タスクの根本目的が達成されない。

- **C2 — `--from-stdin` discriminator が T189 SESSION_STOP forwarder を破壊する**
  `args[1] === "--from-stdin"` が truthy になり新パスに誤って入る欠陥を 2.3 で明示し、`const typeArg = args[1] && !args[1].startsWith("--") ? args[1] : undefined;` に修正。Step 2 の Red フェーズに C2 回帰テスト（args=[send, --from-stdin] → 旧 QueueMessageSchema パスへ）を明記。

- **C3 — /clear 起因の SESSION_STARTED が `scanTasks.saveTaskState` 前に到着する保証がない**
  daemon の SESSION_STARTED ハンドラで、対象 Conductor が taskId を持ちかつ sessionId が変化した場合に **task-state.json の該当 assigned エントリを in-place 更新** する補足ロジックを Step 3 に追加。テストケース（C3 正常系 + 同一 sessionId 冪等性）を追加し、Risk 表から「race なし」の誤った論拠を削除し「SESSION_STARTED ハンドラで補足更新する」に書き換えた。E2E Step 3 の期待値にも task-state.json 更新確認を明記。

### Major（全て反映）

- **M1 — plan 2.5 が proxy.ts:217-232 の実装と不一致**
  「既存パスに委ねる」旨の誤記を削除し、「proxy.ts:226-233 の catch は silent だが、新 CLI から CONDUCTOR_SESSION 送信経路が物理的に消えるため実害なし」と正確に書き直した。Risk 表の論拠も「新 CLI から送信経路が消える」だけに絞った。proxy.ts の validation ログ追加は非目標として記録。

- **M2 — docs/spec/01-skill-cmux-team.md:70 の CLI 一覧に CONDUCTOR_SESSION が残存**
  変更ファイル一覧に #20 として追加し、Step 6 の 1 番に該当更新手順を追加した。

### Minor（可能な範囲で反映）

- **m1** — `i18n.ts` の CONDUCTOR_SESSION 削除は実 grep で no-op（参照ゼロ）。変更ファイル一覧 #17 を no-op として明示的に記録（作業対象外）
- **m2** — Conductor hook command の `--conductor-id "$CONDUCTOR_ID"` は SessionStartedMessage schema に対応フィールドが無く無視されるため削除する方針を Step 4 の Conductor command 差し替えと変更ファイル一覧 #3 / テスト assert に反映
- **m3** — `buildMessageFromHookInput` のテストに「余分な引数は無視される」ケースを Step 2 の Red フェーズに追加
- **m4** — E2E Step 3 の「task-state.json.sessionId が UUID2」を C3 前提として明示
- **m5** — 2.6 節を「1 Conductor プロセスにつき startup hook は 1 回のみで 2 重通知は実在しない」の短文に整理

## 付録 A: 調査ログ

### A.1 読んだファイル（rev2 で追加再確認分を含む）

- `skills/cmux-team/manager/main.ts:170-205` — getArg/requireArg/hasFlag/readStdin ヘルパー
- `skills/cmux-team/manager/main.ts:680-850` — cmdSend の全分岐（`from-stdin` 分岐の現行 T189 実装を再確認）
- `skills/cmux-team/manager/main.ts:1020-1182` — detect-ask.sh + generateAgentSettings + generateConductorSettings（**matcher: "startup" を現物で確認: L1073, L1131**）
- `skills/cmux-team/manager/main.ts:1189-1270` — cmdConductor の crypto.randomUUID/CONDUCTOR_SESSION/--session-id
- `skills/cmux-team/manager/daemon.ts:730-827` — SESSION_STARTED / CONDUCTOR_SESSION ハンドラ（**L811-827 を削除対象として確認**）
- `skills/cmux-team/manager/daemon.ts:1260-1275` — scanTasks の task-state.json 書き込み（C3 の論拠）
- `skills/cmux-team/manager/daemon.ts:1280-1300` — spawnPidWatcher 内のコメント
- `skills/cmux-team/manager/conductor.ts:415-478` — assignTask の `/clear` + 2 秒 sleep + プロンプト送信 → `status = "running"` → return（C3 の race 再現条件）
- `skills/cmux-team/manager/proxy.ts:210-266` — /api/messages 受信と silent catch、Agent sessionId state mutation
- `skills/cmux-team/manager/schema.ts:30-140` — QueueMessage discriminatedUnion 全体
- `skills/cmux-team/manager/main.test.ts:1-170` — 既存 Conductor settings regression テスト
- `skills/cmux-team/manager/daemon.test.ts:986-1051` — T195 Agent SESSION_STARTED / SESSION_CLEAR テストの直後に本タスクの新 describe を追加
- `docs/spec/01-skill-cmux-team.md:60-80` — CLI サブコマンド一覧（**L70 に CONDUCTOR_SESSION 残存を確認**）
- `docs/spec/05-install-and-infrastructure.md:150-270`
- `docs/spec/06-implementation-tasks.md:220-280`
- `.team/tasks/203-sessionid-sessionstart-hook-clear-resume/task.md`
- `.team/tasks/203-sessionid-sessionstart-hook-clear-resume/runs/task-203-1776234919/design-review.md` (rev2 でフル通読)

### A.2 WebFetch

- `https://code.claude.com/docs/en/hooks` → SessionStart hook JSON 入力フォーマット確認済み
  - フィールド: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `source`, `model`, `agent_type?`
  - `source`: `"startup" | "resume" | "clear" | "compact"`
  - `matcher` は上記 4 値のいずれか 1 値ちょうどを取る。空文字は既存 Stop hook で動作実績あり

### A.3 Grep 結果（抜粋）

- `CMUX_CLAUDE_HOOKS_DISABLED` は cmux ラッパー hook を無効化するためのフラグ。自作 `--settings` JSON 経由の hook は影響を受けない (docs/spec/02-skill-cmux-agent-role.md:39 に明記)
- `SESSION_STARTED` 参照は `main.ts`, `daemon.ts`, `schema.ts`, `main.test.ts`, `daemon.test.ts`, `task.ts` に分散
- `CONDUCTOR_SESSION` 参照は `main.ts:831,845,1226`, `daemon.ts:811-827,1296`, `schema.ts:105-110,130,139`, `conductor.ts:271,280`, `docs/spec/01-skill-cmux-team.md:70`, `docs/spec/05-install-and-infrastructure.md:221` に集中
- `rg 'CONDUCTOR_SESSION' skills/cmux-team/manager/i18n.ts` → 0 件（m1 の no-op を確認）
- `rg 'queue/incoming|readQueueMessages' skills/cmux-team/manager` → e2e テストのみヒット（runtime file-based queue dispatcher は無い / M1 の論拠）
- Master surface には SessionStart hook が設定されていない
