# 実装計画: docs/spec/glossary.md 新設

## 1. 概要

cmux-team の用語定義は現状 `docs/spec/00`〜`09` および `CLAUDE.md` に散在しており、
新規参加者や別タスクのエージェントが「ある用語の一次定義はどこか」を即座に辿れない。
本タスクでは `docs/spec/glossary.md` を新設し、用語 → 一次定義場所への
インデックス（二次資料）として機能させる。glossary 自体に詳細定義は持たせず、
1〜3 行の要約と一次リンクに留めることで、定義の本体は spec 側に保つ（DRY）。

範囲は (1) glossary.md の新設、(2) `docs/spec/00-project-overview.md` の
「仕様ドキュメント索引」表への glossary 行追加、(3) `CLAUDE.md` の
「リポジトリ構造」直下の docs/spec ファイル表への glossary 行追加、の 3 点。

## 2. 採用する構成方針

| 項目 | 方針 | 理由 |
|------|------|------|
| 性格 | **二次資料**（インデックス）に振り切る。各エントリは 1〜3 行の要約 + 一次リンク + 関連用語のみ | 定義の本体を spec から複製すると DRY 違反になり、片方が腐る |
| 構成 | カテゴリ別グルーピング（10 カテゴリ）。カテゴリ内は表形式 | カテゴリ軸で「同じ概念群がどこで定義されているか」を一覧化できる |
| ソート順 | カテゴリは仕様書の番号順に近い意味的順序（4 層 → Task → FSM → 属性 → Token Pool → テンプレート → Sync → Worktree → 通信）。カテゴリ内は概念依存順（呼び出される側が先） | アルファベット順より「読み進めやすい」順 |
| 目次 | 冒頭に「カテゴリ目次」を置く。用語数が多くないので個別用語の TOC は割愛 | 用語数 ≒ 50 程度。個別 TOC はメンテ負荷の割にメリットが薄い |
| リンク形式 | 同一 `docs/spec/` 内 → ファイル名相対（例: `07-state-machine.md#1-conductor-fsm`）。`CLAUDE.md` 参照 → `../../CLAUDE.md#section-anchor` | docs/spec/glossary.md からの相対参照 |
| anchor 生成 | GFM 慣例（小文字化・空白→ハイフン・ピリオド/コロン/カッコ等の記号削除・日本語はそのまま） | GitHub レンダラーが採用するルール |
| 表記揺れの扱い | 同概念に複数呼称があるものは両方立項。一方を本項目（定義入り）、他方を「→ <本項目> を参照」のリダイレクト記述にする | 検索性 vs 重複の両立 |
| 略号方針 | TXXX / AXXX（タスク・アーティファクト ID）は要約文中に出てきても展開しない | 一次資料側の表現を変えないため |
| 網羅性 | 「複数候補が出る用語」「会話で頻出する用語」を優先。マイナーな実装内部用語は割愛 | 全網羅は spec 側の責務 |

## 3. 収録用語リスト

カテゴリ内の表は実装時にそのまま glossary.md に転記できる粒度で書く。
リンクの section anchor は GFM 慣例で生成（実装時に GitHub プレビューで疎通確認）。

### 3.1 4層アーキテクチャ

