---
name: cmux-team
description: >
  Use when orchestrating multi-agent development via cmux.
  Triggers: .team/ directory exists, user says "team", "spawn agents",
  "parallel", "sub-agent", or any /team-* command is invoked.
  Provides: agent spawning, monitoring, result collection, synchronization protocols.
---

# cmux-team: マルチエージェントオーケストレーション

4層アーキテクチャ（Master → Manager → Conductor → Agent）による
自律的マルチエージェント開発オーケストレーションスキル。

## 0. アーキテクチャ概要

### 4層構造

```
[ユーザー] ↔ [Master] → [Manager (daemon)] → [Conductor (常駐)] → [Agent (実作業)]
    │            │              │                       │                      │
    │            │              │                       │                      ├─ コード実装
    │            │              │                       │                      ├─ テスト実行
    │            │              │                       │                      └─ 完了→停止
    │            │              │                       │
    │            │              │                       ├─ git worktree 内で作業
    │            │              │                       ├─ Agent 起動・監視（タブとして作成）
    │            │              │                       ├─ 結果統合
    │            │              │                       ├─ タスクを close（cmux-team close-task）
    │            │              │                       └─ done マーカー作成→idle に戻る
    │            │              │
    │            │              ├─ タスク検出→idle Conductor にタスク割り当て
    │            │              ├─ done マーカーで完了検出（pull 型）
    │            │              └─ Journal 読み取り + ログ記録 + Conductor リセット
    │            │
    │            ├─ タスク作成
    │            ├─ 真のソース直接参照→報告
    │            └─ Manager 健全性確認
    │
    └─ 指示・確認
```

### 各層の責務

| 層 | 責務 | 特徴 |
|----|------|------|
| **Master** | ユーザー対話。タスク作成。真のソース直接参照で進捗報告。 | 作業しない。ポーリングしない。 |
| **Manager** | daemon として常駐。[TASK_CREATED] 通知で起床→タスク検出→idle Conductor にタスク割り当て→done マーカーで完了検出→ログ記録→Conductor リセット→アイドル化。 | アイドル時停止、イベント駆動。 |
| **Conductor** | 常駐。タスクを割り当てられると自律実行。git worktree 隔離。Agent spawn（タブ）→結果統合→タスクを close（`cmux-team close-task`）→done マーカー作成→idle に戻る。 | 常駐。タスク完了後も停止しない。 |
| **Agent** | 実作業（実装・テスト・リサーチ等）。 | 完了したら停止。上位が見に来る。 |

### 通信方式

| 方向 | 手段 |
|------|------|
| Master → Manager | `.team/tasks/` + `task-state.json` + `cmux send` 通知（イベント駆動） |
| Manager → Conductor | `cmux send`（`/clear` + 新プロンプト送信） |
| Manager ← Conductor | done マーカーファイル（`.team/output/conductor-N/done`）の存在確認（pull 型） |
| Conductor → Agent | `cmux send`（プロンプト送信） |
| Conductor ← Agent | `cmux-team await-agent`（done マーカーの fs.watch）+ PID watcher |
| Manager → Master | `.team/logs/manager.log` + `cmux-team status`（team.json + ログ） |

## 1. コマンド一覧

### スラッシュコマンド（Claude 内）

| コマンド | 説明 |
|---------|------|
| `/master` | Master ロール再読み込み（`/clear` 後の復帰用） |
| `/team-spec` | 要件ブレスト（Master が直接ユーザーと対話） |
| `/team-task` | タスク管理（タスクの作成・一覧・クローズ） |
| `/team-archive` | 完了タスクのアーカイブ（closed → archived） |
| `/artifact` | 知見のアーティファクト化（作成・一覧・表示） |

### CLI サブコマンド

チーム体制の構築・管理はすべて CLI 経由で行う:

