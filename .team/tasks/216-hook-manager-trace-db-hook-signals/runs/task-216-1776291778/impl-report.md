# T216 実装レポート — hook 全送信設計への統合

**タスク**: T216 hook全送信設計への統合: CLAUDE.md更新 + Managerフィルタ移設 + trace DB hook_signals
**Implementer run**: task-216-1776291778
**実装日時**: 2026-04-16
**ベースプラン**: `plan.md` rev2 (Approved 済み)

---

## Completed Tasks

| # | サブタスク | 状態 |
|---|----------|------|
| ST-1  | CLAUDE.md に hook 全送信ポリシー + hook_signals GC 運用手順を追記 | ✅ |
| ST-2  | trace-store.ts に `hook_signals` テーブル + `insertHookSignal` を追加（64KB ガード付き） | ✅ |
| ST-3  | daemon.ts の `DaemonState` に `traceDb: Database | null` を追加、`initInfra` で初期化 | ✅ |
| ST-4  | `handleMessage` 入口で `insertHookSignal` を呼ぶ（switch 分岐の前） | ✅ |
| ST-5  | `case "SESSION_ENDED"` 先頭に `reason === "other"` ガードを追加（state 触らず break） | ✅ |
| ST-6  | `buildMessageFromHookInput` に SESSION_ENDED ブランチを追加 + `SessionEndedMessageSchema` import | ✅ |
| ST-7  | `generateConductorSettings` の SessionEnd matcher を `"logout|prompt_input_exit|other"` + `--from-stdin` 方式に変更 | ✅ |
| ST-8  | `generateAgentSettings` の SessionEnd hook を `--from-stdin` 方式に統一 | ✅ |
| ST-9  | `main.test.ts` 更新: (a) T210 matcher 文字列更新 / (b) Conductor 新仕様 test / (c) Agent 新仕様 test + `buildMessageFromHookInput` 新ブランチ 3 本 | ✅ |
| ST-10 | `trace-store.test.ts` 新規作成: `insertHookSignal` ユニットテスト 3 本（SESSION_STARTED / SESSION_ENDED reason=other / 64KB truncate） | ✅ |
| ST-11 | `daemon.test.ts` に T216 describe 追加: reason=other で state 不遷移 + logout/prompt_input_exit の regression 2 本 | ✅ |
| ST-12 | 全体 tsc + bun test の最終 gate（363 pass / 0 fail / tsc error 0） | ✅ |

---

## Files Changed

| # | ファイル | 種別 | 変更概要 |
|---|---------|------|---------|
| 1 | `CLAUDE.md` | 追加 | Manager プロトコル セクション末尾に `### hook 全送信ポリシー（T216）` subsection を追加。設計思想・実装上の不変条件・hook_signals GC の手動運用手順（`sqlite3 ... DELETE FROM hook_signals WHERE timestamp < ...`）を記載 |
| 2 | `skills/cmux-team/manager/schema.ts` | 追加 | `export type SessionEndedMessage = z.infer<typeof SessionEndedMessage>` を追加（型エイリアス不足） |
| 3 | `skills/cmux-team/manager/trace-store.ts` | 更新 | `SCHEMA` 定数に `CREATE TABLE IF NOT EXISTS hook_signals` + 3 INDEX を append。`QueueMessage` 型 import 追加、`HOOK_SIGNAL_PAYLOAD_LIMIT = 64*1024` 定数、`insertHookSignal(db, message)` を export で追加（64KB 超で `slice` + `console.warn("hook_signal_payload_truncated ...")`） |
| 4 | `skills/cmux-team/manager/daemon.ts` | 更新 | `Database`/`initDB`/`insertHookSignal` の import 追加、`DaemonState` に `traceDb: Database | null` 追加、`createDaemon` の返却に `traceDb: null` 追加、`initInfra` 末尾で `state.traceDb = initDB(root)` を try/catch でセット |
| 5 | `skills/cmux-team/manager/daemon.ts` | 更新 | `handleMessage` 入口（switch 前）で `state.traceDb` が null でなければ `insertHookSignal(state.traceDb, message)` を try/catch で呼び出し。失敗時は `log("hook_signal_insert_failed", ...)` |
| 6 | `skills/cmux-team/manager/daemon.ts` | 更新 | `case "SESSION_ENDED"` の先頭（Master surface チェックより前）に `if (message.reason === "other") { log("session_ended_other_ignored", ...); break; }` を追加 |
| 7 | `skills/cmux-team/manager/main.ts` | 更新 | schema import 行に `SessionEndedMessage` 型と `SessionEndedMessage as SessionEndedMessageSchema` を追加 |
| 8 | `skills/cmux-team/manager/main.ts` | 更新 | `buildMessageFromHookInput` に `if (type === "SESSION_ENDED") { ... }` ブランチを追加（`obj.reason` を安全に抽出して `SessionEndedMessageSchema.parse` で返す） |
| 9 | `skills/cmux-team/manager/main.ts` | 更新 | `generateConductorSettings` の SessionEnd hook: matcher を `"logout|prompt_input_exit"` → `"logout|prompt_input_exit|other"`、command を `--from-stdin` 方式に変更、`--reason "session_end"` ハードコードを削除 |
| 10 | `skills/cmux-team/manager/main.ts` | 更新 | `generateAgentSettings` の SessionEnd hook: command を `--from-stdin` 方式に変更、`--reason "session_end"` ハードコードを削除 |
| 11 | `skills/cmux-team/manager/main.test.ts` | 更新 | T210 既存 test の matcher 文字列を `"logout|prompt_input_exit|other"` に更新（`.find` パターン維持）。`buildMessageFromHookInput` の「異常: 未対応 type で throw」を SESSION_ENDED → TASK_CREATED に差し替え（SESSION_ENDED は正常系になったため） |
| 12 | `skills/cmux-team/manager/main.test.ts` | 追加 | `T216: Conductor SessionEnd(logout|prompt_input_exit|other) hook は --from-stdin 方式で reason ハードコードを含まない` test、`T216: Agent SessionEnd ...` test、`T216: SESSION_ENDED — reason=logout/other/undefined を stdin から抽出` の 3 本を追加 |
| 13 | `skills/cmux-team/manager/trace-store.test.ts` | 新規作成 | `insertHookSignal` ユニットテスト 3 本（SESSION_STARTED / SESSION_ENDED reason=other / SESSION_ASK 100KB question で 64KB truncate） |
| 14 | `skills/cmux-team/manager/daemon.test.ts` | 追加 | `describe("handleMessage: SESSION_ENDED reason=other (T216)")` に 3 test: reason=other で `conductor.status` が `"running"` のまま / reason=logout で `disconnected` に遷移 / reason=prompt_input_exit で `disconnected` に遷移 |

