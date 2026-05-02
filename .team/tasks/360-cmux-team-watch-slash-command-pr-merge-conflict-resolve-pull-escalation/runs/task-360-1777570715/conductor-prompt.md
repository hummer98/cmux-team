# タスク割り当て

## タスク内容

---
id: 360
title: /cmux-team:watch slash command 新設（PR merge / conflict resolve / pull / escalation 自動化）
priority: high
depends_on: [359]
created_by: surface:123
created_at: 2026-04-26T22:34:09.809Z
---

## タスク
events stream を Monitor 監視して、PR merge / conflict resolve / pull / escalation を Master 自身が自動実行する slash command を新設する。

参照:
- issue: https://github.com/hummer98/cmux-team/issues/42
- spec: \`docs/spec/10-events-stream.md\`（T357）
- CLI: \`cmux-team events\`（T359）

## 設計方針（issue で確定済み）

- **opt-in**（user が能動的に \`/cmux-team:watch\` を invoke）
- **Master template / CLAUDE.md には介入しない**（Phase 1）
- **自動化レベル: (c)** — PR merge / conflict resolve / pull まで Master 自身が実行
- 通知処理 protocol は **command 本文に内包**（context が消えたら user が再 invoke）

## 実装範囲

### 1. \`commands/watch.md\` 新規作成

namespace は \`cmux-team\` plugin の slash command として配置（実際のパスは既存の \`commands/\` 配下に従う）。

YAML frontmatter:
\`\`\`yaml
allowed-tools: Bash, Read, Edit, Monitor
description: events stream を監視して PR merge / conflict resolve / pull / escalation を自動処理する
\`\`\`

### 2. Pre-flight checks

command 本文の冒頭で:
- daemon 稼働確認（\`.team/daemon.pid\` 存在 + \`cmux-team status\`）
- \`.team/logs/events.jsonl\` 存在確認（無ければ「writer が動いていない」と error）

### 3. Monitor 起動

\`\`\`bash
cmux-team events --follow --types task_completed,task_completed_state_mismatch,task_aborted,task_sync_guard_rejected,task_reverted_to_ready,conductor_done_unresolved,conductor_disconnect_timeout,conductor_asking
\`\`\`

を Monitor で persistent 起動。

### 4. 通知処理 protocol（command 本文に明記）

| event | 処理 |
|---|---|
| \`task_completed\` | 該当 worktree が PR を生成しているか確認 → \`gh pr merge --squash\` → conflict 検出時は worktree で resolve commit → push → main に戻って \`git pull --ff-only\` |
| \`task_completed_state_mismatch\` | 異常通知 + \`journal_summary\` を user に提示。auto merge は行わない（要 user 判断） |
| \`task_aborted\` (reason=judgment_pending) | user に escalation 通知（\`journal_summary\` 表示） |
| \`task_aborted\` (その他 reason) | log のみ |
| \`task_sync_guard_rejected\` | user に手動介入要請（pull / stash / branch 切替指示） |
| \`task_reverted_to_ready\` | log のみ（Manager が再 assign する） |
| \`conductor_done_unresolved\` | user に判断要請（\`journal_summary\` 提示、\`worktree_path\` 案内） |
| \`conductor_disconnect_timeout\` | user に状況通知（forced close 直前の警告） |
| \`conductor_asking\` | user に質問内容を pass through |

### 5. 終了処理

user が watch mode を抜けたい時は \`/clear\` または明示的な指示で Monitor 停止。command 内で明文化する。

## scope outside

- Master template / CLAUDE.md への組み込み（Phase 2、別 issue）
- writer 実装（T358）
- CLI（T359）
- docs 反映（T(task5)）


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-360-1777570715` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-360-1777570715
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-360-1777570715/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/360-cmux-team-watch-slash-command-pr-merge-conflict-resolve-pull-escalation/runs/task-360-1777570715
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/360-cmux-team-watch-slash-command-pr-merge-conflict-resolve-pull-escalation/runs/task-360-1777570715/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
