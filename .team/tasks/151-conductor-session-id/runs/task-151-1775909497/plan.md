# T151 実装計画: Conductor 起動関数統合 + session-id 自己生成

## 概要

Conductor 起動に存在する3つの関数（`spawnSingleConductor`, `launchConductorOnSurface`, `spawnConductor`）を1つの `launchConductor()` に統合し、session-id の生成責務を Manager 側から `cmdConductor()` 自身に移す。

---

## 変更対象ファイル一覧

| ファイル | 変更概要 |
|---------|---------|
| `skills/cmux-team/manager/schema.ts` | `ConductorSessionMessage` 型追加、`QueueMessage` union に追加 |
| `skills/cmux-team/manager/conductor.ts` | 3関数 → `launchConductor()` に統合、`spawnConductor` 削除、`initializeConductorSlots` 簡素化、`assignTask` の non-null assertion 修正 |
| `skills/cmux-team/manager/main.ts` | `cmdConductor()` で sessionId 自己生成 + HTTP 通知、abort/restart から `--session-id` 引数・直接設定を削除、`cmdSend` に `CONDUCTOR_SESSION` 対応追加、`cmdSpawnConductor` の呼び出し先変更 |
| `skills/cmux-team/manager/daemon.ts` | `CONDUCTOR_SESSION` ハンドラ追加、pidWatcher の sessionId クリア維持方針変更 |

---

## Step 1: schema.ts — ConductorSessionMessage 型追加

**ファイル:** `skills/cmux-team/manager/schema.ts`

### 1-1. 新メッセージ型追加（L75 付近、SessionClearMessage の後）

```typescript
export const ConductorSessionMessage = z.object({
  type: z.literal("CONDUCTOR_SESSION"),
  surface: z.string(),
  sessionId: z.string(),
  timestamp: z.string().datetime(),
});
```

### 1-2. QueueMessage union (L82-93) に追加

```typescript
export const QueueMessage = z.discriminatedUnion("type", [
  TaskCreatedMessage,
  ConductorDoneMessage,
  ConductorRegisteredMessage,
  AgentSpawnedMessage,
  SessionStartedMessage,
  SessionEndedMessage,
  SessionActiveMessage,
  SessionIdleMessage,
  SessionClearMessage,
  ConductorSessionMessage,  // ← 追加
  ShutdownMessage,
]);
```

### 1-3. 型 export 追加

```typescript
export type ConductorSessionMessage = z.infer<typeof ConductorSessionMessage>;
```

---

## Step 2: conductor.ts — 起動関数の統合 + defensive 修正

**ファイル:** `skills/cmux-team/manager/conductor.ts`

### 2-1. 削除する関数

| 関数 | 行番号 | 理由 |
|------|--------|------|
| `spawnSingleConductor` | L69-110 | `launchConductor` に統合 |
| `launchConductorOnSurface` | L147-182 | `launchConductor` に統合 |
| `spawnConductor` | L555-598 | 外部から未使用（Grep で確認済み）。削除 |

### 2-2. 新規追加: `launchConductor`（旧 spawnSingleConductor の位置 L69 付近）

