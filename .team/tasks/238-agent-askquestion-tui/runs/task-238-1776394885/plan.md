# T238 実装計画: Agent AskQuestion 時の通知と TUI 強調

## 概要

Conductor 側で既に動作している `asking` パターン（YELLOW 表示 + `askQuestion` 状態保持）を Agent 側に展開し、追加で `cmux notify` による OS 通知を Agent surface に飛ばす。Agent の解除経路は新設せず、既存の `SESSION_STARTED` (running) / `SESSION_IDLE` (idle) の自然上書きに委ねる（best-effort 設計）。

設計方針:
- **既存 Conductor 実装の対称化**: `daemon.ts:1572-1581` を Agent 分岐 (`daemon.ts:1584-1604`) に水平展開
- **schema 拡張は最小**: `AgentState.status` に `"asking"` を追加するだけ（`askQuestion` フィールドは Agent には設けない — TUI には Conductor 行と違い質問本文は描かないため）
- **通知は best-effort**: `cmux notify` 失敗は `log("error", ...)` で握りつぶす
- **Conductor 側挙動は不変**: 既に動作しているため touch しない

## 影響ファイル一覧

| ファイル | 修正概要 |
|---------|---------|
| `skills/cmux-team/manager/schema.ts` | `AgentState.status` に `"asking"` を追加 |
| `skills/cmux-team/manager/cmux.ts` | `notify()` ラッパー関数を新規追加（best-effort） |
| `skills/cmux-team/manager/daemon.ts` | SESSION_ASK の Agent 分岐に status 遷移 / notify spawn / notifyStateChanged を追加 |
| `skills/cmux-team/manager/dashboard.tsx` | Agent 行レンダリングに `status === "asking"` 分岐を追加 |
| `skills/cmux-team/manager/daemon.test.ts` | SESSION_ASK Agent 分岐の assertion を追加 |

## 各ファイルの詳細変更

### 1. `skills/cmux-team/manager/schema.ts`

Agent の `status` 列挙に `"asking"` を追加。

**before** (`schema.ts:148-159`):
```ts
export interface AgentState {
  surface: string;
  role?: string;
  taskTitle?: string;
  spawnedAt: string;
  sessionId?: string;
  pid?: number;
  pidWatcherInterval?: ReturnType<typeof setInterval>;
  // T236: TUI spinner のために Conductor と対称の status を持つ。
  // AGENT_SPAWNED で "starting"、SESSION_STARTED で "running"、SESSION_IDLE で "idle"。
  status: "starting" | "running" | "idle";
}
```

**after**:
```ts
export interface AgentState {
  surface: string;
  role?: string;
  taskTitle?: string;
  spawnedAt: string;
  sessionId?: string;
  pid?: number;
  pidWatcherInterval?: ReturnType<typeof setInterval>;
  // T236: TUI spinner のために Conductor と対称の status を持つ。
  // AGENT_SPAWNED で "starting"、SESSION_STARTED で "running"、SESSION_IDLE で "idle"。
  // T238: SESSION_ASK で "asking"。SESSION_STARTED/IDLE で自然上書きにより解除される。
  status: "starting" | "running" | "idle" | "asking";
}
```

互換性: 永続ファイルに旧 status (`starting/running/idle`) しか書かれていなくても問題ない。"asking" は揮発状態であり、daemon 再起動後は SESSION_STARTED / SESSION_IDLE で再構築される（task body の非ゴール参照）。

---

### 2. `skills/cmux-team/manager/cmux.ts`

`cmux notify` を呼ぶラッパー関数を追加。既存の `setStatus` (244-258 行) と同じパターンで失敗を `log("error", ...)` で握りつぶす（best-effort）。

**追加位置**: `clearStatus` (260-271 行) の直後

**追加コード**:
```ts
/**
 * cmux notify を実行して OS 通知を送る (T238)。
 * best-effort: 失敗時は log するのみで throw しない。
 *
 * @param surface 通知先 surface（例: agent surface）
 * @param title 通知タイトル
 * @param subtitle サブタイトル（任意）
 * @param body 本文（任意。長文は呼び出し元で truncate しておく）
 */
export async function notify(
  surface: string,
  title: string,
  body?: string,
  opts?: { subtitle?: string; workspace?: string },
): Promise<void> {
  const args = ["notify", "--surface", surface, "--title", title];
  if (opts?.subtitle) args.push("--subtitle", opts.subtitle);
  if (body) args.push("--body", body);
  if (opts?.workspace) args.push("--workspace", opts.workspace);
  try {
    await runCmux(args);
  } catch (e: any) {
    await log("error", `notify failed: ${formatSurface(surface, "S")} ${formatExecError(e)}`);
  }
}
```

