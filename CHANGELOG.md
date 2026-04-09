# Changelog

## [3.30.0] - 2026-04-09

### Added
- plan.md の出力先を worktree から OUTPUT_DIR（タスクフォルダ `runs/` 配下）に変更 (T107)
- ダッシュボード Tasks の並び順を open 上位 + createdAt 降順に変更 (T108)
- `delete-task` コマンド追加 (T109)
- `abort-task` の Journal 記録対応 (T109)
- タスク時間管理: `assignedAt` 記録 + ダッシュボードに経過時間表示 (T110)
- workspace 分離: `cmux identify` から workspace_ref を取得し、他ワークスペースの surface との混同を防止 (T116)

### Fixed
- メモリリーク修正: daemon.ts の interval 重複・fs.watch 未クローズ・proxy.ts の `drainAndLog` 未 catch (T113)
- Conductor `starting` 状態のステート遷移バグ修正 (T114)
- `daemon_auto_restart` 後に Master が proxy を見失う問題を修正 (T115)

## [3.29.0] - 2026-04-07

### Added
- タスク中心フォルダ集約: プロンプト・出力をタスクディレクトリ（`.team/tasks/TNNN-slug/runs/`）に統合。タスク単位で関連ファイルが一箇所にまとまる (T102)
- Tasks タブで Enter 押下時にタスクドキュメントを glow フルスクリーンビューワーで表示 (T103)
- PreToolUse hook で `.team/tasks/*/runs/` 配下への書き込みを許可。指示書の生成がブロックされなくなる (T104)
- ダッシュボードの 5h/7d レート制限表示を個別色化し、ダークトーンに変更 (T105)

### Fixed
- `close-task` 実行後に CONDUCTOR_DONE メッセージが送信されず Conductor が stuck するバグを修正 (T106)

## [3.28.0] - 2026-04-07

### Added
- Journal・Log の表示順を逆転し、最新エントリが一番上に表示されるように変更。エントリ追加時は先頭表示中なら自動追従、スクロール中は位置を保持、フォーカス中は自動スクロール無効 (T100)
- ダッシュボードの TPM 表示を 5h/7d の unified 使用率表示に置換

### Fixed
- Tasks スクロール領域が広くなりすぎていたのを5行に戻した (T099)

## [3.27.0] - 2026-04-07

### Added
- `dockeeper` スキル (`skills/dockeeper/SKILL.md`) を新規追加。`git log` と closed タスク履歴を参照して `docs/spec/` を実装と同期する
- `/docs-sync` スラッシュコマンドを追加。`--dry-run`（差分確認のみ）・`--auto`（確認なし自動更新）オプション対応
- ダッシュボードの GitHub issue リンクに OSC 8 ハイパーリンクを有効化。対応ターミナルでクリック可能に (T093)
- ダッシュボード Tasks 行全体をクリック可能に (T094)

### Changed
- ダッシュボードヘッダーから RUNNING 表示を削除し、バージョン番号の表示位置を移動 (T095)
- Master プロンプト: assigned タスクへの補足指示フローを改善。`abort-task` 推奨を廃止し、状態確認 → `--depends-on` 後続タスク作成 or `cmux send` 直接送信の判断フローを追加

### Fixed
- `create-task --help` に `--run-after-all` オプションの説明を追加 (T098)
- ダッシュボード Tasks セクションのスクロールが5件で止まるバグを修正 (T096)
- Master がアイドル時にスピナーが回り続けるバグを修正 (T097)

## [3.26.1] - 2026-04-06

### Fixed
- Conductor の hook 注入を `CMUX_CLAUDE_HOOKS_DISABLED` 方式に修正。cmux ラッパーが `--settings` を先に注入するため cmux-team の hooks が無視される問題を解消。cmux hooks と cmux-team hooks をマージした単一の settings で両方が正常に動作するように (T092)

## [3.26.0] - 2026-04-06

