# 要件定義: cmux-team

## 概要

Claude Code + cmux によるマルチエージェント開発オーケストレーション。
TypeScript daemon がタスクキューを監視し、cmux のペイン分割で複数の Claude Code セッション（Conductor/Agent）を起動・監視・統合する。
ユーザーは Master セッションに自然言語で指示するだけで、並列開発ワークフローが自律的に実行される。

## 目的

Claude Code の組み込みサブエージェント（Agent ツール）はブラックボックスであり、途中経過が見えない。
cmux-team は cmux のターミナル分割を活用し、サブエージェントの作業を**リアルタイムに可視化**しつつ**並列実行**する仕組みを提供する。

## ターゲットユーザー

cmux 内で Claude Code を使う開発者。Claude Max 推奨（複数セッション同時実行による API 消費が大きいため）。

## アーキテクチャ

### 構成要素

| 構成要素 | 実体 | 責務 |
|----------|------|------|
| **Master** | Claude Code セッション（Opus） | ユーザー対話、タスク作成、進捗報告 |
| **daemon** | TypeScript プロセス（bun） | タスク監視、Conductor スロット管理、結果回収、TUI ダッシュボード |
| **Conductor** | Claude Code セッション（Opus）× 3（固定スロット） | 1タスクを自律実行。Agent 起動・監視・結果統合。常駐し `/clear` で再利用 |
| **Agent** | Claude Code セッション（Opus） | 実作業（実装・テスト・リサーチ等）。完了したら停止 |

### 起動フロー

```
ユーザー: /cmux-team:start
  → daemon (main.ts start) 起動
    → インフラ初期化 (.team/ ディレクトリ構造)
    → ロギングプロキシ起動
    → 固定2x2レイアウト構築（Conductor 3スロット）
    → 各 Conductor で Claude Code 起動（--append-system-prompt-file conductor-role.md）
    → Master ペイン spawn (cmux new-split right → Claude Code)
    → TUI ダッシュボード表示
    → メインループ開始（キュー処理 + タスクスキャン + Conductor 監視）
```

### 通信モデル

| 方向 | 手段 |
|------|------|
| Master → daemon | CLI (`main.ts create-task` / `main.ts send`) → `.team/queue/*.json` |
| daemon → Conductor | `cmux send`（`/clear` + タスクプロンプト送信）— Conductor は常駐、再 spawn しない |
| Conductor → daemon | done マーカーファイル（`<outputDir>/done`）+ CONDUCTOR_DONE キューメッセージ（Stop hook 経由） |
| Conductor → Agent | `main.ts spawn-agent` CLI（タブ作成 + プロキシ設定 + Trust 承認） |
| Agent → daemon | AGENT_SPAWNED キューメッセージ（spawn-agent CLI が送信） |
| daemon → Master | なし（Master が `manager.log` / `main.ts status` を直接参照） |

## 機能要件

### Must-have

