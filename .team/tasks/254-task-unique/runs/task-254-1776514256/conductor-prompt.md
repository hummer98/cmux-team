# タスク割り当て

## タスク内容

---
id: 254
title: Task の二重起動を防ぐ unique 制約を不変条件として検査
priority: medium
created_by: surface:47
created_at: 2026-04-17T18:26:23.187Z
depends_on: [251]
---

## 背景

A015 の実装タスク (a) Task 二重起動対策。

**スコープ**: 本タスクは `assignTask` の unique 制約と起動時整合性チェックに絞る。resume_fallback_to_ready の再設計や resume 条件の緩和は別タスクで扱う。

現状、同一 taskId が複数 Conductor で同時 running になるリスクがある。`scanTasks` は tick 内で直列なので通常経路での race 窓は狭いが、以下の場面で防御が欲しい:

- daemon 再起動時の resume パスでの整合性崩れ
- 外部プロセス（CLI 直接実行等）による task-state.json 書換
- 将来の並列化リファクタで race が再発生するリスクへの保険

**注意（既実装の再利用）**:
- `task-state.json` の atomic 書き込みは `saveTaskState` (`task.ts:126-131`) で `.tmp + rename` として既に実装済み。本タスクで再実装しない
- broken 状態は T250 で導入済み。fail-stop 先として流用する（T251 で surface 消失時の broken 化が入る前提）

## やること

1. **assignTask 先頭の unique 検査** (`conductor.ts:258`)
   - task-state.json を再読込し、対象 taskId が既に `assigned` かつ別 Conductor surface に紐づいていないか検査
   - 違反を検出したら `AssignTaskError("task", "task_already_assigned_to=<surface>")` を throw
   - scanTasks 側の既存エラーハンドリング経路で task を abort、idle Conductor は維持
2. **起動時の整合性チェック** (`main.ts:cmdStart` の resumePlan 構築時)
   - task-state.json の `status=assigned` エントリと team.json の conductors を cross-check
   - 同一 taskId が複数 Conductor に紐づいている場合は、該当 Conductor を broken で復元し、task は journal 付きで ready に戻す（人間の介入待ち）
   - 違反ログ: `task_unique_violation task_id=<id> existing_surface=<s1> conflict_surface=<s2>`
3. **判断フロー**: A015 方針に従い fail-stop を基本にする
   - 該当 Conductor のみ broken 化（daemon 全停止はしない）
   - 既存の別 Conductor は触らない（feedback_error_recovery — 自動 reopen/reset しない）

## 判断が必要なポイント

- 起動時チェックで team.json と task-state.json が食い違う具体パターンの列挙（手動編集、並行 daemon 起動、clock drift 等）
- 「task-state では assigned だが team.json に対応 Conductor エントリが無い」ケースの扱い（ready に戻すか、journal 付き abort か）

## スコープ外（別タスクで扱う）

- `main.ts:601` `resume_fallback_to_ready` の再設計（「元 Conductor 生存時は ready 化しない」等）
- resume 条件の緩和（「worktree 残 + session 生存」で resume を試みる等）
- atomic 書き込み実装（既実装のため）

## 参考

- A015 「決定」1 項「Unique 制約の明示」
- `main.ts:601` resume_fallback_to_ready（行番号は旧 task.md の 666 から修正済）
- `daemon.ts:1822` scanTasks / `daemon.ts:1932` assignTask 呼び出し
- `conductor.ts:258` assignTask
- `task.ts:126-131` saveTaskState（既 atomic）
- 依存: T251（resetConductor surface 実在確認 + broken 化）


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-254-1776514256` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-254-1776514256
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-254-1776514256/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/254-task-unique/runs/task-254-1776514256
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/254-task-unique/runs/task-254-1776514256/summary.md` に書き出す。

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
