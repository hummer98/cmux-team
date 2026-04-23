# Seed: Implementation Tasks

全フェーズ実装済み。以下は実装完了状態の記録。

---

## Phase 1: Foundation — 完了

### Task 1.1: Repository scaffolding — 完了
- ディレクトリ構造作成
- `skills/cmux-team/SKILL.md`, `skills/cmux-agent-role/SKILL.md`, `skills/dockeeper/SKILL.md`
- `commands/*.md`（全6コマンド: master, team-spec, team-task, team-archive, artifact, docs-sync）
- `skills/cmux-team/templates/`（全14テンプレート）
- `.gitignore`, `LICENSE` (MIT), `README.md`, `README.ja.md`
- `.claude-plugin/plugin.json`
- `package.json`（npm パッケージ）
- `bin/cmux-team.js`（CLI ラッパー）
- `bin/postinstall.js`（npm postinstall スクリプト）

### Task 1.2: npm パッケージング — 完了（install.sh を置き換え）
- `@hummer98/cmux-team` として npm 公開
- postinstall で bun install + claude plugin add を自動実行
- bin/cmux-team.js で bun を透過呼び出し

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

### Task 2.4: stop 機能 — 廃止（T286, v4.3.0）
- 従来は CLI サブコマンド `cmux-team stop` として SHUTDOWN メッセージ送信を実装していた
- cmux セッション終了で daemon が自動停止するため、明示停止コマンドは不要と判断し廃止
- 手動停止が必要な場合は `kill <pid>`（`.team/daemon.pid` に PID 記録）で対応

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
- 全14テンプレート実装
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
- `task-state.json` による集約管理（draft/ready/assigned/closed/aborted/deleted/archived）
- タスク中心フォルダ集約（`tasks/TNNN-slug/task.md` ＋ `runs/<taskRunId>/` にプロンプト・成果物を集約）
- 依存関係解決（`depends_on` フィールド）
- 優先度ソート（high/medium/low）
- `base_branch`, `run_after_all`, `exclusive` 属性のサポート

### Task 6.7: トレースDB — 完了
- SQLite FTS5 データベース（`trace-store.ts`）
- API リクエスト/レスポンスのメタデータ + 本文を記録
- CLI: `cmux-team trace-task <task-id>`（旧 `trace --task/--search/--show` は廃止）
- メタデータヘッダー伝播: `x-cmux-task-id`, `x-cmux-conductor-surface`, `x-cmux-role`

### Task 6.8: アーティファクト管理 — 完了
- `artifact.ts` によるアーティファクト CRUD
- CLI: `cmux-team artifacts`（一覧・検索）
- スラッシュコマンド `/artifact`（作成・一覧・表示）

### Task 6.9: 追加 CLI サブコマンド — 完了
- `conductor` — Conductor 情報表示
- `spawn-master` — Master surface 起動
- `spawn-conductor` — 単一 Conductor の起動・登録
- `abort-task` — 実行中タスクの中止 + worktree 削除 + Conductor 再起動 + journal 記録
- `delete-task` — draft/ready タスクの削除 + journal 記録

### Task 6.10: ユニットテスト — 完了
- `daemon.test.ts`, `proxy.test.ts`, `queue.test.ts`, `task.test.ts`
- `bun test` で実行（`prepublishOnly` で自動実行）

### Task 6.11: Plugin hooks — 完了
- SessionStart hook: cmux 環境外でのタブ名リネーム
- PreToolUse hook: team.json / task-state.json への直接編集ブロック

---

## 追加改善（Phase 7 以降）— 完了済み

T082〜T116 で実施された主要改善:

### スキル / コマンド追加
- **dockeeper スキル + `/docs-sync` コマンド** — `docs/spec/` を実装現状に同期するスキルとスラッシュコマンドを新設

### タスク管理
- **タスク中心フォルダ集約（T102）** — `.team/tasks/TNNN-slug/runs/<taskRunId>/` にプロンプト・plan.md・Agent 出力を集約
- **`delete-task` 追加 + `abort-task` の Journal 対応（T109）** — タスクの削除・中止と journal 記録
- **`base_branch` + Nerd Font ブランチアイコン（T081）** — タスクごとのマージ先ブランチ指定
- **`--depends-on` オプション（T083）** — タスク依存関係の指定
- **planner の plan.md を `OUTPUT_DIR` 配下へ移動（T107）** — worktree 間の衝突防止

