# タスク割り当て

## タスク内容

---
id: 379
title: cmux-team metrics サブコマンド実装 + hook_signals 棚卸し
priority: high
depends_on: [359]
created_at: 2026-04-29T01:08:47.072Z
---

## タスク
## 背景

CodeDNA (https://github.com/Larens94/codedna) を cmux-team 自身に適用するか **計測ベース** で判断するための baseline 計測基盤を構築する。背景・全体計画は **GitHub issue #44** を参照。

T358 (events.jsonl writer) と T359 (cmux-team events CLI) で task FSM / lifecycle event の SSOT が確立する。本タスクはそれに加えて **tool call レベルの観察と集計レイヤー** を実装する。

## やること

### 1. hook_signals 棚卸し

現状の hook_signals テーブル (`.team/traces/traces.db`) が以下を記録しているか確認。不足があれば hook 受信側で追記:

- `tool_name` (Read / Grep / Edit / Bash 等)
- `tool_input.file_path` (Read/Edit 対象ファイル)
- `tool_response.success` or 失敗判定可能なフィールド
- `session_id` (task との連結用)

session_id ↔ task_id の紐付けが正しく動くか検証。events.jsonl の session 情報と join 可能か確認、ズレがあれば修正。

### 2. cmux-team metrics サブコマンド実装

\`skills/cmux-team/manager/main.ts\` の CLI dispatcher に \`metrics\` を追加:

**入力 source:**
- events.jsonl (T358 成果物) — task FSM transition / lifecycle
- hook_signals (.team/traces/traces.db) — tool call 集計
- api_usage (.team/traces/traces.db) — token 消費

**出力:** per-task or 期間集計の JSON / text サマリー

**Options:**
- \`--task-id <id>\` 単一 task
- \`--since <duration|ts>\` 期間
- \`--format json|text|csv\` 出力形式
- \`--group-by task|day|week\` 集計軸

### 3. 集計指標（最低限実装）

- **task あたり:** 完了時間、abort/forced close 率、Read/Grep/Edit/Bash call 数、token 消費、time-to-first-Edit、tool call 失敗率
- **期間あたり:** hook block 発生率、forced close 発動率、task 完了率
- **variance:** tool call 数の std

## Done 判定

- \`cmux-team metrics --since 7d --format json\` が動作し per-task 集計を返す
- hook_signals に必要フィールドが揃っている (場合により追記)
- bun test 既存 suite 全 pass
- Phase 0 (T358-T361) のうち T358-T359 は完了している前提

## 関連

- GitHub issue: https://github.com/hummer98/cmux-team/issues/44
- T357: events stream spec (closed)
- T358: events.jsonl writer (depends)
- T359: cmux-team events CLI (depends)
- T380: metrics spec 文書化 (本タスクに依存)
- T381: baseline 定期 snapshot (本タスクに依存)


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-379-1777562435` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-379-1777562435
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-379-1777562435/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/379-cmux-team-metrics-hook-signals/runs/task-379-1777562435
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/379-cmux-team-metrics-hook-signals/runs/task-379-1777562435/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
