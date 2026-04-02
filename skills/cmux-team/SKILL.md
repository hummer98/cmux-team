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
| Conductor ← Agent | pull（`cmux list-status` で Idle/Running 検出） |
| Manager → Master | `.team/logs/manager.log` + `cmux list-status`（直接参照） |

## 1. コマンド一覧

### スラッシュコマンド（Claude 内）

| コマンド | 説明 |
|---------|------|
| `/master` | Master ロール再読み込み（`/clear` 後の復帰用） |
| `/team-spec` | 要件ブレスト（Master が直接ユーザーと対話） |
| `/team-task` | タスク管理（タスクの作成・一覧・クローズ） |
| `/team-archive` | 完了タスクのアーカイブ（closed → archived） |

### CLI サブコマンド

チーム体制の構築・管理はすべて CLI 経由で行う:

| コマンド | 説明 |
|---------|------|
| `cmux-team start` | daemon 起動 + Master spawn + レイアウト構築 |
| `cmux-team status` | ステータス表示（team.json + ログ末尾） |
| `cmux-team stop` | graceful shutdown（SHUTDOWN メッセージ送信） |
| `cmux-team send TASK_CREATED` | タスク作成通知（`--task-id`, `--task-file` 必須） |
| `cmux-team send TODO` | TODO 通知（`--content` 必須） |
| `cmux-team send SHUTDOWN` | シャットダウン通知 |
| `cmux-team spawn-agent` | Agent spawn（`--conductor-surface`, `--role`, `--prompt` or `--prompt-file`） |
| `cmux-team agents` | 稼働中エージェント一覧 |
| `cmux-team kill-agent` | Agent 終了（`--surface` 必須、`--conductor-surface` 任意） |
| `cmux-team create-task` | タスク作成（`--title` 必須、`--priority`, `--status`, `--body` 任意） |
| `cmux-team update-task` | タスク状態更新（`--task-id`, `--status` 必須） |
| `cmux-team close-task` | タスククローズ（`--task-id` 必須、`--journal` 任意） |
| `cmux-team trace` | API トレース検索（`--task`, `--search`, `--show`） |

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