| 用語 | 定義案（1〜3 行） | 一次リンク | 関連 |
|------|------------------|-----------|------|
| Master | ユーザー対話を担う最上位層。タスクを CLI 経由で作成し、進捗を確認する。実装は共有ストア（`.team/`）への CLI クライアントで、複数 Master の並行動作を許容する。 | `00-project-overview.md#core-concept`, `04-templates.md#master-template` | Manager / Conductor / Agent / surface |
| Manager | TypeScript daemon（`skills/cmux-team/manager/main.ts`）。タスク検出 → idle Conductor へ割り当て → done マーカーで完了検出（pull 型）を担う。Conductor は spawn しない。 | `00-project-overview.md#core-concept`, `05-install-and-infrastructure.md#manager-daemontypescript` | Master / Conductor / daemon / done marker |
| Conductor | 常駐 Claude セッション。タスクを受けて worktree 内で Agent を spawn・監視・統合し、最終的に `close-task` でタスクを閉じる。直接コードを書かない。 | `00-project-overview.md#core-concept`, `04-templates.md#conductor-templates3種`, `07-state-machine.md#1-conductor-fsm` | Manager / Agent / Conductor FSM |
| Agent | Conductor が `spawn-agent` で起動する子セッション。Researcher / Architect / Planner / Design Reviewer / Implementer / Inspector / DocKeeper / TaskManager の 8 ロール。 | `04-templates.md#テンプレート一覧`, `02-skill-cmux-agent-role.md` | Conductor / Role / overlay |
| surface | cmux 上で各セッションが占有するペイン/タブの識別子（例: `surface:5`）。daemon は workspace 名と組み合わせて一意に識別する。 | `05-install-and-infrastructure.md#manager-daemontypescript`, `04-templates.md#テンプレート変数一覧` | cmux / pane / conductorSlot |
| Role / OverlayRole | spawn-agent が受け付ける 8 ロール（`AgentRole`）と、overlay/master/conductor を含む 10 ロール（`OverlayRole`）。エイリアス: `impl→implementer`, `reviewer→design-reviewer`。 | `04-templates.md#project_instructions-プレースホルダt247--t342` | Agent / overlay |

### 3.2 Task 関連

| 用語 | 定義案 | 一次リンク | 関連 |
|------|--------|-----------|------|
| Task（タスク） | 単位作業の定義。`.team/tasks/TNNN-slug/task.md` で表現し、CLI（`create-task` / `update-task`）経由でのみ作成・更新する。 | `00-project-overview.md#per-project-statecmux-team-start-で作成`, `../../CLAUDE.md#タスクの作成更新は-cli-経由直接ファイル操作禁止` | TaskRun / Task FSM / Artifact |
| Artifact（アーティファクト） | 「わかったこと」の記録。`.team/artifacts/Axxx-<slug>.md`。誰でも直接ファイル作成可（Task との対比）。`type` は research / decision / session / spec / report。 | `../../CLAUDE.md#artifacts知見の記録` | Task / `/artifact` コマンド |
| Deliverable（納品物） | `close-task` で指定するタスクの納品方式。kind は `files` / `merged` / `pr` / `none`。auto-close 経路は `none` を daemon が自動付与。 | `08-runtime-boundary.md`, `05-install-and-infrastructure.md#cli-サブコマンド`, `07-state-machine.md#21-状態一覧-6-値` | close-task / Task FSM (closed) |
| TaskRun / taskRunId | タスク実行 ID（`task-NNN-TIMESTAMP` 形式）。worktree 名・出力ディレクトリ（`.team/tasks/TNNN-slug/runs/<taskRunId>/`）の根として使う。 | `05-install-and-infrastructure.md#タスク状態の拡張フィールドresume-用`, `00-project-overview.md#per-project-statecmux-team-start-で作成` | Task / OUTPUT_DIR / Worktree |
| conductorSlot | assigned タスクが占有する Conductor の surface ID（例: `surface:5`）。resume 用 metadata として `task-state.json` に記録される。 | `05-install-and-infrastructure.md#タスク状態の拡張フィールドresume-用` | surface / sessionId / resume |
| sessionId | Claude Code セッション ID。`SESSION_STARTED` hook で daemon に push され、`/clear` 等で session が切り替わるたびに最新値で更新される。 | `05-install-and-infrastructure.md#タスク状態の拡張フィールドresume-用`, `05-install-and-infrastructure.md#メッセージング` | SESSION_STARTED / resume |

### 3.3 Task FSM 状態（6 値 + 関連）

`disconnected` は Conductor 側の状態だが、disconnect timeout で Task が `aborted` に
遷移する連動関係があるため glossary でも併載する。

