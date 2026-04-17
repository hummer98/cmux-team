# Design Review: T203 plan.md

## Verdict

**Changes Requested**

## Summary

plan.md の全体構造（SessionStart hook 入力 JSON を `--from-stdin` 経由で parse し、Conductor/Agent の sessionId を hook ルートに一本化する）は正しい方針で、変更範囲・TDD ステップも概ね網羅的。ただし**実コードで検証すると、このままでは /clear 後の sessionId 更新は発火しない**。現在の Agent/Conductor の SessionStart hook は `matcher: "startup"` で登録されており、plan はこれを変更していないため、`/clear` や `/compact` では hook 自体が起動しない。本タスクの根本目的が達成されないため Changes Requested とする。加えて `--from-stdin` 分岐の discriminator ロジックに T189 forwarder を壊す欠陥、`/clear` → SESSION_STARTED → `scanTasks.saveTaskState` の処理順序が plan の前提どおりになる保証が無い点も指摘する。

## Strengths

- task.md の議論（proxy ルート廃止、CONDUCTOR_SESSION 廃止）を正しく汲み取り、状態遷移のアンラッピング範囲（schema / daemon / main / proxy / conductor / docs）を丁寧に洗い出している
- `buildMessageFromHookInput` を純関数として切り出し、単体テスト可能にする方針が TDD として筋が良い
- Step 1 で schema を先に変更し TypeScript のコンパイルエラーで漏れを炙り出す戦略は安全
- Risk 表で `bash -c` の stdin 継承・`CMUX_CLAUDE_HOOKS_DISABLED=1` の影響・古い CONDUCTOR_SESSION の queue 残存を網羅的に検討している
- SessionStartedMessage に `source` optional を追加してログで追跡可能にする提案（2.4）は観測性として有益
- 後方互換のため `if (message.sessionId)` ガードを入れて旧メッセージを壊さない配慮

## Issues

### Critical (must fix)

**C1. SessionStart hook の `matcher` が "startup" のまま — /clear では hook 自体が発火しない**

現状コード:

- `skills/cmux-team/manager/main.ts:1073` (Agent) — `matcher: "startup"`
- `skills/cmux-team/manager/main.ts:1131` (Conductor) — `matcher: "startup"`

