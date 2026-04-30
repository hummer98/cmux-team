# タスク割り当て

## タスク内容

---
id: 306
title: trace-task --metrics でタスク別トークン消費集計を表示
priority: medium
depends_on: [305]
created_by: surface:629
created_at: 2026-04-23T18:06:37.789Z
---

## 背景

T305 で api_usage テーブルが揃う前提で、`cmux-team trace-task <id>` にトークン消費の集計表示を追加する。ユーザーが「このタスクは重かった」「軽かった」を即座に判断できるようにする。

## ゴール

`cmux-team trace-task <id>` の出力に token 消費集計を**既定で含める**。サプレスしたいユーザー向けに `--no-metrics` フラグを用意する（ON がデフォルト、OFF はオプトアウト）。

## 表示項目（案）

```
Task T042 Token Usage
  Total requests: 127
  Total input:  12,345 tokens
  Total output:  4,567 tokens
  Cache creation: 8,901 tokens
  Cache read:   45,678 tokens  (cache hit rate: 78.7%)
  Duration: 23m 14s

By role:
  conductor   45 req  input=2,345  output=890    cache_read=12,345
  agent       82 req  input=10,000 output=3,677  cache_read=33,333

By model:
  claude-opus-4-7      67 req  ...
  claude-sonnet-4-6    60 req  ...
```

- リクエスト数、input/output/cache tokens 合計
- cache hit 率 = `cache_read / (input + cache_read)`
- role 別 / model 別の内訳
- assigned → closed の経過時間（既存の task_sessions から取得）

## 調査スコープ

- \`skills/cmux-team/manager/main.ts\` の \`cmdTraceTask\`（line 4020 周辺）
- 既存の表示レイアウト・カラム幅
- \`--no-metrics\` フラグ実装（既定 ON、オプトアウト形式）
- api_usage データ不在時（古いタスク）のフォールバック表示

## フラグ設計

- 既定: metrics セクションを表示
- \`--no-metrics\`: 従来の trace-task 出力のみ（metrics 非表示）
- api_usage に該当 task_id のレコードが 0 件の場合: \`(no usage data — task predates T305)\` 等の 1 行で済ませる

## Out of scope

- Dashboard への統合は T307
- 時系列グラフ・burn rate は T307

## 検証方法

- 既存 closed タスクに対して \`cmux-team trace-task 303\` を叩いて numbers が既定で出ること
- \`cmux-team trace-task 303 --no-metrics\` で従来出力に戻ること
- 古いタスク（api_usage 導入前）は grace fully フォールバック
- 既存 trace-task 出力の非 metrics 部分に regression がないこと


## 作業ディレクトリ

すべての作業は git worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-306-1776976896` 内で行う。
```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-306-1776976896
```
main ブランチに直接変更を加えてはならない。

ブランチ名: `task-306-1776976896/task`

## 作業開始前の確認（ブートストラップ）

worktree は tracked files のみ含む。作業開始前に以下を確認すること:
- `package.json` があれば `npm install` を実行
- `.gitignore` に記載されたランタイムディレクトリ（`node_modules/`, `dist/`, `workspace/` 等）の有無を確認し、必要なら再構築
- `.envrc` や環境変数の設定

## 出力ディレクトリ

```
/Users/yamamoto/git/cmux-team/.team/tasks/306-trace-task-metrics/runs/task-306-1776976896
```

結果サマリーは `/Users/yamamoto/git/cmux-team/.team/tasks/306-trace-task-metrics/runs/task-306-1776976896/summary.md` に書き出す。

## マージ先ブランチ

このタスクの成果は `main` にマージすること。
納品方法（ローカルマージ or PR）は conductor-role.md の完了時の処理に従う。

## 完了通知

完了処理は `conductor-role.md` の「完了時の処理」（Step 1〜12）に従う。特に:
- Step 11: `cmux-team close-task --task-id <TASK_ID> --deliverable-kind <files|merged|pr|none> ... --journal "..."` がタスクを close し、内部で daemon に CONDUCTOR_DONE を送信する。**`--deliverable-kind` は必須**で Step 9 の納品方式と対応付ける（merged / pr / files / none）。詳細は `conductor-role.md` Step 11 を参照
- Step 12: 完了レポートをセッション上に表示する

**`cmux-team send CONDUCTOR_DONE --success true` を自分で呼び出さない** — close-task がその役割を果たす。rebase 衝突等で close-task を呼ばず abort したい場合のみ `conductor-role.md` Step 8 の `--success false` 経路を使う。
