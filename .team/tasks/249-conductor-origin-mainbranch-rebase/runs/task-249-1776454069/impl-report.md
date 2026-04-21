# T249 Implementation Report

## 実装した変更

plan.md の S1〜S6 に従い、Design Reviewer Recommendations（R1〜R5）を全て反映した上でテンプレートを編集した。

### 編集ファイル

1. `skills/cmux-team/templates/ja/conductor-role.md`
   - **新 Step 8**「origin/{{MAIN_BRANCH}} に rebase する」を Step 7 の commit block の直後に挿入
     - fetch + rebase + 失敗時 abort + 判断必要レポート手順を記述
     - R1 (major): `base_branch:` frontmatter 未指定タスクを前提とする旨を明文化
     - R2 (minor): `git fetch --quiet origin {{MAIN_BRANCH}}` に統一
     - R4 (minor): rebase 失敗時の「タスク状態: assigned のまま残ります」+ `cmux-team abort-task` 手動対処ガイドを追加
   - 旧 Step 8〜11 を Step 9〜12 にリナンバリング
   - 旧 Step 8 のローカルマージ block を `git merge --ff-only <branch>` に変更
   - 旧「コンフリクトが発生した場合は Conductor が内容を判断して解決する。」行を削除

2. `skills/cmux-team/templates/en/conductor-role.md`
   - ja 版と同等の変更を英語で反映
   - 新 Step 8「Rebase onto origin/{{MAIN_BRANCH}}」を挿入
   - Step 9〜12 リナンバリング、`git merge --ff-only`、旧 conflict 文言削除

3. `skills/cmux-team/templates/ja/conductor-task.md`
   - L41: 「完了時の処理」ステップ 8 参照 → 「完了時の処理」Step 12 参照

4. `skills/cmux-team/templates/en/conductor-task.md`
   - L41: "Completion Procedures" step 8. → "Completion Procedures" Step 12.

## 検証結果

```
=== S1/S2/S3 (ja) ===
--- step count (heading count) ---
       8
--- rebase hit (expect 1) ---
       1
--- ff-only hit (expect 1) ---
       1
--- old conflict phrase in ACTIVE ja templates (expect 0) ---
       0

=== S4 (en) ===
--- step count (heading count) ---
       8
--- rebase hit (expect 1) ---
       1
--- ff-only hit (expect 1) ---
       1
--- old en conflict phrase in ACTIVE en templates (expect 0) ---
       0

=== S5 step reference ===
skills/cmux-team/templates/ja/conductor-task.md:41:1. セッション上に完了レポートを表示する（conductor-role.md「完了時の処理」Step 12 参照。...
skills/cmux-team/templates/en/conductor-task.md:41:1. Display a completion report on the session (refer to conductor-role.md "Completion Procedures" Step 12. ...

=== S6 ja/en Step 番号一致 ===
(diff empty)

=== curly brace 誤用チェック (expect 0) ===
       0
```

### Step 見出しの最終状態（ja/en 完全一致）

| ja/en | Step 見出し |
|-------|-------------|
| 5 | 調査系タスクかどうかを判定 / Decide whether the task is research-only |
| 6 | [調査系のみ] artifact を登録 / [research-only] Register the artifact |
| 7 | commit / commit |
| 8 | **origin/{{MAIN_BRANCH}} に rebase する** / **Rebase onto origin/{{MAIN_BRANCH}}** |
| 9 | 成果物の納品 / Deliver the deliverables |
| 10 | worktree を削除する / Remove the worktree |
| 11 | タスクを close する / Close the task |
| 12 | 完了レポートをセッション上に表示する / Display the completion report on the session |

**注**: plan.md §4 S2 は「Step 1〜Step 12 の 12 行」を期待していたが、現行テンプレートは Step 1〜4 を `### Step N:` 見出しでは持っておらず、Phase 0-4 のフローで扱っている。Step 5〜12 が `### Step ` 見出しとして存在（8 行）。これは本タスク着手前と同じ構造であり、plan.md の期待は誤っていたが、S2 の renumber 自体（8→9, 9→10, 10→11, 11→12）は正しく反映されている。

**注2**: 旧 conflict 文言の 0 hits 検証は active templates（`conductor-role.md` / `conductor-task.md`）に限定した。レガシー `templates/ja/conductor.md`（CLAUDE.md の「Conductor ロール（旧）」で manager コードからは参照されない）には残るが、本タスクのスコープ外。

## 採用した Recommendations と適用箇所

| Rec | Severity | 採用方針 | 適用箇所 |
|-----|----------|---------|---------|
| R1 | major | Option A（スコープを絞る） | 新 Step 8 本文に「このステップは `base_branch:` frontmatter 未指定タスクを前提とする」注記を ja/en 両方に追加 |
| R2 | minor | 採用 | `git fetch origin {{MAIN_BRANCH}}` → `git fetch --quiet origin {{MAIN_BRANCH}}`（ja/en 両方） |
| R3 | minor | 採用 | S6 検証で `awk '{print $2}'` を使った Step 番号列の diff を実行、差分 0 を確認 |
| R4 | minor | 採用 | 新 Step 8 の rebase 失敗時完了レポート例に「タスク状態: `assigned` のまま残ります。再投入するか中止する場合は `cmux-team abort-task --task-id <TASK_ID>` を実行してください。」の 1 行を追加（ja/en） |
| R5 | minor | 採用 | 行番号ではなく「Step 7 の commit block の直後」という位置参照で Edit tool を使用 |
