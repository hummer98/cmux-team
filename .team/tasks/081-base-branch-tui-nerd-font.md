---
id: 081
title: タスクに base_branch フィールド追加 + TUI 表示（Nerd Font ブランチアイコン）
priority: medium
created_at: 2026-04-05T02:42:21.680Z
---

## タスク
## 概要
タスクにマージ先ブランチ（base_branch）を明示的に指定できるようにし、TUI ダッシュボードに表示する。

## 要件

### 1. タスクに base_branch フィールド追加
- `create-task` CLI に `--base-branch` オプション追加
- タスクファイルの frontmatter に `base_branch` フィールドを保存
- 省略時は未指定（暗黙的に main）

### 2. TUI ダッシュボードでの表示
- `TaskSummary` (daemon.ts) に `baseBranch?: string` 追加
- `buildTaskRow()` (dashboard.tsx) でブランチ名を表示
- **Nerd Font アイコン `` を使用**（U+E0A0, Powerline Branch）
- Nerd Font 未インストール環境のフォールバックとして `⎇` (U+2387) を使用
- 表示例: `● T042 [running]  main  認証機能追加  3:20`
- base_branch 未指定時は表示しない

### 3. Conductor テンプレートへの反映
- `conductor-task.md` のマージ手順で `base_branch` を参照
- 未指定時は現在と同じ動作（暗黙的に main）

### 4. README 更新
- README.md / README.ja.md に Nerd Font 推奨の記述を追加
- brew でのインストール方法を記載:
  ```
  brew install font-hack-nerd-font
  ```
- Nerd Font がなくても動作する旨（⎇ にフォールバック）を併記

## 対象ファイル
- `skills/cmux-team/manager/daemon.ts` — TaskSummary
- `skills/cmux-team/manager/dashboard.tsx` — buildTaskRow
- `skills/cmux-team/manager/task.ts` — タスク読み込み
- `bin/cmux-team.js` — CLI (create-task)
- `skills/cmux-team/templates/conductor-task.md` — マージ手順
- `README.md` / `README.ja.md` — Nerd Font 推奨記述