```typescript
/**
 * 指定 surface 上で Conductor Claude セッションを起動する。
 * - CONDUCTOR_REGISTERED を HTTP API 経由で daemon に送信
 * - 環境変数をシェルに焼き付け
 * - `cmux-team conductor` を起動（session-id は cmdConductor が自己生成）
 * - タブ名を設定
 */
export async function launchConductor(
  projectRoot: string,
  surface: string,
  paneId?: string,
): Promise<void> {
  // 0. paneId が未指定の場合（cmdSpawnConductor 経由等）、surface から解決する
  if (!paneId) {
    paneId = await getPaneIdForSurface(surface);
  }

  // 1. CONDUCTOR_REGISTERED を HTTP API 経由で送信
  try {
    const portFile = join(projectRoot, ".team/proxy-port");
    const port = (await readFile(portFile, "utf-8")).trim();
    await fetch(`http://localhost:${port}/api/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "CONDUCTOR_REGISTERED",
        surface,
        paneId: paneId ?? "",
        timestamp: new Date().toISOString(),
      }),
    });
  } catch (e: any) {
    await log("error", `CONDUCTOR_REGISTERED send failed: surface=${surface} ${e.message}`);
  }

  // 2. 環境変数をシェルに焼き付け
  //    CMUX_SURFACE: cmdConductor が読み取る（必須）。hook も参照する
  //    CMUX_CLAUDE_HOOKS_DISABLED: 統一（旧 spawnSingleConductor のみ欠落していた）
  await cmux.send(surface, `export CMUX_SURFACE=${surface} CMUX_CLAUDE_HOOKS_DISABLED=1\n`);
  await sleep(500);

  // 3. Claude 起動（--session-id なし — cmdConductor が自己生成して daemon に通知する）
  await cmux.send(surface, `cmux-team conductor\n`);

  // 4. タブ名設定
  const num = surface.replace("surface:", "");
  await cmux.renameTab(surface, `[${num}] ♦ idle`);
}
```

**統合時の判断:**
- **paneId 自動解決**: `cmdSpawnConductor` 経由で呼ばれる場合に paneId が渡されないため、先頭で `getPaneIdForSurface` を呼んで解決する。`initializeConductorSlots` 経由では paneId が既に判明しているため無駄な呼び出しを避けられる
- **CMUX_CLAUDE_HOOKS_DISABLED=1**: 常に設定する。旧 `launchConductorOnSurface` と `spawnConductor` は設定していたが `spawnSingleConductor` のみ欠落していた。`cmdConductor()` 内でも `process.env.CMUX_CLAUDE_HOOKS_DISABLED = "1"` (main.ts L833) で設定されるため二重だが、シェルレベルでも設定しておくことで一貫性を持たせる
- **返り値は `void`**: sessionId を返す必要がなくなったため。旧 `spawnSingleConductor` は `ConductorState` を返していたが、`cmdSpawnConductor` ではsurface名だけ必要で、ConductorState 全体は不要
- **--session-id 引数なし**: `cmdConductor()` が UUID を自己生成

### 2-3. `initializeConductorSlots` の変更 (L186-234)

**変更前（L200-228）:**
```typescript
// Phase 2: Claude 一斉起動
const sessionIds = new Map<string, string>();
for (const pane of panes) {
  const sid = await launchConductorOnSurface(projectRoot, pane.surface, pane.paneId);
  sessionIds.set(pane.surface, sid);
}

// フォールバック: ...
for (const pane of panes) {
  const existing = conductors.get(pane.surface);
  if (existing) {
    if (!existing.sessionId) {
      existing.sessionId = sessionIds.get(pane.surface);
    }
  } else {
    conductors.set(pane.surface, {
      ...,
      sessionId: sessionIds.get(pane.surface),
    });
  }
}
```

**変更後:**
```typescript
// Phase 2: Claude 一斉起動
for (const pane of panes) {
  await launchConductor(projectRoot, pane.surface, pane.paneId);
}

// フォールバック: CONDUCTOR_REGISTERED の HTTP POST が失敗した場合に備え
for (const pane of panes) {
  if (!conductors.has(pane.surface)) {
    await log("conductor_registered_fallback", `surface=${pane.surface}`);
    conductors.set(pane.surface, {
      surface: pane.surface,
      paneId: pane.paneId,
      status: "starting",
      startedAt: new Date().toISOString(),
      agents: [],
      // sessionId なし — CONDUCTOR_SESSION メッセージで後から設定される
    });
  }
}
```

**削除:**
- `sessionIds` Map（L202）
- フォールバック内の `existing.sessionId` 補完（L213-215）
- ConductorState 初期値の `sessionId` フィールド（L225）

### 2-4. `assignTask` の non-null assertion 修正 (L397)

**変更前:**
```typescript
session_id: conductor.sessionId!,
```

**変更後:**
```typescript
session_id: conductor.sessionId ?? "",
```

**理由:** CONDUCTOR_SESSION メッセージの HTTP POST が失敗した場合、`conductor.sessionId` が undefined のままタスクが割り当てられる可能性がある。non-null assertion (`!`) だとランタイムで undefined が渡されてしまうが、`?? ""` にすることで安全にフォールバックできる。トレースDB への挿入が失敗しないことが重要。

### 2-5. `resetConductor` は変更しない

**`resetConductor`（L448-513）の `sessionId` に関する変更は行わない。** 現行のコード（`sessionId` を保持）をそのまま維持する。

```typescript
// 現行コード（変更なし）:
// sessionId は初回起動時に発行済み — reset で消さない（常駐セッション）
```

**理由:** 通常のタスク完了フローでは Conductor セッションは再起動されず、`/clear` で待機するだけである。`resetConductor` で `sessionId = undefined` にすると、次タスクの resume が不可能になる。Conductor が実際に再起動される場合（abort/restart）は、`cmdConductor` が新しい `sessionId` を生成し CONDUCTOR_SESSION メッセージで daemon に通知するため、自然に上書きされる。

---

## Step 3: main.ts — cmdConductor の自己生成 + abort/restart 変更

**ファイル:** `skills/cmux-team/manager/main.ts`

### 3-1. import 変更 (L33)

```typescript
// 変更前:
import { spawnSingleConductor } from "./conductor";

