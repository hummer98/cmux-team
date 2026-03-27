# Changelog

## [2.11.0] - 2026-03-28

### Added
- CLI ベースの Agent spawn: `main.ts spawn-agent` コマンドで Conductor からエージェントを起動。logging proxy 統合により全出力を `.team/logs/` に記録
- `--task-title` オプション: spawn-agent に記述的タブ名を指定可能に
- TUI journal タブ: Conductor 完了レポートをジャーナル形式で表示。タスク履歴の振り返りが容易に
- TUI ダッシュボードに Tasks セクション追加: タスク一覧と journal タブのレイアウトを統合

### Changed
- TUI・status のタイムスタンプをローカルタイムゾーンで表示するよう変更

## [2.10.0] - 2026-03-27

### Added
- Stop hook によるイベント通知統一: Conductor 終了時に `main.ts send CONDUCTOR_DONE` で成功/失敗を Manager に通知。`hook-agent-spawned.sh` を廃止し全イベントを CLI 経由に一本化
- `CONDUCTOR_DONE` メッセージに `success` / `reason` / `exitCode` フィールドを追加。エラー終了の検知とリカバリが可能に
- TUI フッターにバージョン番号を表示

### Changed
- Conductor 完了時のペイン自動クローズを廃止。作業履歴の確認やデバッグが容易に

### Fixed
- TUI リロード時のクラッシュを修正（ink unmount してからプロセス再起動）
- リロード時に `exec` でプロセスを置き換え、Master surface を保持するよう修正

## [2.9.0] - 2026-03-27

### Added
- Agent surface のツリー表示: Conductor が spawn した Agent を TUI・status API・team.json にツリー構造で表示
- PostToolUse hook による Agent 自動検出: Conductor の `cmux new-split` を hook で検出し daemon に通知。LLM の協力不要、完全に決定論的
- Conductor 起動時に `--settings` で hook 付きカスタム設定を注入
- daemon status API のドキュメントを共通スキル（cmux-agent-role）に追加。全ロールが `main.ts status` で daemon 状態を参照可能に

### Changed
- Master テンプレートの進捗報告を `main.ts status` に一本化（pid check + cmux read-screen の手動手順を廃止）

## [2.8.0] - 2026-03-27

### Added
- TUI キーボードショートカット: `r` でリロード、`q` で終了。htop 風のキーヒントを最下段に表示
- `r` キーで最新 plugin バージョンに自動切り替え: plugin キャッシュから最新の `main.ts` を再検索して再起動

## [2.7.0] - 2026-03-27

### Added
- `main.ts status` API: daemon に依存せずダッシュボード情報を取得可能。`--log N` でログ末尾行数を指定
- Conductor のタスクタイトル表示: TUI・status API・タブ名・team.json に反映
- フルスクリーン TUI ダッシュボード: ターミナルサイズにレスポンシブ、ログ末尾を色分け表示

### Changed
- **マージ責務を daemon から Conductor に移動**: daemon は決定論的な worktree 削除のみ。マージ/PR は Conductor が判断・実行する。コンフリクト解決も Conductor の責務に
- Conductor テンプレート: 完了時にローカルマージまたは PR 作成を選択可能に

## [2.6.0] - 2026-03-27

### Added
- TypeScript daemon による決定論的 Manager（Claude Code セッションを廃止し、bun プロセスに完全移行）
- TUI ダッシュボード（ink ベース）: タスク・Conductor 状態をリアルタイム表示
- タスク依存解決: `depends_on` フィールドで依存チェーンを宣言可能
- 優先度ソート: high > medium > low の順でタスクを実行
- CLI インターフェース: `main.ts start/send/status/stop` で daemon を操作
- ファイルキュー通信: `.team/queue/` 経由のメッセージパッシング（`cmux send-key` 不要に）
- ユニットテスト 39 件: タスクパース、依存解決、キュー送受信、ユースケースシナリオ
- E2E テストランナー: 独立 cmux workspace で実際の Claude Code を起動して検証（3 シナリオ）
- CONTRIBUTING.md: テスト方法・リポジトリ構造・コーディング規約をコントリビューター向けに分離

### Changed
- README.md / README.ja.md を daemon アーキテクチャに合わせて全面書き直し
- bun を前提条件に追加
- インストール方法: plugin 推奨、skills add をフォールバックに整理

### Fixed
- テンプレート検索: `import.meta.path` からの相対パスを最優先にし、任意のプロジェクトで確実に検出
- テンプレート未検出時: フォールバック動作を廃止し、エラー停止 + リカバリー手段を表示
- ゼロパディング ID のタスクファイルマッチング（`startsWith("1")` が `001-*.md` にマッチしない問題）
- Conductor spawn 後 30 秒のガード期間を追加（初期化中の誤完了判定を防止）

## [2.5.0] - 2026-03-25

### Added
- `/master` コマンド: `/clear` 後に Master ロールを再読み込みする

