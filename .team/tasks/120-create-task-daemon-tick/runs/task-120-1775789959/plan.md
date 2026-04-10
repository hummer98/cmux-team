# T120 実装計画 — create-task 直後の daemon 即時反応

## 概要

`cmux-team create-task --status ready` や `update-task --status ready` 等の CLI 実行後、daemon の tick 反映まで最大 ~10 秒かかる現象を解消する。原因は (a) `state.wakeup` が `sleepUntilWakeup` 呼び出し中しか有効でないため tick 実行中に届いた HTTP 通知が取りこぼされる、(b) fs.watch が `.team/tasks/` 直下のみ・非再帰で、現行のフォルダ構造タスク（`NNN-slug/task.md`）や `task-state.json` の変更を拾えない、の 2 点。

修正は「wakeup を `wakeupPending` フラグ + resolve 関数の二本立てに統一する (A)」「fs.watch を再帰化し `task-state.json` も監視対象に含める (B)」の二段階防御。10 秒ポーリングはフェイルセーフとして維持。

## 調査結果

実装を worktree 内で Read して確認した事実。タスク指示の事実に加えて以下を追加で確定した。

### Bun fs.watch の recursive 対応（macOS / Bun 1.3.11）

実機で `fs.watch("/tmp/bun-watch-test", { recursive: true })` を実行 → サブディレクトリ (`sub/new.txt`) とトップレベル (`top.txt`) 両方の `rename` イベントを取得できた。よって**再帰監視はそのまま使える**。サブディレクトリ個別監視のフォールバックは不要（実装の簡略化のため、最小版では再帰のみサポートし、recursive 未対応環境は諦める方針とする — 現状のサポート環境は Bun 1.3+ on macOS）。

### タスクファイルのディレクトリ構造

`create-task` (`main.ts:1091-1094`) は新規タスクを `.team/tasks/NNN-slug/task.md` に書き出す（フラット構造ではなくフォルダ構造）。現行の非再帰 watch は `NNN-slug/` ディレクトリの作成イベント（`rename:NNN-slug`）は拾える可能性があるが、その中の `task.md` 作成は拾えない。また `loadTasks` (`task.ts:120-150`) は `task.md` の存在前提でパースするため、ディレクトリ作成と同じ tick で scanTasks しても無効タスクとしてスキップされる恐れがある。→ 再帰 watch を入れれば `task.md` の作成を直接検知できる。

### `saveTaskState` の書き込み方式

`task.ts:102-107` は `writeFile(tmp)` → `rename(tmp, filePath)` のアトミック書き込み。fs.watch 側ではリネームイベントが 1〜2 回発生する（`.tmp` と `task-state.json` それぞれ）。`writeFile → rename` の間隔は通常 5–10ms 程度なので、**50ms debounce** で同一バッチとしてまとめられる。片方しかイベントが届かない環境でも `schedule()` が 1 回走れば十分なので問題ない。

### `scheduleRefresh` の debounce

`dashboard.tsx:1194-1203` で 100ms の固定 debounce。wakeup → tick → scheduleRefresh の合計オーバーヘッドは実測で 300ms 未満に収まる見込み。現状維持で OK。

### 受け入れ条件「fs.watch フェイルセーフ 200ms 以内」の内訳

ユーザー体感の 200ms は次の 3 段階の合計として想定する:

| 段階 | 時間 | 根拠 |
|---|---|---|
| ① watcher のイベント → `schedule()` debounce 発火 | 〜50ms | Step 6 の `setTimeout` |
| ② `requestWakeup` → sleep 抜け → 次 tick の scanTasks / updateTeamJson 完了 | 数十〜100ms | 実測で tick 1 周は 100ms 未満 |
| ③ `scheduleRefresh` の debounce → UI 反映 | 100ms | `dashboard.tsx:1194-1203` 固定値 |
| **合計** | **〜200ms** | |

旧案の 100ms debounce だと ③ と合わせて 300ms に寄るため、**debounce は 50ms に設定**する。

### 通知を送らない CLI コマンド