// 変更後:
import { launchConductor } from "./conductor";
```

### 3-2. `cmdConductor()` の変更 (L817-879)

**L844 の変更:**
```typescript
// 変更前:
const sessionId = getArg("session-id");

// 変更後:
const sessionId = crypto.randomUUID();
```

**L844 の後に追加（daemon への HTTP 通知）:**
```typescript
// daemon に CONDUCTOR_SESSION を通知（fire-and-forget ではなく await）
// cmdConductor は execFileSync で claude を起動するため、ここで await しても問題ない
try {
  const portFile = join(PROJECT_ROOT, ".team/proxy-port");
  if (existsSync(portFile)) {
    const port = (await readFile(portFile, "utf-8")).trim();
    await fetch(`http://localhost:${port}/api/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "CONDUCTOR_SESSION",
        surface,
        sessionId,
        timestamp: new Date().toISOString(),
      }),
    });
  }
} catch {
  // daemon 未起動時は無視（Claude 起動は続行）
}
```

**L857-859 の変更:**
```typescript
// 変更前:
if (sessionId) {
  claudeArgs.push("--session-id", sessionId);
}

// 変更後:
claudeArgs.push("--session-id", sessionId);
```

条件分岐を削除。sessionId は常に存在する。

### 3-3. `cmdAbortTask()` の変更 (L1568-1573)

**変更前:**
```typescript
// 8. Conductor を再起動（新しいセッション + 新しい session-id）
const newSessionId = crypto.randomUUID();
await cmux.send(conductor.surface, `export CMUX_SURFACE=${conductor.surface}\n`);
await sleep(500);
await cmux.send(conductor.surface, `cmux-team conductor --session-id ${newSessionId}\n`);
conductor.sessionId = newSessionId;
```

**変更後:**
```typescript
// 8. Conductor を再起動（session-id は cmdConductor が自己生成して daemon に通知する）
await cmux.send(conductor.surface, `export CMUX_SURFACE=${conductor.surface} CMUX_CLAUDE_HOOKS_DISABLED=1\n`);
await sleep(500);
await cmux.send(conductor.surface, `cmux-team conductor\n`);
```

**削除:** `newSessionId` 生成、`--session-id` 引数、`conductor.sessionId = newSessionId`
**追加:** `CMUX_CLAUDE_HOOKS_DISABLED=1`（launchConductor と統一）

### 3-4. `cmdRestartTask()` の変更 (L1653-1658)

abort と同一パターン:

**変更前:**
```typescript
// 6. Conductor を再起動（新しいセッション + 新しい session-id）
const newSessionId = crypto.randomUUID();
await cmux.send(conductor.surface, `export CMUX_SURFACE=${conductor.surface}\n`);
await sleep(500);
await cmux.send(conductor.surface, `cmux-team conductor --session-id ${newSessionId}\n`);
conductor.sessionId = newSessionId;
```

**変更後:**
```typescript
// 6. Conductor を再起動（session-id は cmdConductor が自己生成して daemon に通知する）
await cmux.send(conductor.surface, `export CMUX_SURFACE=${conductor.surface} CMUX_CLAUDE_HOOKS_DISABLED=1\n`);
await sleep(500);
await cmux.send(conductor.surface, `cmux-team conductor\n`);
```

### 3-5. `cmdSend()` に CONDUCTOR_SESSION 対応追加 (L521-626)

switch 文に追加（CONDUCTOR_REGISTERED case の後）:

```typescript
case "CONDUCTOR_SESSION":
  message = {
    type: "CONDUCTOR_SESSION",
    surface: requireArg("surface"),
    sessionId: requireArg("session-id"),
    timestamp: now,
  };
  break;
```

L624 の usage メッセージにも `CONDUCTOR_SESSION` を追加。

### 3-6. `cmdSpawnConductor()` の変更 (L1003-1009)

```typescript
// 変更前:
const result = await spawnSingleConductor(PROJECT_ROOT, surface);
console.log(`SURFACE=${result.surface}`);

// 変更後:
await launchConductor(PROJECT_ROOT, surface);
console.log(`SURFACE=${surface}`);
```

---

## Step 4: daemon.ts — CONDUCTOR_SESSION ハンドラ追加

**ファイル:** `skills/cmux-team/manager/daemon.ts`

### 4-1. CONDUCTOR_SESSION ハンドラ追加（handleMessage 内、CONDUCTOR_REGISTERED case の後 L558 付近）

```typescript
case "CONDUCTOR_SESSION": {
  const conductor = findConductor(state, message.surface);
  if (conductor) {
    conductor.sessionId = message.sessionId;
    await log(
      "conductor_session",
      `surface=${message.surface} session_id=${message.sessionId}`
    );
  } else {
    await log(
      "conductor_session_ignored",
      `surface=${message.surface} reason=conductor_not_found`
    );
  }
  break;
}
```

### 4-2. pidWatcher の sessionId クリア (L860-864)

**変更前:**
```typescript
conductor.sessionId = undefined;
```

**変更後:**
```typescript
// sessionId は保持する（resume で必要）。
// Conductor 再起動時に CONDUCTOR_SESSION メッセージで新しい値に上書きされる。
```

**理由:** disconnected 後に resume する場合、task-state.json に記録済みの sessionId が使われるため直接的な影響はない。しかし、ConductorState の sessionId が undefined になると、updateTeamJson() で team.json に反映される際に sessionId が消え、abort/restart の team.json 読み取り経路（L1503-1512）で不整合が生じる可能性がある。resume 時は既存の sessionId を使うのが正しいため、保持が安全。

---

## エッジケースの対応

### E1: CONDUCTOR_SESSION が daemon に届く前のタスク割り当て

**シナリオ:** `cmdConductor` の HTTP POST より先に SESSION_STARTED が届き、Conductor が idle になってタスクが割り当てられる

**分析:**
1. `cmdConductor()` は同期的に HTTP POST を `await` してから `execFileSync("claude", ...)` を呼ぶ
2. Claude 起動 → hook が SESSION_STARTED を送信 → daemon が idle に遷移
3. したがって CONDUCTOR_SESSION は SESSION_STARTED より**必ず先に**到達する

**結論:** タイミング問題は起きない。HTTP POST 失敗のケースに備え、Step 2-4 で `assignTask` の `conductor.sessionId!` を `conductor.sessionId ?? ""` に変更済み。

### E2: HTTP 通知失敗

`cmdConductor` の `fetch` が失敗しても Claude 起動は続行する。daemon 側の `conductor.sessionId` は undefined のままだが:
- タスク割り当て自体は sessionId に依存しない
- `assignTask` のトレースDB挿入は `conductor.sessionId ?? ""` で安全にフォールバックする（Step 2-4）
- resume 用の sessionId が task-state.json に記録されない可能性はあるが、cmdConductor 内で生成した sessionId は claude の `--session-id` に渡されているので、Claude セッション自体は有効

### E3: daemon 再起動

daemon 再起動時、team.json から Conductor 状態を復元する（daemon.ts L368-396）。team.json には `updateTeamJson()` で sessionId が記録されているため、CONDUCTOR_SESSION メッセージの再送は不要。

### E4: resume フロー

`cmdResume`（main.ts L885-951）は `task-state.json` の `sessionId` を使って `claude --resume` する。この sessionId は `scanTasks`（daemon.ts L834）で `updated.sessionId`（= `conductor.sessionId`）から記録される。CONDUCTOR_SESSION メッセージにより conductor.sessionId は正しく設定されるため、問題なし。

### E5: launchConductor の paneId 未指定（cmdSpawnConductor 経由）

**シナリオ:** `cmdSpawnConductor` は surface のみ指定し paneId を渡さない

**対応:** `launchConductor` の先頭で paneId が未指定の場合に `getPaneIdForSurface(surface)` を呼んで解決する（Step 2-2 参照）。`initializeConductorSlots` 経由では paneId が既に判明しているため、不要な cmux tree 呼び出しを避けられる。

---

## 削除されるコード

| 対象 | ファイル | 行番号 |
|------|---------|--------|
| `spawnSingleConductor()` 関数 | conductor.ts | L69-110 |
| `launchConductorOnSurface()` 関数 | conductor.ts | L147-182 |
| `spawnConductor()` 関数 | conductor.ts | L555-598 |
| `sessionIds` Map + フォールバック sessionId 補完 | conductor.ts | L202, L213-215, L225 |
| `getArg("session-id")` | main.ts | L844 |
| `if (sessionId) { claudeArgs.push(...) }` | main.ts | L857-859 |
| abort: `newSessionId` 生成 + `--session-id` + `conductor.sessionId =` | main.ts | L1569, L1572, L1573 |
| restart: `newSessionId` 生成 + `--session-id` + `conductor.sessionId =` | main.ts | L1654, L1657, L1658 |
| import `spawnSingleConductor` | main.ts | L33 |
| pidWatcher の `conductor.sessionId = undefined` | daemon.ts | L864 |

## 新規追加されるコード

| 対象 | ファイル | 説明 |
|------|---------|------|
| `ConductorSessionMessage` 型 | schema.ts | `{type: "CONDUCTOR_SESSION", surface, sessionId, timestamp}` |
| `launchConductor()` 関数 | conductor.ts | 3関数の統合版。paneId 自動解決 + CONDUCTOR_REGISTERED 送信 + env export + `cmux-team conductor` 起動 |
| `conductor.sessionId ?? ""` | conductor.ts | assignTask の non-null assertion を defensive に修正 |
| sessionId 自己生成 + HTTP POST | main.ts cmdConductor | `crypto.randomUUID()` + `fetch` で CONDUCTOR_SESSION 送信 |
| `CONDUCTOR_SESSION` case | main.ts cmdSend | CLI 経由の送信対応 |
| `CONDUCTOR_SESSION` handler | daemon.ts handleMessage | `conductor.sessionId = message.sessionId` |

---

## 変更順序まとめ

```
Step 1: schema.ts          ← 型定義（他の全 Step が依存）
  ↓
Step 2: conductor.ts       ← 関数統合 + defensive 修正（main.ts の import に影響）
  ↓
Step 3: main.ts            ← cmdConductor 変更 + abort/restart + import 更新
  ↓
Step 4: daemon.ts          ← ハンドラ追加（schema.ts に依存）
```

Step 2 と Step 3 は互いに独立だが、Step 3 が Step 2 の `launchConductor` を import するため、Step 2 を先に完了させる。Step 4 は Step 1 の型定義に依存する。

---

## Design Review 反映履歴

| # | 重要度 | 指摘 | 対応 |
|---|--------|------|------|
| 1 | Critical | resetConductor で sessionId をクリアしてはいけない | Step 2-4（旧）を削除 → Step 2-5 として「変更しない」を明記 |
| 2 | Major | E1 の defensive 変更を正式な Step に昇格 | Step 2-4 として `conductor.sessionId!` → `conductor.sessionId ?? ""` を追加 |
| 3 | Minor | launchConductor で paneId 未指定時の解決 | Step 2-2 の launchConductor に `getPaneIdForSurface` 呼び出しを追加、E5 追加 |
