# Conductor starting 状態のステート遷移バグ修正 — 実装計画

## 変更ファイル一覧

| ファイル | 変更内容 |
|---------|---------|
| `skills/cmux-team/manager/conductor.ts` | `launchConductorOnSurface` の CONDUCTOR_REGISTERED 送信順序を修正 |
| `skills/cmux-team/manager/daemon.ts` | SESSION_IDLE / SESSION_ACTIVE / SESSION_CLEAR ハンドラに starting 対応を追加 + ログ追加 |

## Bug 1: レースコンディション — CONDUCTOR_REGISTERED 送信順序

### 原因

`launchConductorOnSurface`（conductor.ts:125-157）の実行順序:

1. L131-134: `cmux.send()` — シェルコマンドで Claude を起動
2. L137-138: `cmux.renameTab()` — タブ名設定
3. L141-156: HTTP POST で `CONDUCTOR_REGISTERED` を送信

Claude が高速起動すると、SessionStart hook の `SESSION_STARTED` が `CONDUCTOR_REGISTERED` より先に daemon に到着する。daemon.ts の `findConductor()` が undefined を返し、`SESSION_STARTED` が無視される（ログも残らない）。

### 修正内容

`launchConductorOnSurface`（conductor.ts:125-157）の送信順序を変更する。

**変更前** (L131-156):
```typescript
// Claude 起動
await cmux.send(surface, `export CMUX_SURFACE=${surface} && cmux-team conductor ${surface}\n`);
// タブ名設定
const num = surface.replace("surface:", "");
await cmux.renameTab(surface, `[${num}] ♦ idle`);
// CONDUCTOR_REGISTERED を HTTP API 経由で送信
try { ... fetch(...CONDUCTOR_REGISTERED...) } catch { ... }
```

**変更後**:
```typescript
// CONDUCTOR_REGISTERED を HTTP API 経由で送信（Claude 起動前に登録）
try { ... fetch(...CONDUCTOR_REGISTERED...) } catch { ... }
// Claude 起動
await cmux.send(surface, `export CMUX_SURFACE=${surface} && cmux-team conductor ${surface}\n`);
// タブ名設定
const num = surface.replace("surface:", "");
await cmux.renameTab(surface, `[${num}] ♦ idle`);
```

これにより、Claude が起動して `SESSION_STARTED` が発火する前に `CONDUCTOR_REGISTERED` が daemon に到達し、`findConductor()` が conductor を返せるようになる。

### 同様の問題: `spawnSingleConductor`

`spawnSingleConductor`（conductor.ts:43-88）にも同じ順序問題がある。こちらも同様に `CONDUCTOR_REGISTERED` を `cmux.send()` の前に移動する。

**変更前** (L51-79):
```typescript
await cmux.send(surface, `export CMUX_SURFACE=${surface} && cmux-team conductor ${surface}\n`);
const num = surface.replace("surface:", "");
await cmux.renameTab(surface, `[${num}] ♦ idle`);
const paneId = await getPaneIdForSurface(surface);
// CONDUCTOR_REGISTERED ...
```

**変更後**:
```typescript
const num = surface.replace("surface:", "");
const paneId = await getPaneIdForSurface(surface);
// CONDUCTOR_REGISTERED を先に送信
try { ... fetch(...CONDUCTOR_REGISTERED...) } catch { ... }
// Claude 起動
await cmux.send(surface, `export CMUX_SURFACE=${surface} && cmux-team conductor ${surface}\n`);
await cmux.renameTab(surface, `[${num}] ♦ idle`);
```

注意: `spawnSingleConductor` では `paneId` を CONDUCTOR_REGISTERED に含めるため、`getPaneIdForSurface` は CONDUCTOR_REGISTERED の前に実行する必要がある。

## Bug 2: SESSION_IDLE / SESSION_ACTIVE / SESSION_CLEAR が starting を処理しない

### 原因

daemon.ts の各ハンドラが `conductor.status === "disconnected"` のみチェックしており、`"starting"` を処理しない。Bug 1 が修正されても、SESSION_STARTED が何らかの理由で失われた場合のフォールバックとして、これらのハンドラで starting → idle 遷移が必要。

### 修正内容

#### SESSION_IDLE ハンドラ（daemon.ts:525-548）

**変更前** (L538-541):
```typescript
if (conductor.status === "disconnected") {
  conductor.status = "idle";
  await log("conductor_recovered", `surface=${message.surface} via=SESSION_IDLE new_status=idle`);
}
```

**変更後**:
```typescript
if (conductor.status === "disconnected" || conductor.status === "starting") {
  const event = conductor.status === "starting" ? "conductor_ready" : "conductor_recovered";
  conductor.status = "idle";
  await log(event, `surface=${message.surface} via=SESSION_IDLE`);
}
```

