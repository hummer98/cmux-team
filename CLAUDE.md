# cmux-team

Claude Code + cmux によるマルチエージェント開発オーケストレーションのスキル/コマンドパッケージ。
Master（ユーザー対話）→ Manager（イベント駆動監視）→ Conductor（タスク実行）→ Agent（実作業）の4層構造。

## プロジェクトミッション

**cmux のターミナルマルチプレクサ機能を活用し、Claude Code の複数セッションを協調させて開発タスクを自律的に遂行できるようにする。**

### ゴール

1. **ユーザーは指示を出すだけ** — 実装・テスト・レビューは全てエージェントが行う
2. **進捗が見える** — cmux のペイン分割でエージェントの作業がリアルタイムに可視化される
3. **安全に失敗できる** — git worktree 隔離により main は常に無傷
4. **プラグインとして誰でもインストールできる** — Claude Code Plugin として配布

### 設計原則

| 原則 | 意味 |
|------|------|
| **上位が下位を監視する（pull 型）** | 下位からの push 報告に依存しない。セマンティック動作の信頼性問題を回避 |
| **決定論的なものはコードで、判断が必要なものは AI で** | イベント検出は確実に、意思決定は柔軟に |
| **各層は自分の仕事だけをする** | Master は作業しない、Agent は報告しない、Conductor はユーザーに聞かない |
| **逸脱を防ぐより、逸脱しても安全な構造にする** | worktree 隔離 + 事後レビュー |
| **シンプルさを優先** | 動くものを最小構成で。過剰な抽象化を避ける |

## 判断基準と優先順位

### タスクの優先順位（高→低）

1. **バグ修正** — 既存機能が壊れている場合は最優先
2. **実験で発見された問題の修正** — 実際に動かして判明した issue（#12 のような具体的な失敗事例）
3. **ユーザー体験の改善** — インストール・起動・操作が簡単になる変更
4. **ドキュメントの正確性** — README や SKILL.md が実装と乖離していれば修正
5. **新機能** — 新しいエージェントロールやコマンドの追加
6. **最適化** — パフォーマンス、トークン消費、レート制限対策

### 判断に迷ったとき

- **「動くか？」が最優先** — 理論的な美しさより実際に動作すること
- **実験で検証してから本実装** — cmux-team-lab 等で試してから SKILL.md に反映
- **既存の動作を壊さない** — CLI コマンドのインターフェースを安定させる
- **ユーザーに聞く** — 設計判断で迷ったら issue を作ってユーザーの判断を仰ぐ

## GitHub issue 作成ガイドライン

> **注意:** ここでの「issue」は GitHub issue を指す。ローカルのタスク管理（`.team/tasks/`）とは別の概念。

### issue を作成すべき場面

- 実験中に発見した具体的な失敗パターン（再現手順付き）
- SKILL.md の指示と実際のエージェント動作の乖離
- cmux 側の制約による回避策が必要な場合
- 設計判断が必要で、複数の選択肢がある場合

### issue に含めるべき情報

- **問題**: 何が起きたか（発生事例があれば具体的に）
- **原因**: なぜ起きたか
- **修正内容**: 具体的な変更案（ファイル名・セクション番号まで）
- **対象ファイル**: 修正が必要なファイル一覧

### issue を作成すべきでない場面

- typo やフォーマットの軽微な修正 → 直接コミットでよい
- 明らかなバグ修正 → 直接コミットでよい
- 将来的な夢の機能 → 現在のゴールに集中する

## リポジトリ構造

```
cmux-team/
├── .claude-plugin/
│   ├── plugin.json                   # プラグインマニフェスト
│   └── marketplace.json              # Marketplace カタログ
├── package.json                      # npm パッケージ定義
├── .npmignore                        # npm publish 除外設定
├── bin/
│   ├── cmux-team.js                  # CLI エントリポイント
│   └── postinstall.js                # npm postinstall スクリプト
├── skills/
│   ├── cmux-team/
│   │   ├── SKILL.md                  # 4層アーキテクチャ定義スキル
│   │   ├── manager/                  # Manager daemon（TypeScript / Bun）
│   │   │   ├── main.ts               #   CLI エントリー（サブコマンド実装）
│   │   │   ├── daemon.ts             #   メインループ・ファイル監視
│   │   │   ├── conductor.ts          #   Conductor 初期化・タスク割当・監視
│   │   │   ├── master.ts             #   Master spawn・監視
│   │   │   ├── cmux.ts               #   cmux コマンドラッパー
│   │   │   ├── proxy.ts              #   ロギングプロキシ（API 透過傍受）
│   │   │   ├── queue.ts              #   メッセージキュー
│   │   │   ├── trace-store.ts        #   SQLite FTS5 トレース
│   │   │   ├── task.ts               #   タスク管理
│   │   │   ├── template.ts           #   プロンプトテンプレート展開
│   │   │   ├── artifact.ts           #   アーティファクト管理
│   │   │   ├── dashboard.tsx         #   TUI ダッシュボード
│   │   │   ├── logger.ts             #   ログ出力
│   │   │   ├── schema.ts             #   Zod スキーマ定義
│   │   │   └── package.json          #   Bun 依存関係
│   │   └── templates/                # エージェントプロンプトテンプレート (14個)
│   │       ├── common-header.md      #   全エージェント共通ヘッダー
│   │       ├── master.md             #   Master ロール
│   │       ├── manager.md            #   Manager ロール
│   │       ├── conductor.md          #   Conductor ロール（旧）
│   │       ├── conductor-role.md     #   Conductor 常駐ロール
│   │       ├── conductor-task.md     #   Conductor タスク割り当て時プロンプト
│   │       ├── researcher.md         #   リサーチャーロール
│   │       ├── architect.md          #   アーキテクトロール
│   │       ├── planner.md            #   計画立案ロール
│   │       ├── design-reviewer.md    #   設計レビューロール
│   │       ├── implementer.md        #   実装者ロール
│   │       ├── inspector.md          #   検品ロール
│   │       ├── dockeeper.md          #   ドキュメント管理者ロール
│   │       └── task-manager.md       #   タスク管理者ロール
│   └── cmux-agent-role/
│       └── SKILL.md                  # サブエージェント行動規範スキル
├── commands/                         # スラッシュコマンド定義 (5個)
│   ├── master.md                     #   Master ロール再読み込み（/clear 復帰用）
│   ├── team-spec.md                  #   要件ブレスト（対話型）
│   ├── team-task.md                  #   タスク管理
│   ├── team-archive.md              #   完了タスクのアーカイブ
│   └── artifact.md                  #   知見のアーティファクト化
├── docs/
│   ├── spec/                         # 統合仕様書（実装と同期された仕様）
│   │   ├── 00-project-overview.md
│   │   ├── 01-skill-cmux-team.md
│   │   ├── 02-skill-cmux-agent-role.md
│   │   ├── 03-commands.md
│   │   ├── 04-templates.md
│   │   ├── 05-install-and-infrastructure.md
│   │   └── 06-implementation-tasks.md
│   ├── research/                     # リサーチドキュメント
│   └── slides/                       # プレゼン資料
├── CHANGELOG.md                      # 変更ログ
├── LICENSE                           # MIT
├── README.md                         # ユーザー向けドキュメント（英語）
└── README.ja.md                      # ユーザー向けドキュメント（日本語）
```

