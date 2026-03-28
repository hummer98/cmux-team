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
| **daemon** | TypeScript プロセス（bun） | タスク監視、Conductor spawn、結果回収、TUI ダッシュボード |
| **Conductor** | Claude Code セッション（Opus） | 1タスクを自律実行。Agent 起動・監視・結果統合 |
| **Agent** | Claude Code セッション（Opus） | 実作業（実装・テスト・リサーチ等） |

### 起動フロー

```
ユーザー: /cmux-team:start
  → daemon (main.ts start) 起動
    → インフラ初期化 (.team/ ディレクトリ構造)
    → ロギングプロキシ起動
    → Master ペイン spawn (cmux new-split right → Claude Code)
    → TUI ダッシュボード表示
    → メインループ開始（タスクスキャン + Conductor 監視）
```

### 通信モデル

| 方向 | 手段 |
|------|------|
| Master → daemon | CLI (`main.ts send`) → `.team/queue/*.json` |
| daemon → Conductor | `cmux new-split` + Claude Code 起動 |
| Conductor → daemon | Stop hook → `.team/queue/*.json`（CONDUCTOR_DONE）+ `cmux read-screen` ポーリング |
| Conductor → Agent | `main.ts spawn-agent` CLI |
| Agent → daemon | PostToolUse hook（AGENT_SPAWNED）/ AGENT_DONE キューメッセージ |
| daemon → Master | なし（Master が `manager.log` / `main.ts status` を直接参照） |

## 機能要件

### Must-have

- [ ] REQ-001: daemon 起動 — `main.ts start` で daemon + Master を起動し TUI ダッシュボードを表示
- [ ] REQ-002: タスク作成 — Master が `.team/tasks/open/<id>-<slug>.md` にタスクファイルを作成し CLI でキューに通知
- [ ] REQ-003: タスクステータスフロー — `draft` → `ready` の2段階。daemon は `ready` のみ処理
- [ ] REQ-004: タスク依存解決 — YAML frontmatter の `depends_on` フィールドで依存順序を自動解決
- [ ] REQ-005: 優先度ソート — `high` > `medium` > `low` で実行順を決定
- [ ] REQ-006: Conductor spawn — daemon がタスク検出時に git worktree 作成 + cmux ペイン分割 + Claude Code 起動
- [ ] REQ-007: Conductor 監視（pull 型） — `cmux read-screen` で `❯` + `esc to interrupt` の有無で状態判定
- [ ] REQ-008: Conductor 監視（push 型） — Claude Code Stop hook → CONDUCTOR_DONE キューメッセージ
- [ ] REQ-009: 結果回収 — Conductor 完了検出時に worktree 削除 + タスクファイル closed 移動 + journal サマリー抽出
- [ ] REQ-010: Conductor 同時実行制限 — `CMUX_TEAM_MAX_CONDUCTORS`（デフォルト 3）で上限制御
- [ ] REQ-011: Agent spawn — `main.ts spawn-agent` CLI でペイン作成・Trust 承認・タブ名設定・daemon 通知を一括実行
- [ ] REQ-012: Agent 監視 — Conductor が `cmux read-screen` で完了検出（pull 型）
- [ ] REQ-013: TODO メッセージ — 軽微な作業を CLI で即時タスク化（`main.ts send TODO --content "..."`)
- [ ] REQ-014: ファイルキュー — `.team/queue/*.json` に zod スキーマ検証済みメッセージを書き込み、daemon が定期ポーリングで処理
- [ ] REQ-015: TUI ダッシュボード — ink/React ベースのフルスクリーン表示（Header, Master, Conductors, Tasks, Journal/Log タブ）
- [ ] REQ-016: ダッシュボードキーバインド — `1`=journal, `2`=log, `Tab`=切替, `r`=reload, `q`=quit
- [ ] REQ-017: git worktree 隔離 — Conductor は `.worktrees/<conductor-id>/` で作業。main ブランチは無傷
- [ ] REQ-018: worktree ブートストラップ — `package.json` があれば `npm install` を自動実行
- [ ] REQ-019: Trust 自動承認 — `cmux read-screen` で「Yes, I trust」検出時に `cmux send-key return`
- [ ] REQ-020: タブ名自動設定 — `[surface番号] タスクタイトル` 形式でタブをリネーム
- [ ] REQ-021: graceful shutdown — `main.ts stop` / SHUTDOWN キューメッセージ / `q` キーで停止
- [ ] REQ-022: ステータス CLI — `main.ts status` で Master/Conductors/Tasks/Log を一括表示
- [ ] REQ-023: Agent 一覧 CLI — `main.ts agents` で稼働中エージェントを表示
- [ ] REQ-024: Agent kill CLI — `main.ts kill-agent` で surface クローズ + AGENT_DONE 通知
- [ ] REQ-025: Master テンプレート — `templates/master.md` をコピーして `.team/prompts/master.md` を生成
- [ ] REQ-026: Conductor テンプレート — `templates/conductor.md` のプレースホルダーを変数展開して `.team/prompts/<conductor-id>.md` を生成
- [ ] REQ-027: テンプレート検索 — daemon 自身の相対パス → plugin キャッシュ → プロジェクトローカル → 手動インストール先の順で検索
- [ ] REQ-028: ロギング — `.team/logs/manager.log` に `[ISO8601] event detail` 形式で追記
- [ ] REQ-029: ロギングプロキシ — Anthropic API への透過プロキシ。リクエスト/レスポンスを `.team/logs/traces/api-trace.jsonl` に JSONL 記録。streaming 対応
- [ ] REQ-030: プロキシポート伝搬 — `.team/proxy-port` にポート番号を書き出し、Agent 起動時に `ANTHROPIC_BASE_URL` を設定
- [ ] REQ-031: Conductor 完了通知 Hook — Conductor 用 settings.json に Stop hook を生成し、CONDUCTOR_DONE を自動送信
- [ ] REQ-032: Agent spawn 検出 Hook — Conductor 用 settings.json に PostToolUse hook を生成し、`cmux new-split` 実行時に AGENT_SPAWNED を自動送信
- [ ] REQ-033: hot reload — ダッシュボード `r` キーで最新の main.ts にプロセスを exec 置換
- [ ] REQ-034: Conductor レビュー判断 — コードファイルの変更がある場合のみ Reviewer Agent を起動
- [ ] REQ-035: Conductor 納品 — ローカルマージ（デフォルト）または Pull Request の選択
- [ ] REQ-036: Journal セクション — Conductor 完了時にタスクファイルに作業サマリーを追記。daemon がログに記録

