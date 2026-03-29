---
id: 1774711261
title: タスク定義と状態の分離: tasks/ をフラット化し状態を daemon 管理に移行
priority: high
status: ready
created_at: 2026-03-28T19:17:48.955Z
---

## タスク
## 背景

タスクファイルが定義（title, body, priority）と状態（status, journal, closedAt）を混在させており、worktree マージ時に状態が巻き戻る問題がある。

## やること

### 1. タスクファイルを定義のみに限定
- .team/tasks/*.md はフラットな1ディレクトリに統一（open/ / closed/ の分割を廃止）
- タスクファイルには title, body, priority のみ記載（status, journal, closedAt は含めない）
- 既存の open/ と closed/ のファイルを tasks/ 直下に移動

### 2. タスク状態を daemon 管理に移行
- .team/task-state.json（gitignored）でタスク状態を管理
- 構造例: { "1774711252": { "status": "closed", "closedAt": "...", "journal": "..." } }
- daemon 起動時に task-state.json がなければ、既存ファイルの frontmatter から初期状態を構築

### 3. 影響範囲の修正
- main.ts: create-task, update-task, close-task コマンドを新構造に対応
- daemon.ts の scanTasks: open/ ではなく task-state.json を参照
- task.ts の loadTasks / filterExecutableTasks: 新構造に対応
- conductor テンプレートの close-task 呼び出し: journal は task-state.json に記録
- dashboard.tsx: taskList の構築ロジックを新構造に対応
- initInfra: tasks/open, tasks/closed の mkdir を tasks/ 一本に変更

### 4. .gitignore の整理
- .team/.gitignore から tasks/ を削除（定義は git tracked に戻す）
- 代わりに task-state.json を追加

### 5. 既存データの移行
- open/ と closed/ のファイルを tasks/ 直下にコピー
- frontmatter から status 情報を読み取って task-state.json を生成
- 移行後に open/ と closed/ ディレクトリを削除

## 完了条件
- tasks/ がフラットな1ディレクトリで定義のみ含む
- タスク状態が .team/task-state.json で管理されている
- worktree マージでタスク状態が巻き戻らない
- TUI の Tasks セクションが正しく表示される
- create-task, update-task, close-task が新構造で動作する
- 既存テストがパスする
