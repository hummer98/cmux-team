# plan.md — initializeConductorSlots 状態上書きバグの修正

## 問題の根本原因

`initializeConductorSlots` が `spawnSingleConductor` を **順次 await** するため、Conductor-1 の起動から Conductor-3 の起動完了まで数十秒かかる。この間に以下の並行処理が発生する:

1. `spawnSingleConductor` が HTTP POST で `CONDUCTOR_REGISTERED` を proxy に送信
2. proxy の `onMessage` コールバック経由で `handleMessage` が呼ばれ、`state.conductors.set(surface, {status: "starting"})` が実行される
3. Claude 起動完了時に `SESSION_STARTED` が発火し、`handleMessage` が `conductor.status = "idle"` に遷移させる
4. **しかし**、`initializeConductorSlots` が全 slot の ConductorState を返却し、`initializeLayout` L312-314 で:
   ```typescript
   for (const slot of slots) {
     state.conductors.set(slot.surface, slot);  // ← 古い status: "starting" で上書き
   }
   ```
5. 既に `"idle"` に遷移済みの Conductor が `"starting"` に巻き戻される
6. 60秒後に `monitorConductors` の `STARTING_TIMEOUT_SEC` で `"disconnected"` になる

**本質**: `spawnSingleConductor` の返却値（スナップショット）で `handleMessage` が管理するライブ状態を上書きしている。

## 修正アプローチ

`initializeConductorSlots` を2フェーズに分離し、状態登録を `CONDUCTOR_REGISTERED` メッセージハンドラに一元化する。

### Phase 1: pane 分割（Claude は起動しない）

新関数 `createConductorPanes` で cmux の split だけ実行し、`{surface, paneId}[]` を返す。

### Phase 2: Claude 一斉起動

新関数 `launchConductorOnSurface` で各 surface に Claude 起動コマンドを送信し、`CONDUCTOR_REGISTERED` を POST する。ConductorState は返却しない。

### 状態管理の変更

- `initializeConductorSlots` は `void` を返す（ConductorState[] を返さない）
- `initializeLayout` は `state.conductors.set()` を呼ばない
- 状態登録は `CONDUCTOR_REGISTERED` → `handleMessage` に一元化
- フォールバック: CONDUCTOR_REGISTERED の HTTP POST が失敗した場合に備え、launch 後に `state.conductors` に未登録の surface を補完する

## 変更ファイル一覧と変更内容

### 1. `skills/cmux-team/manager/conductor.ts`

#### 新関数: `createConductorPanes`

pane 分割のみを実行する関数。Claude の起動は行わない。

```typescript
/**
 * Conductor 用の pane を分割作成する（Claude は起動しない）
 */
export async function createConductorPanes(
  count: number,
  daemonSurface?: string,
): Promise<{ surface: string; paneId?: string }[]> {
  const panes: { surface: string; paneId?: string }[] = [];

  // 1. daemon を右に split → Conductor-1 pane
  const s1 = await cmux.newSplit("right", daemonSurface ? { surface: daemonSurface } : undefined);
  panes.push({ surface: s1, paneId: await getPaneIdForSurface(s1) });

  if (count >= 2) {
    // 2. daemon を下に split → Conductor-2 pane
    const s2 = await cmux.newSplit("down", daemonSurface ? { surface: daemonSurface } : undefined);
    panes.push({ surface: s2, paneId: await getPaneIdForSurface(s2) });
  }

  if (count >= 3) {
    // 3. Conductor-1 を下に split → Conductor-3 pane
    const s3 = await cmux.newSplit("down", { surface: s1 });
    panes.push({ surface: s3, paneId: await getPaneIdForSurface(s3) });
  }

  return panes;
}
```

#### 新関数: `launchConductorOnSurface`

既存 pane 上で Claude を起動し CONDUCTOR_REGISTERED を送信する。ConductorState は返却しない。

```typescript
/**
 * 既存 pane 上で Claude を起動し CONDUCTOR_REGISTERED を送信する
 */
export async function launchConductorOnSurface(
  projectRoot: string,
  surface: string,
  paneId?: string,
): Promise<void> {
  // Claude 起動
  await cmux.send(
    surface,
    `export CMUX_SURFACE=${surface} && cmux-team conductor ${surface}\n`
  );

  // タブ名設定
  const num = surface.replace("surface:", "");
  await cmux.renameTab(surface, `[${num}] ♦ idle`);

  // CONDUCTOR_REGISTERED を HTTP API 経由で送信
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
}
```

#### `initializeConductorSlots` の書き換え

2フェーズに分離。戻り値を `void` に変更。フォールバック登録用に `state` を受け取る。

