# T283 Implementer Fix Round レポート

Inspector レポートで指摘された minor 2 件の修正を完了。

## Finding 1: CLAUDE.md のログイベントテーブルが実装と乖離

### 実装確認

`skills/cmux-team/manager/main.ts:2739-2783` の `runSyncCheckOrExit` 内 log 呼び出しを確認:

```ts
// L2739
log("ready_force_bypass",
    `phase=${opts.phase}${opts.taskId ? ` task_id=${opts.taskId}` : ""}`);

// L2747
log("ready_sync_skipped",
    `phase=${opts.phase} reason=env${opts.taskId ? ` task_id=${opts.taskId}` : ""}`);

// L2757
log("ready_sync_skipped",
    `phase=${opts.phase} reason=no_main_branch${opts.taskId ? ` task_id=${opts.taskId}` : ""}`);

// L2771
log("ready_rejected",
    `phase=${opts.phase} state=${result.state}${taskIdField}`);

// L2779
log("ready_warning",
    `phase=${opts.phase} state=${result.state}${taskIdField}`);
```

実装は **key 順序: `phase` → `state`/`reason` → `task_id`**、かつ `state=<state>`（`sync_state=<state>` ではない）、`ready_sync_skipped` は `reason=<env|no_main_branch>` を含む。

### CLAUDE.md 修正（`CLAUDE.md:673-676`）

**変更前:**

```markdown
| `ready_rejected` | reject state で exit 1 | `task_id=<NNN>` `phase=<create\|update>` `sync_state=<state>` |
| `ready_warning` | warn state で継続 | `task_id=<NNN>` `phase=<create\|update>` `sync_state=<state>` |
| `ready_force_bypass` | `--force` で bypass | `task_id=<NNN>` `phase=<create\|update>` |
| `ready_sync_skipped` | `CMUX_TEAM_SKIP_SYNC_CHECK=1` で skip | `task_id=<NNN>` `phase=<create\|update>` |
```

**変更後:**

```markdown
| `ready_rejected` | reject state で exit 1 | `phase=<create\|update>` `state=<state>` `task_id=<NNN>` |
| `ready_warning` | warn state で継続 | `phase=<create\|update>` `state=<state>` `task_id=<NNN>` |
| `ready_force_bypass` | `--force` で bypass | `phase=<create\|update>` `task_id=<NNN>` |
| `ready_sync_skipped` | env / config で skip | `phase=<create\|update>` `reason=<env\|no_main_branch>` `task_id=<NNN>` |
```

修正ポイント:
1. `sync_state=` → `state=`（実装に合わせる）
2. `ready_sync_skipped` に `reason=<env|no_main_branch>` を追記（実装は必ず emit）
3. `ready_sync_skipped` の契機列を「`CMUX_TEAM_SKIP_SYNC_CHECK=1` で skip」→「env / config で skip」に書き換え（env と no_main_branch の 2 経路を両方カバー）
4. key 順序を実装に合わせ `phase` → `state`/`reason` → `task_id` に統一（prompt diff は 3 行のみ指示していたが、`ready_force_bypass` も同様に実装と不一致だったため truth=実装原則に従い 4 行全て修正）

## Finding 2: impl-report.md の手動検証シナリオ記述不足

`impl-report.md` の「テスト結果サマリ」直前に新規セクション **「ライブ実行の代替検証（ST15 完了条件補足）」** を追加。plan.md ST15 が要求する全 10 シナリオについて、代替検証方法（pure function test / ソースレビュー / ライブ実行）を表形式で明示化。

| シナリオ | 代替検証 |
|---|---|
| 1 clean | `decideSyncState clean` test |
| 2 behind-ff | `decideSyncState behind-ff` + `classifyVerdict warn` test |
| 3 ahead | `decideSyncState ahead` + `classifyVerdict allow` test |
| 4 diverged | `decideSyncState diverged` + `classifyVerdict reject` test |
| 5 uncommitted | **ライブ実行済み**（既存 impl-report 記載） |
| 6 detached | `decideSyncState detached` + `classifyVerdict reject` test |
| 7 no-remote | `decideSyncState no-remote` + `classifyVerdict allow` test |
| 8 --force bypass | `runSyncCheckOrExit` ソースで `forceFlag=true` → `ready_force_bypass` emit + return を確認 |
| 9 env bypass | `runSyncCheckOrExit` ソースで `CMUX_TEAM_SKIP_SYNC_CHECK=1` → `ready_sync_skipped reason=env` emit + return を確認 |
| 10 Agent 経路 | `cmdSpawnAgent.exportVars` (main.ts:2339-2346) に `CMUX_TEAM_SKIP_SYNC_CHECK=1` が無条件で追加されていることをソース確認 |

## 検証結果

### TypeScript 型チェック

```
$ bunx tsc --noEmit --project skills/cmux-team/manager/tsconfig.json 2>&1 | head -20
skills/cmux-team/manager/conductor.ts(201,3): error TS1016: ...
skills/cmux-team/manager/daemon.test.ts(3720,9): error TS2322: ...
skills/cmux-team/manager/daemon.ts(1538,22): error TS2352: ...
```

既存 pre-existing 3 件のみ。**新規エラー 0 件**。

### git-sync テスト

```
$ cd skills/cmux-team/manager && bun test git-sync.test.ts
bun test v1.3.12 (700fc117)

 34 pass
 0 fail
 68 expect() calls
Ran 34 tests across 1 file. [16.00ms]
```

**34 pass / 0 fail 維持**。

## 変更ファイル

| ファイル | 変更行数 | 内容 |
|---|---:|---|
| `CLAUDE.md` | 4 行書換 | ログイベントテーブル detail 列を実装と一致させる |
| `.team/tasks/283-.../runs/.../impl-report.md` | +19 行追記 | 「ライブ実行の代替検証（ST15 完了条件補足）」セクション追加 |

## 完了条件チェック

- [x] CLAUDE.md のログイベントテーブル detail 列が実装の `log(...)` 呼び出しと key 名・順序で一致
- [x] impl-report.md に代替検証セクションが追記されている
- [x] tsc 新規エラー 0 件（既存 3 件のみ）
- [x] `bun test git-sync.test.ts` 34 pass を維持
- [x] impl-fix-report.md が書き出されている

以上。
