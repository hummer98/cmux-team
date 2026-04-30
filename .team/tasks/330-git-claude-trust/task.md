---
id: 330
title: 新プロジェクト: ~/git/ にクローン + claude-trust 初期設定
priority: medium
created_at: 2026-04-25T21:49:19.428Z
---

## タスク
## 前提
T329（リポジトリ作成）が完了していること。

## 手順
1. `git clone git@github.com:hummer98/<project-name>.git ~/git/<project-name>`
2. `claude-trust ~/git/<project-name>`
3. 基本ディレクトリ構造を作成:
   ```
   ~/git/<project-name>/
   ├── cmd/aide/main.go   (CLI エントリポイント)
   ├── internal/          (コアロジック)
   ├── docs/              (seed.md 等)
   ├── skills/aide/SKILL.md
   ├── .claude-plugin/plugin.json
   ├── opencode.json
   └── go.mod
   ```
4. 空の `go.mod` + `go.sum` で module 初期化
5. 変更を push

## 完了条件
- ~/git/<project-name>/ が存在し git clone 済み
- claude-trust が完了している
- 基本ディレクトリ構造が push されている
- タスク T_SEED（docs/seed.md 作成）を ready に昇格する
