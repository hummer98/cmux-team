# 実装計画: daemon_auto_restart 後に Master が proxy を見失う問題

## 1. 問題の分析（根本原因）

### 発生シナリオ

1. daemon がソースファイルの変更を検出 → `state.restartRequested = true`（daemon.ts:357）
2. メインループ終了後、`process.exit(42)` で auto_restart を通知（main.ts:406-410）
3. **親 daemon の `onReload` ハンドラ**（main.ts:256-292）が子 daemon を `execFileSync` で起動
4. 子 daemon が `cmdStart()` → proxy 起動部分（main.ts:211-229）に到達
5. `resolveProxyPort()` で既存 proxy の生存チェック:
   - **proxy が生きている場合**: ポート再利用（`proxy_reused`）→ 問題なし
   - **proxy が死んでいる場合**: 新しい proxy を起動 → **新ポートが割り当てられる**
6. Master の `ANTHROPIC_BASE_URL` は `cmux-team spawn-master` 実行時に `resolveProxyPort()` で解決されるが（main.ts:918-920）、これは **Master プロセス起動時に一度だけ** 実行される
7. Master プロセスは既に起動済みなので、旧ポートの `ANTHROPIC_BASE_URL` を持ち続ける

### 根本原因

- Master は起動時に `ANTHROPIC_BASE_URL` を環境変数として設定し、`execFileSync("claude", ...)` でプロセスを起動する（main.ts:928-938）
- 環境変数はプロセス起動時に固定されるため、proxy ポートが変わっても Master には伝播しない
- Conductor も同様の問題を抱えるが、Conductor はタスク割り当て時に `/clear` + 新プロンプト送信で動作するため、`cmdConductor()` が再実行されることはない（ただし Conductor も同じ Claude プロセスなので `ANTHROPIC_BASE_URL` は固定）

### 影響範囲

- **Master**: `ANTHROPIC_BASE_URL` が旧ポートのまま → API 呼び出し不可
- **Conductor**: 同様に `ANTHROPIC_BASE_URL` が旧ポートのまま → タスク実行不可
- **結果**: チーム全体が API に接続できなくなる

## 2. 修正箇所の一覧

| # | ファイル | 関数/箇所 | 行番号 | 変更内容 |
|---|---------|----------|--------|---------|
| 1 | daemon.ts | `startMaster()` | 237-268 | proxy ポート変化検知時の Master 再起動ロジック追加 |
| 2 | daemon.ts | `tick()` | 338-360 | proxy ポート変化検知の組み込み |
| 3 | daemon.ts | `DaemonState` 型 | 周辺 | （変更不要: `proxyPort` は既存） |
| 4 | main.ts | proxy 起動部分 | 211-229 | 前回ポートとの比較ログ追加 |
| 5 | main.ts | `resolveProxyPort()` | 688-706 | alive チェック結果のログ追加 |
| 6 | main.ts | `cmdLaunchMaster()` | 896-942 | spawn 時の proxy ポートログ追加 |

## 3. 具体的な変更内容

### 3-1. daemon.ts — `tick()` に proxy ポート変化検知を追加（338-360行目）

**既存コード（343-349行目）の proxy 死活チェック部分を拡張:**

```typescript
export async function tick(state: DaemonState): Promise<void> {
  state.lastUpdate = new Date();
  await scanTasks(state);
  await monitorConductors(state);

  // proxy ポート変化チェック + 死活チェック
  if (state.proxyPort) {
    const alive = await isProxyAlive(state.proxyPort);
    if (!alive) {
      await log("proxy_dead", `port=${state.proxyPort} — Master/Conductor がAPIに接続できない状態`);
    }

    // proxy-port ファイルの値と state.proxyPort を比較
    const currentPortStr = await readProxyPortFile(state.projectRoot);
    if (currentPortStr) {
      const currentPort = parseInt(currentPortStr, 10);
      if (currentPort !== state.proxyPort) {
        await log("proxy_port_changed", `prev=${state.proxyPort} new=${currentPort}`);
        state.proxyPort = currentPort;
        // Master を再起動して新ポートで接続させる
        await restartMasterForProxyChange(state, currentPort);
      }
    }
  }

  // ソースファイルの mtime 変更を検出
  // ... (既存コード)
}
```

**補足**: `readProxyPortFile` は proxy-port ファイルを読むだけのヘルパー（生存確認なし）。`resolveProxyPort()` とは異なり TCP 接続チェックを行わない（ファイルの値が変わったかだけを見る）。

