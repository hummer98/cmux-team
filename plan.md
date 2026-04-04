# TUI ダッシュボード早期表示 — 実装計画書

## 概要

Manager daemon の起動シーケンス（`main.ts` の `cmdStart`）で、TUI ダッシュボード（`startDashboard`）を **ロギングプロキシ起動直後** に表示開始し、Conductor/Master の起動進捗を TUI のジャーナルでリアルタイム表示する。

現状はすべての起動処理が完了した後に TUI を表示しているため、起動中はターミナルに `console.log` が流れるだけで視認性が低い。TUI を早期表示することで、起動プロセス全体がダッシュボード上で可視化される。

### 変更の要点

1. `DaemonState` に `bootPhase` フィールドを追加
2. cmdStart 内の `console.log` を全削除し `log()` に統一
3. バージョン取得をプロキシ起動直後に移動
4. `startDashboard` をプロキシ起動後・レイアウト初期化前に呼び出す
5. `initializeLayout` / `startMaster` は TUI 表示後にバックグラウンド実行
6. ダッシュボードのヘッダーに `bootPhase` を反映（STARTING / RUNNING / STOPPED）
7. `startMaster` / `initializeLayout` 内の `console.log` も `log()` に置換

---

## 変更ステップ

### ステップ 1: DaemonState に bootPhase を追加

**対象ファイル**: `skills/cmux-team/manager/daemon.ts`

**変更箇所**: DaemonState インターフェース（行 31〜52）

```typescript
// 行 32 の running の直後に追加
export interface DaemonState {
  running: boolean;
  bootPhase: "infra" | "conductors" | "master" | "ready";  // ← 追加
  masterSurface: string | null;
  // ...（残りは既存のまま）
}
```

**変更箇所**: createDaemon 関数（行 65〜86）

```typescript
// 行 67 の running: true の直後に追加
return {
  running: true,
  bootPhase: "infra",  // ← 追加
  masterSurface: null,
  // ...
};
```

---

### ステップ 2: cmdStart 内の console.log を削除

**対象ファイル**: `skills/cmux-team/manager/main.ts`

以下の行の `console.log` を **すべて削除**（ログ情報は既存の `log()` 呼び出しでカバーされているか、後続ステップで `log()` に置換する）。

| 行番号 | 現在の console.log | 対応 |
|--------|-------------------|------|
| 170 | `console.log("🚀 cmux-team 起動開始")` | 削除（daemon_started ログで代替） |
| 188 | `console.log("✅ インフラ準備完了")` | `await log("infra_ready")` に置換 |
| 195 | `console.log("⏳ ロギングプロキシ確認中...")` | 削除（proxy_reused / proxy_started ログで代替） |
| 199 | `console.log("✅ ロギングプロキシ: 既存プロセスを再利用 ...")` | 削除（proxy_reused ログあり） |
| 208 | `console.log("✅ ロギングプロキシ起動完了 ...")` | 削除（proxy_started ログあり） |
| 211 | `console.log("⚠️  ロギングプロキシ起動失敗 (続行)")` | 削除（proxy_start_failed ログあり） |
| 242 | `console.log("✅ 起動完了 — ダッシュボードに切り替えます\n")` | 削除 |

**注意**: 行 174 の `console.error("❌ cmux 環境外です ...")` は TUI 起動前なのでそのまま残す。

---

### ステップ 3: startMaster / initializeLayout 内の console.log を log() に置換

**対象ファイル**: `skills/cmux-team/manager/daemon.ts`

#### startMaster（行 226〜258）

| 行番号 | 現在 | 置換後 |
|--------|------|--------|
| 237 | `console.log("✅ Master: 既存セッション検出 (スキップ)")` | 削除（直後の `log("master_alive", ...)` で代替） |
| 249 | `console.log("⏳ Master 起動中...")` | `await log("master_spawning")` |
| 254 | `console.log("✅ Master 起動完了 ...")` | `await log("master_started", "surface=" + master.surface)` |
| 256 | `console.log("❌ Master 起動失敗")` | `await log("master_spawn_failed")` |

#### initializeLayout（行 260〜313）

| 行番号 | 現在 | 置換後 |
|--------|------|--------|
| 299 | `console.log("✅ Conductor スロット: team.json から ...")` | 削除（直後の `log("conductors_restored", ...)` で代替） |

---

### ステップ 4: バージョン取得をプロキシ起動直後に移動

**対象ファイル**: `skills/cmux-team/manager/main.ts`

現在の位置（行 255〜264）からバージョン取得コードを **プロキシ起動後（行 214 の後）** に移動する。