### 2つのスキルの役割分担

| スキル | 誰が読むか | 内容 |
|--------|-----------|------|
| `cmux-team` (SKILL.md) | Master（ユーザーセッション） | 4層アーキテクチャ全体の定義、Master 行動原則 |
| `cmux-agent-role` (SKILL.md) | Agent（実作業エージェント） | 出力プロトコル・タスク作成・作業境界 |

### docs/spec/（統合仕様書）

実装と同期された統合仕様書。各ファイルはプロジェクトの設計・実装仕様を定義しており、コード変更時に参照すべきドキュメント。

**cmux-team の仕様・挙動について質問された場合は、該当する `docs/spec/` のファイルを Read して回答すること。**

| ファイル | 内容 |
|---------|------|
| 00-project-overview.md | プロジェクト概要・4層アーキテクチャ・設計原則 |
| 01-skill-cmux-team.md | cmux-team スキル（SKILL.md）の仕様 |
| 02-skill-cmux-agent-role.md | cmux-agent-role スキル（SKILL.md）の仕様 |
| 03-commands.md | スラッシュコマンド定義 |
| 04-templates.md | エージェントプロンプトテンプレート仕様 |
| 05-install-and-infrastructure.md | インストール・インフラ構成 |
| 06-implementation-tasks.md | 実装タスク定義 |

## スキル・コマンドの追加・修正方法

### スキルの追加

1. `skills/<skill-name>/SKILL.md` を作成
2. YAML frontmatter に `name`, `description`（トリガー条件を含む）を記載
3. Markdown 本文にスキルの知識・プロトコルを記述

### コマンドの追加

1. `commands/<command-name>.md` を作成
2. YAML frontmatter に `allowed-tools`, `description` を記載
3. Markdown 本文に手順・引数仕様・注意事項を記述
4. `$ARGUMENTS` でユーザーからの引数を参照できる

### テンプレートの追加

1. `skills/cmux-team/templates/<role-name>.md` を作成
2. `{{VARIABLE}}` プレースホルダーを使用（下記参照）
3. Conductor（または Manager）が spawn 時にテンプレート変数を置換し `.team/prompts/` に書き出す

## テンプレート変数仕様

テンプレート内の `{{VARIABLE}}` プレースホルダーは、Conductor（または Manager）がプロンプト生成時に実際の値に置換する。

### 共通変数（common-header.md 由来）

| 変数 | 説明 |
|------|------|
| `{{ROLE_ID}}` | エージェントの識別子（例: `researcher-1`, `architect`） |
| `{{TASK_DESCRIPTION}}` | タスクの説明文 |
| `{{PROJECT_ROOT}}` | プロジェクトルートの絶対パス |

### Conductor 変数

| 変数 | 使用テンプレート | 説明 |
|------|----------------|------|
| `{{TASK_CONTENT}}` | conductor-task | タスクファイル本文 |
| `{{WORKTREE_PATH}}` | conductor, conductor-task | git worktree のパス |
| `{{OUTPUT_DIR}}` | conductor, conductor-task | 出力ディレクトリパス（例: `.team/output/<taskRunId>/`） |
| `{{CONDUCTOR_ID}}` | conductor, conductor-task | Conductor 実行 ID（`task-<NNN>-<timestamp>` 形式。例: `task-042-1712345678`） |
| `{{TASK_STATUS_FILE}}` | conductor, conductor-task | 完了マーカーファイルパス |
| `{{PROJECT_ROOT}}` | conductor-role | プロジェクトルートの絶対パス |
| `{{MAIN_BRANCH}}` | conductor-role, conductor-task | プロジェクトの主開発ブランチ名（`.team/config.json` の `mainBranch` または `git symbolic-ref refs/remotes/origin/HEAD` で自動検出。T213 で追加） |