```typescript
/**
 * Conductor スロットを初期化する（2フェーズ: pane 分割 → Claude 一斉起動）
 *
 * 状態登録は CONDUCTOR_REGISTERED メッセージハンドラに委譲する。
 * HTTP POST 失敗時のフォールバックとして、launch 後に state.conductors に
 * 未登録の surface があれば直接登録する。
 */
export async function initializeConductorSlots(
  projectRoot: string,
  conductors: Map<string, ConductorState>,
  count: number = 3,
  daemonSurface?: string,
): Promise<void> {
  try {
    console.log(`⏳ Conductor スロット作成中 (${count}個)...`);

    // Phase 1: pane 分割（Claude は起動しない）
    console.log(`  ⏳ Phase 1: pane 分割中...`);
    const panes = await createConductorPanes(count, daemonSurface);
    console.log(`  ✅ Phase 1: ${panes.length}個の pane 作成完了`);

    // Phase 2: Claude 一斉起動
    console.log(`  ⏳ Phase 2: Claude 起動中...`);
    for (const pane of panes) {
      await launchConductorOnSurface(projectRoot, pane.surface, pane.paneId);
    }

    // フォールバック: CONDUCTOR_REGISTERED の HTTP POST が失敗した場合に備え、
    // state.conductors に未登録の surface を直接登録する
    for (const pane of panes) {
      if (!conductors.has(pane.surface)) {
        await log("conductor_registered_fallback", `surface=${pane.surface}`);
        conductors.set(pane.surface, {
          surface: pane.surface,
          paneId: pane.paneId,
          status: "starting",
          startedAt: new Date().toISOString(),
          agents: [],
        });
      }
    }

    console.log(`✅ Conductor スロット ${panes.length}個 準備完了`);
    await log("conductor_slots_initialized", `count=${panes.length}`);
  } catch (e: any) {
    await log("error", `initializeConductorSlots failed: ${e.message}`);
  }
}
```

#### `spawnSingleConductor` の扱い

`spawnSingleConductor` は `spawnConductor`（後方互換ラッパー、L330-363）から参照されている。**削除せずそのまま残す**。初期化フローからは使われなくなるが、動的な Conductor 追加の際に引き続き利用可能。

### 2. `skills/cmux-team/manager/daemon.ts`

#### `initializeLayout` の修正（L310-316）

変更前:
```typescript
// 既存なし → 新規作成
await log("layout_creating_new_slots", `count=${state.maxConductors}`);
const slots = await initializeConductorSlots(state.projectRoot, state.maxConductors, daemonSurface);
for (const slot of slots) {
  state.conductors.set(slot.surface, slot);
}
```

変更後:
```typescript
// 既存なし → 新規作成
await log("layout_creating_new_slots", `count=${state.maxConductors}`);
await initializeConductorSlots(state.projectRoot, state.conductors, state.maxConductors, daemonSurface);
// 状態登録は CONDUCTOR_REGISTERED メッセージハンドラ（+ フォールバック）で完了済み
```

import 文の更新: `initializeConductorSlots` に加えて、export が変わった場合は import を確認する（既存 import で十分なはず）。

## CONDUCTOR_REGISTERED メッセージとの整合性

### 二重登録の防止

`CONDUCTOR_REGISTERED` の `handleMessage` ハンドラ（daemon.ts L415-423）は無条件で `state.conductors.set()` する:

```typescript
case "CONDUCTOR_REGISTERED": {
  state.conductors.set(message.surface, {
    surface: message.surface,
    paneId: message.paneId,
    status: "starting",
    startedAt: message.timestamp,
    agents: [],
  });
  ...
}
```

フォールバック登録は `conductors.has()` で既存チェックしてから登録するため、CONDUCTOR_REGISTERED が先に処理されていればスキップされる。逆にフォールバックが先に実行された場合、CONDUCTOR_REGISTERED が後から上書きするが、どちらも `status: "starting"` なので実質的な影響はない。

**結論**: 二重登録は発生しうるが、同一ステータスでの上書きのため副作用なし。SESSION_STARTED による `"idle"` 遷移後に上書きされるリスクは、フォールバック・CONDUCTOR_REGISTERED いずれも `initializeConductorSlots` 完了前に処理されるため問題ない。

### 既存 handleMessage ハンドラへの影響

- `SESSION_STARTED`: 変更なし。`findConductor` で conductor を検索し `status` を更新する。CONDUCTOR_REGISTERED（またはフォールバック）で登録済みの conductor を正しく見つけられる。
- `SESSION_ENDED` / `SESSION_ACTIVE` / `SESSION_IDLE`: 変更なし。
- `CONDUCTOR_DONE`: 変更なし。
- `AGENT_SPAWNED`: 変更なし。

## リスクと対策

| リスク | 影響度 | 対策 |
|-------|--------|------|
| CONDUCTOR_REGISTERED の HTTP POST が全て失敗 | 中 | フォールバック登録で `state.conductors` に直接 set する |
| `createConductorPanes` で途中の split が失敗 | 低 | 既存と同じ try-catch で `initializeConductorSlots failed` ログ。作成できた分だけ launch する |
| `spawnConductor`（後方互換ラッパー）への影響 | なし | `spawnSingleConductor` を残すため、動的追加パスは変更なし |
| `initializeConductorSlots` のシグネチャ変更 | 低 | 呼び出し元は `initializeLayout` のみ。daemon.ts の1箇所を変更するだけ |
