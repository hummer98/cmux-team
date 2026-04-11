# タスク割り当て

## タスク内容

---
id: 161
title: cmux-team start 時に .team/.gitignore を自動生成する
priority: medium
created_at: 2026-04-11T18:14:59.507Z
---

## タスク
## 背景

.team/ 配下にはgit追跡すべきファイル（tasks/, artifacts/, specs/, task-state.json）とセッション固有の一時ファイル（logs/, output/, traces/ 等）が混在している。現状はプロジェクトごとに .gitignore を手動設定しており、統一されていない。

## やること

`cmux-team start` 時（daemon 初期化の .team/ ディレクトリ作成タイミング）に `.team/.gitignore` を自動生成する。

### .team/.gitignore の内容

```gitignore
# セッション固有（追跡不要）
team.json
master.surface
proxy-port
logs/
output/
prompts/
queue/
traces/
sessions/
conductors/
docs-snapshot/
e2e-results/

# 追跡すべき（上記以外）
# tasks/        — タスク定義・runs の成果物
# artifacts/    — 知見の記録
# specs/        — 要件・設計
# task-state.json — タスク状態（resume に必要）
```

### 実装方針

- daemon.ts の初期化処理（.team/ ディレクトリ作成直後）で .team/.gitignore を書き出す
- 既に .team/.gitignore が存在する場合は上書きしない（ユーザーがカスタマイズしている可能性）
- 親プロジェクトの .gitignore は変更しない

### 副作用

- 既存プロジェクト（Dear 等）の .gitignore から .team 関連エントリは手動で削除可能になる（.team/.gitignore が担うため）


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-161-1775931299` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-161-1775931299
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-161-1775931299/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/161-cmux-team-start-team-gitignore/runs/task-161-1775931299
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/161-cmux-team-start-team-gitignore/runs/task-161-1775931299/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら:

1. セッション上に完了レポートを表示する（conductor-role.md「完了時の処理」ステップ 8 参照。設計判断・試行錯誤・自己判断・懸念・成果の勘所を簡潔に出力）
2. 完了通知を送信する:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
   ```
