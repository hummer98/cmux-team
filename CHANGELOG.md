# Changelog

## [3.48.0] - 2026-04-15

### Changed (Breaking — soft)
- **`conductor-settings.json` を共通ファイル 1 個に集約（T206）**。これまで Conductor surface ごとに `.team/prompts/surface:NNN-settings.json` を生成していたが、ファイル内容は surface 独立であることが判明したため `.team/prompts/conductor-settings.json` 1 個に統合した。**既存の起動中 Conductor は古いファイルパスを `--settings` 引数として参照しているため、本バージョンに上げる場合は `cmux-team start` を full quit → restart する必要がある**。`/clear` だけでは復旧しない

### Changed
- **`cmux-team conductor` / `cmux-team resume` から `CMUX_SURFACE` 環境変数必須を撤廃（T206）**。env が未設定の場合は `cmux identify` の `caller.surface_ref` から自動解決する。手動デバッグ目的で `cmux-team conductor` を直接叩く運用が可能になった
- **`--surface` CLI オプションが UUID 形式も受け付けるようになった（T206）**。`cmux send` / `cmux send-key` と同様、`surface:NNN` ref と UUID の両形式を受け付ける。内部で `cmux --id-format both --json tree` 経由で正規化される。対象: `send` / `send-agent` / `spawn-agent` / `await-agent` / `kill-agent`。`send --from-stdin`（hook 経由）は ref 契約のため正規化対象外

### Removed
- 旧 `.team/prompts/surface:NNN-settings.json` ファイルは `cmux-team start` が再生成しなくなる（既存ファイルは手動削除推奨だが、放置しても害はない）

## [3.47.1] - 2026-04-15

### Fixed
- **Manager daemon 再起動時に死亡 Conductor で `disconnected` 状態が固着する問題を修正**。restart 時に存在しない Conductor surface をそのまま復元していたため、生存確認が通らず `disconnected` でタスク割当不能のままスタックしていた。起動時にスキップして idle に戻すよう修正

## [3.47.0] - 2026-04-15

### Added
- **Artifact 登録コマンドを move ベースに変更、Researcher ロールを新設（T198）**。`cmux-team artifacts add` がファイルを `.team/artifacts/` 配下に物理移動する挙動に統一され、外部パス（Conductor/Agent の出力ディレクトリ配下など）から直接 artifact 化できるようになった。併せて調査系タスク向けの Researcher サブエージェントロールを templates に追加し、ja/en テンプレートを同期
- **touched-files zero-errors ルールを inspector / implementer / planner に追加（T197）**。タスクで触れた全ファイルがタスク完了時点で型エラー / lint エラー / テスト失敗をゼロにする要件を 3 ロールのテンプレートに明文化

### Changed (Breaking)
- **Manager の Conductor/Agent/Master 生存監視を PID ベースに全面移行（T195）**。`cmux tree` / `cmux list-status` を使った周期ポーリングを廃止し、SessionStart hook が送る `SESSION_STARTED`（`--pid` 付き）で Manager が PID を受け取り、`spawnPidWatcher` / `spawnAgentPidWatcher` / `spawnMasterPidWatcher` が 1 秒間隔で `process.kill(pid, 0)`（`cmux.isAlive(pid)`）を呼んで生死判定する。cmux 側の SwiftUI メインスレッドデッドロック（A011）で Manager daemon がハングする問題を根治する
- **Agent 起動時に `SessionStart` hook を追加**。`.claude/settings.json` の `SessionStart` に `cmux-team send SESSION_STARTED --pid "$PPID" --surface "$CMUX_SURFACE" --conductor-surface "$CMUX_CONDUCTOR_SURFACE" --role "$CMUX_ROLE"` を登録し、Agent 側も PID が Manager に伝わるようにした。Conductor/Agent の `team.json` に `pid` フィールドが永続化され、`cmux-team resume` 時に復元される
- **`isMasterAlive(state)` のシグネチャ変更**。以前は `workspace` を受けて `cmux tree` を叩いていたが、今は `state.masterPid` を `process.kill` するだけ。`validateSurface` も cmux.ts から削除（呼び出し箇所なし）
- **PID 再利用に関する注意**。PID は OS が再利用する可能性があるため、SessionEnd hook による明示的な `SESSION_ENDED` 通知を優先する。pidWatcher はあくまで hook が来なかった場合のフォールバック扱い
- **削除ログイベント**: `tree_failed` / `list_status_failed` / `surface_validation_failed`（新イベント: `pid_watcher_started` / `session_ended`（`reason=pid_watcher`））

