# T195 Summary: PID ベース監視への全面移行 + docs 同期

- **マージコミット**: `91ed327` (main への ff merge, no-ff)
- **実装コミット**: `6e44637 feat(manager): migrate Conductor/Agent/Master liveness to PID-based (T195)`
- **worktree**: `/Users/yamamoto/git/cmux-team/.worktrees/task-195-1776202229`（マージ後に削除）
- **ブランチ**: `task-195-1776202229/task`（マージ後に削除）
- **タスクブランチ版数**: v3.47.0

## 完了したサブタスク

| Phase | Agent | Surface | 結果 |
|---|---|---|---|
| 1. Plan | Planner | surface:70 | plan.md 766 行作成（9m 28s） |
| 2. Design Review | Design Reviewer | surface:74 | Changes Requested（Blocking 3 + Non-blocking 7, 6m 21s） |
| 2.1 Plan rev2 | Planner | surface:84 | plan.md 931 行に更新（Pollinating 5m 50s） |
| 2.2 Design Review rev2 | Design Reviewer | surface:88 | **Approved**（Cooked 2m 54s） |
| 3. Implementation | Implementer | surface:91 | 248 pass / 0 fail, 18 files changed（Worked 23m 11s） |
| 4. Inspection | Inspector | surface:102 | **GO**（Crunched 7m 16s） |

Phase 2 でレビューが 1 往復発生（最大 2 往復の範囲内）。Phase 3/4 は一発クリア。

## 変更ファイル（18）

### プロダクションコード（6）
- `skills/cmux-team/manager/cmux.ts`（+75/-?）: `isAlive(pid)` 追加、`validateSurface` 系削除
- `skills/cmux-team/manager/daemon.ts`（+213/-213）: `monitorConductors` 縮減、`startMaster` PID 復元、`__testSpawn*PidWatcherTick` 抽出
- `skills/cmux-team/manager/master.ts`（+28/-?）: `isMasterAlive(projectRoot)` 化
- `skills/cmux-team/manager/main.ts`（+44/-?）: SESSION_STARTED の pid 必須化、spawn-agent/send-agent の pid 検証
- `skills/cmux-team/manager/schema.ts`（+8/-?）: `AgentState.pid` / `DaemonState.masterPid` 追加、`treeFailureCount` 削除
- `skills/cmux-team/manager/conductor.ts`（-14）: dead code `isConductorAlive` 削除

### テスト（2）
- `skills/cmux-team/manager/daemon.test.ts`（+334/-?）: PID watcher tick 単体テスト追加
- `skills/cmux-team/manager/cmux.test.ts`（-144）: 旧 `validateSurface` テスト削除、`isAlive` テスト追加

### docs（8）
- `CLAUDE.md`, `skills/cmux-team/SKILL.md`, `docs/spec/01-skill-cmux-team.md`, `docs/spec/04-templates.md`
- `skills/cmux-team/templates/ja/conductor.md`, `skills/cmux-team/templates/en/conductor.md`
- `.team/specs/requirements.md`, `.team/specs/fixed-layout-conductor-reuse.md`

### その他（2）
- `CHANGELOG.md`: v3.47.0 セクション追加（Changed Breaking 5 + Changed 2）
- `package-lock.json`: 3.45.0 → 3.46.0（bootstrap sync）

## テスト結果

- `bun test`: **248 pass / 0 fail** / 486 expect() calls / 14 files / 8.16s
- `bunx tsc --noEmit`: エラーなし
- 完了条件 10 項目: 1-7, 9-10 ✅、8（手動 smoke）は実機検証範囲外

## 検品結果（Inspector GO 判定）

plan §9 の機械チェックはすべて green:
- `cmux.tree` 残存は `getPaneForSurface` / `getPaneIdForSurface` のみ
- `validateSurface` 呼び出し 0 件
- `UNRESPONSIVE_MAX | treeFailureCount | treeFailureFirstAt | cmux_unresponsive` 0 件
- `list-status` 残存は CLAUDE.md の注記付き歴史記録 1 行のみ

Non-blocking finding: CHANGELOG の Agent hook 記述に軽微な文言ドリフト（機能等価、修正見送り）。

## 既知の残件（後続タスク）

- 手動 smoke テスト（kill -9 / /clear / Agent kill / Manager 再起動）は実機シナリオ必要
- upstream cmux #2586 へのコメント追記（範囲外）
- proxy trace による「ハング中 Claude」検出強化（別タスク）
- `cmux read-screen` の Trust 確認検出経路は依然 deadlock リスク（将来タスク）
- Manager 再起動直後の PID 衝突微小リスク（CHANGELOG に明記、`cmux-team stop && start` で回避）

## 補足: 現行 daemon v3.46.0 がタスク遂行中に deadlock

Inspector spawn 時に `validate_surface_failed` で `cmux tree --workspace workspace:9` がタイムアウトし、spawn-agent が 1 回失敗した。まさにこのタスクで修正対象にしている deadlock を現行 daemon が踏んだもの。surface:100 を手動 close してリトライで回復。本 PR を適用すればこの現象は解消する。
