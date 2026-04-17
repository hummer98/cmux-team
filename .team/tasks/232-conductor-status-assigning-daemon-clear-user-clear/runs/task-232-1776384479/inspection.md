# T232 Inspection Report

**タスク**: Conductor status に `assigning` を追加し、daemon 起動 `/clear` の `user_clear` 誤認を修正する
**taskRunId**: task-232-1776384479
**検品対象**: `skills/cmux-team/manager/{schema,conductor,daemon,dashboard,statusline}.ts(x)` + test files
**検品日時**: 2026-04-17
**作業ディレクトリ**: `/Users/yamamoto/git/cmux-team/.worktrees/task-232-1776384479`

---

## Verdict: GO

## Summary

plan.md の Sub-task 1〜8 および design-review.md の Recommendations R1〜R5 が全てコードに反映されており、型エラー 0・全 426 テスト GREEN（T232 新規 9 本含む）。Critical/Major 指摘なし。assigning 状態による daemon-clear と user-clear の分離ロジック、早期 return の配置、60 秒 timeout、UI（spinner/ヘッダー集計/アニメーション駆動）まで plan + review 指摘を満たす実装となっている。

## Findings

### 1. 計画充足（Critical if 未実装）— PASS（minor 1）

- Sub-task 1 (schema `"assigning"` 追加): `schema.ts:181` で `ConductorState.status` union に追加済み — ✅
- Sub-task 2 (assignTask 修正): `conductor.ts:376` で `/clear` 送信直前に `assigning` セット、`conductor.ts:422-423` で旧即時 `status = "running"` が**物理削除**済み（grep 結果: conductor.ts 内に該当行なし）— ✅
- Sub-task 3 (SESSION_STARTED の assigning→running 分岐): `daemon.ts:1040-1046`（ログ `conductor_running`）— ✅
- Sub-task 4 (SESSION_CLEAR 早期 return): `daemon.ts:1480-1490`（ログ `session_clear_expected`、break で switch 抜け）— ✅
- Sub-task 5 (`monitorConductors` の assigning timeout): `daemon.ts:1898`（`ASSIGNING_TIMEOUT_SEC = 60`）+ `daemon.ts:1927-1939`（`conductor_assign_timeout`）— ✅
- Sub-task 6 (UI 対応): `statusline.ts:40`, `dashboard.tsx:402-420`（`assigning…` CYAN スピナー）, `dashboard.tsx:878`（`assigningCount`）, `dashboard.tsx:978`（ヘッダー集計）— ✅
- Sub-task 7 (テスト追加): `conductor.test.ts:105-146` + `daemon.test.ts:1946-2177`（合計 9 本の新規 test）— ✅
- Sub-task 8 (tsc + bun test 緑化): tsc exit=0, bun test 426 pass/0 fail — ✅

**severity: minor** — impl-report.md §Final Verification の「83 tests pass」は daemon.test.ts 単体の数字と主張されているが、実際の `bun test conductor.test.ts daemon.test.ts` の合計は 92 pass。機能影響なし、単なる表記の誤り。

### 2. Recommendations 反映（Critical if 反映漏れ）— PASS

- **R1**（SESSION_IDLE / SESSION_ACTIVE での assigning → running 保険分岐、`taskRunId` 条件付き）
  - SESSION_ACTIVE: `daemon.ts:1273-1281`（via=SESSION_ACTIVE ログ）
  - SESSION_IDLE: `daemon.ts:1374-1382`（via=SESSION_IDLE ログ）
  - 両方とも `conductor.taskRunId` 存在チェック付き — ✅
- **R2**（`scanTasks` catch の assigning → disconnected 保険）
  - task kind catch: `daemon.ts:1664-1674`（`reason=assigning_stuck`）
  - 想定外例外 (AssignTaskError 以外): `daemon.ts:1688-1696`（コメントで R2 明記）— ✅
- **R3**（SESSION_CLEAR `assigning` 早期 return の位置）
  - `daemon.ts:1479-1490`: `findConductor` 直後、既存 `disconnected/starting → idle` 分岐（L1491-1498）よりも**前**に配置 — ✅