### Nice-to-have

- [ ] REQ-N01: ペインレイアウト最適化 — `right` と `down` を組み合わせたグリッドレイアウト（2x2, 2x3）
- [ ] REQ-N02: ワークスペース分離 — 7ペイン以上はワークスペースを分けて対応
- [ ] REQ-N03: E2E テストランナー — `e2e.ts` による自動化テスト（sequential, parallel, interrupt シナリオ）

### Out of scope

- GUI / Web UI（TUI のみ）
- Claude Code 以外の AI モデルバックエンド
- リモートマシンでの分散実行
- リアルタイムコスト計測（API トレースからの事後分析は可能）

## 非機能要件

- NFR-001: ポーリング間隔 — `CMUX_TEAM_POLL_INTERVAL`（デフォルト 10秒）で設定可能
- NFR-002: 同時 Conductor 数 — `CMUX_TEAM_MAX_CONDUCTORS`（デフォルト 3）で設定可能
- NFR-003: Conductor spawn 後ガード期間 — 30秒間は「done」判定しない（起動中の誤判定防止）
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

zod で定義された6種類のメッセージ:

| メッセージ | 方向 | 用途 |
|-----------|------|------|
| `TASK_CREATED` | Master → daemon | タスク作成通知 |
| `TODO` | Master → daemon | 軽微な作業の即時実行依頼 |
| `CONDUCTOR_DONE` | Conductor → daemon | Conductor 完了通知（success/failure + 理由） |
| `AGENT_SPAWNED` | Conductor → daemon | Agent 起動通知（surface + role） |
| `AGENT_DONE` | CLI → daemon | Agent 完了/kill 通知 |
| `SHUTDOWN` | CLI → daemon | graceful shutdown 要求 |

## ファイルシステム構造

```
.team/
├── team.json              # チーム状態（daemon が更新）
├── queue/                 # メッセージキュー
│   ├── *.json             # 未処理メッセージ
│   └── processed/         # 処理済みメッセージ
├── tasks/
│   ├── open/              # Master が作成、daemon が読む
│   │   └── <id>-<slug>.md # YAML frontmatter + Markdown
│   ├── closed/            # daemon が完了時に移動
│   └── archived/          # 手動アーカイブ
├── output/
│   └── conductor-<N>/     # Conductor が書く、daemon が読む
│       ├── summary.md
│       └── done           # 完了マーカー
├── prompts/               # テンプレートから生成されたプロンプト
│   ├── master.md
│   ├── conductor-<N>.md
│   └── conductor-<N>-settings.json  # Conductor 用 hook 設定
├── specs/                 # 仕様書（git tracked）
├── logs/
│   ├── manager.log        # daemon ログ
│   └── traces/
│       └── api-trace.jsonl # API トレース
├── scripts/               # ランタイムスクリプト
├── manager/               # daemon ランタイム（起動時にコピー/参照）
├── proxy-port             # ロギングプロキシのポート番号
├── e2e-results/           # E2E テスト結果
└── .gitignore             # output/, prompts/, logs/, queue/ を除外
```