- `delete-task` (`main.ts:1363-1401`) は `task-state.json` を書き換えるだけで `postMessage()` を一切呼んでいない。
- `close-task` / `abort-task` は CONDUCTOR_DONE を送るが、これは Conductor 停止目的であり「タスク状態が変わった」汎用シグナルではない。

受け入れ条件に `delete-task` の即時反応も含まれるため、**fs.watch 経路での `.team/task-state.json` 監視は必須**（HTTP 通知だけでは delete-task をカバーできない）。

### `handleMessage` の wakeup 呼び出し箇所

grep の結果、`state.wakeup?.()` は `daemon.ts:158`（initFileWatcher）と `daemon.ts:395`（handleMessage TASK_CREATED）の 2 箇所のみ。`state.wakeup = null`・`state.wakeup =` の代入は `sleepUntilWakeup` 内のみ。置き換え対象は少ない。

### main.ts の shutdown パス

`main.ts:255-260` に `shutdown` 関数が定義され、SIGINT/SIGTERM と onQuit、onReload 経由で `state.running = false` が実行される（他に `main.ts:272, 350`）。watcher の明示停止は現状存在せず、`state.running = false` を見て for-await の次イベント待ちで抜けるつくりだが、次イベントが来ないとループがブロックされる。→ **AbortController 経由で watcher を決定論的に停止**する必要がある（特に `bun test` が終わらない問題を避けるため）。

### 既存テスト状況

`daemon.test.ts` には wakeup / watcher に対するテストは存在しない（grep で 0 件）。新規追加になる。

## 実装ステップ

### Step 1 — `DaemonState` に `wakeupPending` と `fileWatcherAbort` を追加

**ファイル**: `skills/cmux-team/manager/daemon.ts`

**変更内容**:

1. `DaemonState` インターフェース (`daemon.ts:35-67`) に以下 2 フィールドを追加:
   - `wakeupPending: boolean`
   - `fileWatcherAbort: AbortController | null`
2. `createDaemon` (`daemon.ts:80-106`) の初期化で:
   - `wakeupPending: false`
   - `fileWatcherAbort: null`

**なぜ**:

- `wakeupPending`: tick 実行中に届いた wakeup 要求を状態として保持するため。関数 (`state.wakeup`) は `sleepUntilWakeup` 呼び出し中しか有効でないので、それとは別に「要求があった」ことを記録する場所が必要。
- `fileWatcherAbort`: fs.watch の async iterator を外部から決定論的に終わらせるため。`state.running = false` だけでは次のイベントが来るまでループが抜けない。特に単体テストで watcher が走ったまま test が終わると bun test がハングする。

**検証**: 型エラーが出ないこと（`bun run tsc --noEmit` 相当を bun の型検査で）。`daemon.test.ts` の既存テストが通ること。

---

### Step 2 — `requestWakeup` 関数を追加

**ファイル**: `skills/cmux-team/manager/daemon.ts`

**変更内容**: 新しい export 関数を追加:

```ts
export function requestWakeup(state: DaemonState): void {
  state.wakeupPending = true;
  state.wakeup?.();  // sleep 中なら即 resolve
}
```

**なぜ**: 呼び出し側を統一する。tick 中か sleep 中かを呼び出し側が気にしなくていい単一 API にする。

**検証**: Step 4 の単体テストと合わせて確認。

---

### Step 3 — `sleepUntilWakeup` を `wakeupPending` ベースに書き換え

**ファイル**: `skills/cmux-team/manager/daemon.ts:170-183`

**変更内容**:

```ts
export function sleepUntilWakeup(state: DaemonState): Promise<void> {
  return new Promise((resolve) => {
    if (state.wakeupPending) {
      // tick 中に立ったフラグをここで消化する。
      // state.wakeup は本来 null だが、将来の変更で壊れないよう防衛的にクリアする。
      state.wakeupPending = false;
      state.wakeup = null;
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      state.wakeup = null;
      state.wakeupPending = false;
      resolve();
    }, state.pollInterval);
    state.wakeup = () => {
      clearTimeout(timer);
      state.wakeup = null;
      state.wakeupPending = false;
      resolve();
    };
  });
}
```

**なぜ**: tick 中に立ったフラグを sleep 突入の瞬間に消化する。これがないと「tick 中に来た wakeup は取りこぼす」という現行バグが残る。

