# Plan: cmux-team-investigate スキル作成（プロジェクトローカル / 配布外）

## 目的

別プロジェクト（`~/git/mado`, `~/git/Dear` 等）の `.team/` 配下 (`manager.log`、`traces.db`、`task-state.json`、surface 画面) を調査するための定型手順を、**このリポジトリ内でだけ有効な開発者用スキル**として `.claude/skills/cmux-team-investigate/SKILL.md` に記述する。npm publish 配布物には含めない。

## 1. 対象ファイルの一覧と変更内容

### 新規作成

- `.claude/skills/cmux-team-investigate/SKILL.md`
  - YAML frontmatter（`name`, `description`）+ Markdown 本文
  - 後述「3. SKILL.md 構造案」を参照

### 変更

- `CLAUDE.md`
  - 追記位置: 「## コーディング規約」セクションの末尾（**299 行目の直後**、`## cmux API 使用上の注意`（301 行目）の前）
  - 追記内容（2 行のサブセクション）:

    ```markdown
    ### 開発者用スキル

    別プロジェクト（mado, Dear 等）の `.team/` 調査は `.claude/skills/cmux-team-investigate/SKILL.md` を参照。
    このスキルはこのリポジトリのワークツリー内でのみ有効で、npm publish には含まれない（配布外）。
    ```

### 変更しないことを確認するファイル

- `package.json`（`files` 配列に `.claude/` が含まれていない — 既に未含有を確認済み）
- `.claude-plugin/plugin.json`（`"skills": "./skills/"` が変更されていない — `.claude/skills/` ではなく `./skills/` を指している）

## 2. 配布対象外であることの根拠（事前確認結果）

- `package.json` の `files` 配列（14〜30 行）に列挙されているのは `bin/`, `skills/cmux-team/SKILL.md`, `skills/cmux-team/templates/`, `skills/cmux-team/manager/**/*.{ts,tsx}`, `skills/cmux-agent-role/`, `commands/`, `.claude-plugin/`, `README.md`, `README.ja.md`, `LICENSE`, `CHANGELOG.md` のみ。`.claude/` は含まれていない。
- `.claude-plugin/plugin.json` の `skills` キーは `./skills/`（プロジェクト直下の `skills/` のみ参照）。`.claude/skills/` はプラグインの skills として認識されない。
- 結果: `.claude/skills/cmux-team-investigate/` は npm publish にも plugin 配布にも入らず、このリポジトリのワークツリー内で Claude Code を起動した場合のみロードされる。

## 3. SKILL.md 構造案

### 3.1 YAML frontmatter

```yaml
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
```

### 3.2 本文セクション構成

1. 「概要」 — 何のためのスキルか、対象リポジトリと配布外であることを明記
2. 「前提」 — 対象は別ワークスペースで起動している cmux-team プロジェクト、`.team/` 構造を持つこと
3. 「Step 1: 対象リポジトリの特定」
4. 「Step 2: ログ収集」
5. 「Step 3: trace DB 検索」
6. 「Step 4: surface 直接参照」
7. 「Step 5: 時系列相関」
8. 「注意事項」（書き込み禁止 / Master 責務継続 / DB ロック）

### 3.3 各手順のコマンド例

#### Step 1: 対象リポジトリの特定

```bash
# パス指定が明確な場合
TARGET=~/git/mado

# surface ID 経由で特定する場合（cmux 上の不審なペインから辿る）
cmux identify --surface <surface-id>
# → caller.workspace_ref からワークスペースのルートを推定し、
#   そこに対応する .team/ を持つリポジトリを TARGET にセット
TARGET=$(cmux identify --surface <surface-id> | jq -r '.caller.workspace_ref')

# .team/ の存在確認
ls "$TARGET/.team/" || { echo "対象に .team/ が無い → 通常のリポジトリ調査に切り替え"; exit 1; }
```

#### Step 2: ログ収集

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

#### Step 3: trace DB 検索

