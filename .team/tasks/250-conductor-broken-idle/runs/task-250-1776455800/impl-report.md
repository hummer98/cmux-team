# T250 実装レポート: Conductor broken status 導入

## 概要

A015「決定 2 項: エラーステートの保持」を実装した。`forceCloseDisconnectedConductor`
による **disconnect timeout → resetConductor → idle** の自動フォールバックを廃止し、
新 status `broken` を導入。確定した異常状態をユーザーが明示的に `clear-conductor`
でクリアするまで痕跡ごと保持する。

## Completed Tasks

全 15 サブタスクを計画書の順序通り完了した。

| # | サブタスク | 結果 |
|---|-----------|------|
| ST-1 | `schema.ts` に `"broken"` status を追加 | ✅ |
| ST-1.5 | `schema.ts` に `ConductorClearMessage` 型を新設（QueueMessage union に追加） | ✅ |
| ST-2 | `forceCloseDisconnectedConductor` を `resetConductor(opts={targetStatus:"broken"})` 呼び出しに縮退 | ✅ |
| ST-3 | SESSION_STARTED / ACTIVE / IDLE / CLEAR の 4 ハンドラに broken early-return ガード | ✅ |
| ST-4 | `monitorConductors` 先頭で broken を skip | ✅ |
| ST-5 | `scanTasks` の idle 検索は既存 `status==="idle"` で broken が自動除外されることを確認（コード変更なし） | ✅ |
| ST-6 | `initializeLayout` の team.json 復元で broken を保存 | ✅ |
| ST-7 | `resetConductor` に 4 引数目 `opts?: { targetStatus, reason }` を追加。ログを三項演算で 1 箇所に集約 | ✅ |
| ST-8A | `handleMessage` に `case "CONDUCTOR_CLEAR"` を新設（not_found / not_broken ガード + resetConductor 呼び出し + requestWakeup） | ✅ |
| ST-8B | `main.ts` に `cmdClearConductor` を新設（surface 正規化 + team.json ルックアップ + broken ガード + CONDUCTOR_CLEAR postMessage） | ✅ |
| ST-9 | `main.ts` dispatch switch に `case "clear-conductor"` を追加 | ✅ |
| ST-10 | `cmdStatus` の Conductor 行で broken を `⨯ BROKEN` と表示 | ✅ |
| ST-11 | `dashboard.tsx` に broken 行を追加（RED + ⨯ + 経過時間 + "use clear-conductor" ヒント）。ヘッダーに `${brokenCount} broken` を追加 | ✅ |
| ST-12 | `i18n.ts` の ja / en 両 dict に `help_clear_conductor` を追加 | ✅ |
| ST-13 | `daemon.test.ts` に broken 系テスト 14 本を追加（既存 test 3 の expects を broken 向けに改訂） | ✅ |
| ST-14 | `updateTeamJson` に `disconnectedAt` を永続化。restore 側にも `disconnectedAt` を追加。round-trip test を追加 | ✅ |
| ST-15 | `conductor.test.ts` に resetConductor opts の 3 テストを追加 | ✅ |

## Files Changed