```typescript
// プロキシ起動コード（行 194〜214）の直後に移動
// ↓ バージョン取得（startDashboard に渡すため先に実行）
let version: string | undefined;
try {
  const pluginJsonPath = join(dirname(import.meta.path), "../../..", ".claude-plugin/plugin.json");
  if (existsSync(pluginJsonPath)) {
    version = JSON.parse(await readFile(pluginJsonPath, "utf-8")).version;
  }
} catch (e: any) {
  await log("error", `version read failed: ${e.message}`);
}
```

元の位置（行 255〜264）のコードは削除する。

---

### ステップ 5: startDashboard を早期に呼び出す

**対象ファイル**: `skills/cmux-team/manager/main.ts`

バージョン取得の直後（ステップ 4 の後）に、以下を挿入する:

```typescript
// --- TUI ダッシュボード早期表示 ---
const { scheduleRefresh } = await startDashboard(() => state, {
  version,
  onReload: async () => {
    // 既存のまま（行 270〜288 のコードをそのまま維持）
    unmountDashboard();
    const latestMainTs = findLatestMainTs();
    await log("daemon_reload");
    await log("daemon_reload_target", latestMainTs);
    state.running = false;
    const { execFileSync } = require("child_process");
    try {
      execFileSync("bash", ["-c", `exec bun run "${latestMainTs}" start`], {
        stdio: "inherit",
        env: process.env,
        cwd: process.cwd(),
      });
    } catch (e: any) {
      await log("error", `daemon reload exec failed: ${e.message}`);
    }
    process.exit(0);
  },
  onQuit: () => { shutdown(); },
  onFullQuit: async () => {
    // 既存のまま（行 290〜338 のコードをそのまま維持）
  },
});
```

**重要**: `shutdown` 関数と `onFullQuit` の中で `state` を参照するため、これらのコード内では `state` が正しくスコープに入っている必要がある。現状の構造で問題ない（`shutdown` は `cmdStart` 内で定義するため）。

ただし **`shutdown` の定義を `startDashboard` より前** に移動する必要がある（`onQuit` コールバックで参照するため）。

**シグナルハンドリングの移動**: 現在の行 244〜253 のコードを startDashboard の**前**に移動する。

```typescript
// シグナルハンドリング（TUI 起動前に設定）
const shutdown = async () => {
  state.running = false;
  await log("daemon_stopped");
  await updateTeamJson(state);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// TUI ダッシュボード早期表示
const { scheduleRefresh } = await startDashboard(() => state, { ... });
```

---

### ステップ 6: initializeLayout / startMaster を TUI 表示後に実行

**対象ファイル**: `skills/cmux-team/manager/main.ts`

startDashboard の直後に、以下の順序で実行する:

```typescript
// --- Conductor + Master 起動（TUI 上で進捗表示） ---

// daemon surface 取得
let daemonSurface: string | undefined = process.env.CMUX_SURFACE;
if (daemonSurface) {
  await log("daemon_surface", `surface=${daemonSurface} (env)`);
} else {
  try {
    daemonSurface = await cmux.getCallerSurface();
    await log("daemon_surface", `surface=${daemonSurface} (identify)`);
  } catch (e: any) {
    await log("daemon_surface_fallback", e.message);
  }
}

// daemon タブタイトル設定
if (daemonSurface) {
  const num = daemonSurface.replace("surface:", "");
  await cmux.renameTab(daemonSurface, `[${num}] Manager`);
}

// Conductor スロット作成
state.bootPhase = "conductors";
scheduleRefresh();
await initializeLayout(state, daemonSurface);
scheduleRefresh();

// Master spawn
state.bootPhase = "master";
scheduleRefresh();
await startMaster(state, daemonSurface);
scheduleRefresh();

// 起動完了
state.bootPhase = "ready";
await updateTeamJson(state);
await log("boot_completed");
scheduleRefresh();
```

元の行 216〜242 の該当コードは削除する（startDashboard 呼び出しも含め、元の位置のものは削除）。

---

### ステップ 7: dashboard.tsx のヘッダーに bootPhase を反映

**対象ファイル**: `skills/cmux-team/manager/dashboard.tsx`

**変更箇所**: buildViewWithApp 内のヘッダー構築部分（行 652〜660 付近）

現在:
```typescript
const headerParts = [
  daemon.running ? "RUNNING" : "STOPPED",
  `PID ${process.pid}`,
  // ...
];
```

変更後:
```typescript
function bootStatus(daemon: DaemonState): string {
  if (!daemon.running) return "STOPPED";
  if (daemon.bootPhase !== "ready") return "STARTING";
  return "RUNNING";
}

const headerParts = [
  bootStatus(daemon),
  `PID ${process.pid}`,
  // ...
];
```

