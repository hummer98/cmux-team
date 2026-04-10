# 実装計画: daemon_auto_restart 後に Master が proxy を見失う問題

## 問題の概要

`daemon_auto_restart`（exit code 42）後:

1. 旧 daemon プロセスが終了 → 同プロセス内の proxy も終了
2. 新 daemon が起動 → `resolveProxyPort()` で旧ポートが死んでいることを検出 → 新 proxy を別ポートで起動
3. `startMaster()` が `isMasterAlive()` で Master surface の生存を確認 → alive → respawn スキップ
4. **Master の `ANTHROPIC_BASE_URL` は旧ポートのまま → API に接続できない**

## 修正方針

proxy ポートの変化を検知したら、旧 Master を close して新 Master を spawn する。

## 変更箇所

### 変更 1: `main.ts` — proxy 起動前に前回ポートを記録し、変化を検出

**ファイル**: `skills/cmux-team/manager/main.ts`
**行番号**: L211〜L229（proxy 起動セクション）

**変更内容**:

proxy 起動ブロックの前（L211 の前）で `.team/proxy-port` ファイルから前回のポートを読み取る。proxy 起動後に前回ポートと新ポートを比較し、変化があれば `state` にフラグをセットする。

```typescript
// ロギングプロキシ起動（既存 proxy が生きていればスキップ）
let proxyHandle: { port: number; stop: () => void } | null = null;

// 前回のポートを記録（proxy 起動前にファイルから読む — alive チェック不要）
let previousProxyPort: string | undefined;
try {
  previousProxyPort = (await readFile(join(PROJECT_ROOT, ".team/proxy-port"), "utf-8")).trim();
} catch {}

const existingProxyPort = await resolveProxyPort();
if (existingProxyPort) {
  state.proxyPort = parseInt(existingProxyPort, 10);
  await log("proxy_reused", `port=${existingProxyPort}`);
} else {
  try {
    proxyHandle = await startProxy(PROJECT_ROOT, {
      getState: () => state,
      onMessage: async (msg) => { await handleMessage(state, msg); },
    });
    await writeFile(join(PROJECT_ROOT, ".team/proxy-port"), String(proxyHandle.port));
    state.proxyPort = proxyHandle.port;
    await log("proxy_started", `port=${proxyHandle.port}`);
  } catch (e: any) {
    await log("proxy_start_failed", e.message);
  }
}

// proxy ポート変化の検出
if (previousProxyPort && state.proxyPort && String(state.proxyPort) !== previousProxyPort) {
  state.proxyPortChanged = true;
  await log("proxy_port_changed", `prev=${previousProxyPort} new=${state.proxyPort}`);
}
```

**ポイント**:
- `previousProxyPort` はファイル読みだけで alive チェックしない（旧 proxy は既に死んでいる前提）
- `resolveProxyPort()` は alive チェック付きなので、旧ポートが死んでいれば `undefined` → 新 proxy 起動の流れになる
- `proxy_reused` の場合（ポート変化なし）は `proxyPortChanged` は `false` のまま → Master 再起動不要

### 変更 2: `daemon.ts` — `DaemonState` にフラグ追加

**ファイル**: `skills/cmux-team/manager/daemon.ts`
**行番号**: L34〜L62（`DaemonState` interface）

**変更内容**:

`DaemonState` に `proxyPortChanged` フィールドを追加する。

```typescript
export interface DaemonState {
  // ... 既存フィールド ...
  /** fs.watch からの即時 tick 要求を通知する resolve 関数 */
  wakeup: (() => void) | null;
  /** Master PID ウォッチャーの interval */
  masterPidWatcherInterval?: ReturnType<typeof setInterval>;
  /** proxy ポートが前回起動時から変化したか（Master 再起動トリガー） */
  proxyPortChanged: boolean;
}
```

L62 の `masterPidWatcherInterval` の後（interface 末尾付近）に追加。

初期値は `false`。`main.ts` の `createInitialState()` 相当の箇所で初期化が必要（既存の state 初期化箇所を確認し、`proxyPortChanged: false` を追加する）。

### 変更 3: `daemon.ts` — `startMaster()` で proxy 変化時に Master を再起動

**ファイル**: `skills/cmux-team/manager/daemon.ts`
**行番号**: L241〜L272（`startMaster()` 関数）

**変更内容**:

Master alive 判定後、`state.proxyPortChanged` が `true` の場合は旧 Master を close して fall-through で新 Master を spawn する。

```typescript
export async function startMaster(state: DaemonState, daemonSurface?: string): Promise<void> {
  // マーカーファイルから既存 Master を検出
  const markerPath = join(state.projectRoot, ".team/master.surface");
  try {
    if (existsSync(markerPath)) {
      const surface = (await readFile(markerPath, "utf-8")).trim();
      if (surface) {
        const alive = await isMasterAlive(surface);
        if (alive) {
          // proxy ポート変化時: 旧 Master を close して再 spawn
          if (state.proxyPortChanged) {
            await log("master_respawn_proxy_changed", `surface=${surface} newPort=${state.proxyPort}`);
            const cmux = await import("./cmux");
            await cmux.closeSurface(surface).catch(() => {});
            state.proxyPortChanged = false;  // フラグリセット
            // fall-through して下の spawn コードへ
          } else {
            state.masterSurface = surface;
            state.masterStatus = "idle";
            await log("master_alive", `surface=${surface}`);
            return;
          }
        }
        await log("master_check_failed", `surface=${surface} alive=false`);
      }
    }
  } catch (e: any) {
    await log("master_check_error", e.message);
  }

  // Master spawn
  await log("master_spawning");
  const master = await spawnMaster(state.projectRoot, daemonSurface);
  if (master) {
    state.masterSurface = master.surface;
    state.masterStatus = "idle";
    await log("master_started", `surface=${master.surface}`);
  } else {
    await log("master_spawn_failed");
  }
}
```

