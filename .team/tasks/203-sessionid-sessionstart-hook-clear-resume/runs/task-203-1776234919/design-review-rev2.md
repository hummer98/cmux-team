# Design Review rev2: T203 plan.md

## Verdict

**Approved**

## Summary

rev1 で指摘した Critical 3 件（C1 matcher / C2 discriminator / C3 task-state.json 同期）、Major 2 件（M1 / M2）、Minor 5 件すべてが plan.md rev2 に反映されており、TDD ステップ・疑似コード・変更ファイル一覧・テスト計画・リスク表・E2E 手順まで整合している。実コードに対する追加 grep でも plan の行番号・状態遷移の前提は正しく、新たな Critical 欠陥は発見されなかった。Step 3 の task-state.json 同期更新ブロックも /clear 先行 / scanTasks 先行のどちらの interleaving でも最終値が UUID2 に収束する構造で、論理欠陥は無い。Minor レベルの注意点を 2 件（new issues に列挙）挙げるが、いずれも Implementer への申し送りで十分対応可能であり、承認を阻害しない。

## 前回指摘の取り込み確認

| 指摘 | 取り込み | 備考 |
|------|---------|------|
| C1 matcher "startup" → "" | ✅ | plan 2.2.1 / Step 4 / 変更ファイル一覧 #2, #3 / テスト 5.1 `main.test.ts` assert (`matcher === ""`) に反映。Agent と Conductor 双方の matcher を変更する旨を明示 |
| C2 `--from-stdin` discriminator | ✅ | plan 2.3 の疑似コードが `const typeArg = args[1] && !args[1].startsWith("--") ? args[1] : undefined;` に差し替え済み。Step 2 Red に「args=[send, --from-stdin] → 旧 QueueMessageSchema パスへ」の回帰テストを明記 |
| C3 task-state.json 同期 | ✅ | plan Step 3 に SESSION_STARTED ハンドラ内での `loadTaskState → 該当 assigned エントリ更新 → saveTaskState` 補足ロジックを疑似コードで記述。Red フェーズに「assigned タスク + /clear シミュレーションで task-state.json.sessionId が U2 に更新」「同一 sessionId 受信時は saveTaskState を呼ばない（冪等性）」2 ケースを追加。Risk 表も「race なし」論拠から「SESSION_STARTED ハンドラで補足更新」論拠に書き換え済み |
| M1 proxy silent catch 記述 | ✅ | plan 2.5 を「proxy.ts:226-233 の catch は silent（ログなし）だが、新 CLI から CONDUCTOR_SESSION 送信経路が物理的に消えるため実害なし」に書き直し。Risk 論拠も論理破綻しない形に整理。proxy.ts の validation ログ追加は §7 で明示的に非目標に |
| M2 docs/spec/01 追加 | ✅ | 変更ファイル一覧 #20 に `docs/spec/01-skill-cmux-team.md:70` を追加。Step 6 の 1 番に該当更新手順を明記 |
| m1 i18n.ts no-op 明記 | ✅ | 変更ファイル一覧 #17 を「no-op、作業対象外」と明示。grep 結果も付録 A.3 に記録 |
| m2 `--conductor-id` 削除 | ✅ | Step 4 Conductor command から `--conductor-id "$CONDUCTOR_ID"` を削除し、main.test.ts の regression に「含まれないこと」の assert を追加 |
| m3 余分な引数は無視される | ✅ | Step 2 Red の buildMessageFromHookInput テスト項目に明記 |
| m4 E2E 期待値 | ✅ | 5.3 Step 3 に「task-state.json.sessionId が UUID2 に更新される」を C3 前提として明記 |
| m5 source=startup 2 重通知節 | ✅ | 2.6 を「1 Conductor プロセスにつき startup は 1 回のみで 2 重通知は実在しない」の短文に整理 |

## New Issues (rev2 で新たに見つけた点)

### Critical (must fix)

なし。

### Major (should fix)

なし。

### Minor (nice to have)

**n1. Step 3 の疑似コードは「ハンドラ全置換」ではなく「差分追加」であることを明示した方が安全**

plan Step 3 #3 の疑似コードは以下のように書かれている:

```ts
const prevSessionId = conductor.sessionId;
if (message.sessionId) conductor.sessionId = message.sessionId;
conductor.pid = message.pid;
conductor.disconnectedAt = undefined;
notifyStateChanged("daemon.ts:handleMessage:session-started-conductor");
spawnPidWatcher(state, conductor, message.pid);
// C3: ...
```

現行の SESSION_STARTED ハンドラ（`daemon.ts:756-763`）には `starting / disconnected → idle` 遷移ブロックが存在する:

