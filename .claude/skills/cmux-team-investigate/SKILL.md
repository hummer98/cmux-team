---
name: cmux-team-investigate
description: >
  Use when investigating another cmux-team project (e.g. ~/git/mado, ~/git/Dear) from this repository.
  Triggers: ユーザーが「mado で〜」「Dear で〜」「~/git/<別プロジェクト> で〜」のように
  別リポジトリの不具合・挙動を質問した場合、もしくは manager.log / trace DB の相関分析、
  特定 surface の挙動調査を求められた場合。
  Provides: 対象リポジトリ特定 → ログ収集 → trace DB 検索 → surface 直接参照 → 時系列相関 の 5 ステップ手順。
  hook_signals テーブル（T216）と cmux-team trace-hooks サブコマンド（T217）による hook 受信の事後追跡もカバーする。
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

### trace DB の位置づけ

`traces.db` は **セッション索引** であり、会話内容は持たない。

```
traces.db（インデックス）
  └─ task_sessions: session_id, role, surface, task_id, event, worktree_path
       ↓ session_id を使って
Claude Code 生ログ（本体）
  └─ ~/.claude/projects/<project-dir>/<session_id>.jsonl
```

`task_sessions` テーブルには FTS5 仮想テーブルはなく、本文検索は不可。

> **注意**: `.team/logs/traces/api-trace.jsonl` はプロキシのアクセスログ（timestamp/method/path/status/bytes のみ）であり、会話内容は含まない。

### DB クエリ

```bash
# 方式 A: 対象リポジトリに cd して cmux-team trace-task を実行
( cd "$TARGET" && cmux-team trace-task <task-id> )

# 方式 B: sqlite3 で直接 readonly 参照（ロック回避のため readonly モード）
sqlite3 "file:$TARGET/.team/traces/traces.db?mode=ro" -readonly \
  "SELECT timestamp, task_id, session_id, role, surface, event FROM task_sessions WHERE task_id='042' ORDER BY id ASC;"

# 方式 C: ロックが掛かっている場合は cp してから読む
cp "$TARGET/.team/traces/traces.db" /tmp/traces-snapshot.db
sqlite3 /tmp/traces-snapshot.db "SELECT * FROM task_sessions WHERE task_id='042';"
```

### session_id から生ログを参照する

DB で `session_id` を取得したら、対応する Claude Code セッションファイルを直接開く。

```bash
# プロジェクトディレクトリ名の変換ルール: パスの / を - に置換し先頭に - を付ける
# 例: /Users/yamamoto/git/mado → -Users-yamamoto-git-mado
SESSION_ID="2577bcfe-2f0e-4dfa-b277-326731acb6ba"
PROJECT_DIR="-Users-yamamoto-git-mado"   # $TARGET のパスから導出
JSONL=~/.claude/projects/$PROJECT_DIR/$SESSION_ID.jsonl

# worktree 内セッションは別ディレクトリに存在する
# 例: /Users/yamamoto/git/mado/.worktrees/task-001-... → -Users-yamamoto-git-mado--worktrees-task-001-...

# tool_use（Bash コマンド）を抽出する
python3 - <<'EOF'
import sys, json
for line in open("$JSONL"):
    obj = json.loads(line)
    if obj.get("type") == "assistant":
        for block in obj.get("message", {}).get("content", []):
            if isinstance(block, dict) and block.get("type") == "tool_use":
                inp = block.get("input", {})
                cmd = inp.get("command", "")
                if cmd:
                    print(cmd[:300])
                    print("---")
EOF
```

> **注意 — コンパクション後は tool_use が消える**: Claude Code はコンテキスト上限に達すると
> 会話を圧縮する。圧縮後の JSONL は `assistant` メッセージに `text` ブロックしか残らず、
> `tool_use` ブロックはすべて失われる。コンパクション済みかどうかは行数（数十行以下）
> や `tool_use` count がゼロかで判断できる。