## タスクファイル形式

```yaml
---
id: <連番>
title: <タスク名>
priority: high|medium|low
status: draft|ready
created_at: <ISO 8601>
depends_on: [<id>, ...]    # オプション
---

## タスク
<タスク内容>

## 対象ファイル
<修正が必要なファイル一覧>

## 完了条件
<何をもって完了とするか>

## Journal                  # Conductor が完了時に追記
- summary: <1行サマリー>
- files_changed: <数>
```

## daemon CLI インターフェース

```
main.ts start                                          daemon 起動 + Master spawn + ダッシュボード
main.ts send TASK_CREATED --task-id <id> --task-file <path>
main.ts send TODO --content <text>
main.ts send CONDUCTOR_DONE --conductor-id <id> --surface <s> [--success true|false] [--reason <msg>]
main.ts send AGENT_SPAWNED --conductor-id <id> --surface <s> [--role <role>]
main.ts send AGENT_DONE --conductor-id <id> --surface <s>
main.ts send SHUTDOWN
main.ts status [--log <N>]                             ステータス表示
main.ts stop                                           graceful shutdown
main.ts spawn-agent --conductor-id <id> --role <role> --prompt <prompt> [--task-title <title>]
main.ts agents                                         稼働中エージェント一覧
main.ts kill-agent --surface <s> [--conductor-id <id>]
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
| `CMUX_TEAM_MAX_CONDUCTORS` | `3` | 同時 Conductor 数上限 |
| `CMUX_SOCKET_PATH` | （cmux 環境で自動設定） | cmux ソケットパス |
| `ANTHROPIC_API_URL` | `https://api.anthropic.com` | プロキシのアップストリーム |
| `ANTHROPIC_BASE_URL` | （プロキシが設定） | Agent に渡すプロキシ URL |
| `CONDUCTOR_ID` | （daemon が設定） | Conductor の識別子 |
| `TASK_ID` | （daemon が設定） | タスクの識別子 |

## 前提条件

- cmux がインストール済みであること
- bun がインストール済みであること（daemon ランタイム）
- Claude Code が利用可能であること
- cmux 内で実行すること（`CMUX_SOCKET_PATH` が必要）

## 未決事項

- daemon のクラッシュリカバリ: 現状は手動再起動が必要。プロセス監視や自動再起動の仕組みはない
- Conductor の最大リトライ回数: クラッシュ時に再 spawn するかどうかの方針が未定義
- API トレースからのコスト集計: JSONL データは蓄積されるが、集計 UI や分析ツールはない
- E2E テストの CI 統合: cmux 環境が必要なため、CI での自動実行方法が未定

---

## `skills/cmux-team/SKILL.md` との相違点

以下は **`skills/cmux-team/SKILL.md`**（Master が読み込む4層アーキテクチャ定義スキル）の記述と実装の間の乖離一覧。修正判断は別途行う。

### 1. Manager の実体（SKILL.md §0, §2 全般）

**SKILL.md の記述**: Manager は別ペインで動作する Claude Code セッション（Sonnet モデル）。`cmux send` でプロンプト送信、イベント駆動で起床。

**実装**: Manager は **TypeScript daemon** (`main.ts`)。Claude セッションではない。bun で実行され、ink ベースの TUI ダッシュボードを表示する。

**影響範囲**: §2 の全サブセクション（2.1〜2.5）が大幅に異なる。

### 2. Manager spawn 手順（SKILL.md §1「Manager spawn 手順」）

**SKILL.md の記述**: `cmux new-split right` → `cmux send` で `claude --dangerously-skip-permissions --model sonnet` を起動。

**実装**: daemon は `bun run main.ts start` で起動。Master を spawn するのは daemon の `startMaster()` 関数。Master テンプレート (`master.md`) にも「Manager は TypeScript プロセスで動作する」と正しく記載されている。

### 3. 通信方式（SKILL.md §5）

