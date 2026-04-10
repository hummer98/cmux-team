# T137: Manager daemon サイドバーステータス更新 — 実装計画書

## 1. 変更対象ファイル一覧

| ファイル | 変更内容 |
|---------|---------|
| `skills/cmux-team/manager/cmux.ts` | `setStatus()` / `clearStatus()` ヘルパー関数を追加 |
| `skills/cmux-team/manager/daemon.ts` | `DaemonState` に `lastSidebarStatus` / `lastSidebarCategory` フィールド追加、`SIDEBAR_STATUS_KEY` 定数追加、`computeSidebarStatus()` 純粋関数と `updateSidebarStatus()` 関数を新設 |
| `skills/cmux-team/manager/main.ts` | メインループで `tick()` → `updateTeamJson()` → `updateSidebarStatus()` の順に直列実行。shutdown 時に `clearStatus()` を呼ぶ |

dashboard.tsx の `formatResetRemaining()` は現在 `function`（非 export）。daemon.ts から再利用するために **export 化せず、daemon.ts 側にロジックを自前で持つ**。理由: dashboard.tsx は React/Ink の TUI モジュールであり、daemon.ts が import すると依存関係が不自然になる。`formatResetRemaining` は 20 行程度の純関数なのでコピーのコストが低い。

## 2. 状態判定ロジック（優先度付きフローチャート）

判定は上から順に評価し、最初にマッチした状態を採用する。

```
1. エラー/要対応
   条件: conductors に status === "disconnected" のものが存在する
   値: "! attention"
   アイコン: exclamationmark.triangle
   色: #FF3B30（赤）

2. スロットリング
   条件: state.rateLimit?.unified5hUtilization >= THROTTLE_5H_THRESHOLD
         OR state.rateLimit?.unifiedStatus === "rate_limited"
   値: "⏸ reset {remaining}"   ← formatResetRemaining(unified5hReset)
   アイコン: pause.circle.fill
   色: #FF3B30（赤）

3. タスク実行中（待ちタスクあり）
   条件: runningCount > 0 AND state.pendingTasks > 0
   値: "{runningCount} running +{state.pendingTasks}"
   アイコン: bolt.fill
   色: #4C8DFF（青）

4. タスク実行中（待ちなし）
   条件: runningCount > 0
   値: "{runningCount} running"
   アイコン: bolt.fill
   色: #4C8DFF（青）

5. 全タスク完了
   条件: openTasks === 0 AND prevCategory が idle/done 以外
         （= error, throttled, running, running_pending のいずれか）
   値: "done"
   アイコン: checkmark.circle.fill
   色: #34C759（緑）
   ※ "done" 表示後、次 tick で openTasks === 0 のままなら 6 の idle に遷移

6. アイドル
   条件: 上記いずれにも該当しない（全 Conductor idle && openTasks 0）
   値: "idle"
   アイコン: pause.circle.fill
   色: #8E8E93（グレー）
```

`runningCount` = `[...state.conductors.values()].filter(c => c.status === "running").length`

### "done" → "idle" 遷移ルール

"done" は直前に idle/done **以外**だった場合のみ 1 tick 分表示される。次 tick で openTasks が 0 のままならば idle に落ちる。これは `prevCategory`（`computeSidebarStatus` の引数として渡される）で判断する:
- `prevCategory` が `"error"` / `"throttled"` / `"running"` / `"running_pending"` のとき → `"done"` を表示
- `prevCategory` が `"done"` / `"idle"` / `null` のとき → `"idle"` に遷移

## 3. cmux.ts のヘルパー関数

### `setStatus(key, value, icon, color, workspace?)`

```typescript
export async function setStatus(
  key: string,
  value: string,
  icon: string,
  color: string,
  workspace?: string,
): Promise<void> {
  const args = ["set-status", key, value, "--icon", icon, "--color", color];
  if (workspace) args.push("--workspace", workspace);
  try {
    await execFile("cmux", args);
  } catch (e: any) {
    // set-status 失敗は致命的ではないため、ログのみで握りつぶす
    await log("error", `setStatus failed: key=${key} value=${value} ${e.message}`);
  }
}
```

### `clearStatus(key, workspace?)`

```typescript
export async function clearStatus(
  key: string,
  workspace?: string,
): Promise<void> {
  const args = ["clear-status", key];
  if (workspace) args.push("--workspace", workspace);
  try {
    await execFile("cmux", args);
  } catch (e: any) {
    // 冪等な後処理のため、失敗は握りつぶす
  }
}
```

