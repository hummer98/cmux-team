# タスク割り当て

## タスク内容

---
id: 119
title: conductor_crashed 誤検出と cleanup 漏れを修正
priority: high
created_at: 2026-04-10T01:53:33.438Z
---

## タスク
## 背景・現象

KDG-lab 事例 (2026-04-10):

- T010 (journal-generator.ts マルチステージ化) が surface:71 で実行中、`cmux tree --workspace workspace:4` のタイムアウトで `validateSurface` が false を返し、Manager が `conductor_crashed` と誤検出した
- 実際には surface は生きており、Conductor は数時間後に T010 を正常完走（`cmux-team close-task` 実行・worktree 削除・main マージ済み）
- しかし `daemon.ts:796-804` の crashed ハンドラが `taskId` だけ undefined にして他フィールドを残したため、`team.json` の `conductors[0]` に `taskRunId=task-010-... / taskTitle=... / worktreePath=...` が残存
- cmux タブ名も `[71] ♦ T010 ...` のままで rename されず
- 後続の `CONDUCTOR_DONE` メッセージは `daemon.ts:399-406` で `conductor.status !== "running"` のため `conductor_done_ignored ... reason=not_running` で破棄され、最後の cleanup チャンスも失われた

ログ抜粋:
```
06:33:15 conductor_crashed surface=surface:71              ← 誤検出
10:41:17 conductor_done_ignored surface=surface:71
         status=idle taskId=undefined reason=not_running    ← cleanup 不発
```

## 根本原因（3 段）

1. **`validateSurface` がリトライしない** (`cmux.ts:113-121`)
   - `tree()` の一過性タイムアウト/エラーをそのまま「surface 消失」と扱う
   - `tree()` 自体に明示 timeout が無く、Node デフォルトに依存

2. **`conductor_crashed` ハンドラの cleanup 漏れ** (`daemon.ts:796-804`)
   - `status="idle"` + `taskId=undefined` のみ実行
   - `taskRunId / taskTitle / worktreePath / outputDir / agents` を保持
   - `renameTab` / worktree remove / branch -d を呼ばない（`resetConductor` を通らない）

3. **`CONDUCTOR_DONE` の defensive cleanup 欠如** (`daemon.ts:399-406`)
   - `conductor.status !== "running"` だと即 `conductor_done_ignored` で抜ける
   - 一度 crashed→idle に落ちた Conductor が後で完走しても cleanup されない

## 修正方針

### 修正 A: `validateSurface` のリトライ化

- `cmux.ts:89` `tree()` に明示 timeout を追加（例: `{ timeout: 5_000 }`）
- `cmux.ts:113` `validateSurface` を N=3 回リトライ + 指数バックオフ（200ms → 400ms → 800ms）に変更
- 全失敗時のみ false を返す
- 影響範囲: `master.ts:22,50` / `conductor.ts:472,511` / `daemon.ts:301,811` / `main.ts:931` の呼び出しは無変更で恩恵を受ける

### 修正 B: `running → crashed` を `disconnected` 遷移に変更

`daemon.ts:796-804` を以下に書き換え:

```ts
case "crashed":
  await log("conductor_disconnected", `surface=${surface} reason=validate_surface_failed`);
  conductor.status = "disconnected";
  conductor.disconnectedAt = new Date().toISOString();
  // taskRunId/taskTitle/worktreePath/outputDir/agents は保持
  break;
```

- `disconnected` 状態は既存（`assignTask` failure conductor kind / `start_timeout` で使用済み）。「cmux 通信不可」の意味として統一
- 復活経路: 既存の SESSION_ACTIVE → running、SESSION_IDLE → idle、CONDUCTOR_DONE → resetConductor がそのまま使える
- `assignTask` の対象は `idle` のみ (`daemon.ts:789` 既存) なので、新規割り当て対象にはならない

### 修正 C: 永久 dead 判定 + defensive cleanup

**C-1: `CONDUCTOR_DONE` の late cleanup** (`daemon.ts:399-415`)

```ts
case "CONDUCTOR_DONE": {
  const conductor = findConductor(state, message.surface);
  if (!conductor) {
    await log("conductor_done_ignored", `surface=${message.surface} reason=not_found`);
    break;
  }
  // running ではなくても taskRunId が残っていれば late cleanup
  if (conductor.status !== "running" && !conductor.taskRunId) {
    await log("conductor_done_ignored", `surface=${message.surface} status=${conductor.status} reason=no_task`);
    break;
  }
  if (conductor.status !== "running") {
    await log("conductor_done_late_cleanup", `surface=${message.surface} status=${conductor.status} taskRunId=${conductor.taskRunId}`);
  }
  // 通常通り処理
  await log(...);
  await handleConductorDone(state, conductor);
  break;
}
```

**C-2: long disconnect timeout** (`daemon.ts` の tick ループ)

- `conductor.status === "disconnected"` かつ `disconnectedAt` から N 分（既存定数があれば再利用、なければ 5 分）経過したら `resetConductor` を強制実行
- ログ: `conductor_disconnect_timeout surface=... elapsed=...s taskRunId=...`
- `resetConductor` 内では `taskRunId` 残存時に worktree/branch も冪等に削除される（既存実装）

