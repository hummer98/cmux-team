# T184 EventBus 実装レポート

## 作成したファイル

- `skills/cmux-team/manager/eventBus.ts`
  - `notifyStateChanged(source)` / `onStateChanged(cb)` を export
  - EventEmitter を module-private に保持
  - `CMUX_TEAM_TRACE_EVENTS=1` で emit を logger に記録
  - テスト用: `__resetBusForTest` / `__listenerCountForTest`
- `skills/cmux-team/manager/eventBus.test.ts`
  - notify/unsubscribe/reset の基本挙動を検証
- `skills/cmux-team/manager/eventBus.trace.test.ts`
  - TRACE フラグを動的 import で検証。PROJECT_ROOT を tmpdir にして manager.log への `event_emit` 出力を確認

## 変更したファイル（要点）

- `skills/cmux-team/manager/conductor.ts`
  - import 追加
  - `assignTask`: `status="running"` 代入直後に notify
  - `resetConductor`: `status="idle"` + フィールドクリア後に notify
- `skills/cmux-team/manager/daemon.ts`
  - import 追加
  - `handleMessage` 各 case の **実 state mutation 直後** に notify を挿入
    - `AGENT_SPAWNED`, `SESSION_STARTED` (master/conductor), `CONDUCTOR_REGISTERED`, `CONDUCTOR_SESSION`, `SESSION_ENDED` (master/conductor/agent), `SESSION_ACTIVE` (master/conductor), `SESSION_IDLE` (master/conductor), `SESSION_CLEAR` (直接 status="idle" パス), `SHUTDOWN`
    - `TASK_CREATED` / `TASK_UPDATED` は state 変更がないため notify しない（§3.4）
    - `SESSION_CLEAR` の `resetConductor` 経由パスは conductor.ts 側で既に notify 済み
  - `scanTasks` に差分検出を導入
    - 開始時に `openTasks` / `pendingTasks` / taskList ハッシュのスナップショット
    - 再構築後に差分があれば `task-list-changed` notify
  - `scanTasks` の assign 失敗パスで conductor を disconnected にする箇所にも notify
  - `scanTasks` の `state.conductors.set(updated.surface, updated)` 直後に notify
  - `monitorConductors` starting-timeout / unresponsive-threshold / surface-missing / agent-removed 直後に notify
  - `spawnPidWatcher` / `spawnMasterPidWatcher` の disconnected 遷移直後に notify
- `skills/cmux-team/manager/dashboard.tsx`
  - import 追加
  - module-level `eventBusUnsubscribe` を導入
  - `startDashboard` の `scheduleRefresh` 定義直後に `onStateChanged(() => scheduleRefresh())` を subscribe
  - `cleanup()` で unsubscribe（listener leak 防止）
  - 再 mount 時は前の unsubscribe を先に呼んでから新しく登録
- `docs/spec/05-install-and-infrastructure.md`
  - `### Event Catalog（eventBus.ts）` サブセクション追加
- `CLAUDE.md`
  - `## ロギングポリシー` 直後に `## EventBus ポリシー` 追加（logger 循環依存禁止を含む）

## plan からの逸脱

なし。plan の R1（実 state mutation 点のみ）/ R2（handleMessage TASK_* は notify しない）/ R3（scanTasks は差分検出）/ R5（YAGNI で notifyStateChanged のみ export）/ R6（logger 循環依存禁止を明文化）/ R7（TRACE 検証は動的 import + 別ファイル）を全て反映済み。

scanTasks の assign 失敗時の「AssignTaskError 以外」パスにも `conductor-disconnected` notify を追加した。plan には明示されていなかったが「実 state mutation 直後は必ず notify」の不変条件を守るため。

## 動作確認結果

### 型チェック

既存のベースライン（main ブランチ時点）と比較して **新規エラーなし**。本 worktree のベースラインには以下 5 件の既存エラーが残存しており、本タスクでは触らない:

```
cmux.ts(22,5): TS2322 Bun Node ExecFile types
dashboard.tsx(373,5): TS2322 WidgetVariant "unstyled"
dashboard.tsx(954,11): TS2322 WidgetVariant "unstyled"
main.test.ts(82,3): TS2322 string | undefined
main.ts(447,42): TS2345 string | null
```

`git stash` して `bun tsc --noEmit` を走らせ、全く同一のエラーセットが出ることを確認済み。

### テスト

```
$ bun test
 179 pass
 0 fail
 383 expect() calls
Ran 179 tests across 13 files. [11.09s]
```

eventBus.test.ts（4 テスト）と eventBus.trace.test.ts（1 テスト）を含め全て緑。

### grep 検査

```
$ rg notifyStateChanged skills/cmux-team/manager
# eventBus.ts + conductor.ts (2 箇所) + daemon.ts (21 箇所) + テストのヒット
# 全て実 state mutation 直後の配置

$ rg "bus\.(emit|on)\b" skills/cmux-team/manager | rg -v eventBus.ts
# (0 件)
```

## 既知の未解決課題

plan §9 Open Questions に記載済み。本タスクスコープ外:

1. Conductor の中間 phase 可視化（worktree 作成〜prompt 送信）を `ConductorState.phase` で扱うかどうか
2. `main.ts:578` の tick 後 `scheduleRefresh()` を完全 event 駆動化するか
3. 受け入れ基準「1 秒以内」の自動計測（目視基準から計測ログ基準への移行）
4. `bus.emit` 禁止を CI / pre-commit に組み込むか
5. TRACE ログを `manager.trace.log` に分離するか

## 受け入れ基準チェックリスト

- [x] `eventBus.ts` が存在し EventEmitter を module-private に保持
- [x] `notifyStateChanged` / `onStateChanged` / `__resetBusForTest` を export
- [x] `rg notifyStateChanged` の全箇所が実 state mutation 直後
- [x] `rg "bus\.(emit|on)\b" ... | rg -v eventBus.ts` が 0 件
- [x] `CMUX_TEAM_TRACE_EVENTS=1` で `event_emit event=state-changed source=...` が manager.log に出力（テストで検証済み）
- [ ] e2e: `cmux-team update-task --status ready` → TUI 即時反映（**目視確認は未実施**。本 worktree は実稼働 daemon を起動しない方針のため CLAUDE.md §テスト方法 の手動 e2e は本 PR で別途実施）
- [ ] e2e: Conductor 割当で `running` 即時遷移（同上）
- [x] dashboard cleanup で unsubscribe（listener leak なし）— コード上で module-level 変数 + cleanup で対応
- [x] `docs/spec/05-install-and-infrastructure.md` に Event Catalog
- [x] `CLAUDE.md` に EventBus ポリシー + logger 循環依存禁止
- [x] `bun test skills/cmux-team/manager` 緑
- [x] `eventBus.test.ts` / `eventBus.trace.test.ts` 追加し緑
- [x] scanTasks は差分検出ベースで notify