- [x] REQ-001: daemon 起動 — `main.ts start` で daemon + 固定レイアウト + Conductor 3スロット + Master を起動し TUI ダッシュボードを表示
- [x] REQ-002: タスク作成 — `main.ts create-task --title <title>` で `.team/tasks/<id>-<slug>.md` にタスクファイルを作成し、`task-state.json` に状態を記録。`--status ready` の場合は TASK_CREATED をキューに送信
- [x] REQ-003: タスクステータスフロー — `draft` → `ready` → `closed`（`task-state.json` で管理）。daemon は `ready` のタスクのみ処理
- [x] REQ-004: タスク依存解決 — YAML frontmatter の `depends_on` フィールドで依存順序を自動解決。依存先がすべて `closed` になるまで実行しない
- [x] REQ-005: 優先度ソート — `high` > `medium` > `low` で実行順を決定
- [x] REQ-006: Conductor タスク割り当て — daemon がタスク検出時に idle Conductor を選択し、git worktree 作成 + `/clear` + タスクプロンプト送信で割り当て
- [x] REQ-007: Conductor 監視（pull 型） — done マーカーファイル（`<outputDir>/done`）の存在で完了判定。フォールバックとして surface 消失でクラッシュ判定
- [x] REQ-008: Conductor 監視（push 型） — CONDUCTOR_DONE キューメッセージ（Stop hook 経由）で即時完了検出
- [x] REQ-009: 結果回収 — Conductor 完了検出時に `task-state.json` から journal サマリーを読み取り、ログに記録。Conductor リセット（Agent タブ閉じ + worktree 削除 + タブ名リセット + 状態を idle に戻す）
- [x] REQ-010: Conductor 同時実行制限 — `CMUX_TEAM_MAX_CONDUCTORS`（デフォルト 3）で固定スロット数を制御
- [x] REQ-011: Agent spawn — `main.ts spawn-agent` CLI でタブ作成（paneId があれば `cmux new-surface --pane`）・プロキシ設定・Trust 承認・タブ名設定・AGENT_SPAWNED キュー送信を一括実行
- [x] REQ-012: Agent 監視 — Conductor が `cmux read-screen` で `❯` + `esc to interrupt` の有無で完了検出（pull 型）
- [x] REQ-013: ファイルキュー — `.team/queue/*.json` に zod スキーマ検証済みメッセージを書き込み、daemon が定期ポーリングで処理。処理済みは `processed/` に移動
- [x] REQ-014: TUI ダッシュボード — ink/React ベースのフルスクリーン表示（Header, Master, Conductors（Agent ツリー付き）, Tasks, Journal/Log タブ切り替え）。2秒間隔で自動更新
- [x] REQ-015: ダッシュボードキーバインド — `1`=journal, `2`=log, `Tab`=切替, `r`=reload, `q`=quit
- [x] REQ-016: git worktree 隔離 — タスク割り当て時に daemon が `.worktrees/<taskRunId>/` を作成。Conductor が完了時に削除
- [x] REQ-017: worktree ブートストラップ — `package.json` があれば `npm install` を自動実行（daemon の `assignTask()` 内）
- [x] REQ-018: Trust 自動承認 — `cmux read-screen` で「Yes, I trust」検出時に `cmux send-key return`（`cmux.waitForTrust()`）
- [x] REQ-019: タブ名自動設定 — Conductor: `[num] ♦ #taskId title`（idle 時 `[num] ♦ idle`）、Agent: `[num] roleIcon title`
- [x] REQ-020: graceful shutdown — `main.ts stop` / SHUTDOWN キューメッセージ / `q` キーで停止
- [x] REQ-021: ステータス CLI — `main.ts status` で Master/Conductors/Tasks/Log を一括表示
- [x] REQ-022: Agent 一覧 CLI — `main.ts agents` で稼働中エージェントを Conductor 別に表示
- [x] REQ-023: Agent kill CLI — `main.ts kill-agent` で surface クローズ + AGENT_DONE キュー送信
- [x] REQ-024: Master テンプレート — `templates/master.md` をコピーして `.team/prompts/master.md` を生成
- [x] REQ-025: Conductor テンプレート — `conductor-role.md`（`--append-system-prompt-file` で永続ロール知識）+ `conductor-task.md`（タスク割り当て時にプレースホルダー展開して `.team/prompts/<taskRunId>.md` を生成）の2ファイル構成
- [x] REQ-026: テンプレート検索 — daemon 自身の相対パス → plugin キャッシュ → プロジェクトローカル → 手動インストール先の順で検索（`findTemplateDir()`）
- [x] REQ-027: ロギング — `.team/logs/manager.log` に `[ISO8601] event detail` 形式で追記
- [x] REQ-028: ロギングプロキシ — Anthropic API への透過プロキシ。リクエスト/レスポンスを `.team/logs/traces/api-trace.jsonl` に JSONL 記録。streaming 対応。デバッグエンドポイント（`/state`, `/tasks`, `/conductors`）付き
- [x] REQ-029: プロキシポート伝搬 — `.team/proxy-port` にポート番号を書き出し、`spawn-agent` CLI が Agent 起動時に `ANTHROPIC_BASE_URL` を設定
- [x] REQ-030: hot reload — ダッシュボード `r` キーで plugin キャッシュの最新 `main.ts` を検索し、`exec` でプロセスを置換
- [x] REQ-031: Conductor レビュー判断 — コードファイル（.ts, .py, .go 等）の変更がある場合のみ Reviewer Agent を起動（`conductor-role.md` テンプレートで定義）
- [x] REQ-032: Conductor 納品 — ローカルマージ（デフォルト）または Pull Request の選択（`conductor-role.md` テンプレートで定義）
- [x] REQ-033: Journal セクション — Conductor 完了時に `close-task --journal` でサマリーを `task-state.json` に記録。daemon が `collectResults()` で journal_summary を抽出してログに記録。TUI の Journal タブに表示
- [x] REQ-034: タスク状態更新 CLI — `main.ts update-task --task-id <id> --status <status>` でタスクの状態を変更。`ready` への変更時は TASK_CREATED を送信
- [x] REQ-035: Conductor リセット — タスク完了後に daemon が Agent タブ閉じ + worktree 削除 + タブ名リセット + ConductorState を idle に戻す（`resetConductor()`）
- [x] REQ-036: Conductor 状態復元 — daemon リロード時に `team.json` から Conductor 状態を復元し、二重起動を防止
- [x] REQ-037: done マーカー二重確認 — `doneCandidate` フラグで2回連続 done 判定されたときのみ完了処理（起動直後の誤判定防止）