- **R4**（追加テスト 2 件）
  - SESSION_IDLE 保険: `daemon.test.ts:2049-2069` — ✅
  - SESSION_ACTIVE 保険: `daemon.test.ts:2072-2092` — ✅
  - `/clear` 送信失敗時の disconnected: `daemon.test.ts:2144-2177` — ✅
- **R5**（dashboard `needsAnimation` に `assigning` を含む）
  - `dashboard.tsx:1324`: `c.status === "running" || c.status === "starting" || c.status === "assigning"` — ✅

### 3. Dead/Zombie Code（Major）— PASS

- `conductor.ts` 内に `status = "running"` 文は**物理削除**済み（`rg 'status = "running"' skills/cmux-team/manager/conductor.ts` で 0 件）— ✅
- daemon.ts の `status = "running"` は全て SESSION_* ハンドラ経由の正規遷移（assigning / starting / disconnected からの遷移）— ✅
- 未使用 import / 変数 / 関数なし（tsc 結果 0）— ✅

### 4. テスト（Critical if 破壊）— PASS

**検証コマンド**:
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-232-1776384479/skills/cmux-team/manager && bun test 2>&1 | tail -5
```

**結果**:
```
 426 pass
 0 fail
 914 expect() calls
Ran 426 tests across 20 files. [13.85s]
```

- 既存テスト回帰なし — ✅
- T232 新規 9 テスト（conductor.test.ts 1 + daemon.test.ts 8）GREEN — ✅
- 回帰防止テスト「running + SESSION_CLEAR は task_aborted」も含む（`daemon.test.ts:1991-2015`）— ✅

### 5. 設計原則（Major）— PASS

- **EventBus ポリシー**: `notifyStateChanged` の source は全て `"<file>:<function>:<reason>"` 形式
  - `conductor.ts:assignTask:assigning-set` / `conductor.ts:assignTask:task-info-updated`
  - `daemon.ts:monitorConductors:assigning-timeout` / `daemon.ts:scanTasks:assigning-fallback-disconnected`
  - 状態 mutation 直後のみ emit（中間処理での emit なし）— ✅
- **logger ポリシー**: `formatSurface(surface, "C")` による `C[NNN]` 表記、`key=value` フォーマットに準拠
  - 新規イベント `conductor_running` / `session_clear_expected` / `conductor_assign_timeout` / `conductor_disconnected(reason=assigning_stuck)` 全て準拠 — ✅
- **Decision Log 準拠**: D2 のログイベント名指針、D5 の「L416 の完全削除」、D6 の「SESSION_STARTED 経由のみの遷移 + R1 保険経路」の方針と実装が一致 — ✅
- **DRY/SSOT**: 60 秒 timeout 定数 `ASSIGNING_TIMEOUT_SEC` は 1 箇所定義、状態遷移ロジックは `handleMessage` / `monitorConductors` / `scanTasks` の 3 箇所に集約（既存構造を踏襲）— ✅

### 6. 型エラーゼロ化 — touched files（Critical）— PASS

**検証コマンド**:
```bash
cd skills/cmux-team/manager && bunx tsc --noEmit
```

**結果**: exit 0（出力なし）— ✅

touched files（`conductor.ts`, `conductor.test.ts`, `daemon.ts`, `daemon.test.ts`, `dashboard.tsx`, `schema.ts`, `statusline.ts`）いずれも型エラーなし。

### 7. 状態遷移の網羅性検証（Critical if 漏れ）— PASS

| 遷移経路 | 実装箇所 | 検証 |
|---------|---------|------|
| `idle → assigning`（入口）| `conductor.ts:376`（`/clear` 送信直前にセット） | ✅ 送信**直前**に配置、送信後ではない |
| `assigning → running`（SESSION_STARTED） | `daemon.ts:1040-1046` | ✅ `conductor_running` ログ |
| `assigning → running`（SESSION_IDLE 保険） | `daemon.ts:1374-1382` | ✅ taskRunId 条件付き |
| `assigning → running`（SESSION_ACTIVE 保険） | `daemon.ts:1273-1281` | ✅ taskRunId 条件付き |
| `assigning` 中の SESSION_CLEAR 早期 return | `daemon.ts:1479-1490` | ✅ task-state / resetConductor 一切触らず |
| `assigning → disconnected`（monitorConductors 60s timeout） | `daemon.ts:1927-1939` | ✅ `conductor_assign_timeout` ログ |
| `assigning → disconnected`（scanTasks catch 保険） | `daemon.ts:1664-1674, 1688-1696` | ✅ task kind + 想定外例外の 2 経路 |

全 7 経路網羅、漏れなし。

---

## Evidence

### tsc 結果

```bash
$ cd skills/cmux-team/manager && bunx tsc --noEmit; echo "exit=$?"
exit=0
```

### bun test 結果（末尾 20 行）

```
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

