# T175 Implementation Report

## Completed Tasks

- サブタスク 1: `proxy.ts:/master-state` に `notifyStateChanged` + `master_state` ログを追加
- サブタスク 2: `cmdLaunchMaster` で `resolveCallerSurfaceOrExit` → `CMUX_SURFACE` を defensive 設定 + `master_spawn_surface` ログ
- サブタスク 3: `generateMasterSettings` に `SessionStart` / `SessionEnd` hook を追加
- サブタスク 4: `main.test.ts` に Master SessionStart/SessionEnd hook の構造テストを追加
- サブタスク 5: `proxy.test.ts` に `/master-state` の `notifyStateChanged` + log 検証テストを追加
- サブタスク 6: 手動 E2E 検証 → **Implementer では未実行**（「Manual E2E Verification (deferred)」参照）

## Files Changed

- `skills/cmux-team/manager/proxy.ts`:
  - `eventBus` から `notifyStateChanged` を import
  - `/master-state` ハンドラ内で state 書き換え直後に `notifyStateChanged("proxy.ts:/master-state:<busy|idle|prompt>")` を呼ぶ
  - 受信時に `log("master_state", "status=<...> prompt=<40字トリム>")` を 1 行出力
- `skills/cmux-team/manager/main.ts`:
  - `generateMasterSettings` の `hooks` に `SessionStart` (matcher `""`) と `SessionEnd` (matcher `logout|prompt_input_exit|other`) を追加
    - command 文字列は Conductor の同 hook と完全一致（`cmux-team send SESSION_{STARTED,ENDED} --from-stdin --surface "${CMUX_SURFACE}" --pid "$PPID"`）
    - Master は `/clear` でセッション継続するため SessionEnd matcher に `clear` を含めない（D2）
  - `cmdLaunchMaster` 冒頭で `const surface = await resolveCallerSurfaceOrExit()` を呼び、`process.env.CMUX_SURFACE = surface` を defensive 設定
  - `master_spawn_surface U[...]` ログを追加
- `skills/cmux-team/manager/main.test.ts`:
  - `describe("generateMasterSettings (T211)")` 内に T175 用テスト 4 件追加
    - SessionStart hook が `cmux-team send SESSION_STARTED --from-stdin` + `${CMUX_SURFACE}` + `$PPID` を含む
    - SessionEnd hook の matcher が `logout|prompt_input_exit|other` 完全一致 + `cmux-team send SESSION_ENDED --from-stdin`
    - SessionEnd matcher に `clear` を含まない（D2 regression guard）
    - 既存 UserPromptSubmit / Stop hook は残る（regression guard）
- `skills/cmux-team/manager/proxy.test.ts`:
  - `describe("POST /master-state (T175)")` を新規追加、テスト 5 件
    - `status=busy` で `masterStatus="running"` + `masterPrompt` 設定 + `notifyStateChanged` 発火
    - `status=idle` で `masterStatus="idle"` + `masterPrompt=undefined` + `notifyStateChanged` 発火
    - `manager.log` に `master_state status=busy prompt=<...>` が 1 行以上記録される
    - prompt のみ更新でも `notifyStateChanged` が呼ばれる
    - `/master-state` ハンドラ呼び出しで bus リスナー数が増えない（副作用なし）

## TDD Cycles / Verification Results

### サブタスク 4 & 5 の RED

- **サブタスク 4 (main.test.ts T175 hook テスト)** — 実装前に先に追加した 2 ケース:
  - `settings.hooks.SessionStart` が `Array.isArray` → `Received: false` で FAIL
  - `settings.hooks.SessionEnd` が `Array.isArray` → `Received: false` で FAIL
  - 想定通りの RED（`generateMasterSettings` に SessionStart/SessionEnd が未定義）
