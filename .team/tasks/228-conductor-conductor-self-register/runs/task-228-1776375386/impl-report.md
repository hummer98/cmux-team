# T228 実装レポート: Conductor self-register 方式への移行

worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-228-1776375386`

## Completed Tasks

1. **S1: `registerSelfAsConductor` ヘルパーを追加**
   `skills/cmux-team/manager/main.ts` の `postMessage` 直後に追加。`resolveProxyPort()` で proxy 生存確認し、不在 / POST 失敗時はいずれも `console.error` + `process.exit(1)` の fail-fast。proxy-port 破損ケースの案内（「`.team/proxy-port` を削除して `cmux-team start` をやり直してください」）もエラーメッセージに含めた。成功時は `conductor_self_register` ログ。

2. **S2: `cmdConductor` に self-register を組み込み**
   `resolveCallerSurfaceOrExit()` の直後、main-branch 解決より前に `await registerSelfAsConductor(surface)` を挿入。コメントで T228 であることを明示。

3. **S3: `cmdResume` にも self-register を組み込み**
   同じく `resolveCallerSurfaceOrExit()` の直後に挿入。daemon 側の idempotent merge により、resume 時に `initializeConductorSlots` が pre-set した taskId/taskRunId/worktreePath が破壊されない旨のコメントを付記。

4. **S4: `launchConductor` から HTTP POST ブロックを削除**
   `skills/cmux-team/manager/conductor.ts` の 87-102 行の try/catch ブロックを削除し、連番コメント「1. 環境変数 / 2. Claude 起動 / 3. タブ名設定」に繰り上げ。JSDoc から「CONDUCTOR_REGISTERED を HTTP API 経由で daemon に送信」を削除し、「T228: 登録は `cmdConductor` / `cmdResume` の self-register に委譲」へ書き換え。

5. **S5: daemon `CONDUCTOR_REGISTERED` ハンドラを idempotent merge 化**
   `daemon.ts:911-` のハンドラで:
   - 既存 state があれば早期 return + `conductor_register_skipped` ログ（`existing_status` / `existing_pid` 付き）
   - `state.conductors.size >= state.maxConductors` 超過新規登録で `conductor_register_over_cap` warning を先に出してから登録続行（soft cap）
   `daemon.test.ts` 末尾に `describe("handleMessage: CONDUCTOR_REGISTERED (T228)")` を追加し 3 ケースをカバー。

6. **S6: `initializeConductorSlots` の非 resume 分岐を削除（resume 分岐は保持）**
   `conductor.ts` のフォールバックループを、`resumeItem` が存在する場合のみ `conductors.set(..., status: "running", taskId, ...)` を実行するよう書き換え。ログイベント名を `conductor_registered_fallback` → `conductor_resume_prepopulated` に改名。コメントも D4 に沿って書き換えた（非 resume 分岐は self-register に委譲）。

7. **S7: 型チェック + ユニットテスト通過**
   - `cd skills/cmux-team/manager && bunx tsc --noEmit` → exit 0（追加エラー 0）
   - `bun test daemon.test.ts` → 76 pass / 0 fail
   - `bun test`（全テスト） → 390 pass / 0 fail

8. **S8: ドキュメント更新**
   - `docs/spec/01-skill-cmux-team.md` の `cmux-team conductor` / `cmux-team resume` 行に self-register の説明を追記
   - `docs/spec/05-install-and-infrastructure.md` のメッセージング節に「CONDUCTOR_REGISTERED は Conductor 実行プロセス自身が POST する self-register 方式」「idempotent merge（既存 skip）」「soft cap」を追記

## Files Changed

| ファイル | 変更概要 |
|---------|---------|
| `skills/cmux-team/manager/main.ts` | `registerSelfAsConductor` ヘルパー追加（`postMessage` 直後）。`cmdConductor` / `cmdResume` の `resolveCallerSurfaceOrExit` 直後に `await registerSelfAsConductor(surface)` を挿入 |
| `skills/cmux-team/manager/conductor.ts` | `launchConductor` から `CONDUCTOR_REGISTERED` POST ブロック削除・連番コメント繰り上げ・JSDoc 更新。`initializeConductorSlots` の fallback ループから非 resume 分岐を削除し、ログイベント名を `conductor_resume_prepopulated` に改名 |
| `skills/cmux-team/manager/daemon.ts` | `CONDUCTOR_REGISTERED` ハンドラを idempotent merge 化（既存 skip + `existing_status` / `existing_pid` ログ、soft cap 超過 warning） |
| `skills/cmux-team/manager/daemon.test.ts` | `describe("handleMessage: CONDUCTOR_REGISTERED (T228)")` を新規追加し 3 ケースを実装（新規登録 / 既存 skip / soft cap 超過） |
| `docs/spec/01-skill-cmux-team.md` | `cmux-team conductor` / `cmux-team resume` 行に self-register 説明追記 |
| `docs/spec/05-install-and-infrastructure.md` | メッセージング節に self-register / idempotent merge / soft cap を記述 |

## TDD Cycles / Verification Results

### 検証コマンド結果

| 検証 | コマンド | 結果 |
|------|---------|------|
| S1 関数定義 | `grep -n "registerSelfAsConductor" skills/cmux-team/manager/main.ts` | 1134 (定義), 1653 (cmdConductor), 1738 (cmdResume) |
| S1 proxy-port 破損案内 | `grep -n 'proxy-port.*を削除' skills/cmux-team/manager/main.ts` | 1142: `壊れた proxy-port ファイルの場合は \`.team/proxy-port\` を削除して \`cmux-team start\` をやり直してください。` |
| S2 cmdConductor | `sed -n '1645,1670p' main.ts \| grep registerSelfAsConductor` | 1 件 |
| S3 cmdResume | `sed -n '1720,1745p' main.ts \| grep registerSelfAsConductor` | 1 件 |
| S4 conductor.ts POST 削除 | `grep -c "CONDUCTOR_REGISTERED" conductor.ts` | 1（コメント内の参照のみ。`launchConductor` 本体の POST ブロックは削除済み） |
| S5 daemon ログイベント | `grep -n "conductor_register_skipped\|conductor_register_over_cap" daemon.ts` | 918: `conductor_register_skipped`, 928: `conductor_register_over_cap` |
| S5 daemon.test.ts | `grep -c "CONDUCTOR_REGISTERED" daemon.test.ts` | 4（>= 3 を満たす） |
| S6 fallback 削除 | `grep -c "conductor_registered_fallback" conductor.ts` | 0 |
| S6 resume prepopulated | `grep -n "conductor_resume_prepopulated" conductor.ts` | 233 |
| S6 starting 不在確認 | `grep -cE '^\s*status: "starting"' conductor.ts` | 0（fallback 削除により conductor.ts 内で status: "starting" を set する箇所なし） |
| S8 docs | `grep -n "self-register\|self register" docs/spec/*.md` | 01-skill: 85, 90 / 05-install: 227 |