### Nice-to-have

- [ ] REQ-N01: E2E テストランナー — `e2e.ts` による自動化テスト（sequential, parallel, interrupt シナリオ）

### Out of scope

- GUI / Web UI（TUI のみ）
- Claude Code 以外の AI モデルバックエンド
- リモートマシンでの分散実行
- リアルタイムコスト計測（API トレースからの事後分析は可能）

## 非機能要件

- NFR-001: ポーリング間隔 — `CMUX_TEAM_POLL_INTERVAL`（デフォルト 10秒）で設定可能
- NFR-002: 同時 Conductor 数 — `CMUX_TEAM_MAX_CONDUCTORS`（デフォルト 3）で設定可能
- NFR-003: done マーカー二重確認 — `doneCandidate` フラグで2 tick 連続 done 判定時のみ完了処理（起動中の誤判定防止）
- NFR-004: API トレース — streaming レスポンスはブロックせず非同期でバイト数を記録
- NFR-005: 言語 — ドキュメント・コメント: 日本語、コード: 英語
- NFR-006: ライセンス — MIT

## 技術スタック

| 技術 | 用途 |
|------|------|
| **bun** | daemon ランタイム（TypeScript 実行） |
| **cmux** | ターミナルマルチプレクサ（ペイン分割・画面読取・キー送信） |
| **Claude Code** | Master/Conductor/Agent セッション |
| **ink** (v6) + **React** (v19) | TUI ダッシュボード |
| **zod** (v4) | キューメッセージのスキーマ検証 |
| **git worktree** | Conductor 作業ディレクトリの隔離 |

## 配布方法

| 方法 | コマンド | 備考 |
|------|---------|------|
| Claude Code Plugin（推奨） | `/plugin install cmux-team@hummer98-cmux-team` | スキル + コマンド一式 |
| npx skills（フォールバック） | `npx skills add hummer98/cmux-team` | スキルのみ |
| 手動インストール（レガシー） | `./install.sh` | `~/.claude/` にコピー |

## キューメッセージスキーマ

zod で定義された5種類のメッセージ:

| メッセージ | 方向 | 用途 |
|-----------|------|------|
| `TASK_CREATED` | Master → daemon | タスク作成通知（`taskId`, `taskFile`） |
| `CONDUCTOR_DONE` | Conductor → daemon | Conductor 完了通知（`conductorId`, `surface`, `success`, `reason?`, `exitCode?`, `sessionId?`, `transcriptPath?`） |
| `AGENT_SPAWNED` | spawn-agent CLI → daemon | Agent 起動通知（`conductorId`, `surface`, `role?`） |
| `AGENT_DONE` | kill-agent CLI → daemon | Agent 完了/kill 通知（`conductorId`, `surface`） |
| `SHUTDOWN` | CLI → daemon | graceful shutdown 要求 |

## ファイルシステム構造

```
.team/
├── team.json              # チーム状態（daemon が自動更新）
├── task-state.json        # タスク状態（status, closedAt, journal）
├── queue/                 # メッセージキュー
│   ├── *.json             # 未処理メッセージ
│   └── processed/         # 処理済みメッセージ
├── tasks/                 # タスクファイル（フラット構造）
│   └── <id>-<slug>.md    # YAML frontmatter + Markdown
├── output/
│   └── <taskRunId>/       # Conductor が書く、daemon が読む
│       ├── summary.md
│       └── done           # 完了マーカー
├── prompts/               # テンプレートから生成されたプロンプト
│   ├── master.md
│   ├── conductor-role.md  # 全 Conductor 共有のロールプロンプト
│   └── <taskRunId>.md     # タスク別プロンプト
├── specs/                 # 仕様書
├── logs/
│   ├── manager.log        # daemon ログ
│   └── traces/
│       └── api-trace.jsonl # API トレース
├── scripts/               # ランタイムスクリプト
├── proxy-port             # ロギングプロキシのポート番号
└── .gitignore             # output/, prompts/, logs/, queue/, task-state.json を除外
```

