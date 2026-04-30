# タスク割り当て

## タスク内容

---
id: 367
title: pool有効時のTHROTTLE判定をpool-awareに変更
priority: medium
created_at: 2026-04-27T06:45:24.189Z
---

## タスク
## 問題

pool有効時でも THROTTLE 判定が `state.rateLimit`（最後のAPIレスポンスで観測した単一アカウントの5h utilization）を参照しているため、pool全体に余裕があっても1アカウントの5hが90%を超えると THROTTLED になってしまう。

## 影響箇所

- `spawn-agent` throttle ガード（main.ts: /rate-limit エンドポイント問い合わせ）
- `scanTasks` throttle ガード（daemon.ts: state.rateLimit 参照）
- dashboard/statusline の ⏸ 表示（daemon.ts）

## 変更方針（案）

pool が有効な場合、THROTTLE 判定に `state.rateLimit` ではなく pool の状態（tokens.db の各アカウントの utilization）を使う:

- pool 内に selectable かつ 5h utilization < 90% のアカウントが1つ以上あれば THROTTLED にしない
- pool が無効な場合は従来通り `state.rateLimit` の5h utilization >= 90% で判定

`/rate-limit` エンドポイントのレスポンスにも pool-aware な `throttled` 値を返す。


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-367-1777275313` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-367-1777275313
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-367-1777275313/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/367-pool-throttle-pool-aware/runs/task-367-1777275313
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/367-pool-throttle-pool-aware/runs/task-367-1777275313/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
