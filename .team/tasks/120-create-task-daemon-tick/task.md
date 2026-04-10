---
id: 120
title: create-task 直後に daemon が即時反応するようにする（tick 待ちの体験改善）
priority: high
created_at: 2026-04-10T02:37:52.600Z
---

## 背景・課題

`cmux-team create-task` を実行してから daemon の UI 更新・Conductor へのタスク割り当てまでに、時折最大 ~10 秒かかる。体験として鈍く、実行のたびに「今ちゃんと受け取られたのか」が不安になる。

Master 運用中にユーザーから明示的に「即座に反応してほしい」とフィードバックがあった。UX 観点で根本的に解消する。

## 調査結果（事実ベース）

実装を読んで以下を確定済み。

### 通知経路は存在する（HTTP IPC）

- CLI 側: `create-task` / `update-task --status ready` などが `postMessage()` で `POST http://localhost:{proxyPort}/api/messages` を送る (`main.ts:660-673, 1119-1127, 1184-1192` ほか)
- daemon 側: proxy ハンドラ (`proxy.ts:163-175`) が `opts.onMessage(msg)` を同プロセス内で呼び、`handleMessage` (`daemon.ts:381-` ) に到達する
- `handleMessage` の `TASK_CREATED` 分岐 (`daemon.ts:383-396`) は `log("task_received", ...)` → `state.wakeup?.()` を呼ぶ

### メインループは単純な直列ループ

```ts
// main.ts:408-425
while (state.running) {
  await tick(state);            // cmux list-status 等の重い処理
  await updateTeamJson(state);
  scheduleRefresh();
  ...
  await sleepUntilWakeup(state); // ← ここでだけ state.wakeup が関数になる
}
```

### `sleepUntilWakeup` の挙動（daemon.ts:170-183）

- 呼ばれた瞬間に `state.wakeup` を resolve 関数としてセット
- `setTimeout(pollInterval)` 満了 or `wakeup()` 実行のどちらかで `state.wakeup = null` + resolve

### fs.watch の現状（daemon.ts:146-168）

- 監視対象は `.team/tasks/` **直下のみ・非再帰**
- macOS の `fs.watch` は再帰監視しないため、サブディレクトリ `NNN-slug/task.md` の作成は拾われない
- `.team/task-state.json` は `.team/` 直下にあり、現状監視対象外
- `watcher.close()` は T113 で修正済み（finally で close）

## 根本原因

`state.wakeup` が関数として有効なのは **`sleepUntilWakeup` 呼び出し中の間だけ**。tick 実行中は `null`。

- tick 実行中に `TASK_CREATED` が届く → `state.wakeup?.()` は **noop（取りこぼし）**
- tick 終了 → `sleepUntilWakeup` で新しい wakeup 関数がセットされるが、通知は既に通り過ぎている
- 次のイベントが来ない限り setTimeout の満了（最大 `poll=10000ms`）を待つ
- ユーザー体験は「sleep 中に当たれば即反応、tick 中に当たれば最大10秒遅延」という不安定さ

さらに fs.watch 側もサブディレクトリ非監視 + `task-state.json` 非監視のため、HTTP 通知取りこぼしの受け皿になれていない。

## 修正方針（UX 優先、二本立て）

### A. tick 中の通知を取りこぼさない（wakeup の信頼性向上）

`DaemonState` に `wakeupPending: boolean` を追加し、wakeup 要求を「flag + sleep 中なら即 resolve」の二本立てに統一する。

```ts
// daemon.ts
export function requestWakeup(state: DaemonState): void {
  state.wakeupPending = true;
  state.wakeup?.();          // sleep 中なら即起こす
}

export function sleepUntilWakeup(state: DaemonState): Promise<void> {
  return new Promise((resolve) => {
    if (state.wakeupPending) {   // tick 中に立ったフラグを消化
      state.wakeupPending = false;
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

- `handleMessage` の **全 case** と `initFileWatcher` から `state.wakeup?.()` を `requestWakeup(state)` に置き換える（TASK_CREATED 以外の通知イベントも同じ経路でいいように統一する）
- CLI の `create-task` / `update-task` / `close-task` / `delete-task` / `abort-task` すべての即時反応がこれで直る

### B. fs.watch を信頼できるフェイルセーフにする

現状の非再帰監視を拡張し、HTTP 通知が何らかの理由で失敗しても fs 経路で 1 秒以内に拾えるようにする。

- Bun の `fs.watch(path, { recursive: true })` が macOS で動くか検証し、動けば `.team/tasks/` を再帰監視
  - Bun ドキュメントで未対応・不安定なら、サブディレクトリの作成をトップレベル watcher で検知してその都度子 watcher を追加するパターンにフォールバック
- `.team/task-state.json` も監視対象にする（`.team/` 直下を watch、もしくはファイル watch）
- 100ms 程度の debounce で変更をまとめてから `requestWakeup(state)`
- watcher のライフサイクル（close / replace）は T113 で入った finally パターンを踏襲、リークを再発させない

### C. UI リフレッシュの動作確認

- `main.ts:408-425` の `scheduleRefresh()` は tick 後に呼ばれているので、A が効けば UI も自動で速くなるはず
- 念のため `scheduleRefresh` の debounce 時間を実測し、体感上許容できるか確認（長すぎたら詰める）

### D. 10 秒ポーリングはフェイルセーフとして維持

- `CMUX_TEAM_POLL_INTERVAL` のポーリングは撤廃しない
- 外部状態変化（Conductor crash、プロセス消失、proxy 切断等）の検出に必要

## 受け入れ条件

- `cmux-team create-task --status ready ...` 実行後、**1 秒以内**に以下が進む:
  - `manager.log` に `task_received` が記録される
  - idle Conductor があれば `conductor_started` まで進む
  - `cmux-team status` / TUI の open task 数・Conductor 状態が即時反映される
- `update-task --status ready` / `close-task` / `delete-task` / `abort-task` でも同等の即時反応
- tick 実行中に連続で複数通知が届いても取りこぼさない（回帰確認として、tick を人工的に遅延させて複数 create-task を連続実行する検証を行う）
- HTTP 通知経路をシミュレートで失敗させても、fs.watch 経由で遅延 ~200ms 以内に反応する
- `CMUX_TEAM_POLL_INTERVAL` のポーリングはフェイルセーフとして動作継続
- 既存の `watcher.close()` パターンを崩さず、FD / interval リークを再発させない

## 検証・調査項目（実装と合わせて）

- Bun `fs.watch(..., { recursive: true })` の macOS 挙動。未対応ならサブディレクトリ個別監視にフォールバック
- `task-state.json` の書き込み方式（`saveTaskState` を確認。上書きか rename atomic か）。debounce 設計とイベント種別ハンドリングに影響
- `scheduleRefresh` の debounce 時間が UX 上許容範囲か

## 参考

- 関連コード: `skills/cmux-team/manager/daemon.ts`, `main.ts`, `proxy.ts`, `task.ts`
- 既に修正済みの関連タスク: T113（watcher.close 漏れ・interval 重複修正）
- コーディング規約・ロギングポリシーは CLAUDE.md 参照

## スコープ外（今回やらない）

- CLI の JSON-RPC / gRPC 化などの大規模な IPC 刷新。既存の HTTP POST を維持した上で信頼性を上げる
