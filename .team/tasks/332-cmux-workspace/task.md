---
id: 332
title: 新プロジェクト: cmux に開発用 workspace を作成
priority: medium
created_at: 2026-04-25T21:49:37.973Z
---

## タスク
## 前提
T330（clone + claude-trust）および T331（docs/seed.md）が完了していること。

## 手順
1. `cmux workspace add <project-name> ~/git/<project-name>` で workspace 登録
2. 開発用ペイン構成を作成（cmux split で editor + terminal + ログペイン）
3. ~/git/<project-name>/ で `cmux-team init` または相当する初期設定

## 補足
- using-cmux スキルを参照して操作を行う
- workspace 名はプロジェクト名と一致させる

## 完了条件
- cmux に <project-name> workspace が存在する
- ~/git/<project-name>/ で Claude Code が起動できる状態になっている