### Added
- Conductor 起動時に `--settings` フラグで hook 設定を自動注入 (T089)。worktree 内でも SessionStart フックが正しく動作するように

### Fixed
- daemon 起動時の `console.log` 出力を `log()` に置換。ログがファイルに統一され TUI 表示が崩れなくなった

## [3.25.0] - 2026-04-06

### Added
- ダッシュボードヘッダーに proxy ポート番号を表示（例: `:60372`）。proxy が生きているかひと目でわかるように
- ダッシュボード Tasks セクションのヘッダーをクリックでタスクフォーカスに切り替え可能に
- タブボタン（Journal / Artifacts / Log）クリック時に対応エリアにフォーカス移動

### Fixed
- `daemon_reload`（R キー）後に proxy が道連れ停止するバグを修正。`exit 42`（auto_restart）を受け取った子 daemon が終了すると proxy 所有者の親 daemon も `process.exit(0)` して proxy が停止する問題を解消。cmux-team.js と同様の再起動ループを組み込み、proxy を安定させる
- `tick()` で proxy の死活を毎ポーリング確認し、停止時にログ（`proxy_dead`）を記録。問題発生時の原因追跡が可能に
- ダッシュボードのカーソルスタイルを `{ underline: true }` → `{ style: { underline: true } }` に修正（rezi-ui スタイル仕様に合わせる）
- ダッシュボード QoL 改善: フォーカスシステム・スクロール・カーソル (T088)

## [3.24.2] - 2026-04-06

### Fixed
- `task_completed` イベントの二重記録を防止。CONDUCTOR_DONE ハンドラにステータスガードを追加し、同一タスクの完了が複数回記録される問題を解消 (T085)
- Journal の `Tundefined` 表示を防御。不正なログ行を削除し、タスクID が未定義のまま記録される問題を修正 (T087)

## [3.24.1] - 2026-04-05

### Fixed
- `create-task` CLI で `dependsOn` 変数が二重宣言されていたバグを修正。`cmux-team start` が即クラッシュする問題を解消

## [3.24.0] - 2026-04-05

### Added
- タスクに `base_branch` フィールド追加。`create-task --base-branch` でマージ先ブランチを明示的に指定可能。TUI に Nerd Font ブランチアイコン（）で表示
- `create-task` CLI に `--depends-on` オプション追加。タスク間の依存���係を指定可能に
- `SESSION_CLEAR` メッセージ追加。`/clear` 実行時に disconnected Conductor を自動回復（TUI チラつきなし）
- TUI ダッシ��ボード QoL 改善: Tasks/Journal のステータスを Nerd Font アイコン化、カーソル表示をアンダーバーに変更、Journal 内の surface 表示を dim 化

### Fixed
- `create-task --depends-on` が無視されるバグを修正。frontmatter に `depends_on` が書き出されず依存チェックが機能しなかった問題を解消

## [3.23.0] - 2026-04-05

### Added
- TUI ダッシュボードを起動シーケンスの早期に表示。プロキシ起動直後に TUI を立ち上げ、Conductor/Master の起動進捗はジャーナルで確認可能に。console.log を廃止し manager.log に統一
- TUI 右上にトークン残量 % をリアルタイム表示。proxy.ts で API レスポンスのレート制限ヘッダーを記録し、ダッシュボードに反映
- Conductor の実装フローテンプレートを強化。4フェーズ（Plan → Design Review → TDD → Inspection）の各テンプレートに詳細な指示・チェックリストを追加

## [3.22.1] - 2026-04-04

### Fixed
- Conductor 初期化時のレースコンディションを修正。pane 分割と Claude 起動を2フェーズに分離し、最初に spawn された Conductor が "starting" に戻されて disconnected になる問題を解消

## [3.22.0] - 2026-04-04