| 用語 | 定義案 | 一次リンク | 関連 |
|------|--------|-----------|------|
| draft | 下書き状態。assign されない。`create-task` のデフォルト、または親タスク abort の cascade で戻る。 | `07-state-machine.md#21-状態一覧-6-値` | ready / cascade |
| ready | 実行待ち。assignable な状態。`update-task --status ready` で昇格、昇格時は sync state ガードが走る。 | `07-state-machine.md#21-状態一覧-6-値`, `../../CLAUDE.md#ready-昇格時の-sync-state-ガード` | sync state / draft |
| assigned | Conductor に割り当て済み。`assignTask` 成功で遷移。assigned のタスク本文の編集は禁止（変更は `abort-task` → 新タスク）。 | `07-state-machine.md#21-状態一覧-6-値`, `../../CLAUDE.md#タスクの作成更新は-cli-経由直接ファイル操作禁止` | Conductor (assigning/running) |
| closed | 正常完了。`close-task` 必須引数 `--deliverable-kind` で kind を指定。auto-close 経路は `kind: "none"` を daemon が自動付与。 | `07-state-machine.md#21-状態一覧-6-値`, `05-install-and-infrastructure.md#cli-サブコマンド` | Deliverable |
| aborted | 中止状態。`abort-task` CLI、disconnect timeout、user_clear、judgment_pending 等から遷移。`restart-task` で `ready` に戻せる。 | `07-state-machine.md#21-状態一覧-6-値`, `07-state-machine.md#24-cascade-ルール-t241` | cascade / restart-task |
| deleted | 明示削除（終端）。draft / ready からのみ遷移可能。assigned は `abort-task` を使う。 | `07-state-machine.md#21-状態一覧-6-値` | delete-task |
| disconnected | （Conductor 状態だが Task と連動）Claude プロセス不在 / SessionEnd / PID 死。`DISCONNECT_TIMEOUT_SEC`（300s）超過で `broken` に遷移し、紐づくタスクは `aborted` + cascade。 | `07-state-machine.md#11-状態一覧-7-値`, `07-state-machine.md#3-conductor--task-の同時遷移` | broken / cascade |

### 3.4 Task 属性

| 用語 | 定義案 | 一次リンク | 関連 |
|------|--------|-----------|------|
| run_after_all | 「全 open タスクが closed になってから実行」する非排他 drain 属性。CLI フラグは `--run-after-all`。 | `../../CLAUDE.md#タスク属性`, `07-state-machine.md` | exclusive / drain |
| exclusive | drain 後に単独実行。assigned の間は他の全 assignment を停止する排他属性。CLI フラグは `--exclusive`。複数 `--exclusive` は ID 昇順で順次実行。 | `../../CLAUDE.md#タスク属性`, `07-state-machine.md` | run_after_all |
| depends_on | タスク間依存関係。親タスクが `aborted` / `deleted` に遷移すると `ready` 子は `draft` に戻される（cascade）。 | `07-state-machine.md#24-cascade-ルール-t241`, `05-install-and-infrastructure.md#cli-サブコマンド` | cascade |
| base_branch | task.md 冒頭で明示する worktree 起点ブランチ。明示時は `worktree-base.ts:resolveWorktreeBase` の最優先（`explicit`）として採用される。 | `05-install-and-infrastructure.md#teamconfigjson初回起動時に自動生成` | start-point / mainBranch |

### 3.5 Conductor FSM 状態（7 値）

| 用語 | 定義案 | 一次リンク | 関連 |
|------|--------|-----------|------|
| starting | `CONDUCTOR_REGISTERED` 直後。Claude プロセス未確認の初期状態。60 秒で disconnected へ TIMEOUT。 | `07-state-machine.md#11-状態一覧-7-値` | REGISTERED |
| idle | タスク割当可能な定常状態。Claude セッション確立済み。`SESSION_STARTED` 到達または `resetConductor` で遷移。 | `07-state-machine.md#11-状態一覧-7-値` | assignTask |
| assigning | `assignTask` で `/clear` 送信済みかつ `SESSION_STARTED` 未到達の中間状態。60 秒で disconnected。 | `07-state-machine.md#11-状態一覧-7-値` | running |
| running | タスク実行中。`SESSION_STARTED(source=clear)` または `SESSION_ACTIVE(hasTaskRunId)` で遷移。 | `07-state-machine.md#11-状態一覧-7-値` | assigning / DONE |
| asking | `AskUserQuestion` を Notification hook で受信した状態。ユーザー入力待ち（T181）。 | `07-state-machine.md#11-状態一覧-7-値`, `05-install-and-infrastructure.md#メッセージング` | SESSION_ASK |
| disconnected | Claude プロセス不在 / SessionEnd / PID 死。300 秒超過で `broken` へ遷移。 | `07-state-machine.md#11-状態一覧-7-値` | PID watcher / broken |
| broken | disconnected 300s 超過の **終端状態**。`cmux-team clear-conductor` のみで解除。 | `07-state-machine.md#11-状態一覧-7-値`, `07-state-machine.md#15-不変条件` | disconnected |