### Conductor / Manager
- **workspace 分離** — daemon が呼び出し元 workspace を記録し、別ワークスペース surface との混同を防止
- **worktree への `.claude/settings.local.json` コピー（T116）** — サブエージェントのローカル設定統一
- **Conductor 起動時 `--settings` hook 注入（T089/T092）** — `CMUX_CLAUDE_HOOKS_DISABLED=1` で cmux ラッパー hook を無効化し、Manager 生成の settings を `--settings` で渡す
- **Conductor `starting` 状態のバグ修正（T114）** — `CONDUCTOR_REGISTERED` 送信順序と SESSION_* ハンドラを修正
- **`close-task` で `CONDUCTOR_DONE` 送信（T106）** — close 後の Conductor stuck 防止
- **メモリリーク修正（T113）** — interval 重複・`fs.watch` 未クローズ・`drainAndLog` 未 catch を修正
- **proxy 再利用時の Master 再接続（T115）** — proxy ポート変化を検出して Master を再接続
- **`task_completed` 二重記録防止（T085）** — CONDUCTOR_DONE ハンドラのステータスガード
- **`SESSION_CLEAR` メッセージ追加（T084）** — `/clear` 時の disconnected 回復

### TUI ダッシュボード
- **bootPhase 早期表示（T080）** — プロキシ起動直後から TUI を表示
- **OSC 8 ハイパーリンク（T093）** — GitHub issue リンクをクリック可能に
- **行クリック可能（T094）** — Tasks 行全体を `ui.button` でラップ
- **ヘッダー RUNNING 削除 + バージョン移動（T095）**
- **5件制限解除（T096）** — `maxItems` ロジック撤廃
- **createdAt 降順 + open 上位（T108）**
- **Journal/Log 逆順表示 + スクロール追従改善（T100）**
- **Tasks タブ Enter でフルスクリーン表示（T103）** — glow ビューワー
- **`assignedAt` + 経過時間表示（T110）** — running は経過、closed/aborted は総実行時間
- **5h/7d unified 使用率表示（T076/T101）** — TPM → unified ヘッダー記録、色分け（T105）
- **Nerd Font アイコン + カーソル + フッター（T082/T088）**
- **Master idle スピナー（T097）**
- **proxy ポート表示 / Tundefined 防御（T087）**

### CLI ヘルプ / ロギング
- **daemon 起動時 `console.log` → `log()` 置換（T090）**
- **`create-task --help` の `--run-after-all` 説明（T098）**

---

## Phase 8: 運用改善（T127〜T141）— 完了済み

v3.35〜v3.38 で実施された主要改善:

### セッション復旧・永続化
- **worktree `.envrc` 生成（T127）** — `source_up` で親の `.envrc` を継承し、direnv 環境変数（OAuth トークン等）を worktree に引き継ぐ
- **`resume` コマンド（T128）** — daemon 再起動時に `task-state.json` の assigned タスクを `claude --resume` で自動復旧
- **~~Conductor `--session-id`（T132）~~ → T203 で撤回** — `crypto.randomUUID()` 自己発行は `/clear` 後の再生成に追従できず resume が壊れていたため、Claude Code の SessionStart hook（`source: startup|resume|clear|compact`）から `SESSION_STARTED` メッセージ経由で daemon が sessionId を一元管理する方式に置き換え
- **resume 多重起動防止** — 既に同一タスクを実行中の Conductor がある場合はスキップ

### レート制限・スロットリング
- **5h レート制限超過で一時停止（T133）** — 5h unified utilization が閾値以上で新規タスク割り当てを停止＋TUI 表示
- **閾値を 95% → 90% に変更（T135）** — `THROTTLE_5H_THRESHOLD = 0.90`

### CLI サブコマンド追加
- **`artifacts add`（T131）** — 既存ファイルをアーティファクトとして登録（ID 自動採番、フロントマター自動生成）
- **`artifacts open`（T140）** — Markdown ビューアでアーティファクトを開く（`CMUX_TEAM_MD_VIEWER` → `mo` → `cat`）
- **`update-task --depends-on`（T136）** — タスク更新時に依存関係を変更可能