**重要**: `wakeup` コールバック内でも `wakeupPending = false` をクリアする。これがないと、sleep 中に要求が来た場合に次の sleep まで pending のままになり、無限にループする可能性がある（sleep 直後に wakeup → 即起床 → pending 残存 → 次の sleep も即起床…）。また `wakeupPending === true` の早期 return 分岐でも `state.wakeup = null` を明示的に代入して不変条件（「sleep 関数が完了した時点で state.wakeup は常に null」）を守る。

**検証**: Step 4 の単体テスト。

---

### Step 4 — `daemon.test.ts` に wakeup 単体テストを追加（TDD）

**ファイル**: `skills/cmux-team/manager/daemon.test.ts`

**テストケース** (bun:test):

1. **tick 中に requestWakeup → 次の sleep は即 resolve**
   - `state.wakeupPending = false` から開始、`state.wakeup = null`（tick 中を再現）
   - `requestWakeup(state)` を呼ぶ → `state.wakeupPending === true`
   - `sleepUntilWakeup(state)` を await → `pollInterval` より短時間 (e.g. < 50ms) で resolve する
   - resolve 後 `state.wakeupPending === false`, `state.wakeup === null`

2. **sleep 中に requestWakeup → 即 resolve**
   - `sleepUntilWakeup` を呼び出しつつ await せず保持
   - マイクロタスク 1 回で `state.wakeup !== null` を確認
   - `requestWakeup(state)` → await 先が即 resolve
   - `state.wakeupPending === false`, `state.wakeup === null`

3. **setTimeout 満了で resolve**
   - `pollInterval = 50` に設定
   - `sleepUntilWakeup` を await → 50ms + 若干で resolve
   - `state.wakeup === null`, `state.wakeupPending === false`

4. **sleep 中の連続 requestWakeup で timer がリークしない**
   - `sleepUntilWakeup` を呼ぶ → `requestWakeup` を 2 連続
   - 1 回目で resolve 済み。2 回目は `state.wakeup` が null のため noop（ただし `wakeupPending` は立つ）
   - 次の `sleepUntilWakeup` も即 resolve

5. **tick ループ相当: requestWakeup を複数回割り込ませても全て消化される**
   - 疑似 tick ループを回す擬似コード:
     ```ts
     for (let i = 0; i < 5; i++) {
       // tick に相当する同期処理（state.wakeup は null のまま）
       requestWakeup(state);  // tick 中の割り込みをエミュレート
       await sleepUntilWakeup(state);  // pollInterval より十分短く resolve する
     }
     ```
   - 全ループが pollInterval に達せず resolve すること（タイムアウト保険として `pollInterval = 1000ms` にしておき、5 ループ合計が 100ms 未満なら合格）
   - 最終的に `state.wakeupPending === false`, `state.wakeup === null`

**なぜ**: Step 1-3 の実装が「tick 中取りこぼし」を本当に解消しているかを保証するリグレッションテスト。特にケース 5 は実運用での「tick 中に複数の create-task が来るパターン」を検証する。

**検証**: `bun test daemon.test.ts` で上記 5 ケースが通る。

---

### Step 5 — `state.wakeup?.()` の呼び出し箇所を `requestWakeup(state)` に置換

**ファイル**: `skills/cmux-team/manager/daemon.ts`

**変更内容**:

1. `initFileWatcher` 内 (`daemon.ts:158`) → `requestWakeup(state)`
2. `handleMessage` の `TASK_CREATED` case (`daemon.ts:395`) → `requestWakeup(state)`

**なぜ**: 統一 API に寄せる。`handleMessage` の TASK_CREATED 以外（CONDUCTOR_DONE, SESSION_ENDED 等）は **明示的に `requestWakeup` を呼ばない**ことに注意 — これらは `handleMessage` 内で既に state を直接更新しており、次の tick を待つ必要がない（既に更新済み）。ただし UI 即時反映のため CONDUCTOR_DONE 等でも呼ぶと安心。→ **最小変更方針**で今回は既存 `state.wakeup?.()` 呼び出し箇所のみ置換に留める。

**検証**:

