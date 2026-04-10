# タスク割り当て

## タスク内容

---
id: 126
title: 補足: spawn-conductor の --surface 引数を削除
priority: medium
depends_on: [125]
created_at: 2026-04-10T07:09:02.103Z
---

## タスク
T125 の補足。spawn-conductor は現在の surface で起動するため、--surface 引数自体が不要。

## やること

- `cmdSpawnConductor()` から `--surface` と `--direction` 引数のパースを削除
- surface は環境変数 `CMUX_SURFACE` または `cmux identify` で自動取得
- help テキストも更新
- `spawnSingleConductor()` のシグネチャから direction, parentSurface を削除（T125 で残っていれば）


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-126-1775805609` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-126-1775805609
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-126-1775805609/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/126-spawn-conductor-surface/runs/task-126-1775805609
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/126-spawn-conductor-surface/runs/task-126-1775805609/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら、最後に:
```bash
cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
```
