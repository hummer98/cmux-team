# Glossary（用語集）

cmux-team の主要用語と一次定義場所のインデックス。各エントリは 1〜3 行の要約 + 一次リンクのみで、
定義の本体は spec 側に置かれている。詳細はリンク先を参照すること。

本ドキュメントは **二次資料**である。定義の本体を spec から複製すると DRY 違反になり片方が腐るため、
glossary には要約と一次リンクのみを置く方針を取る。

## 目次

1. [4 層アーキテクチャ](#1-4-層アーキテクチャ)
2. [Task 関連](#2-task-関連)
3. [Task FSM 状態](#3-task-fsm-状態6-値--関連)
4. [Task 属性](#4-task-属性)
5. [Conductor FSM 状態](#5-conductor-fsm-状態7-値)
6. [Token Pool](#6-token-pool)
7. [テンプレート変数](#7-テンプレート変数)
8. [Sync state](#8-sync-stategit-同期判定)
9. [Worktree / start-point](#9-worktree--start-point-解決)
10. [コミュニケーション系](#10-コミュニケーション系)

---

## 1. 4 層アーキテクチャ

| 用語 | 定義 | 一次リンク | 関連 |
|------|------|-----------|------|
| Master | ユーザー対話を担う最上位層。タスクを CLI 経由で作成し、進捗を確認する。実装は共有ストア（`.team/`）への CLI クライアントで、複数 Master の並行動作を許容する。 | [`00-project-overview.md#core-concept`](00-project-overview.md#core-concept), [`04-templates.md#master-template`](04-templates.md#master-template) | Manager / Conductor / Agent / surface |
| Manager | TypeScript daemon（`skills/cmux-team/manager/main.ts`）。タスク検出 → idle Conductor へ割り当て → done マーカーで完了検出（pull 型）を担う。Conductor は spawn しない。 | [`00-project-overview.md#core-concept`](00-project-overview.md#core-concept), [`05-install-and-infrastructure.md#manager-daemontypescript`](05-install-and-infrastructure.md#manager-daemontypescript) | Master / Conductor / daemon / done marker |
| Conductor | 常駐 Claude セッション。タスクを受けて worktree 内で Agent を spawn・監視・統合し、最終的に `close-task` でタスクを閉じる。直接コードを書かない。 | [`00-project-overview.md#core-concept`](00-project-overview.md#core-concept), [`04-templates.md#conductor-templates3種`](04-templates.md#conductor-templates3種), [`07-state-machine.md#1-conductor-fsm`](07-state-machine.md#1-conductor-fsm) | Manager / Agent / Conductor FSM |
| Agent | Conductor が `spawn-agent` で起動する子セッション。Researcher / Architect / Planner / Design Reviewer / Implementer / Inspector / DocKeeper / TaskManager の 8 ロール。 | [`04-templates.md#テンプレート一覧`](04-templates.md#テンプレート一覧), [`02-skill-cmux-agent-role.md`](02-skill-cmux-agent-role.md) | Conductor / Role / overlay |
| surface | cmux 上で各セッションが占有するペイン/タブの識別子（例: `surface:5`）。daemon は workspace 名と組み合わせて一意に識別する。 | [`05-install-and-infrastructure.md#manager-daemontypescript`](05-install-and-infrastructure.md#manager-daemontypescript), [`04-templates.md#テンプレート変数一覧`](04-templates.md#テンプレート変数一覧) | cmux / pane / conductorSlot |
| Role / OverlayRole | spawn-agent が受け付ける 8 ロール（`AgentRole`）と、overlay/master/conductor を含む 10 ロール（`OverlayRole`）。エイリアス: `impl→implementer`, `reviewer→design-reviewer`。 | [`04-templates.md#project_instructions-プレースホルダt247--t342`](04-templates.md#project_instructions-プレースホルダt247--t342) | Agent / overlay |

**関連 spec**: [`00-project-overview.md`](00-project-overview.md) / [`04-templates.md`](04-templates.md) / [`02-skill-cmux-agent-role.md`](02-skill-cmux-agent-role.md)

## 2. Task 関連

| 用語 | 定義 | 一次リンク | 関連 |
|------|------|-----------|------|
| Task（タスク） | 単位作業の定義。`.team/tasks/TNNN-slug/task.md` で表現し、CLI（`create-task` / `update-task`）経由でのみ作成・更新する。 | [`00-project-overview.md#per-project-statecmux-team-start-で作成`](00-project-overview.md#per-project-statecmux-team-start-で作成), [`../../CLAUDE.md#タスクの作成更新は-cli-経由直接ファイル操作禁止`](../../CLAUDE.md#タスクの作成更新は-cli-経由直接ファイル操作禁止) | TaskRun / Task FSM / Artifact |
| Artifact（アーティファクト） | 「わかったこと」の記録。`.team/artifacts/Axxx-<slug>.md`。誰でも直接ファイル作成可（Task との対比）。`type` は research / decision / session / spec / report。 | [`../../CLAUDE.md#artifacts知見の記録`](../../CLAUDE.md#artifacts知見の記録) | Task / `/artifact` コマンド |
| Deliverable（納品物） | `close-task` で指定するタスクの納品方式。kind は `files` / `merged` / `pr` / `none`。auto-close 経路は `none` を daemon が自動付与。 | [`08-runtime-boundary.md`](08-runtime-boundary.md), [`05-install-and-infrastructure.md#cli-サブコマンド`](05-install-and-infrastructure.md#cli-サブコマンド), [`07-state-machine.md#21-状態一覧-6-値`](07-state-machine.md#21-状態一覧-6-値) | close-task / Task FSM (closed) |
| TaskRun / taskRunId | タスク実行 ID（`task-NNN-TIMESTAMP` 形式）。worktree 名・出力ディレクトリ（`.team/tasks/TNNN-slug/runs/<taskRunId>/`）の根として使う。 | [`05-install-and-infrastructure.md#タスク状態の拡張フィールドresume-用`](05-install-and-infrastructure.md#タスク状態の拡張フィールドresume-用), [`00-project-overview.md#per-project-statecmux-team-start-で作成`](00-project-overview.md#per-project-statecmux-team-start-で作成) | Task / OUTPUT_DIR / Worktree |
| conductorSlot | assigned タスクが占有する Conductor の surface ID（例: `surface:5`）。resume 用 metadata として `task-state.json` に記録される。 | [`05-install-and-infrastructure.md#タスク状態の拡張フィールドresume-用`](05-install-and-infrastructure.md#タスク状態の拡張フィールドresume-用) | surface / sessionId / resume |
| sessionId | Claude Code セッション ID。`SESSION_STARTED` hook で daemon に push され、`/clear` 等で session が切り替わるたびに最新値で更新される。 | [`05-install-and-infrastructure.md#タスク状態の拡張フィールドresume-用`](05-install-and-infrastructure.md#タスク状態の拡張フィールドresume-用), [`05-install-and-infrastructure.md#メッセージング`](05-install-and-infrastructure.md#メッセージング) | SESSION_STARTED / resume |

**関連 spec**: [`00-project-overview.md`](00-project-overview.md) / [`08-runtime-boundary.md`](08-runtime-boundary.md) / [`../../CLAUDE.md`](../../CLAUDE.md)

## 3. Task FSM 状態（6 値 + 関連）

`disconnected` は Conductor 側の状態だが、disconnect timeout で Task が `aborted` に
遷移する連動関係があるため glossary でも併載する。

| 用語 | 定義 | 一次リンク | 関連 |
|------|------|-----------|------|
| draft | 下書き状態。assign されない。`create-task` のデフォルト、または親タスク abort の cascade で戻る。 | [`07-state-machine.md#21-状態一覧-6-値`](07-state-machine.md#21-状態一覧-6-値) | ready / cascade |
| ready | 実行待ち。assignable な状態。`update-task --status ready` で昇格、昇格時は sync state ガードが走る。 | [`07-state-machine.md#21-状態一覧-6-値`](07-state-machine.md#21-状態一覧-6-値), [`../../CLAUDE.md#ready-昇格時の-sync-state-ガード`](../../CLAUDE.md#ready-昇格時の-sync-state-ガード) | sync state / draft |
| assigned | Conductor に割り当て済み。`assignTask` 成功で遷移。assigned のタスク本文の編集は禁止（変更は `abort-task` → 新タスク）。 | [`07-state-machine.md#21-状態一覧-6-値`](07-state-machine.md#21-状態一覧-6-値), [`../../CLAUDE.md#タスクの作成更新は-cli-経由直接ファイル操作禁止`](../../CLAUDE.md#タスクの作成更新は-cli-経由直接ファイル操作禁止) | Conductor (assigning/running) |
| closed | 正常完了。`close-task` 必須引数 `--deliverable-kind` で kind を指定。auto-close 経路は `kind: "none"` を daemon が自動付与。 | [`07-state-machine.md#21-状態一覧-6-値`](07-state-machine.md#21-状態一覧-6-値), [`05-install-and-infrastructure.md#cli-サブコマンド`](05-install-and-infrastructure.md#cli-サブコマンド) | Deliverable |
| aborted | 中止状態。`abort-task` CLI、disconnect timeout、user_clear、judgment_pending 等から遷移。`restart-task` で `ready` に戻せる。 | [`07-state-machine.md#21-状態一覧-6-値`](07-state-machine.md#21-状態一覧-6-値), [`07-state-machine.md#24-cascade-ルール-t241`](07-state-machine.md#24-cascade-ルール-t241) | cascade / restart-task |
| deleted | 明示削除（終端）。draft / ready からのみ遷移可能。assigned は `abort-task` を使う。 | [`07-state-machine.md#21-状態一覧-6-値`](07-state-machine.md#21-状態一覧-6-値) | delete-task |
| disconnected | （Conductor 状態だが Task と連動）Claude プロセス不在 / SessionEnd / PID 死。`DISCONNECT_TIMEOUT_SEC`（300s）超過で `broken` に遷移し、紐づくタスクは `aborted` + cascade。 | [`07-state-machine.md#11-状態一覧-7-値`](07-state-machine.md#11-状態一覧-7-値), [`07-state-machine.md#3-conductor--task-の同時遷移`](07-state-machine.md#3-conductor--task-の同時遷移) | broken / cascade |

**関連 spec**: [`07-state-machine.md`](07-state-machine.md)

## 4. Task 属性

| 用語 | 定義 | 一次リンク | 関連 |
|------|------|-----------|------|
| run_after_all | 「全 open タスクが closed になってから実行」する非排他 drain 属性。CLI フラグは `--run-after-all`。 | [`../../CLAUDE.md#タスク属性`](../../CLAUDE.md#タスク属性), [`07-state-machine.md`](07-state-machine.md) | exclusive / drain |
| exclusive | drain 後に単独実行。assigned の間は他の全 assignment を停止する排他属性。CLI フラグは `--exclusive`。複数 `--exclusive` は ID 昇順で順次実行。 | [`../../CLAUDE.md#タスク属性`](../../CLAUDE.md#タスク属性), [`07-state-machine.md`](07-state-machine.md) | run_after_all |
| depends_on | タスク間依存関係。親タスクが `aborted` / `deleted` に遷移すると `ready` 子は `draft` に戻される（cascade）。 | [`07-state-machine.md#24-cascade-ルール-t241`](07-state-machine.md#24-cascade-ルール-t241), [`05-install-and-infrastructure.md#cli-サブコマンド`](05-install-and-infrastructure.md#cli-サブコマンド) | cascade |
| base_branch | task.md 冒頭で明示する worktree 起点ブランチ。明示時は `worktree-base.ts:resolveWorktreeBase` の最優先（`explicit`）として採用される。 | [`05-install-and-infrastructure.md#teamconfigjson初回起動時に自動生成`](05-install-and-infrastructure.md#teamconfigjson初回起動時に自動生成) | start-point / mainBranch |

**関連 spec**: [`../../CLAUDE.md#タスク属性`](../../CLAUDE.md#タスク属性) / [`07-state-machine.md`](07-state-machine.md)

## 5. Conductor FSM 状態（7 値）

| 用語 | 定義 | 一次リンク | 関連 |
|------|------|-----------|------|
| starting | `CONDUCTOR_REGISTERED` 直後。Claude プロセス未確認の初期状態。60 秒で disconnected へ TIMEOUT。 | [`07-state-machine.md#11-状態一覧-7-値`](07-state-machine.md#11-状態一覧-7-値) | REGISTERED |
| idle | タスク割当可能な定常状態。Claude セッション確立済み。`SESSION_STARTED` 到達または `resetConductor` で遷移。 | [`07-state-machine.md#11-状態一覧-7-値`](07-state-machine.md#11-状態一覧-7-値) | assignTask |
| assigning | `assignTask` で `/clear` 送信済みかつ `SESSION_STARTED` 未到達の中間状態。60 秒で disconnected。 | [`07-state-machine.md#11-状態一覧-7-値`](07-state-machine.md#11-状態一覧-7-値) | running |
| running | タスク実行中。`SESSION_STARTED(source=clear)` または `SESSION_ACTIVE(hasTaskRunId)` で遷移。 | [`07-state-machine.md#11-状態一覧-7-値`](07-state-machine.md#11-状態一覧-7-値) | assigning / DONE |
| asking | `AskUserQuestion` を Notification hook で受信した状態。ユーザー入力待ち（T181）。 | [`07-state-machine.md#11-状態一覧-7-値`](07-state-machine.md#11-状態一覧-7-値), [`05-install-and-infrastructure.md#メッセージング`](05-install-and-infrastructure.md#メッセージング) | SESSION_ASK |
| disconnected | Claude プロセス不在 / SessionEnd / PID 死。300 秒超過で `broken` へ遷移。 | [`07-state-machine.md#11-状態一覧-7-値`](07-state-machine.md#11-状態一覧-7-値) | PID watcher / broken |
| broken | disconnected 300s 超過の **終端状態**。`cmux-team clear-conductor` のみで解除。 | [`07-state-machine.md#11-状態一覧-7-値`](07-state-machine.md#11-状態一覧-7-値), [`07-state-machine.md#15-不変条件`](07-state-machine.md#15-不変条件) | disconnected |

**関連 spec**: [`07-state-machine.md`](07-state-machine.md)

## 6. Token Pool

| 用語 | 定義 | 一次リンク | 関連 |
|------|------|-----------|------|
| handle | token の表示識別子（`@pers`、`@kddi` 等）。display name の先頭 4 文字を `@xxxx` 形式に変換。**変更不可**。 | [`09-token-pool.md#cli-コマンド`](09-token-pool.md#cli-コマンド), [`09-token-pool.md#db-スキーマcmux-teamtokensdb`](09-token-pool.md#db-スキーマcmux-teamtokensdb) | organization_id / rotate |
| plan | token の契約プラン。`pro` / `max-x5` / `max-x20` / `unknown` のいずれか。`rateLimitTier` から自動解決される。 | [`09-token-pool.md#cli-コマンド`](09-token-pool.md#cli-コマンド) | plan_ratio / set-plan |
| plan_ratio | plan の流量倍率（pro=1.0 / max-x5=5.0 / max-x20=20.0 / unknown=NULL）。pool_capacity の重み付けに使う。 | [`09-token-pool.md#cli-コマンド`](09-token-pool.md#cli-コマンド), [`09-token-pool.md#pool_capacity-指標`](09-token-pool.md#pool_capacity-指標) | pool_capacity |
| selectable | token が候補化対象かのフラグ。auto-discover 登録は `selectable=0`、明示登録は `selectable=1`。`effectiveDefault` 一致時のみ runtime 昇格。 | [`09-token-pool.md#db-スキーマcmux-teamtokensdb`](09-token-pool.md#db-スキーマcmux-teamtokensdb), [`09-token-pool.md#auto-discover`](09-token-pool.md#auto-discover) | auto-discover |
| tags（hint 体系） | token 側の hint。`any` / `oss-only` / `org:<name>` / `auto`。**ACL ではない**（プロジェクト側の `default` / `include` / `exclude` が ACL を担う）。 | [`09-token-pool.md#タグ設計hint-体系`](09-token-pool.md#タグ設計hint-体系) | project default-include-exclude |
| project default / include / exclude | プロジェクト config（`.team/config.json: tokenPool`）の token 候補制御。`default` は無条件 admit、`include` は tags 不問 admit、`exclude` は最優先除外。 | [`09-token-pool.md#プロジェクト設定teamconfigjson`](09-token-pool.md#プロジェクト設定teamconfigjson) | tags / OSS project |
| auto-discover | proxy が未知 token（`auth_hash` 不一致）を検出した際に tokens.db に自動 INSERT する仕組み。`selectable=0` / `tags=["auto"]` / Keychain 未登録。pool 機能 OFF では走らない（T341）。 | [`09-token-pool.md#auto-discover`](09-token-pool.md#auto-discover) | promote / selectable |
| credential_source | token の認証情報をどこが管理しているか。`manual` / `subscription` / `auto-discover` の 3 種（T391 で `claude-credentials` を廃止）。`manual` は keychain 保存 + spawn-agent inject、`subscription` は keychain 不保存 + inject せず Claude Code 本体の認証経路に委ねる、`auto-discover` は proxy 観測専用で `selectable=0`。 | [`09-token-pool.md#credential_sourcet391-で再整理`](09-token-pool.md#credential_sourcet391-で再整理) | subscription / manual / auto-discover |
| subscription（credential_source） | Claude Max 等の subscription token。Claude Code 本体が `~/.claude/.credentials.json` で refresh 管理するため cmux-team は keychain に snapshot しない。`cmux-team token add --subscription <handle>` で登録、proxy が初回観測で `auth_hash` / `organization_id` を埋める（T391 で導入、Dear T340 401 障害の対策）。 | [`09-token-pool.md#credential_sourcet391-で再整理`](09-token-pool.md#credential_sourcet391-で再整理) | credential_source / shouldInjectCredential |
| lease | spawn-agent 時に取得する short-term reservation（120 秒 TTL）。race を atomic INSERT OR IGNORE で吸収する。 | [`09-token-pool.md#token-選択アルゴリズムselecttoken`](09-token-pool.md#token-選択アルゴリズムselecttoken), [`09-token-pool.md#db-スキーマcmux-teamtokensdb`](09-token-pool.md#db-スキーマcmux-teamtokensdb) | selectToken |
| pool_capacity | 「Max x20 を 100% とした持続可能流量の比率」指標。`flow_i = min(remaining_5h, remaining_7d) * plan_ratio / time` の合計を `REFERENCE_FLOW (= 20.0/168)` で割った百分率。 | [`09-token-pool.md#pool_capacity-指標`](09-token-pool.md#pool_capacity-指標) | plan_ratio |
| effectiveDefault | 候補抽出で「無条件 admit」となる handle。`tokenPool.default ?? (isOss ? globalConfig.oss_default : null)` で決まる。 | [`09-token-pool.md#token-選択アルゴリズムselecttoken`](09-token-pool.md#token-選択アルゴリズムselecttoken) | OSS / default |

**関連 spec**: [`09-token-pool.md`](09-token-pool.md)

## 7. テンプレート変数

| 用語 | 定義 | 一次リンク | 関連 |
|------|------|-----------|------|
| `{{VARIABLE}}` | テンプレート（`skills/cmux-team/templates/{ja,en}/*.md`）のプレースホルダー総称。Conductor / daemon が spawn 時に置換し、ランタイム prompt（`.team/prompts/`）として書き出す。**全変数一覧は 04-templates.md を参照。** | [`04-templates.md#テンプレート変数一覧`](04-templates.md#テンプレート変数一覧) | テンプレート / overlay |
| `{{COMMON_HEADER}}` | common-header.md（全エージェント共通ヘッダー）の展開結果。Agent ロール 8 件すべてで使用。 | [`04-templates.md#common-header全エージェント共通`](04-templates.md#common-header全エージェント共通) | Agent |
| `{{PROJECT_INSTRUCTIONS}}` | overlay placeholder。`.team/agent-instructions/<role>.md` の内容で置換される。Master / Conductor 用は daemon 起動時に直接展開（T247 / T342）。 | [`04-templates.md#project_instructions-プレースホルダt247--t342`](04-templates.md#project_instructions-プレースホルダt247--t342) | overlay / OverlayRole |
| `{{TASK_CONTENT}}` | タスク定義の本文。`conductor-task` / `planner` / `design-reviewer` / `inspector` で使用。 | [`04-templates.md#テンプレート変数一覧`](04-templates.md#テンプレート変数一覧) | Task |
| `{{OUTPUT_DIR}}` | 出力ディレクトリパス（`.team/tasks/TNNN-slug/runs/<taskRunId>/`）。planner はここに `plan.md` を書く。 | [`04-templates.md#テンプレート変数一覧`](04-templates.md#テンプレート変数一覧) | TaskRun |
| `{{OUTPUT_FILE}}` | 個別 Agent の出力ファイルパス（researcher / architect / design-reviewer / implementer / inspector / dockeeper / task-manager）。 | [`04-templates.md#テンプレート変数一覧`](04-templates.md#テンプレート変数一覧) | OUTPUT_DIR |
| `{{WORKTREE_PATH}}` | git worktree の絶対パス。conductor / conductor-task で使用。 | [`04-templates.md#テンプレート変数一覧`](04-templates.md#テンプレート変数一覧) | Worktree |
| `{{MAIN_BRANCH}}` | プロジェクト主開発ブランチ名。解決順位は env > config > `git symbolic-ref` 自動検出。T253 で fail-stop。 | [`04-templates.md#テンプレート変数一覧`](04-templates.md#テンプレート変数一覧), [`05-install-and-infrastructure.md#teamconfigjson初回起動時に自動生成`](05-install-and-infrastructure.md#teamconfigjson初回起動時に自動生成) | base_branch |
| `{{BASE_BRANCH}}` | タスクの target ブランチ。未指定時は `mainBranch` と同値（T253 で `"main"` リテラルフォールバック廃止）。 | [`04-templates.md#テンプレート変数一覧`](04-templates.md#テンプレート変数一覧) | mainBranch |

**関連 spec**: [`04-templates.md`](04-templates.md)

## 8. Sync state（git 同期判定）

| 用語 | 定義 | 一次リンク | 関連 |
|------|------|-----------|------|
| Ready sync guard | `update-task --status ready` 昇格時に走る local ↔ `origin/<mainBranch>` 同期判定。`diverged` / `uncommitted` / `detached` は exit 1（`ready_rejected`）。 | [`../../CLAUDE.md#ready-昇格時の-sync-state-ガード`](../../CLAUDE.md#ready-昇格時の-sync-state-ガード) | sync state / `--force` |
| diverged | local と origin が双方独自の commit を持つ状態。Ready 昇格を拒否する。 | [`../../CLAUDE.md#ready-昇格時の-sync-state-ガード`](../../CLAUDE.md#ready-昇格時の-sync-state-ガード) | Ready sync guard |
| uncommitted | working tree に未コミットの変更がある状態。Ready 昇格を拒否する。 | [`../../CLAUDE.md#ready-昇格時の-sync-state-ガード`](../../CLAUDE.md#ready-昇格時の-sync-state-ガード) | Ready sync guard |
| detached | HEAD がブランチに紐づいていない（detached HEAD）。Ready 昇格を拒否する。 | [`../../CLAUDE.md#ready-昇格時の-sync-state-ガード`](../../CLAUDE.md#ready-昇格時の-sync-state-ガード) | Ready sync guard |
| behind-ff | local が origin より strict behind かつ fast-forward 可能。`mainBranch` checkout 中なら自動 `git pull --ff-only`、それ以外は警告のみで昇格続行。 | [`../../CLAUDE.md#ready-昇格時の-sync-state-ガード`](../../CLAUDE.md#ready-昇格時の-sync-state-ガード) | `--no-auto-pull` |
| no-remote | upstream remote が無い状態。警告のみで昇格続行。 | [`../../CLAUDE.md#ready-昇格時の-sync-state-ガード`](../../CLAUDE.md#ready-昇格時の-sync-state-ガード) | Ready sync guard |
| `CMUX_TEAM_SKIP_SYNC_CHECK` | sync check 全体を skip する環境変数（Conductor / Agent 環境に自動注入される）。 | [`../../CLAUDE.md#ready-昇格時の-sync-state-ガード`](../../CLAUDE.md#ready-昇格時の-sync-state-ガード), [`09-token-pool.md#機能-onoff3-階層`](09-token-pool.md#機能-onoff3-階層) | `--force` |

**関連 spec**: [`../../CLAUDE.md#ready-昇格時の-sync-state-ガード`](../../CLAUDE.md#ready-昇格時の-sync-state-ガード)

## 9. Worktree / start-point 解決

`worktree-base.ts:resolveWorktreeBase` の 5 階層（T242 / T275）。優先順位順。

| 用語 | 定義 | 一次リンク | 関連 |
|------|------|-----------|------|
| explicit | task.md frontmatter に `base_branch:` が明示された場合に採用される最優先 source。 | [`05-install-and-infrastructure.md#teamconfigjson初回起動時に自動生成`](05-install-and-infrastructure.md#teamconfigjson初回起動時に自動生成) | base_branch |
| config-local-ahead | local `<mainBranch>` が `origin/<mainBranch>` より strict ahead（同一 SHA でない・origin が ancestor）の場合に採用（T275）。push しない運用や stale origin から worktree が切られるのを防ぐ。 | [`05-install-and-infrastructure.md#teamconfigjson初回起動時に自動生成`](05-install-and-infrastructure.md#teamconfigjson初回起動時に自動生成) | mainBranch / fetch-before-worktree |
| config-origin | `origin/<mainBranch>` が存在する場合に採用される通常 source。 | [`05-install-and-infrastructure.md#teamconfigjson初回起動時に自動生成`](05-install-and-infrastructure.md#teamconfigjson初回起動時に自動生成) | mainBranch |
| config-local | local `<mainBranch>` のみ存在する場合に採用。 | [`05-install-and-infrastructure.md#teamconfigjson初回起動時に自動生成`](05-install-and-infrastructure.md#teamconfigjson初回起動時に自動生成) | mainBranch |
| head-fallback | 上記すべてが解決できない場合の HEAD フォールバック。最終手段。 | [`05-install-and-infrastructure.md#teamconfigjson初回起動時に自動生成`](05-install-and-infrastructure.md#teamconfigjson初回起動時に自動生成) | (なし) |
| `CMUX_TEAM_FETCH_BEFORE_WORKTREE` | worktree 作成前に `git fetch --quiet origin <mainBranch>` を行うかの環境変数。T283 でデフォルト ON に反転。 | [`05-install-and-infrastructure.md#teamconfigjson初回起動時に自動生成`](05-install-and-infrastructure.md#teamconfigjson初回起動時に自動生成) | config-local-ahead / config-origin |

**関連 spec**: [`05-install-and-infrastructure.md`](05-install-and-infrastructure.md)

## 10. コミュニケーション系

| 用語 | 定義 | 一次リンク | 関連 |
|------|------|-----------|------|
| Trace DB | `.team/traces/traces.db`（SQLite + FTS5）。Anthropic API リクエスト/レスポンス・hook signal・api_usage を記録。検索は `cmux-team trace` / `trace-task` / `trace-hooks`。 | [`05-install-and-infrastructure.md#プロキシサーバー`](05-install-and-infrastructure.md#プロキシサーバー), [`../../CLAUDE.md#通信プロトコル`](../../CLAUDE.md#通信プロトコル) | proxy / hook_signals |
| events stream | 外向け event channel。Manager daemon が `.team/logs/events.jsonl` に JSONL で append し、Master watch mode や `cmux-team events` CLI が購読する。schema v2、16 event 種、append-only（rotate なし）。 | [`10-events-stream.md`](10-events-stream.md) | event channel / EventBus / Trace DB |
| event channel | Manager daemon が外向けに公開する event の論理チャネル。`.team/logs/events.jsonl`（events stream）として実装される。daemon プロセス内 EventBus（`notifyStateChanged`）とは別レイヤー。 | [`10-events-stream.md#1-概要`](10-events-stream.md#1-概要) | events stream / EventBus |
| hook | Claude Code が発行する SessionStart / Stop / Notification / PreToolUse / PostToolUse / SessionEnd 等のイベント。hook shell には分岐ロジックを持たせず、全イベントを daemon に転送する。 | [`../../CLAUDE.md#実装ルールガードレール`](../../CLAUDE.md#実装ルールガードレール), [`05-install-and-infrastructure.md#メッセージング`](05-install-and-infrastructure.md#メッセージング) | hook_signals / Trace DB |
| EventBus | daemon プロセス内の **実 state mutation** → TUI refresh を疎結合に接続する EventEmitter ラッパー（`eventBus.ts`）。`notifyStateChanged` / `onStateChanged` のみ使用可（`bus.emit` / `bus.on` 直接呼び出しは禁止）。 | [`05-install-and-infrastructure.md#event-catalogeventbusts`](05-install-and-infrastructure.md#event-catalogeventbusts), [`../../CLAUDE.md#実装ルールガードレール`](../../CLAUDE.md#実装ルールガードレール) | state mutation |
| queue | daemon の HTTP プロキシが受け口を兼ねるメッセージキュー。CLI（`cmux-team send <TYPE>`）から POST されたメッセージを受信。旧ファイルベース `queue.ts` は廃止済み。 | [`05-install-and-infrastructure.md#メッセージング`](05-install-and-infrastructure.md#メッセージング) | proxy |
| done marker | Conductor 完了通知用ファイル（`.team/tasks/TNNN-slug/runs/<taskRunId>/done`）。Manager は fs.watch + PID ベース生存確認（`spawnPidWatcher`）で完了検出する（pull 型）。 | [`00-project-overview.md#core-concept`](00-project-overview.md#core-concept), [`../../CLAUDE.md#manager-プロトコル概要`](../../CLAUDE.md#manager-プロトコル概要) | Conductor / await-agent |
| journal | `task-state.json` 内に記録される状態遷移の監査ログ（`task_aborted` / `task_completed` / `parent_aborted: <id>` 等）。 | [`07-state-machine.md#24-cascade-ルール-t241`](07-state-machine.md#24-cascade-ルール-t241), [`../../CLAUDE.md#エラーリカバリ`](../../CLAUDE.md#エラーリカバリ) | cascade |
| CONDUCTOR_DONE | Conductor から daemon に送る完了メッセージ。`success: true` で正常 close、`unresolved: true` で `aborted` + cascade（preserveWorktree）。 | [`07-state-machine.md#3-conductor--task-の同時遷移`](07-state-machine.md#3-conductor--task-の同時遷移), [`05-install-and-infrastructure.md#メッセージング`](05-install-and-infrastructure.md#メッセージング) | DONE / Task FSM |

**関連 spec**: [`05-install-and-infrastructure.md`](05-install-and-infrastructure.md) / [`07-state-machine.md`](07-state-machine.md) / [`10-events-stream.md`](10-events-stream.md) / [`../../CLAUDE.md`](../../CLAUDE.md)