### Agent ロール固有変数

| 変数 | 使用テンプレート | 説明 |
|------|----------------|------|
| `{{COMMON_HEADER}}` | 全 Agent ロール | common-header.md の展開結果 |
| `{{OUTPUT_FILE}}` | 全 Agent ロール | 出力ファイルパス（例: `.team/output/researcher-1.md`） |
| `{{TOPIC}}` | researcher | リサーチトピック |
| `{{SUB_QUESTIONS}}` | researcher | 調査すべきサブ質問リスト |
| `{{REQUIREMENTS_CONTENT}}` | architect | requirements.md の内容 |
| `{{RESEARCH_SUMMARY}}` | architect | リサーチ結果の要約 |
| `{{CODEBASE_CONTEXT}}` | architect | 既存コードベースのコンテキスト |
| `{{PLAN_CONTENT}}` | planner, design-reviewer, implementer, inspector | plan.md の内容 |
| `{{TASK_CONTENT}}` | planner, design-reviewer, inspector | タスク内容 |
| `{{DESIGN_CONTENT}}` | implementer | design.md の内容 |
| `{{TASKS_CONTENT}}` | implementer | tasks.md のアサインされたタスク |
| `{{SPECS_CONTENT}}` | dockeeper | 現在の仕様書全体 |
| `{{LAST_SNAPSHOT_SUMMARY}}` | dockeeper | 前回の docs スナップショットの要約 |
| `{{OPEN_TASKS_LIST}}` | task-manager | オープンタスクの一覧 |

## インストール方法

```bash
npm install -g @hummer98/cmux-team
```

`postinstall` スクリプトにより manager/ の依存関係が自動解決される。

## テスト方法

自動テストはない。以下の手順で E2E テストを行う。

### 前提

- cmux がインストールされていること
- Claude Code が利用可能であること（Claude Max 推奨）

### インストールテスト

```bash
# グローバルインストール
npm install -g @hummer98/cmux-team
# → ~/.claude/ にスキル・コマンド・テンプレートが配置されること
# → cmux-team コマンドが利用可能になること

# アンインストール
npm uninstall -g @hummer98/cmux-team
```

### 機能テスト（ターミナルで実行）

```bash
# 1. cmux を起動
cmux

# 2. チーム体制構築（daemon + Master + Conductor 起動）
cmux-team start
# → .team/ が作成され team.json が正しいこと
# → daemon が起動し Manager として機能すること
# → Master Claude セッションが spawn されること
# → 3つの Conductor が固定ペインに配置されること

# 3. タスク作成（Master セッション内で）
cmux-team create-task --title "テストタスク" --status ready --body "テスト用"
# → .team/tasks/ にタスクファイルが作成されること
# → daemon がタスクを検出し idle Conductor に割り当てること
# → Conductor がタスクを自律実行すること

# 4. ステータス確認
cmux-team status
# → daemon 状態、Conductor 一覧、タスク数、ログが表示されること

# 5. クリーンアップ
cmux-team stop
# → daemon が graceful shutdown すること
```

### 確認ポイント

- 4層構造（Master → Manager(daemon) → Conductor → Agent）が正しく機能すること
- daemon がタスクを検出し idle Conductor に割り当てること
- Conductor がタスク完了後に done マーカーを作成し idle に戻ること
- Agent は git worktree 内で作業し、メインブランチを汚さないこと
- `cmux send` 後に `cmux send-key return` で送信されること
- Trust 確認が出た場合に自動承認されること

## コーディング規約

- **ドキュメント・コメント**: 日本語
- **コード（変数名・関数名・コマンド）**: 英語
- スキルは YAML frontmatter + Markdown
- コマンドは YAML frontmatter（`allowed-tools`, `description`）+ Markdown
- テンプレートは `{{VARIABLE}}` プレースホルダーを使用
- README.md やユーザー向けテキストは日本語

### 開発者用スキル

別プロジェクト（mado, Dear 等）の `.team/` 調査は `.claude/skills/cmux-team-investigate/SKILL.md` を参照。
このスキルはこのリポジトリのワークツリー内でのみ有効で、npm publish には含まれない（配布外）。

## cmux API 使用上の注意

`cmux tree` はデフォルトで**全ワークスペース**のsurfaceを返す。
複数のワークスペースで cmux-team を同時起動している場合、別ワークスペースのsurface IDと混同する原因になる。

以下のルールを守ること：

- `validateSurface(surface)` ではなく `validateSurface(surface, workspace)` を使う
- `tree()` ではなく `tree(workspace)` を使う（`cmux tree --workspace <id>` に対応）
- daemon の `state.workspace` に起動時のワークスペースが格納されている（`main.ts` 起動時に `getCallerWorkspace()` で取得・設定）
- `getCallerWorkspace()` で呼び出し元のワークスペースを取得できる（`cmux identify` の `caller.workspace_ref`）
- 既存surfaceの検証（`initializeLayout`, `isMasterAlive`, `checkConductorStatus` など）では必ず workspace を渡す
- `newSplit` 直後など**新規作成したsurface**は現在のワークスペースに確実に属するため、workspace指定は不要

## ロギングポリシー

Manager daemon（`skills/cmux-team/manager/`）のロギングに関するルール。

### ログインターフェース

`logger.ts` の `log(event, detail)` を使用する。イベント名でレベルを区別する。