| コマンド | 説明 |
|---------|------|
| `cmux-team start` | daemon 起動 + Master spawn + レイアウト構築（レイアウト消失時は自己修復。T286） |
| `cmux-team status` | ステータス表示（team.json + ログ末尾） |
| `cmux-team send TASK_CREATED` | タスク作成通知（`--task-id`, `--task-file` 必須） |
| `cmux-team send TODO` | TODO 通知（`--content` 必須） |
| `cmux-team send SHUTDOWN` | シャットダウン通知（内部用。明示停止は `kill <pid>`） |
| `cmux-team spawn-agent` | Agent spawn（`--conductor-surface`, `--role`, `--prompt` or `--prompt-file`） |
| `cmux-team agents` | 稼働中エージェント一覧 |
| `cmux-team kill-agent` | Agent 終了（`--surface` 必須、`--conductor-surface` 任意） |
| `cmux-team create-task` | タスク作成（`--title` 必須、`--priority`, `--status`, `--body`, `--depends-on`, `--base-branch`, `--run-after-all`, `--exclusive` 任意） |
| `cmux-team update-task` | タスク状態更新（`--task-id`, `--status` 必須） |
| `cmux-team close-task` | タスククローズ（`--task-id` 必須、`--journal` 任意） |
| `cmux-team await-task` | タスク完了待ち（`--task-id` 必須、`--timeout` 任意） |
| `cmux-team trace` | API トレース検索（`--task`, `--search`, `--show`） |
| `cmux-team get-agent-instructions` | Agent ロールの overlay を表示（`--role` 必須） |
| `cmux-team set-agent-instructions` | overlay を書き込み（`--role` 必須、`--body` / `--from-file` / `--from-stdin`） |
| `cmux-team delete-agent-instructions` | overlay を削除（`--role` 必須、存在しなければ exit 0） |
| `cmux-team list-agent-instructions` | 全ロールの overlay 状況を一覧表示 |

## 1.1. プロジェクト固有の追加指示（agent instructions overlay）

プロジェクト固有の Agent への追加指示を `.team/agent-instructions/<role>.md` に置くと、`cmux-team spawn-agent` 実行時に prompt-file 中の `{{PROJECT_INSTRUCTIONS}}` プレースホルダがその内容で置換される。

### 対象ロール

`researcher` / `architect` / `planner` / `design-reviewer` / `implementer` / `inspector` / `dockeeper` / `task-manager` の 8 ロール。

`--role impl` は `implementer`、`--role reviewer` は `design-reviewer` にエイリアスされる（conductor-role.md の既存 heredoc 例との互換性維持）。

### 編集方法

```bash
# overlay を書き込む
cmux-team set-agent-instructions --role implementer --from-file ./my-impl-notes.md
cmux-team set-agent-instructions --role researcher --body "調査対象は 2025 年以降の論文に限る"
cat ./notes.md | cmux-team set-agent-instructions --role planner --from-stdin

# 内容確認
cmux-team get-agent-instructions --role implementer
cmux-team list-agent-instructions

# 削除
cmux-team delete-agent-instructions --role implementer
```

overlay ファイルは最大 100 KB。それを超えると set 時に exit 1。

### 適用タイミング

`cmux-team spawn-agent --prompt-file <path>` 実行時、prompt-file 内の `{{PROJECT_INSTRUCTIONS}}` プレースホルダが overlay 本文に展開される。Conductor が Agent 起動用の prompt-file を heredoc で書き出す際は、**必ず `{{PROJECT_INSTRUCTIONS}}` を単独行として残すこと**（quoted heredoc `'AGENT_PROMPT'` を使うと shell 展開されず安全）。

overlay が存在しない / 空の場合はプレースホルダが空文字に置換される。

### 典型パターン例

- コーディング規約（命名・コメント言語）を implementer に共有
- テスト方針（モック可否・カバレッジ基準）を inspector に共有
- 調査範囲制限（特定年代・特定著者のみ）を researcher に共有

### Settings タブで確認

dashboard TUI の `Settings` タブ（`4` キー）で 8 ロールの overlay 状況と config 値を一覧・プレビューできる（read-only）。

## 2. トレーサビリティ

daemon 起動時に API Proxy が自動起動し、全 API リクエストを SQLite FTS5 データベースに記録する。Master が過去の作業ログを検索・分析する際に活用できる。

### 自動プロキシ設定

