# Seed: cmux-team Skill（4層アーキテクチャ定義）

## File: `skills/cmux-team/SKILL.md`

## Purpose

4層アーキテクチャ（Master → Manager → Conductor → Agent）全体の定義スキル。
**Master（ユーザーセッション）** が読み込み、タスク作成・Manager 監視・進捗報告を行う。

## Frontmatter

```yaml
---
name: cmux-team
description: >
  Use when orchestrating multi-agent development via cmux.
  Triggers: .team/ directory exists, user says "team", "spawn agents",
  "parallel", "sub-agent", or any /team-* command is invoked.
  Provides: agent spawning, monitoring, result collection, synchronization protocols.
---
```

## Content Sections（実装済み）

### 0. アーキテクチャ概要

**4層構造の図解:**

```
[ユーザー] ↔ [Master] → [Manager (daemon)] → [Conductor (常駐)] → [Agent (実作業)]
```

- Master: ユーザー対話。タスク作成。真のソース直接参照で進捗報告。作業しない。ポーリングしない。
- Manager: daemon として常駐。[TASK_CREATED] 通知で起床→タスク検出→idle Conductor にタスク割り当て→done マーカーで完了検出→ログ記録→Conductor リセット→アイドル化。アイドル時停止、イベント駆動。
- Conductor: 常駐。タスクを割り当てられると自律実行。git worktree 隔離。Agent spawn（タブ）→結果統合→タスクを close（`cmux-team close-task`）→done マーカー作成→idle に戻る。常駐。タスク完了後も停止しない。
- Agent: 実作業（実装・テスト・リサーチ等）。完了したら停止。上位が見に来る。

**通信方式テーブル:**

| 方向 | 手段 |
|------|------|
| Master → Manager | `.team/tasks/` + `task-state.json` + HTTP メッセージ（`cmux-team send` → proxy 受信、イベント駆動） |
| Manager → Conductor | `cmux send`（`/clear` + 新プロンプト送信） |
| Manager ← Conductor | done マーカーファイル（`.team/conductors/<conductor>/done`）の存在確認（pull 型）+ Conductor の Stop/SessionEnd hook が送る SESSION_* メッセージ |
| Conductor → Agent | `cmux-team send-agent`（Conductor の `cmux send` 直接呼び出しは PreToolUse hook でブロック） |
| Conductor ← Agent | `cmux-team await-agent`（Agent の Stop/SessionEnd hook が書き出す done マーカーを fs.watch で監視） |
| Manager → Master | `.team/logs/manager.log` + `cmux-team status` |

### 1. コマンド一覧

**スラッシュコマンド（Claude 内）:**

| コマンド | 説明 |
|---------|------|
| `/master` | Master ロール再読み込み（`/clear` 後の復帰用） |
| `/team-spec` | 要件ブレスト（Master が直接ユーザーと対話） |
| `/team-task` | タスク管理（タスクの作成・一覧・クローズ） |
| `/team-archive` | 完了タスクのアーカイブ（closed → archived） |
| `/artifact` | 知見のアーティファクト化（作成・一覧・表示） |
| `/docs-sync` | `docs/spec/` を実装の現状に同期（dockeeper スキル経由） |

**CLI サブコマンド:**