```ts
if (conductor.status === "starting" || conductor.status === "disconnected") {
  const prevStatus = conductor.status;
  conductor.status = "idle";
  await log(
    prevStatus === "starting" ? "conductor_ready" : "conductor_recovered",
    formatSurface(message.surface, "C")
  );
}
```

plan の疑似コードはこの遷移を省略しているが、実装時にはこれを **残したまま** 前後に挿入する必要がある。Implementer が疑似コードをそのまま全置換すると starting Conductor が idle に遷移しなくなる回帰を生む可能性がある。plan Step 3 の冒頭に「既存の starting/disconnected → idle 遷移ロジックはそのまま残す」という一行コメントを追記すると安全。

**影響度:** Low（現在の既存テスト `conductor_ready` / `conductor_recovered` で即座に検出される）。

**n2. Conductor の SessionEnd(clear) hook (main.ts:1151) との発火順序がドキュメント化されていない**

Conductor の settings.json には現状 `SessionEnd` hook matcher `"clear"` が存在し、`/clear` 時に `SESSION_CLEAR` メッセージを送信する（main.ts:1154）。本タスクで matcher を `""` に変更した SessionStart hook も `/clear` で発火するため、`/clear` 1 回につき **SESSION_CLEAR と SESSION_STARTED の 2 メッセージ** が daemon に届くことになる。plan は SessionEnd hook を触らないので両方が届く前提で動くが、この前提が plan にも Step 3 の疑似コードにも書かれていない。

実際の論理上は問題ない:

- SESSION_CLEAR が先着しても、daemon の SESSION_CLEAR ハンドラは pid リセット等を行うだけで sessionId には触れない（daemon.test.ts:986 の T195 テストで裏付け）
- SESSION_STARTED が先着/後着どちらでも C3 ブロックは最終的に最新値を書く

ただし plan の §2.2「全 source で追従」の背景説明に **「SESSION_CLEAR と SESSION_STARTED の両方が /clear 1 回で届くが、SESSION_CLEAR は sessionId を触らないので安全」** の一文を入れておくと、次の reviewer/implementer の負担が減る。

**影響度:** Low（動作影響なし、ドキュメント品質の話）。

## Verification Notes

実コードに対する grep / Read 結果で plan の記述と行番号を再確認した。

### C1 の matcher 修正対象 (Agent / Conductor 双方存在)

```
$ sed -n '1066,1138p' skills/cmux-team/manager/main.ts
1066  export function generateAgentSettings(projectRoot: string, surface: string): string {
...
1073          matcher: "startup",
1076            command: `bash -c 'cmux-team send SESSION_STARTED --surface "${surface}" --pid "$PPID" 2>/dev/null || true'`,
...
1114  export function generateConductorSettings(projectRoot: string, surface: string): string {
...
1131          matcher: "startup",
1134            command: "bash -c 'cmux-team send SESSION_STARTED --conductor-id \"$CONDUCTOR_ID\" --surface \"${CMUX_SURFACE}\" --pid \"$PPID\" 2>/dev/null || true'",
```

plan 変更ファイル一覧 #2 (1071-1080) と #3 (1129-1138) の行範囲は現行コードと一致。matcher "startup" → "" と command 差し替え、Conductor 側の `--conductor-id` 削除まで plan が網羅している。

### C2 の現行 T189 forwarder

```
$ sed -n '1030,1046p' skills/cmux-team/manager/main.ts
1035  'printf \'{"type":"SESSION_STOP","surface":%s,"conductorId":%s,"pid":%d,"timestamp":%s,"payload":{"transcript_path":%s}}\\n\' \\',
...
1041  '  | cmux-team send --from-stdin 2>/dev/null || true',
```

T189 は `send --from-stdin` 形式（type 引数なし）で起動する。現行の `cmdSend` は `hasFlag("from-stdin")` 分岐内で早期 return しており (`main.ts:688-716`)、`args[1]` を読まないので T189 は現状動く。plan Step 2 の新パス追加後は `args[1] === "--from-stdin"` が truthy になるため、plan 2.3 の `typeArg = args[1] && !args[1].startsWith("--") ? args[1] : undefined;` による正規化で旧パスへ落とす必要がある — plan はこれを正しく疑似コード化している。

### C3 の race 条件と handler 補足更新の有効性

```
$ sed -n '742,795p' skills/cmux-team/manager/daemon.ts
742    case "SESSION_STARTED": {
...
753      const conductor = findConductor(state, message.surface);
754      if (conductor) {
756        if (conductor.status === "starting" || conductor.status === "disconnected") { ... idle 遷移 ... }
764        conductor.pid = message.pid;
765        conductor.disconnectedAt = undefined;
766        notifyStateChanged(...);
767        spawnPidWatcher(state, conductor, message.pid);
769        await log("session_started", ...);  ← sessionId 更新は現状なし
```

