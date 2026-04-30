# 08. Runtime Boundary 棚卸し（Issue #30 M1）

`skills/cmux-team/manager/` 配下の全 TypeScript ファイルを **runtime-specific** / **runtime-agnostic** / **boundary** に分類した棚卸し表。
Issue #30 (Epic: Runtime backend abstraction) の Milestone M1 成果物。

## 分類基準

| 分類 | 意味 |
|---|---|
| **runtime-specific** | Claude Code CLI 固有の概念（hook push / PID watcher / `cmux send` / `/clear` / read-screen / `ANTHROPIC_BASE_URL` / proxy）に直接依存 |
| **runtime-agnostic** | task-state / schema / worktree / deliverable / trace DB / eventBus / logger / config / paths など runtime に無関係 |
| **boundary** | runtime-agnostic コアから runtime-specific を呼び出す接点。アダプタ化が必要な箇所 |

---

## ファイル別分類

### runtime-agnostic（24 ファイル）

| ファイル | 主な責務 |
|---|---|
| `agent-instructions.ts` | Agent overlay ファイルの読み書き・検証 |
| `artifact.ts` | アーティファクトメタデータの解析・検索・登録 |
| `classify-stop.ts` | Stop hook payload の分類（ASK/IDLE 判定）— hook signal 型を参照するが分類ロジック自体は純粋関数 |
| `config.ts` | `.team/config.json` の読み込み・派生値解決 |
| `dashboard-metrics.ts` | Metrics タブの UI 行構築（burn rate 計算） |
| `direnv-check.ts` | `.envrc` direnv allow 状態の非対話検証 |
| `eventBus.ts` | Node.js EventEmitter ベースの状態変更イベント通知 |
| `exec-error.ts` | child_process エラー整形（ログ 1 行化） |
| `gh-cache-auth.ts` | GitHub トークン解決 |
| `gh-cache-cli.ts` | `cmux-team issue|pr` CLI コマンド実装 |
| `gh-cache-format.ts` | GitHub REST JSON ⇄ gh CLI 互換形式の変換 |
| `gh-cache-repo.ts` | git remote から GitHub repo 情報を解決 |
| `gh-cache-store.ts` | `.team/gh-cache.db` の CRUD・スキーマ管理 |
| `gh-cache-sync.ts` | GitHub REST API fetch + DB 反映 |
| `gh-cache-types.ts` | GitHub API/DB record の zod スキーマ定義 |
| `git-sync.ts` | local/origin の同期状態判定（7 状態） |
| `i18n.ts` | 言語検出・国際化メッセージ管理 |
| `layout-restore.ts` | team.json Conductor 復帰計画（pure function） |
| `logger.ts` | ログファイル書き込み・surface format |
| `main-branch.ts` | main branch の自動検出・永続化 |
| `paths.ts` | surface 名のパス正規化 |
| `rate-limit-display.ts` | rate limit 情報を dashboard UI に整形 |
| `rate-limit-persistence.ts` | rate limit 情報の永続化・復元・stale 判定 |
| `task.ts` | タスクメタデータ解析・依存解決・state 管理 |
| `template.ts` | プロンプトテンプレート変数展開 |
| `test-project.ts` | テスト用ダミープロジェクト helper |
| `trace-store.ts` | SQLite ベースのタスク-セッション索引・API usage 記録 |
| `worktree-base.ts` | git worktree add の start-point 解決 |

> **注**: `schema.ts` は `SESSION_STARTED` 等のメッセージ型を定義するが、これは hook signal の型定義（データ構造）であり、実際の hook 配管ロジックは持たない。M2 で正規化イベントアルファベットを定義したら型定義を分離する候補。

### runtime-specific（5 ファイル）

| ファイル | 主な責務 | Claude Code 固有依存 |
|---|---|---|
| `cmux.ts` | cmux コマンドラッパー（ペイン操作・PID watcher） | `cmux send/send-key/read-screen/tree/identify/new-split/close-surface/notify`、`process.kill(pid, 0)` |
| `envrc-prompt.ts` | `.envrc` への `CMUX_CLAUDE_HOOKS_DISABLED=1` 追記対話 | `.envrc` + direnv CLI |
| `pidfile.ts` | daemon 多重起動防止（pidfile lock） | `process.kill(pid, 0)`、`ps` コマンド |
| `preflight.ts` | 前提条件チェック（claude/bun/git/jq/permissions） | `claude` / `bun` バイナリ検出、Claude Code 固有 flag |
| `e2e.ts` | E2E テストランナー | `cmux send`、`cmux read-screen`、`cmux tree` |