**C-3: SESSION_IDLE 経路での cleanup**

`daemon.ts:549-573` の SESSION_IDLE ハンドラで、`status === "disconnected"` から idle に戻す際に `taskRunId` が残っていれば `resetConductor` を呼ぶ:

```ts
if (conductor.status === "disconnected" || conductor.status === "starting") {
  if (conductor.taskRunId) {
    await resetConductor(conductor, state.projectRoot);
  } else {
    conductor.status = "idle";
  }
  ...
}
```

### task-state.json 上 assigned のままのタスク扱い（要判断）

resetConductor で Conductor 側はクリーンアップされるが、`task-state.json` の該当タスクが `assigned` のまま orphan 化する可能性がある。
2 つの選択肢:

- (a) **reopen**: `assigned → ready` に戻し、journal に "manager: conductor lost, reassigned" を追記。次の idle Conductor が自動で再実行
- (b) **forced close**: そのまま closed にし、journal に "manager: conductor lost mid-task" を追記。Master/ユーザーが手動再投入

Conductor が実際には完走しているケース（今回の T010）では、Conductor 自身が `cmux-team close-task` を実行しているので task-state.json は既に closed。reopen はせず Manager 側のクリーンアップだけで足りる。
本当に Agent が dead だったケースでは reopen が望ましいが、Manager 側からは区別が難しいので、まず (b) を採用し、必要ならユーザーが再投入するのが安全。
→ **方針: forced close + journal、reopen はしない**

## 全体ステート遷移（修正後）

```
[starting] ──SESSION_*─→ [idle]
    │ start_timeout
    ▼
[disconnected] ──SESSION_ACTIVE──→ [running]
    │              ──SESSION_IDLE───→ [idle]  (taskRunId 残存時は resetConductor 経由)
    │              ──CONDUCTOR_DONE─→ resetConductor → [idle]  (late cleanup)
    │              ──disconnect_timeout→ resetConductor → [idle]  (forced close + journal)
    ▲
    │ validateSurface fail (after retry)
    │ assignTask fail (conductor kind)
    │
[idle] ──assignTask→ [running] ──CONDUCTOR_DONE─→ resetConductor → [idle]
                          │
                          └─validateSurface fail→ [disconnected]
```

新規 orphan 経路なし。すべての paths が最終的に `resetConductor` を通り、`team.json` と cmux タブ名が確実にクリーンアップされる。

## 影響範囲

### 変更ファイル

- `skills/cmux-team/manager/cmux.ts` — `tree()` timeout、`validateSurface` リトライ
- `skills/cmux-team/manager/daemon.ts` — crashed ハンドラ、CONDUCTOR_DONE ハンドラ、SESSION_IDLE ハンドラ、tick ループに disconnect_timeout 追加
- `skills/cmux-team/manager/conductor.ts` — checkConductorStatus の戻り値型を `"crashed"` から `"disconnected"` にリネーム（or 既存 enum 互換のため string 維持）

### テスト追加

- `cmux.test.ts` (新規 or 既存): `validateSurface` リトライ動作（mock で 2 回失敗 → 3 回目成功で true）
- `daemon.test.ts`:
  - `running → disconnected` 遷移時に taskRunId が保持される
  - `disconnected` 状態の Conductor に CONDUCTOR_DONE が来たら late cleanup される
  - `disconnected` 状態が 5 分経過したら resetConductor が呼ばれる
  - SESSION_IDLE で disconnected → idle 復帰時、taskRunId 残存なら resetConductor 経由

### 既存挙動への影響

- `disconnected` 状態の意味が「assignTask conductor kind 失敗」「start_timeout」だけでなく「validateSurface 失敗」も含むようになる。dashboard/CLI 側でも `disconnected` 表示は既存
- assignTask は `idle` のみ対象 (`daemon.ts:789`) なので、新規割り当ての挙動は不変
- master.ts:22,50 の validateSurface も恩恵を受ける（誤 disconnected 検出が減る）

## 関連

- 事例: `/Users/yamamoto/git/KDG-lab/.team/logs/manager.log` (06:33 / 10:41 のログ)
- 関連バージョン: v3.31.0 → v3.32.0 アップデート時にも `daemon_auto_restart` 経由で同じバグが顕在化

## 完了条件

- [ ] `validateSurface` がリトライで一過性タイムアウトを許容することを test で確認
- [ ] `running → disconnected` 遷移時に taskRunId が保持されることを test で確認
- [ ] `disconnected` 状態に CONDUCTOR_DONE が来たとき late cleanup が走ることを test で確認
- [ ] `disconnected` の disconnect_timeout で resetConductor が呼ばれることを test で確認
- [ ] 全 test pass
- [ ] `.team/team.json` の taskRunId/taskTitle 残存問題が発生しないことを KDG-lab で検証


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-119-1775788497` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-119-1775788497
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-119-1775788497/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/119-conductor-crashed-cleanup/runs/task-119-1775788497
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/119-conductor-crashed-cleanup/runs/task-119-1775788497/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら、最後に:
```bash
cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
```