## 4. daemon.ts への統合方法

### 4.1 定数定義

daemon.ts のトップレベルに配置:

```typescript
const SIDEBAR_STATUS_KEY = "claude_code";
```

### 4.2 DaemonState に追加するフィールド

```typescript
export interface DaemonState {
  // ... 既存フィールド ...
  /** サイドバーステータスの前回表示値（差分抑制用） */
  lastSidebarStatus: string | null;
  /** サイドバーステータスの前回カテゴリ（遷移判定用） */
  lastSidebarCategory: string | null;
}
```

`createDaemon()` で `lastSidebarStatus: null`, `lastSidebarCategory: null` を初期値として設定。

### 4.3 `computeSidebarStatus()` — 純粋関数

DaemonState 全体ではなく必要なフィールドのみを受け取る。`prevCategory` は明示的引数として渡す。

```typescript
type SidebarStatus = {
  label: string;
  icon: string;
  color: string;
  /** lastSidebarCategory の遷移判定用カテゴリ */
  category: "error" | "throttled" | "running" | "running_pending" | "done" | "idle";
};

function computeSidebarStatus(
  state: Pick<DaemonState, "conductors" | "rateLimit" | "pendingTasks" | "openTasks">,
  prevCategory: string | null,
): SidebarStatus {
  const conductors = [...state.conductors.values()];
  const runningCount = conductors.filter(c => c.status === "running").length;
  const hasDisconnected = conductors.some(c => c.status === "disconnected");

  // 1. エラー/要対応
  if (hasDisconnected) {
    return {
      label: "! attention",
      icon: "exclamationmark.triangle",
      color: "#FF3B30",
      category: "error",
    };
  }

  // 2. スロットリング
  const throttled = (state.rateLimit?.unified5hUtilization ?? 0) >= THROTTLE_5H_THRESHOLD
    || state.rateLimit?.unifiedStatus === "rate_limited";
  if (throttled) {
    const remaining = formatResetRemaining(state.rateLimit?.unified5hReset ?? null);
    return {
      label: remaining ? `⏸ reset ${remaining}` : "⏸ throttled",
      icon: "pause.circle.fill",
      color: "#FF3B30",
      category: "throttled",
    };
  }

  // 3-4. タスク実行中
  if (runningCount > 0) {
    const label = state.pendingTasks > 0
      ? `${runningCount} running +${state.pendingTasks}`
      : `${runningCount} running`;
    return {
      label,
      icon: "bolt.fill",
      color: "#4C8DFF",
      category: state.pendingTasks > 0 ? "running_pending" : "running",
    };
  }

  // 5. 全タスク完了（直前が idle/done 以外の場合のみ）
  if (state.openTasks === 0
    && prevCategory !== null
    && prevCategory !== "idle"
    && prevCategory !== "done") {
    return {
      label: "done",
      icon: "checkmark.circle.fill",
      color: "#34C759",
      category: "done",
    };
  }

  // 6. アイドル（デフォルト）
  return {
    label: "idle",
    icon: "pause.circle.fill",
    color: "#8E8E93",
    category: "idle",
  };
}
```

### 4.4 `updateSidebarStatus()` 関数

main.ts のメインループから `tick()` → `updateTeamJson()` の後に直列で呼ばれる。

```typescript
export async function updateSidebarStatus(state: DaemonState): Promise<void> {
  if (!state.workspace) return; // workspace 不明時はスキップ

  const status = computeSidebarStatus(state, state.lastSidebarCategory);

  // 差分抑制: 前回と同じ値なら cmux 呼び出しをスキップ
  const statusKey = `${status.label}|${status.icon}|${status.color}`;
  if (statusKey === state.lastSidebarStatus) return;
  state.lastSidebarStatus = statusKey;
  state.lastSidebarCategory = status.category;

  await cmux.setStatus(SIDEBAR_STATUS_KEY, status.label, status.icon, status.color, state.workspace);
}
```

### 4.5 main.ts メインループへの組み込み

`tick()` → `updateTeamJson()` → `updateSidebarStatus()` の順に直列実行する。

```typescript
// main.ts メインループ（抜粋）
while (state.running) {
  await tick(state);
  await updateTeamJson(state);
  await updateSidebarStatus(state);  // 新規追加
  await sleep(pollInterval);
}
```

`tick()` 内では `scanTasks()` が `state.openTasks` / `state.pendingTasks` を、`monitorConductors()` が Conductor の `status` を更新する。それらが完了し、`updateTeamJson()` も完了した後に `updateSidebarStatus()` を呼ぶことで、最新の状態に基づいた正確なステータス判定が行える。

