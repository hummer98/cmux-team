# タスク割り当て

## タスク内容

---
id: 117
title: cmux-team start に preflight チェック追加 + assignTask 失敗時の Conductor 影響分離
priority: high
created_at: 2026-04-09T18:45:08.008Z
---

## タスク
## 背景

KDG-discord-listner ワークスペースで `cmux-team start` を実行した際に以下の事象が発生した:

1. 対象ディレクトリが git リポジトリとして初期化されていなかった（`.git` 不在）
2. daemon / Master / Conductor 3つはすべて spawn に成功
3. タスク 001 を Conductor に割り当てようとした時点で `git worktree add` が失敗
4. エラーを受けて当該 Conductor を `disconnected` に遷移
5. 同じタスクを次の Conductor に再試行 → 同じエラー → 3つすべて disconnected
6. 以降 `throttled ... no_idle_conductor` が延々と続き完全に詰み

### 実ログ抜粋（`/Users/yamamoto/git/KDG-discord-listner/.team/logs/manager.log`）

```
[2026-04-10T03:31:32] error assignTask failed for task 001: Command failed:
  git worktree add .../.worktrees/task-001-1775759492 -b task-001-1775759492/task
  fatal: not a git repository (or any of the parent directories): .git
[2026-04-10T03:31:32] conductor_disconnected surface=surface:162 reason=assign_failed task_id=001
[2026-04-10T03:31:42] conductor_disconnected surface=surface:162 ...
[2026-04-10T03:31:52] conductor_disconnected surface=surface:163 ...
[2026-04-10T03:32:02] conductor_disconnected surface=surface:164 ...
[2026-04-10T03:32:12〜] throttled task_id=001 no_idle_conductor
```

## 問題の二重構造

### Problem 1: 前提チェック欠如（真因）

`cmux-team start` は動作に必要な前提を検証せず、失敗する瞬間まで走り続ける。非 git リポジトリでも spawn が完了してしまい、タスク割当時に初めて致命的エラーに遭遇する。`git init` 忘れという単純ミスを起動時点で拾えないのは UX 設計の欠陥。

### Problem 2: エラー影響の過剰波及

`skills/cmux-team/manager/daemon.ts:665-670` の assignTask 失敗時処理が、**タスク側の準備失敗**（worktree 作成エラー等）で**健全な Conductor を `disconnected` にしてしまう**。1件のタスクが全 Conductor を連鎖的に破壊する設計は明確に誤り。

## 修正内容

### 1. `cmux-team start` に preflight チェック追加

`main.ts` の start コマンド開始直後、daemon 起動 (`daemon_started` ログ出力) より前に `runPreflight()` を呼び出す。以下を検証:

- [ ] `git rev-parse --git-dir` 成功（カレントが git リポジトリ）
- [ ] `claude` バイナリが PATH に存在（`which claude` 相当）
- [ ] `bun` バイナリが PATH に存在（`which bun` 相当）
- [ ] `.team/` ディレクトリへの書き込み権限

いずれかが失敗したら即 `process.exit(1)`。ユーザーには何が足りないか・どう直せばよいかを日本語で明示する。例:

\`\`\`
❌ cmux-team start: 前提チェックに失敗しました

  ✗ git リポジトリではありません
    /Users/yamamoto/git/KDG-discord-listner

解決方法:
  cd /Users/yamamoto/git/KDG-discord-listner
  git init
  git add -A && git commit -m "Initial commit"
\`\`\`

複数チェックが同時に失敗した場合は全部まとめて表示する（1件ずつ直す手間を省く）。

### 2. assignTask 失敗時の影響分離

`daemon.ts:665-670` を修正:

- **タスク側の問題**（worktree 作成失敗、プロンプト生成失敗など）
  → 該当タスクを abort、journal にエラー内容を記録
  → Conductor は idle のまま稼働継続
- **Conductor 側の問題**（cmux send 失敗など、プロセス不在の徴候）
  → これまで通り disconnected

判定方法は、assignTask 内で例外を型で区別するか、エラーメッセージ分類か、実装都合で選択してよい。少なくとも `git worktree add` 失敗は明確に「タスク側」に分類すること。

## 期待動作

1. **preflight 失敗時**: daemon / Master / Conductor は一切 spawn されず、即座にユーザーへ明確なエラーメッセージを返して exit 1
2. **preflight 通過後に worktree 失敗**: 該当タスクのみ abort（理由付き）、Conductor は全員 idle のまま動作継続、他のタスクは正常に処理される

## 参考ファイル

- `skills/cmux-team/manager/main.ts` — start コマンド実装
- `skills/cmux-team/manager/daemon.ts:665-670` — assignTask エラー処理（Problem 2 の該当箇所）
- `skills/cmux-team/manager/conductor.ts` — worktree 作成処理（エラー発生源）

## 検証手順

1. 非 git ディレクトリで `cmux-team start` → preflight エラーで即 exit することを確認
2. git 初期化済みディレクトリで `cmux-team start` → 正常起動することを確認
3. `claude` を PATH から一時的に外した状態で `cmux-team start` → エラー終了することを確認
4. 意図的に worktree 作成を失敗させるタスク（存在しない親ディレクトリへの worktree 作成等）を投入 → 該当タスクのみ abort、他 Conductor は idle のまま、別タスクは正常処理されることを確認

## スコープ外

- Master/Conductor ランタイム中に親ディレクトリが git から外れるような極端なケースのリカバリ（頻度が低い・対応コストが見合わない）
- preflight チェック項目の外部設定化（まずはハードコードで十分）


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-117-1775760410` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-117-1775760410
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-117-1775760410/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/117-cmux-team-start-preflight-assigntask-conductor/runs/task-117-1775760410
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/117-cmux-team-start-preflight-assigntask-conductor/runs/task-117-1775760410/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら、最後に:
```bash
cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
```
