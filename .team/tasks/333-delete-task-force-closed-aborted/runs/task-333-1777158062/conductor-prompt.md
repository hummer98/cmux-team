# タスク割り当て

## タスク内容

---
id: 333
title: delete-task --force で closed/aborted タスクも強制削除可能にする
priority: medium
created_by: surface:91
created_at: 2026-04-25T22:13:10.118Z
---

## タスク
## 概要

`cmux-team delete-task` は現状 `closed` / `aborted` / `deleted` のタスクを reject する（`main.ts:4328-4331`）。
古いノイズタスクを掃除したい場合に毎回 `rm -rf` + `task-state.json` 手編集する羽目になっており、CLI 経由で完結できない。

このタスクで `--force` フラグを追加し、`closed` / `aborted` のタスクも CLI から削除できるようにする。

## やること

### 1. `TaskFsmEvent.DELETE` に optional `force` を追加

`skills/cmux-team/manager/state-machine/events.ts:108`:

```typescript
| { type: "DELETE"; force?: boolean }
```

既存呼出は `{ type: "DELETE" }` のままで動く（force 未指定時は false 相当）。

### 2. task-fsm.ts の DELETE case を拡張

`skills/cmux-team/manager/state-machine/task-fsm.ts:111-120`:

```typescript
case "DELETE": {
  // delete-task CLI。draft / ready のみ通常許可。
  // force=true なら closed / aborted も deleted 化を許可。
  // assigned は force でも禁止（abort-task 経由を強制）。
  if (state === "draft" || state === "ready") {
    return withActions("deleted", [
      { type: "log", event: "task_deleted" },
      { type: "cascade_children" },
    ]);
  }
  if (event.force && (state === "closed" || state === "aborted")) {
    return withActions("deleted", [
      { type: "log", event: "task_deleted", detail: `force=true prev=${state}` },
      // closed/aborted からの強制削除は cascade 不要（既に terminal で子は影響済み）
    ]);
  }
  return noop(state);
}
```

`assigned` および既に `deleted` のタスクは引き続き noop。

### 3. main.ts の cmdDeleteTask を更新

`skills/cmux-team/manager/main.ts:4303-4372`:

- `getArg("force")` 相当のフラグ判定を追加（既存の `--force` 受理パターンに合わせる。`hasFlag("force")` 等が他コマンドにあれば再利用）
- `currentStatus === "assigned"` reject はそのまま維持
- `closed` / `aborted` / `deleted` の reject を以下に変更:

```typescript
if (currentStatus === "deleted") {
  console.error(`Error: task ${taskId} is already deleted.`);
  process.exit(1);
}
if ((currentStatus === "closed" || currentStatus === "aborted") && !forceFlag) {
  console.error(
    `Error: task ${taskId} is already ${currentStatus}. Use --force to delete it anyway.`
  );
  process.exit(1);
}
```

- `applyTaskEvent` 呼出を `event: { type: "DELETE", force: forceFlag }` に変更
- `force=true` で closed/aborted を消した場合は `task_force_deleted` のようなログを残しても良い（task-fsm の log action で代替できればそちらでも可）

### 4. FSM テスト追加

`skills/cmux-team/manager/state-machine/fsm.test.ts` の Task DELETE テストブロックに以下を追加:

- `closed + DELETE (force=false) → closed (noop)`
- `closed + DELETE (force=true) → deleted` (log action 含む)
- `aborted + DELETE (force=false) → aborted (noop)`
- `aborted + DELETE (force=true) → deleted`
- `assigned + DELETE (force=true) → assigned (force でも noop)`
- `deleted + DELETE (force=true) → deleted (noop)`

### 5. CLI 統合テスト

`main.test.ts` または専用 test に追加:

- `delete-task --task-id <closed_id>` （force なし）→ exit 1, stderr に "already closed" + "Use --force"
- `delete-task --task-id <closed_id> --force` → exit 0, task-state が deleted に遷移、`task_deleted` ログ
- `delete-task --task-id <assigned_id> --force` → exit 1, stderr "is assigned" （force でも abort-task 誘導を維持）

### 6. ヘルプ・ドキュメント更新

- `skills/cmux-team/manager/i18n.ts` の `help_delete_task` に `--force` の説明を追加（en / ja 両方）
  - 例: "`--force`: closed / aborted のタスクも強制削除する。assigned は対象外。"
- `main.ts` 上部のコマンドヘッダコメント（22 行目周辺）の delete-task syntax にも追記:
  - `delete-task --task-id <id> [--journal <text>] [--force]`

## 完了条件

- `bun test ./fsm.test.ts ./main.test.ts` で新規テスト含め pass
- `bunx tsc --noEmit` clean
- `cmux-team delete-task --help` に `--force` 説明が出る
- 実機で `cmux-team delete-task --task-id <closed_id> --force` が成功する手動確認

## 注意

- `assigned` への force は **絶対に許可しない**。abort-task 経由でないと worktree や Conductor との整合が崩れる
- `deleted` への二重 delete は noop 維持（多重削除でログが汚れないように）
- bun test 全体実行は遅いので個別ファイル実行で検証する（T327 で調査中）
- task-state.json への直接書込みは禁止（CLAUDE.md ガードレール）。必ず `applyTaskEvent` 経由

## 参考

- 既存実装: `skills/cmux-team/manager/main.ts:4303-4372` (cmdDeleteTask)
- FSM: `skills/cmux-team/manager/state-machine/task-fsm.ts:111-120` (DELETE case)
- イベント型: `skills/cmux-team/manager/state-machine/events.ts:101-121`
- CLAUDE.md「task-state」「state machine」項


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-333-1777158062` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-333-1777158062
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-333-1777158062/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/333-delete-task-force-closed-aborted/runs/task-333-1777158062
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/333-delete-task-force-closed-aborted/runs/task-333-1777158062/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