**補足**: `bootStatus` はファイル内のヘルパーとして `buildViewWithApp` の外（ファイルスコープ）に定義してもよいし、インラインの三項演算子でも可:

```typescript
const status = !daemon.running ? "STOPPED" : daemon.bootPhase !== "ready" ? "STARTING" : "RUNNING";
```

---

## 新規起動順序

変更後の `cmdStart` の流れ:

```
1. createDaemon + initSourceWatcher + initFileWatcher
2. initInfra → log("infra_ready")
3. ロギングプロキシ起動（既存/新規）
4. バージョン取得（plugin.json から）
5. shutdown 関数定義 + シグナルハンドリング登録
6. startDashboard ← ここで TUI 表示開始（bootPhase: "infra"）
7. daemon surface 取得 + タブ名設定
8. state.bootPhase = "conductors" → initializeLayout → scheduleRefresh
9. state.bootPhase = "master" → startMaster → scheduleRefresh
10. state.bootPhase = "ready" → updateTeamJson → log("boot_completed")
11. メインループ（tick + scheduleRefresh）
```

---

## DaemonState への追加

### 型定義

```typescript
export interface DaemonState {
  running: boolean;
  bootPhase: "infra" | "conductors" | "master" | "ready";
  // ... 既存フィールド
}
```

### 各フェーズの意味

| フェーズ | タイミング | ダッシュボード表示 |
|---------|-----------|------------------|
| `infra` | createDaemon 直後（初期値） | STARTING |
| `conductors` | initializeLayout 開始時 | STARTING |
| `master` | startMaster 開始時 | STARTING |
| `ready` | 全起動処理完了後 | RUNNING |

### createDaemon の初期値

```typescript
bootPhase: "infra",
```

---

## dashboard.tsx の変更

### ヘッダー表示

**変更箇所**: `buildViewWithApp` 内の `headerParts` 構築（行 652〜654 付近）

- `daemon.running ? "RUNNING" : "STOPPED"` を3状態に拡張:
  - `!daemon.running` → `"STOPPED"`
  - `daemon.bootPhase !== "ready"` → `"STARTING"`
  - それ以外 → `"RUNNING"`

### import の追加

`DaemonState` の型は既に dashboard.tsx で使用されているため、`bootPhase` の追加で import の変更は不要。

---

## テスト観点

### 手動テストで確認すべきポイント

1. **TUI 早期表示**: `cmux-team start` 実行後、Conductor/Master 起動**前**にダッシュボードが表示されること
2. **STARTING 表示**: 起動中はヘッダーが `STARTING` と表示されること
3. **RUNNING 遷移**: Conductor + Master 起動完了後にヘッダーが `RUNNING` に変わること
4. **ジャーナル進捗**: Conductor/Master の起動ログがジャーナルタブにリアルタイムで表示されること
5. **console.log 非表示**: TUI 起動後に生テキストがターミナルに出力されないこと
6. **onReload 動作**: `r` キーでリロードが正常に動作すること
7. **onQuit / onFullQuit**: `q` / `Q` キーが正常に動作すること
8. **シグナルハンドリング**: Ctrl+C で graceful shutdown すること
9. **既存 Conductor 復元**: team.json に既存 Conductor がある場合、復元が正常に動作すること
10. **cmux 環境外エラー**: cmux 外で実行した場合のエラーメッセージが表示されること（console.error はそのまま）

---

## リスクと注意点

1. **shutdown 関数のスコープ**: `startDashboard` の `onQuit` コールバックが `shutdown` を参照するため、`shutdown` の定義は `startDashboard` 呼び出しより前に配置する必要がある。元のコードでは `startDashboard` の後に定義されていた（`onQuit` がクロージャで参照できていたのは、呼び出しが遅延されるため）が、明示的に前に移動する方が安全。

2. **scheduleRefresh の呼び出しタイミング**: `initializeLayout` / `startMaster` 内で state を変更した場合、直後に `scheduleRefresh()` を呼ばないと TUI に反映されない。各フェーズ切り替え時に確実に呼ぶこと。

3. **onFullQuit 内の Conductor 参照**: 起動途中（bootPhase が conductors の最中）に `Q` が押された場合、`state.conductors` が空または不完全な可能性がある。ただし既存コードでも for-of で空 Map をイテレートするだけなので実害はない。

4. **TUI 起動前のエラー**: `initInfra` やプロキシ起動で致命的エラーが発生した場合、TUI 起動前なので従来通り `process.exit(1)` で終了する。この部分は変更なし。

5. **他サブコマンドへの影響なし**: `console.log` の削除は `cmdStart` 内に限定。`status`, `trace`, `create-task` 等のサブコマンドの `console.log` は変更しない。