なぜ `surface` を引数に取るか: task body で「通知先 surface は Agent surface（ユーザー確認済み）」と明示されている。`cmux notify` の `--surface` は ID/ref を受け取る（`cmux notify --help` で確認済み）。

なぜ `setStatus` と同じ握りつぶしパターンか: 通知失敗で daemon を止めたくない。失敗してもログさえ残れば原因追跡可能（ロギングポリシー準拠）。

---

### 3. `skills/cmux-team/manager/daemon.ts`

SESSION_ASK の Agent 分岐 (1584-1604 行) に以下を追加:

1. `agent.status = "asking"` セット
2. `notifyStateChanged(...)` 呼び出し
3. `cmux.notify(...)` を `void` で fire-and-forget spawn

**before** (`daemon.ts:1584-1604`):
```ts
      // 3) Agent surface か判定
      let matched = false;
      for (const c of state.conductors.values()) {
        const agent = c.agents.find(a => a.surface === message.surface);
        if (!agent) continue;
        matched = true;
        try {
          await writeAgentDone(state.projectRoot, c.surface, agent.surface, {
            status: "ask",
            question: message.question,
          });
        } catch (e: any) {
          await log("error", `writeAgentDone failed (session_ask): ${e.message}`);
        }
        await log(
          "agent_ask",
          `${formatPair(c.surface, agent.surface, "C", "A")} question=${truncate(message.question, 120)}`
        );
        // Agent surface は閉じない（Conductor が await-agent で STATUS=ask を受けて対処）
        break;
      }
```

**after**:
```ts
      // 3) Agent surface か判定
      let matched = false;
      for (const c of state.conductors.values()) {
        const agent = c.agents.find(a => a.surface === message.surface);
        if (!agent) continue;
        matched = true;
        try {
          await writeAgentDone(state.projectRoot, c.surface, agent.surface, {
            status: "ask",
            question: message.question,
          });
        } catch (e: any) {
          await log("error", `writeAgentDone failed (session_ask): ${e.message}`);
        }
        // T238: TUI spinner / 色変更のための status 遷移。
        //       SESSION_STARTED (running) / SESSION_IDLE (idle) の自然上書きで解除される。
        agent.status = "asking";
        notifyStateChanged("daemon.ts:handleMessage:session-ask-agent");
        // T238: OS 通知を Agent surface に送る (best-effort)。
        //       await しない fire-and-forget — 通知の遅延で他メッセージ処理を止めない。
        const subtitle = agent.taskTitle ?? agent.role ?? "Agent";
        const body = truncate(message.question, 200);
        void cmux.notify(message.surface, "Agent asking", body, { subtitle });
        await log(
          "agent_ask",
          `${formatPair(c.surface, agent.surface, "C", "A")} question=${truncate(message.question, 120)}`
        );
        // Agent surface は閉じない（Conductor が await-agent で STATUS=ask を受けて対処）
        break;
      }
```

**変更ポイント解説**:

- `agent.status = "asking"`: dashboard.tsx で YELLOW 表示の判定に使う
- `notifyStateChanged("daemon.ts:handleMessage:session-ask-agent")`: TUI 即時 refresh（既存 conductor 分岐 1576 行と同じ source 命名規則）
- `void cmux.notify(...)`: fire-and-forget。`cmux.notify` 内部で例外は握りつぶされるため `void` で十分。`await` しない理由は、通知 spawn が遅延すると後続メッセージ処理を block してしまうため
- `subtitle` に `agent.taskTitle ?? agent.role ?? "Agent"` を入れる（task body の「subtitle: role or task title」指示に準拠）
- `body` は `truncate(message.question, 200)` で切り詰め（OS 通知の長文表示は環境依存のため安全側）
- 既存の `writeAgentDone` + `agent_ask` ログは task body の指示通り変更しない

**既存 Conductor 実装との対応関係** (`daemon.ts:1572-1581`):

| Conductor 側 | Agent 側 (本変更) |
|---|---|
| `conductor.askQuestion = message.question` | （Agent には保持しない — TUI に質問本文を描かないため） |
| `conductor.status = "asking"` | `agent.status = "asking"` |
| `if (message.pid) conductor.pid = message.pid` | （Agent 側は SESSION_STARTED で更新済みのため省略 — task body 指示に従う） |
| `conductor.disconnectedAt = undefined` | （Agent には disconnected 状態がないため不要） |
| `notifyStateChanged("daemon.ts:handleMessage:session-ask-conductor")` | `notifyStateChanged("daemon.ts:handleMessage:session-ask-agent")` |
| `log("conductor_asking", ...)` | （既存 `log("agent_ask", ...)` を流用 — task body 指示） |
| (なし) | `void cmux.notify(...)` ← 新規追加 |

