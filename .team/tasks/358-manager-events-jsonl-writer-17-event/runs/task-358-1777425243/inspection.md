# Inspection: T358 events.jsonl writer

## Verdict: GO

## Summary

spec / plan / impl-summary を独立検証した結果、`events-writer.ts` は v2 schema に厳密準拠し、6 つの Major (M1-M6) と 7 つの minor が漏れなく適用されていた。テスト実行は impl-summary の主張どおり 58 ファイル / 1755 件 pass・0 件 fail、tsc も新規エラーなし。ガードレール（hook 不変・bus 直接呼び出しなし・logger.ts → eventBus.ts import なし・既存 await log() 削除なし・spec 改変なし）も全て満たす。

## A. spec 整合性

- `EVENTS_SCHEMA_VERSION = 2`（`events-writer.ts:23`）→ spec §2 / §3 / §4 「現行値 2」と一致
- `EventStreamRecord` discriminated union（`events-writer.ts:47-125`）は spec §6.1〜§6.16 の 16 event 種すべてを網羅。各 payload の field 名・必須/optional 区分・enum 値（`reason` / `kind` / `new_status`）が spec の表と完全に一致
  - 特に `task_completed_state_mismatch.reason: "missing_close_task"` リテラル一致（§6.5）
  - `conductor_disconnected.task_id?: string` で optional 化（§6.11）
  - `conductor_disconnect_timeout.task_id?: string` で optional 化（§6.16）
- `SpecAbortReason`（`events-writer.ts:29-35`）は spec §6.6 の 6 値（`judgment_pending | disconnect_timeout | user_clear | assign_failed | resume_marked_aborted | other`）に厳密一致
- `mapAbortReason`（`events-writer.ts:131-152`）の 8→6 値マップは plan §2.1 の表と完全一致：
  - pass-through 4 値 (user_clear / judgment_pending / assign_failed / disconnect_timeout)
  - `abort_task → other`
  - `resume_no_session_id` / `resume_no_task_run_id` / `resume_no_worktree → resume_marked_aborted`
- `ts` は writer 側で `new Date().toISOString()` で付与（`events-writer.ts:172`）。形式は ISO 8601 with ms + Z（test の regex `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$` で検証済み）
- 1 record/line: `JSON.stringify(...) + "\n"`（`events-writer.ts:176`）。test「1 行 1 record」で trailing `\n` と record 内 `\n` 不在を実 fs read で検証

## B. plan 準拠 (M1-M6)

- **M1**: `task.ts:623-628` で `markTaskAborted` wrapper が `mapAbortReason(reason)` を実適用して emit。dynamic import で循環依存回避。`task.test.ts` に 8 値の table-driven assertion あり。✅
- **M2**: `task-fsm.ts:42-55` の CREATE reducer が `initialStatus === "ready"` のとき `[task_created, task_ready]` の 2 件 log action を返す（リテラル確認）。✅
- **M3**: `daemon.ts:3776` の `emitEvent({event:"task_completed"})` は `else` 通常経路 1 ヶ所のみ。auto-close ブランチ（`stateMismatchOnSuccess === true`、3689-3756）には `emitEvent({event:"task_completed"})` の呼び出しなし（grep 確認済み）。`manager.log` 側の `await log("task_completed", ...)` は v1 互換のため温存。✅
- **M4**: `apply-task-actions.ts:80-146` の switch は allowlist 5 種（task_created / task_ready / task_assigned / task_completed_state_mismatch / task_reverted_to_ready）に限定、default 句はコメント `// allowlist 外の log は events.jsonl に流さない` 付きで `return` のみ（no-op）。`task-fsm.ts:79-92` の ASSIGN_FAIL kind=task は `task_aborted_core` にリネーム済み（リテラル確認）。✅
- **M5**: `daemon.ts:3705-3729` の auto-close 経路で `applyTaskEvent({type:"CLOSE", autoClosed:true})` 呼び出しに `eventStream: { conductorSurface: conductor.surface, worktreePath: conductor.worktreePath ?? "", journalSummary: journalSummary ?? "" }` を付与。✅
- **M6**: `daemon.ts:2989-3015` の `applyAssignCommit` で `applyTaskEvent({type:"ASSIGN_OK"})` に `eventStream: { conductorSurface: updated.surface, taskRunId: updated.taskRunId ?? "" }` を付与。✅

## C. ガードレール