#### SESSION_ACTIVE ハンドラ（daemon.ts:504-523）

**変更前** (L517-520):
```typescript
if (conductor.status === "disconnected") {
  conductor.status = "running";
  await log("conductor_recovered", `surface=${message.surface} via=SESSION_ACTIVE new_status=running`);
}
```

**変更後**:
```typescript
if (conductor.status === "disconnected") {
  conductor.status = "running";
  await log("conductor_recovered", `surface=${message.surface} via=SESSION_ACTIVE new_status=running`);
} else if (conductor.status === "starting") {
  conductor.status = "idle";
  await log("conductor_ready", `surface=${message.surface} via=SESSION_ACTIVE`);
}
```

理由: starting → idle（running ではなく idle）。starting 状態の conductor にはタスクが割り当てられていないため、「タスク実行中」を意味する running ではなく idle が正しい。

#### SESSION_CLEAR ハンドラ（daemon.ts:550-559）

**変更前** (L551-558):
```typescript
const conductor = findConductor(state, message.surface);
if (conductor && conductor.status === "disconnected") {
  conductor.status = "idle";
  conductor.disconnectedAt = undefined;
  if (message.pid) conductor.pid = message.pid;
  await log("conductor_recovered", `surface=${message.surface} via=SESSION_CLEAR new_status=idle`);
}
```

**変更後**:
```typescript
const conductor = findConductor(state, message.surface);
if (conductor && (conductor.status === "disconnected" || conductor.status === "starting")) {
  const event = conductor.status === "starting" ? "conductor_ready" : "conductor_recovered";
  conductor.status = "idle";
  conductor.disconnectedAt = undefined;
  if (message.pid) conductor.pid = message.pid;
  await log(event, `surface=${message.surface} via=SESSION_CLEAR`);
}
```

## 追加ログ

### SESSION_STARTED ハンドラで conductor が見つからない場合（daemon.ts:425-445）

**変更前** (L425-445):
```typescript
const conductor = findConductor(state, message.surface);
if (conductor) {
  // ... 処理
}
break;
```

**変更後**:
```typescript
const conductor = findConductor(state, message.surface);
if (conductor) {
  // ... 処理（既存のまま）
} else {
  await log("session_started_ignored", `surface=${message.surface} reason=conductor_not_found`);
}
break;
```

## Bug 3: /clear 後に SESSION_STARTED が送信されない

### 分析

SessionStart hook の matcher が "startup" のみのため、/clear 後の SessionStart にはマッチしない。

### 対応

Bug 2 の修正で SESSION_IDLE / SESSION_CLEAR 経由の復帰パスが確保されるため、追加の hook 変更は不要。

/clear 後のフロー:
1. `/clear` → SessionEnd(clear) 発火 → SESSION_ENDED 送信 → conductor.status = "disconnected"
2. 新セッション開始 → SessionStart 発火（startup matcher 不一致で SESSION_STARTED は送信されない）
3. Claude がアイドルになる → SessionIdle 発火 → SESSION_IDLE 送信
4. Bug 2 修正により disconnected → idle に遷移（既に対応済み）

## 影響範囲と注意点

### 影響範囲

- **起動シーケンス**: CONDUCTOR_REGISTERED の送信順序変更により、conductor が SESSION_STARTED を受信できるようになる。`initializeConductorSlots` のフォールバック（conductor.ts:182-195）は引き続き有効で、HTTP POST 失敗時のセーフティネットとして機能する。
- **ステート遷移**: starting 状態からの遷移パスが増えるが、全て idle への遷移であり、タスク割当ロジック（scanTasks）には影響しない。
- **ログ**: 新規ログイベント `session_started_ignored` が追加される。既存の `conductor_ready` イベントの `via=` 詳細が増える。

### 注意点

1. **`spawnSingleConductor` も修正対象**: `launchConductorOnSurface` と同じ問題を持つため、両方の関数を修正する必要がある。
2. **`initializeConductorSlots` のフォールバック**: Bug 1 の修正後も、HTTP POST の失敗に備えたフォールバック（conductor.ts:182-195）は削除しない。冗長だがセーフティネットとして有用。
3. **SESSION_ACTIVE の starting → idle 遷移**: タスク未割当の conductor が active 状態になるのは初期化中のみ。idle に遷移させてもすぐに SESSION_IDLE が来るため実害はない。ただし、scanTasks が idle conductor を検出してタスクを割り当てる可能性がある。Claude が初期化中でも `/clear` + プロンプト送信は受け付けるため問題ない。
4. **monitorConductors のタイムアウト**: starting 状態の 60 秒タイムアウト（daemon.ts:704-721）は引き続き有効。Bug 2 の修正で SESSION_IDLE 等による正常な遷移が先に発生するため、タイムアウトに到達するケースは減る。
