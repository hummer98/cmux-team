# タスク割り当て

## タスク内容

---
id: 204
title: restart-task を aborted 状態からも使えるようにする
priority: medium
created_at: 2026-04-15T06:44:52.161Z
---

## タスク
## 背景

現在 `cmux-team restart-task` は `assigned` 状態のタスクしか受け付けない（`main.ts:2509`）:

```typescript
if (currentStatus !== "assigned") {
  console.error(`Error: task ${taskId} is not assigned (current status: ${currentStatus ?? "unknown"}). Only assigned tasks can be restarted.`);
  process.exit(1);
}
```

しかし `aborted` 状態のタスクを再実行したいケース（Conductor クラッシュ・手動 `/clear`・resume 失敗後の対応など）は実運用でしばしば発生する。現状の回避策は `update-task --status ready` で直接戻すことだが、task-state.json に `worktreePath` / `sessionId` / `taskRunId` / `conductorSlot` / `abortedAt` などの残骸が残り、Manager が resume を試みる可能性があって不安定。

アーキテクチャ的にも aborted → restart は自然なパスで、現在の制限は意図的なものというより単に対応していないだけ。

## ゴール

- `cmux-team restart-task --task-id <id>` が `aborted` 状態からも使えるようにする
- 残骸（worktree、ブランチ、task-state の resume 用フィールド）を確実にクリーンアップしてから ready に戻す
- 既存の `assigned` からの restart 動作は一切壊さない

## 変更対象

### 1. `main.ts:2492` `cmdRestartTask`

**状態チェックの緩和** (`main.ts:2509`):

```typescript
// before
if (currentStatus !== "assigned") {
  console.error(`Error: task ${taskId} is not assigned ... Only assigned tasks can be restarted.`);
  process.exit(1);
}

// after
if (currentStatus !== "assigned" && currentStatus !== "aborted") {
  console.error(`Error: task ${taskId} is not assigned or aborted (current status: ${currentStatus ?? "unknown"}). Only assigned or aborted tasks can be restarted.`);
  process.exit(1);
}
```

**aborted 分岐の追加**:

`aborted` 状態では既に Conductor とは切れている（forced-close 済みまたは未割り当て）ため、team.json からの Conductor 探索や `CONDUCTOR_DONE` 通知は不要。代わりに:

1. `taskState[taskId].worktreePath` が存在し `existsSync` で実在するなら `git worktree remove --force <path>` で削除（冪等、失敗してもログだけ）
2. `taskState[taskId].taskRunId` から派生するブランチ `${taskRunId}/task` も `git branch -D` で削除（冪等）
3. task-state から `worktreePath` / `taskRunId` / `sessionId` / `conductorSlot` / `assignedAt` / `abortedAt` / `journal`（既存 journal は新 journal でオーバーライト）を剥がして `status: "ready"` に戻す
4. `log("task_restarted", "task_id=<id> from=aborted journal_summary=<journal>")` でイベント記録
5. `TASK_CREATED` message を送信して Manager に再割り当てさせる

具体的な構造案（擬似コード）:

```typescript
async function cmdRestartTask(): Promise<void> {
  // ... 既存の help / taskId / journalArg / title 取得は共通 ...

  const taskState = await loadTaskState(PROJECT_ROOT);
  const currentStatus = taskState[taskId]?.status;

  if (currentStatus !== "assigned" && currentStatus !== "aborted") {
    console.error(`Error: task ${taskId} is not assigned or aborted (current status: ${currentStatus ?? "unknown"}). Only assigned or aborted tasks can be restarted.`);
    process.exit(1);
  }

  if (currentStatus === "aborted") {
    await restartAbortedTask(taskId, title, journal, taskState, taskFile);
    return;
  }

  // 以降、既存の assigned 分岐処理
}
```

`restartAbortedTask` の実装:

```typescript
async function restartAbortedTask(
  taskId: string,
  title: string,
  journal: string,
  taskState: TaskStateMap,
  taskFile: string | null,
): Promise<void> {
  const ts = taskState[taskId];

  // 1. worktree 削除（冪等）
  if (ts.worktreePath && existsSync(ts.worktreePath)) {
    try {
      await execFileAsync("git", ["worktree", "remove", "--force", ts.worktreePath], { cwd: PROJECT_ROOT });
    } catch (e: any) {
      await log("cleanup_failed", `restart-task worktree remove: path=${ts.worktreePath} ${e.message}`);
    }
  }

  // 2. ブランチ削除（冪等）
  if (ts.taskRunId) {
    const branch = `${ts.taskRunId}/task`;
    try {
      await execFileAsync("git", ["branch", "-D", branch], { cwd: PROJECT_ROOT });
    } catch (e: any) {
      await log("cleanup_failed", `restart-task branch delete: branch=${branch} ${e.message}`);
    }
  }

  // 3. task-state クリーンアップ
  taskState[taskId] = {
    status: "ready",
    journal: `[restart] ${journal}`,
  };
  // worktreePath / taskRunId / sessionId / conductorSlot / assignedAt / abortedAt は落とす
  await saveTaskState(PROJECT_ROOT, taskState);

  await log("task_restarted", `task_id=${taskId}${title ? ` title=${title}` : ""} from=aborted journal_summary=${journal}`);

  // 4. TASK_CREATED 通知
  await postMessage({
    type: "TASK_CREATED",
    taskId,
    taskFile: taskFile ?? "",
    timestamp: new Date().toISOString(),
  });

  console.log(`OK restarted ${taskId} (from aborted, re-queued as ready)`);
}
```