Claude Code の docs（[code.claude.com/docs/en/hooks](https://code.claude.com/docs/en/hooks)）を確認したところ、SessionStart hook の `matcher` は `"startup" | "resume" | "clear" | "compact"` のいずれか**ちょうど 1 値**を指定する。つまり `matcher: "startup"` のままでは `/clear`（`source: "clear"`）でも `/compact`（`source: "compact"`）でも hook は起動しない。plan の Step 4 は `command` 文字列の差し替えしか触れておらず、matcher を変更していない。**この修正がないと、本タスクの根本目的（/clear 後に daemon が最新 sessionId を受け取る）が達成されない。**

修正方針（plan に追記すべき内容）:

- Agent / Conductor とも `matcher: "startup"` → `matcher: ""`（空文字＝全 source）に変更する。既存 Stop hook (`main.ts:1083`) が既に `matcher: ""` を使っているので Claude Code 側のサポートは確認済み
- もしくは matcher を `"startup"|"clear"|"compact"|"resume"` の 4 entry に分割する。plan 2.2「全 source で追従」とも整合する
- 回帰テスト: `main.test.ts` の既存 assert `settings.hooks.SessionStart.length` および `matcher` 値をアップデート

**C2. `--from-stdin` ハンドラの discriminator ロジックが T189 forwarder を破壊する**

plan 2.3 のコード:

```ts
if (hasFlag("from-stdin")) {
  const raw = await readStdin();
  const typeArg = args[1]; // "SESSION_STARTED" 等
  if (typeArg) {
    // 新パス
  } else {
    // 既存パス
  }
}
```

現行の T189 SESSION_STOP forwarder は `main.ts:1041` で `cmux-team send --from-stdin`（type 無し）を呼んでいるため、`process.argv.slice(2)` は `["send", "--from-stdin"]` となり、**`args[1] === "--from-stdin"` は truthy**。plan の `if (typeArg)` 分岐は新パスに入ってしまい、hook JSON として parse しようとして失敗 → T189 の SESSION_STOP forwarder が壊れる。

修正方針:

- discriminator を `if (typeArg && !typeArg.startsWith("--"))` にする
- もしくは `const typeArg = args[1] && !args[1].startsWith("--") ? args[1] : undefined;` として早期に正規化
- 必須: `main.test.ts` の `buildMessageFromHookInput` テストに「`cmux-team send --from-stdin` 相当の args（type 無し）」で旧パスへ落ちる回帰テストを追加する（plan の 5.2 回帰リストに書かれた `main.ts:1039-1041` テストは「該当テスト or hand test」と曖昧、プロセス内で `argv` を差し替えるスタイルのユニットテストを明示する）

**C3. `/clear` 起因の SESSION_STARTED が `scanTasks` の `saveTaskState` 前に到着する保証がない**

plan は「daemon の SESSION_STARTED ハンドラで `conductor.sessionId = message.sessionId` を更新するだけ」を Step 3 の全てとしているが、実際には `conductor.ts:427` (`assignTask`) で `/clear` が **タスク割当フロー中に** 送られる構造になっている:

```ts
await cmux.send(conductor.surface, "/clear");
await sleep(500);
await cmux.sendKey(conductor.surface, "return");
await sleep(2000);
await cmux.send(conductor.surface, `${promptFile} を読んで...`);
await sleep(500);
await cmux.sendKey(conductor.surface, "return");
// ... conductor.status = "running"; return;
```

その直後 `daemon.ts:1262-1273` の `scanTasks` が task-state.json に `sessionId: updated.sessionId` を書き込む。`/clear` の結果 Claude は SessionStart(source=clear) 発火 → hook 経由で daemon に POST → handleMessage(SESSION_STARTED) → `conductor.sessionId = Y` の一連が、`assignTask` の合計 3 秒の sleep 中に完走していれば plan 通り動くが、

1. Claude Code 側で /clear を内部処理するレイテンシが 3 秒を超えた場合
2. 事業所負荷が高い環境で hook の bash spawn / HTTP POST が遅延した場合
3. proxy 経由の処理キューがバックアップしている場合

いずれでも `scanTasks` は **/clear 前の古い sessionId** を task-state.json に保存する。以降 daemon が再起動すると `cmdResume` が古い session_id で `claude --resume` → 本タスクで修正したはずの失敗が再発する。

plan の Risk 表は「元々 idle に遷移する条件は SESSION_STARTED 受信が必須」と書いているが、該当 Conductor は `assignTask` 開始時点で既に `idle` なので、この論拠は成り立たない（`SESSION_STARTED` を待って idle に遷移するのは starting/disconnected 経路のみ — `daemon.ts:756-763`）。

修正方針（plan に追記すべき内容）:

- daemon の SESSION_STARTED ハンドラで、対象 Conductor が `running` 状態（= taskId あり）の場合は **task-state.json も同時に更新** する:
  ```ts
  if (message.sessionId && conductor.sessionId !== message.sessionId && conductor.taskId) {
    const ts = await loadTaskState(state.projectRoot);
    const cur = ts[conductor.taskId];
    if (cur && cur.status === "assigned" && cur.sessionId !== message.sessionId) {
      ts[conductor.taskId] = { ...cur, sessionId: message.sessionId };
      await saveTaskState(state.projectRoot, ts);
    }
  }
  conductor.sessionId = message.sessionId;
  ```
- もしくは `assignTask` 側で `/clear` 送信後 SESSION_STARTED の到達を await する（既存の PidWatcher と類似の await 機構を導入）
- いずれにせよ Step 3 のテストに「/clear 後に SESSION_STARTED が届いたとき task-state.json の sessionId が更新される」テストを追加する

### Major (should fix)

**M1. plan 2.5 の「既存パスに委ねる」が実装と一致しない**

plan 2.5:

> daemon 側の queue ディスパッチで `discriminatedUnion` parse に失敗したら `log("queue_message_invalid", ...)` + skip する既存パスに委ねる

実コード確認（`proxy.ts:217-232`）:

```ts
try {
  const body = await req.json();
  const msg = QueueMessage.parse(body);
  await opts.onMessage(msg);
  return new Response(JSON.stringify({ ok: true }), ...);
} catch {
  return new Response(JSON.stringify({ error: "invalid body" }), { status: 400, ... });
}
```

**Zod 失敗は silent catch + 400 返却で、ログには残らない。** plan が言及する `log("queue_message_invalid", ...)` は存在しない。また file-based queue dispatcher も現在は存在しない（`rg "queue/incoming"` は e2e テストのみヒット）。

影響: 実害は小さい（古い CONDUCTOR_SESSION を送るクライアントは新 CLI には存在しない）が、plan の「安全に破壊的変更 OK」の根拠が誤っている。また将来 schema 変更で似たトラブルが起きた時に原因追跡ができなくなる。

修正方針:

- `proxy.ts:231` の catch 節で `await opts?.log?.(...)` 相当を追加するか、もしくは plan から「既存パス」の記述を削除して「proxy の HTTP 400 で silent reject される」と正確に書き直す
- リスク表の「古い CONDUCTOR_SESSION が来ても OK」の論拠を「新 CLI からは CONDUCTOR_SESSION 送信経路が物理的に消える」だけに絞る

**M2. 変更ファイル #20 `docs/spec/05-install-and-infrastructure.md:163` はそのままで良いと断ってあるが、docs/spec/01-skill-cmux-team.md:70 の CLI 一覧に `CONDUCTOR_SESSION` が残存している**

実 grep:

```
docs/spec/01-skill-cmux-team.md:70:| `cmux-team send <TYPE>` | 内部メッセージ通知（`TASK_CREATED / TASK_UPDATED / CONDUCTOR_DONE / CONDUCTOR_REGISTERED / CONDUCTOR_SESSION / AGENT_SPAWNED / SESSION_STARTED / ...
```

plan の変更ファイル一覧（#20 / #21）には 05- と 06- しか含まれていない。01- も併せて更新する必要がある。

### Minor (nice to have)

**m1. plan の変更ファイル一覧 #17 — `i18n.ts` への `CONDUCTOR_SESSION` 削除作業は**実際には no-op である

実 grep:

```
$ rg -n 'CONDUCTOR_SESSION' skills/cmux-team/manager/i18n.ts
(no matches)
```

i18n.ts は元々 CONDUCTOR_SESSION を help 本文に含んでいない（もともと記載漏れ）。plan は「grep で確認」と保険をかけているので実害はないが、「削除するものは無い」と明記した方が Implementer の迷いが減る。

**m2. Conductor hook の `--conductor-id "$CONDUCTOR_ID"` 保持が無意味**

plan Step 4.2 は Conductor の SessionStart hook command で `--conductor-id` を保持するが、`SessionStartedMessage` schema には `conductorId` フィールドが無いため、この引数は無視される（`buildMessageFromHookInput` も読まない）。保持する意図が不明。

対応案のどちらか:

- 保持する意味がないので削除する
- plan 2.4 の `source: z.enum(...)` 追加と合わせて `conductorId: z.string().optional()` を追加し、ログに出す

**m3. `conductor-id` を残すと `requireArg` / `getArg` の単体テストが将来増えたとき混乱する。plan の buildMessageFromHookInput テストに「余分な引数は無視される」ケースを 1 件追加しておくと防壊れ耐性が上がる。**

**m4. plan 5.3 E2E Step 3 の期待値**

> `.team/logs/manager.log` で `session_started source=clear session_id=<UUID2>` が記録されること、**task-state.json の sessionId が UUID2 になっていること**

後半の「task-state.json の sessionId が UUID2」は Critical C3 で指摘したとおり、Step 3 の実装だけでは保証されない。C3 の fix を入れた上で、この E2E 期待値を「task-state.json.sessionId が新 UUID に更新される」と明示すること。

**m5. plan の「2.6 source=startup の 2 重通知問題」は実質「問題なし」だけの節で情報量が薄い。削るか、「startup の 2 重通知シナリオは実在しない（1 Conductor プロセスにつき startup は 1 回のみ）」と断っておくと読み手に優しい。**

## Recommendations

Planner に以下の修正を依頼する:

1. **[C1] Step 4 に「matcher 変更」を追加する**:
   - `main.ts:1073` (Agent) / `main.ts:1131` (Conductor) の `matcher: "startup"` → `matcher: ""` に変更
   - 既存 regression テスト (`既存の SessionStart / Stop / SessionEnd hook が残存している`) に `settings.hooks.SessionStart[0].matcher === ""` の assert を追加
   - 変更ファイル一覧 #1 ~ #3 にこの変更を反映
2. **[C2] plan 2.3 の pseudocode を修正する**:
   - `const typeArg = args[1] && !args[1].startsWith("--") ? args[1] : undefined;` に差し替え
   - `buildMessageFromHookInput` のテストケースに「args=[send, --from-stdin] で typeArg=undefined → 旧 QueueMessageSchema パスへ」を追加
   - Step 2 の TDD 手順に本回帰ケースを明記
3. **[C3] Step 3 の daemon ハンドラ変更に task-state.json 同期更新を追加する**:
   - SESSION_STARTED ハンドラ内で、更新先 Conductor が `running` かつ `taskId` あり、かつ `message.sessionId` が既存値と異なる場合に `loadTaskState` → 該当エントリの sessionId を差し替え → `saveTaskState`
   - Step 3 テストに「assigned タスクに対する /clear シミュレーションで task-state.json.sessionId が更新される」ケースを追加
   - Risk 表の「race なし」の項目を削除し、「/clear → SessionStart hook 到達までの間に task-state.json への反映が遅延するが、SESSION_STARTED ハンドラで補足更新する」と書き換え
4. **[M1] plan 2.5 を書き直す**:
   - 「既存パスに委ねる」を削除し、「新 CLI から CONDUCTOR_SESSION 送信経路が物理的に消えるため、proxy で HTTP 400 (silent) を返すケース自体が発生しない」と記述
   - もしくは proxy.ts:231 の catch に validation 失敗ログを追加するタスクを plan に組み込む（小変更）
5. **[M2] 変更ファイル一覧 #20 に docs/spec/01-skill-cmux-team.md:70 を追加**する（CONDUCTOR_SESSION を CLI 一覧から削除）
6. **[m1-m5] Minor 指摘を取り込む**（任意）

修正後に再レビューを希望する。特に C1, C2, C3 は TDD ステップを修正した上で Step ごとの Red → Green 遷移が明示されているか再確認したい。

## Verification Notes

実コードで確認した事項（plan の記述と実装の整合）:

### C1 関連
```
$ rg -n 'matcher.*startup|SessionStart' skills/cmux-team/manager/main.ts | head
1061: * - SessionStart hook: SESSION_STARTED 送信（T195: PID 追跡に使う）
1071:      SessionStart: [
1073:          matcher: "startup",
1129:      SessionStart: [
1131:          matcher: "startup",
```

Claude Code docs 確認済み — `matcher` は `"startup"|"resume"|"clear"|"compact"` のいずれか 1 値ちょうどを取り、部分一致やワイルドカードのサポートは記載なし。既存 `Stop: [{ matcher: "", ... }]` が有効なので空文字は受け付けられる。

### C2 関連
```
$ rg -n 'cmux-team send --from-stdin' skills/cmux-team/manager/main.ts
1041:  '  | cmux-team send --from-stdin 2>/dev/null || true',
```

T189 SESSION_STOP forwarder は type 引数なしで呼んでいる。`const args = process.argv.slice(2);` → `args[0]="send", args[1]="--from-stdin"`。plan の `if (typeArg)` は truthy と判定されて新パスに入り、hook JSON parse → SESSION_STOP 互換性破壊が起こる。

### C3 関連
```ts
// conductor.ts:425-438 — assignTask 内で /clear が送られる（status は idle のまま）
await cmux.send(conductor.surface, "/clear");
await sleep(500);
await cmux.sendKey(conductor.surface, "return");
await sleep(2000);
await cmux.send(conductor.surface, `${promptFile} を読んで...`);
// conductor.status = "running"; は L469（return 直前）
```

```ts
// daemon.ts:1260-1273 — scanTasks は assignTask 直後に task-state.json を書き込む
state.conductors.set(updated.surface, updated);
ts[task.id] = { ..., sessionId: updated.sessionId };
await saveTaskState(state.projectRoot, ts);
```

```ts
// daemon.ts:742-795 — SESSION_STARTED ハンドラは現状 pid のみ更新、sessionId は触らない
// idle → idle のままで特に状態遷移なし（L754-773）
```

3 秒の sleep 中に hook が到達すれば OK だが、到達を待つ機構は存在しない。

### M1 関連
```ts
// proxy.ts:226-233
try {
  const body = await req.json();
  const msg = QueueMessage.parse(body);
  await opts.onMessage(msg);
  return new Response(JSON.stringify({ ok: true }), ...);
} catch {
  return new Response(JSON.stringify({ error: "invalid body" }), { status: 400, ... });
}
```

silent catch。plan の「`log("queue_message_invalid", ...)` に委ねる」は事実誤認。

```
$ rg -n 'queue/incoming|queue/processed|readQueueMessages' skills/cmux-team/manager/
e2e.ts:122,203 のみヒット。runtime queue dispatcher は無い。
```

### M2 関連
```
$ rg -n 'CONDUCTOR_SESSION' docs/spec/
docs/spec/01-skill-cmux-team.md:70:...CONDUCTOR_SESSION ...
docs/spec/05-install-and-infrastructure.md:221:...CONDUCTOR_SESSION ...
```

plan の変更ファイル一覧には 05 のみ含まれる。01 も更新対象。

### m1 関連
```
$ rg -n 'CONDUCTOR_SESSION' skills/cmux-team/manager/i18n.ts
(no matches)
```

i18n.ts に CONDUCTOR_SESSION の記載なし。plan item #17 は no-op。

### 既存テスト構造
```
$ rg -n 'describe\(' skills/cmux-team/manager/daemon.test.ts | tail -10
986: describe("SESSION_CLEAR: pid リセット (T195)", ...)
1011: describe("Agent SESSION_STARTED (T195)", ...)
1051: describe("createDaemon: layout (T176)", ...)
```

plan Step 3 で追加する `describe("SESSION_STARTED で sessionId 更新 (T203)")` は既存の T195 Agent SESSION_STARTED テストの直後に入れるのが自然。

```
$ rg -n 'describe\(' skills/cmux-team/manager/main.test.ts | head
27: describe("generateConductorSettings - PreToolUse hook (§4.1)", ...)
87: describe("PreToolUse hook 挙動 (§4.2)", ...)
```

plan Step 2 の `describe("buildMessageFromHookInput")` は既存構造と整合する位置に追加可能。

### その他確認
- `task-state.json.sessionId` は現状 `daemon.ts:1271` (`scanTasks`) 以外では更新されない — C3 の修正が必要な論拠
- `conductor.ts:470, 557` のコメントは plan 通り修正対象
- `proxy.ts:246-265` の agent.sessionId mutation は plan 通り削除対象（trace 用 sessionId 変数は直下で使われていないため変数ごと不要になる可能性、実装時に要確認）
- `cmdResume` の `execFileSync` は `cwd: ts.worktreePath` を使う（`main.ts:1338`）— 本タスクの非目標。OK