| イベント名パターン | 用途 | 例 |
|-------------------|------|-----|
| `error` | 操作失敗・例外 | `log("error", "assignTask failed: ...")` |
| `*_failed` | 特定操作の失敗 | `log("proxy_start_failed", ...)` |
| `*_started`, `*_completed` | ライフサイクルイベント | `log("daemon_started", ...)` |
| その他 | 状態変化・判断記録 | `log("conductor_reset", ...)` |

### 必ずログすべきイベント

1. **例外捕捉時**: `catch` で例外を処理する場合、最低限 `log("error", ...)` でメッセージを記録する
2. **外部コマンド失敗時**: cmux コマンド（`send`, `sendKey`, `tree` 等）の失敗は `log("error", ...)` で記録する。**error オブジェクトに `stderr` / `stdout` が付いている場合は必ず detail に含める**（`e.message` のみでは "Command failed: <cmd>" で終わり原因追跡が不能になる）。例: `log("error", \`tree failed: ${e.message} stderr=${e.stderr ?? ""}\`)`。
3. **判断分岐**: 複数パスがある場合、どのパスに入ったか記録する（例: done マーカー検出方法、フォールバック発動）
4. **状態遷移**: Conductor/Agent のステータス変化は必ず記録する（既存で実施済み）

### 禁止事項

- **空の `catch {}`**: 例外を完全に握りつぶさない。最低限ログを残す。ただし以下は例外として許容:
  - **冪等な後処理**（`closeSurface`, `renameTab`, `branch -d` 等）: 失敗しても影響がない操作
  - **存在チェック的な操作**（`validateSurface`, ファイル存在確認等）: 失敗＝不在として扱う設計
- **高頻度ループ内の過剰ログ**: `tick()` 毎回のログは不要。状態変化があった場合のみ記録する
- **機密情報のログ**: API キー、トークン等をログに含めない

### ログフォーマット

```
[2026-04-04T10:30:00+09:00] event_name key1=value1 key2=value2
```

- タイムスタンプはローカル TZ 付き ISO 8601（`logger.ts` の `localISOString()` が生成）
- detail は `key=value` のスペース区切り。値にスペースを含む場合はそのまま末尾に付与
- 1 行 1 イベント。複数行ログは避ける

#### surface 表記（T192）

surface はロール別プレフィックス + `[ID]` で表記する。生の `surface:NNN` や `surface=surface:NNN` は使わない。`formatSurface(surface, role)` / `formatPair(parent, child, pRole, cRole)`（`logger.ts`）を利用する。

| ロール | 意味 | 例 |
|-------|------|-----|
| `C` | Conductor | `C[665]` |
| `A` | Agent | `A[719]` |
| `M` | Manager (daemon) | `M[120]` |
| `U` | User session (Master) | `U[100]` |
| `S` | 不明（`cmux.ts` の低レベル箇所のみ） | `S[300]` |

親子関係は `>` で連結する: `C[665]>A[719]`（Conductor → Agent）。

例:

```
[2026-04-14T10:30:00+09:00] daemon_started v0.23.0 pid=12345 poll=10000ms ...
[2026-04-14T10:30:05+09:00] conductor_started C[665] task_id=T042 conductor_id=task-042-1712345678
[2026-04-14T10:31:00+09:00] agent_done C[665]>A[719] trigger=session_idle status=completed
```

`task_id=` / `conductor_id=` / `artifact_id=` / `pid=` 等の他のキーは従来通り `key=value` 形式を維持する。

## EventBus ポリシー

daemon 内の **実 state mutation** → TUI refresh は `eventBus.ts` 経由で通知する。

- `notifyStateChanged(source)` / `onStateChanged(cb)` のみ使用可
- `bus.emit` / `bus.on` の直接呼び出しは `eventBus.ts` 外では禁止（`rg "bus\.(emit|on)\b" skills/cmux-team/manager | rg -v eventBus.ts` で 0 件を維持）
- emit は **実際に state が変化した直後のみ**。中間処理の完了点（外部コマンド終了、ローカル変数更新）では emit しない。「emit 箇所 = state mutation 箇所」の不変条件を維持する
- source 引数は `"<ファイル>:<関数>:<理由>"` 形式で呼び出し位置を明示する
- `CMUX_TEAM_TRACE_EVENTS=1` で emit ログが `manager.log` に出力される
- `logger.ts` は `eventBus.ts` を import してはならない（循環依存禁止）

## プロンプト編集ルール（厳守）

**テンプレート (`skills/cmux-team/templates/*.md`) がソースオブトゥルース。** ランタイムプロンプト (`.team/prompts/*.md`) は派生物であり、直接編集してはならない。

| やること | やらないこと |
|---------|-------------|
| `skills/cmux-team/templates/master.md` を編集 | `.team/prompts/master.md` を直接編集 |
| `skills/cmux-team/templates/manager.md` を編集 | `.team/prompts/manager.md` を直接編集 |
| 編集後に `cmux-team start` で再生成 or テンプレートからコピー | ランタイムだけ書き換えて「動いた」で終わり |

**理由:** ランタイムプロンプトだけ書き換えると、テンプレートとの乖離が蓄積する。次回の `cmux-team start` や別プロジェクトでの起動時に変更が消失する。

プロンプトを変更する場合の手順:
1. `skills/cmux-team/templates/*.md` を編集
2. `.team/prompts/*.md` にコピー（または `cmux-team start` で再生成）
3. 他プロジェクト（Dear 等）のランタイムプロンプトも更新
4. コミット・リリース

## Manager プロトコル（内部実装）

TypeScript daemon（`skills/cmux-team/manager/main.ts`）として Bun で実行。キューベースのイベント駆動でタスク管理を行う。

