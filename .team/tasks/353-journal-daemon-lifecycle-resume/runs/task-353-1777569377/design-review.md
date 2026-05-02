# T353 Design Review (revision 2)

## Verdict
**Approved**

## Summary

前回 Critical / Major / Minor 全指摘が解消されている。`boot_completed` の detail 拡張による既存イベント流用、`loadTasks` 再 load による open task 確定値取得、`JournalEntry.dim?: boolean` 一本化、`daemon_reload` の Journal 非表示降格による「正常時 3 行以内」確実満足、`resumeAssignments.length` のセマンティクス確定（B 経路 + topup-resume）、emit 側 `formatUptimeFromStartedAt` ヘルパ抽出での unit test 戦略 — いずれも実コードベースと整合し、設計上の決断と根拠が plan に明示されている。実装に進めて良い。

## Resolution status (前回指摘への対応)

- **C1 (`boot_completed` 既存イベントの重複検討)**: **解消**。§0.4 で案 D（`boot_completed` の detail 拡張）を採用、案 A/B/C との比較も含めて選定理由を明示。`daemon_ready` 新設は破棄。E2E `waitForLog("daemon_started", 30_000)` は `daemon_started` を残すため非破壊。`grep boot_completed` の結果も `e2e.ts` に参照なし → detail 変更による E2E 影響もなし
- **C2 (`state.openTasks` 取得方法)**: **解消**。§3.3 から `state.openTasks` 案を削除。`loadTasks(PROJECT_ROOT)` 再 load + `tasks.filter(t => !isTerminalStatus(t.status)).length` に固定。理由（`scanTasks` 未実行で必ず 0）をコメント明記。実コード `task.ts:394` の `loadTasks` シグネチャ `Promise<{tasks: TaskMeta[]; taskState: TaskStateMap}>` と plan §3.3 の `const { tasks: tasksAtBoot } = await loadTasks(PROJECT_ROOT);` は整合
- **M1 (`dim` 表示の実装方針)**: **解消**。§5 / §5.1 で `JournalEntry.dim?: boolean` 一本化、icon 文字列マッチ案は撤去。parser で `daemon_stopped` ブランチに `dim: true` を立て、`buildJournalRows` で `entry.dim ? { dim: true } : {}` を style にマージ
- **M2 (「正常時 3 行以内」)**: **解消**。§6.2 で 3 案比較の上、(a) `daemon_reload` を Journal 非表示降格を採用。reload 1 回 = ▼(親 stop) + ▲(子 boot_completed) = 2 行で吸収、起動・停止・再起動 = ▲ + ▼ + ▲ = 3 行で task spec 満足。§4.2 から `daemon_reload` ブランチ削除、§10 リスク表に「reload 行数」エントリ追記
- **M3 (`master_restored` 集約除外)**: **解消**。§3.3 / §10 / Revision History で「task.md L33 の `restoredMasters` 要求は L40 サンプル文面と内部矛盾しており、L40 を採用」と明示。Master 復元数は log タブの `master_restored` で代替可能、将来 `restored_masters=K` 追加で拡張可能と記載
- **M4 (A 経路 keep-alive)**: **解消**。§1.8 で `applyRestorePlan` (`daemon.ts:1093-1236`) の戻り値詳細を実コードベースで分析。A 経路 (`plan.alive`) は `state.conductors.set` のみで `assignments.push` しない（`daemon.ts:1099-1131`）、B 経路は `launchConductor` 成功時のみ push（`daemon.ts:1182-1189`）、topup-resume も push（`daemon.ts:1414`）。`restoredConductors = resumeAssignments.length` は「実際に再 spawn された数」で意味的に正しいと確定
- **M5 (emit 側 unit test)**: **解消**。§7.5 (a) で `formatUptimeFromStartedAt(startedAtIso, now=Date.now())` を export ヘルパとして抽出 + unit test を main 推奨、(b) 手動検証手順も併記。boundary case（巻き戻り = 0、起動直後 = 0、通常）をカバー
- **Mi1 (nerd font codepoint)**: **解消**。§4.4 で確定値表に書き換え。▲ = `` (nf-fa-arrow_up) / ▼ = `` (nf-fa-arrow_down) / ✕ は既存（task_aborted 系）、`daemon_reload` 用 ↻ は M2 (a) 採用で不要
- **Mi2 (boundary case)**: **解消**。§7.2 に追加 — `task_id` 欠落 / 空 reason / `uptime_sec=0` / `restored_conductors=0` で `fresh start` / `daemon_stopped` detail 欠落 / 単数複数表記揺れ / `boot_completed` 拡張前 (空 detail) regression / `daemon_started` と `daemon_reload` が Journal entry を生成しないこと
- **Mi3 (`JournalEntry` 型 export)**: **解消**。§5.1 / §7.1 / §9 で `parseJournalEntries` / `buildJournalRows` / `JournalEntry` interface / `DAEMON_SENTINEL_TASK_ID` / `formatUptimeSec` 全 export 化を明示

