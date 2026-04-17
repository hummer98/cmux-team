# タスク割り当て

## タスク内容

---
id: 184
title: Manager: state 変更の TUI 即時反映（EventBus + 追跡性担保）
priority: medium
created_at: 2026-04-14T01:41:03.051Z
---

## タスク
# 背景

現状、`state.conductors` や `state.tasks` の変更は daemon の `tick()` 完了後にしか TUI に反映されない。`assignTask()` のように **tick の途中で長時間かかる処理**（worktree 作成・envrc 生成・cmux send 等）では、内部で `conductor.status = "running"` にセットしても TUI は古い state を表示し続ける違和感がある。

## 該当箇所

- `skills/cmux-team/manager/daemon.ts:481` (`conductor.status = "running"` 設定後も tick 完了まで TUI に反映されない)
- `skills/cmux-team/manager/main.ts:578` (`scheduleRefresh()` は tick 完了後のみ)

# 設計方針: EventBus パターン

state 変更箇所と TUI refresh を直接結合させない。両者が `eventBus` モジュールだけを参照する一方向依存にする。

```
conductor.ts ─┐
daemon.ts ────┼─▶ eventBus ◀── dashboard.tsx
```

T183（update-task 即時反映）とも設計思想を揃える（postMessage queue と eventBus は補完関係）。

# 追跡性担保（重要）

EventEmitter の「どこから emit されるか分からない」問題を以下で必ず緩和する:

## 1. 名前付きラッパーのみ公開（生 `bus.emit` 禁止）

```ts
// eventBus.ts
const bus = new EventEmitter()  // module 外に export しない

export function notifyStateChanged(source: string) {
  bus.emit("state-changed", { source })
  if (process.env.CMUX_TEAM_TRACE_EVENTS) {
    log("event_emit", \`event=state-changed source=\${source}\`)
  }
}

export function onStateChanged(cb: () => void) { bus.on("state-changed", cb) }
```

- `rg notifyStateChanged` で全 emit 箇所が grep できる
- `source` 引数は呼び出し元（例: \"conductor.ts:assignTask:481\"）を必須で渡す

## 2. TypeScript discriminated union で型に列挙

```ts
type Event =
  | { type: \"state-changed\"; source: string }
  | { type: \"task-assigned\"; taskId: string; surface: string }
```

新イベントを足すと型が全 subscriber を強制チェック。

## 3. オプトイン emit ログ

`CMUX_TEAM_TRACE_EVENTS=1` 時のみ `manager.log` に `event_emit event=... source=...` を記録（普段は無効）。

## 4. docs/spec に Event Catalog を追加

`docs/spec/05-install-and-infrastructure.md` もしくは `docs/spec/` 配下の新規ファイルに以下のような表を追加:

| event | payload | emitter (場所) | subscriber |
|---|---|---|---|
| state-changed | {source} | conductor.ts:assignTask 複数点, daemon.ts:tick | dashboard.tsx |

## 5. 生 emit 禁止の簡易チェック

READMEまたはCLAUDE.md に \"bus.emit の直接呼び出しを eventBus.ts 外で書かない\" と明記。CI 不要、grep で定期確認できる程度でよい。

# 実装タスク（調査してほしいこと含む）

1. **eventBus.ts の新規作成**
   - `EventEmitter` を内部で持つ
   - `notifyStateChanged(source)`, `onStateChanged(cb)` を export
   - discriminated union の `Event` 型を定義
   - `CMUX_TEAM_TRACE_EVENTS` による emit ログを実装

2. **既存の state mutation 箇所を洗い出して notify を挿入**
   - `conductor.ts`: `assignTask` 内の各フェーズ（worktree 作成完了、prompt 生成完了、cmux send 完了、`status = \"running\"` 設定時）
   - `daemon.ts`: `tick` 完了時、`monitorConductors` の状態遷移時、`scanTasks` のタスク状態変更時
   - `main.ts`: `cmdUpdateTask` / `cmdCloseTask` / `cmdAbortTask` / `cmdRestartTask` / `cmdDeleteTask`（※ T183 と重複する領域あり — 統合可能なら統合）

3. **dashboard.tsx で onStateChanged → scheduleRefresh に接続**
   - 既存の `tick 後の scheduleRefresh` は残しても良い（二重で安全側）

4. **docs/spec に Event Catalog 追加**

5. **T183 との統合**
   - T183（update-task 全更新の TUI 即時反映）は同じ問題の別側面。eventBus を先に実装してから T183 を解決する順序が自然。
   - T183 担当 Conductor とコンフリクトしないよう、本タスクで eventBus を先に land させ、T183 は emit 呼び出しを足す形にする

# 受け入れ基準

- `cmux-team update-task --status ready` 実行から **1 秒以内**に TUI の Tasks 表示が更新される
- ready タスクが Conductor に割り当てられた瞬間、TUI の Conductors 表示が **worktree 作成や cmux send を待たずに** \"assigning...\" または \"running\" に遷移して見える
- `rg notifyStateChanged skills/cmux-team/manager` で全 emit 箇所が列挙できる
- `eventBus.ts` 以外の場所で `bus.emit` 直接呼び出しが無い（grep で 0 件）
- `CMUX_TEAM_TRACE_EVENTS=1` で起動すると manager.log に `event_emit` 行が出る
- `docs/spec/` に Event Catalog セクションが追加されている
- 既存テスト・e2e を破壊していない

# 参考ファイル

- `skills/cmux-team/manager/conductor.ts` (assignTask 等の state mutation)
- `skills/cmux-team/manager/daemon.ts:499-502` (tick), `481` (conductor.status mutation)
- `skills/cmux-team/manager/main.ts:571-590` (main loop, scheduleRefresh)
- `skills/cmux-team/manager/dashboard.tsx:1287-1317` (scheduleRefresh 定義)
- `skills/cmux-team/manager/queue.ts` (既存 postMessage との比較・統合可能性の検討)
- `CLAUDE.md` ロギングポリシー（event_emit ログも準拠させる）

# 備考

- T183 とは補完関係。T183 が先に着手された場合は T183 側で notify を呼び出すだけの最小実装に変更できる。
- 将来的に state observer（Proxy パターン）に移行する場合も、eventBus を先に導入しておけば移行コストが下がる。


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-184-1776131028` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-184-1776131028
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-184-1776131028/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/184-manager-state-tui-eventbus/runs/task-184-1776131028
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/184-manager-state-tui-eventbus/runs/task-184-1776131028/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら:

1. セッション上に完了レポートを表示する（conductor-role.md「完了時の処理」ステップ 8 参照。設計判断・試行錯誤・自己判断・懸念・成果の勘所を簡潔に出力）
2. 完了通知を送信する:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
   ```
