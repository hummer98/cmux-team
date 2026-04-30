# Design Review (round 2): T358 plan.md v2

## Verdict: Approved

## Summary

round 1 の Major 6 件はすべて本文（§1〜§7）に正しく反映されており、Minor 7 件・Nits 3 件も対応済み。spec §6 enum 整合・payload routing・経路分担・allowlist 設計の構造的な懸念は解消した。新たな大きなリスクは検出されず、実装着手可能な状態と判断する。

---

## Major 指摘の対応確認

### M1: `SpecAbortReason` 独立型 + `mapAbortReason` + wrapper 側マップ — **対応済み**

- §2.1 で `SpecAbortReason` を spec §6.6 準拠の 6 値独立 enum として定義し、`AbortReason` を借りない設計に変更されている（plan.md:21-27）
- 8 値→6 値マップ表が §2.1 末尾の表で明示されており、`abort_task → other` / `resume_no_* → resume_marked_aborted` / 他 5 値は同名 pass-through という round 1 推奨マップと完全一致（plan.md:50-62）
- `mapAbortReason(r: AbortReason): SpecAbortReason` を `events-writer.ts` で export、`task.ts:markTaskAborted` の wrapper 末尾で明示適用、reducer 側では行わない切り分けも §2.1 末尾と §3 Step (c)-1 で一貫している（plan.md:63, 186）
- §5.1 で「8 値マップを table-driven test で完全網羅」、§5.2 で「`markTaskAborted.test.ts` で 8 値パラメタライズ確認」と test 計画にも反映済み

### M2: `task-fsm.ts:CREATE` で `initialStatus="ready"` のとき log action 2 件 — **対応済み**

- §3 Step (b)-4 で「`task-fsm.ts:42-49` (CREATE reducer) を `initialStatus === "ready"` のとき `task_created` + `task_ready` の 2 件 log action を返すよう変更（推奨方針 a）」と明記、reducer 純関数性は保持（plan.md:175）
- §4 編集対象の `task-fsm.ts` 行で M2 の拡張内容を明示（plan.md:245）
- §5.2 で `createTaskProgrammatic({status:"ready"})` での両 event emit assertion を test 計画に追加（plan.md:281）

### M3: `task_completed` を auto-close 経路から外す、`task_completed_state_mismatch` のみ — **対応済み**

- §2.5 末尾「`task_completed` を auto-close 経路から外す根拠（M3）」で 4 行にわたって理由と branch 分岐の扱いを明文化（plan.md:97-101）
- §3 Step (c)-2 で「通常経路（`else` ブランチ、line 3637 付近）からのみ `task_completed` emit」「auto-close 経路は `task_completed` を emit しない」と二重に確認（plan.md:188-189）
- manager.log 側の二重 log は v1 互換のため温存、spec 制約は events.jsonl のみ適用、という round 1 ガイダンスも §2.5 末尾に取り込まれている
- §5.2 で「auto-close 経路で `task_completed` が events.jsonl に emit されないことを negative assertion で確認」と test も追加（plan.md:283）

### M4: `apply-task-actions` switch を allowlist 化、`task-fsm.ts:79` を `task_aborted_core` リネーム — **対応済み**

- §2.5「apply-task-actions の switch は allowlist 設計」サブセクションで「spec §6 対応 5 種だけ emit、それ以外は logger.log のみに残す」「switch の default は no-op（明示的 `return`）」「`task_aborted` → `task_aborted_core` にリネーム」と 3 点を明示（plan.md:108-112）
- §3 Step (b)-3 で具体的なリネーム指示、§4 編集対象の `task-fsm.ts` でも (2) として記載（plan.md:174, 245）
- §3 Step (f)-3 / §5.2 で「ASSIGN_FAIL kind=task テストを `task_aborted_core` 名に追従修正」と既存テスト破壊回避の指示も含む（plan.md:226, 282）

### M5: auto-close 経路 `applyTaskEvent` で `eventStream: { conductorSurface, worktreePath, journalSummary }` — **対応済み**

- §2.6 表 3 行目に `daemon.ts:handleConductorDone` auto-close 経路（line 3585）の eventStream payload と switch case 組立を明示（plan.md:140）
- §3 Step (b)-6 三つ目の bullet で「`{ conductorSurface: conductor.surface, worktreePath: conductor.worktreePath ?? "", journalSummary }` を渡す」と具体化（plan.md:180）
- §4 daemon.ts 行で「auto-close 経路は `applyTaskEvent({type:"CLOSE", autoClosed:true})` 呼び出しで `eventStream: { conductorSurface, worktreePath, journalSummary }` を渡し、apply-task-actions 経由で `task_completed_state_mismatch` のみ emit（M5）」と再確認（plan.md:249）
- `journal_summary` は `collectResults()` 流用、空でも `""` を出す旨も §2.6 末尾に記載済み（plan.md:143）

### M6: `applyAssignCommit` の `applyTaskEvent` で `eventStream: { conductorSurface, taskRunId }` — **対応済み**

