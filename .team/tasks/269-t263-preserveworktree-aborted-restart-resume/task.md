---
id: 269
title: T263 preserveWorktree 経路でタスクを aborted に倒す（restart 時の誤 resume 防止）
priority: high
created_by: surface:199
created_at: 2026-04-19T06:40:51.363Z
---

## タスク
## 背景

T263 で導入した「CONDUCTOR_DONE --success=false 時に worktree/branch を preserve する」経路に設計の穴がある。

`handleConductorDone` の `unresolved` 分岐:
- `conductor_done_unresolved` ログを記録
- `resetConductor(..., { preserveWorktree: true })` で worktree/branch を温存
- **task-state.json の status は `assigned` のまま更新しない**

一方で T264 の `resume_marked_aborted` は `sessionId` / `taskRunId` / `worktreePath` / worktree 実在 の 4 条件すべてが満たされる場合のみ resume 対象と判定し、preserveWorktree 起因の「assigned だが Conductor は idle に戻っている」ケースを救済対象から除外してしまう。

## 実際に起きた事故（T266）

1. 2026-04-19 14:04:49 T266 で `conductor_done_unresolved` → worktree 温存、task 状態 assigned 維持
2. 後に `cmux-team start` / daemon 再起動が走る
3. `resumePlan` が T266 を含む（4 条件満たすため）
4. `planLayoutRestore` が idle な C[192] にマッチング → `cmux-team resume 266` 送信
5. 既存タスク（T267 直後）の /clear と重なって `user_clear` 検知 → `task_aborted`

結果: 本来「人間判断待ち」として保留されるべきタスクが、restart の度に勝手に abort される。

## 修正スコープ

### A. `handleConductorDone` の unresolved 分岐で task を aborted に倒す

`skills/cmux-team/manager/daemon.ts` の `handleConductorDone`:

```ts
} else if (unresolved) {
  await log("conductor_done_unresolved", ...);
  // 追加: task を aborted に遷移（worktree/branch は preserve されるので restart-task で再投入可能）
  await markTaskAborted(state.projectRoot, taskId, {
    reason: "judgment_pending",
    journal: `conductor_done_unresolved: ${opts?.reason ?? "-"} (worktree=${conductor.worktreePath})`,
  });
}
```

`markTaskAborted` は既存関数（`task_aborted` ログ + cascade を発火するやつ）を再利用。新規関数追加不要のはず。

### B. abort 経路の cascade 波及確認

CLAUDE.md §依存タスクの cascade より、aborted は `ready` 子を draft に戻す。T266 のような「レビューが後続にある」ケースで、後続タスクが ready のまま待機していた場合は draft に戻ることになる。この副作用は設計通りだが、テストで挙動確認する。

### C. ドキュメント更新

- `CLAUDE.md` の「T263: preserve worktree/branch when CONDUCTOR_DONE reports --success=false」節を更新
  - 「task state は `aborted` になる。worktree/branch は preserved」と明記
  - `cmux-team restart-task --task-id <X>` が再投入の正式導線であることを追記
- `skills/cmux-team/templates/ja/conductor-role.md` の Step 8 フォールバック記述
  - 「タスク状態: `assigned` のまま残ります」→「タスク状態: `aborted` になります（worktree は温存）」
  - 再投入導線として `restart-task` を明記
- 同 en 版も更新

### D. テスト追加

`skills/cmux-team/manager/daemon.test.ts` の T263 既存テスト群（Case #9, #10）に、task_state が `aborted` になることを検証する expect を追加。

## 受け入れ条件

- [ ] `handleConductorDone` の unresolved 分岐で task_state が `aborted` に遷移する
- [ ] journal / abortReason に `judgment_pending` 相当の識別子が入る
- [ ] daemon 再起動時に preserveWorktree された task が resume されない（既存 daemon.test.ts に統合テストを追加）
- [ ] `cmux-team restart-task --task-id <X>` で明示的再投入できる（既存コマンドの確認のみ）
- [ ] `preserveWorktree: true` の contract（worktree/branch は温存）は維持
- [ ] conductor-role.md ja/en の Step 8 フォールバック記述を更新
- [ ] CLAUDE.md の T263 関連記述を更新

## 関連

- T263（c5f5526 の直前の commit ee698d6）
- T264（resume_marked_aborted 導入）
- T268（Step 8/9 フォールバックの conflict 自動解消 — 本タスクと独立、並行可能）

## 補足

本タスクを入れると、T263 の「worktree を残すが task は open のまま」という微妙なセマンティクスが「worktree を残すが task は aborted」に変わる。意味論としては「Conductor が自力で完遂できなかった → aborted、成果物は残すから人間が見て判断して」となり直感に合う。
