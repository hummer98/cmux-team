# Plan: Manager の cmux tree タイムアウトを crash 判定から除外

## 1. 現状分析

### 1.1 cmux 呼び出し箇所（`skills/cmux-team/manager/`）

| 箇所 | 用途 | エラーハンドリング |
|------|------|---------------------|
| `cmux.ts:20` `runCmux()` | 全 cmux コマンドの execFile ラッパー。失敗時は `formatExecError(e)` で wrap し再 throw。元 Error は `cause` で保持、`stderr`/`stdout` を転写 | OK（既に整形済み） |
| `cmux.ts:124` `tree()` | `timeout: 5_000` で `cmux tree --workspace <ws>` 実行 | runCmux に委譲 |
| `cmux.ts:164` `validateSurface()` | `tree()` を最大 3 回（バックオフ 200/400/800ms）リトライ。全失敗で `validate_surface_failed` ログ → `false` 返却 | リトライ済み・ただし return false が daemon 側で「crash」相当に解釈される |
| `daemon.ts:1011` `monitorConductors()` 冒頭の `tree()` | tick 毎に 1 回呼んで結果をキャッシュ | 失敗時 `monitor_tree_failed last_error=${e.message}`（**stderr 欠落**） |
| `daemon.ts:1056` `surfaceAlive(conductor.surface)` | キャッシュ無効時 `validateSurface()` にフォールバック。`false` で `conductor_disconnected ... kind=crashed` 認定 | crash 判定で disconnect 状態へ遷移 |

### 1.2 現在の判定フロー（running Conductor）

```
monitorConductors tick
  ↓ tree() タイムアウト or 失敗
  ↓ treeOutput = null
  ↓ surfaceAlive() → validateSurface() フォールバック
  ↓ validateSurface 内で tree() を 3 回再試行（合計 ~1.4s）
  ↓ 全失敗 → false
  ↓ daemon: kind=crashed として disconnected 化
  ↓ disconnectedAt 記録
  ↓ DISCONNECT_TIMEOUT_SEC=300 経過後 forceCloseDisconnectedConductor
  ↓ task abort（reason=disconnect_timeout）
```

### 1.3 問題点

- **タイムアウトと真クラッシュを判別していない**: `validateSurface` の戻り値が `false` でも、原因が「surface 不在」か「cmux daemon 不応答」か区別不能。後者は瞬間的高負荷でも 1〜2 tick 連続で起こりうる（事象ログ 01:56:56→01:57:28 に 3 連続）。
- **キャッシュ tree の失敗が即フォールバックを誘発**: `treeOutput=null` → `surfaceAlive` ごとに `validateSurface` を呼ぶ。daemon が不応答ならフォールバックも不応答で連鎖失敗。
- **`monitor_tree_failed` ログが `e.message` のみ**: `stderr` を含まないため原因究明不能（CLAUDE.md「ロギングポリシー」§ 違反）。
- **disconnected 経過時間がタイムアウト中もカウントされる**: cmux 復旧後に Conductor 自体は健在でも、累積 300s で abort されうる。

## 2. タイムアウト判別方法の設計

### 2.1 Node `execFile` のタイムアウト検出

`child_process.execFile` は `timeout` 超過時に SIGTERM で kill する。投げられる Error の特徴:

```
error.killed === true
error.signal === 'SIGTERM'  // または 'SIGKILL'
error.code === null
error.message === 'Command failed: cmux tree --workspace ...'
```

cmux 側の正規エラー（例: workspace not found）は `error.code` が非 0 の数値で `stderr` にメッセージが入る。両者は明確に区別可能。

### 2.2 判定ヘルパーの追加

`exec-error.ts` に以下を追加:

```ts
/** execFile タイムアウト判定: timeout で SIGTERM kill されたか */
export function isExecTimeout(e: unknown): boolean {
  const err = e as { killed?: boolean; signal?: string | null; code?: unknown };
  if (err?.killed === true && (err.signal === "SIGTERM" || err.signal === "SIGKILL")) {
    return true;
  }
  return false;
}
```

`cmux.ts` の `runCmux` で wrap する際、`wrapped.timedOut = isExecTimeout(e)` を転写しておき、上位で参照可能にする。

### 2.3 cmux tree が「成功したが中身が出力されない」ケース

execFile タイムアウト以外に、cmux daemon が SIGPIPE 等で空 stdout を返す可能性は低いが念のため: `tree()` 戻り値が空文字列なら例外として扱う（明示的に throw）。本タスクでは追加検討に留め、必須実装ではない。

## 3. 判定ロジック変更の設計