### 3.6 Token Pool 用語

| 用語 | 定義案 | 一次リンク | 関連 |
|------|--------|-----------|------|
| handle | token の表示識別子（`@pers`、`@kddi` 等）。display name の先頭 4 文字を `@xxxx` 形式に変換。**変更不可**。 | `09-token-pool.md#cli-コマンド`, `09-token-pool.md#db-スキーマcmux-teamtokensdb` | organization_id / rotate |
| plan | token の契約プラン。`pro` / `max-x5` / `max-x20` / `unknown` のいずれか。`rateLimitTier` から自動解決される。 | `09-token-pool.md#cli-コマンド` | plan_ratio / set-plan |
| plan_ratio | plan の流量倍率（pro=1.0 / max-x5=5.0 / max-x20=20.0 / unknown=NULL）。pool_capacity の重み付けに使う。 | `09-token-pool.md#cli-コマンド`, `09-token-pool.md#pool_capacity-指標` | pool_capacity |
| selectable | token が候補化対象かのフラグ。auto-discover 登録は `selectable=0`、明示登録は `selectable=1`。`effectiveDefault` 一致時のみ runtime 昇格。 | `09-token-pool.md#db-スキーマcmux-teamtokensdb`, `09-token-pool.md#auto-discover` | auto-discover |
| tags（hint 体系） | token 側の hint。`any` / `oss-only` / `org:<name>` / `auto`。**ACL ではない**（プロジェクト側の `default` / `include` / `exclude` が ACL を担う）。 | `09-token-pool.md#タグ設計hint-体系` | project default-include-exclude |
| project default / include / exclude | プロジェクト config（`.team/config.json: tokenPool`）の token 候補制御。`default` は無条件 admit、`include` は tags 不問 admit、`exclude` は最優先除外。 | `09-token-pool.md#プロジェクト設定teamconfigjson` | tags / OSS project |
| auto-discover | proxy が未知 token（`auth_hash` 不一致）を検出した際に tokens.db に自動 INSERT する仕組み。`selectable=0` / `tags=["auto"]` / Keychain 未登録。pool 機能 OFF では走らない（T341）。 | `09-token-pool.md#auto-discover` | promote / selectable |
| lease | spawn-agent 時に取得する short-term reservation（120 秒 TTL）。race を atomic INSERT OR IGNORE で吸収する。 | `09-token-pool.md#token-選択アルゴリズムselecttoken`, `09-token-pool.md#db-スキーマcmux-teamtokensdb` | selectToken |
| pool_capacity | 「Max x20 を 100% とした持続可能流量の比率」指標。`flow_i = min(remaining_5h, remaining_7d) * plan_ratio / time` の合計を `REFERENCE_FLOW (= 20.0/168)` で割った百分率。 | `09-token-pool.md#pool_capacity-指標` | plan_ratio |
| effectiveDefault | 候補抽出で「無条件 admit」となる handle。`tokenPool.default ?? (isOss ? globalConfig.oss_default : null)` で決まる。 | `09-token-pool.md#token-選択アルゴリズムselecttoken` | OSS / default |

### 3.7 テンプレート変数