- **ログ**: `.team/logs/manager.log` に状態変化を追記形式で記録（`conductor_started`, `task_completed`, `idle_start` 等）
- **状態確認**: `cmux-team status` で daemon 状態・Conductor 一覧・タスク数・ログ末尾を表示

### タスク検出

`task-state.json` で `status: ready` のタスクを検出し Conductor に割り当てる。なければ待機して再チェック。

### Conductor へのタスク割り当て

1. idle Conductor を検出（ConductorState の `status: "idle"` + surface 生存）
2. worktree 作成・プロンプト生成
3. Conductor surface に `/clear` + 新プロンプト送信

**Conductor は spawn しない。** 起動時に作成された固定ペインに対してタスクを送信するだけ。

### Conductor 監視（push + PID）

- **主要判定**: done マーカーファイル（`.team/output/conductor-N/done`）の存在で完了判定
- **生存確認**: 独自 hook の `SESSION_STARTED` / `SESSION_IDLE` / `SESSION_CLEAR` / `SESSION_ENDED` が daemon に push され、PID 単位で `spawnPidWatcher` が生存追跡（`process.kill(pid, 0)` を 1 秒間隔）
- **重要**: T195 以降 `cmux tree` / `cmux list-status` への依存は完全撤廃。Conductor / Agent / Master の生存確認は PID ベース + hook push に一本化

### タスクの作成・更新は CLI 経由（直接ファイル操作禁止）

タスクの作成・更新は必ず CLI を使うこと。`.team/tasks/` への直接ファイル書き込みは hook でブロックされる。

```bash
cmux-team create-task --title "タイトル" --status draft --body "説明"
cmux-team update-task --task-id 112 --status ready
```

> **注意:** `.team/artifacts/` は直接ファイル作成が前提だが、`.team/tasks/` は CLI 経由のみ。混同しないこと。

### assigned タスクの編集禁止

assigned 状態のタスクファイルの編集は禁止。Conductor は起動時のプロンプトのスナップショットで動作するため、タスクファイルの変更は実行中の作業に反映されない。変更が必要な場合: `abort-task` で中止 → 新タスク作成。

### 結果回収

完了検出後: ログ記録 → Conductor リセット（`/clear`）→ done マーカー削除。

Manager がやらないこと:
- タスクの close（Conductor が `cmux-team close-task` を実行）
- Conductor ペインの close（persistent — 閉じない）
- worktree の削除（Conductor の責務）
- マージ処理（Conductor が納品方法を判断する）

### ループ継続・アイドル化

- **Conductor 稼働中**: デフォルト10秒間隔（`CMUX_TEAM_POLL_INTERVAL`）で pull 型監視を実行
- **アイドル時（open tasks ゼロ）**: 停止して待機。`idle_start` をログ記録
- **起床トリガー**: `[TASK_CREATED]` 通知で再起動

### hook 全送信ポリシー（T216）

hook（SessionStart / Stop / SessionEnd 等）は **全イベントを Manager に転送する**。
フィルタリング・ルーティング・state 遷移判定は **Manager 側（daemon.ts handleMessage）で
のみ** 行う。hook の shell スクリプトには分岐ロジックを持たせない。

**根拠:**
- hook 側でフィルタすると、後からデバッグする際に「hook は発火したか」が追跡不能
- trace DB の `hook_signals` テーブルに全シグナルが記録されるため、事後解析が可能
- matcher は Claude Code 側の regex 仕様に依存するため、cmux-team 固有の判定を載せると脆くなる

**実装上の不変条件:**
- `handleMessage` の入口（switch 分岐より前）で必ず `insertHookSignal` を呼ぶ
- SessionEnd の `reason=other` は記録のみ行い state 遷移しない
  （`/clear` 等の曖昧な終了を disconnected と誤判定しないため）
- hook shell は `cmux-team send ... --from-stdin` で stdin JSON を
  そのまま転送する。hook 内で `--reason` をハードコードしない

**運用上の注意（hook_signals GC）:**
- `hook_signals` テーブルの自動 GC は未実装。DB が膨張した場合は手動で古い行を削除する:
  ```bash
  sqlite3 .team/traces/traces.db "DELETE FROM hook_signals WHERE timestamp < '2026-01-01'"
  ```
- 将来的に CLI サブコマンド化する可能性あり

## タスク属性

タスク frontmatter で表現される実行制御属性。CLI で指定すると frontmatter に永続化される。

| 属性 | 意味 | CLI フラグ |
|------|------|-----------|
| `run_after_all: true` | 全 open タスクが closed になってから実行（非排他 drain） | `--run-after-all` |
| `exclusive: true` | drain 後に単独実行。assigned の間は他の全 assignment を停止（closed になると再開）。`--run-after-all` を暗黙に含む | `--exclusive` |

### exclusive の 3 フェーズモデル

1. **drain** — 他の全 open タスクが closed になるまで `ready` で待機（run_after_all と同一セマンティクス）
2. **exclusive run** — 自身が `assigned` になった後、他のタスク（exclusive / 通常 / run_after_all）の assignment を停止
3. **resume** — 自身が `closed` になった次 tick から通常 assignment を再開

### 競合ルール

- `--exclusive` 同士は共存可能（ID 昇順に順次排他実行）
- `--exclusive` と非排他 `--run-after-all` は共存不可（どちら側から起票しても `RUN_AFTER_ALL_CONFLICT`）
- 非排他 `--run-after-all` 同士は従来通り共存不可（1 つまで）
- `--run-after-all` と `--exclusive` の冗長指定は `create_task_redundant_flags` 警告のみで処理継続

