# Inspection Report: T195

## Verdict

**GO**

## Summary

T195 の PID ベース監視移行は plan §4 の Step 1–12 がすべてコードに反映され、`bun test` (248 pass / 0 fail) と `bunx tsc --noEmit` が green。plan §5 の named export + `__testSpawn*PidWatcherTick` による同期テスト戦略、plan §3 D3.1 の Master resume pid 復元、SESSION_CLEAR 3 分岐、spawnAgentPidWatcher の冪等性、docs 7 ファイル + CHANGELOG 同期のいずれも実コードで確認済み。CHANGELOG の Agent hook 記述に軽微な文言ドリフトがあるが機能的には等価で blocking ではない。

## Completion Criteria Check（plan §9 の 10 項目）

| # | 条件 | 結果 | 検証コマンド / 根拠 |
|---|---|---|---|
| 1 | `cmux.tree` / `await tree` grep が `getPaneForSurface` / `getPaneIdForSurface` 以外空 | ✅ | `grep -rn "cmux.tree\|await tree" skills/cmux-team/manager --include="*.ts" \| grep -v "\.test\.ts" \| grep -v "getPaneForSurface" \| grep -v "getPaneIdForSurface"` → 0 件 |
| 2 | `validateSurface` grep が空 | ✅ | `grep -rn "validateSurface" skills/cmux-team/manager --include="*.ts"` → 0 件（main.ts:1499 に「T195: validateSurface 削除」コメントのみ） |
| 3 | `isMasterAlive` は master.ts 定義 + daemon.ts の startMaster 呼び出しのみ | ✅ | `master.ts:50` (定義) / `daemon.ts:16` (import) / `daemon.ts:477` (呼び出し)。引数は `projectRoot` |
| 4 | `master.ts` に `cmux.isAlive` + team.json 読み込み実装あり | ✅ | `master.ts:50-61` で `.team/team.json` を読み `cmux.isAlive(master.pid)` を返却 |
| 5 | `cmux list-status` がドキュメント/テンプレから撤廃（注記付き歴史記録のみ可） | ✅ | `grep -rn "list-status" CLAUDE.md skills/cmux-team/SKILL.md docs/spec/ skills/cmux-team/templates/` → `CLAUDE.md:436` の T195 撤廃注記 1 行のみ |
| 6 | `UNRESPONSIVE_MAX` / `treeFailureCount` / `treeFailureFirstAt` / `cmux_unresponsive` grep が空 | ✅ | `grep -rn "UNRESPONSIVE_MAX\|treeFailureCount\|treeFailureFirstAt\|cmux_unresponsive" skills/cmux-team/manager --include="*.ts"` → 0 件 |
| 7 | `bun test` が green | ✅ | `cd skills/cmux-team/manager && bun test` → **248 pass / 0 fail / 486 expect() calls / 14 files / 8.06s** |
| 8 | 手動 smoke（kill -9 / /clear / Agent kill / Manager 再起動） | ⚠️ 範囲外 | Inspector 検品範囲外。impl-report §5 で明示的にリリース直前マニュアル検証へ委譲されている |
| 9 | CHANGELOG `[3.47.0]` に 2 項目以上 | ✅ | `[3.47.0] - 2026-04-16` に Breaking 5 項目 + Changed 2 項目 |
| 10 | docs 7 ファイル同期済み | ✅ | CLAUDE.md / SKILL.md / spec 01,04 / templates ja,en / requirements.md / fixed-layout-conductor-reuse.md すべて差分あり |

追加: `bunx tsc --noEmit` → **exit 0（型エラーなし）**

## Plan との整合性

### §4 Step 1–12

| Step | 実装箇所 | 確認 |
|---|---|---|
| 1. schema: AgentState.pid / DaemonState.masterPid / treeFailure* 削除 | `schema.ts:39-45, 145-153, 157-170` | ✅ |
| 2. cmux.ts: isAlive / __setIsAliveImpl / validateSurface 削除 | `cmux.ts:175-190`、旧 validateSurface は削除済 | ✅ |
| 3. master.ts: isMasterAlive を pid ベースに | `master.ts:50-61` | ✅ |
| 3b. daemon.ts: startMaster で team.json pid を復元 | `daemon.ts:457-511` | ✅（`master_restored` ログ + `spawnMasterPidWatcher` 起動あり） |
| 4. monitorConductors 縮減 | `daemon.ts:1437-1471`（starting/disconnected timeout のみ） | ✅ |
| 5. SESSION_STARTED: pid 受け取り + watcher spawn（Master/Conductor/Agent 全経路） | `daemon.ts:736-790` | ✅ |
| 6. SESSION_CLEAR: pid クリア（3 分岐） | `daemon.ts:1075-1113` | ✅（running-reset 分岐で `conductor.pid = undefined` + `pidWatcherInterval` クリア） |
| 7. spawnPidWatcher / spawnAgentPidWatcher / spawnMasterPidWatcher の tick body 抽出 | `daemon.ts:1277-1408` | ✅（`__testSpawn*PidWatcherTick` named export あり） |
| 8. main.ts: spawn-agent/send-agent の validateSurface 削除 + pid 読み込み | `main.ts:1499-1500, 1788-1816` | ✅（send-agent は 200ms × 3 retry で team.json から agent.pid を読む） |
| 9. Agent SessionStart hook 生成 | `main.ts:1066-1112` → `.team/prompts/<surface>-agent-settings.json` に `cmux-team send SESSION_STARTED --surface "${surface}" --pid "$PPID"` | ✅ |
| 10. updateTeamJson に pid 永続化 | `daemon.ts:1550-1594` | ✅ |
| 11. テスト追加 | `daemon.test.ts`（crashed→disconnected 遷移 / spawnAgentPidWatcher tick / SESSION_CLEAR pid reset / Agent SESSION_STARTED）、`cmux.test.ts`（isAlive） | ✅ |
| 12. docs 同期 | 7 ファイル + CHANGELOG | ✅ |

