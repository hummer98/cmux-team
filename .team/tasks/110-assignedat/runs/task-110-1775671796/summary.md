# Summary: T110 タスク時間管理 assignedAt 記録 + ダッシュボード表示改善

## 結果: GO (完了)

## 変更ファイル

| ファイル | 変更内容 |
|---------|---------|
| `skills/cmux-team/manager/task.ts` | TaskState に `assignedAt?: string` フィールド追加 |
| `skills/cmux-team/manager/daemon.ts` | TaskSummary に `assignedAt` 追加、import に `loadTaskState`/`saveTaskState` 追加、assignTask 成功後に task-state.json を `{ status: 'assigned', assignedAt }` で更新、taskList 構築に `assignedAt` マッピング追加 |
| `skills/cmux-team/manager/dashboard.tsx` | `compactElapsed` 関数追加、`buildTaskRow` の timeInfo ロジックを状態別表示に変更 |

## ダッシュボード表示パターン

| タスク状態 | 表示内容 | 例 |
|-----------|---------|-----|
| draft / ready / blocked | 作成時間（HH:MM） | `14:30` |
| running（assigned） | 開始時間 + 経過時間 | `14:30 (2h35m)` |
| closed | 完了時刻 + 総実行時間 | `16:05 (1h35m)` |
| aborted | 中止時刻 + 実行時間 | `15:00 (30m)` |

## マージコミット

- `495d42d` feat: タスク時間管理 assignedAt 記録 + ダッシュボード表示改善
- main にローカルマージ済み（Fast-forward）
