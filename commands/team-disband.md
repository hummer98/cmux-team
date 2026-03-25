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
   - `git worktree list` で `.worktrees/` 内の worktree を列挙
   - 各 worktree について未マージの変更を確認:
     ```bash
     cd <worktree-path>
     UNMERGED=$(git log --oneline main..HEAD 2>/dev/null)
     if [ -n "$UNMERGED" ]; then
       echo "WARNING: 未マージの変更があります: <worktree-path>"
       echo "$UNMERGED"
     fi
     ```
   - **未マージの変更がある場合**: ユーザーに警告を表示し確認を求める。`$ARGUMENTS = "force"` の場合のみスキップして強制削除
   - **未マージの変更がない場合**: `git worktree remove <path>` で削除（`--force` 不要）
   - 対応するブランチを `git branch -d` で削除（マージ済みのみ。未マージは `-d` が失敗するので安全）

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
