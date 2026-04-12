---
name: cmux-team-investigate
description: >
  Use when investigating another cmux-team project (e.g. ~/git/mado, ~/git/Dear) from this repository.
  Triggers: ユーザーが「mado で〜」「Dear で〜」「~/git/<別プロジェクト> で〜」のように
  別リポジトリの不具合・挙動を質問した場合、もしくは manager.log / trace DB の相関分析、
  特定 surface の挙動調査を求められた場合。
  Provides: 対象リポジトリ特定 → ログ収集 → trace DB 検索 → surface 直接参照 → 時系列相関 の 5 ステップ手順。
  対象プロジェクトの .team/ は読み取り専用で扱い、書き込みは行わない。
---

# cmux-team-investigate

## 概要

別プロジェクト（`~/git/mado`, `~/git/Dear` 等、cmux-team を導入済みの別リポジトリ）の
`.team/` 配下を調査するための定型手順。`manager.log`、`traces.db`、`task-state.json`、
cmux surface の画面を相関させて、原因を切り分ける。

このスキルは **このリポジトリ（cmux-team 開発リポジトリ）のワークツリー内でのみ有効** な
開発者用スキルである。`.claude/skills/` 配下にあり npm publish にも plugin 配布にも含まれない。
他プロジェクトの Claude Code セッションからは利用できない。

## 前提

- 対象は別ワークスペースで起動している cmux-team プロジェクトであり、`.team/` 構造を持つこと
- 対象リポジトリの `.team/` は **読み取り専用** で扱う。書き込み系 CLI（`create-task`,
  `update-task`, `close-task` 等）を対象 CWD で実行してはならない
- 修正が必要と判断した場合は、適切なリポジトリで別タスクとして起票する（Master が直接コードを書かない原則は維持）

## Step 1: 対象リポジトリの特定

```bash
# パス指定が明確な場合
TARGET=~/git/mado

# surface ID 経由で特定する場合（cmux 上の不審なペインから辿る）
cmux identify --surface <surface-id>
# → caller.workspace_ref からワークスペースのルートを推定し、
#   そこに対応する .team/ を持つリポジトリを TARGET にセット
TARGET=$(cmux identify --surface <surface-id> | jq -r '.caller.workspace_ref')

# .team/ の存在確認（無ければ通常のリポジトリ調査に切り替え）
ls "$TARGET/.team/" || { echo "対象に .team/ が無い → 通常の git log / grep 調査へ"; exit 1; }
```

`workspace_ref` がリポジトリのパスそのものとは限らないため、`.team/` の存在で確認する保守的な手順を取る。

## Step 2: ログ収集

```bash
# manager.log 末尾
tail -n 200 "$TARGET/.team/logs/manager.log"

# 特定キーワードで grep（タスク ID、conductor、error）
grep -E "task-042|conductor_|error" "$TARGET/.team/logs/manager.log" | tail -n 100

# タスク状態スナップショット
cat "$TARGET/.team/task-state.json" | jq '.tasks | to_entries[] | {id:.key, status:.value.status}'

# Conductor の状態
ls "$TARGET/.team/conductors/"
cat "$TARGET/.team/conductors/conductor-1.json" 2>/dev/null
```

## Step 3: trace DB 検索

> **重要**: 現行の `cmux-team trace-task` は CWD の `.team/traces/traces.db` のみを参照する
> （`--db` オプションは存在しない）。別リポジトリの DB を読むには次のいずれかを使う。

```bash
# 方式 A: 対象リポジトリに cd して cmux-team trace-task を実行
( cd "$TARGET" && cmux-team trace-task <task-id> )

# 方式 B: sqlite3 で直接 readonly 参照（ロック回避のため readonly モード）
sqlite3 "file:$TARGET/.team/traces/traces.db?mode=ro" -readonly \
  "SELECT timestamp, task_id, role, surface, event FROM task_sessions WHERE task_id='042' ORDER BY id ASC;"

# 方式 C: ロックが掛かっている場合は cp してから読む
cp "$TARGET/.team/traces/traces.db" /tmp/traces-snapshot.db
sqlite3 /tmp/traces-snapshot.db "SELECT * FROM task_sessions WHERE task_id='042';"
```

`task_sessions` テーブルは通常テーブル + 通常 INDEX で、FTS5 仮想テーブルは持たない。
本文の全文検索が必要な場合は body ファイルを直接 grep する:

```bash
grep -rl "<query>" "$TARGET/.team/logs/traces/bodies/"
```

## Step 4: surface 直接参照

別ワークスペースを参照するときは必ず `--workspace` を付ける
（CLAUDE.md「cmux API 使用上の注意」参照）。

```bash
WS=$(cmux identify --surface <surface-id> | jq -r '.caller.workspace_ref')
cmux read-screen --surface <surface-id> --workspace "$WS"

# ワークスペース全体の状態
cmux list-status --workspace "$WS"
cmux tree --workspace "$WS"
```

## Step 5: 時系列相関

`manager.log` のタイムスタンプ（ローカル TZ 付き ISO 8601）を基準軸にして、
trace DB の `timestamp` 列とつき合わせる。

```bash
# manager.log 側
grep "task-042" "$TARGET/.team/logs/manager.log"
# 例: [2026-04-12T10:30:15+09:00] conductor_started conductor=1 task=042

# trace DB 側（同タスクの行を時系列で）
sqlite3 "file:$TARGET/.team/traces/traces.db?mode=ro" -readonly \
  "SELECT timestamp, role, event FROM task_sessions
   WHERE task_id='042' ORDER BY timestamp ASC;"

# 必要ならログと DB を時刻でソートしてマージ確認
```

## 注意事項

- **書き込み禁止**: 対象プロジェクトの `.team/` には書き込まない。`create-task` /
  `update-task` / `close-task` 等を対象 CWD で実行してはならない。修正タスクは
  **このリポジトリ** または対象リポジトリのオーナーに渡すかたちで別途起票する。
- **Master 責務の継続**: 調査で原因が特定できたら、修正は別タスクとして適切な
  リポジトリに `cmux-team create-task` で起票する。Master が直接コードを書かない
  原則は変わらない。
- **trace DB のロック**: 対象 daemon が WAL モードで開いているため、書き込みアクセスは
  衝突する可能性がある。読むときは `?mode=ro` URI、または `cp` スナップショットを使う。
- **配布外**: このスキル自体はこのリポジトリの `.claude/skills/` 配下にあり、
  npm publish にも plugin 配布にも含まれない。他プロジェクトの Claude Code セッションでは
  利用できない。
