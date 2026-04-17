# T232 Implementation Report

**タスク**: Conductor status に `assigning` を追加し、daemon 起動 `/clear` の `user_clear` 誤認を修正する
**taskRunId**: task-232-1776384479
**作業ディレクトリ**: `/Users/yamamoto/git/cmux-team/.worktrees/task-232-1776384479`

---

## Completed Tasks

| Sub-task | 内容 | 反映 | 備考 |
|----------|------|------|------|
| Sub-task 1 | `schema.ts` に `"assigning"` ステータスを追加 | ✅ | `ConductorState.status` union に追加 |
| Sub-task 2 | `conductor.ts` `assignTask` を修正 | ✅ | `/clear` 送信直前に `assigning` セット・L416 の即時 `running` セットを完全削除 (D5) |
| Sub-task 3 | `daemon.ts` SESSION_STARTED ハンドラに `assigning → running` 分岐追加 | ✅ | `conductor_running` ログ |
| Sub-task 4 | `daemon.ts` SESSION_CLEAR ハンドラで `assigning` 早期 return | ✅ | `findConductor` 直後・既存 `disconnected/starting → idle` 分岐の **前** (R3) |
| Sub-task 5 | `monitorConductors` に `assigning` timeout (60s) 追加 | ✅ | `ASSIGNING_TIMEOUT_SEC = 60`、`conductor_assign_timeout` ログ |
| Sub-task 6 | `statusline.ts` / `dashboard.tsx` UI 対応 | ✅ | `assigning…` 表示 + `assigningCount` ヘッダー集計 + `needsAnimation` に含める (R5) |
| Sub-task 7 | テスト追加（daemon + conductor）| ✅ | 9 テスト追加 — SESSION_CLEAR / STARTED / IDLE / ACTIVE / monitorConductors timeout / 回帰 / R4 (b) |
| Sub-task 8 | tsc + bun test 全体緑化 | ✅ | `tsc --noEmit` exit 0、全 426 tests pass |

### Recommendations 反映チェック

| Rec | 内容 | 反映 |
|-----|------|------|
| R1  | SESSION_IDLE / SESSION_ACTIVE の `assigning → running` 保険分岐 (+ `taskRunId` 前提) | ✅ daemon.ts 両ハンドラに追加、via=SESSION_IDLE / SESSION_ACTIVE を明示 |
| R2  | `scanTasks` catch で `assigning` 状態のまま抜けた場合に `disconnected` に倒す | ✅ task kind 分岐末尾に保険追加、AssignTaskError 以外の分岐は既存で同等 |
| R3  | SESSION_CLEAR `assigning` 早期 return の挿入位置（`findConductor` 直後・既存分岐の **前**）| ✅ 位置厳守 |
| R4  | (a) R1 保険テスト追加、(b) `/clear` 送信失敗時の disconnected テスト追加 | ✅ 両方追加（合計 9 新テスト中 3 本が R4） |
| R5  | dashboard `needsAnimation` に `assigning` を含める | ✅ CYAN スピナー + ラベル `assigning…` + ヘッダー `assigning` 集計表示 |

---

## Files Changed