### Changed
- **Conductor テンプレート書き換え**。`skills/cmux-team/templates/ja/conductor.md` / `en/conductor.md` の Agent 監視ループから `cmux list-status` 参照を削除し、`cmux-team await-agent` の exit code（0=completed/ask, 10=crashed, 2=timeout）を case 分岐で扱う手順に差し替えた
- **ドキュメント同期**。`CLAUDE.md` / `skills/cmux-team/SKILL.md` / `docs/spec/01-skill-cmux-team.md` / `docs/spec/04-templates.md` / `.team/specs/requirements.md` から `cmux list-status` 参照を削除し、`cmux tree` の用途を「init 時の pane 逆引きのみ」と明記

### Fixed
- **`findTemplateDir` の探索順を project-local 優先に反転（T200）**。npm でグローバルインストールされた templates が project-local のテンプレート編集を上書きしてしまう問題を修正。これにより `skills/cmux-team/templates/` 配下の編集を再インストールなしで即反映できる
- **dashboard Journal panel の surface 表記を修正（T196）**。`surface:NNN` の `surface:` prefix を strip して `[NNN]` の統一フォーマットで表示するよう修正

## [3.46.0] - 2026-04-15

### Added
- **Agent の完了検出を await-agent 方式に刷新（T181）**。Conductor の 30 秒ポーリング（`cmux read-screen`）を廃止し、Agent の Stop/SessionEnd hook が done マーカーを書き出し、Conductor 側は `cmux-team await-agent` が `fs.watch` で即時検知する pull 型構造に移行。TOCTOU 対策として watcher を先に起動し、`startedAt` 比較で古い done マーカーを無視する
- **AskUserQuestion の構造的検出（T181）**。Agent のトランスクリプト JSONL から AskUserQuestion を検出し、Agent タスクでは Conductor が自律回答、Conductor タスクでは TUI に `status=asking` バッジを表示してユーザー介入を待つ。`schema.ts` に `SessionAskMessage` / `ConductorState.askQuestion` を追加
- **Stop hook の分類ロジックを Manager 側に移行（T189）**。shell 側の detect-ask スクリプトを 70 行→23 行の forwarder に縮退し、ASK/IDLE/SKIP の判定は daemon の純粋関数 `classifyStopPayload()` が担当する（unit test 15 件）。preflight に `jq` 必須化を追加（python3 fallback を撤去）
- **logger の surface 表記を簡略化（T192）**。`formatSurface()` / `formatPair()` ヘルパーを追加し、`surface:NNN` 生表記を `C[665]` / `A[719]` / `C[665]>A[719]` のようなロール別プレフィックス形式に統一。`daemon_started` ログ先頭に `package.json` から読んだバージョンを付加
- **タブ名をロールのみに固定（T193）**。従来のタスク進捗を混ぜた動的タブ名を廃止し、`[N] Master` / `[N] Manager` / `[N] Conductor` / `[N] Agent` の 4 種類だけに正規化。タスク状態は dashboard / team.json / statusline / log で可視化する