### 4.6 `formatResetRemaining()` のコピー

dashboard.tsx から以下の純関数をコピーする（daemon.ts 内に private 関数として配置）:

```typescript
function formatResetRemaining(resetIso: string | null): string {
  if (!resetIso) return "";
  const asNum = Number(resetIso);
  const resetMs = !isNaN(asNum) && asNum > 1e9 ? asNum * 1000 : new Date(resetIso).getTime();
  if (isNaN(resetMs)) return "";
  const sec = Math.floor((resetMs - Date.now()) / 1000);
  if (sec <= 0) return "0m";
  if (sec < 60) return "<1m";
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return m > 0 ? `${h}h${m}m` : `${h}h`;
  }
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  return h > 0 ? `${d}d${h}h` : `${d}d`;
}
```

## 5. 差分抑制の設計

### メモリ構造

DaemonState に 2 フィールドを追加:

| フィールド | 型 | 初期値 | 用途 |
|-----------|---|-------|------|
| `lastSidebarStatus` | `string \| null` | `null` | `"label\|icon\|color"` のキー。前回と同じならスキップ |
| `lastSidebarCategory` | `string \| null` | `null` | `"running"` / `"done"` / `"idle"` 等。"done" 遷移判定用 |

### 更新フロー

1. `computeSidebarStatus(state, state.lastSidebarCategory)` で現在の状態を判定（`state` は必要フィールドのみ参照）
2. `statusKey = "${label}|${icon}|${color}"` を生成
3. `statusKey === state.lastSidebarStatus` なら **return**（cmux 呼び出しスキップ）
4. 異なれば `cmux.setStatus()` を呼び、`lastSidebarStatus` と `lastSidebarCategory` を更新

これにより、10 秒ごとの tick で毎回 `cmux set-status` を呼ぶことを防ぐ。

## 6. エッジケース

### workspace が null の場合

`state.workspace` は `createDaemon()` 時は `null`、`main.ts` の起動処理で `getCallerWorkspace()` により設定される。`updateSidebarStatus()` 冒頭で `if (!state.workspace) return;` とし、workspace 未確定時はスキップ。

### daemon 起動直後（bootPhase !== "ready"）

`tick()` は `bootPhase === "ready"` になるまで呼ばれない（main.ts のメインループ構造による）。`bootPhase` が "infra" / "conductors" / "master" の間はサイドバー更新不要。

ただし、起動直後の `tick()` 初回では `lastSidebarCategory` が `null` のため、openTasks === 0 でも "done" は表示されない（`prevCategory !== null` の条件により "idle" になる。意図通り）。

### graceful shutdown 時の clear-status

main.ts の `shutdown()` 関数に `clearStatus` 呼び出しを追加:

```typescript
const shutdown = async () => {
  state.running = false;
  state.fileWatcherAbort?.abort();
  state.fileWatcherAbort = null;
  // サイドバーステータスをクリア
  if (state.workspace) {
    await cmux.clearStatus(SIDEBAR_STATUS_KEY, state.workspace);
  }
  await log("daemon_stopped");
  await updateTeamJson(state);
  process.exit(0);
};
```

### auto-restart（source_changed / npm_auto_update）時

`state.running = false; state.restartRequested = true;` 後、main.ts のメインループが `process.exit(42)` する。この直前に `clearStatus` は **不要**（再起動後の daemon が即座に新しいステータスを設定するため）。

### rateLimit が null の場合

proxy 未起動時は `state.rateLimit` が `null`。この場合スロットリング判定はスキップされ（`?? 0` により閾値を下回る）、次の判定（running / done / idle）に進む。

### "done" が表示され続ける問題の防止

"done" は 1 tick のみ表示。次 tick で `openTasks === 0` かつ `prevCategory === "done"` なら `computeSidebarStatus()` は `"idle"` を返す（条件 5 の `prevCategory !== "done"` に該当しないため）。差分抑制により `"idle"` は 1 回だけ `set-status` される。

### throttled → 完了のパスで "done" が表示される

従来の計画では "done" の条件が `prevCategory === "running" || "running_pending"` に限定されていたため、throttled 状態からタスクが完了した場合に "done" が表示されなかった。修正後は `prevCategory` が `"idle"` / `"done"` / `null` **以外**であれば "done" を表示するため、throttled → 完了のパスでも正しく "done" が 1 tick 表示される。
