# タスク割り当て

## タスク内容

---
id: 403
title: metrics: api_usage の task_id 解決の調査・修正
priority: medium
created_by: surface:510
created_at: 2026-04-30T16:09:11.030Z
---

## タスク
## 背景

T379 (cmux-team metrics サブコマンド + hook_signals 棚卸し) の inspection で発見された minor 指摘 #2。

`api_usage` テーブルの `task_id` が全件 NULL のため、`cmux-team metrics` の per-task `tokens` 集計が常に 0 になる。

実測 (T379 worktree から):
```sql
SELECT COUNT(*) AS total, SUM(task_id IS NULL) AS null_task_id FROM api_usage;
-- 12,583 rows, 12,583 NULL
```

集計ロジック自体は in-memory fixture テストで正しく動作するため T379 のスコープ外として別タスク化。

## 調査範囲

- `skills/cmux-team/manager/proxy.ts` の task_id 解決ロジック（T305 で追加）
- 解決失敗のパス（surface → role → task_id の lookup chain）
- 本リポジトリ運用の特定設定差異（pool key モード等）

## 期待される成果

1. `api_usage.task_id` が解決される条件を特定
2. 修正可能なら `proxy.ts` の resolution ロジックを fix
3. 修正不能（外部要因）なら `.team/artifacts/` に research を残す

## 関連

- 親タスク: T379 (cmux-team metrics + hook_signals 棚卸し)
- 関連 commit: T305 (api_usage に task_id 列追加)


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-403-1777576769` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-403-1777576769
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-403-1777576769/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/403-metrics-api-usage-task-id/runs/task-403-1777576769
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/403-metrics-api-usage-task-id/runs/task-403-1777576769/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