### 3.1 新ステータス `unresponsive` の導入

ConductorState に新ステータスは**追加しない**（schema 変更の影響範囲を抑える）。代わりに以下のフィールドを `ConductorState` に追加:

```ts
treeFailureCount?: number;       // 連続 tree 失敗回数（成功で 0 リセット）
treeFailureFirstAt?: string;     // 最初に失敗した ISO 時刻
```

### 3.2 連続失敗カウントによる crash 判定の遅延

`monitorConductors` の tick 冒頭 tree 呼び出し:

```ts
let treeOutput: string | null = null;
let treeError: any = null;
try {
  treeOutput = await cmux.tree(state.workspace ?? undefined);
} catch (e: any) {
  treeError = e;
  await log("monitor_tree_failed", formatExecError(e));  // ← stderr 含む
}
```

`surfaceAlive(surface)` を以下に変更:

```ts
const surfaceAlive = async (surface: string): Promise<"alive" | "missing" | "unknown"> => {
  if (treeOutput !== null) {
    return treeOutput.includes(surface) ? "alive" : "missing";
  }
  // tree 失敗時: validateSurface もタイムアウト/真エラーで分岐
  return cmux.validateSurfaceDetailed(surface, state.workspace ?? undefined);
};
```

`validateSurface` の戻り値を bool から `"alive" | "missing" | "unknown"` の 3 値に拡張する（既存呼び出し元の互換のため `validateSurface` は維持し、新たに `validateSurfaceDetailed` を export。`validateSurface` は `=== "alive"` で bool 返却）。

`validateSurfaceDetailed` のリトライ後判定:
- 1 回でも tree 成功 → `output.includes(surface)` で `alive`/`missing`
- 全失敗 + 全試行が `isExecTimeout(e)` → `unknown`
- 全失敗 + 真エラーが含まれる → `missing`（従来挙動互換）

### 3.3 Conductor running 時の判定

```ts
const result = await surfaceAlive(conductor.surface);

if (result === "alive") {
  conductor.treeFailureCount = 0;
  conductor.treeFailureFirstAt = undefined;
  // 既存の Agent 生存チェックへ
} else if (result === "unknown") {
  // タイムアウト等の一時的 cmux 不応答 — crash 判定しない
  conductor.treeFailureCount = (conductor.treeFailureCount ?? 0) + 1;
  if (conductor.treeFailureFirstAt === undefined) {
    conductor.treeFailureFirstAt = new Date().toISOString();
  }
  await log(
    "conductor_unresponsive",
    `surface=${surface} consecutive=${conductor.treeFailureCount} since=${conductor.treeFailureFirstAt}`
  );
  // 連続失敗が閾値超 + 経過秒も超過なら disconnected へ昇格
  const elapsed = (Date.now() - new Date(conductor.treeFailureFirstAt).getTime()) / 1000;
  if (
    conductor.treeFailureCount >= UNRESPONSIVE_MAX_TICKS &&
    elapsed >= UNRESPONSIVE_MAX_SEC
  ) {
    await log(
      "conductor_disconnected",
      `surface=${surface} reason=tree_unresponsive_persistent kind=cmux_unresponsive ` +
        `consecutive=${conductor.treeFailureCount} elapsed=${Math.round(elapsed)}s ` +
        `taskRunId=${conductor.taskRunId ?? "-"}`
    );
    conductor.status = "disconnected";
    conductor.disconnectedAt = new Date().toISOString();
  }
  continue;  // Agent チェックもスキップ（同じ tree に依存するため）
} else {
  // result === "missing" — 従来通り crash 判定
  await log(
    "conductor_disconnected",
    `surface=${surface} reason=validate_surface_failed kind=crashed taskRunId=${conductor.taskRunId ?? "-"}`
  );
  conductor.status = "disconnected";
  conductor.disconnectedAt = new Date().toISOString();
  continue;
}
```

### 3.4 閾値定数

```ts
/** cmux unresponsive と判定する連続 tick 閾値 */
const UNRESPONSIVE_MAX_TICKS = Number(process.env.CMUX_TEAM_UNRESPONSIVE_MAX_TICKS) || 6;
/** cmux unresponsive と判定する累積経過秒（初回失敗から） */
const UNRESPONSIVE_MAX_SEC = Number(process.env.CMUX_TEAM_UNRESPONSIVE_MAX_SEC) || 120;
```

デフォルト 10 秒 poll × 6 tick = 60s 連続失敗、かつ 120s 経過で disconnected 昇格。事象ログ（01:56:56〜01:57:28 の 32 秒で 3 失敗）では abort されない値に設定。

