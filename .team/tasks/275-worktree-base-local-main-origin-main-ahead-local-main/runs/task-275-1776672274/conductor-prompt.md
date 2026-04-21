# タスク割り当て

## タスク内容

---
id: 275
title: worktree-base: local main が origin/main より ahead のとき local main を優先
priority: high
created_at: 2026-04-20T07:44:54.111Z
---

## タスク
## 背景

ai-web-builder の T006（2026-04-19）で、「禁止事項: `git push`」運用のため
T004 / T005 が local main にのみ merge され origin は stale になっていた状態で
worktree を作成した結果、古い base から切られ、Conductor が Step 8 / Step 9 で
詰まって `CONDUCTOR_DONE --success=false`（reason 空）で諦めた。

## 現状

`skills/cmux-team/manager/worktree-base.ts` の `resolveWorktreeBase` 優先順位:

1. `explicit`（task frontmatter `base_branch:`）
2. `config-origin`（`origin/<main>` があれば採用）← **origin が stale でも採用**
3. `config-local`（`origin/<main>` が無い場合の local フォールバック）
4. `head-fallback`

CLAUDE.md（T242 節）にも「`config-origin` を確実に使うには origin が最新化されて
いる必要がある」と注記があるが、ロジック側で救っていない。

## 改修

`config-origin` を選ぶ前に「local `<main>` が `origin/<main>` より **strictly ahead**」
を判定し、該当すれば local を優先する。

### 判定ロジック

```
1. origin/<main> と local <main> の両方が存在するか
2. git merge-base --is-ancestor origin/<main> <main>  (exit 0 なら origin が
   local の ancestor)
3. git rev-parse origin/<main> != git rev-parse <main>  (完全同一は ahead で
   ない)
```

3 つとも満たした場合のみ新 source `config-local-ahead` を採用。

### 新・優先順位

1. `explicit`
2. `config-local-ahead`（新）
3. `config-origin`
4. `config-local`（origin 不在の救済、従来通り）
5. `head-fallback`

### ログ

```
worktree_created branch=<new> base=<main> source=config-local-ahead
  path=<worktreePath>
```

source の enum と log 出力の両方に追加する。

## 対象ファイル

- `skills/cmux-team/manager/worktree-base.ts`（主要ロジック）
- `skills/cmux-team/manager/worktree-base.test.ts` があれば追加テスト（なければ
  手動検証で可）
- `docs/spec/05-install-and-infrastructure.md` の該当節（優先順位表）
- `CLAUDE.md` の T242 節（「config-origin を確実に使うには origin が最新化されて
  いる必要がある」の記述を「local ahead の場合は自動で config-local-ahead が
  選ばれる」に更新）

## 検証

1. テスト用 repo で `git commit` を積み `git push` しない状態を作る
2. `cmux-team start` → ready タスクを assign
3. `manager.log` に `source=config-local-ahead` が出ること
4. worktree 内 `git log` で local main の最新 commit が含まれること
5. リグレッション: origin が ahead なケース（通常の PR マージ後）で従来通り
   `source=config-origin` が選ばれること

## 関連

- 発生事例: ai-web-builder T006（2026-04-19）
- 兄弟タスク: conductor-role.md Step 8 / Step 9 の rebase 対象と判断必要レポート
  強化（独立に merge 可）
- CLAUDE.md 現行記述: `## worktree 作成時の start-point 解決（T242）` 節


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-275-1776672274` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-275-1776672274
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-275-1776672274/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/275-worktree-base-local-main-origin-main-ahead-local-main/runs/task-275-1776672274
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/275-worktree-base-local-main-origin-main-ahead-local-main/runs/task-275-1776672274/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