**解除経路（新規コード不要）**:
- `daemon.ts:1144-1145` の Agent SESSION_STARTED 分岐で `agent.status = "running"` が既存 → asking から自然上書き
- `daemon.ts:1542-1543` の Agent SESSION_IDLE 分岐で `agent.status = "idle"` が既存 → asking から自然上書き

---

### 4. `skills/cmux-team/manager/dashboard.tsx`

Agent 行レンダリングに `status === "asking"` 分岐を追加。Conductor 行 444 行 (`ui.text("asking", { style: { fg: YELLOW } })`) と同じスタイルを使う。

**before** (`dashboard.tsx:504-525`):
```tsx
    // T236: status に応じて spinner / role アイコンを切り替え。
    //       status undefined は古い team.json 復元経路で起きうる → idle 相当で描画。
    const isAgentRunning = a.status === "running" || a.status === "starting";
    if (isAgentRunning) {
      const spinChar = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]!;
      children.push(
        ui.row({ gap: 1 }, [
          ui.text(`   ${prefix}`, { dim: true }),
          ui.text(`[${a.surface.replace("surface:", "")}]`, { style: { fg: CYAN } }),
          ui.text(spinChar, { style: { fg: CYAN } }),
          ui.text(label),
        ])
      );
    } else {
      children.push(
        ui.row({ gap: 1 }, [
          ui.text(`   ${prefix}`, { dim: true }),
          ui.text(`[${a.surface.replace("surface:", "")}]`, { style: { fg: CYAN } }),
          ui.text(`${roleIcon} ${label}`, { dim: true }),
        ])
      );
    }
```

**after**:
```tsx
    // T236: status に応じて spinner / role アイコンを切り替え。
    //       status undefined は古い team.json 復元経路で起きうる → idle 相当で描画。
    // T238: status === "asking" のときは YELLOW + ? マーク + ラベル YELLOW で強調。
    const isAgentAsking = a.status === "asking";
    const isAgentRunning = a.status === "running" || a.status === "starting";
    if (isAgentAsking) {
      children.push(
        ui.row({ gap: 1 }, [
          ui.text(`   ${prefix}`, { dim: true }),
          ui.text(`[${a.surface.replace("surface:", "")}]`, { style: { fg: YELLOW } }),
          ui.text("?", { style: { fg: YELLOW } }),
          ui.text(`${roleIcon} ${label}`, { style: { fg: YELLOW } }),
        ])
      );
    } else if (isAgentRunning) {
      const spinChar = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]!;
      children.push(
        ui.row({ gap: 1 }, [
          ui.text(`   ${prefix}`, { dim: true }),
          ui.text(`[${a.surface.replace("surface:", "")}]`, { style: { fg: CYAN } }),
          ui.text(spinChar, { style: { fg: CYAN } }),
          ui.text(label),
        ])
      );
    } else {
      children.push(
        ui.row({ gap: 1 }, [
          ui.text(`   ${prefix}`, { dim: true }),
          ui.text(`[${a.surface.replace("surface:", "")}]`, { style: { fg: CYAN } }),
          ui.text(`${roleIcon} ${label}`, { dim: true }),
        ])
      );
    }
```

**スタイル選択の根拠**:
- マーク: `?` を採用（task body で `?` または `!` から選択可とあり、Conductor 行 453 行も `?` を使用しているため統一）
- 色: `YELLOW`（Conductor 行 444 行と完全一致）
- role icon は `roleIcon` を保持しつつ YELLOW で塗る（Agent の役割を見失わないため）
- spinner は出さない（asking は静的状態であり、回転表示は混乱を招く）

**Conductor 行との違い**:
- Agent 行は質問本文 (`?` プレフィックス + 本文) を描かない（dashboard 縦幅節約のため。本文は OS 通知側で見せる）
- elapsed 時間も描かない（Agent 行は元から elapsed を出していないため対称）

---

### 5. `skills/cmux-team/manager/daemon.test.ts`

既存の `describe("handleMessage: SESSION_STOP (T189)", () => {...})` ブロック (1420 行〜) 内、`test("Agent / Case A (ASK) → writeAgentDone(status=ask) が呼ばれる", ...)` (1427 行〜) に assertion を追加する。

**追加 assertion** (test ブロックの末尾、1465 行 `});` の直前):
```ts
    // T238: agent.status が "asking" に遷移している
    const updatedAgent = conductor.agents.find(a => a.surface === "surface:a1");
    expect(updatedAgent?.status).toBe("asking");
```