### Changed
- **Conductor の初期プロンプトを廃止（T193）**。Conductor ペインは ❯ idle 状態で起動し、タスク割当時にだけプロンプトを push するようになった。起動直後に 1 通のチャットメッセージが消費されなくなり、`/clear` なしで 1 ターン分のコンテキストを節約できる。`i18n.ts` から未使用の `conductor_wait_prompt` を削除
- **ドキュメント同期（T191）**。CLI 一覧を `cmux-team --help` と同期（`await-agent` / `await-task` / `self-update` / `trace-task` を追加、旧 trace 系を削除）し、T181 の await-agent 方式、T187 の autoUpdate 3 モード、レイアウト戦略 wide / 16x9、コマンド一覧（/master, /team-spec, /team-task, /team-archive, /artifact, /docs-sync, /trace-task）を `docs/spec/` と README 両版に反映。`docs/spec/06-implementation-tasks.md` に Phase 10（T180-T190）を追加

### Fixed
- **既知の tsc エラー 6 件を解消（T190）**。T181 で顕在化した型エラーを実行時挙動を変えずに解消: `cmux.ts` の execFile 戻り値を destructure + `.toString()` で string に正規化、`@types/update-notifier` を devDependencies に追加（T187 で入れ忘れ）、`dashboard.tsx` の無効な `dsVariant: "unstyled"` を削除（2 箇所）、`main.test.ts` の RegExp capture を non-null 断言、`main.ts` の `state.workspace` を `?? undefined` で変換

## [3.45.0] - 2026-04-14

### Changed (Breaking)
- **auto-update を `update-notifier` ベースの 3 モード（`off | notify | task`）に再設計（T187）**。daemon 自身は install しなくなり、`task` モードでは `--run-after-all` の update タスク（frontmatter `kind: cmux-team-update`）を自動起票して Conductor に install を委ねる。検出間隔は 12h 固定。`NO_UPDATE_NOTIFIER=1` で無効化可能。`cmux-team self-update` サブコマンドを追加（手動起票）
- **config `autoUpdate: true` の意味が「install 実行」から「update タスク起票」に変わる**（T186 から T187 への移行時に注意）。`true` → `task`、`false` → `off` と内部で正規化
- **起動時ログのフォーマット変更**: `auto_update_config enabled=<bool> source=<src>` → `auto_update_config mode=<mode> source=<src>`
- **削除ログイベント**: `npm_auto_update` / `npm_update_check_failed` / `npm_self_update_completed`（新イベント: `update_check_started` / `update_available` / `update_task_created` / `update_task_skipped_*` / `update_check_failed`）

### Added
- `update-notifier@^7.0.0` 依存追加（Bun 動作確認済み）
- `dashboard.tsx` に update 通知バナー（黄色、ヘッダ直下）を追加。`notify` モードでは `cmux-team self-update` 誘導文言、`task` モードでは起票済み task ID を表示
- `schema.ts` に `AutoUpdateMode` enum + `normalizeAutoUpdate()` ヘルパー
- `task.ts` に `createTaskProgrammatic()` を新設（cmdCreateTask と daemon 内部起票の共通化）
- `cmux-team --version` / `-v` フラグを追加。`package.json` のバージョンを出力して即終了する（T185）
- `eventBus.ts` に `notifyStateChanged` / `onStateChanged` の名前付きラッパーを集約し、Conductor の status 変更・daemon の tick/monitor/scan 結果・dashboard の再描画購読を接続。tick 待ちなしで TUI が即時反映される。`CMUX_TEAM_TRACE_EVENTS=1` で `event_emit` ログが `manager.log` に出力される（T184）
- `update-task` 等の全更新経路から `TASK_UPDATED` を emit し TUI が即時反映されるよう統一（T183）

## [3.44.1] - 2026-04-14

### Changed
- `/release` コマンドを Master 自身が実行する方式から `--run-after-all` タスクとして起票する方式に変更。全オープンタスクの完了を待って Conductor がリリース作業を実行する運用に統一
- 仕様書 (`docs/spec/`) を v3.39〜v3.43 の実装状況に同期。Phase 9 運用強化セクション（CLI 拡張、i18n テンプレート、レート制限スロットル、conductor 制御 hook 等）を追加
- `.claude/scheduled_tasks.lock` を `.gitignore` に追加（ローカル固有のランタイム状態のため追跡対象外）