※ 実装時は既存コードベースのスタイル・ヘルパー関数を確認して合わせること。`cleanupAssignedTask` の中で worktree/ブランチ削除をしているなら、その内部関数を共通化して使うのが望ましい。

### 2. i18n メッセージ修正 (`i18n.ts`)

`restart-task` の help 文字列で「running」「実行中」になっている箇所を「assigned or aborted」「assigned または aborted」に修正:

- `i18n.ts:371` `cmux-team restart-task -- restart a running task (re-queues as ready)`
- `i18n.ts:532` `cmux-team restart-task --task-id <id> [--journal <text>] restart a running task`
- `i18n.ts:891` `cmux-team restart-task -- 実行中タスクを再実行（ready に戻す）`
- `i18n.ts:1052` `cmux-team restart-task --task-id <id> [--journal <text>] 実行中タスクを再実行`

examples セクション（`i18n.ts:381,382,901,902`）は追加で aborted 状態の例を足してもよい:

```
cmux-team restart-task --task-id 030 --journal "resume failed; restart from scratch"
```

### 3. （推奨）assigned 分岐でも resume 用フィールドを剥がす

現状 `assigned` からの restart (`main.ts:2548-2553`) は `status` と `assignedAt` しか触らず、`worktreePath` / `sessionId` / `taskRunId` / `conductorSlot` を残している。`assignTask` 時に上書きされるので実害はないが、T203 で hook 経由 sessionId 追従に変わる以上、整合性を保つため **`assigned` 分岐でも同じ剥がし処理をやる** のが望ましい。

この修正はスコープを広げるかもしれないので、担当者の判断で:
- 一緒にやる → 一貫性確保・T203 との親和性高
- 別タスクに切る → スコープ最小化

のどちらかを選ぶこと。一緒にやるなら aborted/assigned 共通の剥がしヘルパーを作ると綺麗。

## テスト計画

### 手動テスト

1. **aborted → restart が ready に戻ること**
   - 適当なタスクを assigned にする
   - Conductor ペインで `/clear` を実行 → Manager が task を aborted にする
   - `cmux-team restart-task --task-id <id>` を実行
   - task-state.json で `status: ready` になり、`worktreePath` / `sessionId` 等が剥がれていることを確認
   - Manager が idle Conductor に自動再割り当てすることを確認

2. **古い worktree が残っていても冪等に動くこと**
   - aborted 状態で worktree ディレクトリを手動で削除してから `restart-task` 実行
   - エラーログは出るがコマンドは成功すること

3. **存在しない task-id でエラーになること**
   - `cmux-team restart-task --task-id 999` が明確なエラーで exit 1

4. **assigned からの restart が従来通り動くこと**
   - 既存パスの回帰テスト

### 自動テスト

`main.test.ts` があるなら `cmdRestartTask` のユニットテストに aborted ケースを追加。なければ手動テスト結果を journal に記録。

## 参考情報

- `skills/cmux-team/manager/main.ts:2492` — `cmdRestartTask` 本体
- `skills/cmux-team/manager/main.ts:2509` — 状態チェック（今回の変更点）
- `skills/cmux-team/manager/main.ts:2548-2553` — assigned 分岐の task-state 更新（推奨 3 の対象）
- `skills/cmux-team/manager/conductor.ts:502` — `resetConductor` の worktree/branch 削除ロジック（流用参考）
- `skills/cmux-team/manager/i18n.ts:371,532,891,1052` — help 文字列
- `git log -S 'cmdRestartTask'` → `e09f285 feat: restart-task サブコマンドの実装` が初導入コミット

## 関連タスク

- T203 `sessionId を SessionStart hook 経由で一元化し /clear 後の resume を回復する`
  - 独立して並行作業可能だが、両方 `main.ts` を触るのでマージ時に軽い衝突の可能性あり
  - 先着順でマージ、後発が rebase する方針でよい

## 非目標

- `closed` / `deleted` 状態からの restart — 意図的に終わらせたタスクを誤操作で復活させるリスクがあるため対象外
- `ready` / `draft` 状態からの restart — そもそも restart する意味がない（すでに実行待ちまたは未起票）
- restart-task の新しいオプション追加（`--keep-worktree` 等）— 本タスクでは扱わない


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-204-1776241217` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-204-1776241217
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-204-1776241217/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/204-restart-task-aborted/runs/task-204-1776241217
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/204-restart-task-aborted/runs/task-204-1776241217/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら:

1. セッション上に完了レポートを表示する（conductor-role.md「完了時の処理」ステップ 8 参照。設計判断・試行錯誤・自己判断・懸念・成果の勘所を簡潔に出力）
2. 完了通知を送信する:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
   ```