| 用語 | 定義案 | 一次リンク | 関連 |
|------|--------|-----------|------|
| `{{VARIABLE}}` | テンプレート（`skills/cmux-team/templates/{ja,en}/*.md`）のプレースホルダー総称。Conductor / daemon が spawn 時に置換し、ランタイム prompt（`.team/prompts/`）として書き出す。**全変数一覧は 04-templates.md を参照。** | `04-templates.md#テンプレート変数一覧` | テンプレート / overlay |
| `{{COMMON_HEADER}}` | common-header.md（全エージェント共通ヘッダー）の展開結果。Agent ロール 8 件すべてで使用。 | `04-templates.md#common-header全エージェント共通` | Agent |
| `{{PROJECT_INSTRUCTIONS}}` | overlay placeholder。`.team/agent-instructions/<role>.md` の内容で置換される。Master / Conductor 用は daemon 起動時に直接展開（T247 / T342）。 | `04-templates.md#project_instructions-プレースホルダt247--t342` | overlay / OverlayRole |
| `{{TASK_CONTENT}}` | タスク定義の本文。`conductor-task` / `planner` / `design-reviewer` / `inspector` で使用。 | `04-templates.md#テンプレート変数一覧` | Task |
| `{{OUTPUT_DIR}}` | 出力ディレクトリパス（`.team/tasks/TNNN-slug/runs/<taskRunId>/`）。planner はここに `plan.md` を書く。 | `04-templates.md#テンプレート変数一覧` | TaskRun |
| `{{OUTPUT_FILE}}` | 個別 Agent の出力ファイルパス（researcher / architect / design-reviewer / implementer / inspector / dockeeper / task-manager）。 | `04-templates.md#テンプレート変数一覧` | OUTPUT_DIR |
| `{{WORKTREE_PATH}}` | git worktree の絶対パス。conductor / conductor-task で使用。 | `04-templates.md#テンプレート変数一覧` | Worktree |
| `{{MAIN_BRANCH}}` | プロジェクト主開発ブランチ名。解決順位は env > config > `git symbolic-ref` 自動検出。T253 で fail-stop。 | `04-templates.md#テンプレート変数一覧`, `05-install-and-infrastructure.md#teamconfigjson初回起動時に自動生成` | base_branch |
| `{{BASE_BRANCH}}` | タスクの target ブランチ。未指定時は `mainBranch` と同値（T253 で `"main"` リテラルフォールバック廃止）。 | `04-templates.md#テンプレート変数一覧` | mainBranch |

### 3.8 Sync state（git 同期判定）

| 用語 | 定義案 | 一次リンク | 関連 |
|------|--------|-----------|------|
| Ready sync guard | `update-task --status ready` 昇格時に走る local ↔ `origin/<mainBranch>` 同期判定。`diverged` / `uncommitted` / `detached` は exit 1（`ready_rejected`）。 | `../../CLAUDE.md#ready-昇格時の-sync-state-ガード` | sync state / `--force` |
| diverged | local と origin が双方独自の commit を持つ状態。Ready 昇格を拒否する。 | `../../CLAUDE.md#ready-昇格時の-sync-state-ガード` | Ready sync guard |
| uncommitted | working tree に未コミットの変更がある状態。Ready 昇格を拒否する。 | `../../CLAUDE.md#ready-昇格時の-sync-state-ガード` | Ready sync guard |
| detached | HEAD がブランチに紐づいていない（detached HEAD）。Ready 昇格を拒否する。 | `../../CLAUDE.md#ready-昇格時の-sync-state-ガード` | Ready sync guard |
| behind-ff | local が origin より strict behind かつ fast-forward 可能。`mainBranch` checkout 中なら自動 `git pull --ff-only`、それ以外は警告のみで昇格続行。 | `../../CLAUDE.md#ready-昇格時の-sync-state-ガード` | `--no-auto-pull` |
| no-remote | upstream remote が無い状態。警告のみで昇格続行。 | `../../CLAUDE.md#ready-昇格時の-sync-state-ガード` | Ready sync guard |
| `CMUX_TEAM_SKIP_SYNC_CHECK` | sync check 全体を skip する環境変数（Conductor / Agent 環境に自動注入される）。 | `../../CLAUDE.md#ready-昇格時の-sync-state-ガード`, `09-token-pool.md#機能-onoff3-階層` | `--force` |

### 3.9 Worktree / start-point 解決

`worktree-base.ts:resolveWorktreeBase` の 5 階層（T242 / T275）。優先順位順。