> **重要**: 現行の `cmux-team trace-task` は CWD の `.team/traces/traces.db` のみを参照する（`--db` オプション無し）。
> 別リポジトリの DB を読むには次のいずれかを使う:

```bash
# 方式 A: 対象リポジトリに cd して cmux-team trace-task を実行
( cd "$TARGET" && cmux-team trace-task <task-id> )

# 方式 B: sqlite3 で直接 readonly 参照（ロック回避のため readonly モード）
sqlite3 "file:$TARGET/.team/traces/traces.db?mode=ro" -readonly \
  "SELECT timestamp, task_id, role, surface, event FROM task_sessions WHERE task_id='042' ORDER BY id ASC;"

# 方式 C: ロックが掛かっている場合は cp してから読む
cp "$TARGET/.team/traces/traces.db" /tmp/traces-snapshot.db
sqlite3 /tmp/traces-snapshot.db "SELECT * FROM task_sessions WHERE task_id='042';"

# 補足: 全文検索が必要な場合は body ファイルを直接 grep
grep -rl "<query>" "$TARGET/.team/logs/traces/bodies/"
```

#### Step 4: surface 直接参照

```bash
# 別ワークスペースのため必ず --workspace を付ける（CLAUDE.md「cmux API 使用上の注意」参照）
WS=$(cmux identify --surface <surface-id> | jq -r '.caller.workspace_ref')
cmux read-screen --surface <surface-id> --workspace "$WS"

# ワークスペース全体の状態
cmux list-status --workspace "$WS"
cmux tree --workspace "$WS"
```

#### Step 5: 時系列相関

```bash
# manager.log のタイムスタンプ（ローカル TZ 付き ISO 8601）を基準にする
grep "task-042" "$TARGET/.team/logs/manager.log"
# 例: [2026-04-12T10:30:15+09:00] conductor_started conductor=1 task=042

# 同タスクの trace 行を取得
sqlite3 "file:$TARGET/.team/traces/traces.db?mode=ro" -readonly \
  "SELECT timestamp, role, event FROM task_sessions
   WHERE task_id='042' ORDER BY timestamp ASC;"

# 必要なら同一タイムウィンドウで manager.log と DB 両方を時刻でソートしてマージ確認
```

### 3.4 注意事項セクション

- **書き込み禁止**: 対象プロジェクトの `.team/` は読み取り専用。`create-task` / `update-task` / `close-task` 等の書き込み系コマンドを対象 CWD で実行してはならない。修正タスクは**このリポジトリ**または対象リポジトリのオーナーに渡すかたちで起票する。
- **Master 責務の継続**: 調査で原因が特定できたら、修正は別タスクとして適切なリポジトリに `cmux-team create-task` で起票する。Master が直接コードを書かない原則は変わらない。
- **trace DB のロック**: daemon が WAL モードで開いているため、別プロセスからの書き込みアクセスは衝突する可能性がある。読むときは `?mode=ro` URI または `cp` スナップショットを使う。
- **配布外**: このスキル自体はこのリポジトリの `.claude/skills/` 配下にあり、npm publish にも plugin 配布にも含まれない。他プロジェクトの Claude Code セッションでは利用できない。

## 4. 検証手順

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-165-1775961686

# 1. ファイル生成確認
test -f .claude/skills/cmux-team-investigate/SKILL.md && echo OK

# 2. .claude/ が npm publish に含まれないこと
npm pack --dry-run 2>&1 | grep -i '\.claude/' && echo "FAIL: .claude/ が含まれている" || echo "OK: .claude/ は含まれない"

# 3. .claude-plugin/plugin.json の skills キー
grep '"skills"' .claude-plugin/plugin.json
# → "skills": "./skills/", のままであること

# 4. CLAUDE.md 追記確認
grep -n "開発者用スキル" CLAUDE.md
# → 「## コーディング規約」の直後（300〜301 行付近）に入っていること