| # | ファイル | 変更概要 |
|---|---------|----------|
| 1 | `skills/cmux-team/manager/schema.ts` | `ConductorState.status` union に `"broken"` を追加。`ConductorClearMessage` を新設し `QueueMessage` discriminated union に追加 |
| 2 | `skills/cmux-team/manager/daemon.ts` | (a) `forceCloseDisconnectedConductor` を resetConductor 1 行呼び出しに縮退（`{targetStatus:"broken", reason:"disconnect_timeout"}`）。(b) SESSION_STARTED / ACTIVE / IDLE / CLEAR 4 ハンドラに broken early-return ガード追加。(c) `monitorConductors` 先頭で broken skip。(d) `initializeLayout` の team.json 復元で broken 保持 + `disconnectedAt` 復元。(e) `handleMessage` に `CONDUCTOR_CLEAR` handler を新設。(f) `updateTeamJson` に `disconnectedAt` を永続化 |
| 3 | `skills/cmux-team/manager/conductor.ts` | `resetConductor` に 4 引数目 `opts?: { targetStatus?: "idle"\|"broken"; reason?: string }` を追加。`conductor.status = opts?.targetStatus ?? "idle"`。broken の場合のみ `disconnectedAt` を保持。ログは三項演算で `conductor_broken` / `conductor_reset` を 1 箇所集約 |
| 4 | `skills/cmux-team/manager/main.ts` | (a) `cmdClearConductor` を新設（CONDUCTOR_CLEAR を postMessage）。(b) dispatch switch に `case "clear-conductor"` を追加。(c) `cmdStatus` の Conductor 列挙で broken を `⨯ BROKEN` 表示 + 型 row に `status?: string` 追加 |
| 5 | `skills/cmux-team/manager/dashboard.tsx` | `isBroken` 分岐を追加（RED + ⨯ + `disconnectedAt` 経過時間 + "use clear-conductor" ヒント）。Conductor ヘッダーに `${brokenCount} broken` を追加 |
| 6 | `skills/cmux-team/manager/i18n.ts` | `help_clear_conductor` を ja / en 両 dict に追加 |
| 7 | `skills/cmux-team/manager/daemon.test.ts` | 既存 test "3. disconnect timeout で forced close" を broken 期待値に改訂。broken 関連 13 テスト追加: scanTasks 除外 1、SESSION_* 不変 7（STARTED x 4 source + ACTIVE + IDLE + CLEAR）、CONDUCTOR_CLEAR 5（broken→idle、idle 無視、running 無視、disconnected 無視、未登録 not_found）、team.json round-trip 1 |
| 8 | `skills/cmux-team/manager/conductor.test.ts` | `resetConductor` import 追加。opts テスト 3 本追加（opts 未指定 = idle デフォルト、opts.targetStatus="broken"、opts.targetStatus="idle" 明示指定） |

## TDD Cycles / Verification Results

### TDD サイクル

各 ST について、計画書の「完了条件」と「検証コマンド」を満たすサイクルを実施した:

- **RED**: 新規テストは broken 不変条件を記述。ST-13 test "disconnect timeout で forced close" の
  既存 assertion（`status === "idle"`, `disconnectedAt === undefined`）を `status === "broken"` /
  `disconnectedAt` 保持 / `state.conductors.has(surface)` に書き換えた時点で従来実装に対して
  fail することを確認。
- **GREEN**: ST-1/1.5/2/3/4/6/7/8A に沿って実装を追加し fail → pass を確認。
- **REFACTOR**: `resetConductor` の targetStatus フラグで 2 つの経路（idle/broken）の差分を
  最小化（disconnectedAt 保持・ログキー・sourceタグ のみ）。`log("conductor_broken", ...)` の
  重複記述を resetConductor 1 箇所に集約（Decision D12）。
- **VERIFY**: `bun test` / `bunx tsc --noEmit` を実行し、全テスト pass・0 型エラーを確認。

### 検証結果

#### `bun test`

```
 522 pass
 0 fail
 1184 expect() calls
Ran 522 tests across 23 files. [19.72s]
```

- ベースライン 505 pass → 522 pass (17 テスト追加)
- 内訳: daemon.test.ts 14 テスト追加（ST-13 の 13 + ST-14 の 1）、conductor.test.ts 3 テスト追加（ST-15）
- 既存テスト 1 件を broken 期待値に改訂（daemon.test.ts "3. disconnect timeout で forced close"）
- 0 fail

#### `bunx tsc --noEmit`

```
(0 errors)
```

- broken 追加・CONDUCTOR_CLEAR 追加による網羅漏れは発生しなかった
- `updateTeamJson` の `disconnectedAt` フィールド追加も型エラーなし

#### 計画書の検証コマンドチェック結果