| 用語 | 定義案 | 一次リンク | 関連 |
|------|--------|-----------|------|
| explicit | task.md frontmatter に `base_branch:` が明示された場合に採用される最優先 source。 | `05-install-and-infrastructure.md#teamconfigjson初回起動時に自動生成` | base_branch |
| config-local-ahead | local `<mainBranch>` が `origin/<mainBranch>` より strict ahead（同一 SHA でない・origin が ancestor）の場合に採用（T275）。push しない運用や stale origin から worktree が切られるのを防ぐ。 | `05-install-and-infrastructure.md#teamconfigjson初回起動時に自動生成` | mainBranch / fetch-before-worktree |
| config-origin | `origin/<mainBranch>` が存在する場合に採用される通常 source。 | `05-install-and-infrastructure.md#teamconfigjson初回起動時に自動生成` | mainBranch |
| config-local | local `<mainBranch>` のみ存在する場合に採用。 | `05-install-and-infrastructure.md#teamconfigjson初回起動時に自動生成` | mainBranch |
| head-fallback | 上記すべてが解決できない場合の HEAD フォールバック。最終手段。 | `05-install-and-infrastructure.md#teamconfigjson初回起動時に自動生成` | (なし) |
| `CMUX_TEAM_FETCH_BEFORE_WORKTREE` | worktree 作成前に `git fetch --quiet origin <mainBranch>` を行うかの環境変数。T283 でデフォルト ON に反転。 | `05-install-and-infrastructure.md#teamconfigjson初回起動時に自動生成` | config-local-ahead / config-origin |

### 3.10 コミュニケーション系

| 用語 | 定義案 | 一次リンク | 関連 |
|------|--------|-----------|------|
| Trace DB | `.team/traces/traces.db`（SQLite + FTS5）。Anthropic API リクエスト/レスポンス・hook signal・api_usage を記録。検索は `cmux-team trace` / `trace-task` / `trace-hooks`。 | `05-install-and-infrastructure.md#プロキシサーバー`, `../../CLAUDE.md#通信プロトコル` | proxy / hook_signals |
| hook | Claude Code が発行する SessionStart / Stop / Notification / PreToolUse / PostToolUse / SessionEnd 等のイベント。hook shell には分岐ロジックを持たせず、全イベントを daemon に転送する。 | `../../CLAUDE.md#実装ルールガードレール`, `05-install-and-infrastructure.md#メッセージング` | hook_signals / Trace DB |
| EventBus | daemon プロセス内の **実 state mutation** → TUI refresh を疎結合に接続する EventEmitter ラッパー（`eventBus.ts`）。`notifyStateChanged` / `onStateChanged` のみ使用可（`bus.emit` / `bus.on` 直接呼び出しは禁止）。 | `05-install-and-infrastructure.md#event-catalogeventbusts`, `../../CLAUDE.md#実装ルールガードレール` | state mutation |
| queue | daemon の HTTP プロキシが受け口を兼ねるメッセージキュー。CLI（`cmux-team send <TYPE>`）から POST されたメッセージを受信。旧ファイルベース `queue.ts` は廃止済み。 | `05-install-and-infrastructure.md#メッセージング` | proxy |
| done marker | Conductor 完了通知用ファイル（`.team/tasks/TNNN-slug/runs/<taskRunId>/done`）。Manager は fs.watch + PID ベース生存確認（`spawnPidWatcher`）で完了検出する（pull 型）。 | `00-project-overview.md#core-concept`, `../../CLAUDE.md#manager-プロトコル概要` | Conductor / await-agent |
| journal | `task-state.json` 内に記録される状態遷移の監査ログ（`task_aborted` / `task_completed` / `parent_aborted: <id>` 等）。 | `07-state-machine.md#24-cascade-ルール-t241`, `../../CLAUDE.md#エラーリカバリ` | cascade |
| CONDUCTOR_DONE | Conductor から daemon に送る完了メッセージ。`success: true` で正常 close、`unresolved: true` で `aborted` + cascade（preserveWorktree）。 | `07-state-machine.md#3-conductor--task-の同時遷移`, `05-install-and-infrastructure.md#メッセージング` | DONE / Task FSM |

## 4. 既存ファイルへの追加内容

### 4.1 `docs/spec/glossary.md`（新規作成）

`docs/spec/` 直下に新規作成。冒頭は以下の構造:

```markdown
# Glossary（用語集）

cmux-team の主要用語と一次定義場所のインデックス。各エントリは 1〜3 行の要約 + 一次リンクのみで、
定義の本体は spec 側に置かれている。詳細はリンク先を参照すること。

## 目次

1. [4 層アーキテクチャ](#1-4-層アーキテクチャ)
2. [Task 関連](#2-task-関連)
3. [Task FSM 状態](#3-task-fsm-状態)
4. [Task 属性](#4-task-属性)
5. [Conductor FSM 状態](#5-conductor-fsm-状態)
6. [Token Pool](#6-token-pool)
7. [テンプレート変数](#7-テンプレート変数)
8. [Sync state](#8-sync-state)
9. [Worktree / start-point](#9-worktree--start-point)
10. [コミュニケーション系](#10-コミュニケーション系)

---

## 1. 4 層アーキテクチャ

（§3.1 の表をそのまま転記）

...
```