### 用途

- **`--run-after-all`**: 「全タスク完了後の後片付け」用（並列実行はしないが、走行中の他タスクの停止はしない）
- **`--exclusive`**: リリース作業・コンフリクト解消・破壊的依存変更・cmux-team 自身の更新など、他タスクを全て止めて単独で走らせたい作業

## 通信プロトコル

### ファイルベース通信

`.team/` ディレクトリ構造:

```
.team/
├── tasks/             # タスクファイル（フラット構造）
├── task-state.json    # タスク状態管理（status: draft/ready/assigned/closed）
├── artifacts/         # Axxx — 知見の記録（調査・設計判断・セッション要約）
├── output/            # Conductor/Agent の出力（taskRunId 別）
├── conductors/        # Conductor 状態ファイル
├── prompts/           # プロンプト（監査証跡）
├── specs/             # 要件・設計ドキュメント
├── queue/             # メッセージキュー（incoming/ + processed/）
├── logs/              # manager.log + traces/bodies/
├── traces/            # SQLite トレースDB（traces.db）
├── sessions/          # セッション情報
├── proxy-port         # プロキシポート番号
└── team.json          # チーム構成（daemon が自動更新）
```

### cmux コマンド通信

| コマンド | 用途 |
|---------|------|
| `cmux send` | 上位→下位のプロンプト送信 |
| `cmux send-key return` | 複数行プロンプトの送信確定 |
| `cmux tree` | init 時の pane 逆引きのみ使用（監視は hook + PID に一本化） |
| `cmux read-screen` | Trust 確認・エラー確認 |
| `cmux close-surface` | 完了した Agent タブの終了 |
| `cmux-team spawn-agent` | Agent 起動（タブ作成・プロキシ設定・Trust 承認を一括実行） |

### 複数行テキスト送信

単一行は末尾 `\n` で送信可能。複数行プロンプトは `cmux send` の後に `sleep 0.5` + `cmux send-key return` で送信確定。

## チーム状態管理

### team.json

daemon の `updateTeamJson()` が定期的に自動更新する。Master、Conductor、手動コマンドから直接書き込んではならない。

`team.json.masters` は **配列**で、複数の Master 稼働を許容する（T229）。各要素は `{ surface, status, pid?, startedAt }` のサブセットを書き出す（`daemon.ts:updateTeamJson` 実装準拠）。旧 `team.json.master`（単一オブジェクト）は廃止済み。`masters[0]` への単純な依存は避け、複数 Master 前提で扱うこと。

Master は **任意の pane から** `cmux-team spawn-master` で追加できる（T230）。pane 内の `cmdLaunchMaster` が `MASTER_REGISTERED` メッセージを daemon に POST → handler が `.team/masters/<surface>.json` を書き出し `state.masters` に登録する。daemon 未起動時は fail-fast（exit 1）。

### 進捗情報の取得方法（Master 向け）

status.json は廃止。Master は以下の真のソースから直接情報を取得する:

| 情報 | 真のソース | 取得方法 |
|------|-----------|---------|
| Manager の状態 | `.team/logs/manager.log` | `cat .team/logs/manager.log` または `cmux-team status` |
| 稼働中 Master | `.team/team.json` | `jq .masters .team/team.json` |
| 稼働中 Conductor | `.team/team.json` | `jq .conductors .team/team.json` |
| open task 数 | task-state.json | `cat .team/task-state.json`（status で絞り込み） |
| 完了タスク履歴 | ログ | `cat .team/logs/manager.log` |

## レイアウト戦略

起動時にレイアウトモードに応じたペイン構成を作成し、セッション終了まで変更しない。モードは `cmux-team start --layout=<wide|16x9>` または `.team/config.json` の `layout` で指定する（デフォルト: `wide`）。

### wide（デフォルト — 2x2、Conductor x3）

```
[Manager|Master] | [Conductor-1]
[Conductor-2   ] | [Conductor-3]
```

- **左上**: Manager（daemon）| Master（ユーザーセッション）— 2つの surface がタブとして同居
- **右上〜右下**: Conductor-1〜3（常駐 Claude セッション）
- **最大3タスク並列**、4つ目以降はキューイング

### 16x9（上段フル幅 + 下段 2 分割、Conductor x2）

```
[ Manager | Master (上段フル幅) ]
[ Conductor-1 | Conductor-2    ]
```

- **上段**: Manager | Master（タブとして同居、横幅 100%）
- **下段左/右**: Conductor-1 / Conductor-2
- **最大2タスク並列**、3つ目以降はキューイング
- 16:9 ディスプレイで Conductor ペインの横幅を最大化する用途

### 共通事項

- **ペイン構成は不動** — セッション中に close しない
- **サブエージェント**は `spawn-agent` CLI で Conductor ペイン内にタブとして作成（タブはスペースを消費しないためレイアウトが崩れない）
- 優先順位: CLI 引数 > `.team/config.json` > デフォルト（`wide`）
- `CMUX_TEAM_MAX_CONDUCTORS` で Conductor 数を上書き可能。`16x9` で 2 超を指定すると警告ログ出力で 2 にクランプ

## プロジェクト設定（.team/config.json）

daemon 起動時に参照される永続設定。`cmux-team start` 実行時に必要なフィールドが自動補完される。

| フィールド | 型 | 説明 |
|-----------|-----|------|
| `layout` | `"wide" \| "16x9"` | レイアウトモード（CLI `--layout` 引数で上書き可能） |
| `autoUpdate` | `"off" \| "notify" \| "task"` | 自動更新モード（`CMUX_TEAM_AUTO_UPDATE` env で上書き可能） |
| `mainBranch` | `string` | プロジェクトの主開発ブランチ名（T213 で追加） |

