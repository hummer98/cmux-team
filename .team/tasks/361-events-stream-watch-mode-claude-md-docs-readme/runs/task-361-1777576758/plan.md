# T361 実装計画 — events stream / watch mode を CLAUDE.md / docs / README に追加

T357（events stream spec）/ T358（events writer）/ T359（`cmux-team events` CLI）/
T360（`/cmux-team:watch` slash command）の成果物を踏まえ、events stream と watch mode を
**opt-in トーンを保ったまま** ユーザー向けドキュメントに反映する。

Master template (`skills/cmux-team/templates/master.md`) および CLAUDE.md の Master セクション本体への組み込みは
Phase 2 で別 issue として議論するため **本タスクではノータッチ**。

---

## 1. 変更ファイル一覧と編集の概要

| ファイル | 編集内容 |
|---|---|
| `docs/spec/glossary.md` | §10「コミュニケーション系」テーブルに `watch mode` 用語を 1 行追加（`events stream` / `event channel` は既追加なので変更しない） |
| `docs/spec/00-project-overview.md` | Core Concept のアーキテクチャ図直後（`Target Users` 直前）に「events channel（opt-in）」段落を 1 つ挿入。Phase 1 では opt-in であることを明記 |
| `CLAUDE.md` | §通信プロトコルの「進捗情報の取得方法」テーブル直後に「events stream（opt-in watch mode 用）」サブセクションを追加 |
| `README.md` | Slash Commands テーブルに `/cmux-team:watch` 行を追加。Communication テーブルに events stream 行を追加 |
| `README.ja.md` | スラッシュコマンド テーブルに `/cmux-team:watch` 行を追加。通信モデル テーブルに events stream 行を追加 |

5 ファイルの編集はそれぞれ独立しており、順序依存はない。

---

## 2. ファイル別の具体的編集指示

### 2.1 `docs/spec/glossary.md`

**挿入位置**: §10「コミュニケーション系」テーブルの `event channel` 行（163 行目）の **直後**、`hook` 行（164 行目）の **直前**。

**挿入する 1 行**（既存テーブルの行フォーマットに合わせる、逐語）:

```markdown
| watch mode | Master が `/cmux-team:watch` を能動 invoke した時のみ起動する opt-in な events stream 監視モード。`task_completed` の自動 PR merge / conflict resolve / `git pull --ff-only` までを Master が自走し、判断が必要な event は escalate する。default 無効。 | [`../../commands/watch.md`](../../commands/watch.md), [`10-events-stream.md`](10-events-stream.md) | events stream / event channel |
```

**注意**:

- `events stream` / `event channel` の行（162-163 行目）は **既に存在するため触らない**。重複して挿入しないこと。
- §10 末尾の「**関連 spec**: …」行（171 行目）は変更不要（`10-events-stream.md` が既に列挙されている）。
- §11 の `metrics SSOT` 行（177 行目）は触らない。

### 2.2 `docs/spec/00-project-overview.md`

**挿入位置**: Core Concept のアーキテクチャ図のコードブロック終端 ` ``` ` （35 行目）の **直後**、`## Target Users` 見出し（37 行目）の **直前**。

**挿入する段落**（前後に空行を 1 行ずつ確保する、逐語）:

```markdown
### events channel（opt-in、Phase 1）

Manager daemon は上記の pull 型の制御フローとは別に、**外向け event channel** として
`.team/logs/events.jsonl` に状態変化（`task_completed` / `conductor_asking` /
`task_sync_guard_rejected` 等）を JSONL で append-only に書き出す。`cmux-team events`
CLI および Master の watch mode（`/cmux-team:watch`）が購読する一次ソースで、4 層の
基本制御経路（Master → Manager → Conductor → Agent）には介在しない補助チャネル。

**Phase 1 では opt-in**。default 無効で、user が `/cmux-team:watch` を能動 invoke した
ときのみ Master が監視を開始する。daemon は events.jsonl への書き出し自体は常時行うため、
`tail -F` や `cmux-team events --follow` で外部からも自由に購読できる。schema・event 一覧は
[`10-events-stream.md`](10-events-stream.md) を参照。
```

**注意**:

