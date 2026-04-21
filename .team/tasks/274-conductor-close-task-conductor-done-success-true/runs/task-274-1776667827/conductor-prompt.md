# タスク割り当て

## タスク内容

---
id: 274
title: Conductor 完了通知を close-task に一本化（CONDUCTOR_DONE --success true 単体呼び出しを排除）
priority: medium
created_at: 2026-04-20T06:50:27.481Z
---

## タスク
## 背景

~/git/Dear の T204 が「TUI 上 [assigned]、manager.log 上 task_completed」という不整合状態で放置された（2026-04-19）。

調査の結果、Conductor が `cmux-team close-task` を呼ばずに `cmux-team send CONDUCTOR_DONE --success true` だけを送信していた。Manager daemon の `handleConductorDone` は success=true を「Conductor 側で close-task 済み想定」として扱い、task-state を検証しないため、task-state.json の status=assigned がそのまま残った。

## 根本原因（テンプレート矛盾）

- `conductor-role.md` Step 11: `cmux-team close-task` を実行する指示（close-task が内部で CONDUCTOR_DONE を post する）
- `conductor-task.md:37-45`: 完了通知として `cmux-team send CONDUCTOR_DONE --success true` を送れ、と重複指示

per-task プロンプトの conductor-task.md が優先されると close-task がスキップされる。

## 影響範囲の確認結果

- `--success true` の単体送信: 正当なユースケース**ゼロ**（close-task が内部 post する）
- `--success false` の単体送信: `conductor-role.md:477` の rebase 衝突 abort パスのみ正当（close-task で代替不可）

## 修正内容

### 1. conductor-task.md 修正（必須）

- `skills/cmux-team/templates/ja/conductor-task.md:37-45` の「完了通知 → cmux-team send CONDUCTOR_DONE --success true」を削除
- `conductor-role.md` の Step 11（close-task）に集約する旨を残す
- `skills/cmux-team/templates/en/conductor-task.md` 側も同様に修正（英語版の対応箇所を確認）

### 2. daemon 側の整合性ガード（保険、推奨）

`handleConductorDone`（`skills/cmux-team/manager/daemon.ts:2895-` の success=true 経路）で:

- task-state の現在値が `assigned` のまま残っていたら `task_completed_state_mismatch` を warn ログに出す
- 自動で `closed` に倒す（journal: `auto_closed_by_daemon: CONDUCTOR_DONE without close-task`）
- あるいは保守側に倒し `aborted` にして人間判断に回す（要 Master 判断）

旧プロンプトが残っている他プロジェクトで再発しても TUI 上で assigned のまま残らないようにする。

### 3. （任意）CLI 側で送信を拒否

`cmux-team send CONDUCTOR_DONE --success true` を CLI 経由で呼んだ場合に warning or error を出す案。下位互換を壊す可能性があるため 2 の daemon ガードで十分なら不要。

## 受け入れ基準

- [ ] conductor-task.md（ja/en 両方）から `send CONDUCTOR_DONE --success true` の指示が消えている
- [ ] 新規に生成される `.team/prompts/conductor-task-*.md` に上記指示が含まれない
- [ ] daemon の handleConductorDone に整合性チェックが入る（or 2 を見送る決定を docs/spec に残す）
- [ ] CHANGELOG に破壊的変更として記載（Conductor が Claude Code の過去セッションを resume すると旧プロンプトを実行し得るため、ロールアウト時は cmux-team restart が必要な旨を書く）

## 参考

- T204 調査: Dear ~/git/Dear/.team/tasks/204-1896-a-6-a-1843/
- 原因コード: `skills/cmux-team/manager/daemon.ts:2895-2974`（handleConductorDone）
- 重複指示: `skills/cmux-team/templates/ja/conductor-task.md:37-45`
- close-task 内部 post: `skills/cmux-team/manager/main.ts:2896-2912`


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-274-1776667827` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-274-1776667827
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-274-1776667827/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/274-conductor-close-task-conductor-done-success-true/runs/task-274-1776667827
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/274-conductor-close-task-conductor-done-success-true/runs/task-274-1776667827/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら:

1. セッション上に完了レポートを表示する（conductor-role.md「完了時の処理」Step 12 参照。設計判断・試行錯誤・自己判断・懸念・成果の勘所を簡潔に出力）
2. 完了通知を送信する:
   ```bash
   cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
   ```