- hook shell 変更なし — リポジトリに `skills/cmux-team/manager/hooks/` ディレクトリ自体存在せず（`find` で確認）、git status でも hook 関連ファイルの追加なし。✅
- `bus.emit` / `bus.on` の直接呼び出しを events-writer から行っていない — `grep "bus\.emit\|bus\.on" skills/cmux-team/manager/events-writer.ts` 0 件。✅
- `taskState[...] =` / `saveTaskState(` の追加 — `git diff` の `+` 行で events-writer 関連変更内に該当パターン 0 件。daemon.ts / main.ts への追加もなし。✅
- `logger.ts` から `eventBus.ts` への import — `grep "from.*eventBus" skills/cmux-team/manager/logger.ts` 0 件。`events-writer.ts` も `eventBus` を import していない。✅

## D. テスト実行結果（自分で再実行した）

| 項目 | 結果 | 備考 |
|---|---|---|
| `events-writer.test.ts` | **18 pass / 0 fail / 148 expect()** | impl-summary 主張と一致 |
| `state-machine/apply-task-actions.test.ts` + `state-machine/task-state-store.test.ts` + `task.test.ts` | **139 pass / 0 fail / 329 expect()**（合算実行） | |
| `state-machine/fsm.test.ts` | **184 pass / 0 fail / 344 expect()** | |
| 全 manager テスト個別実行（55 ファイル + state-machine 3 ファイル = 58 ファイル） | **1755 pass / 0 fail** | impl-summary の `1755 件 pass` と完全一致 |
| `bunx tsc --noEmit -p skills/cmux-team/manager/tsconfig.json` | exit=0、出力なし | 新規型エラー 0 件 |

## E. テスト品質

- **`events-writer.test.ts`** は `createDummyProject` で temp PROJECT_ROOT を作成し、`readJsonl()` ヘルパで実 fs から読み出して `JSON.parse` 後に assertion している（spy ではない）。plan §5.1 の 7 観点すべてカバー：
  - schema 適合（schema_version=2 / ts regex / event field）
  - 1 record/line（trailing `\n` + record 内 `\n` 不在）
  - append-only（10 件 / 100 件 + 追加 1 件で `stat().size` 増加確認）
  - エラー耐性（events.jsonl をディレクトリ化して EISDIR を強制 → throw しないこと + manager.log に `events_writer_error` + `event=task_ready` + `message=` を含むこと）
  - mkdir 自動（subdirs:[] で空 project から start）
  - **並行 emit**（`Promise.all` で 100 件 emit → 100 行すべて `JSON.parse` 成功 + 全 task_id がユニーク）
  - `mapAbortReason` 8 値 → 6 値の table-driven 完全網羅
- **caller test の eventStream 渡し忘れ negative assertion** が `apply-task-actions.test.ts:256-273`（`task_assigned`）と `298-313`（`task_completed_state_mismatch`）の 2 経路で実装され、`events_writer_error` + `event=...` + `task_id=...` を manager.log で確認するアサーションを含む。✅
- **allowlist 外 log の events.jsonl 不流出**を `apply-task-actions.test.ts:337-358` で 5 種（task_aborted_core / task_closed / task_deleted / task_restarted / task_create_idempotent_skip）について `events.length === 0` で確認。✅
- `task.test.ts` で `markTaskAborted` の SpecAbortReason マップを 8 値 table-driven で確認（impl-summary 記載どおり）。

## F. 副作用

- `manager.log` v1 出力は破壊なし — `git diff` で `await log("...")` の削除行 0 件、改変は コメント / log action の event 名（M2 / M4 で意図的）の 3 行のみ。dashboard / trace 互換維持。✅
- task-state.json schema 不変 — patch 内容（assignedAt / closedAt / journal / deliverable / sessionId 等）は既存と同形。✅
- `notifyStateChanged` 呼び出しの追加・削除なし — `git diff | grep notifyStateChanged` 0 件。✅
- `docs/spec/10-events-stream.md` 自体への変更なし — git log では 2026-04-27 の T357 commit が最新で、本タスク中に touch されていない。✅

## Findings

### Critical (NOGO 要因)

- なし

### Major (修正必須)

- なし

### Minor (推奨)

- `events-writer.ts` の `eventsFilePath()`（line 154-160）は `process.env.PROJECT_ROOT || process.cwd()` フォールバックで cwd を使う。daemon は通常 `PROJECT_ROOT` を設定して起動するため実害はないが、テスト並行実行時に test の cwd と project root の不一致で events.jsonl が想定外パスに作られるリスクがある。test は `createDummyProject` 内で `process.env.PROJECT_ROOT` を切り替える前提で組まれており現状 green。将来テスト並行化を強化する場合は logger.ts と同様 strict モード化を検討すると安全。今回は GO 阻害ではない。
- `daemon.ts:3775` の `if (taskId && taskId !== "undefined")` ガードは過防衛気味で、`taskId === "undefined"` 文字列の混入を実コード経路から想定しづらい。本来 `if (taskId)` で十分だが副作用なし。指摘のみ。

## Fix Required (NOGO の場合のみ)

該当なし（GO）。