### Fixed
- cmux daemon 高負荷で `cmux tree` が一時的にタイムアウトした際、Manager が Conductor を crash と誤判定し稼働中タスクが abort される問題を修正。タイムアウトは `unknown` 状態として扱い、連続失敗が閾値を超えた場合のみ `cmux_unresponsive` で disconnected 化する。環境変数 `CMUX_TEAM_UNRESPONSIVE_MAX_TICKS` (default 6) / `CMUX_TEAM_UNRESPONSIVE_MAX_SEC` (default 120) で調整可能

## [3.44.0] - 2026-04-14

### Added
- `--layout=16x9` レイアウトモードを追加。上段フル幅（Manager|Master タブ）+ 下段 2 分割（Conductor x2）で 16:9 ディスプレイに最適化。`.team/config.json` の `layout` フィールドでも指定可能。`CMUX_TEAM_MAX_CONDUCTORS` が 2 超の場合は警告ログ出力で 2 にクランプ

### Changed
- macOS スリープ抑止（`caffeinate`）を daemon ライフタイム常時ではなくアクティブなタスク実行中のみ有効化。アイドル時はスリープを許可しバッテリー消費を抑制

### Fixed
- `logger.ts` の `PROJECT_ROOT` がモジュール読み込み時に一度だけ評価されていたため、テストが本番のログディレクトリにログを書き込んでしまう問題を修正。呼び出しごとに遅延評価するよう変更し、回帰テストを追加

## [3.43.0] - 2026-04-12