**`cmux.notify` 呼び出しの検証**:

`cmux` モジュール全体は test では実コマンドが呼ばれない構造（`__setTreeImpl` / `__setIsAliveImpl` のみがテスト用差し替えポイント）だが、`cmux.notify` は `runCmux` を直接呼ぶため、実際には execFile が走る。CI で `cmux` バイナリが無い環境では失敗するが best-effort 設計のためログのみで test は通る。

ただし副作用検証のため、以下の追加対応が望ましい（**plan の推奨事項として記載、実装者判断**）:

オプション A（最小）: `cmux.notify` の呼び出し検証はせず、`agent.status === "asking"` のみ確認する（task body の指示範囲）

オプション B（厳密）: `cmux.ts` に `__setNotifyImpl` テストフックを追加し、test では mock を inject。ただし他の関数（send/sendKey 等）が同等のフック未整備のため、整合性のためには見送り推奨

→ **推奨はオプション A**。`cmux.notify` の失敗は `log("error", ...)` に出るので運用面で追跡可能。

**新規 test の追加（任意推奨）**: SESSION_ASK Agent 分岐を直接叩く test
```ts
  test("T238: Agent SESSION_ASK → agent.status='asking' に遷移", async () => {
    const state = await createDaemon(testDir);
    const conductor: ConductorState = {
      surface: "surface:c1",
      startedAt: new Date().toISOString(),
      agents: [{ surface: "surface:a1", spawnedAt: new Date().toISOString(), status: "running" as const }],
      status: "running",
    };
    state.conductors.set(conductor.surface, conductor);

    await handleMessage(state, {
      type: "SESSION_ASK",
      surface: "surface:a1",
      question: "どちらにしますか?",
      pid: 123,
      timestamp: new Date().toISOString(),
    });

    expect(conductor.agents[0]!.status).toBe("asking");
    // SESSION_STARTED で running に自然解除される
    await handleMessage(state, {
      type: "SESSION_STARTED",
      surface: "surface:a1",
      pid: 123,
      timestamp: new Date().toISOString(),
    });
    expect(conductor.agents[0]!.status).toBe("running");
  });
```

この test は `describe("handleMessage: SESSION_STOP (T189)", ...)` の外、独立した `describe("T238: Agent asking 状態遷移", () => {...})` ブロックを新設して入れることを推奨。

---

## 検証手順

### 単体テスト
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-238-1776394885/skills/cmux-team/manager
bun test daemon.test.ts -t "ASK"
```

期待結果:
- 既存 `Agent / Case A (ASK)` test に追加した `agent.status === "asking"` assertion が pass
- 新規 `T238: Agent SESSION_ASK` test が pass

### 型チェック
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-238-1776394885/skills/cmux-team/manager
bun run tsc --noEmit
```
期待: schema.ts の status union 拡張で daemon.ts / dashboard.tsx の参照箇所が型エラーにならないこと。

### E2E 手動検証

1. KDG-lab 等の別セッションで cmux-team を起動し、Agent に AskUserQuestion を踏ませる
   - もしくは daemon に直接 SESSION_ASK を流す（最小再現）:
     ```bash
     cmux-team send '{"type":"SESSION_ASK","surface":"<agent-surface>","question":"テスト?","pid":1,"timestamp":"2026-04-17T00:00:00.000Z"}' --from-stdin
     ```
2. macOS 通知センターに「Agent asking」通知が出ることを確認
3. TUI ダッシュボードで該当 Agent 行が YELLOW + `?` で表示されることを確認
4. Conductor が応答を Agent に送り、Agent が再開（次の SESSION_STARTED）した時点で行が CYAN spinner（running）に戻ることを確認
5. Agent が完了して SESSION_IDLE に遷移したら role icon + dim ラベル（idle）に戻ることを確認

### ログ確認
```bash
tail -f /Users/yamamoto/git/cmux-team/.team/logs/manager.log | grep -E "agent_ask|notify"
```
期待: `agent_ask C[XXX]>A[YYY] question=...` が出力され、`notify failed` が出ていないこと。

---

## 制約と非ゴール（再掲）

- **コード変更は本 plan では行わない**（plan.md 作成のみ）
- 既存 Conductor 側挙動（`daemon.ts:1572-1581`, `dashboard.tsx:444`）は変更しない
- `cmux notify` 失敗は best-effort で握りつぶす
- asking 解除の明示 API は追加しない（SESSION_STARTED/IDLE で自然解除）
- 永続ファイル後方互換: 旧 status 値で永続化された AgentState を読んでも問題ない（status は揮発状態として扱われ、SESSION_STARTED/IDLE で上書きされる）