### `mainBranch` の優先順位

Conductor が worktree 作成時のベース・マージ先として使うブランチ名。以下の優先順位で解決される:

1. **`CMUX_TEAM_MAIN_BRANCH` 環境変数** — `cmdConductor` 起動時に env から取得（daemon が `launchConductor` で注入）
2. **`.team/config.json` の `mainBranch`** — `cmdStart` 時に解決・永続化された値
3. **`"main"` フォールバック** — env も config も未設定の場合

`cmdStart` 実行時は以下の順で `mainBranch` を決定する（config が既にあればそれを優先）:

1. `.team/config.json` に `mainBranch` があればそれを採用（source=`config`）
2. なければ `git symbolic-ref refs/remotes/origin/HEAD` で検出（source=`detected`）
3. 検出も失敗すれば `"main"` にフォールバック（source=`fallback`）

source が `config` 以外の場合のみ結果を `.team/config.json` に書き戻し、`main_branch_resolved branch=<name> source=<config|detected|fallback>` をログ出力する。初回起動後は常に config 経路が使われる。

### worktree 作成時の start-point 解決（T242）

Conductor が worktree を作成する際、start-point は以下の優先順位で決定される（`worktree-base.ts:resolveWorktreeBase`）:

1. **`explicit`** — task.md frontmatter の `base_branch:` が明示されている場合
2. **`config-origin`** — `origin/<mainBranch>` が存在すれば採用（他タスクの PR マージ後の最新状態を起点にする）
3. **`config-local`** — `origin/<mainBranch>` が無く、local `<mainBranch>` が存在する場合
4. **`head-fallback`** — 上記いずれも解決できない場合（`git worktree add -b <new>` のみ発行、現在の HEAD から分岐）

ログは `worktree_created branch=<new> base=<ref> source=<explicit|config-origin|config-local|head-fallback> path=<worktreePath>` 形式。

**注意:** `config-origin` を確実に使うには origin が最新化されている必要がある。ローカル未 push の commit を起点にしたい場合は、task.md の `base_branch: HEAD` を明示すれば従来通り現在の HEAD から分岐する（`explicit` 経路）。

**環境変数 `CMUX_TEAM_FETCH_BEFORE_WORKTREE=1`** を設定すると、worktree 作成前に `git fetch --quiet origin <mainBranch>` を実行する（タイムアウト 30 秒、失敗はログのみで継続）。デフォルトは OFF — offline 環境・rate limit 対策・並列負荷回避のため。

## git worktree（概要）

すべての作業は `.worktrees/<taskRunId>/` 内で行う。main ブランチは常に無傷。

- **作成**: `git worktree add .worktrees/<taskRunId> -b <taskRunId> <start-point>`（taskRunId は `task-<NNN>-<timestamp>` 形式。例: `task-042-1712345678`）。`<start-point>` は上記「worktree 作成時の start-point 解決」の通り、`origin/<mainBranch>` を優先
- **ブートストラップ**: tracked files のみチェックアウトされるため、`npm install` 等の初期化が必要（詳細は `templates/conductor.md` 参照）
- **成功時**: worktree 内でコミット → main にマージ → worktree 削除
- **失敗時**: `git worktree remove --force` + ブランチ削除
- **クリーンアップ**: `git worktree list` で確認、`git worktree remove <path> --force` で削除、`git worktree prune` で壊れた参照を修復

## エラーリカバリ

| 障害 | 検出者 | 対応 |
|------|--------|------|
| Agent クラッシュ | Conductor | `cmux-team await-agent` が STATUS=crashed で exit 10 → Conductor が判断 |
| Conductor クラッシュ | Manager | `spawnPidWatcher` が PID 死亡を検出 → `disconnected` → timeout 後 forced close |
| Manager クラッシュ | Master | Manager が応答なし → 再 spawn |
| API レート制限 | 各層 | 待機して再試行、同時 Agent 数を削減 |

**異常検出**: PID ベース生存確認（`spawnPidWatcher` が `process.kill(pid, 0)` を 1 秒間隔で呼ぶ）と hook push（`SESSION_STARTED` / `SESSION_IDLE` / `SESSION_CLEAR` / `SESSION_ENDED`）で行う。`cmux read-screen` は Trust 確認検出にのみ使う。

### 依存タスクの cascade（T241）

親タスクが `aborted` / `deleted` に遷移したとき、`depends_on` に親を含む
**ready** 状態の子タスクは自動的に `draft` に戻される。

- `draft` 子: 変更なし
- `ready` 子: **`draft` に戻す**（journal に `parent_aborted: <parentId>` 追記）
- `assigned` 子: 変更なし（走行中の作業は止めない）
- `closed` / `aborted` / `deleted` 子: 変更なし

cascade は以下 5 経路で同期的に走る:
1. `cmux-team abort-task` CLI
2. `cmux-team delete-task` CLI
3. Conductor forced close（disconnect timeout）
4. user_clear（手動 /clear で running を abort）
5. assign_failed（worktree 作成失敗等）

ログ: `child_reverted_to_draft parent=<X> child=<Y> reason=parent_aborted`
（delete 経路でも `reason=parent_aborted` で統一）

## 既知の注意点

### Trust 確認（初回起動時）

新しいディレクトリで Claude を起動すると「Trust this folder?」確認が表示される。Manager または Conductor が `cmux read-screen` で検出し `cmux send-key return` で自動承認するが、タイミングによっては手動介入が必要な場合がある。

