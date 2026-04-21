---
id: 264
title: resume_fallback_to_ready を安全化する（assigned + worktree 不在 → aborted へ）
priority: high
depends_on: [263]
created_by: surface:199
created_at: 2026-04-19T03:16:55.924Z
---

## タスク
## 背景

T262 の事例で、daemon 再起動時に以下のログが出力され、Inspector GO 判定済みの成果が自動破棄された:

\`\`\`
11:45:04 resume_fallback_to_ready task_id=262 reason=no_worktree
         worktreePath=.worktrees/task-262-1776560393
         sessionId=present taskRunId=task-262-1776560393
11:45:05 worktree_created branch=task-262-1776566705/task ...  # 最初からやり直し
\`\`\`

task-state が \`assigned\` なのに worktree が存在しない状態を、daemon は **無条件で \`ready\` に差し戻して再走させる**。実際には 1 回目の成果（plan v2 Approved / Inspector GO / 644 test pass）が .team/tasks/262-conductor/runs/task-262-1776560393/ に残っており、再走不要だった。

T263 の修正が入れば worktree が消える経路は原則なくなるが、以下の残存ケースで \`resume_fallback_to_ready\` が危険に働き続ける:

1. T263 修正前の旧 state（assigned + worktree 不在）から起動した場合
2. ユーザーが手動で worktree を \`git worktree remove --force\` した場合
3. 何らかのバグで worktree だけ消えた場合

## やること（実装方針）

1. **\`resume_fallback_to_ready\` を廃止し \`resume_marked_aborted\` に置き換える**
   - 該当箇所（\`skills/cmux-team/manager/daemon.ts\` の resume 時ロジック。grep で \`resume_fallback_to_ready\` を検索）
   - 従来: task-state[id].status = \"ready\" + assigned フィールド delete
   - 新: task-state[id].status = \"aborted\"
         + abortedAt=now
         + journal=\`[resume] lost worktree (taskRunId=<...>). artifacts preserved at .team/tasks/<slug>/runs/<taskRunId>/\`
   - ログ: \`resume_marked_aborted task_id=<X> reason=no_worktree taskRunId=<...>\`
   - 自動的な再走を止め、人間が中身を確認して \`restart-task\` するか手動マージするかを判断できるようにする

2. **artifact preservation メッセージ**
   - journal に旧 taskRunId と runs ディレクトリパスを含め、人間がすぐ成果物にアクセスできるようにする

3. **テスト追加**
   - resume 時に assigned + worktree 不在 → aborted に遷移すること
   - journal に旧 taskRunId が記録されること
   - ready 差し戻しが発生しないこと

## 調査してほしい点

- \`resume_fallback_to_ready\` の呼び出し元と、前段の条件（他にも fallback 経路があるなら整理）
- T263 先行マージ済の前提で進める（depends_on: 263）。T263 の preserveWorktree 経路が入れば、正常系で worktree が消えるケースがほぼなくなる
- restart-task コマンドの存在確認（aborted → ready 戻しの人間向け手段）

## 期待する完了状態

- assigned + worktree 不在のタスクは自動的に aborted に遷移し、再走しない
- 旧成果物パスが journal で確認できる
- bun test 全通過

## 参考ファイル

- skills/cmux-team/manager/daemon.ts の resume ロジック
- skills/cmux-team/manager/main.ts の restart-task CLI
- 今回の事例ログ: .team/logs/manager.log \"resume_fallback_to_ready\" 11:45 前後