### §5 テスト戦略（named export + fake timer 統一）

- `__setIsAliveImpl(fn | null)` が `cmux.ts:175-180` に named export として存在
- `__testSpawnPidWatcherTick` / `__testSpawnAgentPidWatcherTick` / `__testSpawnMasterPidWatcherTick` が `daemon.ts` に named export として存在
- `daemon.test.ts` の新規テストは real timer 不要（tick body を同期的に呼び出す）で、fake timer との競合なし

### §3 Blocking 対応

- **D3.1 Master resume pid 化**: `daemon.ts:457-511` で team.json の master.pid を読み、生存時は新規 spawn せず `state.masterPid` 復元 + `spawnMasterPidWatcher` を起動。失敗時は従来の spawn にフォールバック。
- **startMaster の pid 復元（旧 daemon.ts:466）**: 上記と同一経路で解決。
- **`isMasterAlive` の workspace → projectRoot 切り替え**: `master.ts:50`、`daemon.ts:477` 両方で整合。

## Non-blocking Findings

1. **CHANGELOG の Agent hook 記述にドリフト**
   - CHANGELOG: `.claude/settings.json` の Agent SessionStart に `cmux-team send SESSION_STARTED --pid "$PPID" --surface "$CMUX_SURFACE" --conductor-surface "$CMUX_CONDUCTOR_SURFACE" --role "$CMUX_ROLE"` を登録、と記述
   - 実装: `main.ts:generateAgentSettings` が `.team/prompts/<surface>-agent-settings.json` に `cmux-team send SESSION_STARTED --surface "${surface}" --pid "$PPID"` のみを書き出し、Agent に `--settings` 経由で渡す
   - 機能的には等価（どちらでも pid が daemon に push される）で blocking ではないが、リリース前に CHANGELOG 文言を実装に合わせて修正すると正確。
2. **plan §9 criterion 8（手動 smoke）は未実施**
   - 本タスクの検品範囲外（impl-report §5 が明記）。リリース前に kill -9 / /clear / Agent kill / Manager 再起動の 4 シナリオを実機で確認することを推奨。
3. **package-lock.json の差分**
   - version のみ 3.45.0 → 3.46.0 のバンプで、dependency 追加・削除なし。問題なし。

## Fix Required

N/A（GO 判定）

## Verification Performed

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-195-1776202229

# A. cmux.tree 残存チェック
grep -rn "cmux.tree\|await tree" skills/cmux-team/manager --include="*.ts" \
  | grep -v "\.test\.ts" \
  | grep -v "getPaneForSurface" \
  | grep -v "getPaneIdForSurface"
# → 0 件

# B. validateSurface 残存
grep -rn "validateSurface" skills/cmux-team/manager --include="*.ts"
# → main.ts:1499 に「// T195: validateSurface 削除」コメント 1 件のみ（呼び出し 0 件）

# C. list-status 残存
grep -rn "list-status" CLAUDE.md skills/cmux-team/SKILL.md docs/spec/ skills/cmux-team/templates/
# → CLAUDE.md:436 の T195 撤廃注記 1 件のみ

# D. 旧監視フィールド残存
grep -rn "UNRESPONSIVE_MAX\|treeFailureCount\|treeFailureFirstAt\|cmux_unresponsive" \
  skills/cmux-team/manager --include="*.ts"
# → 0 件

# E. bun test
cd skills/cmux-team/manager && bun test 2>&1 | tail -30
# → 248 pass / 0 fail / 486 expect() calls / 14 files / 8.06s

# F. 型チェック
bunx tsc --noEmit
# → exit 0（エラーなし）

# G. plan § Blocking コード確認
#   - daemon.ts:457-511 (startMaster + isMasterAlive 経路)
#   - daemon.ts:1075-1113 (SESSION_CLEAR 3 分岐)
#   - daemon.ts:1277-1408 (__testSpawn*PidWatcherTick named export)
#   - daemon.ts:1334-1341 (spawnAgentPidWatcher findIndex === -1 → "noop")
#   - main.ts:1066-1112 (Agent SessionStart hook 生成)
#   - main.ts:1788-1816 (send-agent の pid 読み込み 200ms × 3 retry)
#   - schema.ts:39-45, 145-170 (AgentState.pid / masterPid / treeFailure* 削除)
#   - CHANGELOG.md [3.47.0] - 2026-04-16
```

すべての機械チェック + コードレビューで GO 判定。
