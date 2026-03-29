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
   TypeScript Manager プロセスに SHUTDOWN メッセージを送信:
   ```bash
   # SHUTDOWN キューメッセージを送信
   cmux-team stop

   # プロセスが終了するまで待機（最大 15 秒）
   MANAGER_PID=$(python3 -c "import json; d=json.load(open('.team/team.json')); print(d.get('manager',{}).get('pid',''))")
   for i in $(seq 1 15); do
     kill -0 $MANAGER_PID 2>/dev/null || break
     sleep 1
   done

   # まだ生きていたら SIGTERM
   kill $MANAGER_PID 2>/dev/null || true

   # Manager ペインを閉じる
   MANAGER_SURFACE=$(python3 -c "import json; d=json.load(open('.team/team.json')); print(d.get('manager',{}).get('surface',''))")
   cmux close-surface --surface $MANAGER_SURFACE 2>/dev/null || true
   ```

6. **ステータスクリア**
   - cmux clear-progress
   - cmux のサイドバーステータスをすべてクリア

7. **team.json 更新**
   daemon の stop コマンド（手順5）が team.json の状態を自動更新する（phase: "disbanded" 等）。直接書き込みは不要。

8. サマリー表示

## 引数

$ARGUMENTS = "force" → グレースフル終了をスキップし即座にペインクローズ

## 注意事項

- .team/ ディレクトリ自体は削除しない
- マージされていない worktree ブランチがある場合は警告を表示