## タスクファイル形式

```yaml
---
id: <連番>
title: <タスク名>
priority: high|medium|low
created_at: <ISO 8601>
depends_on: [<id>, ...]    # オプション
---

## タスク
<タスク内容>

## 対象ファイル
<修正が必要なファイル一覧>

## 完了条件
<何をもって完了とするか>
```

**注意**: `status` フィールドはタスクファイル内ではなく `task-state.json` で管理する。タスクファイルの frontmatter に `status` があっても、`task-state.json` の値で上書きされる。

## daemon CLI インターフェース

```
main.ts start                                          daemon 起動 + レイアウト構築 + Master spawn + ダッシュボード
main.ts send TASK_CREATED --task-id <id> --task-file <path>
main.ts send CONDUCTOR_DONE --conductor-id <id> --surface <s> [--success true|false] [--reason <msg>] [--exit-code <n>] [--session-id <id>] [--transcript-path <path>]
main.ts send AGENT_SPAWNED --conductor-id <id> --surface <s> [--role <role>]
main.ts send AGENT_DONE --conductor-id <id> --surface <s>
main.ts send SHUTDOWN
main.ts status [--log <N>]                             ステータス表示
main.ts stop                                           graceful shutdown
main.ts spawn-agent --conductor-id <id> --role <role> (--prompt <prompt> | --prompt-file <path>) [--task-title <title>]
main.ts agents                                         稼働中エージェント一覧
main.ts kill-agent --surface <s> [--conductor-id <id>]
main.ts create-task --title <title> [--priority <p>] [--status <s>] [--body <text>]
main.ts update-task --task-id <id> --status <status>
main.ts close-task --task-id <id> [--journal <text>]
```

## スラッシュコマンド一覧

| コマンド | 説明 |
|---------|------|
| `/cmux-team:start` | daemon 起動 + Master spawn |
| `/cmux-team:master` | Master ロール再読み込み（`/clear` 後） |
| `/team-spec [概要]` | 要件ブレスト（対話型） |
| `/team-research <トピック>` | 並列リサーチ |
| `/team-design` | 設計 + レビュー |
| `/team-impl [タスク\|all]` | 並列実装 |
| `/team-review` | 実装レビュー |
| `/team-test [scope\|all]` | テスト作成・実行 |
| `/team-sync-docs` | ドキュメント同期 |
| `/team-task [操作]` | タスク管理 |
| `/team-archive [範囲]` | 完了タスクのアーカイブ |
| `/team-status` | チーム状態表示 |
| `/team-disband [force]` | 全エージェント終了 |

## 環境変数

| 変数 | デフォルト | 説明 |
|------|-----------|------|
| `PROJECT_ROOT` | 自動検出 | プロジェクトルート |
| `CMUX_TEAM_POLL_INTERVAL` | `10000` | daemon ポーリング間隔（ms） |
| `CMUX_TEAM_MAX_CONDUCTORS` | `3` | 同時 Conductor 数上限（固定スロット数） |
| `CMUX_SOCKET_PATH` | （cmux 環境で自動設定） | cmux ソケットパス |
| `ANTHROPIC_API_URL` | `https://api.anthropic.com` | プロキシのアップストリーム |
| `ANTHROPIC_BASE_URL` | （プロキシが設定） | Agent に渡すプロキシ URL |
| `CONDUCTOR_ID` | （spawn-agent が設定） | Agent に渡す Conductor 識別子 |
| `ROLE` | （spawn-agent が設定） | Agent に渡すロール名 |

## 前提条件

- cmux がインストール済みであること
- bun がインストール済みであること（daemon ランタイム）
- Claude Code が利用可能であること
- cmux 内で実行すること（`CMUX_SOCKET_PATH` が必要）

## 未決事項

- daemon のクラッシュリカバリ: 現状は手動再起動が必要。プロセス監視や自動再起動の仕組みはない
- Conductor の最大リトライ回数: クラッシュ時は idle に戻すが、再試行ポリシーが未定義
- API トレースからのコスト集計: JSONL データは蓄積されるが、集計 UI や分析ツールはない
- E2E テストの CI 統合: cmux 環境が必要なため、CI での自動実行方法が未定