- §仕様ドキュメント索引のテーブル（121-134 行目）には `10-events-stream.md` 行が既にあるため触らない。
- アーキテクチャ図のコードブロック内（13-35 行目）は触らない（4 層の基本フローと events channel は別レイヤーの補助チャネル、図への混入は責務分離を曖昧にするため避ける）。
- Key Principles（41-47 行目）の文言は変更しない。

### 2.3 `CLAUDE.md`

**挿入位置**: §通信プロトコル の「進捗情報の取得方法」テーブル末尾（198 行目 — `metric サマリ` の行）の **直後**、`## Ready 昇格時の sync state ガード`（200 行目）の **直前**。

**挿入する段落**（前後に空行を 1 行ずつ確保する、逐語）:

```markdown
### events stream（opt-in watch mode 用）

Manager daemon は外向け event channel として `.team/logs/events.jsonl` に
状態変化を JSONL で append-only に書き出す（schema は `docs/spec/10-events-stream.md` 参照）。

- **default 無効**。user が `/cmux-team:watch` を能動 invoke したときのみ Master が監視を開始する
- 過去 event の遡及処理は行わない（state は外部に持たない）
- `cmux-team events [--follow] [--types <names>] [--format json|tsv]` CLI で tail / filter 可能
- 詳細仕様は `docs/spec/10-events-stream.md`、watch mode の挙動は `commands/watch.md` を参照

> Master template (`skills/cmux-team/templates/master.md`) への自動 watch 組み込みは Phase 2 で別途検討（本節は外部公開チャネルの存在告知のみ）。将来 default 化を検討するかは別 issue で議論する。
```

**注意**:

- 既存の §通信プロトコル の `.team/` ディレクトリ構造ブロック（177-187 行目）は触らない。`logs/` 行のコメントには既に `manager.log + traces/bodies/` が記載されているが、ここに `events.jsonl` を追記しない（ディレクトリ構造の正確性は維持しつつ、events stream は新サブセクションで案内する方針）。
- 「進捗情報の取得方法」テーブル本体には `cmux-team events` 行を追加しない。**進捗確認コマンド案内は不要というユーザー方針に反するため**。events stream は user-invoked watch 専用として独立サブセクションで紹介する。
- 階層は `### events stream（opt-in watch mode 用）`（h3）。直前の「進捗情報の取得方法」が h3 なので、h2 の §通信プロトコル 配下の並列 h3 として配置する。

### 2.4 `README.md`

#### 2.4.1 Slash Commands テーブルに `/cmux-team:watch` 行を追加

**挿入位置**: `#### Slash Commands (run within Claude)` セクションのテーブル（203-211 行目）の `/master` 行（205 行目）と `/team-spec` 行（206 行目）の **間**。

**old**（206 行目）:

```markdown
| `/master` | Reload Master role | After `/clear` |
| `/team-spec [summary]` | Brainstorm requirements | Deciding what to build |
```

**new**:

```markdown
| `/master` | Reload Master role | After `/clear` |
| `/cmux-team:watch` | Watch events stream and auto-handle PR merge / conflict resolve / pull (opt-in) | When you want Master to auto-merge completed PRs and surface escalations |
| `/team-spec [summary]` | Brainstorm requirements | Deciding what to build |
```

#### 2.4.2 Communication テーブルに events stream 行を追加

**挿入位置**: `### Communication` テーブル（256-264 行目）の末尾、`Conductor ← Agent` 行（263 行目）の **直後**、`## Project-Specific Agent Instructions`（265 行目）の **直前**。

**old**（263-264 行目）:

```markdown
| Conductor ← Agent | `cmux-team await-agent` (fs.watch on Agent done marker) |

## Project-Specific Agent Instructions
```

**new**:

```markdown
| Conductor ← Agent | `cmux-team await-agent` (fs.watch on Agent done marker) |
| daemon → external readers | events stream (`.team/logs/events.jsonl`, JSONL append-only) — opt-in, consumed by `cmux-team events --follow` and Master `/cmux-team:watch` |

## Project-Specific Agent Instructions
```

**注意**:

- 既存の `daemon → Conductor` / `Conductor → Agent` 等の主制御フローには影響しない補助チャネルとして、テーブル末尾に 1 行追加する。
- `/cmux-team:watch` の表記は `commands/watch.md` の見出しと一貫させる（先頭の `:` は colon、`watch` は小文字）。

