# Seed: Implementation Tasks

全フェーズ実装済み。以下は実装完了状態の記録。

---

## Phase 1: Foundation — 完了

### Task 1.1: Repository scaffolding — 完了
- ディレクトリ構造作成
- `skills/cmux-team/SKILL.md`, `skills/cmux-agent-role/SKILL.md`
- `commands/*.md`（全13コマンド）
- `skills/cmux-team/templates/`（全13テンプレート）
- `.gitignore`, `LICENSE` (MIT), `README.md`, `README.ja.md`
- `.claude-plugin/plugin.json`

### Task 1.2: install.sh — 完了
- `--check`, `--uninstall`, `--help` フラグ実装
- `using-cmux` スキル依存チェック追加

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

### Task 2.2: /start コマンド — 完了
- daemon 起動 + Master spawn + 固定2x2レイアウト構築
- TUI ダッシュボード表示
- プロキシサーバー起動
- 旧 `/team-init` を置き換え

### Task 2.3: /team-status コマンド — 完了
- 真のソース直接参照（status.json 廃止）

### Task 2.4: /team-disband コマンド — 完了
- Bottom-up 停止（Agent → Conductor → Manager）
- git worktree クリーンアップ
- 未マージ worktree の警告

---

## Phase 3: Workflow Commands — 完了

### Task 3.1: /team-research — 完了
- トピック分解 → Researcher 3体 spawn → 結果統合

### Task 3.2: /team-spec — 完了
- 対話的要件ブレスト → requirements.md 生成

### Task 3.3: /team-design — 完了
- Architect + Reviewer 2体 → 設計レビューループ → design.md 生成

### Task 3.4: /team-impl — 完了
- タスク自動生成、並列実装、バッチ処理

### Task 3.5: /team-review — 完了
- diff サイズベースレビュアー配分、findings からタスク自動作成

### Task 3.6: /team-test — 完了
- スコープ別テスト（unit/integration/e2e）、フレームワーク自動検出

---

## Phase 4: Support Commands — 完了

### Task 4.1: /team-task — 完了
- CLI ベース CRUD（`bun run main.ts create-task`, `close-task`）
- task-state.json による状態管理

### Task 4.2: /team-sync-docs — 完了
- スナップショット差分検出、DocKeeper Agent オプション

### Task 4.3: /team-archive — 完了（追加実装）
- closed タスクの日付別アーカイブ

### Task 4.4: /master — 完了（追加実装）
- `/clear` 後の Master ロール再読み込み

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
- イベント駆動ステートマシン（10秒ポーリング）
- ファイルベースメッセージキュー（Zod バリデーション）

### Task 6.2: Conductor スロット管理 — 完了
- 起動時に3台の常駐 Claude セッションを作成
- タスク割り当て → 実行 → 完了検出 → リセットのサイクル
- doneCandidate パターン（2 tick 連続で完了確定）

### Task 6.3: spawn-agent CLI — 完了
- プロキシ設定・タブ作成・Trust 承認を一括実行
- ロールアイコンマッピング
- Conductor ペイン内にタブとして作成

### Task 6.4: TUI ダッシュボード — 完了
- React + ink ベース
- ヘッダー・Conductor 一覧・タスクリスト・Journal/Log タブ
- 2秒間隔ライブ更新

### Task 6.5: API プロキシサーバー — 完了
- Bun.serve ベースのリクエスト/レスポンスログ
- JSONL トレース形式
- ストリーミング対応
- デバッグエンドポイント

### Task 6.6: タスク状態管理 — 完了
- `task-state.json` による集約管理（draft/ready/in_progress/closed/archived）
- フラット `tasks/` 構造（旧 `open/closed/` サブディレクトリ廃止）
- 依存関係解決（`depends_on` フィールド）
- 優先度ソート（high/medium/low）

---

## 追加改善（Phase 7 以降）

以下は今後の改善候補であり、現時点では未実装:

- レート制限のインテリジェント制御（プロキシでの自動スロットリング）
- Conductor 台数の動的スケーリング
- Web UI ダッシュボード
- マルチプロジェクト対応
