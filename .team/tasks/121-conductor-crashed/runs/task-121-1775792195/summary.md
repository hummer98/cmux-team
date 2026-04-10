# T121 実行サマリー (task-121-1775792195)

## 結果: GO

## 背景

T119 は conductor_crashed 誤検出と cleanup 漏れの修正タスクだったが、cmux.app の PTY 障害により Phase 3 Implementation が完了できず ABORTED した。T121 は T119 の plan.md (Design Review 完了済み) を引き継ぎ、実装を完遂した。

## 完了したフェーズ

### Phase 1-2: Plan + Design Review (T119 成果物を流用)

T119 の plan.md (1288行, Design Review 10項目全反映済みの最終版) を T121 出力ディレクトリにコピーして使用。Phase 1-2 をスキップ。

### Phase 2.5: 再発確認

現行コード (v3.32.0) を確認し、T119 の修正が main にマージされていないことを確認。バグは再発する状態にあった。

### Phase 3: Implementation

cmux.app の PTY トラブル (cmux tree タイムアウト) により Implementer Agent (surface:311) が起動不能となったため、Conductor 自身が plan.md §9 の Step 順序に従って直接実装。

### Phase 4: Inspection

plan.md §12.1 の完了条件チェックリストとの突合を実施。全項目クリア。

## 実装した修正

| 修正ID | plan.md Section | 内容 |
|--------|----------------|------|
| A | §2 | cmux.ts: tree() に 5s timeout 追加、validateSurface に 3 回リトライ (tree 例外時のみ) |
| B | §3 | daemon.ts: monitorConductors の crashed → disconnected 遷移 (kind=crashed ログ) |
| C-1 | §4 | daemon.ts: CONDUCTOR_DONE late cleanup (disconnected 状態でも taskRunId が残っていれば cleanup) |
| C-2 | §5 | daemon.ts: DISCONNECT_TIMEOUT_SEC (5分) + forceCloseDisconnectedConductor + monitorConductors 最終形 (tree キャッシュ surfaceAlive) |
| C-3 | §6 | daemon.ts: SESSION_IDLE で disconnected + taskRunId は running に戻すだけ (Critical 1: worktree 誤削除防止) |
| Minor 3 | §5.4.1 | conductor.ts: resetConductor に disconnectedAt クリア追加 |
| Minor 4 | §5.4 | daemon.ts: forceCloseDisconnectedConductor 内で pidWatcherInterval クリア |
| Minor 5 | §12.2 | daemon.ts: CMUX_TEAM_DISCONNECT_TIMEOUT_SEC 環境変数で上書き可能 |

## 変更ファイル一覧

| ファイル | 種別 | 変更概要 |
|---------|------|---------|
| skills/cmux-team/manager/cmux.ts | 修正 | tree() timeout + validateSurface リトライ |
| skills/cmux-team/manager/cmux.test.ts | 新規 | validateSurface リトライテスト (4件) |
| skills/cmux-team/manager/conductor.ts | 修正 | resetConductor に disconnectedAt クリア追加 |
| skills/cmux-team/manager/daemon.ts | 修正 | monitorConductors 最終形 + CONDUCTOR_DONE late cleanup + forceCloseDisconnectedConductor + SESSION_IDLE 復帰処理 + monitorConductors export |
| skills/cmux-team/manager/daemon.test.ts | 追加 | crashed → disconnected 遷移テスト (7件) |

## テスト結果

- `bun test`: 81 pass, 0 fail (既存 70 + 新規 11)
- `bunx tsc --noEmit`: T121 変更分は型エラーなし (dashboard.tsx の既存エラーのみ)

## マージ

- コミット: `8b5c328` (worktree)
- マージ: `1cd319f` (main, ローカルマージ, コンフリクト解決済み)

## 特記事項

- cmux.app の PTY トラブルにより Agent spawn が不能だったため、Conductor が直接実装を行った
- これは T119 と同じ現象で、まさにこのタスクが修正しようとしている問題が実行中に発生するという皮肉な状況だった
- plan.md の Design Review が完了していたため、実装自体は機械的な差分適用で完了できた
