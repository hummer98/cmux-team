---
id: 252
title: initializeLayout で PID 死亡 Conductor の残骸掃除を先行させる
priority: medium
created_by: surface:47
created_at: 2026-04-17T18:26:01.606Z
---

## タスク
## 背景

A015 の実装タスク (b) Surface 二重起動対策。

現状 `initializeLayout` (`daemon.ts:810` 付近) は team.json 復元時に
PID 死亡 Conductor を `conductor_restore_skipped reason=pid_dead` で
**スキップ** して新規 pane 作成に進む。

このとき旧 surface の pane がまだ残っていても掃除されないため、
pane 二重化 + 同一 worktree を 2 プロセスが触るリスクが残る。

## やること

1. `initializeLayout` で PID 死亡検出時に、既存 pane の存在確認を行う
2. 残骸 pane が存在すれば `cmux.closeSurface` で閉じる
3. 関連する worktree が生きているかも確認し、所有プロセスの生死を
   ログに残す（削除はしない — `feedback_error_recovery` に従い判断は人間に委ねる）
4. 掃除完了後に新規 pane 作成 or resume に進む

## 判断が必要なポイント

- pane 閉鎖は安全か（pane に別プロセスが載っている可能性への対応）
- PID 死亡だが pane 存在 + 生きたプロセス連結のケースの扱い
- 「掃除に失敗したら fail-stop」とするか、best-effort で進めるか
  （A015 方針に照らすと fail-stop 寄り）

## 参考

- A015 「現状コードの逸脱箇所インデックス」(b) 項
- `daemon.ts:782` initializeLayout