### Conductor・Agent・Master 管理
- **`CMUX_CLAUDE_HOOKS_DISABLED=1` の適用拡大（T130/T139）** — Conductor/Agent spawn 時（T130）+ spawn-master（T139）に追加
- **ワークスペース名の自動設定（T129）** — `cmux-team start` 時に `basename(PROJECT_ROOT)` をワークスペース名に設定
- **サイドバーステータスのリアルタイム更新（T137）** — `cmux set-status` で error/throttled/running/done/idle を表示、差分抑制付き
- **SESSION_CLEAR で running Conductor を abort + idle リセット（T141）** — ユーザー手動 `/clear` 時にタスクを aborted に遷移
- **/clear 方式への復帰** — タスク割り当て時の /exit + 再起動を /clear + 新プロンプト送信に戻す

### タスク状態管理
- **`task-state.json` に resume 用フィールド追加** — `worktreePath`, `taskRunId`, `conductorSlot`, `sessionId` を `assignTask` 時に記録

---

## Phase 9: 運用強化（T143〜T174）— 完了済み

v3.39.0〜v3.43.0 で実施された主要改善:

### 観測・分析
- **Tasks パネル Enter で task.md をビューア起動（T143）**
- **trace-task CLI + cmux-team-guide スキル（T144〜T147）** — タスク→セッション索引、配布先向けヘルプ
- **trace DB をタスク-セッション索引に再設計（T144）**

### Conductor 統合・環境改善
- **Conductor `--session-id` 引数を撤廃し自己生成方式に** → さらに T203 で自己生成も撤廃し、SessionStart hook 経由の daemon 一元管理に置き換え
- **statusline ロール別カスタム** — Master は open タスク数、Conductor/Agent は役割別表示
- **Conductor 完了時に要約レポート表示**
- **slot-id 引数廃止・`CMUX_SURFACE` 環境変数に統一**

### Markdown ビューア
- **`mo` ビューアで既存ブラウザを再利用（T156）**
- **TUI 停止せず `mo + cmux browser open` 方式（T153）**
- **ファイル固有 URL で直接フォーカス**

### resume / 起動フロー
- **full_quit から worktree 削除を撤廃し resume ログ改善**
- **worktree 作成時に `baseBranch` を start-point として使用**
- **assigned タスクの resume は shell 側で直接実行（T174）** — Conductor ペインに `cmux-team resume` 文字列を送らない

### i18n・テンプレート
- **プロンプトテンプレートの i18n 対応（T159）** — `templates/{ja,en}/` で分離

### インフラ・設定
- **`.team/.gitignore` の内容更新（T161）** — `team.json` を追跡対象外に移し、追跡対象をコメントで明示
- **Master statusline のコスト表示を open タスク数に置換（T158）**
- **初期化時の `.gitignore`/`config.json`/`team.json` 生成をログ記録（T162）**
- **初回起動時に `.envrc` へ `CMUX_CLAUDE_HOOKS_DISABLED=1` 追記を対話提案（T162/T164）** — direnv allow と再起動も促す

### ロギング
- **execFile エラー時に stderr/stdout をログに含める（T163）**

### 配布・可観測性
- **`marketplace.json` のバージョンを現行に同期**
- **conductor-role.md に他 Conductor surface 直接操作の禁止を追記**
- **conductor-role.md に調査系タスク完了時の summary.md artifact 化ステップ追加（T171）**

### ダッシュボード
- **tab-axis キー入力時の activeTab/focusedArea 同期修正（T170）**
- **THROTTLED 表示の重複解消＋点滅表示（T172）**

### レート制限・スロットル
- **spawn-agent を rate-limit 時にブロック＋exit code 75 + Conductor retry（T173）** — `/rate-limit` API + ラッパー

### プロキシ
- **Bun.serve の `idleTimeout` を 255s に延長（v3.42.0）** — 長時間 SSE ストリーム切断防止

### Conductor 制御
- **Conductor からの `cmux send`/`cmux send-key` を PreToolUse hook でブロック（T167/T169）** — 代替の `cmux-team send-agent` CLI を追加

