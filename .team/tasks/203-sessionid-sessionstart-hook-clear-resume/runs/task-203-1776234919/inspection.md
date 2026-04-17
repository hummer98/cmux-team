# Inspection: T203

## Verdict

**GO**

## Summary

T203 の実装は plan.md (rev2) と design-review-rev2.md の指示どおり、Critical 3 件 (C1 matcher / C2 discriminator / C3 task-state.json 同期) と Minor 5 件すべてを正しく取り込んでいる。`bun test` は 266 pass / 0 fail を再現し、新規追加された `buildMessageFromHookInput` 単体テスト (8 ケース)・`cmdSend --from-stdin discriminator` 回帰テスト (2 ケース・subprocess 経由)・`SessionStart hook generation` regression (Agent / Conductor)・`SESSION_STARTED で sessionId 更新 (T203)` (6 ケース、C3 正常系 + 冪等性) の網羅性も plan の 5.1 と一致している。Conductor / Agent / docs / schema / proxy のいずれも CONDUCTOR_SESSION 参照ゼロを実現しており、T132 撤回も docs/spec/06 で正しくマークされている。GO とする。

## 検品結果

### Critical / 必須項目チェック

| 項目 | 結果 | 確認方法 |
|------|------|---------|
| C1 matcher: "" (Agent) | ✅ | `main.ts:1128` `matcher: ""` 確認 + `main.test.ts:894-906` で `entry.matcher === ""` を assert |
| C1 matcher: "" (Conductor) | ✅ | `main.ts:1188` `matcher: ""` 確認 + `main.test.ts:908-920` で `entry.matcher === ""` を assert |
| C2 discriminator (`--` 始まりは type 扱いしない) | ✅ | `main.ts:694` `const typeArg = args[1] && !args[1].startsWith("--") ? args[1] : undefined;` + `main.test.ts:850-865` (subprocess で SESSION_STOP forwarder 互換性確認) |
| C3 task-state.json 同期更新 | ✅ | `daemon.ts:772-800` `loadTaskState → 該当 assigned 更新 → saveTaskState`。`taskId` 保有 + `prevSessionId !== message.sessionId` + `cur.status === "assigned"` + `cur.sessionId !== message.sessionId` を満たす場合のみ save。`task_session_updated` ログも追加 |
| C3 冪等性 (同一 sessionId なら save しない) | ✅ | `daemon.ts:776` の `prevSessionId !== message.sessionId` ガード + `daemon.ts:785` の `cur.sessionId !== message.sessionId` ガードで二重防御。`daemon.test.ts:1203-1252` で mtime 比較により save なしを assert |
| C3 例外時のログ | ✅ | `daemon.ts:794-799` `try/catch` で `log("error", "task-state update failed on session_started: ...")` を残している |
| n1 既存 starting/disconnected → idle 遷移ブロック残存 | ✅ | `daemon.ts:756-763` 健在。`daemon.test.ts:1069` で starting → idle を assert |
| n2 SessionEnd hook (matcher: "clear") 残存 | ✅ | `main.ts:1209-1216` で SESSION_CLEAR 用 SessionEnd hook が残っている |
| CONDUCTOR_SESSION 0 件 (skills/ docs/ commands/) | ✅ | `rg 'CONDUCTOR_SESSION' skills/ docs/ commands/` → 0 ヒット (古い `.team/tasks/151-...` 履歴のみがリポジトリ全体には残るが対象外) |
| ConductorSessionMessage schema 削除 | ✅ | `schema.ts` から完全除去、`QueueMessage discriminatedUnion` からも除外、type export も削除 |
| cmdConductor から `--session-id` / `crypto.randomUUID()` 削除 | ✅ | `rg 'randomUUID\|--session-id' main.ts` → 0 件 (cmdResume の `--resume` のみ残存。これは別エンドポイント) |
| Agent settings: `--from-stdin` 形式 + `SESSION_STARTED` を含む | ✅ | `main.ts:1132` `cmux-team send SESSION_STARTED --from-stdin --surface "${surface}" --pid "$PPID"` |
| Conductor settings: `--from-stdin` 形式 + `--conductor-id` を含まない (m2) | ✅ | `main.ts:1193` 確認 + `main.test.ts:919` `expect(cmd).not.toContain("--conductor-id")` |
| proxy.ts: `agent.sessionId` state mutation 削除 | ✅ | `rg 'agent\.sessionId' proxy.ts` → 0 件。daemon.ts:815 の hook 経路に一本化 |
| docs/spec/01:70 CLI 一覧から CONDUCTOR_SESSION 削除 (M2) | ✅ | grep 結果で CLI 一覧から欠落、他種別はそのまま残存 |
| docs/spec/05:250 sessionId 説明書き換え | ✅ | 「Claude Code の SessionStart hook (`source: startup\|resume\|clear\|compact`) から `SESSION_STARTED` メッセージとして daemon に push され、`/clear` 等で session が切り替わるたびに最新値で更新される (T203)」 |
| docs/spec/06:229,263 T132 撤回 | ✅ | `~~Conductor --session-id (T132)~~ → T203 で撤回` 表記 + L263 の自己生成方式撤回も「さらに T203 で...」と上書き済み |
| `bun test` 全 pass | ✅ | `cd skills/cmux-team/manager && bun test` → **266 pass / 0 fail / 540 expect() calls / 14 files** |