- §2.6 表 2 行目に `daemon.ts:applyAssignCommit`（line 2912）の eventStream payload と switch case 組立を明示（plan.md:139）
- §3 Step (b)-6 二つ目の bullet で「`{ conductorSurface: updated.surface, taskRunId: updated.taskRunId }` を渡す」と具体化（plan.md:179）
- §4 daemon.ts 行 (3) で M6 の指示を明記（plan.md:249）
- writer 側型 `task_assigned: { task_id, conductor_surface, task_run_id }` と switch case の 1:1 対応は §2.6 末尾でも改めて確認されており、exhaustive check による compile-time field 漏れ検出が担保される

---

## Minor / Nits の反映確認（要点のみ）

- **m1**（kind の出所）: §3 Step (c)-3 で「reject 経路は `result.state` をそのまま流す（到達は `diverged|uncommitted|detached` の 3 値）」「auto-pull-failed 経路は固定値 `"auto_pull_failed"`」と明記（plan.md:192）— ✓
- **m2**（`task_completed_state_missing` の扱い）: §6.9 第一項で「events.jsonl には emit しない、manager.log だけに残す」と決定明記（plan.md:341）— ✓
- **m3**（shadow.ts 責務）: §6.9 第二項で「shadow.ts の `fsm_shadow_action` は events.jsonl に emit しない」と明記、scope outside §7 とも整合（plan.md:342）— ✓
- **m4**（並行 emit 耐性）: §5.1 表に「100 件 `Promise.all([...])` で並行 emit → 全行が JSON.parse 成功」を追加（plan.md:273）— ✓
- **m5**（17 経路記述）: §1 を「16 event 種を 17+ 経路で emit」に書き換え、§6.7 でも「経路数と event 種数を混同しない」と明示（plan.md:5, 330-332）— ✓
- **m6**（line 番号 drift）: §3 Step (d) 冒頭の注記で「2026-04-29 時点、anchor は `await log("conductor_*", ...)` 行の直前または直後。実装時は grep で再取得」と注記（plan.md:198）— ✓
- **m7**（fallback log 名固定化）: §2.4 で「`events_writer_error` で固定」「detail に `error.message` 必須、可能なら `error.code` / `error.stack` 先頭行も append」と明記（plan.md:85-87）— ✓
- **n1**（§4 並び順）: 編集対象が `task-fsm.ts → apply-task-actions.ts → task-state-store.ts → task.ts → daemon.ts → main.ts` の依存順に並び替え済み、§4 冒頭にも「依存順に並べた」明記あり（plan.md:232, 245-250）— ✓
- **n2**（surface ID 表記）: §6.8 維持 — ✓
- **n3**（`runSyncCheckOrExit` の test 戦略）: §5.2 表に「`process.exit(1)` を踏むため test 側で mock するか、関数を inject 可能シグネチャに切り出す」と test 戦略明記（plan.md:285）— ✓

---

## 新たな懸念

v2 の差分から重大な regression / scope 拡大は検出されなかった。下記は **実装時の確認事項**として残せるが、Verdict を Changes Requested に押し下げるものではない。

- **`apply-task-actions` switch case での `ctx.eventStream` 必須 field 取り扱い**（§2.6 末尾の switch case 例示）: `task_assigned` / `task_completed_state_mismatch` は `ctx.eventStream.conductorSurface` のように non-null 前提でアクセスする組立になっているが、caller 側で eventStream が渡されない実装ミスをした場合の挙動が plan に明記されていない。recommended: switch case 内で eventStream が undefined の場合は `events_writer_error` でフォールバック log するか、TypeScript の型レベルで context を branch ごとに必須化する（例: `LogActionWithContext` の event 名と eventStream の組合わせを discriminated union で表現）。簡易対応としては、§5.2 の test 計画に「ASSIGN_OK / CLOSE(autoClosed) で eventStream を渡し忘れた場合に events_writer_error が出る」negative assertion を 1 ケース追加するだけでも十分。実装段階で気付ければ十分なレベル。

- **§2.6 表で `task_reverted_to_ready` の reason 抽出元**: 「reducer の `detail` から reason を抽出（既存 detail 形式 `reason=<RevertReason>`）」と書かれているが、parsing ロジックが switch case 内に登場することで apply-task-actions が free-text を再パースする形になる。reducer 側で detail に `RevertReason` を構造化された形（log action の追加 field）で返す方が一貫性が高いが、plan の方針（reducer 純関数性維持・最小変更）から見れば現状記述で受容可能。実装時に detail 文字列が他用途と被らないか実コード（grep `reason=`）で 1 度確認すれば十分。

- **§5.2 fixture の `events.jsonl` 直読み戦略**: §5.3 で「createDummyProject + temp PROJECT_ROOT で test 終了時に events.jsonl を read」と書かれているが、各 caller test（task-state-store / apply-task-actions / daemon / markTaskAborted / runSyncCheckOrExit）が temp PROJECT_ROOT を共有するか分離するかが明示されていない。`bun test` 並列実行禁忌の事情も含めると、test ごとに `mkdtemp` で隔離する方針を §5.3 に 1 行追加しておくと安全。これは Approved を妨げない範囲の test infra ノート。

---

（Verdict が Approved のため Recommendations セクションは省略。Planner は Step (a)〜(f) に従って実装に着手して問題ない）