### auto-update
- **`update-notifier` ベースの 3 モード auto-update（T187）** — `off | notify | task` に拡張。`task` モードで `--run-after-all` の update タスクを自動起票し、install を Conductor に委ねる。daemon は検出のみ。`cmux-team self-update` サブコマンド追加。ログフォーマット破壊的変更（`enabled=<bool>` → `mode=<mode>`）、`npm_auto_update` / `npm_update_check_failed` / `npm_self_update_completed` ログ廃止。
- **auto-update の `task` モードと `self-update` 削除（T294、v4.5.0）** — T187 で導入した `task` モード（`--run-after-all` の update タスク自動起票）と `cmux-team self-update` CLI を完全削除。`autoUpdate` は `"off" | "notify"` の 2 値のみに縮約。boolean 後方互換（`true`/`false`）も削除。`CMUX_TEAM_AUTO_UPDATE=task|1|true` / `.team/config.json: autoUpdate: "task" | true | false` は起動時に exit 1 で reject され、移行ガイド付きエラーメッセージが表示される。`notify` モードは TUI バナー表示を維持し、バナー文言を `(upgrade: npm i -g @hummer98/cmux-team@<latest>)` に統一。daemon の `createUpdateTask` / `buildUpdateTaskBody` / `DaemonState.updateAvailable.createdTaskId` と dashboard の `task created` / `task skipped` 分岐を削除。手動更新は `npm install -g @hummer98/cmux-team@latest` を直接実行する。旧アーカイブ内のタスク frontmatter `kind: cmux-team-update` は読み取りのみ維持（実行経路なし）。

---

## Phase 10: await-agent 方式への移行（T180〜T190）— 完了済み

v3.44.0〜v3.45.0 で実施された主要改善:

### Agent 監視プロトコル刷新（T181）
- **Agent にも Stop / SessionEnd hook を注入** — `conductor-settings.json` 相当の hook 設定を Agent spawn 時にも適用
- **done マーカー方式** — Agent 完了時に `.team/conductors/<conductor>/agent-done/<agent>.done` を書き出す
- **`cmux-team await-agent` CLI** — done マーカーを `fs.watch` で監視し、Conductor の 30 秒ポーリングを置換。`STATUS=DONE|ASK|CRASH|TIMEOUT` を stdout に出力し状態別の exit code で終了
- **`SESSION_ASK` メッセージと `asking` 状態** — AskUserQuestion で停止した Agent/Conductor を検出可能に
- **「プロセス継続のままプロンプトに戻る」ケース（429 後等）の検出** — 旧来の surface_lost だけでは取れなかった asking/idle 遷移を hook 経由で捕捉
- **Conductor テンプレート書き換え** — `conductor-role.md` の Agent 監視ループを `await-agent` ベースに全面刷新

### Manager 健全性（T180）
- **`cmux tree` タイムアウトを crash 判定から除外** — 過剰な `conductor_disconnected` 誤判定を修正。`monitor_tree_failed` / `validate_surface_failed` のエラー詳細に stderr/stdout を含めてログ強化

### 運用改善
- **update-task の全更新で TUI 即時反映（T183）** — status 以外の更新でも `postMessage TASK_CREATED` 相当の通知を送り、次 tick を待たずにダッシュボードへ反映
- **state 変更の TUI 即時反映（T184）** — `eventBus.ts` 導入。`notifyStateChanged(source)` ラッパー経由で mutation 直後に `state-changed` イベントを emit、`CMUX_TEAM_TRACE_EVENTS=1` で emit ログを出力

### CLI
- **`cmux-team --version` / `-v`（T185）** — package.json の version を出力
- **auto-update のデフォルト OFF + opt-in 化（T186）** — T187 による 3 モード再設計の前段

### TypeScript 健全性（T190）
- **既知の tsc エラー 6 件を解消** — `cmux.ts` の stdout/stderr 型不整合、`update-notifier` の型定義追加、`dashboard.tsx` の WidgetVariant、`main.test.ts` の undefined 伝播を修正

### リリース運用
- **`--run-after-all` の release タスク自動化（T188）** — Conductor が直接 `npm version` → `git push` → `npm publish` を実行するオペレーショナルタスク
- **排他タスク属性 `exclusive`（T246）** — `--exclusive` フラグ追加。drain 後に単独実行され、assigned の間は他の全 assignment を停止する（closed になると再開）。`--run-after-all` を暗黙に含む。`parseTaskMeta` で `exclusive=true` なら `runAfterAll=true` を強制。`sortByPriority` に ID 昇順二次キー追加（exclusive 同士の順序保証）。`RUN_AFTER_ALL_CONFLICT` 緩和で exclusive 同士のみ共存可能、非排他 run_after_all と exclusive は共存不可。release.md を `--exclusive` に移行

---

## 未実装の改善候補

- レート制限のインテリジェント制御（5h 閾値スロットリングは実装済み、7d 制限や動的閾値調整は未実装）
- Conductor 台数の動的スケーリング
- Web UI ダッシュボード
- マルチプロジェクト対応
- Master 稼働中スピナー（TUI 反映）の実装 — T175 として draft 化
- 16:9 レイアウトモード（Conductor 2 セッション構成）の追加 — T176 として ready 化
