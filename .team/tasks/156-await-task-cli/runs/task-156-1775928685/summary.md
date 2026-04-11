# Task 156: await-task CLI コマンドと配布スキルの追加

## 完了ステータス: GO (Inspection 合格)

## 変更内容

### 新機能: `cmux-team await-task`
- `--task-id NNN` で指定タスクが closed/aborted になるまで `fs.watch` ベースで待機
- カンマ区切りで複数タスク ID 対応 (`--task-id 108,109`)
- `--timeout SECONDS` オプション (デフォルト: 3600秒)
- 終了コード: 0=closed, 1=aborted, 2=timeout
- 完了時に summary.md の内容を stdout にダンプ (フォールバック: journal → メッセージ)

### 変更ファイル (4ファイル)
| ファイル | 変更 |
|---------|------|
| `skills/cmux-team/manager/main.ts` | `cmdAwaitTask()` + `printSummaries()` 追加, switch case 追加, watch import |
| `skills/cmux-team/manager/i18n.ts` | en/ja ヘルプテキスト追加, help_main 追記 |
| `skills/cmux-team/SKILL.md` | コマンド一覧 + セクション4「タスク完了待ち」追加 |
| `skills/cmux-agent-role/SKILL.md` | セクション7末尾に「タスク完了待ち」追記 |

### テスト結果
- ヘルプ表示: OK
- 存在しないタスク ID: 正しくエラー出力
- TypeScript 型チェック: 新規エラーなし

## マージ
- ブランチ `task-156-1775928685/task` → `main` にローカルマージ済み