---

## TDD Cycles / Verification Results

### ST-1: CLAUDE.md 追記
- VERIFY: `grep -cn "hook 全送信\|hook_signals\|reason=other\|DELETE FROM hook_signals" CLAUDE.md` → 6 hit（期待通り）

### ST-2: trace-store.ts hook_signals テーブル追加
- GREEN: `SCHEMA` 定数に `CREATE TABLE IF NOT EXISTS hook_signals (...)` + 3 INDEX、`insertHookSignal(db, message)` を追加
- VERIFY: `bunx tsc --noEmit` → error 0

### ST-3: DaemonState.traceDb 追加
- GREEN: `import type { Database } from "bun:sqlite"`、`import { initDB, insertHookSignal } from "./trace-store"`、DaemonState に `traceDb: Database | null` 追加、`createDaemon` 返却で `traceDb: null`、`initInfra` 末尾で `state.traceDb = initDB(root)` を try/catch で設定
- VERIFY: `bunx tsc --noEmit` → error 0

### ST-4: handleMessage 入口で insertHookSignal 呼び出し
- GREEN: `switch (message.type)` の前に `if (state.traceDb) { try { insertHookSignal(state.traceDb, message); } catch (e) { await log("hook_signal_insert_failed", ...); } }`
- VERIFY: 行順 `insertHookSignal` → `switch` を grep で確認（正しく前段配置）

### ST-5: reason=other ガード
- GREEN: `case "SESSION_ENDED"` 先頭に `if (message.reason === "other") { log("session_ended_other_ignored", ...); break; }`
- VERIFY: ST-11 の unit test で状態不遷移を自動検証

### ST-6: buildMessageFromHookInput SESSION_ENDED ブランチ追加
- RED: 既存 main.test.ts の「異常: 未対応 type で throw」test が SESSION_ENDED を使っていたため fail する予定 → SESSION_ENDED 対応後に TASK_CREATED に差し替えて再 GREEN
- GREEN: `if (type === "SESSION_ENDED") { const reason = typeof obj.reason === "string" ? obj.reason : undefined; ... return SessionEndedMessageSchema.parse(message); }`
- ついでに `schema.ts` に `export type SessionEndedMessage = z.infer<typeof SessionEndedMessage>` を追加（型エイリアス不足で tsc がエラーになるため）
- VERIFY: `bun test main.test.ts` → 95 pass

### ST-7/8: generateConductorSettings / generateAgentSettings 更新
- GREEN: matcher を `"logout|prompt_input_exit|other"` に、command を `--from-stdin` 方式に変更、`--reason "session_end"` ハードコード削除
- VERIFY: `grep -c '"logout|prompt_input_exit|other"' main.ts` → **2**（Conductor + Agent）。`grep -c '"session_end"' main.ts` → **0**

### ST-9: main.test.ts
- (a) T210 既存 test の matcher 文字列更新
- (b) Conductor 新仕様 test（`.find(h => h.matcher === "logout|prompt_input_exit|other")` パターン、`--from-stdin` 検証、`--reason` 非含有検証、`clear` matcher regression）
- (c) Agent 新仕様 test（同上パターン）
- 追加: `buildMessageFromHookInput` の SESSION_ENDED ブランチ 3 本（reason=logout / reason=other / reason 未指定）
- VERIFY: `bun test main.test.ts` → 95 pass / 0 fail