```bash
grep -n "state\.wakeup" skills/cmux-team/manager/daemon.ts
```

期待結果: `sleepUntilWakeup` 内の定義・代入（`state.wakeup = null` / `state.wakeup = (...) => ...`）と `requestWakeup` 内の `state.wakeup?.()` のみが残り、それ以外の `state.wakeup?.()` 呼び出しは 0 件。

併せて `daemon.test.ts` を実行して既存テストがすべて通ること。

---

### Step 6 — fs.watch を再帰化し `.team/task-state.json` も監視（AbortController 付き）

**ファイル**: `skills/cmux-team/manager/daemon.ts:146-168`

**変更内容**: `initFileWatcher` を以下に差し替え。関数シグネチャは `void` のまま（戻り値ではなく `state.fileWatcherAbort` 経由で停止する）:

```ts
export function initFileWatcher(state: DaemonState): void {
  const ac = new AbortController();
  state.fileWatcherAbort = ac;

  const targets: { dir: string; recursive: boolean }[] = [
    { dir: join(state.projectRoot, ".team/tasks"), recursive: true },
    { dir: join(state.projectRoot, ".team"), recursive: false },  // task-state.json 用
  ];

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (debounceTimer) return;
    // 50ms debounce: saveTaskState の writeFile→rename 間隔は通常 5-10ms なので
    // .tmp と task-state.json のイベントは十分同一バッチに収まる。
    // 片方しかイベントが届かない環境でも schedule が 1 回走れば十分。
    // 受け入れ条件 200ms 以内の内訳: debounce 50ms + tick 数十-100ms + refresh 100ms。
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (state.running) requestWakeup(state);
    }, 50);
  };

  for (const { dir, recursive } of targets) {
    if (!existsSync(dir)) continue;
    // watcher を try の外側（IIFE 直下）で宣言して finally からアクセス可能にする。
    // AbortSignal を渡して、ac.abort() 呼び出しで for-await ループを決定論的に抜けさせる。
    (async () => {
      const watcher = watch(dir, { recursive, signal: ac.signal });
      try {
        for await (const event of watcher) {
          if (!state.running) break;
          // .team 直下の watcher は task-state.json のみをトリガに絞る
          if (!recursive) {
            const name = event.filename ?? "";
            if (name !== "task-state.json" && name !== "task-state.json.tmp") continue;
          }
          schedule();
        }
      } catch (e: any) {
        // AbortController で停止した場合は AbortError が throw される。正常終了として扱う。
        if (e?.name === "AbortError") return;
        log("file_watch_failed", `dir=${dir} ${e.message}`).catch(() => {});
      } finally {
        try { (watcher as any).close?.(); } catch {}
      }
    })();
  }
}
```

**main.ts shutdown パスの変更**: `main.ts:255-260` の `shutdown()` 内、`state.running = false` の直後に以下を追加:

```ts
state.fileWatcherAbort?.abort();
state.fileWatcherAbort = null;
```

同様に `main.ts:272, 350` の `state.running = false` 付近にも同じ abort 呼び出しを追加する。`onReload` での再起動パスでも watcher が確実に止まるようにする。

**なぜ**:

- **再帰監視** (`.team/tasks/` recursive): `NNN-slug/task.md` の作成を直接拾える。create-task の HTTP 通知が失敗した場合のフェイルセーフ。
- **`.team/` 非再帰監視 + filename フィルタ**: `task-state.json` の書き換え（特に delete-task / update-task）を拾う。`.team/tasks/` と別 watcher にするのは、再帰監視すると `.team/output/` `.team/logs/` 等の高頻度な変更を全部拾ってしまうため。`.team` 直下の不要なファイルイベントは filename フィルタで捨てる。`.tmp` も許容するのは `saveTaskState` のアトミック rename 途中で拾うため。
- **50ms debounce**: 受け入れ条件 200ms 以内の内訳（debounce 50ms + tick 数十〜100ms + refresh 100ms）を常に満たすため。`saveTaskState` の rename は複数イベントを発火するが、5-10ms 間隔なので 50ms で十分まとまる。
- **`requestWakeup(state)`**: Step 2 で追加した統一 API を使う。これにより tick 中の watcher 発火も取りこぼさない。
- **AbortController**: `state.running = false` だけでは for-await が次イベント待ちでブロックされる。`ac.abort()` により `watch()` の async iterator から AbortError が throw され、決定論的に終了できる。単体テストで watcher が終わらず bun test がハングする問題を根本的に回避する。
- **`file_watch_failed` ログイベント名**: CLAUDE.md のロギングポリシー表の `*_failed` パターンに揃える。
- **`AbortError` の分岐**: 正常終了として扱い `log()` を呼ばない。余計なエラーログを出さない。
- **`finally` で `close()`**: T113 で入った watcher クローズパターンを維持。try/catch で close 自体の失敗を握りつぶすのは冪等な後処理のため（CLAUDE.md のロギングポリシーで許容）。

