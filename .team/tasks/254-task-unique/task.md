---
id: 254
title: Task の二重起動を防ぐ unique 制約を不変条件として検査
priority: medium
created_by: surface:47
created_at: 2026-04-17T18:26:23.187Z
---

## タスク
## 背景

A015 の実装タスク (a) Task 二重起動対策。

現状、同一 taskId が複数 Conductor で同時 running になるリスクがある。
ready → assigned 遷移時の unique 制約が甘く、以下のレース条件で
二重起動が発生しうる:

- `resume_fallback_to_ready` (`main.ts:666`) で元 Conductor がまだ
  走っていないか確認せず ready 化 → 即再割当
- scanTasks → assignTask の間で状態ロード/書き出しの race
- 起動直後に旧 assigned が残っていて、新 Conductor と競合

## やること

1. `assignTask` 先頭で task-state.json を再読み込みし、対象 taskId が
   既に assigned/running 状態なら fail-stop（既存 Conductor surface をログに残す）
2. `resume_fallback_to_ready` の条件を見直し:
   - 元 Conductor surface が team.json に残っていて PID が生きている場合は
     ready 化せず broken 状態で保持
   - worktree が残っていて sessionId も生きているなら resume を試みる
3. task-state.json 書き込みを atomic に（一時ファイル + rename、または lock）
4. 起動時の整合性チェックで taskId が重複 assigned になっていないか検証

## 判断が必要なポイント

- unique 制約違反を発見した場合の fail-stop 粒度:
  daemon 停止まで行くか、該当 Conductor だけ broken に倒すか
- atomic 書き込みの実装方法（bun runtime での選択肢）
- 「Conductor PID は生きているが sessionId が空」のケースの扱い

## 参考

- A015 「決定」セクション 1 項
- `main.ts:666` resume_fallback_to_ready
- `daemon.ts` assignTask 経路