### ST-10: trace-store.test.ts 新規作成
- 3 本の unit test:
  1. SESSION_STARTED → `type/surface/pid/source` 列が正しく入る + `payload_json` を `JSON.parse` で復元可能
  2. SESSION_ENDED reason=other → `reason` 列に "other" が入る + payload_json 復元可能
  3. SESSION_ASK question=100KB → `payload_json.length <= 65536` で truncate + `console.warn` 出力
- VERIFY: `bun test trace-store.test.ts` → 3 pass / 0 fail（truncate warn ログも stdout で確認）

### ST-11: daemon.test.ts T216 describe 追加
- 3 本の unit test:
  1. `reason=other` → `conductor.status === "running"` のまま、`pid` 維持、`disconnectedAt` 未設定
  2. `reason=logout` → `conductor.status === "disconnected"`、`pid === undefined`、`disconnectedAt` 設定（regression）
  3. `reason=prompt_input_exit` → `conductor.status === "disconnected"`（regression）
- `traceDb` は `createDaemon` が返す `null` のまま（handleMessage 内の `if (state.traceDb)` ガードで skip）
- VERIFY: `bun test daemon.test.ts` → 73 pass / 0 fail

### ST-12: 最終 gate
- `bunx tsc --noEmit` → error 0
- `bun test` → 363 pass / 0 fail / 758 expect calls / 17 ファイル

---

## Test Results

### bun test (全体)

```
 363 pass
 0 fail
 758 expect() calls
Ran 363 tests across 17 files. [9.85s]
```

変更ファイル別の内訳:
- `main.test.ts`: 95 pass
- `trace-store.test.ts`: 3 pass（新規）
- `daemon.test.ts`: 73 pass（+3 本追加）

### bunx tsc --noEmit

```
(出力なし) — error 0
```

---

## Issues Encountered

### 1. `SessionEndedMessage` 型エイリアスが schema.ts に存在しなかった

**事象**: `main.ts` で `import type { SessionEndedMessage } from "./schema"` を追加したが、schema.ts 側に `export type SessionEndedMessage = z.infer<typeof SessionEndedMessage>` が無く tsc が通らなかった。`SessionStartedMessage` は既にあった。

**対応**: schema.ts の既存 `export type SessionStartedMessage ...` の直後に `export type SessionEndedMessage = z.infer<typeof SessionEndedMessage>` を追加。Zod スキーマ定数名と TypeScript 型名を同名にする既存のパターンを踏襲。

**影響**: スコープ内解消。cleanup タスク分離不要。

### 2. 既存 test「異常: 未対応 type で throw」が SESSION_ENDED を unsupported 例として使っていた

**事象**: `main.test.ts:785` の test が `buildMessageFromHookInput("SESSION_ENDED", ...)` で throw を期待していたが、T216 で SESSION_ENDED は正常系になったため fail。

**対応**: test の type 引数を `"SESSION_ENDED"` → `"TASK_CREATED"`（genuinely unsupported な type）に差し替え。test 意図（「未対応 type なら throw する」）は維持。スコープ内で解消。

### 3. 既存 test「既存の SessionStart / Stop / SessionEnd hook が残存している (regression)」

**事象**: `main.test.ts:61-67` の test が `settings.hooks.SessionEnd.length === 2` を期待していた。

**確認**: matcher 変更後も SessionEnd hook の数は 2 本（`clear` + `logout|prompt_input_exit|other`）のままなので変更不要。そのまま pass。

### 4. cleanup タスク分離

**なし** — すべて T216 スコープ内で解消した。将来的な検討事項:
- `hook_signals` テーブルの GC 機構（自動 retention）は本 PR スコープ外。運用者向けの手動 `DELETE FROM hook_signals WHERE timestamp < ...` 手順を CLAUDE.md に記載済み
- SESSION_STOP → ASK/IDLE 合成での 2 重記録は plan D4 で「許容」と判断済み（解析時に type で絞れる）

### 5. 手動 E2E 検証

**非実施**: ST-12 の手動検証（daemon 起動 → Conductor spawn → `/clear` → `sqlite3` で `hook_signals` を確認）は本ランでは実施していない。

**理由**: 本実装エージェントは Conductor 経由で呼び出されているため、Manager daemon を新規起動するのは二重起動になり他 Conductor に影響する。unit test（ST-10: `insertHookSignal` 直呼び、ST-11: `handleMessage(reason=other)` 直呼び）で同等の観点を自動検証済み。手動 E2E は Inspector / レビュアが別途実施する想定。

---

## Notes for Inspector

- 受け入れ条件（plan.md §9）の #1〜#13 は自動テストで全て検証済み（#14 の手動 E2E のみ未実施）
- `hook_signals` テーブルは `CREATE TABLE IF NOT EXISTS` で冪等にマイグレーションされるため、既存 `.team/traces/traces.db` は破壊しない
- 既存稼働中の Conductor セッションは古い `--reason "session_end"` ハードコード hook のままだが、次回 Conductor 再起動時に新 settings.json が読み直されるため強制再起動は不要（plan §5.4 D11）