**検証**:

- 手動: daemon を起動して `touch .team/tasks/999-test/task.md` / `echo '{}' > .team/task-state.json` → 次 tick が <200ms で発火することを `manager.log` の状態変化ログで確認。
- 単体テスト: 次の Step 7 で追加。

---

### Step 7 — `daemon.test.ts` に fs.watch 統合テストを追加

**ファイル**: `skills/cmux-team/manager/daemon.test.ts`

**テストケース**:

1. **サブディレクトリ `task.md` 作成で wakeup 発火**
   - `initFileWatcher(state)` を呼ぶ
   - 100ms 待つ（watcher 起動）
   - `.team/tasks/999-foo/task.md` を作成
   - 300ms 以内に `state.wakeupPending === true` または sleep 中の Promise が resolve することを確認

2. **`task-state.json` 更新で wakeup 発火**
   - `initFileWatcher(state)` を呼ぶ
   - `saveTaskState(testDir, {...})` を呼ぶ
   - 300ms 以内に wakeup が発火することを確認

3. **`.team/output/` の変更では wakeup 発火しない**
   - `initFileWatcher(state)` を呼ぶ
   - `.team/output/foo.txt` を作成
   - **1000ms 待っても** `state.wakeupPending === false` のまま（flaky 防止のため 500ms → 1000ms に延長）

**テストハンドリング**:

```ts
afterEach(() => {
  state.fileWatcherAbort?.abort();
  state.fileWatcherAbort = null;
  state.running = false;
});
```

`state.fileWatcherAbort?.abort()` を `afterEach` で呼ぶことで watcher を決定論的に停止させる。これを入れないと次テストまで watcher が生き残り、bun test がハングしたり他テストに干渉する可能性がある。

**なぜ**: 再帰監視 + filename フィルタが期待通り動いているかの回帰テスト。ケース 3 の 1000ms 待機は、debounce (50ms) + macOS 上の fs.watch レイテンシのゆらぎを考慮した余裕。

**検証**: `bun test daemon.test.ts` が通る。`afterEach` が走れば bun test プロセスは即座に exit すること。

---

### Step 8 — `main.ts` の create-task / update-task ログを確認

**ファイル**: `skills/cmux-team/manager/main.ts`

**確認のみ**:

- `postMessage()` 失敗時は silent に無視している (`main.ts:670-672`)。これは HTTP 通知がフェイルセーフとして fs.watch に引き継がれる設計なので **変更不要**。
- `cmdCreateTask` の TASK_CREATED 送信 (`main.ts:1119-1127`) は既に存在。変更不要。

**なぜ**: 既存の通知経路は正しい。壊さないことを確認する。

**変更なし**（ただし Step 6 の shutdown パス変更は `main.ts` に及ぶ）。

---

### Step 9 — 手動 E2E 検証

**前提**: cmux + Claude Max が使える環境で実施。Planner タスク完了後、Implementer / Inspector が実施。

**手順**:

1. **wakeup 即時性**
   - `cmux-team start` で daemon を起動
   - 別セッションから `cmux-team create-task --status ready --title "test1" --body "x"` を実行
   - `.team/logs/manager.log` に `task_received task_id=...` が追記されるまでの体感時間を測る → **1 秒以内**