各カテゴリ見出しは表の直前に置き、表の直後に「**関連 spec**: 一次リンク」の 1 行サマリーを置く。

### 4.2 `docs/spec/00-project-overview.md`（編集）

「## 仕様ドキュメント索引」表（121 行付近）の末尾に glossary 行を追加する。
**挿入位置**: 現状の表は `00`〜`07` の 8 行で構成され、`08` / `09` がそもそも未掲載。
今回は本タスクのスコープを保つため `glossary` 1 行のみ追加（08 / 09 行の追加は別タスク扱い、§5 に注記）。

挿入する行:

```markdown
| -- | glossary.md | 用語集（一次定義のインデックス、二次資料） |
```

`No.` 列は数値ではなく `--`（番号を持たない補助資料であることを明示）。
表末尾に挿入し、列順を既存と一致させる。

### 4.3 `CLAUDE.md`（編集）

「## リポジトリ構造」セクション（57-82 行）直下の `docs/spec/` ファイル表
（「cmux-team の仕様・挙動について質問された場合は、`docs/spec/` の該当ファイルを Read して回答すること。」直後の表）に
glossary 行を追加する。

**挿入位置**: 既存表は `00 / 01 / 04 / 05 / 07 / 08 / 09` を列挙している（02 / 03 / 06 は載っていない）。
glossary は **表の冒頭、`00-project-overview.md` の直前**に挿入する（用語に迷ったらまず glossary を見る、というナビゲーション順）。

挿入する行:

```markdown
| `docs/spec/glossary.md` | 用語集（用語 → 一次定義場所のインデックス） |
```

リポジトリ構造の ASCII ツリー部分（57-66 行付近）は個別 .md ファイルを列挙していないため変更不要。

## 5. 完了基準

| # | 基準 | 検証方法 |
|---|------|---------|
| 1 | `docs/spec/glossary.md` が新設され、§3 の 10 カテゴリすべてのエントリを網羅している | `wc -l docs/spec/glossary.md` が 100 行以上 / カテゴリ見出しが 10 個 |
| 2 | 各カテゴリの表が「用語 / 定義案 / 一次リンク / 関連」の 4 列構成 | 目視 |
| 3 | `docs/spec/00-project-overview.md` の「仕様ドキュメント索引」表に glossary.md 行が追加されている | `grep glossary.md docs/spec/00-project-overview.md` |
| 4 | `CLAUDE.md` の docs/spec ファイル表に glossary.md 行が追加されている | `grep glossary.md CLAUDE.md` |
| 5 | glossary.md の内部リンクがすべて生きている（GitHub プレビューで anchor が解決する） | GitHub の Files Changed タブでホバー確認、または `markdown-link-check` |
| 6 | `bunx tsc --noEmit` が pass する（docs だけなのでほぼ自明だが既存テスト・型を壊していないことの確認） | `cd skills/cmux-team/manager && bunx tsc --noEmit` |
| 7 | 既存 spec ファイルの定義内容には触れていない（DRY 原則: glossary は二次資料） | `git diff docs/spec/00 docs/spec/01 ... docs/spec/09` で本文差分が無いことを確認（00 の索引行追加のみ可） |

### 範囲外（別タスクで扱う）

- `docs/spec/00-project-overview.md` の「仕様ドキュメント索引」表に欠けている `08-runtime-boundary.md` / `09-token-pool.md` の行追加（本タスクは glossary 行追加のみ）
- `CLAUDE.md` の docs/spec 表に欠けている `02 / 03 / 06` の行追加
- glossary に含めなかった「実装内部用語」（例: `notifyStateChanged` の引数仕様、`fsm_shadow_diff` ログ書式 等）の追加
- 英語版 glossary の作成（テンプレート同様 `{ja,en}` 分離が必要なら別タスク）