| ファイル | 変更概要 |
|---------|---------|
| `skills/cmux-team/manager/schema.ts` | `ConductorState.status` union に `"assigning"` を追加 |
| `skills/cmux-team/manager/conductor.ts` | `assignTask` の `/clear` 送信直前に `conductor.status = "assigning"` + `notifyStateChanged`。L416 の即時 `status = "running"` セットを削除。`notifyStateChanged` の source を `task-info-updated` に変更 |
| `skills/cmux-team/manager/daemon.ts` | (a) SESSION_STARTED ハンドラに `assigning → running` 分岐追加。(b) SESSION_CLEAR ハンドラ先頭（`findConductor` 直後）に `assigning` 早期 return 追加。(c) SESSION_IDLE / SESSION_ACTIVE ハンドラに R1 保険分岐追加。(d) `ASSIGNING_TIMEOUT_SEC = 60` 定数追加 + `monitorConductors` に `assigning` timeout 分岐追加。(e) `scanTasks` の task kind catch に R2 保険（assigning 状態なら disconnected 昇格）追加 |
| `skills/cmux-team/manager/statusline.ts` | `StatuslineConductor.status` union に `"assigning"` を追加 |
| `skills/cmux-team/manager/dashboard.tsx` | (a) `buildConductorRow` に `isAssigning` 分岐追加（CYAN スピナー + `assigning…`）。(b) `assigningCount` ヘッダー集計追加、section title に反映。(c) `needsAnimation` に `assigning` を追加（R5）|
| `skills/cmux-team/manager/conductor.test.ts` | `assignTask 状態遷移 (T232)` describe 追加（1 test）。`cmux.send` / `cmux.sendKey` を spyOn で mock、git init + commit で worktree add を通す |
| `skills/cmux-team/manager/daemon.test.ts` | 4 describe / 8 test 追加（+1 from scanTasks R4 describe）：SESSION_CLEAR 中の状態保持 / running regression / SESSION_STARTED 遷移 / R1 SESSION_IDLE/ACTIVE / monitorConductors timeout on/off / R4 `/clear` 送信失敗時の disconnected |

---

## TDD Cycles / Verification Results

### 全体方針

plan の推奨順（schema → conductor → daemon → UI → test）で実装。各 sub-task 完了ごとに `bunx tsc --noEmit` を走らせ、最後にテストを追記 → GREEN まで回す TDD サイクル。

### サイクル 1: schema.ts

- **RED → GREEN**: 型 union 変更で他ファイルの network 的チェック。tsc 0 件で既存箇所の `"starting" | "idle" | "running" | "asking" | "disconnected"` union 依存がないことを確認 → 直ちに GREEN。

### サイクル 2: conductor.ts `assignTask`

- **RED**: plan §4 Sub-task 2 のとおり、既存 "即時 running" を残すと後続テストで fail する（旧コード）。
- **GREEN**: `/clear` 送信直前に `assigning` セット + L416 削除。既存テスト（エラー分類系 3 本）は全て通過。
- **VERIFY**: `bunx tsc --noEmit` exit 0。

### サイクル 3: daemon.ts 各ハンドラ

- **GREEN**: SESSION_STARTED / SESSION_CLEAR / SESSION_IDLE / SESSION_ACTIVE / monitorConductors / scanTasks catch を plan + R1 / R2 / R3 のとおり実装。tsc 0 件。
- **VERIFY**: 既存 daemon.test.ts 74 本すべて通過（回帰無し）。

### サイクル 4: UI (statusline / dashboard)

- **GREEN**: `assigning` 分岐・カウンタ・アニメーション判定を追加。tsc 0 件。

### サイクル 5: テスト追加（Sub-task 7 + R4）

**conductor.test.ts**
- 成功パスで `status === "assigning"` を確認（`running` ではない）
- cmux.send / sendKey を spyOn で mock、git init で worktree add を通す
- 実行結果: 9 tests pass（既存 8 + 新 1）

**daemon.test.ts**（以下すべて新規）
- `handleMessage: assigning 中の SESSION_CLEAR (T232)`
  - assigning + SESSION_CLEAR → status 保持 / task-state 不変 / pid 保持
  - running + SESSION_CLEAR は従来通り user_clear による task_aborted（回帰防止）
- `handleMessage: assigning → running 遷移 (T232)`
  - assigning + SESSION_STARTED(source=clear) → running / pid 更新
  - R1 assigning + SESSION_IDLE(taskRunId あり) → running
  - R1 assigning + SESSION_ACTIVE(taskRunId あり) → running
- `monitorConductors: assigning timeout (T232)`
  - 61 秒経過で `assigning → disconnected`、`disconnectedAt` セット
  - 10 秒経過では `assigning` 維持
