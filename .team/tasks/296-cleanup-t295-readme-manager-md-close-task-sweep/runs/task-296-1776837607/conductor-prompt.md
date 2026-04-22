# タスク割り当て

## タスク内容

---
id: 296
title: cleanup: T295 で漏れた README / manager.md の close-task 旧署名 sweep
priority: low
depends_on: [295]
created_by: surface:627
created_at: 2026-04-22T04:28:08.735Z
---

## タスク
## 発見経緯

T295（close-task の納品物明示を強制化、Conductor 本 run で close 済み）の Inspector がFinding 1 (major) / Finding 2 (minor) として指摘した箇所。plan.md §5.1 Risks で「docs/ CLAUDE.md README.md README.ja.md templates/」を `rg "close-task --task-id.*--journal"` で 0 件まで掃く方針だったが、README と template manager.md の 4 行が漏れた。

## 対象

- `README.md` L110 付近: `\`cmux-team close-task --task-id <id> [--journal <text>]\` | Close a task`
- `README.ja.md` L110 付近: `\`cmux-team close-task --task-id <id> [--journal <text>]\` | タスク close`
- `skills/cmux-team/templates/ja/manager.md` L73 付近: `cmux-team close-task --task-id <TASK_ID> --journal "..."` の例示
- `skills/cmux-team/templates/en/manager.md` L73 付近: 同上の英語版

## 方針

**README.md / README.ja.md**: 新仕様に書き直す。
`cmux-team close-task --task-id <id> --deliverable-kind <files|merged|pr|none> [kind 別フラグ] [--journal <text>]`

**manager.md (ja/en)**: 引数を省略して抽象化（推奨）:
`cmux-team close-task ...`

manager.md は Manager/daemon の動作説明文脈で、読み手に具体的 kind を選ばせる場所ではないため、引数を抽象化したほうが陳腐化しにくい。

## 検証

```bash
rg "close-task --task-id.*--journal" docs/ CLAUDE.md README.md README.ja.md skills/cmux-team/templates/
```

上記が 0 件になること。

## 本体への影響

実装コード / tsc / bun test には影響しない。ドキュメント hygiene のみ。軽微。

## 依存

`depends_on: [295]`（T295 が close されてから着手）


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-296-1776837607` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-296-1776837607
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-296-1776837607/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/296-cleanup-t295-readme-manager-md-close-task-sweep/runs/task-296-1776837607
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/296-cleanup-t295-readme-manager-md-close-task-sweep/runs/task-296-1776837607/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