### 3-2. daemon.ts — `restartMasterForProxyChange()` 新関数を追加

```typescript
/**
 * proxy ポート変化時に Master を再起動する。
 * 既存 Master surface を閉じてから startMaster() で再作成する。
 */
async function restartMasterForProxyChange(state: DaemonState, newPort: number): Promise<void> {
  await log("master_restart_proxy", `new_port=${newPort}`);

  // 1. 既存 Master surface を閉じる
  if (state.masterSurface) {
    try {
      await cmux.closeSurface(state.masterSurface);
    } catch {
      // 既に閉じている場合は無視（冪等な後処理）
    }
    state.masterSurface = null;
    state.masterStatus = "disconnected";
  }

  // 2. マーカーファイル削除（startMaster が既存検出をスキップするため）
  const markerPath = join(state.projectRoot, ".team/master.surface");
  try {
    await rm(markerPath);
  } catch {
    // 存在しない場合は無視
  }

  // 3. startMaster() で再起動（spawnMaster → cmdLaunchMaster → resolveProxyPort で新ポート取得）
  await startMaster(state);
}
```

**設計判断**:
- `spawnMaster()` を直接呼ばず `startMaster()` を呼ぶ。`startMaster()` はマーカーファイルによる既存 Master 検出を行うため、マーカーファイルを事前に削除する。
- Master の再起動は、surface を閉じて新しく作り直すアプローチ。これは `cmdLaunchMaster()` が `resolveProxyPort()` で最新ポートを取得するため、確実に新ポートで接続される。
- Conductor は再起動しない。理由:
  - Conductor はタスク実行中の可能性がある（中断はリスクが高い）
  - Conductor の `ANTHROPIC_BASE_URL` も古いままだが、daemon_auto_restart 後は通常 Conductor も idle 状態
  - Conductor に新タスクが割り当てられる場合、`cmux-team conductor` コマンドは再実行されない（`/clear` + プロンプト送信のみ）ので、Conductor のプロキシ問題は別タスクで対応する

### 3-3. daemon.ts — `readProxyPortFile()` ヘルパー追加

```typescript
/** proxy-port ファイルからポート文字列を読み取る（TCP 生存チェックなし） */
async function readProxyPortFile(projectRoot: string): Promise<string | undefined> {
  try {
    const portFile = join(projectRoot, ".team/proxy-port");
    return (await readFile(portFile, "utf-8")).trim() || undefined;
  } catch {
    return undefined;
  }
}
```

### 3-4. main.ts — proxy 起動部分にログ追加（211-229行目）

既存の proxy 起動部分を修正して、前回ポートとの比較情報をログに追加:

```diff
  // ロギングプロキシ起動（既存 proxy が生きていればスキップ）
  let proxyHandle: { port: number; stop: () => void } | null = null;
  const existingProxyPort = await resolveProxyPort();
  if (existingProxyPort) {
    state.proxyPort = parseInt(existingProxyPort, 10);
-   await log("proxy_reused", `port=${existingProxyPort}`);
+   await log("proxy_reused", `port=${existingProxyPort}`);
+   await log("proxy_reused_check", `port=${existingProxyPort} alive=true`);
  } else {
+   // 旧ポートのファイルが存在するが TCP 死亡の場合を記録
+   const proxyPortFile = join(PROJECT_ROOT, ".team/proxy-port");
+   try {
+     const oldPort = (await readFile(proxyPortFile, "utf-8")).trim();
+     if (oldPort) {
+       await log("proxy_reused_check", `port=${oldPort} alive=false`);
+     }
+   } catch {}
    try {
      proxyHandle = await startProxy(PROJECT_ROOT, {
        getState: () => state,
        onMessage: async (msg) => { await handleMessage(state, msg); },
      });
      await writeFile(join(PROJECT_ROOT, ".team/proxy-port"), String(proxyHandle.port));
+     // 前回ポートと異なる場合を記録
+     if (existingProxyPort && parseInt(existingProxyPort, 10) !== proxyHandle.port) {
+       await log("proxy_port_changed", `prev=${existingProxyPort} new=${proxyHandle.port}`);
+     }
      state.proxyPort = proxyHandle.port;
      await log("proxy_started", `port=${proxyHandle.port}`);
    } catch (e: any) {
      await log("proxy_start_failed", e.message);
    }
  }
```

**注意**: `existingProxyPort` が undefined（旧 proxy 死亡）で新 proxy を起動した場合、この時点では `proxy_port_changed` は記録されない（前回ポートが不明なため）。`proxy_reused_check` で `alive=false` が記録される。

