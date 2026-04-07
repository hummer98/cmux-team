# タスク割り当て

## タスク内容

---
id: 104
title: Conductor hook の .team/tasks/ 書き込み制限を runs/ 許可に緩和
priority: medium
depends_on: [102]
created_at: 2026-04-07T06:05:37.503Z
---

## タスク
## 背景

T102（フォルダ集約）により指示書が `.team/tasks/T100-xxx/runs/` に配置されるようになる。現在の PreToolUse hook は `.team/tasks/` を含むパスへの Write/Edit を全てブロックしているため、Conductor が指示書を書けなくなる。

## 現在の hook（.claude/settings.json:27-38）

`.team/tasks/` を含むパスへの Write/Edit を無条件でブロック。

## 変更内容

判定ロジックを精緻化:

| パス | 許可/禁止 |
|------|----------|
| `.team/tasks/*/task.md` | **禁止**（タスク定義本体） |
| `.team/tasks/*.md`（フラット形式） | **禁止** |
| `.team/tasks/*/runs/**` | **許可**（指示書・出力） |
| `.team/tasks/*/sessions.json` | **許可** |

判定の考え方:
- `.team/tasks/` 配下かつ `/runs/` を含まない → ブロック
- `.team/tasks/T100-xxx/runs/...` → 許可

## 対象ファイル

- .claude/settings.json（PreToolUse hook）


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-104-1775541937` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-104-1775541937
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-104-1775541937/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/104-conductor-hook-team-tasks-runs/runs/task-104-1775541937
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/104-conductor-hook-team-tasks-runs/runs/task-104-1775541937/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main（デフォルト）` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

全ての処理が完了したら、最後に:
```bash
cmux-team send CONDUCTOR_DONE --surface $CMUX_SURFACE --success true
```