## [2.4.0] - 2026-03-25

### Added
- `/team-archive` コマンド: 完了タスクを日付ディレクトリにアーカイブ。範囲指定対応（例: `/team-archive 1-33`）

## [2.3.1] - 2026-03-25

### Changed
- Master テンプレートに TODO ワークフローと cmux#2042 バリデーションを追加（ランタイムとの乖離を解消）
- CLAUDE.md にプロンプト編集ルールを追加（テンプレートがソースオブトゥルース、ランタイム直接編集禁止）

### Fixed
- テンプレート検索で plugin キャッシュの最古バージョン (v2.0.0) が優先される問題を修正（`sort -V | tail -1` で最新を選択）
- spawn-team.sh が Master プロンプトに common-header.md を付与していた問題を修正（Master のペイン操作が抑制されていた）
- `/release` で旧バージョンの plugin キャッシュを削除するステップを追加

## [2.3.0] - 2026-03-25

### Added
- `spawn-team.sh`: `/start` の全フェーズを一括実行するスクリプト（インフラ準備・プロンプト生成・ペイン作成・Trust 承認・team.json 更新）

### Changed
- `/start` コマンドを `spawn-team.sh` の1回呼び出しに簡素化（約20回の tool call → 1回に高速化）

## [2.2.3] - 2026-03-25

### Fixed
- `/team-disband` で未マージの worktree を警告なしに強制削除していた問題を修正（未マージの変更がある場合は警告を表示し、`force` 引数がない限り削除しない）

## [2.2.2] - 2026-03-25

### Changed
- `/start` 実行時に毎回 plugin キャッシュからテンプレートを再生成するよう変更（plugin 更新後にプロンプトが古いまま残る問題を解消）
- Conductor 最大同時実行数を環境変数 `CMUX_TEAM_MAX_CONDUCTORS` で設定可能に（デフォルト: 3）
- Conductor 終了時に session_id を manager.log に記録（`claude --resume` で事後確認可能）

### Fixed
- タスク完了時に worktree のマージを検証せずクローズしていた問題を修正（コード変更の消失を防止）

## [2.2.1] - 2026-03-25

### Changed
- Conductor テンプレートを強化: 冒頭に「自分でコードを書かない」ルールを配置、`[CMUX-TEAM-AGENT]` ヘッダーを除去
- Conductor に Agent 監視ループを追加: 30秒間隔のポーリングで Agent 完了を検出（Agent spawn 後に完了を待てない問題を解消）
- `/release` コマンドをプロジェクトローカル (`.claude/commands/`) に移動（plugin 配布対象から除外）
- `/release` に marketplace キャッシュ pull + plugin reinstall ステップを追加

### Fixed
- タブタイトルに surface 番号が表示されない問題を修正（`[M]` → `[58] Master` 等）

## [2.2.0] - 2026-03-25

### Added
- `/release` コマンド: バージョン自動判定・CHANGELOG 更新・push・GitHub Release を一括実行
- Conductor にレビュー判断ステップ: コード変更を伴うタスクのみ Reviewer Agent を自動起動
- Manager に TODO ワークフロー: タスクファイル不要の軽量ジョブを `[TODO]` メッセージで即時実行
- spawn-conductor.sh がテンプレートベースのプロンプト生成に対応（レビューフロー等がConductor に渡るように）
- ランタイムスクリプト (`spawn-conductor.sh`, `validate-surface.sh`) を plugin 配布物に同梱
- `/start` の Phase 0 でスクリプトを `.team/scripts/` に自動コピー
- surface 存在検証スクリプト (`validate-surface.sh`) で cmux#2042 のフォールバック問題を回避

### Changed
- Manager テンプレートから `[CMUX-TEAM-AGENT]` ヘッダーを除去（ペイン操作が Manager の主要責務であることを明記）
- Manager テンプレートの `[PLAN_UPDATE]` 機構を廃止し、Claude Code ネイティブの TaskCreate/TaskUpdate による TODO 管理に置換
- `cmux rename-tab` を Claude Code 起動後に実行するよう変更（起動前だとタイトルが上書きされる問題を修正）
- Manager のループプロトコルを改善: 毎サイクルでタスク走査を実行（Conductor 監視中の新規タスク検出漏れを防止）

### Fixed
- Manager が Conductor を起動せずサブエージェント (Agent ツール) で作業してしまう問題を修正
- Manager モデルを Haiku から Sonnet に変更（テンプレート指示への追従性向上）

## [2.0.0] - 2026-03-23

### Added
- 4層アーキテクチャ (Master → Manager → Conductor → Agent) の初期実装
- 11 のスラッシュコマンド (`/start`, `/team-status`, `/team-impl` 等)
- 10 のエージェントテンプレート (manager, conductor, researcher, architect 等)
- git worktree による Agent の作業隔離
- Manager のイベント駆動型アイドル停止
- Claude Code Plugin としての配布対応