### 3-5. main.ts — `resolveProxyPort()` にログ追加（688-706行目）

`resolveProxyPort()` は `cmdLaunchMaster()` と `cmdConductor()` から呼ばれる。これら起動時関数では直接ログを追加するほうが適切なので、`resolveProxyPort()` 自体にはログを追加しない（副作用のない純粋関数に近い形を維持）。

代わりに呼び出し側でログを追加する。

### 3-6. main.ts — `cmdLaunchMaster()` にログ追加（896-942行目）

```diff
  // 環境変数を設定
  process.env.PROJECT_ROOT = PROJECT_ROOT;
  process.env.CMUX_NO_RENAME_TAB = "1";
  const proxyPort = await resolveProxyPort();
  if (proxyPort) {
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxyPort}`;
+   await log("master_spawn_proxy", `port=${proxyPort}`);
  } else {
+   await log("master_spawn_proxy_missing");
  }
```

**注意**: `cmdLaunchMaster()` は `cmux-team spawn-master` コマンドとして Master surface 上で実行される（main.ts:928-938 の `execFileSync("claude", ...)` で claude プロセスを起動する前に呼ばれる）。ここでのログは Master surface のシェル出力になるが、`log()` はファイルベースなので daemon のログファイルに書き込まれる。

### 3-7. main.ts — `cmdConductor()` にログ追加（761-763行目付近）

Master と同様に:

```diff
  const proxyPort = await resolveProxyPort();
  if (proxyPort) {
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxyPort}`;
+   await log("conductor_spawn_proxy", `port=${proxyPort}`);
+ } else {
+   await log("conductor_spawn_proxy_missing");
  }
```

## 4. ログ追加箇所まとめ

| ログイベント | 追加箇所 | 説明 |
|-------------|---------|------|
| `proxy_port_changed` | daemon.ts `tick()` / main.ts proxy 起動部分 | ポート変化の検知（`prev=60372 new=60373`） |
| `proxy_reused_check` | main.ts proxy 起動部分 | alive チェック結果（`port=60372 alive=true/false`） |
| `master_spawn_proxy` | main.ts `cmdLaunchMaster()` | spawn-master 実行時のプロキシポート |
| `master_spawn_proxy_missing` | main.ts `cmdLaunchMaster()` | resolveProxyPort() が undefined の場合 |
| `master_restart_proxy` | daemon.ts `restartMasterForProxyChange()` | proxy 変化による Master 再起動開始 |
| `conductor_spawn_proxy` | main.ts `cmdConductor()` | conductor 起動時のプロキシポート |
| `conductor_spawn_proxy_missing` | main.ts `cmdConductor()` | conductor 起動時に proxy なし |

## 5. リスク・注意点

### 5-1. Master 再起動時のユーザー体験

- Master が閉じられ再起動されるため、ユーザーが操作中の場合は中断される
- **緩和策**: Master 再起動前に `proxy_port_changed` ログを記録し、ダッシュボードに表示されるようにする
- 実用上は daemon_auto_restart はソース変更時（開発者がコード編集中）に発生するため、Master 操作中に突然発生する可能性は低い

### 5-2. Conductor の proxy 問題は未対応

- 本計画では Conductor の proxy 更新は対象外
- Conductor はタスク実行中の可能性があり、再起動は作業の中断を意味する
- Conductor の `ANTHROPIC_BASE_URL` は `execFileSync("claude", ...)` 時に固定される
- **後続タスクで対応**: idle Conductor は再起動、active Conductor はタスク完了後に再起動

### 5-3. `readProxyPortFile()` と `resolveProxyPort()` の使い分け

- `readProxyPortFile()`: ファイルからポート文字列を読むだけ（TCP チェックなし）— tick() でのポート変化検出用
- `resolveProxyPort()`: TCP 生存確認付き — Master/Conductor 起動時のポート解決用
- 2つの関数の責務を明確に分離する

### 5-4. race condition

- `tick()` が proxy ポート変化を検出してから Master を再起動する間に、別の `tick()` が走る可能性
- daemon はシングルスレッドの await ループなので、同時に `tick()` が走ることはない → race condition なし

### 5-5. テスト方法

- 自動テストはないため、E2E で検証:
  1. `cmux-team start` で起動
  2. Manager ソースファイルを編集して daemon_auto_restart を発動
  3. proxy が再起動され新ポートになった場合、Master が自動再起動されることを確認
  4. ログに `proxy_port_changed`, `master_restart_proxy`, `master_spawn_proxy` が記録されることを確認
