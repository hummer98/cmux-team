# タスク割り当て

## タスク内容

---
id: 303
title: P2: task-state 全 mutation を pure reducer 経由に置換し SSOT を確立する
priority: high
depends_on: [302]
created_at: 2026-04-23T01:45:40.073Z
---

## タスク
## 背景

T279（P1）で `state-machine/{task-fsm,conductor-fsm,shadow,invariants}.ts` の pure reducer + shadow observer を実装済み。`docs/spec/07-state-machine.md:239-242` に「P2: daemon 側 state mutation を reducer の `{next, actions}` で置換」が予定されているが、本来の P2 を担うはずだった T280 は誤ってリリースタスクに使われており、本タスクは未着手のまま。

T220 race（→ T302 で暫定ガード対応）は SSOT 不在の典型的な症状。`task-state.json` への直接書き込みが daemon.ts / main.ts に 12+ 箇所散在しており、reducer の遷移ガードが効いていない。

## スコープ

### a) Task 側 shadow observer の配線（P1 漏れ分）

`shadowObserveTask` は `state-machine/shadow.ts:118` に定義されているのみで daemon/main からの呼び出しゼロ。全 task-state mutation 箇所に shadow observer を配線し、24h 観測で `fsm_shadow_diff = 0` を確認する。

### b) Task 側 mutation 全箇所の reducer 置換

| ファイル | 行（概算） | 現 mutation | 対応 reducer event |
|---|---|---|---|
| daemon.ts | 950, 1027, 1062, 1081, 1092 | resume / overflow → ready | `RESUME_REVERT_TO_READY`（events.ts に新規追加） |
| daemon.ts | 1575 | sessionId のみ更新 | reducer 対象外（メタデータ更新は別経路） |
| daemon.ts | 2700 | assign 完了 | `ASSIGN_OK` |
| daemon.ts | 3164 | conductor done unresolved | `ABORT(reason=judgment_pending)` |
| main.ts | 871, 928 | restart / overflow | `RESTART` / `RESUME_REVERT_TO_READY` |
| main.ts | 3010 | update-status | `UPDATE_STATUS` |
| main.ts | 3180, 3785 | abort | `ABORT` |
| main.ts | 3859 | close-task | `CLOSE` |
| main.ts | 3888 | restart-task | `RESTART` |
| main.ts | 3964 | delete-task | `DELETE` |

各箇所を以下のパターンに置換：

```ts
const prev = ts[taskId]?.status as TaskStatus | undefined;
const { next, actions } = taskReduce(prev ?? "draft", { type: "ASSIGN_OK" }, ctx);
if (next === prev) {
  await log("task_mutation_skipped", `task_id=${taskId} event=ASSIGN_OK prev=${prev} reducer=noop`);
  // 副作用も rollback（worktree cleanup 等）
  return;
}
ts[taskId] = { ...ts[taskId], status: next, ...metadataFields };
await saveTaskState(...);
await applyTaskActions(actions, taskId, projectRoot);
```

### c) reducer 拡張

resume / overflow → ready の経路には現 reducer に対応 event が無い。`events.ts` に `RESUME_REVERT_TO_READY` 等を追加し `task-fsm.ts` で遷移を定義する。挙動は state-machine 仕様の追補として `07-state-machine.md` に追記する。

### d) action handler 実装

reducer が返す `{ type: "log", event, detail? }` / `{ type: "cascade_children" }` を実行する薄いディスパッチャ `applyTaskActions(actions, taskId, projectRoot)` を 1 箇所作って集約する。`cascade_children` は既存の `cascadeAbortToChildren` を呼び出す形でブリッジ。

### e) 並行書き込みの atomicity

reducer 置換だけでは「load → reduce → save」の race が残る。daemon プロセス内では in-process mutex で `saveTaskState` を直列化する（CLI は別プロセスなので file lock も検討）。

選択肢：
1. in-process mutex のみ（daemon 内のみ保護、CLI は別途）
2. file lock（`.team/task-state.lock`）で daemon + CLI の両方を保護

T220 race の根治には少なくとも (1) が必須。(2) はオーバーキルかもしれないので別タスク化検討。

## 受け入れ条件

- shadow 配線完了後、24h 実稼働観測で `fsm_shadow_diff = 0` / `fsm_invariant_violation = 0`
- 全 reducer 置換完了後、 `bun test` pass + 新規ユニットテスト（terminal status への mutation skip / cascade actions 実行）
- `grep -n 'taskState\[.*\] =' daemon.ts main.ts` がゼロ件（直接書き込み撲滅、reducer 経由のヘルパ関数のみ残る）
- T302 で入れた暫定ガード（assign_skipped_terminal）を削除し、reducer の `noop(state)` 経路に統合
- `07-state-machine.md` を P2 完了に追記、P3（次のフェーズ案 or 完了宣言）を明記

## 対象ファイル

- `skills/cmux-team/manager/state-machine/{events,task-fsm,shadow}.ts`
- `skills/cmux-team/manager/daemon.ts` `main.ts`
- 新規: `skills/cmux-team/manager/state-machine/apply-actions.ts`（または `task.ts` に追加）
- `docs/spec/07-state-machine.md`

## 依存

- T302（assign 上書きガード）が先に入っていると安全。T303 完了時に T302 の暫定コードを削除する


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-303-1776910530` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-303-1776910530
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-303-1776910530/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/303-p2-task-state-mutation-pure-reducer-ssot/runs/task-303-1776910530
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/303-p2-task-state-mutation-pure-reducer-ssot/runs/task-303-1776910530/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
