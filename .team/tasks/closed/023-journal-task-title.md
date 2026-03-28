---
id: 023
title: ジャーナルにタスクタイトルを表示
priority: medium
status: ready
created_at: 2026-03-28T00:00:00+09:00
---

## タスク

TUI ジャーナルの各エントリにタスクタイトルを表示する。現状は task_id と conductor_id しか表示されず味気ない。

### 変更内容

#### 1. ログ出力に `title=` を追加

- `conductor.ts` の `conductor_started` ログ（現在 141行目付近）:
  ```
  task_id=${taskId} conductor_id=${conductorId} surface=${surface} title=${taskTitle}
  ```

- `daemon.ts` の `task_completed` ログ（現在 256行目付近）:
  ```
  task_id=... conductor_id=... title=${conductor.taskTitle} session=... ...
  ```

- `daemon.ts` の `task_received` ログも可能であればタイトルを追加（タスクファイルを読んで取得）

#### 2. ジャーナルパーサーでタイトルを抽出・表示

`dashboard.tsx` の `useJournalEntries()` で:
- `detail` から `title=(.+?)(?:\s+\w+=|$)` でタイトルを抽出
- `JournalEntry.message` にタイトルを設定

#### 3. 表示フォーマット

変更前: `17:51 [▶] #19 conductor-1774597886 started`
変更後: `17:51 [▶] #19 ダッシュボード TUI に Tasks/Todos セクションを追加`

変更前: `17:57 [✓] #19 task_id=19 conductor_id=conductor-1774597886 session=...`
変更後: `17:57 [✓] #19 ダッシュボード TUI に Tasks/Todos セクションを追加`

## 対象ファイル

- `skills/cmux-team/manager/conductor.ts` — `conductor_started` ログに title 追加
- `skills/cmux-team/manager/daemon.ts` — `task_completed` / `task_received` ログに title 追加
- `skills/cmux-team/manager/dashboard.tsx` — ジャーナルパーサーで title を抽出して表示

## 完了条件

- ジャーナルの各エントリにタスクタイトルが表示される
- タイトルがない場合は従来通り conductor_id 等で表示（フォールバック）