### ペイン幅の注意

サブエージェントは Conductor と同じ pane 内にタブとして作成される（`cmux new-surface`）。タブ作成に失敗した場合は `new-split right` にフォールバックする。

### パーミッション確認

`--dangerously-skip-permissions` で起動しても `.claude/commands/` や `.claude/skills/` への書き込み時に確認ダイアログが出る場合がある。最初の確認で「Yes, and allow Claude to edit its own settings for this session」を選択すること。

### トレーサビリティ（v3.4.0）

daemon 起動時に API Proxy が自動起動し、全 API リクエストを SQLite FTS5 データベースに記録する。

- **DB パス**: `.team/traces/traces.db`
- **本文保存**: `.team/logs/traces/bodies/`
- **検索**: `cmux-team trace-task <id>`（旧 `cmux-team trace --task / --search / --show` は廃止され `trace-task` に集約）
- **メタデータ**: `x-cmux-task-id`, `x-cmux-conductor-surface`, `x-cmux-role` ヘッダーで伝播
- **自動設定**: Master/Conductor に `ANTHROPIC_BASE_URL` を設定し、全リクエストを Proxy 経由にする
- **base 列（T243）**: `task_sessions` テーブルの `event=assigned` 行に `base_branch` / `base_sha` / `base_source` を記録する。worktree 作成時の出発点（branch ラベル + 親 commit SHA + 解決ソース）を事後追跡できるようにするための列で、`event=agent_spawned` / `closed` / `aborted` 行は NULL のまま。T243 より前の旧レコードも NULL のまま（マイグレーションでは過去行を更新しない）

### API レート制限

複数エージェント同時実行で API 過負荷になりやすい。4層構造により同時セッション数が増えるため、Claude Max 推奨。

### auto-update（デフォルト OFF、3モード）

daemon 稼働中の自動更新は `update-notifier` で検出だけ行い、**実際の install は daemon ではなく update タスクを起票して Conductor に委ねる**。複数 Node 環境（Volta / nvm / Homebrew など）で意図しないバージョンに上書きされる問題を回避するため、デフォルトは OFF。

モード（`autoUpdate`）:

| mode | 挙動 |
|------|------|
| `off`（デフォルト） | 何もしない。registry へのアクセスなし |
| `notify` | 12h 周期で更新検出 → TUI バナーのみ表示。install はしない |
| `task` | 12h 周期で更新検出 → `--run-after-all` update タスクを自動起票 |

設定方法（優先順位: **env > config > default**）:

- 環境変数 `CMUX_TEAM_AUTO_UPDATE`: `0|false|off` / `1|true|task` / `notify` を受け付ける（空文字は未設定扱い）
- `.team/config.json` の `{ "autoUpdate": "off" | "notify" | "task" | true | false }`
  - 後方互換: `true` → `task`、`false` → `off`

関連:
- `NO_UPDATE_NOTIFIER=1` で無効化（update-notifier 標準の環境変数）
- `cmux-team self-update` で任意タイミングに update タスクを手動起票（既存 run_after_all / 同 latest タスクがあれば exit 0 でそれを返す）
- 起動時ログ: `auto_update_config mode=<mode> source=<env|config|default>`（**T186 の `enabled=<bool>` から破壊的変更**）
- update タスクの frontmatter には `kind: cmux-team-update` が付く（重複検出に使用）

## Artifacts（知見の記録）

会話中の調査結果・設計判断・セッション要約は `.team/artifacts/` に Axxx 番号付きで保存する。

### Txxx と Axxx の違い

| | Txxx（タスク） | Axxx（アーティファクト） |
|---|---|---|
| 本質 | 「やること」の管理 | 「わかったこと」の記録 |
| ライフサイクル | draft → ready → assigned → closed | 作成 → 参照（→ アーカイブ） |
| 誰が作る | Master / ユーザー | 誰でも（Master, Conductor, Agent） |

### いつ Artifact を作るか

- 調査・リサーチを行ったとき（type: research）
- 設計上の判断を下したとき（type: decision）
- セッション終了時に重要な発見があったとき（type: session）
- 要件・仕様を整理したとき（type: spec）
- 分析レポートを作成したとき（type: report）

### フォーマット

ファイル名: `.team/artifacts/Axxx-<slug>.md`

```yaml
---
id: A001
type: research          # research | decision | session | spec | report
title: "タイトル"
created: <ISO 8601>
updated: <ISO 8601>     # 任意 — 更新時に付与
author: surface:100     # 作成した surface ID（T229 で "master" 等の固定ラベルから surface 文字列へ破壊的変更）
task: T038              # 任意 — 関連タスク
tags: [tag1, tag2]      # 任意
---
```

> **T229 破壊的変更:** `author` は従来 `master` / `conductor-N` / `agent-xxx` の固定ラベルを使用していたが、複数 Master 時代に備え surface ID 文字列（例: `surface:100`）に変更された。`/artifact` コマンド経由で作成する場合は自動的に呼び出し元の `CMUX_SURFACE` が設定される。既存 artifact の `author` 値は保持される（マイグレーション不要）。

### 参照方法

- 会話中: 「A001で調査した通り」「A003の設計判断に基づき」
- タスクとの紐付け: フロントマターの `task: T038` で関連付け
- 新セッション開始時: 直近の artifacts を確認してコンテキストを復元

### コマンド

- `/artifact [type] "タイトル"` — 会話コンテキストから要約生成・保存
- `/artifact list` — 一覧表示
- `/artifact show Axxx` — 内容表示