daemon が起動すると Proxy が自動で立ち上がり、Master および Conductor に `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` を設定する。これにより全 API リクエストが Proxy 経由になり、リクエスト/レスポンスが自動記録される。

### メタデータ伝播

リクエストヘッダーからメタデータを動的に抽出し、トレースに紐付ける:

| ヘッダー | 内容 |
|---------|------|
| `x-cmux-task-id` | タスクID |
| `x-cmux-conductor-surface` | Conductor surface |
| `x-cmux-role` | エージェントロール |
| `x-claude-code-session-id` | Claude Code セッションID |

### trace CLI

`cmux-team trace` コマンドでトレースを検索・表示できる:

```bash
# タスクIDでフィルタ
cmux-team trace --task 035

# 全文検索（SQLite FTS5）
cmux-team trace --search "error"

# 特定トレースの詳細表示（リクエスト/レスポンス本文含む）
cmux-team trace --show 42

# Conductor IDでフィルタ
cmux-team trace --conductor conductor-1

# ロールでフィルタ
cmux-team trace --role impl

# 結果数制限（デフォルト20）
cmux-team trace --limit 50
```

### 活用例

Master がユーザーに進捗報告する際、過去の API リクエスト履歴を参照できる:

```bash
# あるタスクでどんな API リクエストが行われたか確認
cmux-team trace --task 035

# エラーに関連するリクエストを全文検索
cmux-team trace --search "rate_limit"
```

## 3. cmux 操作リファレンス

### 環境変数

| 変数 | 意味 |
|------|------|
| `CMUX_SOCKET_PATH` | cmux ソケットパス。設定されていれば cmux 環境内で動作中 |
| `CMUX_WORKSPACE_ID` | 現在のワークスペースID |
| `CMUX_SURFACE_ID` | 現在のサーフェスID |
| `CMUX_SURFACE` | cmux-team が設定。`surface:N` 形式。これが設定されていれば cmux-team 管理下 |

### 基本操作コマンド

| コマンド | 用途 |
|---------|------|
| `cmux identify` | 自分の workspace/surface を確認 |
| `cmux tree` | ペイン・サーフェス階層を表示（T195 以降は init 時の pane 逆引きのみ使用） |
| `cmux list-panes` | ペイン一覧 |
| `cmux list-pane-surfaces` | ペイン内のサーフェス一覧 |
| `cmux new-split right` | 右にペイン分割（`left`/`up`/`down` も可） |
| `cmux new-surface --pane pane:N` | ペイン内に新しいタブを作成 |
| `cmux send --surface surface:N "command\n"` | コマンド送信 |
| `cmux send-key --surface surface:N return` | キー送信 |
| `cmux read-screen --surface surface:N` | 画面読み取り |
| `cmux close-surface --surface surface:N` | サーフェス（タブ）を閉じる |
| `cmux rename-tab --surface surface:N "name"` | タブ名変更 |
| `cmux refresh-surfaces` | 画面バッファ強制更新 |

### send の改行ルール（重要）

**単一行**: 末尾に `\n` を付ける。
```bash
cmux send --surface surface:1 "echo hello\n"
```

**複数行**: 個別の `send` + `send-key return` で送信する。
```bash
cmux send --surface surface:1 "line 1"
cmux send-key --surface surface:1 return
cmux send --surface surface:1 "line 2"
cmux send-key --surface surface:1 return
```

**注意**: `\n` は最後の1つだけが Enter として機能する。途中の `\n` は改行にならない。

### 制御キーの送信

`send-key` を使う（`send` ではない）:

```bash
cmux send-key --surface surface:N ctrl+c    # 中断
cmux send-key --surface surface:N ctrl+d    # EOF
cmux send-key --surface surface:N ctrl+z    # サスペンド
cmux send-key --surface surface:N return    # Enter
cmux send-key --surface surface:N tab       # Tab
cmux send-key --surface surface:N escape    # Escape
```

**よくある間違い**: `cmux send "C-c"` や `cmux send "\x03"` → 動作しない。必ず `send-key` を使うこと。

### read-screen トラブルシューティング

