# タスク割り当て

## タスク内容

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



## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-239-1776412606` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-239-1776412606
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-239-1776412606/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/239-cmux-team-resume-cwd-worktree-project-root/runs/task-239-1776412606
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/239-cmux-team-resume-cwd-worktree-project-root/runs/task-239-1776412606/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら:

1. セッション上に完了レポートを表示する（conductor-role.md「完了時の処理」ステップ 8 参照。設計判断・試行錯誤・自己判断・懸念・成果の勘所を簡潔に出力）
2. 完了通知を送信する:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
   ```
