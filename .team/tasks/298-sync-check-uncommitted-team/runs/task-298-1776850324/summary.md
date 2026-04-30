# T298 完了サマリー

## タスク
sync check の uncommitted 判定から `.team/` 配下を除外（`git-sync.ts` の `hasUncommittedOnMain` 計算に pathspec `:(exclude).team` を適用）。

## 変更ファイル
- `skills/cmux-team/manager/git-sync.ts`: `collectSyncFacts` 内、`headStatus === "on-main"` 分岐の `git status --porcelain` を `git status --porcelain -- . :(exclude).team` に変更
- `skills/cmux-team/manager/git-sync.test.ts`: 既存 mock key 10 ヶ所を新しい pathspec key に更新 + 新規テスト 3 件追加（`.team/` のみ dirty → clean / 他ファイルのみ dirty → uncommitted / 混在 → uncommitted）
- `CLAUDE.md`: 「Ready 昇格時の sync state ガード（T283）」セクションに T298 注記を追加
- `package-lock.json`: `4.4.0 → 4.5.0` の version 追従（v4.5.0 release 時の lock 同期漏れの解消、T298 ロジックとは独立）

## 検証結果
- `bun test skills/cmux-team/manager/git-sync.test.ts`: 37 pass / 0 fail（75 expect）
- `bunx tsc --noEmit`: T298 起因の新規エラーなし（pre-existing 3 件は stash で変更退避しても同じく発生、スコープ外）

## 手動動作確認
本 worktree は `task-298-1776850324/task` branch 上で動作するため `collectSyncFacts` の `headStatus` が `on-other-branch` 扱いになり、`cmux-team create-task --status ready` を worktree 内で発行しても sync check が `on-main` 分岐を通らない。代わりに新規 3 件の unit test で pathspec 除外の挙動を直接検証した（Inspector の判断・受け入れ条件を満たすと結論）。

## 設計判断
- pathspec magic `:(exclude).team` を使い、porcelain 出力のパース（quoted path / rename `old -> new` 等のエッジケース）を自前実装しない
- 他の state（`diverged` / `detached` / SHA 比較 / ancestor 判定）には触らない — scope を広げない
- `--force` / `CMUX_TEAM_SKIP_SYNC_CHECK=1` / `--skip-fetch` の bypass 手段は変更なし