### テスト結果

```
$ cd skills/cmux-team/manager && bun test daemon.test.ts
76 pass
0 fail
203 expect() calls
Ran 76 tests across 1 file. [2.53s]

$ bun test
390 pass
0 fail
858 expect() calls
Ran 390 tests across 18 files. [9.83s]
```

新規 3 ケース（全 pass）:

1. **新規 surface 登録**: `CONDUCTOR_REGISTERED` → `state.conductors` に set され `status=starting` / `agents=[]` / `startedAt=message.timestamp` になることを検証。`manager.log` に `conductor_registered` が記録されることも確認。
2. **既存 skip**: 事前に `running` + `taskId` + `agents` を持つ conductor を登録 → 同 surface で再度 `CONDUCTOR_REGISTERED`。既存の `status/taskId/taskRunId/taskTitle/worktreePath/agents/pid` が破壊されないこと、skip ログに `reason=already_registered existing_status=running existing_pid=12345` が含まれることを検証。
3. **soft cap 超過**: `state.maxConductors=3` に 3 件登録済みで 4 件目を POST → `state.conductors.size=4` に増えること（登録成功）、および `conductor_register_over_cap current=3 max=3` warning が記録されることを検証。

### 型チェック

```
$ bunx tsc --noEmit
exit=0
```

追加エラー 0 件。既存エラーも 0 件（計画書「既存型エラーの先読み」で確認済みの状態を維持）。

## Issues Encountered

- `grep -c "CONDUCTOR_REGISTERED" skills/cmux-team/manager/conductor.ts` が期待値 0 ではなく 1 になった。内訳を確認したところ、S6 で追加した D4 コメント（「非 resume 分岐は self-register (cmdConductor → CONDUCTOR_REGISTERED POST) に 委譲したため削除」）内の 1 件で、計画書の S6 コメント記述例に沿った正当な参照。`launchConductor` 本体の POST ブロックは削除済み（計画書の S4 完了条件「`launchConductor` 内に `CONDUCTOR_REGISTERED` 文字列が存在しない」を満たす）。S6 のコメント自体が計画書にあるため、この 1 件は仕様どおり。
- その他、実装中に計画書との乖離・予期せぬブロッカーは発生しなかった。