### テスト網羅性

新規追加テストは plan の 5.1 で要求された全項目をカバーしている:

**`main.test.ts`:**
- `describe("buildMessageFromHookInput (T203)")` — 8 ケース
  - 正常 (startup)、source=clear、session_id 無し、m3 余分フィールド無視、source 4 値全 pass、無効 JSON、object 以外、未対応 type
- `describe("cmdSend --from-stdin discriminator (C2 / T203)")` — 2 ケース (subprocess 経由)
  - 旧 forwarder 互換 (SESSION_STOP) / 新 hook 解釈 (SESSION_STARTED + --surface + --pid)
  - **subprocess で実際に CLI を起動して HTTP POST を spy するスタイル**を採用しており、discriminator のロジック検証として実コードパス全体を通している。これは plan より厳密で評価できる
- `describe("SessionStart hook generation (T203)")` — 2 ケース
  - Agent matcher === "" + 必須引数 / Conductor matcher === "" + `--conductor-id` を含まないこと

**`daemon.test.ts`:**
- `describe("SESSION_STARTED で sessionId 更新 (T203)")` — 6 ケース
  - Conductor 単純反映 (n1: starting → idle 維持を同時 assert) / Conductor /clear 上書き / sessionId 無しで保持 / Agent 反映 / C3 task-state.json 同期 / C3 冪等性 (mtime 比較)

「mock の漏れ」「assert の不足」は見当たらない。各ケースが具体的な期待値を assert しており、no-op をすり抜ける構造ではない。

### Findings

#### Critical (must fix)
なし。

#### Major (should fix)
なし。

#### Minor (nice to have)

**Mn-1. proxy.ts から `sessionId` / `x-claude-code-session-id` 関連変数も併せて完全削除されている**

plan #14 は「ヘッダ取得自体は trace 用に残してよい（変数未使用になれば変数ごと整理する）」とあり、Implementer は後者の path を選択して `req.headers.get("x-claude-code-session-id")` を含む sessionId 関連の変数・参照を proxy.ts から完全削除した。`rg 'session_id\|sessionId' proxy.ts` → 0 件。trace DB 側 (`trace-store.ts`) は `task_sessions.session_id` を `conductor.ts:446` の `insertTaskSession` 経由で記録しており、proxy 経由ではないため、この削除によるトレース機能への実害はない。仕様上問題なしだが、将来的に「proxy 経由で API リクエストヘッダから session_id を見て trace に紐付ける」改修を入れる際は `proxy.ts` への再導入が必要になる。本タスクのスコープ外として記録のみ。

**Mn-2. C3 冪等性テストが `mtime` 比較に依存している**