### Added
- Conductor の実装フローを4フェーズ（Plan → Design Review → TDD → Inspection）に刷新。各フェーズに専用テンプレート（planner, design-reviewer, implementer, inspector）を追加
- 起動コマンド名を `spawn-*` に統一（`launch-master` → `spawn-master`）、未使用の `restart-conductor` / `reset-conductor` を削除

### Fixed
- IPC 移行で残存していた `sendMessage` 参照を HTTP API (`postMessage`) に移行

### Changed
- assigned（実行中）タスクの編集禁止ルールを Master テンプレートと CLAUDE.md に明記

## [3.21.0] - 2026-04-04

### Added
- TUI の Master 列に状態表示（running/idle/入力プロンプトの先頭部分）を追加。Claude Code hooks + daemon HTTP API で連携
- ファイルベース IPC を HTTP API に移行（キュー・done マーカーを廃止し、proxy エンドポイント経由の通信に統一）
- Conductor の自己登録方式を導入（`spawn-conductor` コマンド新設）。daemon が Conductor を直接管理する代わりに、Conductor 起動時に自身を登録する形に変更
- Conductor に "starting" ステータスを追加。起動途中の Conductor にタスクが割り当てられる問題を防止

## [3.20.1] - 2026-04-04

### Changed
- TUI の tasks 表示が 2 秒ポーリングではなく daemon の状態変化直後に更新されるように改善

## [3.20.0] - 2026-04-04

### Added
- `--model` オプションで Master・Conductor・Agent ごとに使用モデルを指定可能に（`cmux-team spawn-master --model claude-opus-4-6` 等）

### Fixed
- `spawn-master` 経由で起動した Master が指示に無応答になる問題を修正（初期プロンプト引数を渡していたため Claude が print モードで起動・終了していた）
- プロキシのエラーが `manager.log` に記録されなかった問題を修正（`fetchHandler` に try-catch を追加）
- streaming レスポンスのログ処理中に例外が発生した場合、`reader.releaseLock()` が呼ばれず応答がブロックされる可能性を修正

## [3.19.1] - 2026-04-04

### Fixed
- `cmux-team start` 起動時に dashboard.tsx の `SPINNER_FRAMES` 重複宣言で Bun ランタイムエラーが発生する問題を修正

## [3.19.0] - 2026-04-04

### Added
- `abort-task` コマンドを追加。実行中タスクの中止・Conductor/Agent の強制停止・worktree クリーンアップを一括実行
- TUI の running Conductor にスピナーアニメーション（boxBounce: ▖▘▝▗）を追加
- TUI の Tasks セクションにカーソル移動とスクロール機能を追加（上下矢印キー対応）
- TUI のタスク一覧で `depends_on` の未解決依存を `[blocked Txxx]` として表示
- TUI の Journal に Conductor の surface 番号 `[xxx]` を表示
- Master の Claude Code セッション状態を Manager が監視し TUI に反映（connected/disconnected/idle/running）
- GitHub Actions によるリリース自動化ワークフロー（タグ push で npm publish + GitHub Release）
- ロギングポリシーを策定し全般的にログを改善。外部コマンド失敗・判断分岐・例外の握りつぶしを解消

### Changed
- npm auto-update を全 Conductor が idle のときのみ実行するよう制限
- `docs/seeds/` を `docs/spec/` にリネーム。設計シードから統合仕様書に位置づけを変更
- 統合仕様書を現在の実装に同期

### Fixed
- dashboard.tsx の型エラーと task.test.ts のモック不足を修正

## [3.18.0] - 2026-04-04

### Added
- ブランチ名・worktree パスをタスクIDベースの命名に変更（`task-<NNN>-<timestamp>` 形式）。git branch や git log からどのタスクの作業か一目で判別可能に

### Fixed
- タスク未割り当ての Conductor が disconnected になった際に `T000` と表示される問題を修正

## [3.17.0] - 2026-04-04