| 項目 | コマンド | 期待 | 実測 |
|------|---------|------|------|
| ST-1 schema broken | `rg '"broken"' schema.ts` | ヒット | ✅ `status: ... \| "broken"` |
| ST-1.5 CONDUCTOR_CLEAR schema | `rg '"CONDUCTOR_CLEAR"' schema.ts` | ヒット | ✅ `z.literal("CONDUCTOR_CLEAR")` |
| ST-2 forceClose 直書きログ削除 | `rg 'log\("conductor_broken"' daemon.ts` | 0 件 | ✅ 0 件（daemon.ts にはコメントのみ、emit は conductor.ts のみ） |
| ST-2 resetConductor broken 呼び出し | `rg 'targetStatus: "broken"' daemon.ts` | 1 件 | ✅ 1 件（forceCloseDisconnectedConductor 内） |
| ST-3 session_event_ignored_broken | `rg 'session_event_ignored_broken' daemon.ts \| wc -l` | 4 件 | ✅ 4 件（4 ハンドラ） |
| ST-4 broken skip in monitorConductors | `rg 'status === "broken"' daemon.ts` | ヒット | ✅ monitorConductors / scan / restore / handler |
| ST-7 log("conductor_broken") 1 箇所集約 | `rg 'log\(.*"conductor_broken"' src \| rg -v test` | conductor.ts の 1 件 | ✅ conductor.ts:567 のみ |
| ST-8A case CONDUCTOR_CLEAR | `rg 'case "CONDUCTOR_CLEAR"' daemon.ts` | 1 件 | ✅ 1 件 |
| ST-8B cmdClearConductor in main | `rg 'cmdClearConductor' main.ts` | 定義 + dispatch | ✅ 定義 1 + dispatch 1 |
| ST-9 "clear-conductor" dispatch case | `rg 'clear-conductor' main.ts` | ヒット | ✅ `case "clear-conductor":` |
| ST-12 help_clear_conductor in i18n | `rg 'help_clear_conductor' i18n.ts \| wc -l` | 2 件 (ja/en) | ✅ 2 件 |

## Issues Encountered

### updateTeamJson / restoreConductors に disconnectedAt が無かった件

**発見経緯**: ST-14 の round-trip テストで「broken の disconnectedAt が team.json に永続化されて
いない」ため failing (1 件)。

**原因**: 従来の `updateTeamJson` は `disconnectedAt` を出力しておらず、broken が一時的な in-memory
状態として設計されていた。broken 導入後は「daemon 再起動を挟んでも経過時間が表示できる」ことが
要件（plan ST-14 の期待値）。

**対応**:
- `updateTeamJson` の conductor シリアライズに `disconnectedAt: c.disconnectedAt` を追加
- `initializeLayout` の restore 側に `disconnectedAt: c.disconnectedAt` を追加

**影響範囲**: 計画「3. 変更対象」の表に明記されていなかったが、ST-14 の plan 擬似コードで
`disconnectedAt` 保持が expected として書かれており、実質必要な対応。scope out しても broken
要件を満たせないため本タスク内で対応した。

### 他の issue なし

- 型エラー: 発生せず（tsc 0 errors）
- 既存テスト破壊: 1 件のみ（"3. disconnect timeout で forced close"）だが計画書 ST-13 (1) で
  明示的に期待値を broken 向けに改訂する指示あり → 対応済み
- 計画スコープ外変更: 無し。計画書 ST-1〜15 の範囲内のみ変更

## 計画との差分

### 計画に明記されていなかったが実装した変更

1. **`updateTeamJson` に `disconnectedAt` を永続化**（上記 Issues 参照）。
2. **`initializeLayout` restore に `disconnectedAt` を復元**（上記 Issues 参照）。

いずれも plan ST-14 の expected 挙動から必須で、scope 内と判断して対応した。

### 計画通りに実装した変更

上記以外は全て計画書 ST-1〜15 の指示に厳密に従った。Decision Log D1〜D13（CONDUCTOR_CLEAR 新設、
opts 1 本化、ログ 1 箇所集約、broken の state 残存、SESSION_* early-return 等）も全て遵守。

## 手動 E2E 検証（本タスク外）

本リポジトリでは自動テストで broken の状態遷移・CONDUCTOR_CLEAR 経路・team.json round-trip
を検証済み。実環境（cmux 起動済み）での手動 E2E（PID kill → `⨯ BROKEN` 表示 →
`clear-conductor` → idle 復帰）は本タスク外とする（計画書「5.5 テスト戦略」参照）。