`daemon.test.ts:1216-1243` は「saveTaskState が呼ばれていない」ことを `fs.stat` の `mtimeMs` 比較で確認している。bun test の高速実行下では beforeStat と handleMessage 完了直後の afterStat が同 ms に収まる可能性がゼロではなく、CI 環境で flake が出る余地がある（実際は `await handleMessage` の中で IO がはさまるので別 ms になる確率が高く、現状は pass している）。より厳密にするなら `saveTaskState` を spy する形が望ましいが、本タスクでは実用上問題ないため記録のみ。

**Mn-3. trace DB の `insertTaskSession` (`conductor.ts:446`) は assignTask の /clear 直後（hook 到達待ちなし）に `conductor.sessionId ?? ""` を書き込むため、/clear 経路では空文字または旧 sessionId が trace に記録される race が残る**

これは plan の §7「非目標」に明示された通り「トレース DB の session_id 記録変更（trace 側は proxy 経由のままで問題ない）」のスコープ外。本タスクの目的（resume の回復）には影響しない。task-state.json 側は C3 fix で正しく追従するため resume は動く。記録のみ。

**Mn-4. 既存 `Conductor: 2 回目の sessionId は上書きされる` テスト (`daemon.test.ts:1072-1100`) で `conductor.taskId` を設定していないため、C3 ブロック (taskId 必須) には入らず純粋な state 上書きのみを検証している**

C3 同期更新の検証は別ケース (`C3: assigned タスクを持つ Conductor の /clear で...`) で実施されており、テストの分割が適切。指摘ではなく確認事項。

## Verification Notes

### コード grep / Read で確認した実コード

```
$ rg -n 'CONDUCTOR_SESSION' skills/ docs/ commands/
(no matches)
```

```ts
// schema.ts:39-46 — SessionStartedMessage に source 追加、ConductorSessionMessage 削除済み
SessionStartedMessage = z.object({
  type: z.literal("SESSION_STARTED"),
  surface: z.string(),
  pid: z.number(),
  sessionId: z.string().optional(),
  source: z.enum(["startup", "resume", "clear", "compact"]).optional(),
  timestamp: z.string().datetime(),
});
```

```ts
// main.ts:690-737 — cmdSend --from-stdin の C2 正規化
if (hasFlag("from-stdin")) {
  const raw = await readStdin();
  const typeArg = args[1] && !args[1].startsWith("--") ? args[1] : undefined;
  if (typeArg) {
    // 新パス
    message = buildMessageFromHookInput(typeArg, raw, { surface: requireArg("surface"), pid: Number(requireArg("pid")), now });
  } else {
    // 旧パス（T189 互換）— QueueMessageSchema.parse
  }
}
```

```ts
// main.ts:1067-1098 — buildMessageFromHookInput 純関数
export function buildMessageFromHookInput(type, rawJson, opts) {
  parsed = JSON.parse(rawJson); // throw on invalid
  if (type === "SESSION_STARTED") { ... return SessionStartedMessageSchema.parse(...) }
  throw new Error(`unsupported hook message type: ${type}`);
}
```

```ts
// main.ts:1124-1135 — Agent SessionStart hook
SessionStart: [{
  matcher: "",
  hooks: [{ command: `bash -c 'cmux-team send SESSION_STARTED --from-stdin --surface "${surface}" --pid "$PPID" 2>/dev/null || true'`, ... }],
}],

// main.ts:1185-1196 — Conductor SessionStart hook
SessionStart: [{
  matcher: "",
  hooks: [{ command: "bash -c 'cmux-team send SESSION_STARTED --from-stdin --surface \"${CMUX_SURFACE}\" --pid \"$PPID\" 2>/dev/null || true'", ... }],
}],
```