**SKILL.md の記述**: `Master → Manager` は `.team/tasks/open/` + `cmux send` 通知。

**実装**: `Master → daemon` は **CLI** (`main.ts send`) → `.team/queue/*.json` ファイルキュー。`cmux send` は使わない。

### 4. Conductor 起動方式（SKILL.md §2.2）

**SKILL.md の記述**: `.team/scripts/spawn-conductor.sh` にシェルスクリプトとして委譲。

**実装**: `conductor.ts` の `spawnConductor()` 関数で TypeScript から直接実行。シェルスクリプトではない。`spawn-conductor.sh` はレガシーとして `.team/scripts/` に残存するが使用されていない。

### 5. Conductor 完了検出（SKILL.md §2.3）

**SKILL.md の記述**: pull 型のみ（`cmux read-screen` で `❯` 検出）。

**実装**: pull 型（`cmux read-screen`）**+ push 型**（Claude Code Stop hook → CONDUCTOR_DONE キューメッセージ）のハイブリッド。push 型が先に検出されることが多い。

### 6. Agent 起動方式（SKILL.md §3.3）

**SKILL.md の記述**: Conductor が `cmux new-split` + `cmux send` で直接起動。

**実装**: Conductor が **`main.ts spawn-agent` CLI** を呼び出す。CLI がペイン作成・Trust 承認・タブ名設定・daemon 通知（AGENT_SPAWNED）を一括実行する。

### 7. Conductor Hook 設定（SKILL.md 未記載）

**SKILL.md**: Hook ベースのイベント検出に関する記述なし。

**実装**: Conductor spawn 時に `<conductor-id>-settings.json` を生成し、`--settings` オプションで渡す。PostToolUse hook（Agent spawn 検出）+ Stop hook（Conductor 完了通知）を自動設定。

### 8. ロギングプロキシ（SKILL.md 未記載）

**SKILL.md**: API トレース機能に関する記述なし。

**実装**: `proxy.ts` が Anthropic API への透過プロキシを提供。リクエスト/レスポンスの JSONL トレース記録。Agent には `ANTHROPIC_BASE_URL` でプロキシ経由を指定。

### 9. TUI ダッシュボード（SKILL.md 未記載）

**SKILL.md**: Manager のダッシュボード機能に関する記述なし。

**実装**: `dashboard.tsx` が ink/React ベースのフルスクリーン TUI を提供。Header、Master、Conductors（Agent ツリー付き）、Tasks、Journal/Log タブ。2秒間隔で自動更新。キーボードショートカット対応。

### 10. team.json の構造（SKILL.md §6）

**SKILL.md の記述**: `manager` フィールドに `surface` と `status` のみ。

**実装**: `manager` フィールドに `pid`（プロセスID）と `type: "typescript"` を含む。`conductors` に `taskTitle` と `agents` 配列を含む。

### 11. hot reload（SKILL.md 未記載）

**SKILL.md**: reload 機能に関する記述なし。

**実装**: ダッシュボード `r` キーで plugin キャッシュの最新 `main.ts` を検索し、`exec` でプロセスを置換。

### 12. レビュー判断（SKILL.md 未記載）

**SKILL.md**: Conductor のレビュー判断ロジックに関する記述なし。

**実装**: `conductor.md` テンプレートにレビュー判断基準が定義。コードファイル（.ts, .py, .go 等）の変更がある場合のみ Reviewer Agent を起動。

### 13. Journal セクション（SKILL.md 未記載）

**SKILL.md**: タスク完了時の Journal 追記に関する記述なし。

**実装**: Conductor が完了時にタスクファイルに `## Journal` セクションを追記（summary, files_changed）。daemon が `collectResults()` で journal_summary を抽出してログに記録。TUI の Journal タブに表示。

### 14. spawn-agent CLI（SKILL.md 未記載）

**SKILL.md**: daemon の `spawn-agent` サブコマンドに関する記述なし。

**実装**: `main.ts spawn-agent --conductor-id <id> --role <role> --prompt <prompt>` で Agent のペイン作成・Trust 承認・タブ名設定・AGENT_SPAWNED 通知を一括実行。Conductor テンプレートからも参照されている。

### 15. E2E テストランナー（SKILL.md 未記載）

**SKILL.md**: E2E テストに関する記述なし。

**実装**: `e2e.ts` が3シナリオ（sequential dependencies, parallel + consolidation, interrupt TODO）の自動テストを提供。独立した cmux workspace で daemon のフルライフサイクルを検証。