**ポイント**:
- `closeSurface` 後は `return` しないので、そのまま下の Master spawn コードに fall-through する
- `proxyPortChanged` フラグは close 直後にリセットする（再 spawn 失敗時に無限ループを防ぐ）
- `closeSurface` は冪等操作なので `.catch(() => {})` で失敗を無視する

### 変更 4: `main.ts` — `cmdLaunchMaster()` にログ追加

**ファイル**: `skills/cmux-team/manager/main.ts`
**行番号**: L918〜L921（proxy ポート解決部分）

**変更内容**:

`cmdLaunchMaster()` 内で proxy ポートを解決した後にログを追加する。

```typescript
const proxyPort = await resolveProxyPort();
if (proxyPort) {
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxyPort}`;
}
await log("master_spawn_proxy", `port=${proxyPort ?? "none"}`);
```

**注意**: `cmdLaunchMaster()` は `cmux-team spawn-master` コマンドとして実行されるため、`log()` が使える。

### 変更 5: `main.ts` — state 初期化に `proxyPortChanged` を追加

**ファイル**: `skills/cmux-team/manager/main.ts`

state 初期化箇所（`DaemonState` オブジェクトリテラル）に `proxyPortChanged: false` を追加する。

## 変更の順序

1. **`daemon.ts`**: `DaemonState` interface に `proxyPortChanged: boolean` を追加
2. **`main.ts`**: state 初期化に `proxyPortChanged: false` を追加
3. **`main.ts`**: proxy 起動セクション（L211〜L229）に前回ポート読み取り + 変化検出を追加
4. **`daemon.ts`**: `startMaster()` に proxy 変化時の Master 再起動ロジックを追加
5. **`main.ts`**: `cmdLaunchMaster()` にログ追加

順序の理由: 1→2 は型定義と初期化（コンパイルが通る状態を維持）、3 は検出ロジック、4 は検出結果に基づくアクション、5 は独立したログ追加。

## テスト方針（手動テスト手順）

### テスト 1: daemon_auto_restart 時の Master 再起動確認

1. `cmux-team start` でシステムを起動
2. `.team/proxy-port` の現在のポート番号を確認: `cat .team/proxy-port`
3. Manager のソースファイルに軽微な変更を加えて保存（例: コメント追加）
4. daemon がソース変更を検出し `daemon_auto_restart`（exit code 42）を実行するのを待つ
5. ログを確認:
   - `proxy_port_changed prev=<old> new=<new>` が出力されること
   - `master_respawn_proxy_changed` が出力されること
   - `master_started` が出力されること（新 Master が spawn されたこと）
6. Master セッションで API 呼び出しが正常に動作すること（例: 簡単な質問を投げる）

### テスト 2: proxy ポート変化なし時の Master 維持確認

1. `cmux-team start` でシステムを起動
2. `cmux-team stop` → `cmux-team start` で再起動（proxy プロセスは独立していないので通常は変化する）
3. proxy が reuse された場合（`proxy_reused` ログ）:
   - `proxy_port_changed` ログが出力されないこと
   - Master が再起動されずに `master_alive` ログが出力されること

### テスト 3: Master が既に死んでいる場合の通常 spawn

1. `cmux-team start` でシステムを起動
2. Master セッションを手動で終了（`cmux close-surface <master-surface>`）
3. daemon が Master 消失を検出して `startMaster()` を呼ぶのを待つ
4. `proxyPortChanged` が `false` の場合、通常の `master_check_failed` → `master_spawning` → `master_started` フローになること

## リスク・注意点

### 1. Master セッションのコンテキスト消失

Master を close して再 spawn すると、ユーザーが進行中の会話が失われる。ただし:
- `daemon_auto_restart` 自体がソース変更による再起動なので、通常は開発者（ユーザー自身）がトリガーしている
- proxy が死んだ Master は API 呼び出し不能なので、いずれにせよ使えない
- ユーザーへの影響は「会話コンテキストの消失」のみで、作業データ（タスク・アーティファクト）は `.team/` に保持されている

### 2. `closeSurface` の競合

`closeSurface` と新 Master spawn が近いタイミングで起きるため、cmux 側でレイアウトが一時的に乱れる可能性がある。ただし Master は daemon surface の右 split に作成されるため、旧 Master の close 後に同じ場所に新 Master が作成される。

### 3. フラグリセットのタイミング

`proxyPortChanged` を `closeSurface` 直後にリセットしている。Master spawn が失敗した場合、フラグは `false` に戻っているが Master は不在のまま。次の `tick()` で `startMaster()` が呼ばれた際は `isMasterAlive()` が `false` を返すので、通常の spawn フローで復帰する。

### 4. `cmux` モジュールの import

`daemon.ts` の `startMaster()` 内で `cmux.closeSurface` を呼ぶために `import("./cmux")` を使用する。`daemon.ts` が既に `cmux` をインポートしているか確認し、既にあればそれを使う。なければ dynamic import または static import を追加する。

### 5. `cmdLaunchMaster()` のログ出力

`cmdLaunchMaster()` は `cmux-team spawn-master` として子プロセスで実行される。`log()` は `.team/logs/manager.log` に追記するため、daemon とのログファイル競合は通常は問題にならない（追記 only）。ただし厳密にはファイルロックがないため、ログ行が混在する可能性はゼロではない。実用上は問題ないレベル。
