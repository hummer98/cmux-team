# タスク割り当て

## タスク内容

---
id: 366
title: pool capacity を 5h / 7d 別表示に変更
priority: medium
created_at: 2026-04-27T06:17:11.253Z
---

## タスク
## Context

現状 pool capacity はトークンごとに `min(5h候補, 7d候補)` を取って合計した単一数値（例: 352%）で表示されているが、5h ウィンドウと 7d ウィンドウのボトルネックがどちらか分からない。

## 変更内容

`computePoolCapacity` を 5h / 7d 別に合計を計算するよう変更し、以下の形式で表示する:

- TUI ヘッダー（pool-header-display.ts）: `pool capacity: 5h 120% / 7d 80%`
- CLI status（pool-status-header.ts）: 同様の形式
- 色分けは `min(5h, 7d)` をベースに既存閾値（>=100% GREEN / >=40% YELLOW / <40% RED）を維持

## 変更ファイル

- `token-store.ts`: `PoolCapacityResult` に `capacity_5h_pct` / `capacity_7d_pct` を追加
- `pool-status-header.ts`: `PoolHeaderInput.capacityPct` → `capacity5hPct` + `capacity7dPct`
- `pool-summary.ts`: header 構築を新型に変更
- `dashboard.tsx`: `buildPoolHeader` の色分けを `min(5h, 7d)` ベースに
- `pool-header-display.ts`: TUI ヘッダー表示を更新
- テスト: `pool-status-header.test.ts` を新型に合わせて更新


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-366-1777275302` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-366-1777275302
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-366-1777275302/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/366-pool-capacity-5h-7d/runs/task-366-1777275302
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/366-pool-capacity-5h-7d/runs/task-366-1777275302/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