### 2.5 `README.ja.md`

#### 2.5.1 スラッシュコマンド テーブルに `/cmux-team:watch` 行を追加

**挿入位置**: `#### スラッシュコマンド（Claude 内で実行）` セクションのテーブル（191-199 行目）の `/master` 行（193 行目）と `/team-spec` 行（194 行目）の **間**。

**old**（193-194 行目）:

```markdown
| `/master` | Master ロール再読み込み | `/clear` 後 |
| `/team-spec [概要]` | 要件をブレスト | 何を作るか決める時 |
```

**new**:

```markdown
| `/master` | Master ロール再読み込み | `/clear` 後 |
| `/cmux-team:watch` | events stream を監視して PR merge / conflict resolve / pull を自動処理（opt-in） | 完了した PR の自動 merge と介入要 event のエスカレーションを Master に任せたい時 |
| `/team-spec [概要]` | 要件をブレスト | 何を作るか決める時 |
```

#### 2.5.2 通信モデル テーブルに events stream 行を追加

**挿入位置**: `### 通信モデル` テーブル（259-266 行目）の末尾、`daemon → Master` 行（266 行目）の **直後**、`### エージェントロール`（268 行目）の **直前**。

**old**（266-268 行目）:

```markdown
| daemon → Master | なし（Master が `manager.log` / `task-state.json` を直接参照） |

### エージェントロール
```

**new**:

```markdown
| daemon → Master | なし（Master が `manager.log` / `task-state.json` を直接参照） |
| daemon → 外部 reader | events stream（`.team/logs/events.jsonl`、JSONL append-only）— opt-in。`cmux-team events --follow` / Master `/cmux-team:watch` が購読 |

### エージェントロール
```

**注意**:

- 英語版（README.md）の方は `daemon → external readers` 行を Communication テーブル末尾（`Conductor ← Agent` 行の直後）に置くが、日本語版（README.ja.md）の通信モデル テーブルには既に `daemon → Master` 行があるため、その直後に追加する。**両言語版で挿入位置が違うのは既存テーブル構造の差**による。
- `/cmux-team:watch` の表記は `commands/watch.md` の見出しと一貫。

---

## 3. 留意事項

### 3.1 opt-in トーンの保持

以下は **絶対に書かない**（強い推奨は Phase 2 で別途議論）:

- 「常時 watch せよ」
- 「watch mode を default で有効にすべき」
- 「Master は events stream を購読することが望ましい」
- 「events stream を使わないと進捗を取りこぼす」

代わりに使う表現:

- 「user が能動的に `/cmux-team:watch` を invoke したときのみ」
- 「opt-in」「default 無効」
- 「将来 default 化を検討」（強い推奨を避けるトーン）

### 3.2 Master template / Master セクションには介入しない

以下のファイルは **本タスクで一切編集しない**（Phase 2、別 issue）:

- `skills/cmux-team/templates/master.md`
- `skills/cmux-team/templates/ja/master.md`（存在する場合）
- `skills/cmux-team/templates/en/master.md`（存在する場合）
- `skills/cmux-team/SKILL.md`（cmux-team スキル本体に Master の watch 義務を書き込まない）
- `commands/master.md`（存在する場合）

### 3.3 用語表記の一貫性

| 表記 | 用途 |
|---|---|
| `events stream` | チャネル全体を指す総称 |
| `event channel` | 「外向け論理チャネル」という性格を強調する文脈 |
| `watch mode` | Master の opt-in 監視モード |
| `/cmux-team:watch` | slash command 名（colon は半角、`watch` は小文字） |
| `.team/logs/events.jsonl` | ファイルパス（必ずバッククォートで囲む） |
| `cmux-team events` | CLI 名（必ずバッククォートで囲む） |

これら以外の表記揺れ（`events-stream` ハイフン、`watch-mode` ハイフン、`Watch Mode` キャピタライズ、`/watch` の prefix なし表記等）は使わない。

### 3.4 リンク整合

