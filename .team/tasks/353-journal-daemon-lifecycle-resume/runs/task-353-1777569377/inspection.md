# T353 Inspection

## Verdict
**GO**

## Summary

Plan §3-§7 の作業項目はすべて diff に反映されており、`boot_completed` detail 拡張・`daemon_stopped` の `uptime_sec` 追加・`formatUptimeFromStartedAt` の `Math.max(0, ...)` 巻き戻り対策・`buildJournalRows` の sentinel filter 緩和・`JournalEntry.dim` 一本化が plan の決定通り実装されている。新規 27 cases / regression 15 cases / tsc 0 errors すべて pass。完了条件 (task.md L113-119) を満たす。

## Test Result
- dashboard-journal.test.tsx: **23 pass / 0 fail / 60 expects**
- daemon-uptime.test.ts: **4 pass / 0 fail / 4 expects**
- dashboard-conductor.test.tsx (regression): **15 pass / 0 fail / 35 expects**
- bunx tsc --noEmit: **0 errors**

## Plan Compliance

- **§3.1 DaemonState.startedAt**: ✅ `daemon.ts:149-153` に `startedAt: string` フィールド追加。`createDaemon` の初期化リテラル (`daemon.ts:422`) で空文字初期化
- **§3.2 daemon_started emit 維持**: ✅ `main.ts:677-680` の detail はそのまま温存。`<version> pid=N poll=Nms ...` フォーマット維持。E2E `waitForLog("daemon_started")` 非破壊
- **§3.3 boot_completed detail 拡張**: ✅ `main.ts:1145-1153` で `loadTasks(PROJECT_ROOT)` 再 load + `isTerminalStatus` filter で `open_tasks` を確定値で取得（plan のサンプルコードと完全一致）。`restoredConductors = resumeAssignments.length` も plan §1.8 / M4 の決定通り。`state.openTasks` は使っていない (C2 解消)
- **§3.4 daemon_stopped uptime_sec**: ✅ `main.ts:833-835` で `state.startedAt ? formatUptimeFromStartedAt(state.startedAt) : 0` の空ガード付きで emit。`formatUptimeFromStartedAt` は `Math.max(0, Math.floor(...))` で巻き戻り対策（`main.ts:161-165`）
- **§4.2 parser ブランチ**: ✅ `dashboard.tsx:399-457` に 4 ブランチ追加（`boot_completed` / `daemon_stopped` / `resume_worktree_missing_late` / `conductor_resume_launch_failed`）。`daemon_reload` ブランチは意図的に作成せず自然 skip (M2 解消)
- **§5 buildJournalRows**: ✅ `dashboard.tsx:1061-1080` で filter 条件 `isValidTaskId(e.taskId) || e.taskId === DAEMON_SENTINEL_TASK_ID` に緩和。sentinel taskId のときは `T###` 列を null で省略。`entry.dim` を icon style にマージ
- **§7 テスト**: ✅ `dashboard-journal.test.tsx` は plan §7.2-7.4 の全 case を網羅（boot_completed 5 / daemon_stopped 3 / resume failure 4 / regression 1 / hidden events 2 / sentinel + dim 4 / formatUptimeSec 4 = 23 cases）。`daemon-uptime.test.ts` は plan §7.5 (a) の boundary case 4 を実装

## Verification done

- `git diff skills/cmux-team/manager/{daemon.ts,main.ts,dashboard.tsx}` を読み、各箇所が plan と一致することを確認
- **emit 順序確認**: `main.ts:676` で `state.startedAt = new Date().toISOString()` が `await log("daemon_started", ...)` (L677) より前に実行されている
- **boot_completed emit 位置**: `main.ts:1143` の `state.bootPhase = "ready"` 直後 → `updateTeamJson` → `loadTasks` → `boot_completed` emit。design-review が要求した「`state.openTasks` ではなく `loadTasks` 再 load」になっていることを目視確認
- **`daemon_reload` の自然 skip**: `dashboard.tsx:399-457` の if-else チェーンに `daemon_reload` 該当ブランチがないことを確認。test fixture (`dashboard-journal.test.tsx:163-167`) でも `parseJournalEntries(["[...] daemon_reload"]).length === 0` を verify
- **icon codepoint**: `dashboard.tsx` の新規 `nerdIcon` は `` (▲) / `` (▼) / `` (✕) を生 UTF-8 で記述（plan §4.4 の指定通り）。`task_aborted` と同じ `` を resume failure に再利用するのも plan §4.4 の表通り
- **テスト fixture と emit format の整合性**: `dashboard-journal.test.tsx:30` の `"boot_completed version=v3.45.0 restored_conductors=2 open_tasks=1"` は `main.ts:1150-1153` の emit 文字列と完全一致
- **個別 test 実行**: `bun test --timeout 30000 dashboard-journal.test.tsx` / `daemon-uptime.test.ts` / `dashboard-conductor.test.tsx` を `cd skills/cmux-team/manager` で個別実行し全 pass を確認
- **tsc**: `bunx tsc --noEmit` exit 0、output なし

## Findings

### Critical (NOGO 理由)
なし

### Major
なし

### Minor

- **`daemon_stopped` の `state.startedAt` 空ガード（plan 未明記の追加）**: plan §3.4 のサンプルコードは `state.startedAt` を直接 `new Date(...)` に渡す形だったが、実装 (`main.ts:834`) では `state.startedAt ? formatUptimeFromStartedAt(state.startedAt) : 0` の三項演算子で空ガードしている。impl-summary に「`new Date("")` は `NaN` で `Math.max(0, NaN)` も `NaN` を返すため」の理由が記載されており、defensive な改善として妥当。`cmdStart` 経由の通常運用では `state.startedAt` は必ず非空なので runtime 動作に差は出ない
- **`formatUptimeSec` と既存 `formatUptime` の命名衝突**: design-review.md rev2 の minor 指摘。実装では JSDoc コメント (`dashboard.tsx:268-271`) に「既存の `formatUptime` (startMs ベース、空白なし) と紛らわしいが、こちらは sec ベース + 空白あり」と明示する形で対応済み。命名統一は後続タスクで実施可能で、本タスクの完了条件には影響しない
- **Resume failure events の icon fallback `[✕]` には `[]` 括弧があるが `▲` `▼` にはない**: plan §4.4 の表通り（`▲` / `▼` / `[✕]`）。視覚的なバランスは僅かに不均一だが意図された設計

## Fix Required (NOGO の場合)

なし