| コマンド | 説明 |
|---------|------|
| `cmux-team start` | daemon 起動 + Master spawn + レイアウト構築 |
| `cmux-team status` | ステータス表示（team.json + ログ末尾） |
| `cmux-team stop` | graceful shutdown（SHUTDOWN メッセージ送信） |
| `cmux-team send TASK_CREATED` | タスク作成通知（`--task-id`, `--task-file` 必須） |
| `cmux-team send <TYPE>` | 内部メッセージ通知（`TASK_CREATED / TASK_UPDATED / CONDUCTOR_DONE / CONDUCTOR_REGISTERED / AGENT_SPAWNED / SESSION_STARTED / SESSION_ENDED / SESSION_ACTIVE / SESSION_IDLE / SESSION_ASK / SESSION_STOP / SESSION_CLEAR / SHUTDOWN`。ほとんどは Claude セッションの SessionStart/Stop/SessionEnd hook が送信する） |
| `cmux-team send-agent` | Agent/Conductor surface へメッセージ送信（`--surface` 必須、`<message>` positional、`--no-return` 任意）。Conductor → 他 surface 操作はこの CLI 経由に限定され、`cmux send` の直接呼び出しは hook でブロックされる |
| `cmux-team spawn-conductor` | 単一 Conductor を起動・登録 |
| `cmux-team spawn-agent` | Agent spawn（`--conductor-surface`, `--role`, `--prompt` or `--prompt-file`）。`/rate-limit` API でスロットル中はブロックされ exit code 75 を返す |
| `cmux-team agents` | 稼働中エージェント一覧 |
| `cmux-team kill-agent` | Agent 終了（`--surface` 必須、`--conductor-surface` 任意） |
| `cmux-team create-task` | タスク作成（`--title` 必須、`--priority`, `--status`, `--body`, `--depends-on`, `--base-branch`, `--run-after-all` 任意） |
| `cmux-team update-task` | タスク状態更新（`--task-id` 必須、`--status` / `--title` / `--body` / `--depends-on` のいずれか必須） |
| `cmux-team close-task` | タスククローズ（`--task-id` 必須、`--journal`, `--force` 任意。close 後 `CONDUCTOR_DONE` を送信） |
| `cmux-team abort-task` | 実行中タスクの中止（`--task-id` 必須、`--journal` 任意）。Conductor 停止 → worktree 削除 → `aborted` に遷移 → Conductor を再起動 |
| `cmux-team restart-task` | assigned タスクの Conductor セッションを再起動（`--task-id` 必須、`--journal` 任意）。タスク自体は assigned のまま維持 |
| `cmux-team delete-task` | draft/ready タスクの削除（`--task-id` 必須、`--journal` 任意）。`assigned` のタスクは `abort-task` を使う |
| `cmux-team await-task` | タスク完了を fs.watch で待機（`--task-id` 必須、カンマ区切りで複数指定可、`--timeout` 任意。非ブロッキング用途） |
| `cmux-team await-agent` | Agent 完了/ask/crash を done マーカーの fs.watch で待機（`--surface` 必須、`--timeout` 任意）。Conductor テンプレートから使用され、STATUS= 行を stdout に出力し状態に応じた exit code で終了する（T181） |
| `cmux-team trace-task` | 特定タスクのセッション履歴を表示（タスク ID positional 引数必須） |
| `cmux-team conductor` | Conductor 情報表示 |
| `cmux-team spawn-master` | Master surface 起動 |
| `cmux-team artifacts` | アーティファクト一覧・検索 |
| `cmux-team artifacts add` | ファイルをアーティファクトとして登録（`<file>` 必須、`--type`, `--title`, `--task`, `--tags` 任意） |
| `cmux-team artifacts open` | Markdown ビューアでアーティファクトを開く（`<id>` 必須。ビューア: `CMUX_TEAM_MD_VIEWER` → `mo` → `cat` の順で決定） |
| `cmux-team resume` | assigned タスクの Conductor セッション再開（`<task-id>` positional 引数必須）。起動時 resume 経路では Manager が shell 側で直接 `claude --resume` を実行する（Conductor ペインに `cmux-team resume` 文字列を送らないこと） |
| `cmux-team self-update` | update タスクを手動起票（`--run-after-all` で全 open タスク完了後に install）。既存 run_after_all / 同 latest タスクがあれば exit 0 でそれを返す（T187） |

### 2. トレーサビリティ

daemon 起動時に API Proxy が自動起動し、全 API リクエストを SQLite FTS5 データベースに記録する。Master が過去の作業ログを検索・分析する際に活用できる。

**自動プロキシ設定:**
daemon が起動すると Proxy が自動で立ち上がり、Master および Conductor に `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` を設定する。全 API リクエストが Proxy 経由になり、リクエスト/レスポンスが自動記録される。

**メタデータ伝播:**

| ヘッダー | 内容 |
|---------|------|
| `x-cmux-task-id` | タスクID |
| `x-cmux-conductor-surface` | Conductor surface |
| `x-cmux-role` | エージェントロール |
| `x-claude-code-session-id` | Claude Code セッションID |

**trace CLI:**
```bash
cmux-team trace-task 035            # 特定タスクのセッション履歴（Conductor + Agent）
```

> 旧 `cmux-team trace --task / --search / --show` は `trace-task` に集約された（commit `0641ac9`）。全文検索 CLI は現在なく、`.team/traces/traces.db` を直接参照する必要がある。

