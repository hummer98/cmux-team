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
│   │   └── templates/                # エージェントプロンプトテンプレート (10個)
│   │       ├── common-header.md      #   全エージェント共通ヘッダー
│   │       ├── manager.md            #   Manager ロール
│   │       ├── conductor.md          #   Conductor ロール
│   │       ├── researcher.md         #   リサーチャーロール
│   │       ├── architect.md          #   アーキテクトロール
│   │       ├── reviewer.md           #   レビュアーロール
│   │       ├── implementer.md        #   実装者ロール
│   │       ├── tester.md             #   テスターロール
│   │       ├── dockeeper.md          #   ドキュメント管理者ロール
│   │       └── task-manager.md       #   タスク管理者ロール
│   └── cmux-agent-role/
│       └── SKILL.md                  # サブエージェント行動規範スキル
├── commands/                         # スラッシュコマンド定義 (4個)
│   ├── master.md                     #   Master ロール再読み込み（/clear 復帰用）
│   ├── team-spec.md                  #   要件ブレスト（対話型）
│   ├── team-task.md                  #   タスク管理
│   ├── team-archive.md              #   完了タスクのアーカイブ
│   └── artifact.md                  #   知見のアーティファクト化
├── docs/seeds/                       # 設計シードドキュメント（実装時の入力仕様）
│   ├── 00-project-overview.md
│   ├── 01-skill-cmux-team.md
│   ├── 02-skill-cmux-agent-role.md
│   ├── 03-commands.md
│   ├── 04-templates.md
│   ├── 05-install-and-infrastructure.md
│   └── 06-implementation-tasks.md
├── LICENSE                           # MIT
├── README.md                         # ユーザー向けドキュメント（英語）
└── README.ja.md                      # ユーザー向けドキュメント（日本語）
```

### 2つのスキルの役割分担

| スキル | 誰が読むか | 内容 |
|--------|-----------|------|
| `cmux-team` (SKILL.md) | Master（ユーザーセッション） | 4層アーキテクチャ全体の定義、Master 行動原則 |
| `cmux-agent-role` (SKILL.md) | Agent（実作業エージェント） | 出力プロトコル・タスク作成・作業境界 |

### docs/seeds/ の役割

設計フェーズで作成されたシードドキュメント。実装の入力仕様であり、各ファイルの「あるべき姿」を定義している。コード変更時はシードの意図と整合しているか確認すること。

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
| `{{OUTPUT_FILE}}` | 出力ファイルパス（例: `.team/output/researcher-1.md`） |
| `{{PROJECT_ROOT}}` | プロジェクトルートの絶対パス |
| `{{WORKTREE_PATH}}` | git worktree のパス（Agent が作業するディレクトリ） |
| `{{OUTPUT_DIR}}` | 出力ディレクトリパス（例: `.team/output/`） |

### ロール固有変数

| 変数 | 使用テンプレート | 説明 |
|------|----------------|------|
| `{{COMMON_HEADER}}` | 全ロール | common-header.md の展開結果 |
| `{{TOPIC}}` | researcher | リサーチトピック |
| `{{SUB_QUESTIONS}}` | researcher | 調査すべきサブ質問リスト |
| `{{REQUIREMENTS_CONTENT}}` | architect, reviewer, tester | requirements.md の内容 |
| `{{RESEARCH_SUMMARY}}` | architect | リサーチ結果の要約 |
| `{{CODEBASE_CONTEXT}}` | architect | 既存コードベースのコンテキスト |
| `{{DESIGN_CONTENT}}` | reviewer, implementer | design.md の内容 |
| `{{ARTIFACT_CONTENT}}` | reviewer | レビュー対象の成果物 |
| `{{TASKS_CONTENT}}` | implementer | tasks.md のアサインされたタスク |
| `{{TEST_SCOPE}}` | tester | テスト範囲 |
| `{{IMPLEMENTATION_SUMMARY}}` | tester | 実装結果の要約 |
| `{{SPECS_CONTENT}}` | dockeeper | 現在の仕様書全体 |
| `{{LAST_SNAPSHOT_SUMMARY}}` | dockeeper | 前回の docs スナップショットの要約 |
| `{{OPEN_TASKS_LIST}}` | task-manager | オープンタスクの一覧 |
| `{{MANAGER_INSTRUCTIONS}}` | manager | Manager への指示（イベント駆動監視設定等） |
| `{{CONDUCTOR_INSTRUCTIONS}}` | conductor | Conductor へのタスク実行指示 |
| `{{PHASE_NAME}}` | conductor | 実行フェーズ名（research, design, impl 等） |

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

1. idle Conductor を検出（done マーカーなし + surface 生存 + `❯` 表示中）
2. worktree 作成・プロンプト生成
3. Conductor surface に `/clear` + 新プロンプト送信

**Conductor は spawn しない。** 起動時に作成された固定ペインに対してタスクを送信するだけ。

### Conductor 監視（pull 型）

- **主要判定**: done マーカーファイル（`.team/output/conductor-N/done`）の存在で完了判定
- **フォールバック**: `cmux list-status` で Idle 検出
- **重要**: push ではなく pull 型。Conductor は done マーカーを作成して idle に戻り、Manager が見に来る

### 結果回収

完了検出後: ログ記録 → Conductor リセット（`/clear`）→ done マーカー削除。

Manager がやらないこと:
- タスクの close（Conductor が `cmux-team close-task` を実行）
- Conductor ペインの close（persistent — 閉じない）
- worktree の削除（Conductor の責務）
- マージ処理（Conductor が納品方法を判断する）

### ループ継続・アイドル化

- **Conductor 稼働中**: 30秒間隔で pull 型監視を実行
- **アイドル時（open tasks ゼロ）**: 停止して待機。`idle_start` をログ記録
- **起床トリガー**: `[TASK_CREATED]` 通知で再起動

## 通信プロトコル

### ファイルベース通信

`.team/` ディレクトリ構造:

```
.team/
├── tasks/             # タスクファイル（フラット構造）
├── task-state.json    # タスク状態管理（status: draft/ready/assigned/closed）
├── artifacts/         # Axxx — 知見の記録（調査・設計判断・セッション要約）
├── output/conductor-N/ # Conductor が書く、Manager が読む
├── prompts/           # プロンプト（監査証跡）
├── specs/             # 要件・設計ドキュメント
├── traces/            # SQLite トレースDB
└── team.json          # チーム構成（Master が初期化）
```

### cmux コマンド通信

| コマンド | 用途 |
|---------|------|
| `cmux send` | 上位→下位のプロンプト送信 |
| `cmux send-key return` | 複数行プロンプトの送信確定 |
| `cmux list-status` | 上位が下位の状態を取得（pull 型監視） |
| `cmux read-screen` | Trust 確認・エラー確認 |
| `cmux close-surface` | 完了した Agent タブの終了 |
| `cmux-team spawn-agent` | Agent 起動（タブ作成・プロキシ設定・Trust 承認を一括実行） |

### 複数行テキスト送信

単一行は末尾 `\n` で送信可能。複数行プロンプトは `cmux send` の後に `sleep 0.5` + `cmux send-key return` で送信確定。

## チーム状態管理

### team.json

daemon の `updateTeamJson()` が定期的に自動更新する。Master、Conductor、手動コマンドから直接書き込んではならない。

### 進捗情報の取得方法（Master 向け）

status.json は廃止。Master は以下の真のソースから直接情報を取得する:

| 情報 | 真のソース | 取得方法 |
|------|-----------|---------|
| Manager の状態 | Manager workspace | `cmux list-status --workspace MANAGER_WS` |
| 稼働中 Conductor | cmux ペイン構成 | `cmux tree` |
| open task 数 | task-state.json | `cat .team/task-state.json`（status で絞り込み） |
| 完了タスク履歴 | ログ | `cat .team/logs/manager.log` |

## レイアウト戦略

### 固定2x2レイアウト

起動時に固定の2x2レイアウト（4ペイン、5 surface）を作成し、セッション終了まで変更しない。

```
[Manager|Master] | [Conductor-1]
[Conductor-2   ] | [Conductor-3]
```

- **左上**: Manager（daemon）| Master（ユーザーセッション）— 2つの surface がタブとして同居
- **右上〜右下**: Conductor-1〜3（常駐 Claude セッション）
- **4ペインは不動** — close しない
- **サブエージェント**は `spawn-agent` CLI で Conductor ペイン内にタブとして作成（タブはスペースを消費しないためレイアウトが崩れない）
- **最大3タスク並列**、4つ目以降はキューイング

## git worktree（概要）

すべての作業は `.worktrees/conductor-N/` 内で行う。main ブランチは常に無傷。

- **作成**: `git worktree add .worktrees/conductor-N -b conductor-N/task`
- **ブートストラップ**: tracked files のみチェックアウトされるため、`npm install` 等の初期化が必要（詳細は `templates/conductor.md` 参照）
- **成功時**: worktree 内でコミット → main にマージ → worktree 削除
- **失敗時**: `git worktree remove --force` + ブランチ削除
- **クリーンアップ**: `git worktree list` で確認、`git worktree remove <path> --force` で削除、`git worktree prune` で壊れた参照を修復。`.team/worktrees/` 配下の記録も確認すること

## エラーリカバリ

| 障害 | 検出者 | 対応 |
|------|--------|------|
| Agent クラッシュ | Conductor | `cmux list-status` で消失検出 → 再 spawn |
| Conductor クラッシュ | Manager | Idle のまま done マーカーなし → 再 spawn or abort してタスク reopen |
| Manager クラッシュ | Master | Manager が応答なし → 再 spawn |
| API レート制限 | 各層 | 待機して再試行、同時 Agent 数を削減 |

**異常検出**: `cmux list-status` で Running/Idle を判定。検出できない場合は `cmux read-screen` にフォールバック（シェルプロンプト表示 → Claude 終了、エラーメッセージ → クラッシュ、画面空 → ペイン消失）。

## 既知の注意点

### Trust 確認（初回起動時）

新しいディレクトリで Claude を起動すると「Trust this folder?」確認が表示される。Manager または Conductor が `cmux read-screen` で検出し `cmux send-key return` で自動承認するが、タイミングによっては手動介入が必要な場合がある。

### ペイン幅の注意

サブエージェントは Conductor と同じワークスペース内に `new-split` で配置するのがデフォルト。ペイン数が多すぎて幅が不足すると `cmux send` や `cmux read-screen` が失敗する場合がある。その場合はペイン数を減らすか、ワークスペースを分けて対応する。

### パーミッション確認

`--dangerously-skip-permissions` で起動しても `.claude/commands/` や `.claude/skills/` への書き込み時に確認ダイアログが出る場合がある。最初の確認で「Yes, and allow Claude to edit its own settings for this session」を選択すること。

### トレーサビリティ（v3.4.0）

daemon 起動時に API Proxy が自動起動し、全 API リクエストを SQLite FTS5 データベースに記録する。

- **DB パス**: `.team/traces/traces.db`
- **本文保存**: `.team/logs/traces/bodies/`
- **検索**: `cmux-team trace --task <id>`, `--search <query>`, `--show <id>`
- **メタデータ**: `x-cmux-task-id`, `x-cmux-conductor-id`, `x-cmux-role` ヘッダーで伝播
- **自動設定**: Master/Conductor に `ANTHROPIC_BASE_URL` を設定し、全リクエストを Proxy 経由にする

### API レート制限

複数エージェント同時実行で API 過負荷になりやすい。4層構造により同時セッション数が増えるため、Claude Max 推奨。

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
author: master          # master | conductor-N | agent-xxx
task: T038              # 任意 — 関連タスク
tags: [tag1, tag2]      # 任意
---
```

### 参照方法

- 会話中: 「A001で調査した通り」「A003の設計判断に基づき」
- タスクとの紐付け: フロントマターの `task: T038` で関連付け
- 新セッション開始時: 直近の artifacts を確認してコンテキストを復元

### コマンド

- `/artifact [type] "タイトル"` — 会話コンテキストから要約生成・保存
- `/artifact list` — 一覧表示
- `/artifact show Axxx` — 内容表示
