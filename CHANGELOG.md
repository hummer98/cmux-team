# Changelog

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