### 2a. Dashboard のレート制限表示（T227）

dashboard ヘッダー右端に `5h: X% ████░░░░░░` / `7d: Y% ██░░░░░░░░` を表示する。値は Anthropic API レスポンスヘッダー（`anthropic-ratelimit-unified-5h-utilization` 等）から取得し、`.team/rate-limit.json` にスナップショットとして永続化される。

- **復元**: `cmux-team start` 時に `.team/rate-limit.json` を読み込み、next API 応答が来るまでは前回値を表示する。ファイル不在・破損・型不一致は null フォールバックで `Rate: --` 表示。
- **stale 表示**: `unified5hReset` / `unified7dReset` のいずれかが未来にある間は通常表示。両方過去 or 両方 null or 片方過去+片方 null の場合は **全パーツを GRAY にし末尾に `(stale)` を付加する**。新しい API 応答が来ると stale ラベルは消え、最新値で上書きされる。
- **throttle 判定**: `unified5hUtilization >= 90%` または `unifiedStatus === "rate_limited"` でスロットル中とみなしヘッダーを `⏸ THROTTLED`（赤 / blink）にする。ただし **stale な復元値ではスロットル判定を一切行わない**（dashboard 表示のみならず、daemon の tick によるタスク割当抑止・サイドバーステータス・proxy の `/rate-limit` エンドポイント全てに適用）。stale 中はタスクを通常通り割り当て、次の API 応答で throttle 状態を再確認する。

### 3. cmux 操作リファレンス

**環境変数:**

| 変数 | 意味 |
|------|------|
| `CMUX_SOCKET_PATH` | cmux ソケットパス。設定されていれば cmux 環境内で動作中 |
| `CMUX_WORKSPACE_ID` | 現在のワークスペースID |
| `CMUX_SURFACE_ID` | 現在のサーフェスID |
| `CMUX_SURFACE` | cmux-team が設定。`surface:N` 形式。これが設定されていれば cmux-team 管理下 |
| `CMUX_CLAUDE_HOOKS_DISABLED` | `1` に設定すると cmux ラッパーの hook を無効化。Conductor・Agent・Master 起動時に自動設定 |
| `CMUX_TEAM_MD_VIEWER` | `artifacts open` で使用する Markdown ビューアのコマンド名。未設定時は `mo` → `cat` にフォールバック |

**workspace 分離（重要）:**

`cmux tree` はデフォルトで全ワークスペースの surface を返すため、複数ワークスペースで cmux-team を同時起動している場合は別ワークスペースの surface ID と混同する原因になる。daemon は起動時に呼び出し元の workspace を `state.workspace` に記録し、pane 逆引き・surface 作成には常に `--workspace` を付けて問い合わせる（T195 以降 surface 検証は PID ベースに移行したため、`cmux tree` は init 時の pane 逆引きにのみ使用）。

**基本操作コマンド:**

| コマンド | 用途 |
|---------|------|
| `cmux identify` | 自分の workspace/surface を確認 |
| `cmux tree --workspace <id>` | ペイン・サーフェス階層を表示（T195 以降は init 時の pane 逆引きのみに使用。生存確認は PID + hook push に一本化） |
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

**send の改行ルール（重要）:**

- **単一行**: 末尾に `\n` を付ける
- **複数行**: 個別の `send` + `send-key return` で送信する
- **注意**: `\n` は最後の1つだけが Enter として機能する。途中の `\n` は改行にならない

**制御キーの送信:**
`send-key` を使う（`send` ではない）:
```bash
cmux send-key --surface surface:N ctrl+c    # 中断
cmux send-key --surface surface:N return    # Enter
```

**read-screen トラブルシューティング:**

| 問題 | 対処 |
|------|------|
| 空・古い出力 | `cmux refresh-surfaces` してからリトライ |
| 出力が切れる | `--scrollback` オプションを追加 |
| 特定行数だけ必要 | `--lines N` オプションを追加 |
| surface が見つからない | `cmux list-pane-surfaces` で確認 |

**通知:**
```bash
# アプリ内通知（ペイン強調 + サイドバーバッジ）
cmux notify --title "完了" --body "ビルドが成功しました"

# macOS 通知センター（サウンド付き）
osascript -e 'display notification "ビルド完了" with title "Claude" sound name "Glass"'
```