```
$ sed -n '1260,1273p' skills/cmux-team/manager/daemon.ts
1260   state.conductors.set(updated.surface, updated);
1262   const ts = await loadTaskState(state.projectRoot);
1263   ts[task.id] = {
1264     ...ts[task.id],
...
1271     sessionId: updated.sessionId,
1272   };
1273   await saveTaskState(state.projectRoot, ts);
```

**interleaving シナリオの検証:**

| 順序 | 結果 | 備考 |
|------|------|------|
| SESSION_STARTED 先着（scanTasks 書込前） | scanTasks 時点で `updated.sessionId` は既に U2（handleMessage が conductor.sessionId を in-place 書き換え済み） → ts[T].sessionId = U2 ✓ | conductor object はハンドラと scanTasks で参照共有。C3 ブロック内の saveTaskState は `cur.status === "assigned"` で false を引くので no-op、直後の scanTasks saveTaskState が U2 を書く |
| SESSION_STARTED 後着（scanTasks 書込後） | scanTasks が U1 を書いた後、handleMessage C3 ブロックが `cur.status === "assigned" && cur.sessionId !== message.sessionId` で true を引く → U2 で上書き ✓ | plan の C3 ブロックそのもの |

どちらの順序でも最終値が U2 に収束する。plan の pseudocode は正しい。

### M1 proxy silent catch

```
$ sed -n '222,234p' skills/cmux-team/manager/proxy.ts
222     if (req.method === "POST" && url.pathname === "/api/messages") {
...
226       try {
227         const body = await req.json();
228         const msg = QueueMessage.parse(body);
229         await opts.onMessage(msg);
230         return new Response(JSON.stringify({ ok: true }), ...);
231       } catch {
232         return new Response(JSON.stringify({ error: "invalid body" }), { status: 400, ... });
233       }
```

silent catch（ログ出力なし）。plan 2.5 の記述と一致。plan は「新 CLI から送信経路自体が消えるため実害なし」で論拠を絞っており、Risk 表も整合。

### M2 docs/spec/01 / 05 の CONDUCTOR_SESSION 残存

```
$ rg -n 'CONDUCTOR_SESSION' docs/spec/
docs/spec/01-skill-cmux-team.md:70: ... CONDUCTOR_SESSION ...
docs/spec/05-install-and-infrastructure.md:221: ... CONDUCTOR_SESSION ...
```

plan 変更ファイル一覧 #20 (docs/spec/01), #21 (docs/spec/05) 双方を更新対象として明示。Step 6 の手順にも反映済み。

### m1 i18n.ts は no-op

```
$ rg -n 'CONDUCTOR_SESSION' skills/cmux-team/manager/i18n.ts
(no matches)
```

i18n.ts に CONDUCTOR_SESSION 参照なし。plan #17 の no-op 記述は正しい。

### schema.ts 行番号確認

```
$ sed -n '105,140p' skills/cmux-team/manager/schema.ts
105  export const ConductorSessionMessage = z.object({
106    type: z.literal("CONDUCTOR_SESSION"),
107    surface: z.string(),
108    sessionId: z.string(),
109    timestamp: z.string().datetime(),
110  });
...
117  export const QueueMessage = z.discriminatedUnion("type", [
...
130    ConductorSessionMessage,
131    ShutdownMessage,
132  ]);
...
139  export type ConductorSessionMessage = z.infer<typeof ConductorSessionMessage>;
```

plan 変更ファイル #11 (105-110), #12 (117-132), #13 (139) の行番号とすべて一致。削除対象も全て捉えている。

### 既存テスト構造

```
$ rg -n 'describe\(' skills/cmux-team/manager/daemon.test.ts | tail -5
986  SESSION_CLEAR: pid リセット (T195)
1011 Agent SESSION_STARTED (T195)
1051 createDaemon: layout (T176)
```

plan Step 3 の新 describe `"SESSION_STARTED で sessionId 更新 (T203)"` は T195 Agent SESSION_STARTED の直後（≈ L1051 手前）に挿入するのが自然で、plan もその位置を想定している。

### その他

- `conductor.ts:470, 557` のコメントは現物で `// sessionId は初回起動時に発行済み — ...` と確認済み。plan の書き換え対象として一致。
- `conductor.ts:425-440` の /clear + sleep シーケンスは rev1 Verification Notes と変わらず。C3 の race 前提条件も変わらず。
- `proxy.ts:246-266` の agent.sessionId state mutation ブロックも現物確認済み。plan #14 の削除対象として正しい。
- `cmdResume` の `execFileSync` で `cwd: ts.worktreePath` を使う点は §7 で非目標として明示。OK。
