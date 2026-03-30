---
id: 015
title: daemon の auto-restart 機能（コード更新時に自動再起動）
priority: medium
created_at: 2026-03-29T10:46:45.252Z
---

## タスク
daemon のソースコード更新時に Conductor を維持したまま daemon プロセスだけ自動再起動する。tick ループ内でソースファイルの mtime を監視し、変更検出時に exit code 42 で終了。起動ラッパーが exit code 42 を検知して自動再起動。team.json/task-state.json による状態復元と initializeLayout の既存 Conductor 検出は既存機能を活用。
