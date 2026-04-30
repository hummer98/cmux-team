# T398 検品結果

## Verdict: **GO**

## 詳細

### 1. コード正しさ — `daemon.ts` の guard

`skills/cmux-team/manager/daemon.ts:3030-3050` を確認。

- [x] guard は **Exclusive lock guard の直後**（`for (const task of …)` ループの直前）に入っている
- [x] `assignedRunAfterAllTaskIds` の filter は `t.runAfterAll && !t.exclusive && assignedIds.has(t.id)`（defense-in-depth で `!t.exclusive` あり）
- [x] guard hit 条件は `assignedRunAfterAllTaskIds.size > 0 && executable.length > 0`
- [x] `dispatchTargets = runAfterAllExecutable` に切替（`return` ではない）
- [x] log event 名は `run_after_all_lock_active`、format は `task_ids=<csv> pending_normal=<n>`
- [x] `for (const task of allExecutable)` が `for (const task of dispatchTargets)` に置き換え（diff 上で確認済み）
- [x] `state.pendingTasks = allExecutable.length` は不変（diff に登場せず保持）

実装は plan §2.1 (b) の採用案 (ii) と完全一致。

### 2. テスト完全性

`skills/cmux-team/manager/daemon-run-after-all-lock.test.ts`（新規 287 行）を確認。

- [x] TC1〜TC5 が**全て**存在（`describe("scanTasks: run_after_all lock guard (T398)")` 内に 5 test ブロック）
- [x] 各テストで実 status / log / conductor.status を assert（緩すぎる assertion なし）
- [x] **TC2** は「他の RAA も `ready` ではなくなる（dispatch 試行）」+「`run_after_all_lock_active` ログが出ない」で並走可を立証
- [x] **TC3** は T397 + T398 の組合せ（draft → ready 化後の並走防止）を 2 回 `scanTasks` 呼び出し（1 回目: dep 未解決で no-op、2 回目: ready 化後に guard が立つ）で再現
- [x] **TC4** は exclusive guard が先に作動することを `exclusive_lock_active` のみ出力 / `run_after_all_lock_active` は出ない、で確認（regression なし）
- [x] **TC5** は executable=0 / RAA=0 の no-op を log なしで確認
- [x] TC1 の assigned 作り込みは `createTask("301", "raa-task", { runAfterAll: true, status: "assigned" })` + `makeConductor("surface:301", { status: "running", taskId: "301" })` で plan §3.3 末尾の指示通り
- [x] helper 重複は最小限（`createTask` / `setTaskStatus` / `makeConductor` / `readManagerLog` の 4 つのみ、plan §3.1 で許容された自前ヘルパー方針）

### 3. ドキュメント

`docs/spec/07-state-machine.md`（+50 / -2）を確認。

- [x] 新節 `## 5. dispatch ガード (run_after_all / exclusive)` を追加。サブ節 §5.1 throttle / §5.2 Exclusive lock / §5.3 run_after_all lock (T398) / §5.4 各 flag semantics 比較 を含む
- [x] 節番号衝突なし: 既存 `## 5. 段階計画` を `## 6. 段階計画` にリナンバリング（impl-changes.md の報告通り）
- [x] 既存サブ番号 `### 5.1 T302 脚注` → `### 6.1 T302 脚注` にシフト済み（diff に `### 6.1 T302 脚注` を確認）
- [x] 他ファイルからの旧節番号参照: `grep -rn "07-state-machine.md#5"` / `#段階計画` / `#t302` ともに 0 件。glossary.md からの参照は `#1-conductor-fsm` / `#21-状態一覧-6-値` / `#24-cascade-ルール-t241` / `#11-状態一覧-7-値` / `#15-不変条件` / `#3-conductor--task-の同時遷移` のみで、いずれも §1〜§4 の anchor（変更なし）
- [x] `CLAUDE.md` のタスク属性表は plan §4.2 通り、`run_after_all` 行に「assigned 中は normal の新規 assignment を停止するが、他の `run_after_all` とは並走可」を追記