### Added
- `cmux-team send-agent --surface <agent-surface> <message>` を追加。Conductor が自分で spawn した Agent にだけメッセージを送れる正規ルート。`.team/team.json` で呼び出し元との関係を検証し、自己送信・他 Conductor・他 Conductor の Agent は reject する。`spawn-agent` 直後の反映ラグに備えて `agent_not_found` の場合のみ 200ms × 最大 5 回リトライ (#21, #22)
- Conductor に PreToolUse hook を追加。Bash tool 経由の `cmux send` / `cmux send-key` を実行時にブロックし、stderr に代替コマンド (`cmux-team send-agent`) を案内する（既存 Conductor は `cmux-team stop` → `start` で再起動すると反映される）(#21)
- スロットル中のサブ Agent 起動を抑制する仕組みを追加。proxy に `/rate-limit` API を設け、throttle 検出時は `cmux-team spawn-agent` が exit 75 で終了し Conductor 側でリトライする流れに統一

### Changed
- `conductor-role.md`（ja/en）の他 surface 直接操作禁止の記述を強化し、API エラー等で停止した Agent の回復手順として `cmux-team send-agent` の使用例を追記
- 調査系タスクの完了時に summary.md を artifact として自動保存するステップを `conductor-role.md` に追記

### Fixed
- daemon 再起動時に assigned タスクの `cmux-team resume` コマンドが Conductor ペインのシェルではなく既に起動済みの Claude Code のチャット入力として送信され、セッション再開が行われない問題を修正

## [3.42.0] - 2026-04-12

### Added
- プロジェクト内専用の開発者スキル `cmux-team-investigate` を追加。別プロジェクト (mado, Dear 等) の `.team/` 調査フローを定義（配布対象外）
- 初回起動時に `.envrc` へ `CMUX_CLAUDE_HOOKS_DISABLED=1` の追記を対話提案。追記後は `direnv allow` + 再起動を案内するメッセージを表示
- `initInfra` 時に `.gitignore` / `config.json` / `team.json` の自動生成をログへ記録し追跡可能に
- `execFile` エラー時に `stderr` / `stdout` をログへ含めるユーティリティ (`exec-error.ts`) を追加し、cmux 呼び出し経路の障害原因を追跡可能に

### Changed
- ロギングポリシーに「外部コマンド失敗時は stderr/stdout 同梱必須」ルールを追記
- `conductor-role.md` に他 Conductor surface の直接操作禁止ルールを追記
- `/release` 手順 4 に `marketplace.json` のバージョン更新ステップを追加
- `cmux-team-investigate` スキルの trace DB 参照手順を現行実装に同期

### Fixed
- Bun.serve の idleTimeout が未設定 (デフォルト 10s) のため Claude API の長時間 SSE ストリーム (拡張思考等) が途中で切れ "socket connection was closed unexpectedly" が発生する問題を修正。最大値 255s まで延長
- ダッシュボードの `THROTTLED` 表示が重複していた問題を修正し、点滅表示に変更
- ダッシュボードでタブ軸キー操作時に `activeTab` と `focusedArea` が同期されず表示が崩れる問題を修正
- `marketplace.json` のバージョンが実装と乖離していた問題を修正し同期

## [3.41.0] - 2026-04-12

### Added
- `cmux-team await-task --task-id <id>` コマンドを追加。タスク完了をノンブロッキングで待機し、完了時に summary を stdout に出力
- エージェントプロンプトテンプレートの i18n 対応。`templates/ja/` と `templates/en/` にディレクトリ分離し、ロケールに応じて自動選択
- `cmux-team start` 時に `.team/.gitignore` を自動生成。セッション固有ファイルを除外し追跡対象を明確化

### Changed
- Master statusline のコスト表示を open タスク数表示に置換（サブスクでは従量コスト不要）
- mo ビューアで同一ワークスペース内の既存ブラウザを再利用。新規 split を作らず `goto` でナビゲート

### Fixed
- mo ビューアでファイル固有 URL（`?file=<id>`）を使い、対象ファイルに直接フォーカスするよう修正

## [3.40.0] - 2026-04-11

### Added
- ロール別カスタムステータスバーの実装。Conductor・Agent がそれぞれの役割に応じたステータス表示を行う
- Conductor 完了時にセッション上へ要約レポートを自動表示
- TUI を停止せず `mo` + `cmux browser open` で Markdown を表示する方式に変更

### Changed
- Conductor 起動関数を統合し session-id を自己生成方式に変更
- Conductor の slot-id 引数を廃止し `CMUX_SURFACE` 環境変数に統一

### Fixed
- `cmux-team stop` 時に assigned タスクの worktree まで削除してしまい、再起動時の resume が失敗する問題を修正。worktree クリーンアップを full_quit から撤廃
- resume 失敗時のログに worktreePath・sessionId 等の詳細情報を追加
- worktree 作成時に baseBranch を start-point として使用するよう修正

## [3.39.1] - 2026-04-11

### Changed
- Conductor の hooks から cmux 自動通知（`cmux claude-hook notification/stop/session-start` 等）を全削除。通知制御は Manager 側で行う方針に統一

## [3.39.0] - 2026-04-11

### Added
- `cmux-team trace-task <task-id>` CLI コマンドを追加。タスクに関連する全セッション情報（Conductor・Agent）を一覧表示
- `cmux-team-guide` スキルを追加。配布先でも cmux-team の機能・使い方・仕様に関する質問に回答可能に
- TUI Tasks パネルで Enter キーを押すと task.md を Markdown ビューアで閲覧可能に

### Changed
- trace DB を HTTP リクエストログから タスク-セッション索引に再設計。タスクごとの全セッション（Conductor・Agent）を追跡可能に
- `docs/spec/` を v3.35〜v3.38 の実装変更に同期

## [3.38.0] - 2026-04-11

### Added
- `artifacts open` サブコマンドを追加。アーティファクトを Markdown ビューア（`mo`）で表示可能に。環境変数 `CMUX_TEAM_MD_VIEWER` でビューアをカスタマイズ可能

### Fixed
- Master spawn 時に `CMUX_CLAUDE_HOOKS_DISABLED=1` が未設定のため cmux 通知が大量発生する問題を修正
- running 状態の Conductor に手動 `/clear` を送信してもステータスがリセットされない問題を修正。abort + idle リセットが正しく動作するように
- `resume` で実行中タスクの多重起動を防止

## [3.37.0] - 2026-04-11

### Added
- Manager daemon がサイドバーステータス（idle / running / error 等6状態）をリアルタイム更新

### Fixed
- タスク割り当て時に Conductor セッションが `/exit` で毎回破棄される問題を修正。`/clear` 方式に戻し、常駐セッションを維持するように変更
- session-id を初回起動時に発行し、Conductor のライフタイム中維持するように修正

## [3.36.0] - 2026-04-11

### Added
- Conductor 起動時に `--session-id` を指定してセッションを resume 可能に
- `update-task` に `--depends-on` オプションを追加し、タスク間の依存関係を設定可能に
- `artifacts add` コマンドを追加。既存ファイルをファイル名指定でアーティファクトとして登録可能に
- `cmux-team start` 時にワークスペース名を起動フォルダ名に自動設定
- `cmux-team resume` で restart 時に Conductor セッションを resume で再開

### Changed
- 5h レート制限のスロットリング閾値を 95% から 90% に変更し、より早い段階で新規タスク割り当てを一時停止
- Conductor/Agent spawn 時に `CMUX_CLAUDE_HOOKS_DISABLED=1` を設定し、hooks による干渉を防止

## [3.35.0] - 2026-04-10

### Added
- `restart-task` サブコマンドを追加。実行中タスクの中止＋再キューを1コマンドで実行可能に (T124)
- worktree 作成時に `source_up` の `.envrc` を自動生成し、親ディレクトリの OAuth トークンを継承 (T127)

### Changed
- `spawn-conductor` から split を除去。現在の surface で直接 Conductor を起動するように変更。`--surface`/`--direction` 引数を削除 (T125, T126)

## [3.34.1] - 2026-04-10

### Fixed
- spawn-agent で worktree に cd した後に `direnv allow` が実行されず、Agent が OAuth トークンを引き継げない問題を修正 (T123)

## [3.34.0] - 2026-04-10

### Changed
- Agent/Conductor 起動時の環境変数をワンライナー export からシェルへの焼き付け方式に変更。プロセス死亡時も環境変数が維持される (T122)
- worktree 作成後に `direnv allow` を自動実行し、`.envrc` の OAuth トークンが worktree 内でも自動的に利用可能に (T122)

## [3.33.0] - 2026-04-10

### Added
- タスク作成後の即時反応: `create-task --status ready` 実行時に daemon が次の tick を待たず即座にタスクを検出・割り当て開始 (T120)
- ダッシュボードのレート制限表示にリセットまでの残り時間を追加（`5h: 42% ████░░░░░░ 1h23m` 形式）

### Changed
- ダッシュボードヘッダーから PID 表示を削除し、表示をシンプル化

### Fixed
- Conductor がサブエージェント完了待ちの間に TUI 上 idle と誤表示されるバグを修正。`validateSurface` に 3 回リトライを追加し、一時的な `cmux tree` 失敗による crashed 誤検出を防止 (T121)
- crashed 判定時の遷移を即 idle → disconnected に変更し、5 分の猶予期間で自動復帰を可能に (T121)
- crashed 処理の cleanup 漏れ修正: `taskRunId` / `taskTitle` / `agents` が残る問題を解消 (T121)

## [3.32.0] - 2026-04-10

### Added
- i18n 対応: `CMUX_TEAM_LANG` > `LC_ALL` > `LC_MESSAGES` > `LANG` の優先順でロケールを検出し、CLI メッセージ・help テキストを EN/JA で自動切り替え
- `cmux-team start` に preflight チェックを追加。git リポジトリ確認、claude/bun コマンド存在確認、書込権限検証を一括実施し、失敗項目をまとめて表示

### Changed
- `assignTask` のエラー影響範囲を分離。worktree 作成失敗などの task 起因エラーでは Conductor を idle のまま維持し、cmux 送信失敗などの conductor 起因エラーのみ disconnected 扱いに変更 (T117)
- `docs/spec/` を T082〜T116 の実装変更に同期（delete-task/abort-task Journal、4 フェーズフロー、proxy/trace 現状化ほか） (T118)

## [3.31.0] - 2026-04-09

### Added
- worktree 作成時に `.claude/settings.local.json` をコピーし、サブエージェントが同じローカル設定で動作するように (T116)

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