### 3.5 `DISCONNECT_TIMEOUT_SEC` の扱い

そのまま 300s で維持する。理由:
- `disconnected` への遷移自体を慎重化（§3.3）したため、disconnect_timeout に至る経路は本物のクラッシュに限定される
- タイムアウト中の経過時間カウントは現状維持で問題なし（disconnected 昇格以降はクラッシュとみなして良い）

将来的拡張余地として、`forceCloseDisconnectedConductor` 直前に `tree()` を再試行し、まだ daemon 不応答なら timeout を延長するオプションも検討可能（本タスクスコープ外）。

## 4. ログ強化方針

### 4.1 `formatExecError` の適用範囲

cmux コマンド呼び出しに起因する全ログを `formatExecError(e)` 経由に統一:

- `daemon.ts:1013` `monitor_tree_failed`: `e.message` → `formatExecError(e)`
- `cmux.ts:174` `validate_surface_failed`: `last_error=${e.message}` → `last_error=${formatExecError(e)}`
- `cmux.ts:143` `getPaneForSurface failed`: 同上
- `cmux.ts:206` `setStatus failed`: 同上

`cmux.ts` の `runCmux` wrap で既に `formatExecError` を message 化しているため二重整形にはならないが、上位で `e.stderr` が直接読めない場合に備えて wrap 後の Error にも `stderr`/`stdout` プロパティを残してある（既存）。`formatExecError` を呼べば wrap 済み Error からも一貫して再構成される。

### 4.2 unresponsive 関連の追加ログ

- `conductor_unresponsive surface=... consecutive=N since=ISO` （tick 毎ではなく、状態変化時のみログを抑制したい場合は `consecutive % 3 === 0` 等で間引く — 第一実装では毎 tick 出力で OK）
- `conductor_responsive_recovered surface=... after_failures=N elapsed=Xs` （unresponsive 状態から復帰時）

### 4.3 ログイベント名一覧（追加・変更）

| イベント | 種別 | 内容 |
|---------|------|------|
| `monitor_tree_failed` | 変更 | detail に stderr/stdout を含める |
| `validate_surface_failed` | 変更 | 同上 |
| `conductor_unresponsive` | 追加 | tree 失敗継続中の Conductor |
| `conductor_responsive_recovered` | 追加 | tree 復旧時 |
| `conductor_disconnected kind=cmux_unresponsive` | 追加バリエーション | 持続的不応答による昇格 |

## 5. 変更ファイル一覧

| ファイル | 変更概要 |
|---------|---------|
| `skills/cmux-team/manager/exec-error.ts` | `isExecTimeout(e)` 関数を追加 |
| `skills/cmux-team/manager/cmux.ts` | `runCmux` wrap 時に `wrapped.timedOut = isExecTimeout(e)` 転写。`validateSurfaceDetailed(surface, ws)` を新規 export（`"alive"`/`"missing"`/`"unknown"` を返却、3 試行で全 timeout なら `"unknown"`）。`validateSurface` は `validateSurfaceDetailed(...) === "alive"` のラッパとして残す。`validate_surface_failed` ログを `formatExecError(e)` 化。`getPaneForSurface failed` も同様 |
| `skills/cmux-team/manager/schema.ts` | `ConductorState` に `treeFailureCount?: number`, `treeFailureFirstAt?: string` を追加（既存セッションの読み込み互換のため optional） |
| `skills/cmux-team/manager/daemon.ts` | `monitor_tree_failed` を `formatExecError(e)` 化。`monitorConductors` の `surfaceAlive` を 3 値返却に変更。running 判定で `unknown` 時のカウント・閾値判定を実装。Agent 生存チェックは `treeOutput !== null` 時のみ実行（`unknown` 時はスキップ）。`alive` 復帰時に `treeFailureCount` リセット + `conductor_responsive_recovered` ログ。`UNRESPONSIVE_MAX_TICKS`/`UNRESPONSIVE_MAX_SEC` 定数定義 |
| `CLAUDE.md` | （任意）`CMUX_TEAM_UNRESPONSIVE_MAX_TICKS`/`CMUX_TEAM_UNRESPONSIVE_MAX_SEC` 環境変数を「コーディング規約」または「Manager プロトコル」節に追記 |

## 6. テスト方針

### 6.1 ユニットテスト（`exec-error.ts`）

新規 `skills/cmux-team/manager/exec-error.test.ts` または既存テストへ追記:

