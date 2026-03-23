---
allowed-tools: Bash, Read, Write, Edit
description: "全層を終了しチームを解散する"
---

# /team-disband

全層（Agent → Conductor → Manager）を bottom-up で終了してください。

## 手順

1. .team/team.json を読む（なければ未初期化を案内）
   稼働中の Conductor は `cmux tree` で確認する

2. **Layer 1: Agent 終了**
   各 Conductor の Agent を終了:
   - cmux send --surface <agent-surface> "/exit\n"
   - sleep 2
   - cmux close-surface --surface <agent-surface>

3. **Layer 2: Conductor 終了**
   各 Conductor を終了:
   - cmux send --surface <conductor-surface> "/exit\n"
   - sleep 2
   - cmux close-surface --surface <conductor-surface>

4. **Layer 3: git worktree クリーンアップ**
   - git worktree list で .worktrees/ 内の worktree を列挙
   - git worktree remove <path> --force で削除
   - 対応するブランチを git branch -D で削除

5. **Layer 4: Manager 終了**
   - cmux send --surface <manager-surface> "/exit\n"
   - sleep 2
   - cmux close-surface --surface <manager-surface>

6. **ステータスクリア**
   - cmux clear-progress
   - cmux のサイドバーステータスをすべてクリア

7. **team.json 更新**
   - phase: "disbanded"
   - manager: null
   - conductors: []

8. サマリー表示

## 引数

$ARGUMENTS = "force" → グレースフル終了をスキップし即座にペインクローズ

## 注意事項

- .team/ ディレクトリ自体は削除しない
- マージされていない worktree ブランチがある場合は警告を表示
