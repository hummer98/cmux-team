# Seed: Implementation Tasks

全フェーズ実装済み。以下は実装完了状態の記録。

---

## Phase 1: Foundation — 完了

### Task 1.1: Repository scaffolding — 完了
- ディレクトリ構造作成
- `skills/cmux-team/SKILL.md`, `skills/cmux-agent-role/SKILL.md`
- `commands/*.md`（全5コマンド: master, team-spec, team-task, team-archive, artifact）
- `skills/cmux-team/templates/`（全13テンプレート）
- `.gitignore`, `LICENSE` (MIT), `README.md`, `README.ja.md`
- `.claude-plugin/plugin.json`
- `package.json`（npm パッケージ）
- `bin/cmux-team.js`（CLI ラッパー）
- `bin/postinstall.js`（npm postinstall スクリプト）

### Task 1.2: npm パッケージング — 完了（install.sh を置き換え）
- `@hummer98/cmux-team` として npm 公開
- postinstall で bun install + claude plugin add を自動実行
- bin/cmux-team.js で bun を透過呼び出し（exit code 42 で自動再起動）

### Task 1.3: cmux-agent-role SKILL.md — 完了
- 出力プロトコル、タスク作成（CLI 経由）、作業境界、ロール別ガイドライン
- daemon ステータス取得セクション追加
- 完了シグナル・ステータス報告廃止（停止するだけ）

---

## Phase 2: Core Orchestration — 完了

### Task 2.1: cmux-team SKILL.md — 完了
- 4層アーキテクチャ全体定義
- Master の行動原則（やること/やらないこと）
- Manager プロトコル（TypeScript daemon）
- Conductor プロトコル（常駐セッション）
- Agent プロトコル
- 通信プロトコル（ファイルベース + cmux コマンド）
- チーム状態管理（team.json daemon 自動管理）
- レイアウト戦略（固定2x2）
- git worktree プロトコル
- エラーリカバリ

### Task 2.2: start 機能 — 完了
- daemon 起動 + Master spawn + 固定2x2レイアウト構築
- TUI ダッシュボード表示
- プロキシサーバー起動
- CLI サブコマンド `cmux-team start` として実装（旧 `/start` スラッシュコマンドは廃止）

### Task 2.3: status 機能 — 完了
- 真のソース直接参照（status.json 廃止）
- CLI サブコマンド `cmux-team status` として実装

### Task 2.4: stop 機能 — 完了
- グレースフルシャットダウン
- CLI サブコマンド `cmux-team stop` として実装

---

## Phase 3: Workflow Commands — 廃止

初期設計ではスラッシュコマンドとして以下を想定していたが、
タスクベースの Conductor 委譲モデルに移行したため廃止:

- `/team-research` → タスク作成で Conductor に委譲
- `/team-design` → タスク作成で Conductor に委譲
- `/team-impl` → タスク作成で Conductor に委譲
- `/team-review` → タスク作成で Conductor に委譲
- `/team-test` → タスク作成で Conductor に委譲
- `/team-sync-docs` → タスク作成で Conductor に委譲

---

## Phase 4: Support Commands — 完了

### Task 4.1: /team-task — 完了
- CLI ベース CRUD（`cmux-team create-task`, `update-task`, `close-task`）
- task-state.json による状態管理
- スラッシュコマンド `/team-task` でも操作可能

### Task 4.2: /team-archive — 完了
- closed タスクの日付別アーカイブ

### Task 4.3: /master — 完了
- `/clear` 後の Master ロール再読み込み

### Task 4.4: /artifact — 完了
- 知見の構造化・保存（research, decision, session, spec, report）
- 一覧表示・内容表示

---

## Phase 5: Templates & Polish — 完了

### Task 5.1: Agent prompt templates — 完了
- 全13テンプレート実装
- 旧仕様（`cmux wait-for -S`, `cmux set-status`）からの移行完了
- Conductor テンプレート3種（フル/タスク/ロール）追加
- Master テンプレート追加

### Task 5.2: README.md — 完了
- `README.md`（英語）+ `README.ja.md`（日本語）

### Task 5.3: Integration testing — 完了
- E2E テストランナー（`manager/e2e.ts`）実装
- 2シナリオ: 逐次依存（A→B→C）、並列リサーチ＋統合

---

## Phase 6: Manager Daemon — 完了（設計シードにない追加実装）

### Task 6.1: TypeScript daemon — 完了
- Bun ランタイムでの常駐プロセス
- イベント駆動ステートマシン（10秒ポーリング + ファイル監視による即時 tick）
- ファイルベースメッセージキュー（Zod バリデーション）
- ソースファイル mtime 監視による自動再起動（exit code 42）

### Task 6.2: Conductor スロット管理 — 完了
- 起動時に3台の常駐 Claude セッションを作成
- タスク割り当て → 実行 → 完了検出 → リセットのサイクル
- doneCandidate パターン（2 tick 連続で完了確定）

### Task 6.3: spawn-agent CLI — 完了
- プロキシ設定・タブ作成・Trust 承認を一括実行
- ロールアイコンマッピング
- Conductor ペイン内にタブとして作成

### Task 6.4: TUI ダッシュボード — 完了
- React + ink ベース（@rezi-ui/core, @rezi-ui/node 使用）
- ヘッダー・Conductor 一覧・タスクリスト・Journal/Log タブ
- 2秒間隔ライブ更新

### Task 6.5: API プロキシサーバー — 完了
- Bun.serve ベースのリクエスト/レスポンスログ
- ストリーミング対応
- 既存プロセスの再利用
- デバッグエンドポイント

### Task 6.6: タスク状態管理 — 完了
- `task-state.json` による集約管理（draft/ready/in_progress/closed/archived）
- フラット `tasks/` 構造（旧 `open/closed/` サブディレクトリ廃止）
- 依存関係解決（`depends_on` フィールド）
- 優先度ソート（high/medium/low）

### Task 6.7: トレースDB — 完了
- SQLite FTS5 データベース（`trace-store.ts`）
- API リクエスト/レスポンスのメタデータ + 本文を記録
- CLI 検索: `cmux-team trace --task <id>`, `--search <query>`, `--show <id>`
- メタデータヘッダー伝播: `x-cmux-task-id`, `x-cmux-conductor-surface`, `x-cmux-role`

### Task 6.8: アーティファクト管理 — 完了
- `artifact.ts` によるアーティファクト CRUD
- CLI: `cmux-team artifacts`（一覧・検索）
- スラッシュコマンド `/artifact`（作成・一覧・表示）

### Task 6.9: 追加 CLI サブコマンド — 完了
- `conductor` — Conductor 情報表示
- `spawn-master` — Master surface 起動

### Task 6.10: ユニットテスト — 完了
- `daemon.test.ts`, `proxy.test.ts`, `queue.test.ts`, `task.test.ts`
- `bun test` で実行（`prepublishOnly` で自動実行）

### Task 6.11: Plugin hooks — 完了
- SessionStart hook: cmux 環境外でのタブ名リネーム
- PreToolUse hook: team.json / task-state.json への直接編集ブロック

---

## 追加改善（Phase 7 以降）

以下は今後の改善候補であり、現時点では未実装:

- レート制限のインテリジェント制御（プロキシでの自動スロットリング）
- Conductor 台数の動的スケーリング
- Web UI ダッシュボード
- マルチプロジェクト対応