- `scanTasks: /clear 送信失敗時 (T232 R4)`
  - cmux.send 例外 → AssignTaskError("conductor") → `idleConductor.status === "disconnected"`

実行結果: 83 tests pass（既存 74 + 新 9）

### サイクル 6: REFACTOR

- 新規コードのコメントを整理（Decision Log や R1 / R2 などの参照を付与）。
- 追加ログイベント名は Decision Log D2 に準拠（`conductor_running` / `session_clear_expected` / `conductor_assign_timeout`）。
- `notifyStateChanged` source 命名は CLAUDE.md EventBus ポリシーに沿って `"<file>:<function>:<reason>"` 形式（例: `conductor.ts:assignTask:assigning-set`）。

---

## Final Verification

### `bunx tsc --noEmit`

```
exit 0 (エラーなし)
```

### `bun test 2>&1 | tail -40`

```
[trace-store] hook_signal_payload_truncated type=SESSION_ASK size=100109

envrc-prompt.test.ts:
.envrc に CMUX_CLAUDE_HOOKS_DISABLED=1 を追記しました。
反映には以下の手順が必要です:

  1. 現在のセッションを exit
  2. シェルで: direnv allow
  3. cmux-team start を再実行

（direnv が未導入の場合は手動で source .envrc または環境変数設定が必要です）
.envrc に CMUX_CLAUDE_HOOKS_DISABLED=1 を追記しました。
反映には以下の手順が必要です:

  1. 現在のセッションを exit
  2. シェルで: direnv allow
  3. cmux-team start を再実行

（direnv が未導入の場合は手動で source .envrc または環境変数設定が必要です）
.envrc に CMUX_CLAUDE_HOOKS_DISABLED=1 を追記しました。
反映には以下の手順が必要です:

  1. 現在のセッションを exit
  2. シェルで: direnv allow
  3. cmux-team start を再実行

（direnv が未導入の場合は手動で source .envrc または環境変数設定が必要です）
.envrc に CMUX_CLAUDE_HOOKS_DISABLED=1 を追記しました。
反映には以下の手順が必要です:

  1. 現在のセッションを exit
  2. シェルで: direnv allow
  3. cmux-team start を再実行

（direnv が未導入の場合は手動で source .envrc または環境変数設定が必要です）

 426 pass
 0 fail
 914 expect() calls
Ran 426 tests across 20 files. [13.59s]
```

- Pass: 426 / Fail: 0
- T232 テスト（daemon + conductor）: 新規 9 本すべて GREEN
- 既存テストに回帰なし

---

## Issues Encountered

なし。plan + Recommendations の範囲で完結。

- tsc `--noEmit` は最初から exit 0 で、既存の型エラーは検出されず（plan §6 のとおり）
- UI (dashboard.tsx) の実機表示は unit test 範囲外（CLI を動かす E2E は本タスク範囲外、plan §5 のとおり）
- `.team/artifacts/` には書き出していない（指示どおり — Conductor の完了処理で登録）

## 参考: 主要な挙動変更

1. **新しい状態 `assigning`**: daemon が `/clear` を送る直前にセットされ、SESSION_STARTED / SESSION_IDLE / SESSION_ACTIVE で `running` に遷移する。60 秒で timeout → `disconnected`。
2. **SESSION_CLEAR の分岐**:
   - `assigning` → 早期 break（destructive 処理完全スキップ）
   - `disconnected`/`starting` → `idle` 復帰（既存通り）
   - `running` → ユーザー手動 /clear として task_aborted + resetConductor（既存通り、T229 の stale guard も適用）
3. **ログイベント追加**: `conductor_running`, `session_clear_expected`, `conductor_assign_timeout`
4. **UI**: `assigning…` CYAN スピナー + ヘッダー集計 + スピナー駆動判定対象
