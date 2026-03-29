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
- **既存の動作を壊さない** — 手動オーバーライドコマンド（/cmux-team:start-research 等）は残す
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
├── commands/                         # スラッシュコマンド定義 (11個)
│   ├── start.md                      #   チーム体制構築（Master + Manager）
│   ├── team-spec.md                  #   要件ブレスト（対話型）
│   ├── team-research.md              #   並列リサーチ
│   ├── team-design.md                #   設計 + レビュー
│   ├── team-impl.md                  #   並列実装
│   ├── team-review.md                #   実装レビュー
│   ├── team-test.md                  #   テスト作成・実行
│   ├── team-sync-docs.md             #   ドキュメント同期
│   ├── team-task.md                  #   タスク管理
│   ├── team-status.md                #   チーム状態表示
│   └── team-disband.md               #   全エージェント終了
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

### 機能テスト（cmux 内で実行）

```bash
# 1. cmux を起動し Claude Code を立ち上げる
cmux
# Claude Code 内で:

# 2. チーム体制構築（Master + Manager 起動）
/cmux-team:start
# → .team/ が作成され team.json が正しいこと
# → Master が Manager を spawn すること
# → Manager がイベント駆動でタスク待機を開始すること

# 3. リサーチ（Manager → Conductor → Agent の流れ）
/cmux-team:start-research テストトピック
# → Manager が Conductor を spawn すること
# → Conductor が Agent を spawn し、ペインが分割されること
# → Agent が起動・実行・完了すること
# → .team/output/researcher-*.md に結果が書き出されること
# → Conductor がフェーズ完了を Manager に報告すること

# 4. ステータス確認
/cmux-team:start-status
# → 各層（Manager, Conductor, Agent）の状態が表示されること

# 5. クリーンアップ
/cmux-team:start-disband
# → 全ペインが閉じること
# → git worktree が削除されること
```

### 確認ポイント

- 4層構造（Master → Manager → Conductor → Agent）が正しく機能すること
- Manager が Conductor の完了を検知し次のフェーズに進むこと
- Agent は git worktree 内で作業し、メインブランチを汚さないこと
- `cmux send` 後に `cmux send-key return` で送信されること
- Trust 確認が出た場合に自動承認されること
- 完了シグナル (`cmux wait-for`) が正しく受信されること
- サイドバーにステータスが表示されること

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
| 編集後に `/start` で再生成 or テンプレートからコピー | ランタイムだけ書き換えて「動いた」で終わり |

**理由:** ランタイムプロンプトだけ書き換えると、テンプレートとの乖離が蓄積する。次回の `/start` や別プロジェクトでの起動時に変更が消失する。

プロンプトを変更する場合の手順:
1. `skills/cmux-team/templates/*.md` を編集
2. `.team/prompts/*.md` にコピー（または `/start` で再生成）
3. 他プロジェクト（Dear 等）のランタイムプロンプトも更新
4. コミット・リリース

## 既知の注意点

### Manager の動作仕様

- **モデル**: `--model sonnet` で起動
- **権限**: `--dangerously-skip-permissions`（Sonnet はテンプレートの指示に忠実に従うため権限制限不要）
- **イベント駆動**: アイドル時は停止し、Master からの `[TASK_CREATED]` 通知で起床する。ポーリングしない
- **Conductor 起動**: `.team/scripts/spawn-conductor.sh` にスクリプト化。worktree 作成・ペイン分割・プロンプト生成・Claude 起動・Trust 承認を決定論的に処理
- **ログ**: `.team/logs/manager.log` に状態変化を追記形式で記録（`conductor_started`, `task_completed`, `idle_start` 等）
- **status.json は廃止**: Master は真のソース（`cmux read-screen`, `cmux tree`, `ls .team/tasks/`, `manager.log`）を直接参照する

### `cmux send` の改行問題

単一行テキスト（シェルコマンドなど）は末尾 `\n` で送信可能だが、**複数行テキストでは `\n` が改行として入力欄に追加されるだけで送信されない**。複数行プロンプトを送る場合:

```bash
# 1. テキストを送信（\n を付けない）
cmux send --surface surface:M --workspace workspace:N "${PROMPT}"
# 2. 明示的に Enter を送信
sleep 0.5
cmux send-key --surface surface:M --workspace workspace:N "return"
```

### Trust 確認（初回起動時）

新しいディレクトリで Claude を起動すると「Trust this folder?」確認が表示される。Manager または Conductor が `cmux read-screen` で検出し `cmux send-key return` で自動承認するが、タイミングによっては手動介入が必要な場合がある。

### ペイン幅の注意

サブエージェントは Conductor と同じワークスペース内に `new-split` で配置するのがデフォルト。ペイン数が多すぎて幅が不足すると `cmux send` や `cmux read-screen` が失敗する場合がある。その場合はペイン数を減らすか、ワークスペースを分けて対応する。

### パーミッション確認

`--dangerously-skip-permissions` で起動しても `.claude/commands/` や `.claude/skills/` への書き込み時に確認ダイアログが出る場合がある。最初の確認で「Yes, and allow Claude to edit its own settings for this session」を選択すること。

### git worktree のクリーンアップ

Agent は git worktree 上で作業する。`/cmux-team:start-disband` 実行時に worktree は自動削除されるが、異常終了した場合は手動でクリーンアップが必要。

```bash
# 残存 worktree の確認
git worktree list
# 不要な worktree の削除
git worktree remove <path> --force
# worktree の参照が壊れている場合
git worktree prune
```

`.team/worktrees/` 配下にも worktree パスが記録されているため、合わせて確認すること。

### API レート制限

複数エージェント同時実行で API 過負荷になりやすい。4層構造により同時セッション数が増えるため、Claude Max 推奨。
