---
id: 239
title: cmux-team resume の cwd バグ修正（worktree → PROJECT_ROOT）
priority: high
created_by: surface:47
created_at: 2026-04-17T07:56:46.304Z
---

## タスク
## 症状

`cmux-team resume <task-id>` 実行時に Conductor セッションが見つからず失敗する:

```
No conversation found with session ID: 3543f81a-9d7d-4534-b7c3-8409de34139a
```

daemon 再起動時の boot 経路（`task_resumed ... (via boot)`）で assigned タスクの Conductor を復帰できない。

## 原因

Conductor の通常起動（`cmdConductor`）は `cwd: PROJECT_ROOT` で claude を exec するため、Claude はセッション JSONL を `~/.claude/projects/-<PROJECT_ROOT をスラッシュ置換>/` に保存する。

一方 `cmdResume` は `cwd: ts.worktreePath` で `claude --resume` を exec しているため、Claude は別の project dir（worktree 側）を探しにいってヒットしない。

### 該当箇所

`skills/cmux-team/manager/main.ts:1845`

```typescript
execFileSync("claude", [
  "--resume", ts.sessionId,
  "--dangerously-skip-permissions",
  "--settings", conductorSettingsPath,
  "--model", model,
], {
  stdio: "inherit",
  env: process.env,
  cwd: ts.worktreePath,   // ← バグ: PROJECT_ROOT にすべき
});
```

参考: `cmdConductor` は `cwd: PROJECT_ROOT`（main.ts:1769）。

## 修正方針

`cwd: ts.worktreePath` → `cwd: PROJECT_ROOT` に変更する。

Conductor は project root で動作し、Agent のみ worktree 内で動作するという設計に合わせる。`cmdResume` は Conductor セッションを復帰するためのコマンドなので PROJECT_ROOT が正しい。

## 検証

1. 修正版をビルド
2. Dear（or 任意の assigned タスク持ち project）で daemon を再起動
3. `task_resumed ... (via boot)` のログと共に Conductor の Claude が正常に resume されること
4. Conductor surface に `No conversation found` が出ないこと

## 関連

- インストール版 v3.52.0 で再現（~/git/Dear）
- 該当 surface: workspace:2 の surface:48 / surface:49
- 影響: daemon 再起動時に assigned 状態のタスクが復帰不能（ready に fallback される / 手動介入が必要）