### hook_signals テーブルを参照する — 「どの hook が実際に発火したか」

`task_sessions` がセッション索引であるのに対し、`hook_signals` テーブルは
**Manager daemon が受信した全 hook シグナルの生ログ** である（T216「hook 全送信ポリシー」）。
hook shell → daemon の受信が成立したかを Manager の分岐判定（`handleMessage`）前に
確認できるため、「Conductor が idle に戻らない」「Agent の完了が検知されない」等の
症状で最初に引くテーブル。

記録される hook type の例: `SESSION_STARTED` / `SESSION_STOPPED` / `SESSION_ENDED` /
`SESSION_IDLE` / `SESSION_CLEAR` / `AGENT_SPAWNED` / `SESSION_ASK` / `CONDUCTOR_DONE`。

スキーマ（`skills/cmux-team/manager/trace-store.ts` の `CREATE TABLE IF NOT EXISTS hook_signals`）:

```sql
CREATE TABLE hook_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  type TEXT NOT NULL,
  surface TEXT,
  pid INTEGER,
  reason TEXT,
  source TEXT,
  question TEXT,
  task_run_id TEXT,
  payload_json TEXT NOT NULL
);
-- index: type / surface / timestamp
```

#### 方式 A: `cmux-team trace-hooks` サブコマンド（T217）

別プロジェクトを対象にする場合は必ず対象 CWD で実行する。

```bash
# id DESC で新しい順に最大 50 件（デフォルト）
( cd "$TARGET" && cmux-team trace-hooks )

# hook type で絞り込み
( cd "$TARGET" && cmux-team trace-hooks --type SESSION_ENDED --limit 20 )

# surface で絞り込み（surface:665 / 665 / C[665] のいずれも受理）
( cd "$TARGET" && cmux-team trace-hooks --surface 'C[665]' )

# task_run_id で絞り込み、JSON 配列として出力
( cd "$TARGET" && cmux-team trace-hooks --task-run task-042-1712345678 --json )
```

オプション: `--type <TYPE>` / `--surface <surface>` / `--task-run <id>` /
`--limit <N>`（デフォルト 50、id DESC）/ `--json`。
コマンド実装は `skills/cmux-team/manager/main.ts` の `cmdTraceHooks`。

#### 方式 B: sqlite3 で直接 readonly 参照

```bash
# ある task_run の hook を時系列（古い順）で見る
sqlite3 "file:$TARGET/.team/traces/traces.db?mode=ro" -readonly \
  "SELECT timestamp, type, surface, pid, reason, task_run_id
   FROM hook_signals
   WHERE task_run_id='task-042-1712345678'
   ORDER BY id ASC;"

# ある surface で発火した hook を時系列で見る
sqlite3 "file:$TARGET/.team/traces/traces.db?mode=ro" -readonly \
  "SELECT timestamp, type, reason, source
   FROM hook_signals
   WHERE surface='surface:665'
   ORDER BY id ASC;"
```

ロック回避は他テーブルと同じく `?mode=ro` URI または `cp` スナップショット方式を使う
（「注意事項 → trace DB のロック」参照）。

#### 調査手順の指針

- **Conductor が idle に戻らない** → `type IN ('SESSION_IDLE','SESSION_CLEAR','SESSION_ENDED')` を対象 surface で絞り、hook が届いているか確認する
- **Agent の完了が検知されない** → `type='CONDUCTOR_DONE'` または `type='SESSION_ENDED'` を task_run_id で絞る
- **hook 自体が発火していない**（hook_signals に行が無い） → hook shell 側の問題。Claude Code 側の hook 設定と matcher を疑う
- **hook は届いているが Manager が反応していない** → Manager の分岐判定（`handleMessage`）側の問題。`manager.log` と照合して原因を特定する

`hook_signals` は Manager のフィルタ前の生ログなので、「hook が届いたか」と
「Manager が正しく処理したか」を切り分けるためのプライマリソースとして扱う。

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