# 5. SKILL.md frontmatter の name と description が valid YAML であること
head -20 .claude/skills/cmux-team-investigate/SKILL.md
```

## 5. 懸念事項とエッジケース

| 項目 | 内容 | 対応案 |
|------|------|--------|
| 対象に `.team/` が無い | 通常のリポジトリ（cmux-team を導入していない）の場合 | Step 1 で `ls "$TARGET/.team/"` が失敗したら、通常の `git log` / `grep` ベース調査に切り替えるよう SKILL.md に明記する |
| `cmux-team trace --db` は存在しない | 現行 CLI は `trace-task <task-id>` のみで `--db` オプション無し。タスク本文の Step 3 記述（`cmux-team trace --db <repo>/.team/traces/traces.db`）は実装と乖離している | SKILL.md では「方式 A: cd して `cmux-team trace-task` 実行 / 方式 B: sqlite3 readonly 直接クエリ / 方式 C: cp スナップショット」の 3 方式に置き換える。タスク本文と乖離するが、これは現行実装に合わせるための合理的な変更 |
| trace DB のロック | daemon が WAL モードで開いているため別プロセスからの読み取りが詰まることがある | `sqlite3 "file:...?mode=ro" -readonly` または `cp` スナップショット方式を Step 3 のデフォルトとして提示 |
| traces.db のスキーマは FTS5 ではない | CLAUDE.md は「SQLite FTS5」と書いているが `trace-store.ts` の `task_sessions` テーブルは通常テーブル + 通常 INDEX。本文全文検索は `.team/logs/traces/bodies/` を grep するしかない | SKILL.md でも「全文検索したい場合は bodies/ ディレクトリを `grep -r` する」と明記する |
| surface ID から対象リポジトリを特定する操作 | `cmux identify --surface <id>` の `caller.workspace_ref` がそのままパスかは未検証 | SKILL.md には「workspace_ref からリポジトリパスを推定し、`.team/` の存在で確認する」と保守的に書く |
| `.claude/` が将来 plugin 経由で誤配布される懸念 | プラグインマニフェストが今後 `.claude/skills/` を拾うように変わると配布されてしまう | CLAUDE.md 追記文に「配布外」を明記し、回帰防止のため検証手順 (`npm pack --dry-run`) を README/コミットメッセージで言及する |

## 6. 完了条件チェックリスト

- [ ] `.claude/skills/cmux-team-investigate/SKILL.md` が作成されている
- [ ] frontmatter に `name: cmux-team-investigate` と発動条件を含む `description` が記載されている
- [ ] 本文に Step 1〜5 のコマンド例（```bash ブロック）が入っている
- [ ] 注意事項（書き込み禁止 / Master 責務継続 / DB ロック / 配布外）が記載されている
- [ ] `CLAUDE.md` の「## コーディング規約」直後に「### 開発者用スキル」サブセクション（2 行）が追記されている
- [ ] `npm pack --dry-run 2>&1 | grep '\.claude/'` が空（`.claude/` が配布対象外）
- [ ] `.claude-plugin/plugin.json` の `skills` キーが `./skills/` のまま

## 7. 実装担当 Agent への引き継ぎメモ

- タスク本文の Step 3 に書かれている `cmux-team trace --db <repo>/.team/traces/traces.db --search <query>` は**現行 CLI に存在しない**。SKILL.md では `cmux-team trace-task <id>`（cd 方式）と `sqlite3` 直接クエリの 2 方式に置き換えること。乖離をユーザーに報告する必要は無い（plan.md の懸念事項で既に明示している）。
- CLAUDE.md への追記は `## cmux API 使用上の注意` の直前（現状 300〜301 行目の空行に挟まれた位置）に入れる。前後セクションの行間（空行 1 行）を維持すること。
- SKILL.md 内のサンプルコマンドはあくまで「定型手順の例」であり、実行時にコピペして使う前提なので、変数名 (`TARGET`, `WS` 等) は短く明示的に。