| 問題 | 対処 |
|------|------|
| 空・古い出力 | `cmux refresh-surfaces` してからリトライ |
| 出力が切れる | `--scrollback` オプションを追加 |
| 特定行数だけ必要 | `--lines N` オプションを追加 |
| surface が見つからない | `cmux list-pane-surfaces` で確認 |

### 通知

```bash
# アプリ内通知（ペイン強調 + サイドバーバッジ）
cmux notify --title "完了" --body "ビルドが成功しました"

# macOS 通知センター（サウンド付き）
osascript -e 'display notification "ビルド完了" with title "Claude" sound name "Glass"'
```

## 4. タスク完了待ち（await-task）

`cmux-team await-task` はタスクの完了を `fs.watch` ベースで待機する CLI コマンド。
`cmux-team status` のポーリングに比べて軽量・高速で、Claude Code の `Bash run_in_background` と組み合わせることで Master がブロックされずにタスク完了を待てる。

### 基本的な使い方

```bash
# 単一タスクの完了を待つ
cmux-team await-task --task-id 108

# 複数タスクの完了を待つ（カンマ区切り）
cmux-team await-task --task-id 108,109

# タイムアウト指定（デフォルト: 3600秒）
cmux-team await-task --task-id 108 --timeout 7200
```

### 終了コード

| コード | 意味 | stdout/stderr |
|--------|------|---------------|
| 0 | 全タスク closed | summary.md の内容を stdout に出力 |
| 1 | いずれかのタスクが aborted | abort 理由を stderr に出力 |
| 2 | タイムアウト | 残タスク一覧を stderr に出力 |

### Master での活用パターン

```bash
# バックグラウンドでタスク完了を待つ（Claude Code の Bash run_in_background）
cmux-team await-task --task-id 108
# → task-notification で完了が通知される + summary が読める

# 「結果を見てから次を判断」するフロー
cmux-team await-task --task-id 108
# 完了後に summary を読んで次のアクションを決定
```

### depends-on との使い分け

| 方式 | 用途 |
|------|------|
| `depends-on` (frontmatter) | 自動チェーン: A → B の順序保証。Manager が自動で B を発火 |
| `await-task` (CLI) | 手動チェーン: A の結果を**見てから**次を判断するケース |

## 5. タスク属性

タスク frontmatter で表現される実行制御属性。`create-task` の CLI フラグで指定すると永続化される。

| 属性 | 意味 | CLI フラグ |
|------|------|-----------|
| `run_after_all: true` | 全 open タスク closed 後に実行（非排他 drain） | `--run-after-all` |
| `exclusive: true` | drain 後に単独実行。assigned の間は他の全 assignment を停止（closed 後に再開）。`--run-after-all` を暗黙に含む | `--exclusive` |

### exclusive の 3 フェーズ

1. **drain** — 他の全 open タスクが closed になるまで `ready` で待機
2. **exclusive run** — assigned 後、他の全タスクの assignment を停止（単独実行）
3. **resume** — closed 後の次 tick から通常 assignment 再開

### 競合ルール

- `--exclusive` 同士は共存可能（ID 昇順に順次排他実行）
- `--exclusive` ↔ 非排他 `--run-after-all` は共存不可（どちら側から起票しても `RUN_AFTER_ALL_CONFLICT`）
- 非排他 `--run-after-all` 同士は 1 つまで（従来通り）
- `--run-after-all` と `--exclusive` を同時指定すると警告のみで処理継続

## 6. 他プロジェクトを覗く

cmux-team は AI 観察箱として、**他プロジェクトの runtime 状態を読む**ことを中核ユースケースの 1 つとしている。`--project-root` flag で対象を指定できる。

| 用途 | 例 |
|------|----|
| read 系（status / agents / events / metrics 等） | `cmux-team status --project-root /path/to/other` |
| write 系（create-task / start / spawn-* 等） | cwd と異なる project への書き込みは確認 prompt が出る。TTY なし環境では `--project-root-confirm` または `CMUX_TEAM_PROJECT_ROOT_CONFIRM=1` env で skip |

env 経路 `PROJECT_ROOT=...` も引き続きサポート（flag が指定されたら env は無視される）。flag で指定した path が存在しない / `.team/` を含まない場合は exit 1（strict 検証）。
