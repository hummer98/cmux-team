# タスク割り当て

## タスク内容

---
id: 323
title: TUI: pool capacity 指標表示 + cmux-team pool status コマンド
priority: medium
created_at: 2026-04-24T22:42:03.898Z
---

## タスク
## 概要

TUI の Master / Conductor / Agent 行にトークン handle と使用率を表示し、
ヘッダーに pool_capacity 指標を表示する。
また `cmux-team pool status` サブコマンドで全アカウント一覧を表示する。

依存: T318（tokens.db CRUD）, T320（proxy UPSERT）, T321（spawn-agent selection）

## 設計根拠

`.team/artifacts/A019-token-pool-design.md` 参照。

## TUI 変更（cmux-team status）

### ヘッダー部（pool 有効時のみ表示）

```
┌─ token pool ─────────────────────────────────────┐
│ pool capacity: 173%                              │
│ next reset: @kddi 5h in 30m (+20 pts)            │
└──────────────────────────────────────────────────┘
```

- `pool_capacity` = `computePoolCapacity()` の結果
- `next reset` = selectable 全アカウント中で最も早い reset と、その際の capacity 増分

### Master / Conductor / Agent 行

```
Master     [969] @pers    <5h:10%/7d:30%>  cap:100%
Conductor  [123] @pers    <5h:10%/7d:30%>  cap:100%
           [124] @kddi    <5h:82%/7d:60%>  cap: 40%  ⚠
Agent      [201] @kddi    <5h:82%/7d:60%>  cap: 40%  ⚠
```

- handle は `team.json` の surface エントリに token_handle フィールドを追加して保持
  - Master / Conductor: daemon 起動時に organization_id で解決（変更なし）
  - Agent: spawn 時に選択された handle を記録
- `<5h:X%/7d:Y%>` は使用率（0〜100%）。閾値超過（5h>80% or 7d>90%）で赤
- `cap: X%` はアカウント単体の pool_capacity 寄与。20% 未満で ⚠

pool 機能 OFF の場合はこの行を非表示（既存レイアウトと同じ）

## cmux-team pool status コマンド

全アカウントの一覧（token pool 専用のサブコマンド）:

```
$ cmux-team pool status

HANDLE   PLAN     TAGS       SEL  CAP      5H USE  7D USE  NEXT_RESET
@pers    max-x20  any        yes  100%     10%      30%     5h in 4h 30m
@kddi    max-x20  org:kddi   yes   40%     82%      60%     7d in 3d 12h
@auto    unknown  auto       no    --       8%      20%     5h in 1h 15m

pool capacity: 140%
```

## 検証

- pool 有効時に TUI ヘッダーに capacity が表示されること
- handle が各 surface 行に表示されること
- 5h > 80% のアカウントで ⚠ が表示されること
- pool 無効時は追加表示がないこと（既存レイアウト維持）
- `cmux-team pool status` で全アカウント一覧が表示されること
- `bun test` + `tsc --noEmit` が通ること


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-323-1777102517` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-323-1777102517
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-323-1777102517/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/323-tui-pool-capacity-cmux-team-pool-status/runs/task-323-1777102517
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/323-tui-pool-capacity-cmux-team-pool-status/runs/task-323-1777102517/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