（標準出力に混じる `.envrc ...` テキストは `envrc-prompt.test.ts` の期待挙動であり、本タスクの実装と無関係。）

### Recommendations 反映ファイル + 行番号

| Rec | 内容 | 反映箇所 |
|-----|------|---------|
| R1-a | SESSION_IDLE ハンドラに assigning → running 保険 | `daemon.ts:1374-1382` |
| R1-b | SESSION_ACTIVE ハンドラに assigning → running 保険 | `daemon.ts:1273-1281` |
| R2-a | scanTasks task kind catch の assigning fallback | `daemon.ts:1664-1674` |
| R2-b | scanTasks 想定外例外の assigning fallback | `daemon.ts:1688-1696` |
| R3 | SESSION_CLEAR assigning 早期 return の配置（findConductor 直後・disconnected/starting 分岐の前） | `daemon.ts:1479-1490` |
| R4-a | SESSION_IDLE 保険テスト | `daemon.test.ts:2049-2069` |
| R4-b | SESSION_ACTIVE 保険テスト | `daemon.test.ts:2072-2092` |
| R4-c | `/clear` 送信失敗時の disconnected テスト | `daemon.test.ts:2144-2177` |
| R5 | dashboard `needsAnimation` に `assigning` を含める | `dashboard.tsx:1324` |

### L416 の物理削除確認（Sub-task 2 / Decision Log D5）

```bash
$ rg 'status = "running"' skills/cmux-team/manager/conductor.ts
(no matches)
```

conductor.ts 内に `status = "running"` は 1 箇所も残っていない（= impl-report の主張どおり物理削除済み、コメントアウト残存なし）。

### 新規テスト 9 本の詳細

| # | 場所 | テスト名 |
|---|------|---------|
| 1 | `conductor.test.ts:121` | assignTask 成功後に conductor.status === 'assigning'（running ではない） |
| 2 | `daemon.test.ts:1949` | assigning + SESSION_CLEAR → task-state.json は変更されず status も保持 |
| 3 | `daemon.test.ts:1991` | running + SESSION_CLEAR は従来通り task_aborted 記録（回帰防止） |
| 4 | `daemon.test.ts:2018` | assigning + SESSION_STARTED(source=clear) で running に遷移 / pid 更新 |
| 5 | `daemon.test.ts:2049` | R1: assigning + SESSION_IDLE(taskRunId あり) で running に遷移する |
| 6 | `daemon.test.ts:2072` | R1: assigning + SESSION_ACTIVE(taskRunId あり) で running に遷移する |
| 7 | `daemon.test.ts:2097` | assigning のまま 60 秒経過で disconnected に遷移する |
| 8 | `daemon.test.ts:2117` | assigning で 60 秒未満なら状態を維持（未 timeout） |
| 9 | `daemon.test.ts:2147` | cmux.send で例外 → AssignTaskError(conductor) → idleConductor.status === 'disconnected' |

---

## Fix Required

なし（Verdict: GO）。

## 備考

- 実装報告書の「83 tests pass」表記は daemon.test.ts + conductor.test.ts 合計 92 pass の誤記と思われる（Finding 1 の minor として記載）。実質的な挙動には影響しないため GO を変更しない。
- E2E での実機確認（`cmux-team start` 疎通）は本タスク範囲外（plan §5）。unit test 範囲内での網羅性は達成されている。