### Added
- 全サブコマンドに `--help` オプションを追加。AI がコマンド仕様を自己参照可能に
- タスクに `run_after_all` フラグを追加。全通常タスク完了後に実行するタスク（リリース等）をキュー可能に
- ステートファイルを統一し PreToolUse hook で保護。AI からの直接編集をブロック
- task-state.json のアトミック書き込み（tmp → rename）を実装

### Fixed
- `/clear` 時に Conductor が一時的に disconnected 表示になる問題を修正。SessionEnd hook の matcher から `clear` を除外

### Changed
- ConductorState を team.json に永続化。daemon 再起動時にタスク割り当て情報を復元可能に
- Conductor マーカーファイル方式を廃止。team.json + cmux tree ベースの管理に統一

## [3.16.0] - 2026-04-03

### Added
- Master/Conductor/Agent 起動時に `CMUX_NO_RENAME_TAB=1` を設定。using-cmux の SessionStart フックによるタブ名上書きを抑止
- using-cmux プラグインとの共存が可能に。排他的な競合警告を削除

## [3.15.0] - 2026-04-03

### Added
- using-cmux スキルの機能を cmux-team に統合。cmux 環境内でのペイン操作・サブエージェント管理が単一プラグインで完結
- TUI ログタブにローカルタイムゾーン表示とスクロール機能を追加
- Master surface のマーカーファイル方式を実装。daemon が Master を確実に識別可能に

### Fixed
- Agent 完了時に Conductor ツリーから削除されない問題を修正（SESSION_ENDED が Agent surface でも正しく処理されるように）
- spawn-agent が Conductor のペインではなくフォーカス中のペインにタブを作成するバグを修正。paneId を明示的に指定するように変更
- TUI で closed タスクが running 表示のままになるバグを修正。task-state.json の status を優先するように変更

## [3.14.0] - 2026-04-03

### Added
- Artifacts タブで Enter キーによる Markdown ビューア起動。環境変数 `CMUX_MD_VIEWER` でビューア指定可能（デフォルト: glow → cat フォールバック）

### Changed
- サブエージェントの TUI ツリー削除トリガーを明示的キューメッセージ (AGENT_DONE) から SESSION_ENDED（Claude フック自動発火）に変更。Conductor クラッシュ時のゴーストエントリを防止

### Fixed
- SESSION_ACTIVE/SESSION_IDLE イベント受信時に disconnected 状態の Conductor が復帰しない問題を修正。セッションが生存しているのにタスク割り当てされない状態を解消

## [3.13.1] - 2026-04-03

### Fixed
- auto-restart 時の Conductor 発見をマーカーファイル方式に変更。タブ名ベースの検出は using-cmux の hook によるタブ名上書きで機能しなかった問題を修正

## [3.13.0] - 2026-04-03

### Changed
- Conductor の識別子を固定名 (conductor-slot-N) から surface ID に変更。auto-restart 時に旧セッションのイベントが新 Conductor に誤適用される問題を根本解決
- auto-restart 時の Conductor 発見を team.json ベースから cmux tree ベースに変更。同一 workspace 内の既存 Conductor を自動再利用し、surface の無限増殖を防止
- team.json のアトミック書き込み (tmp → rename) で、restart 時のファイル破損を防止
- CLI の `--conductor-id` オプションを `--conductor-surface` に変更

### Fixed
- Journal タブのエントリを新しい順（逆順）で表示するように修正

## [3.12.1] - 2026-04-03

### Fixed
- SESSION_ENDED 受信時に Conductor を即座に disconnected 状態にし、再接続の無限リトライを防止

## [3.12.0] - 2026-04-02

### Added
- Artifacts 機能: 調査結果・設計判断・セッション要約を `.team/artifacts/` に記録・管理する仕組みを追加
- `/artifact` コマンドで会話コンテキストからアーティファクトを生成・一覧・表示
- `cmux-team artifacts` CLI サブコマンド（list / show / create）
- Manager TUI に Artifacts タブを追加。一覧表示・詳細プレビュー・キーボードナビゲーション対応