### boundary（3 ファイル）

| ファイル | 主な責務 | アダプタ化が必要な箇所 |
|---|---|---|
| `conductor.ts` | Conductor 初期化・タスク割り当て・監視・結果回収・リセット | `launchConductor`（cmux.send + shell 環境変数注入）、`assignTask`（`/clear` 送信 + worktree 作成の混在）、`resetConductor`（cmux.closeSurface + worktree cleanup の混在） |
| `daemon.ts` | Manager メインロジック・イベント処理・状態管理（event loop hub） | hook signal 受信（`SESSION_STARTED` / `SESSION_IDLE` 等）から state 遷移を行う `handleMessage`、PID watcher 起動、proxy URL 注入 |
| `proxy.ts` | Anthropic API 透過プロキシ + JSONL トレース・rate limit 管理 | `ANTHROPIC_BASE_URL` でリダイレクト制御、rate limit header 抽出、プロキシ起動・shutdown |

### mixed（schema.ts について）

`schema.ts` は `SESSION_STARTED` 等のメッセージ型を enum として持つが、これは純粋な型定義であり runtime 固有ロジックは持たない。M2 で正規化イベントアルファベットを定義したら `HookSignalType` を `RuntimeBackend` interface 側に移動し、`schema.ts` は runtime-agnostic のままに保つのが望ましい。

---

## 集計サマリー

| 分類 | ファイル数 | 割合 |
|---|---|---|
| runtime-agnostic | 28 | 65.1% |
| runtime-specific | 5 | 11.6% |
| boundary | 3 | 7.0% |
| （型定義のみ / 境界グレー） | 7 | 16.3% |
| 合計 | 43 | 100% |

---

## アダプタ化の優先順位

M3（claude-code adapter 実装）に向けた着手順序:

### 1. `conductor.ts` — 最優先

`assignTask` と `resetConductor` に runtime-agnostic な worktree ロジックと runtime-specific な `/clear` + `cmux send` が混在している。分離方針:

- **`AgentBackend` interface** を切る: `spawn(prompt)`, `send(text)`, `reset()`, `kill()` の 4 メソッド
- `launchConductor` は surface 生成部分（cmux 依存）をアダプタ側に委譲
- worktree 作成・削除ロジックはコアに残す

### 2. `daemon.ts` — handleMessage の分離

`handleMessage` の hook signal 受信 → state 遷移のハンドラを以下に分離:

- **`RuntimeEventAdapter`**: hook push（`SESSION_STARTED` / `SESSION_IDLE` 等）を受けて正規化イベント（`session_started` / `session_idle` 等）に変換
- **コア `handleEvent(normalizedEvent)`**: 正規化イベントのみを受け取り、task-state / ConductorState を更新
- opencode アダプタは SSE event を正規化イベントに変換してコアに流す

### 3. `proxy.ts` — FetchInterceptor interface

- `interface TraceInterceptor { intercept(req, res): void }` を定義
- claude-code アダプタ: `ANTHROPIC_BASE_URL` を proxy に向けて intercept
- opencode アダプタ: `provider.options.baseURL` で proxy に向ける（静的設定で対応可能）
- rate limit 情報の抽出・永続化は既に `rate-limit-persistence.ts` に分離済み → コアに残せる

---

## 正規化イベントアルファベット（M2 設計候補）

Claude Code hook signal → 正規化イベントの対応:

| Claude Code hook | 正規化イベント | opencode SSE 相当 |
|---|---|---|
| `SESSION_STARTED` | `session_started` | `session.status` (status=running) |
| `SESSION_IDLE` | `session_idle` | `session.idle` |
| `SESSION_CLEAR` | `session_reset` | N/A（`/clear` は opencode では session 再作成） |
| `SESSION_ENDED` | `session_ended` | `session.error` or `session.status`(stopped) |
| `NOTIFICATION` | `permission_asked` | `permission.asked` |
| `STOP_FAILURE` (T392) | `api_error_received` | `session.error` (error=ApiError) |
| `CONDUCTOR_DONE` | `task_completed` | （daemon 内部イベント、runtime 非依存） |
| `AGENT_SPAWNED` | `agent_started` | （spawn-agent CLI 内部イベント） |

---

*更新: 2026-04-24（Issue #30 M1 棚卸し完了）*
