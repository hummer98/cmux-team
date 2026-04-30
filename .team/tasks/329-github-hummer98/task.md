---
id: 329
title: 新プロジェクト: GitHub リポジトリ作成 (hummer98)
priority: medium
created_at: 2026-04-25T21:49:12.018Z
---

## タスク
## 前提
T328（プロジェクト名決定）が完了していること。

## 手順
1. `gh repo create hummer98/<project-name> --public --description '...' `
2. topics 設定: `agent-skills`, `declarative-cli`, `ai-agent`
3. main ブランチ初期化（README.md + LICENSE + .gitignore(Go) を push）
4. リポジトリ URL を次タスク（T_CLONE）の body に記録

## 完了条件
- hummer98/<project-name> が GitHub に存在する
- main ブランチに初期コミットがある
- タスク T_CLONE（clone + claude-trust）を ready に昇格する
