# Summary: Conductor 起動時に --session-id を指定して resume 可能にする

## 判定: GO (Inspection Passed)

## 変更内容

タスク割当時に UUID を生成し、`/exit` + `--session-id` 付き再起動方式に変更。
SessionStart hook の `$SESSION_ID` 環境変数が常に空になる問題を根本解決し、resume 機能を確実に動作させる。

### 変更ファイル

| ファイル | 変更内容 |
|---------|---------|
| `skills/cmux-team/manager/main.ts` | `cmdConductor` に `--session-id`, `--task-prompt` オプション追加。`generateConductorSettings` から `--session-id` パラメータ削除 |
| `skills/cmux-team/manager/conductor.ts` | `assignTask` を `/clear` → `/exit` + 再起動方式に変更。`resetConductor` で `sessionId` クリア追加 |
| `skills/cmux-team/manager/daemon.ts` | `SESSION_STARTED` ハンドラから sessionId 保存ロジック削除。`scanTasks` で sessionId を task-state.json に記録。`SESSION_ENDED` ハンドラに running ガード追加 |

### 統計

- 3 files changed, 48 insertions(+), 31 deletions(-)

## テスト結果

- TypeScript コンパイル: 既存エラー3件（今回の変更と無関係）。今回の変更により main にあった daemon.ts の型エラー2件が副次的に解消
- 新規エラー: なし

## マージ

- 方法: ローカルマージ（main ブランチ）
- マージコミット: `git merge task-132-1775829890/task` — 成功（コンフリクトなし）

## フェーズ実行ログ

| フェーズ | 結果 |
|---------|------|
| Phase 1: Plan | plan.md 作成完了。案A（/exit + --session-id 再起動）を採用 |
| Phase 2: Design Review | Approved（推奨事項: SESSION_ENDED ガード追加） |
| Phase 3: Implementation | 6変更 + 1推奨事項の計7箇所を実装完了 |
| Phase 4: Inspection | GO — plan との整合性・コード品質ともに問題なし |
