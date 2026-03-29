---
id: 021
title: Conductor ペインの自動クローズを廃止
priority: high
status: ready
created_at: 2026-03-27T12:45:00+09:00
---

## タスク

`collectResults()` で Conductor のペインを自動的に閉じる処理を削除する。
現状は Conductor 完了時に `/exit` → `closeSurface` でペインが消えるため、ユーザーが結果を確認できず、Agent ペインだけが孤立する問題がある。

### 変更内容

`conductor.ts` の `collectResults()` から以下を削除:

1. `/exit` の送信（`cmux.send(conductor.surface, "/exit\n")`）
2. exit 画面からの session_id 取得（`cmux.readScreen` → regex マッチ）
3. `cmux.closeSurface(conductor.surface)` 呼び出し

session_id の取得は Stop hook（タスク 020）で代替する。それまでは session_id なしで動作させる。

worktree クリーンアップとタスクの closed 移動はそのまま残す。

## 対象ファイル

- `skills/cmux-team/manager/conductor.ts` — `collectResults()` からペインクローズ処理を削除

## 完了条件

- Conductor 完了後もペインが残り、ユーザーが作業履歴を確認できる
- worktree クリーンアップとタスククローズは従来通り動作する
- Agent ペインが孤立しない（Conductor と並んで残る）