- `isExecTimeout({ killed: true, signal: 'SIGTERM' })` → `true`
- `isExecTimeout({ killed: true, signal: 'SIGKILL' })` → `true`
- `isExecTimeout({ killed: false, signal: null, code: 1 })` → `false`
- `isExecTimeout({ killed: true, signal: 'SIGTERM', code: 0 })` → `true`（code は無視）
- `isExecTimeout(new Error('plain'))` → `false`

### 6.2 ユニットテスト（`cmux.ts`）

`validateSurfaceDetailed` のモック検証:
- 1 回目で tree 成功・surface 含む → `"alive"`
- 1 回目で tree 成功・surface 不在 → `"missing"`
- 3 回全て execFile timeout → `"unknown"`
- 3 回全て真エラー（ENOENT 等） → `"missing"`
- timeout + timeout + 真エラー → `"missing"`（混在時は missing 寄せ）

実装には `runCmux` を vi.mock するか、`tree` を直接モック注入できるよう薄い refactor が必要。最小実装: `validateSurfaceDetailed` の中で各試行の `isExecTimeout` を配列に蓄積し、全要素 true なら `"unknown"`。

### 6.3 手動検証

1. **正常系（既存挙動温存）**:
   - cmux-team start で Conductor 3 つ起動
   - `cmux close-surface --surface conductor-1-surface` で意図的に kill
   - `manager.log` に `conductor_disconnected ... kind=crashed` が出ることを確認（30s 以内）
   - 5 分後に `task_aborted reason=disconnect_timeout` が出ること

2. **異常系（タイムアウト誤判定の修正検証）**:
   - cmux daemon に SIGSTOP を送信して一時的に応答停止 (`kill -STOP $(pgrep -f 'cmux daemon')`)
   - 30〜60 秒待機後 SIGCONT で再開
   - `manager.log` に `monitor_tree_failed` (stderr 含む) と `conductor_unresponsive consecutive=N` が出ること
   - SIGCONT 後に `conductor_responsive_recovered` が出ること
   - **task が aborted にならないこと**（task-state.json で確認）

3. **持続的不応答（昇格パス）**:
   - cmux daemon SIGSTOP のまま 3 分以上放置
   - `conductor_disconnected ... kind=cmux_unresponsive consecutive=>=6 elapsed=>=120s` が出ること
   - その後 5 分で `task_aborted` 発生

4. **ログ内容確認**:
   - `monitor_tree_failed` の出力例:
     ```
     [...] monitor_tree_failed Command failed: cmux tree --workspace workspace:4 | stderr=Error: Command timed out
     ```
   - 旧来の `last_error=Command failed: ...` 単独ではなく stderr が含まれていること

## 7. 受け入れ基準チェックリスト

- [ ] cmux tree が一時的にタイムアウト（連続 5 tick 以下、累積 120s 未満）しても、Conductor が稼働中であれば task が aborted にならない
- [ ] `monitor_tree_failed` 等の cmux エラーログに stderr が含まれる（`formatExecError` 適用）
- [ ] `validate_surface_failed` ログにも stderr が含まれる
- [ ] `conductor_unresponsive` / `conductor_responsive_recovered` ログが出力される
- [ ] 既存の本物クラッシュ検出（surface が tree 出力に存在しない場合）は変わらず `kind=crashed` で disconnect される
- [ ] `disconnected` 状態の forced cleanup (`DISCONNECT_TIMEOUT_SEC=300`) は引き続き機能する
- [ ] CLAUDE.md「ロギングポリシー」§ の「error オブジェクトに `stderr` / `stdout` が付いている場合は必ず detail に含める」を満たす
- [ ] `bun test` 等のユニットテスト追加 (`isExecTimeout`, `validateSurfaceDetailed` の 3 値返却)
- [ ] 環境変数 `CMUX_TEAM_UNRESPONSIVE_MAX_TICKS`, `CMUX_TEAM_UNRESPONSIVE_MAX_SEC` で閾値を上書き可能
- [ ] 既存セッション (`conductors/*.json`) を読み込んでも `treeFailureCount` 未設定で動作する（optional 後方互換）

## 8. 実装順序の推奨

1. `exec-error.ts` に `isExecTimeout` + テスト
2. `cmux.ts` の `runCmux` で `timedOut` 転写、`validate_surface_failed` ログを `formatExecError` 化
3. `cmux.ts` に `validateSurfaceDetailed` 追加 + テスト
4. `schema.ts` に optional フィールド追加
5. `daemon.ts` の `monitorConductors` 書き換え（unresponsive 経路 + ログ強化）
6. 手動検証（cmux daemon SIGSTOP/SIGCONT シナリオ）
7. PR 作成