2. **tick 中の取りこぼし回避（tick 継続実行の観測）**
   - tick を人工的に遅延させるため `CMUX_TEAM_POLL_INTERVAL=30000` で daemon を起動
   - tick に入る瞬間を狙って連続 3 回 `create-task` を実行（シェルループで `for i in 1 2 3; do cmux-team create-task ...; done`）
   - 3 タスクすべてが tick 終了後 **1 秒以内**に scanTasks で拾われ assign まで進むことを確認
   - 観測条件: `manager.log` に `task_received` が 3 行 → `conductor_started` または `throttled` の状態変化ログが 1 秒以内に 3 行出現すること
   - 注: daemon.ts には汎用の `tick_start` ログは存在しない。観測はタスク受信・状態遷移ログを代替指標とする

3. **HTTP 通知失敗時の fs.watch フェイルセーフ**
   - daemon 起動後、`.team/proxy-port` を一時的に削除（または書き換え）して postMessage を失敗させる
   - `cmux-team create-task ...` を実行 → HTTP は silent fail
   - fs.watch 経路で `task.md` 作成を検知 → 300ms 以内に次 tick が走ることを `manager.log` の状態変化（`updateTeamJson` 前後のログ等）で確認
   - 終了後 `.team/proxy-port` を元に戻す

4. **delete-task の即時反応**
   - 既存 ready タスクを `cmux-team delete-task --task-id NNN` で削除
   - `.team/task-state.json` の更新を fs.watch が拾い、<300ms で tick が走って UI の open task 数が減ることを確認

5. **10 秒ポーリングのフェイルセーフ維持**
   - `CMUX_TEAM_POLL_INTERVAL` を 3000 に設定、fs.watcher を一時的に無効化（コード側のデバッグフラグで）して daemon 起動
   - 何もイベントを起こさずに 3.5 秒以内に tick が 1 回回ることを `manager.log` の更新で確認
   - 終了後に元に戻す

**なぜ**: 単体テストではカバーできない「HTTP + fs.watch の同居」「実際のシェル経由の CLI 呼び出し」「UI 更新までの体感レイテンシ」を検証する。

---

## テスト/検証方針

### 単体テスト (TDD)

- Step 4: wakeup ロジック 5 ケース（tick ループ相当の割り込みテスト含む）
- Step 7: fs.watch 3 ケース（afterEach で AbortController を停止）
- 先に失敗するテストを書いてから実装を入れる TDD で進める

### 回帰確認

- `bun test` を manager/ 全体で実行し既存テストが通ること
- 既存の `watcher.close()` パターンを崩していないこと（Step 6 の finally / close をレビュー）
- `handleMessage` の他の case (CONDUCTOR_DONE など) の挙動に変更がないこと
- shutdown パス（SIGINT/SIGTERM/onQuit/onReload）で watcher が確実に停止すること

### 手動 E2E (Step 9)

Implementer/Inspector が実施。計画書にはチェックリストとして含めるが Planner は実施しない。

---

## リスクと対処

| リスク | 検出方法 | 対処 |
|---|---|---|
| Bun の `{ recursive: true }` が将来の版で挙動変更 | 単体テストが fail | filename ベースのフィルタが入っているので、別バージョンで動作差異が出ても 50ms debounce の挙動で吸収できる。最悪フォールバックとして `.team/tasks/` 直下のみ監視 + サブディレクトリを個別 watch する実装に戻す |
| `.team/output/` の高頻度書き込みが `.team` 非再帰 watcher に届いて誤発火 | 手動テストで `manager.log` の tick 頻度が異常に高い | recursive: false なので `.team/output/` は届かないはずだが、念のため `schedule()` 内の filename チェックを厳格化 |
| `wakeupPending` のクリア漏れで無限ループ | `bun test` のタイムアウト or 手動テストで CPU 100% | Step 4 のテストケース 2, 4, 5 で明示的に検証。実装時 `wakeup` コールバック内の `wakeupPending = false` と、早期 return 分岐での `state.wakeup = null` を必ず入れる |
| watcher が AbortController で停止せずテストがハング | `bun test` のタイムアウト | Step 6 の AbortController 実装 + Step 7 の afterEach で確実に停止させる。`AbortError` は catch 側で正常終了扱い |
| `AbortError` を catch し忘れて `file_watch_failed` ログが汚染される | `manager.log` に AbortError が記録される | Step 6 の `if (e?.name === "AbortError") return;` で防ぐ |
| `wakeupPending = true` の状態で daemon が stop → 次回 start で誤動作 | `createDaemon` で `false` 初期化しているので問題なし | Step 1 で確認済 |

