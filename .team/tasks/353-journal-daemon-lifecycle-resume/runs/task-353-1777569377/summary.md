# T353 完了サマリー: Journal に daemon lifecycle / resume イベントを追加

## 完了したサブタスク

1. Phase 1 (Plan): Planner Agent が plan.md を作成 — `boot_completed` 既存イベントを発見・採用する設計に到達
2. Phase 2 (Design Review): Reviewer Agent が plan を 2 往復レビュー → Approved
3. Phase 3 (Impl): Implementer Agent が TDD で実装 — emit 拡張 + parser 4 ブランチ追加 + filter 緩和 + テスト 27 cases
4. Phase 4 (Inspection): Inspector Agent が GO 判定（Critical/Major なし）

## 変更ファイル

- `skills/cmux-team/manager/daemon.ts` — `DaemonState.startedAt: string` 追加 + 初期化
- `skills/cmux-team/manager/main.ts`
  - `isTerminalStatus` を import
  - `cmdStart` で `state.startedAt = new Date().toISOString()` を `daemon_started` 前に代入
  - `boot_completed` emit に `version=X restored_conductors=N open_tasks=M` を追加（`loadTasks` 再 load + `isTerminalStatus` filter で確定値取得）
  - `daemon_stopped` emit に `uptime_sec=N` を追加
  - `formatUptimeFromStartedAt(iso, now=Date.now())` を export ヘルパとして追加（`Math.max(0, ...)` で巻き戻り対策）
- `skills/cmux-team/manager/dashboard.tsx`
  - `parseJournalEntries` / `buildJournalRows` / `JournalEntry` を export 化
  - `JournalEntry.dim?: boolean` 追加
  - `DAEMON_SENTINEL_TASK_ID = "__daemon__"` 定数追加
  - `formatUptimeSec` ヘルパ追加（既存 `formatUptime` とは入力単位・命名で区別）
  - parser に 4 ブランチ追加: `boot_completed` ▲ CYAN / `daemon_stopped` ▼ CYAN+dim / `conductor_resume_launch_failed` ✕ RED / `resume_worktree_missing_late` ✕ RED
  - `daemon_reload` は意図的に Journal 非表示（log タブのみ）
  - `buildJournalRows` の filter を `isValidTaskId(e.taskId) || e.taskId === DAEMON_SENTINEL_TASK_ID` に緩和、sentinel 描画分岐追加

### 新規

- `skills/cmux-team/manager/dashboard-journal.test.tsx` — 23 tests / 60 expects
- `skills/cmux-team/manager/daemon-uptime.test.ts` — 4 tests / 4 expects

## テスト結果

| ファイル | 結果 |
|---|---|
| dashboard-journal.test.tsx (新規) | 23 pass / 0 fail / 60 expects |
| daemon-uptime.test.ts (新規) | 4 pass / 0 fail / 4 expects |
| dashboard-conductor.test.tsx (regression) | 15 pass / 0 fail / 35 expects |
| `bunx tsc --noEmit` | 0 errors |

## 設計上の重要な判断

1. **`daemon_started` には触らず、既存の `boot_completed` (main.ts:1133) の detail を拡張**してそれを Journal の ▲ ソースイベントにした。新規 `daemon_ready` イベント追加案は破棄。理由: E2E (`waitForLog("daemon_started")`) を非破壊で維持できる + 既存イベント名を流用することで命名衝突がない
2. **`state.openTasks` を使わず `loadTasks` 再 load**: `state.openTasks` は `scanTasks` 未実行時点で 0 のため、`boot_completed` emit 地点では確実に 0 になる。`loadTasks(PROJECT_ROOT)` を再 load して `isTerminalStatus` filter で確定値を取得
3. **`daemon_reload` を Journal 非表示**: 完了条件「正常時 3 行以内」を満たすため。reload 時は ▼(親 stop) + ▲(子 boot_completed) の 2 行で吸収可能
4. **`master_restored` を集約サマリーから除外**: task.md L33 と L40 が内部矛盾していたため L40 のサンプル文面（"resumed N conductors"）を採用。将来 `restored_masters=K` 追加で拡張可能
5. **A 経路（keep-alive）を `restored_conductors` カウントから除外**: `applyRestorePlan` 実装上 A 経路は `assignments.push` されないため、自然に B 経路 + topup-resume のみがカウントされる

## マージ先

main ブランチへローカル ff-only マージ予定（`base_branch:` 未指定）。

## 残課題

なし。完了条件はすべて満たしている。

`formatUptimeSec` と既存 `formatUptime` の命名衝突は JSDoc 明示で対応済み。後続で命名統一を検討してもよいが本タスクのスコープ外。
