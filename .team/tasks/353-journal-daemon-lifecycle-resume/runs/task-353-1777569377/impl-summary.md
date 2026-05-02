# T353 実装サマリー

## 変更ファイル

- `skills/cmux-team/manager/daemon.ts`
  - `DaemonState` interface に `startedAt: string` を追加（line 149-153 付近）
  - `createDaemon` の初期化リテラルに `startedAt: ""` を追加（cmdStart で daemon_started emit 前に確定値で上書きする前提）
- `skills/cmux-team/manager/main.ts`
  - `task` の import に `isTerminalStatus` を追加
  - `cmdStart` で `state.startedAt = new Date().toISOString()` を `daemon_started` emit より前に代入
  - `boot_completed` emit を空 detail から `version=<v> restored_conductors=<N> open_tasks=<M>` に拡張。値は `loadTasks(PROJECT_ROOT)` 再 load + `isTerminalStatus` filter で確定値を取得（plan §3.3 のコード抜粋通り）
  - `daemon_stopped` emit detail に `uptime_sec=<N>` を追加。`state.startedAt` が空（cmdStart 経由でない場合）は 0 にフォールバック
  - `formatUptimeFromStartedAt(startedAtIso, now=Date.now())` を export ヘルパとして追加（`Math.max(0, Math.floor((now - new Date(startedAtIso).getTime()) / 1000))`）
- `skills/cmux-team/manager/dashboard.tsx`
  - `JournalEntry` interface を `export` 化、`dim?: boolean` フィールドを追加
  - `parseJournalEntries` / `buildJournalRows` を `export` 化
  - `DAEMON_SENTINEL_TASK_ID = "__daemon__"` 定数を `export` 化して追加
  - `formatUptimeSec(sec)` ヘルパを export 化して追加（既存 `formatUptime(startMs)` とは別物。秒入力 + 空白あり: `Xs` / `Xm Ys` / `Xh` / `Xh Ym`）
  - `parseJournalEntries` の if-else チェーンに 4 ブランチを追加
    - `boot_completed` → ▲ CYAN（version + summary）
    - `daemon_stopped` → ▼ CYAN + `dim: true`
    - `resume_worktree_missing_late` → [✕] RED
    - `conductor_resume_launch_failed` → [✕] RED + reason 抽出
  - `buildJournalRows` の filter 条件を `isValidTaskId(e.taskId) || e.taskId === DAEMON_SENTINEL_TASK_ID` に緩和。sentinel taskId のときは `T###` 列を出さず、`entry.dim` を icon style にマージする実装

## 追加テスト

- `skills/cmux-team/manager/dashboard-journal.test.tsx`（新規）
  - `parseJournalEntries: boot_completed` 5 case（複数/単数/fresh start/拡張前互換）
  - `parseJournalEntries: daemon_stopped` 3 case（uptime 整形/0s/detail 欠落フォールバック）
  - `parseJournalEntries: resume failure events` 4 case（reason 抽出/unknown/task_id 欠落 skip/worktree_missing）
  - `parseJournalEntries: 既存 5 イベント regression` 1 case
  - `parseJournalEntries: 非表示イベント` 2 case（daemon_reload / daemon_started）
  - `buildJournalRows: sentinel + dim 描画` 4 case（T###スキップ/dim style/通常 T### regression/空エントリ）
  - `formatUptimeSec` 4 case（境界）
  - 計 23 tests / 60 expect calls
- `skills/cmux-team/manager/daemon-uptime.test.ts`（新規）
  - `formatUptimeFromStartedAt` 4 case（通常/巻き戻り/0s/ms 切り捨て）

## tsc 結果

`cd skills/cmux-team/manager && bunx tsc --noEmit` → 0 errors / 0 warnings

## test 結果

| ファイル | 結果 |
|---|---|
| `dashboard-journal.test.tsx`（新規） | 23 pass / 0 fail / 60 expect |
| `daemon-uptime.test.ts`（新規） | 4 pass / 0 fail / 4 expect |
| `dashboard-conductor.test.tsx`（regression） | 15 pass / 0 fail |
| `dashboard-master.test.tsx`（regression） | 6 pass / 0 fail |
| `dashboard-issues.test.tsx`（regression） | 11 pass / 0 fail |
| `dashboard-metrics.test.tsx`（regression） | 39 pass / 0 fail |
| `dashboard-pool.test.tsx`（regression） | 2 pass / 0 fail |
| `daemon.test.ts`（regression） | 187 pass / 0 fail（初回 1 error が出たが logger 関連の flaky で 2 回目は消失） |
| `main.test.ts`（regression） | 213 pass / 0 fail |

## 実装上の判断

- **icon の nerd codepoint**: plan §4.4 通り `` (▲ nf-fa-arrow_up) / `` (▼ nf-fa-arrow_down) / `` (✕ 既存 task_aborted と同じ) を使用。fallback は `▲` `▼` `[✕]`。`nerdIcon(<nerd>, <fallback>)` の既存パターンを踏襲
- **formatUptimeSec vs formatUptime の命名**: design-review minor の懸念に従い、新ヘルパは sec ベース + 空白あり (`Xm Ys` 形式) で既存 `formatUptime` (startMs ベース + 空白なし) と引数も出力も区別可能にした。命名を `formatUptimeFromSec` まで変えるかは検討したが、コメントで明示する方針で十分と判断（テストもこの仕様を固定する）
- **daemon_stopped の `state.startedAt` 空ガード**: `state.startedAt` が空文字（cmdStart 経由でないテスト等）の場合は `formatUptimeFromStartedAt` を呼ばず 0 を返す。`new Date("")` は `NaN` で `Math.max(0, NaN)` も `NaN` を返すため、明示的に空ガードする実装
- **`formatUptimeFromStartedAt` を main.ts に置いた**: plan §3.4 の「main.ts または daemon.ts」のうち main.ts を選択。export してテストから直接 import 可能にした。daemon.ts は循環の懸念を避ける意図で main.ts に集約
- **`dim` 表示の実装**: M1 の通り `JournalEntry.dim?: boolean` 一本化。`buildJournalRows` で `iconStyle` を組み立てる際に `entry.dim ? { dim: true } : {}` を `style` フィールドにマージ。icon 文字列マッチは行っていない

## 残課題

- なし。plan §の作業順序 1〜8 はすべて完了。手動検証 §7.5 (b) の daemon 起動・停止での Journal 目視確認は Conductor / ユーザー側の dogfooding で実施することを想定（本タスクの完了条件には unit test 戦略 (a) で十分）