```ts
// daemon.ts:742-806 — SESSION_STARTED ハンドラ (Conductor 分岐)
if (conductor.status === "starting" || conductor.status === "disconnected") {
  conductor.status = "idle"; // n1: 既存ブロック維持
}
const prevSessionId = conductor.sessionId;
if (message.sessionId) conductor.sessionId = message.sessionId; // T203
conductor.pid = message.pid;
spawnPidWatcher(...)

// C3: assigned タスク同期更新
if (message.sessionId && prevSessionId !== message.sessionId && conductor.taskId) {
  try {
    const ts = await loadTaskState(state.projectRoot);
    const cur = ts[conductor.taskId];
    if (cur && cur.status === "assigned" && cur.sessionId !== message.sessionId) {
      ts[conductor.taskId] = { ...cur, sessionId: message.sessionId };
      await saveTaskState(state.projectRoot, ts);
      await log("task_session_updated", `${formatSurface(...)} task_id=... session_id=... source=...`);
    }
  } catch (e: any) {
    await log("error", `task-state update failed on session_started: ${e?.message ?? e}`);
  }
}

await log("session_started", `${formatSurface(message.surface, "C")} pid=${message.pid} session_id=${message.sessionId ?? "-"} source=${message.source ?? "-"}`);
```

```ts
// daemon.ts:809-826 — Agent 分岐
for (const c of state.conductors.values()) {
  const agent = c.agents.find(a => a.surface === message.surface);
  if (agent) {
    if (message.sessionId) agent.sessionId = message.sessionId; // T203
    agent.pid = message.pid;
    ...
  }
}
```

```ts
// main.ts:1248-1310 — cmdConductor (sessionId 自己生成削除済み)
// rg 'randomUUID|--session-id' main.ts → 0 件
// claudeArgs に --session-id なし
```

```ts
// proxy.ts:1-406 — agent.sessionId / x-claude-code-session-id 完全除去
// rg 'session_id|sessionId' proxy.ts → 0 件
```

```ts
// conductor.ts:271,280 — コメント書き換え
// "sessionId なし — SessionStart hook で後から設定される"

// conductor.ts:470 — assignTask 内コメント
// "sessionId は SessionStart hook で最新値に追従する"

// conductor.ts:557 — resetConductor 内コメント
// "sessionId は SessionStart hook で最新値に追従するため reset では触らない"
```

```
# docs/spec
docs/spec/01-skill-cmux-team.md:70 — CLI 一覧から CONDUCTOR_SESSION 除外
docs/spec/05-install-and-infrastructure.md:250 — T203 新方針 (Claude Code の SessionStart hook 経由) を明記
docs/spec/06-implementation-tasks.md:229 — ~~Conductor --session-id (T132)~~ → T203 で撤回
docs/spec/06-implementation-tasks.md:263 — 自己生成撤廃も「さらに T203 で... daemon 一元管理に置き換え」と追記
```

### `bun test` 実行結果

```
$ cd skills/cmux-team/manager && bun test
bun test v1.3.12 (700fc117)
...
 266 pass
 0 fail
 540 expect() calls
Ran 266 tests across 14 files. [8.62s]
```

Implementer 自己申告 (266 pass / 0 fail) を完全再現。

### EventBus / ロギングポリシー整合

- `notifyStateChanged("daemon.ts:handleMessage:session-started-conductor")` — file:func:reason 形式 ✅
- `notifyStateChanged("daemon.ts:handleMessage:session-started-agent")` — 同上 ✅
- `bus.emit` / `bus.on` 直接呼び出しは無し（`rg "bus\.(emit|on)\b" skills/cmux-team/manager | rg -v eventBus.ts` → 0 件相当）
- C3 同期更新の例外 catch は `log("error", ...)` を残している ✅
- ログフォーマットは `formatSurface(message.surface, "C")` + `key=value` 形式 ✅

### テンプレート編集ルール整合

`.team/prompts/*.md` への直接編集は無し。`templates/*.md` も今回の変更対象外。

## Fix Required (NOGO の場合のみ)

NOGO ではないため、修正指示なし。

## 参考: 検品が再評価したいと思うかもしれない論点

- Mn-3 の trace DB race は将来的に「proxy 経由で trace の session_id を補正する」など別タスクで扱う価値あり
- Mn-2 の mtime 比較テストは spy パターンに置き換えると堅牢性が上がるが、現状 flake は観測されていない

以上。