## New concerns (今回新たに発見した問題)

なし。残るのは plan 採否の問題ではなく、実装時に細かく決めれば良い軽微なスタイル差異のみ:

- **Minor (informational)**: 新ヘルパ `formatUptimeSec` と既存 `formatUptime` (`dashboard.tsx:256`) の命名が紛らわしい。既存は `startMs: number → "Xm Ys"`（空白なし）、新規は `sec: number → "Xm Ys"`（空白あり）。実装時に既存スタイルに揃える / コメント追記 / 一本化（既存を `formatUptimeFromStart`、新規を `formatUptime` に統一）等の選択肢があるが、**plan 修正必須事項ではない**。実装者の判断で良い

## Recommendations

実装着手可。

## Verification done

- `grep -n "loadTasks" skills/cmux-team/manager/task.ts` → `task.ts:394` で `export async function loadTasks(projectRoot: string): Promise<{tasks: TaskMeta[]; taskState: TaskStateMap}>` を確認。plan §3.3 の `const { tasks: tasksAtBoot } = await loadTasks(PROJECT_ROOT);` のシグネチャ整合
- `grep -n "isTerminalStatus" skills/cmux-team/manager/{task,daemon,main}.ts` → `task.ts:782` で定義、`daemon.ts:22` で import 済み（`main.ts` には未 import なので plan §3.3 / §9 の「`main.ts` の import に追加」要件は妥当）
- `grep -n "boot_completed" skills/cmux-team/manager/{main,daemon,e2e}.ts skills/cmux-team/manager/dashboard.tsx` → `main.ts:1133` 単一 emit のみ、E2E / dashboard 参照なし。`boot_completed` の detail 拡張は E2E `waitForLog` に影響しない
- `sed -n '1125,1140p' skills/cmux-team/manager/main.ts` → emit 順序確認: `state.bootPhase = "ready"` → `await updateTeamJson(state)` → `await log("boot_completed")` → `scheduleRefresh()`。`resumeAssignments` (`main.ts:1080`) の戻り値が in-scope で `boot_completed` 行から参照可能
- `sed -n '1093,1131p' skills/cmux-team/manager/daemon.ts` → A 経路 (`plan.alive`) は `state.conductors.set` のみ実行、`assignments` への push なし。plan §1.8 / M4 の分析と一致
- `sed -n '1140,1210p' skills/cmux-team/manager/daemon.ts` → B 経路は `launchConductor` 成功時のみ `assignments.push(...)`、失敗時は `conductor_resume_launch_failed` を emit。emit detail = `task_id=${item.taskId} ${formatSurface(surface, "C")} ${e?.message ?? e}` で plan §1.6 / §4.2 の reason 抽出 regex (`^task_id=\S+\s+\S+\s*`) と整合
- `sed -n '1395,1420p' skills/cmux-team/manager/daemon.ts` → `initializeLayout` 末尾 deficit 補充で `assignments.push(...addl)`。topup-resume も `resumeAssignments.length` に含まれる
- `sed -n '335,381p' skills/cmux-team/manager/dashboard.tsx` → `parseJournalEntries` は `if/else if` チェーンで末尾 `else` 無し、未該当 event は何も push せず自然 skip。plan §7.2 の「`daemon_started` / `daemon_reload` は Journal entry を生成しない」テストは parser 構造に整合
- `sed -n '975,995p' skills/cmux-team/manager/dashboard.tsx` → 現状 `buildJournalRows` は `entries.filter((e) => isValidTaskId(e.taskId)).map(...)`。plan §5 の filter 緩和 + sentinel 描画分岐は妥当
- `sed -n '244,253p' skills/cmux-team/manager/dashboard.tsx` → 現状 `JournalEntry` interface に `dim` フィールドなし。plan §5.1 の追加が必要
- `sed -n '660,675p' skills/cmux-team/manager/main.ts` → `daemon_started` emit detail は `${state.version} pid=${process.pid} poll=${state.pollInterval}ms max_conductors=${state.maxConductors} layout=${state.layout} sleep_prevention=${sleepPrevention}`。plan §7.2 fixture `"daemon_started v3.45.0 pid=12345 poll=2000ms max_conductors=2 layout=16x9 sleep_prevention=true"` と整合
- `sed -n '815,835p' skills/cmux-team/manager/main.ts` → `daemon_stopped` 現状は detail 空文字。plan §3.4 の `uptime_sec=N` 追加は新規拡張で互換性破壊なし
- `grep -n "boot_completed\|waitForLog" skills/cmux-team/manager/e2e.ts` → `e2e.ts:269` `waitForLog("daemon_started", 30_000)` のみ。`boot_completed` 未参照を再確認
