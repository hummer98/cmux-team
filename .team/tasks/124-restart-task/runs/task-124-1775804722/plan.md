# Plan: restart-task サブコマンドの実装

## 概要

`cmux-team restart-task --task-id <id> [--journal "理由"]` を実装する。
abort-task のクリーンアップ処理を共通化し、最後の状態を `ready` に戻して TASK_CREATED 通知を送信する。

## 変更ファイル

1. **`skills/cmux-team/manager/main.ts`**
   - `cmdAbortTask()` のクリーンアップ処理（ステップ2〜5: sub-agent close, PID kill, worktree 削除）を共通関数 `cleanupAssignedTask()` として抽出
   - `cmdAbortTask()` は `cleanupAssignedTask()` を呼び出すようにリファクタ
   - 新規 `cmdRestartTask()` を追加:
     - `cleanupAssignedTask()` でクリーンアップ
     - status を `ready` に変更（`aborted` ではなく）
     - journal に `[restart]` プレフィックスを付与
     - `TASK_CREATED` 通知を送信 → daemon が idle Conductor に再割り当て
     - Conductor を再起動
   - case 文に `"restart-task"` を追加
   - 冒頭コメントに restart-task を追加

2. **`skills/cmux-team/manager/i18n.ts`**
   - 英語メッセージ追加: `restart_journal_default`, `help_restart_task`, help_main のコマンドリスト
   - 日本語メッセージ追加: 同上

## 共通関数 `cleanupAssignedTask()` の設計

```typescript
async function cleanupAssignedTask(conductor: any): Promise<void> {
  // 1. Sub-agent の surface を閉じる
  // 2. Conductor の PID を kill
  // 3. worktree 削除 + ブランチ削除
}
```

- abort-task の既存ステップ3〜5をそのまま抽出
- conductor オブジェクト（team.json から取得済み）を引数に受ける
- abort-task / restart-task 両方から呼び出す

## cmdRestartTask() の処理フロー

1. assigned 状態確認（abort-task と同じ）
2. team.json から Conductor 特定（abort-task と同じ）
3. `cleanupAssignedTask(conductor)` 呼び出し
4. task-state.json: status を `ready` に変更（closedAt/abortedAt は付けない）
5. journal をタスクファイルに追記（`[restart]` プレフィックス）
6. ログ記録: `task_restarted`
7. CONDUCTOR_DONE 通知（abort-task と同じ）
8. Conductor 再起動（abort-task と同じ）
9. TASK_CREATED 通知送信 → daemon が再割り当て
10. `OK restarted {taskId}` を出力

## 注意点

- conductor が見つからない場合は abort-task と同様に状態だけ ready に戻す（+ TASK_CREATED 通知）
- task-state.json の status を ready にする際、assignedAt 等の前回の割り当て情報はクリアする