### ロールバック戦略

- Step 1-5 (wakeup 統合) と Step 6 (fs.watch 拡張 + AbortController) は独立したコミットにする
- 問題発生時は Step 6 のみ revert して Step 1-5 は残す（wakeup 修正は副作用がほぼない安全な変更のため）
- Step 6 revert 時は `main.ts` の `state.fileWatcherAbort?.abort()` 追加も同じコミットに含めて一緒に revert する

---

## スコープ外（今回やらない）

- CLI の JSON-RPC / gRPC 化などの大規模 IPC 刷新（タスク指示の明示的な除外）
- 既存の HTTP POST 経路の置き換え（タスク指示の明示的な除外）
- `handleMessage` の TASK_CREATED 以外の case に `requestWakeup` を追加すること（既存の `state.wakeup?.()` 呼び出し箇所のみを置換。新規の wakeup トリガー追加は最小変更方針のため見送り）
- `.team/tasks/` のフラット構造タスクへの対応（現行の create-task はフォルダ構造のみ生成するため不要）
- `scheduleRefresh` の debounce 時間短縮（100ms は体感上十分、CLAUDE.md の「今あるものを直す」原則に従い触らない）
- Linux / Windows での fs.watch 再帰サポート確認（現時点のサポート環境は macOS のみ、`05-install-and-infrastructure.md` 参照）
- Bun の recursive 未対応環境（古い Bun 等）向けのサブディレクトリ個別監視フォールバック（Bun 1.3+ を前提とする）
- 汎用 `tick_start` ログの追加（既存の状態変化ログで観測可能なため不要）

## 変更ファイル一覧（Implementer 向け早見表）

| ファイル | 変更概要 |
|---|---|
| `skills/cmux-team/manager/daemon.ts` | `DaemonState.wakeupPending: boolean` 追加 / `DaemonState.fileWatcherAbort: AbortController \| null` 追加 / `requestWakeup` 関数追加 / `sleepUntilWakeup` を wakeupPending ベースに書き換え（早期 return 分岐での `state.wakeup = null` 含む）/ `state.wakeup?.()` の呼び出しを 2 箇所置換 / `initFileWatcher` を再帰監視 + `.team/task-state.json` 監視 + 50ms debounce + AbortController 連携 + `file_watch_failed` ログ + AbortError 分岐に拡張 |
| `skills/cmux-team/manager/main.ts` | `shutdown()` と `state.running = false` を設定する他の箇所（`main.ts:255, 272, 350` 近辺）で `state.fileWatcherAbort?.abort()` を呼ぶように変更。`initFileWatcher(state)` 呼び出し自体は変更不要（戻り値を使わず `state.fileWatcherAbort` を内部で設定する） |
| `skills/cmux-team/manager/daemon.test.ts` | wakeup 5 ケース（tick ループ相当の割り込みテスト含む）+ fs.watch 3 ケース（`.team/output/` 非発火の待機時間 1000ms）の単体テスト追加。`afterEach` で `state.fileWatcherAbort?.abort()` を呼び決定論的にクリーンアップ |
| (変更なし) `proxy.ts`, `task.ts` | 既存の通知送信コードと saveTaskState はそのまま |

## コーディング規約（CLAUDE.md 準拠）の再確認

- 新規 `log()` 呼び出しは `file_watch_failed` のような `*_failed` パターン、または状態変化イベント名で記録する（ロギングポリシー表準拠）
- 空 `catch {}` は冪等な後処理 (`watcher.close()`) のみで許容、他は `log(...)` を入れる
- AbortError は例外扱いせず正常終了パスで return する（catch 側に `if (e?.name === "AbortError") return;` を入れる）
- コメントは日本語、識別子は英語
- 後方互換コードは入れない — 既存の `state.wakeup?.()` 呼び出しは全置換（feedback_no_backward_compat.md に従う）