### 4. テスト実行

完了条件のコマンドを Inspector 自身で実行。

```
$ cd skills/cmux-team/manager
$ bun test --timeout 30000 task.test.ts daemon-*.test.ts
112 pass / 0 fail / 232 expect() calls (Ran 112 tests across 2 files. [212.00ms])

$ bun test --timeout 30000 daemon.test.ts
187 pass / 0 fail / 667 expect() calls (Ran 187 tests across 1 file. [24.19s])
```

両方 green。新規 5 テスト + 既存 daemon.test.ts に regression なし。

### 5. tsc

```
$ cd skills/cmux-team/manager
$ bunx tsc --noEmit
（出力なし、exit 0）
```

`daemon.ts` / `daemon-run-after-all-lock.test.ts` 関連を含めて新規エラー 0。

### 6. 完了条件チェック（タスク本文）

| # | 完了条件 | 判定 | 根拠 |
|---|---|---|---|
| 1 | `scanTasks` に run_after_all lock guard 追加 | ✓ | `daemon.ts:3030-3050` |
| 2 | RAA assigned 中、新規 ready normal が dispatch されない | ✓ | TC1 |
| 3 | RAA assigned 中、他の ready RAA は dispatch される（並走可） | ✓ | TC2 |
| 4 | --exclusive 単独実行 regression | ✓ | TC4 |
| 5 | T397 executable ベース判定 + 本 guard、draft → ready 化後も並走しない | ✓ | TC3 |
| 6 | `bun test … task.test.ts daemon-*.test.ts` が green | ✓ | §4 |
| 7 | `docs/spec/07-state-machine.md` 更新 | ✓ | 新節 §5 追加 |
| 8 | `CLAUDE.md` 補足 | ✓ | タスク属性表更新 |

完了条件 8 / 8 を全て満たす。

### 7. plan.md 乖離

| 箇所 | plan.md 予想 | 実装 | 判定 |
|---|---|---|---|
| spec 節番号 | §6 として末尾追加（plan §4.1 line 198: 「挿入位置: `## 5. 段階計画` の手前 (line 272 付近)」と書きつつ、節番号は「## 6. dispatch ガード」と呼称） | §5 として挿入し、既存 §5 を §6 にリナンバリング | **許容** — plan §4.1 末尾「節番号衝突がないか確認すること」の指示と整合。挿入位置（既存 §5 の前）は plan の指示通り。「dispatch ガード」を §5 として置く方が「§5 dispatch ガード → §6 段階計画 → §関連」と読み順が自然で、構造的に改善。impl-changes.md でも理由を明記済み |

その他は plan.md 完全準拠。採用案 (ii) (`dispatchTargets` 切替)、defense-in-depth `!t.exclusive` フィルタ、log event 命名、テストファイル新設、helper 自前コピー方針、いずれも plan の通り。

### 8. スコープ違反

`git status` 結果:

```
M CLAUDE.md
M docs/spec/07-state-machine.md
M package-lock.json    # ← worktree 起動時点で既に変更済み (Implementer は touch していない)
M skills/cmux-team/manager/daemon.ts
?? skills/cmux-team/manager/daemon-run-after-all-lock.test.ts
```

スコープ内のファイルのみ変更。scope_violation なし。

### 9. ガードレール

- `daemon.ts` の diff: 新規 `taskState[...] =` / `saveTaskState(` 追加なし（guard 内では `tasks.filter(...)` の read-only 操作のみ）
- `bus.emit` / `bus.on` の直接呼び出し追加なし
- 空 `catch {}` なし（テストの `catch { return ""; }` は値を返す意味のあるブロック、空ではない）
- 新 guard コード内に `tree(workspace)` / `validateSurface(...)` 呼び出しなし（不要）

すべて clean。

## Fix Required

なし（全項目 GO、minor 指摘もなし）。