### Fixed
- `spawn-agent` が `CMUX_SURFACE` 環境変数から pane を自動解決するように修正

## [3.11.0] - 2026-04-02

### Added
- TUI のタスクタイトル内の GitHub issue 番号（`#xxx`）を OSC 8 ハイパーリンクとして表示。クリックでブラウザが開く
- Agent の `session_id` を `AgentState` に記録し、`team.json` や `agents` サブコマンドで参照可能に (#16)

### Changed
- タスク番号の表記を `#xxx` から `Txxx` に変更。`#xxx` は GitHub issue 専用に

## [3.10.0] - 2026-04-02

### Changed
- Conductor 起動を並列化し、チーム立ち上げ時間を短縮
- Trust 確認の待機処理（waitForTrust）を廃止。Conductor hooks による自動承認に統一

## [3.9.2] - 2026-03-31

### Fixed
- Stop hook が毎ターンの応答完了で `SESSION_ENDED` を送信し、Conductor が応答するたびに disconnected 扱いになるバグを修正。`SESSION_IDLE`（応答完了）と `SESSION_ENDED`（セッション終了）を分離
- タスク完了検出の `doneCandidate` 二重確認ロジックを廃止。最大20秒の完了検出遅延を解消

## [3.9.1] - 2026-04-01

### Added
- TUI で `Q`（Shift+Q）によるフルシャットダウン機能。全 Agent → Conductor → Master の surface を close し、worktree をクリーンアップしてから daemon を終了。Y/N 確認ダイアログ付き

## [3.9.0] - 2026-04-01

### Added
- Conductor ライフサイクル監視: Claude Code の SessionStart/Stop hooks と PID ウォッチャーにより、Conductor の起動・停止・切断を約1秒以内に検知
- `disconnected` 状態: Claude Code が終了した Conductor をダッシュボードで可視化（⚠ アイコン）
- `restart-conductor` / `reset-conductor` コマンド: 切断した Conductor の手動復旧が可能に
- `update-task --body` / `--title`: draft/ready 状態のタスク内容を CLI から更新可能に

### Changed
- 配布版 SKILL.md を 593行から 147行に最小化。Manager/Conductor/Agent の内部プロトコルを CLAUDE.md に移動し、Master が不要な情報を持たない設計に
- Conductor テンプレートにブートストラップ手順と Agent 起動ルールを追加
- cmux-agent-role SKILL.md からタスクファイルフォーマット例を削除し CLI 使用のみに

### Fixed
- `update-task` にステータス遷移ガードを追加。assigned/closed 状態のタスク変更を拒否し、実行中タスクの意図しない上書きを防止
- `close-task` に assigned ガードを追加（`--force` で強制可能）
- Master テンプレートで `.team/tasks/` への直接書き込みを明示的に禁止

## [3.8.1] - 2026-03-31

### Fixed
- Conductor 起動時に `CONDUCTOR_ID` 環境変数が未設定だった問題を修正。Agent spawn 時に team.json から paneId を取得できず、タブではなく split で作成されていた

## [3.8.0] - 2026-03-31

### Added
- daemon 稼働中の npm auto-update 機能。5分間隔で npm registry から最新バージョンを確認し、新バージョンがあれば自動インストール + 再起動する

## [3.7.1] - 2026-03-30

### Fixed
- Conductor のタスク完了検出を run ベースの done マーカーから task ベースの status.json に変更し、完了判定の信頼性を改善
- ロギングプロキシの `Bun.serve()` を `development: false` に設定し、stdout へのログ出力が TUI ダッシュボードに重なる問題を修正

## [3.7.0] - 2026-03-30

### Added
- ファイルシステム監視（fs.watch）による即時タスク検出。`.team/tasks/` や `.team/queue/` への変更をポーリング間隔を待たずに即座に処理
- ロギングプロキシの再利用機能。既存プロキシが生存していれば新規起動をスキップし、daemon 再起動時のポート競合を回避

### Changed
- ダッシュボードのレイアウトを簡素化（ヘッダー統合、セクションタイトルのスリム化）
- ダッシュボード更新処理に lifecycle error ハンドリングを追加し、高速更新時のクラッシュを防止
- Manager タブタイトルに surface 番号を付与（`[N] Manager` 形式）
- `spawn-agent` の `--task-title` 省略時に Conductor のタスクタイトルをフォールバック

## [3.6.1] - 2026-03-30

### Changed
- Master/Conductor の起動を `cmux-team conductor <id>` / `cmux-team spawn-master` CLI ラッパー経由に変更。起動時に `.team/proxy-port` から proxy ポートを動的に解決するため、Manager 再起動時に既存セッションの API 接続が切れる問題を解消
- Ink 版ダッシュボードを廃止し Rezi 版に一本化

## [3.6.0] - 2026-03-30

### Added
- Rezi TUI ダッシュボードにカラー表示を追加。Conductor ステータス・タスク状態・ジャーナルアイコンを色分け表示（Ink 版と同等）

### Fixed
- Rezi TUI の `executionMode: "inline"` 未指定による TTY エラーを修正
- Rezi TUI Journal/Log タブのコンテンツが表示されない問題を修正

## [3.5.0] - 2026-03-30

### Added
- Rezi TUI ダッシュボード: マウス対応の新 TUI フレームワーク (Rezi) によるダッシュボードを追加。タブのクリック切替、タスク一覧・ジャーナル・ログのマウスホイールスクロールに対応
- Manager daemon 起動時にタブタイトルを自動設定

### Changed
- TUI のデフォルトレンダラーを Ink から Rezi に切り替え（既存の Ink 版はフォールバック用に保持）

## [3.4.2] - 2026-03-29

### Fixed
- TUI ダッシュボード全セクション（Tasks, Conductors, Journal, Log）の幅計算を `stringWidth` ベースに統一。日本語タイトルや ●/○ マーカーの表示幅ずれによる行折り返しを解消
- TUI 行幅ユニットテストを追加（日本語タイトル・長いタイトル・全角マーカーの幅検証）

## [3.4.1] - 2026-03-29

### Changed
- トレーサビリティ基盤（trace CLI, SQLite FTS5, メタデータ伝播）のドキュメントを SKILL.md, CLAUDE.md, README に追加

## [3.4.0] - 2026-03-29

### Added
- トレーサビリティ基盤: Proxy が API リクエスト/レスポンス本文を SQLite に記録。`cmux-team trace` CLI でセッション横断検索（FTS5 全文検索対応）
- Conductor/Master からのリクエストにメタデータ（conductor-id, task-id, role 等）を自動伝播

## [3.3.0] - 2026-03-29

### Added
- daemon の auto-restart 機能: ソースコードが更新されると Conductor を維持したまま daemon プロセスだけ自動再起動する。tick ループ内で mtime を監視し、変更検出時に exit code 42 で再起動

### Changed
- release コマンドの npm publish を別 surface で実行するよう変更（OTP ブラウザ認証対応）

## [3.2.0] - 2026-03-29

### Added
- 起動時の進捗を標準出力に表示（daemon 起動・Conductor 作成・Master spawn の各ステップ）

### Changed
- CLI 移行に伴い旧スラッシュコマンド 9 個を削除（start, team-research, team-design, team-impl, team-review, team-test, team-status, team-disband, team-sync-docs）。残存コマンドは master, team-spec, team-task, team-archive の 4 個
- README, CLAUDE.md, CONTRIBUTING.md, SKILL.md の参照を CLI ベースに統一

### Fixed
- `cmux-team status` の Tasks カウントがアーカイブ済みタスクにより負値になるバグを修正
- TUI ダッシュボードで日本語タイトルが折り返されて表示が崩れる問題を修正（string-width による表示幅ベースの切り詰めに変更）

## [3.1.0] - 2026-03-29

### Added
- Agent の状態判定を `cmux read-screen` パターンマッチから `cmux list-status` API に移行し、信頼性を大幅に向上

### Fixed
- TUI ダッシュボードで running 状態の Conductor/Task 行の●マーカー後にスペースが欠落する表示バグを修正

## [3.0.3] - 2026-03-29

### Fixed
- daemon 再起動時に Conductor スロットが作成されない問題を修正（daemon 自身の surface を生きた Conductor と誤認していた）
- 全テンプレート・コマンドの CLI パスを `cmux-team` に統一（`bun run .team/manager/main.ts` や `bun run main.ts` の残存参照を除去）
- `validate-surface.sh` 参照をインラインの `cmux tree` チェックに置換

### Changed
- 旧スクリプト `spawn-conductor.sh`, `validate-surface.sh` を削除（TypeScript daemon に移行済み）
- daemon が不要な `.team/scripts/` ディレクトリを作成しなくなった

## [3.0.2] - 2026-03-29

### Fixed
- `cmux-team` コマンド実行時に `Cannot find module './dashboard'` エラーが発生する問題を修正（`.tsx` ファイルがパッケージに含まれていなかった）

### Changed
- 不要な `spawn-team.sh` を削除（CLI に統合済み）

## [3.0.1] - 2026-03-29

### Fixed
- postinstall で Claude Code plugin を自動インストール（手動実行の案内を廃止）
- `npm pkg fix` による bin パスと repository URL の正規化

## [3.0.0] - 2026-03-29

### Added
- npm パッケージとして配布開始 — `npm install -g @hummer98/cmux-team` でインストール可能に
- `cmux-team` CLI コマンド — シェルから直接 `cmux-team start` で daemon を起動
- `spawn-agent` に `--pane` オプション追加 — Conductor が自分の pane を直接指定し、Agent をタブとして確実に起動
- TUI ダッシュボードの Agent 欄に taskTitle を表示 — role のみだった表示にタスク名を追加

### Changed
- パッケージ名を `@hummer98/cmux-team` にスコープ変更
- `install.sh` と plugin cache フォールバックを削除（npm 配布に一本化）
- `prepublishOnly` スクリプト追加（publish 前にテスト実行）
- テストファイル (`*.test.ts`) を npm パッケージから除外

### Fixed
- 仕様書（docs/seeds/ + .team/specs/）を現状の実装に同期

## [2.19.0] - 2026-03-29

### Added
- タスク定義と状態の分離 — `tasks/` をフラット構造に変更し、`task-state.json` で状態を管理

### Fixed
- TUI ダッシュボード: `Sep` を `Box` でラップし全セクションの1行目空白バグを修正
- TUI ダッシュボード: Journal/Log のスペーストリム問題を修正
- `main.ts` / `proxy.test.ts` / `proxy.ts` の TypeScript コンパイルエラー修正
- `initInfra` の `.gitignore` テンプレートに `task-state.json` を追加
- テンプレート・コマンド・スクリプト・テストの `tasks/open`, `tasks/closed` 参照をフラット構造に更新
- `.claude/worktrees/` を git 管理外に変更

## [2.18.1] - 2026-03-29

### Fixed
- spawn-agent でプロキシの生存確認を行い、プロキシが死んでいる場合は `ANTHROPIC_BASE_URL` を設定せず直接 API 接続にフォールバック
- `.team/tasks/` を git 管理外にし、worktree マージ時にタスク状態が巻き戻る問題を防止

## [2.18.0] - 2026-03-29

### Added
- Conductor 起動時に `--append-system-prompt-file` でロール定義をシステムプロンプトに永続化。`/clear` 後もロール定義が維持される

### Fixed
- Conductor スロット初期化時のプロンプトを明確化。曖昧な待機指示により Conductor が自主的にタスクを検索・実行してしまう問題を防止

## [2.17.0] - 2026-03-29

### Added
- TODO メッセージを廃止し `create-task --status ready` に一本化。軽微な作業もタスクとして追跡可能に

### Fixed
- Agent 起動時の `--bare` フラグを除去。`--bare` が OAuth 認証をスキップし Claude Max 環境で API Usage Billing にフォールバックする問題を修正
- TUI ダッシュボードの Tasks セクションで open タスクが表示されない問題を修正。open タスクを優先表示し、残り枠で直近の closed タスクを表示するよう変更
- TUI ダッシュボードで長文タイトルが改行を引き起こしレイアウトが崩れる問題を修正

## [2.16.0] - 2026-03-29

### Added
- Conductor テンプレートに TaskCreate/TaskUpdate によるサブタスク管理を追加。Agent の起動・完了をタスクとして追跡可能に
- Master 起動時に `--append-system-prompt-file` でロール定義をシステムプロンプトに永続化

### Fixed
- Conductor 完了判定を done マーカーファイルのみに変更。interrupt 後に誤って done と判定される問題を修正

## [2.15.1] - 2026-03-29

### Fixed
- SKILL.md の Agent 起動手順を spawn-agent CLI に統一。旧手順（cmux new-surface で直接起動）が残っており、Conductor がプロキシ設定なしで Agent を起動してしまう問題を修正

## [2.15.0] - 2026-03-29

### Changed
- Conductor の Map キーを固定スロット ID（conductor-slot-1/2/3）に変更。タスク割り当てごとに ID が変わり Map エントリが重複蓄積する問題を解消
- 起動時の surface 分割順序を修正。全 split で daemon surface を明示指定し、フォーカス状態に依存しないレイアウト構築に変更
- 手動コマンド（/team-impl 等）から team.json 直接操作を削除し、daemon 管理に統一
- SKILL.md を TypeScript daemon ベースのアーキテクチャに合わせて全面更新

### Fixed
- daemon リロード時にプロキシポートを再利用。既存 Conductor の ANTHROPIC_BASE_URL が旧ポートのままハングする問題を修正

## [2.14.0] - 2026-03-29

### Added
- spawn-agent に `--prompt-file` オプションと `--bare` モードを追加。Agent 起動時のコンテキスト溢れを防止

### Fixed
- Conductor/Agent 起動時の環境変数が子プロセスに継承されず、Agent が API 認証エラー（Not logged in）になる問題を修正

## [2.13.0] - 2026-03-29

### Added
- デバッグ用 HTTP API: プロキシサーバーに `/state`, `/tasks`, `/conductors` エンドポイントを追加。Manager 内部状態を外部から JSON で取得可能に
- Surface 管理を固定 2x2 レイアウト + タブベースサブエージェントに再設計

### Fixed
- spawn-agent で Agent が worktree ではなくメインリポジトリで作業してしまう問題を修正
- TUI の Conductors/Tasks セクションで1行目が表示されないバグを修正
- YAML frontmatter パースで title のダブルクォートが除去されない問題を修正
- Conductor テンプレート変更に合わせて template.ts の正規表現を更新

## [2.12.0] - 2026-03-28

### Added
- CLI `create-task` コマンド: ID 自動採番・タスクファイル生成・Manager 通知を一括実行
- 完了 Conductor を TUI に表示継続: surface 消失時に自動削除
- Conductor タブ名にタスク番号を追加

### Changed
- worktree 削除を daemon から Conductor の責務に移譲

### Fixed
- closed タスク ID のゼロパディング不一致を修正
- ジャーナルから daemon_reload イベントを除外（ログタブのみに表示）
- TUI Tasks の表示改善: ソート順、色分け、完了時刻表示、ゼロパディング統一
- Conductor 完了判定を2回連続 done で確定に変更（誤検知防止）

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