- **サブタスク 5 (proxy.test.ts T175 /master-state テスト)** — 実装前に先に追加した 4 ケース:
  - `emitCount >= 1` → `Received: 0` で FAIL（notifyStateChanged 未実装）
  - `master_state` ログ検索 → `ENOENT no such file or directory` で FAIL（ログ未出力）
  - 想定通りの RED

### GREEN（実装）

- サブタスク 1 実装後 → `bun test proxy.test.ts -t "T175"` : **5 pass / 0 fail / 16 expect**
- サブタスク 3 実装後 → `bun test main.test.ts -t "T175"` : **4 pass / 0 fail / 25 expect**

### VERIFY（全テスト + 型チェック）

- `bun test main.test.ts proxy.test.ts` : **125 pass / 0 fail / 316 expect**
- `bun test` (manager 全件) : **377 pass / 0 fail / 815 expect**
- `bunx tsc --noEmit --project skills/cmux-team/manager` : **exit 0（型エラー 0）**

## Type Check Results

```
$ bunx tsc --noEmit --project skills/cmux-team/manager; echo "EXIT=$?"
EXIT=0
```

変更対象ファイル群（proxy.ts / main.ts / main.test.ts / proxy.test.ts）に型エラー無し。既存型エラーも発生していない。

## 完了条件の定量チェック

```
$ rg -c "notifyStateChanged.*master-state" skills/cmux-team/manager/proxy.ts
3
$ rg -c 'log\("master_state"' skills/cmux-team/manager/proxy.ts
1
```

- plan.md サブタスク 1「完了条件: `notifyStateChanged.*master-state` が 3 以上」→ **3 で達成**
- plan.md サブタスク 1「完了条件: `log("master_state"` が 1 行ヒット」→ **1 で達成**
- `cmdLaunchMaster` (main.ts:1736-1748) で `CMUX_SURFACE` を defensive 設定 + `master_spawn_surface` ログ → **達成**
- `generateMasterSettings` 内に SessionStart / SessionEnd hook → **達成**

## Manual E2E Verification (deferred)

plan.md サブタスク 6 は **手動 E2E 検証** のため Implementer では実行しない。Conductor / ユーザー側で以下を実施すること（手順は plan.md §4 サブタスク 6 より転記）。

### 対象

`cmux-team start` で起動した実セッション（この worktree ではなく `/Users/yamamoto/git/cmux-team/` 本体。ただしリリース後に実施するのが筋）。

### 手順

1. `cmux-team stop && cmux-team start` で daemon と Master を再起動
2. Master セッションに長めのプロンプトを送信（例: 「リサーチ用に 10 個のアイデアを書き出して」）
3. 送信直後 〜 応答完了までの間に TUI ダッシュボードを目視:
   - Master セクションが `▖ ▘ ▝ ▗` 系スピナーに切り替わる
   - 横に `masterPrompt`（40 字程度）が表示される
4. 応答完了後、Master セクションが `● [<num>]`（緑円）に戻る
5. `tail -f .team/logs/manager.log` で以下の 4 行が時系列に出ることを確認:
   - `master_session_started U[<num>] pid=<pid>`（起動時）
   - `master_state status=busy prompt=<...>`（UserPromptSubmit hook）
   - `master_state status=idle`（Stop hook）
   - （Master を kill した場合）`master_session_ended U[<num>] pid=<pid> reason=pid_watcher`

### 完了条件

- 上記 4 ログが揃う
- TUI スピナーが目視で動作

## Issues Encountered

無し。plan.md の想定通りに RED → GREEN → VERIFY が 1 パスで完了した。

補足:

- plan.md §「サブタスク 1」の `eventBus.ts` → `logger.ts` への import が無いことの確認について、実際には `eventBus.ts` は `logger.ts` を import している（`import { log } from "./logger";`）。ただし `logger.ts` は `eventBus.ts` を import していないため循環依存は発生しない（proxy.ts → eventBus.ts → logger.ts の単方向）。plan 記述の前提は事実と一致しないが、結論（循環依存なし）は満たされる。