- `docs/spec/10-events-stream.md` への相対リンクは glossary.md からは `[`10-events-stream.md`](10-events-stream.md)`（同じディレクトリ）。
- `docs/spec/00-project-overview.md` からは同様に `[`10-events-stream.md`](10-events-stream.md)`。
- `CLAUDE.md` からは spec 本体は `docs/spec/10-events-stream.md`（バッククォート + 文字列、リンク化は不要、既存スタイルに準拠）。
- glossary.md から `commands/watch.md` への相対リンクは `[`../../commands/watch.md`](../../commands/watch.md)` となる（`docs/spec/glossary.md` からの相対）。

### 3.5 spec ファイル冒頭表記

`docs/spec/10-events-stream.md` の冒頭ブロック（1-7 行目）には既に
"Master の watch mode（`/cmux-team:watch`）" という表記があり、本タスクの追加文章でも同表記を踏襲する。
独自の言い換え（"watch コマンド"、"watcher" 等）は避ける。

---

## 4. 検証方法

### 4.1 grep で確認すべきキーワード

実装後、以下のコマンドが期待行数を返すこと。

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-361-1777576758

# (1) glossary に watch mode が 1 行追加された
grep -c "^| watch mode |" docs/spec/glossary.md  # => 1

# (2) 00-project-overview.md に events channel 段落が追加された
grep -c "events channel（opt-in、Phase 1）" docs/spec/00-project-overview.md  # => 1

# (3) CLAUDE.md に events stream サブセクションが追加された
grep -c "### events stream（opt-in watch mode 用）" CLAUDE.md  # => 1

# (4) README.md / README.ja.md に /cmux-team:watch 行が追加された
grep -c '`/cmux-team:watch`' README.md       # => 1（Slash Commands テーブル内）
grep -c '`/cmux-team:watch`' README.ja.md    # => 1（スラッシュコマンド テーブル内）

# (5) README.md / README.ja.md に events stream 通信行が追加された
grep -c "events.jsonl" README.md             # => 1
grep -c "events.jsonl" README.ja.md          # => 1

# (6) 既存の events stream / event channel エントリが重複追加されていない
grep -c "^| events stream |" docs/spec/glossary.md   # => 1（既存のみ、増えてはいけない）
grep -c "^| event channel |" docs/spec/glossary.md   # => 1（既存のみ、増えてはいけない）
```

### 4.2 リンクの整合確認

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-361-1777576758

# 10-events-stream.md ファイルが存在する
test -f docs/spec/10-events-stream.md && echo OK

# commands/watch.md ファイルが存在する
test -f commands/watch.md && echo OK

# glossary.md → commands/watch.md の相対リンクが解決する
test -f docs/spec/../../commands/watch.md && echo OK
```

### 4.3 トーン確認（手動 review）

以下の文字列が **新規追加された箇所には現れない** こと:

```bash
# 強い推奨表現が紛れ込んでいないか
grep -E "(常時 watch|常時監視|watch mode を default|必ず watch|watch を有効化すべき|recommend.*watch.*always)" \
  docs/spec/glossary.md docs/spec/00-project-overview.md CLAUDE.md README.md README.ja.md
# => 0 件
```

### 4.4 watch コマンドの動作確認（記載前提の事前確認）

タスク本文の確認事項に「T360 の watch command が実際に動作することを確認した上で記載すること」とあるため、
plan.md を実装する Implementer は `/cmux-team:watch` の **pre-flight checks** が現在の repo 状態で動作することを以下で確認する:

```bash
cd /Users/yamamoto/git/cmux-team/.worktrees/task-361-1777576758
test -f .team/daemon.pid && echo "daemon: running"
test -f .team/logs/events.jsonl && echo "events.jsonl: exists"
cmux-team events --help > /dev/null 2>&1 && echo "events CLI: available"
```

3 つすべて pass すれば watch command の前提（v4.22.0+、daemon 起動中、events writer 動作中）が満たされていることが確認できる。
**1 つでも fail する場合は記載のままで OK**（README/CLAUDE.md には version 要件を書かないので、fail しても plan.md の編集指示は変更不要）。

---

## 5. 実装後の追加作業（本タスクの scope 外、参考）

- Phase 2 別 issue: Master template に `/cmux-team:watch` の自動 invoke を組み込むか議論
- Phase 2 別 issue: events stream を default 化する判断基準（介入頻度、誤検知率、user feedback）の確定
- 本タスクの scope 内では **新規 issue 起票も行わない**。Phase 2 のロードマップ整理は別タスクで実施する。
