# タスク割り当て

## タスク内容

---
id: 263
title: CONDUCTOR_DONE --success=false 時の worktree/branch を daemon が削除しないようにする
priority: high
depends_on: [262]
created_by: surface:199
created_at: 2026-04-19T03:16:30.475Z
---

## タスク
## 背景

T262 で発生した事例:

1. Conductor は Inspector GO 判定まで完了していた（task-262-1776560393 配下に plan/design/impl/inspection.md すべて残存）
2. 何らかの理由で Conductor が \`CONDUCTOR_DONE --success false\` を送信（ログ: \`conductor_error C[192]\` reason なし）
3. daemon の \`handleConductorDone\` が \`resetConductor\` を呼び、worktree と branch 削除を試行
4. branch は \"not fully merged\" で削除失敗、worktree は削除成功
5. task-state.json の T262 は \`assigned\` のまま取り残される
6. その後 daemon.ts 編集による auto-restart で \`resume_fallback_to_ready\` が発火し、最初からやり直しが開始された

## 仕様と実装の矛盾

\`skills/cmux-team/templates/ja/conductor-role.md:462-480\` (Step 9.5 rebase 衝突) には以下が明記されている:

> rebase がコンフリクトで失敗した場合 → 自動解決を試みず、即座に abort して判断必要レポートを返す
> - worktree は削除せず残す（人間が手動で rebase / 再投入できるよう）
> - タスク状態: \`assigned\` のまま残ります
> - 完了通知は \`--success false\` で送信する
> - **この場合 \`close-task\` は呼ばない。**

しかし実装 (\`skills/cmux-team/manager/conductor.ts:558 resetConductor\`) は success 値や task-state を見ず、無条件で worktree/branch 削除を試みる。

## やること（実装方針）

1. **\`resetConductor\` に \`preserveWorktree\` オプションを追加**
   - \`skills/cmux-team/manager/conductor.ts:600-618\` の worktree remove / branch delete ブロックを \`if (!opts?.preserveWorktree)\` で囲む
   - ConductorState のリセット（status=idle, taskRunId=undefined 等）は従来通り行う
   - preserveWorktree=true の場合、conductor 側の taskRunId/worktreePath は undefined にするが、fs 上の worktree と git branch は残す

2. **\`handleConductorDone\` で task-state を見て分岐**（\`skills/cmux-team/manager/daemon.ts:2704 付近\`）
   - task-state.json を読み、当該 taskId の status を確認
   - \`closed\` / \`aborted\` → 従来通り full cleanup（Conductor が明示的に決着済み）
   - \`assigned\` のまま → \`preserveWorktree=true\` で reset し、worktree/branch を温存
   - 後者の場合、ログは \`conductor_done_unresolved\` に分岐（下記 4）

3. **CONDUCTOR_DONE の success 値も判定材料に使う**
   - success=false なら task-state=assigned でも preserveWorktree=true にする保守側倒し
   - success=true で task-state=assigned の場合は現在のバグ想定外なので error ログ + full cleanup で従来動作維持（もしくは現状維持）
   - 挙動の表を plan.md で明示すること

4. **ログ分岐** (\`daemon.ts:2717\`)
   - success=true → \`task_completed task_id=<X> ...\`（従来通り）
   - success=false → \`conductor_done_unresolved task_id=<X> reason=<...>\` （task-state を closed に遷移させないことを明示）
   - ユーザーが grep で \"実際に closed に遷移したタスク\" と \"unresolved のまま残ったタスク\" を区別できるようにする

## 調査してほしい点

- \`resetConductor\` の呼び出し箇所が他にも複数ある（\`handleConductorDone\`, \`CONDUCTOR_CLEAR\`, disconnect_timeout 等）。preserveWorktree オプションの default は false（従来動作維持）とし、\`handleConductorDone\` の unresolved 経路だけで true を渡すのが最小侵襲
- success=false を Conductor が送信する documented な経路は rebase 衝突のみか？ 他の経路（abort-task / restart-task）は明示的に \`close-task\` or \`abort-task\` CLI を先に呼ぶ → task-state が closed/aborted に遷移済みなので新ロジックでも誤動作しないはず
- \`conductor-fsm.ts\` が T262 1 回目で導入済み（純粋関数化）だが、**merge 前にブランチ上に存在するだけ**。本タスクの修正は daemon.ts/conductor.ts 側の直接修正でよい（fsm 経由にするかは implementer 判断）

## 期待する完了状態

- \`CONDUCTOR_DONE --success false\` を受信しても worktree/branch が残る
- task-state は \`assigned\` のまま維持され、人間が \`abort-task\` or \`git merge\` を選べる
- ログから \"unresolved で残っているタスク\" を後追いできる
- 既存の正常系（close-task → CONDUCTOR_DONE --success true）は挙動変化なし
- bun test 全通過

## 参考ファイル

- skills/cmux-team/manager/conductor.ts:558 (resetConductor)
- skills/cmux-team/manager/daemon.ts:1267 (CONDUCTOR_DONE handler)
- skills/cmux-team/manager/daemon.ts:2704 (handleConductorDone)
- skills/cmux-team/templates/ja/conductor-role.md:462 (Step 9.5 仕様)
- 今回の事例ログ: .team/logs/manager.log \"T262\" 11:23 前後


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-263-1776570428` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-263-1776570428
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-263-1776570428/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/263-conductor-done-success-false-worktree-branch-daemon/runs/task-263-1776570428
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/263-conductor-done-success-false-worktree-branch-daemon/runs/task-263-1776570428/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら:

1. セッション上に完了レポートを表示する（conductor-role.md「完了時の処理」Step 12 参照。設計判断・試行錯誤・自己判断・懸念・成果の勘所を簡潔に出力）
2. 完了通知を送信する:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
   ```
