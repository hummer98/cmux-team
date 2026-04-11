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
