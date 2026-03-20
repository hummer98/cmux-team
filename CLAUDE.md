# cmux-team

Claude Code + cmux によるマルチエージェント開発オーケストレーションのスキル/コマンドパッケージ。
Conductor（親 Claude セッション）が cmux CLI を通じて複数のサブエージェント Claude セッションを起動・監視・統合する。

## リポジトリ構造

```
cmux-team/
├── .claude-plugin/
│   ├── plugin.json                   # プラグインマニフェスト
│   └── marketplace.json              # Marketplace カタログ
├── skills/
│   ├── cmux-team/
│   │   ├── SKILL.md                  # Conductor 向けオーケストレーションスキル
│   │   └── templates/                # エージェントプロンプトテンプレート (8個)
│   │       ├── common-header.md      #   全エージェント共通ヘッダー
│   │       ├── researcher.md         #   リサーチャーロール
│   │       ├── architect.md          #   アーキテクトロール
│   │       ├── reviewer.md           #   レビュアーロール
│   │       ├── implementer.md        #   実装者ロール
│   │       ├── tester.md             #   テスターロール
│   │       ├── dockeeper.md          #   ドキュメント管理者ロール
│   │       └── issue-manager.md      #   イシュー管理者ロール
│   └── cmux-agent-role/
│       └── SKILL.md                  # サブエージェント行動規範スキル
├── commands/                         # スラッシュコマンド定義 (11個)
│   ├── team-init.md                  #   .team/ 初期化
│   ├── team-spec.md                  #   要件ブレスト（対話型）
│   ├── team-research.md              #   並列リサーチ
│   ├── team-design.md                #   設計 + レビュー
│   ├── team-impl.md                  #   並列実装
│   ├── team-review.md                #   実装レビュー
│   ├── team-test.md                  #   テスト作成・実行
│   ├── team-sync-docs.md             #   ドキュメント同期
│   ├── team-issue.md                 #   イシュー管理
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
├── install.sh                        # インストーラ（レガシー、plugin 未対応環境向け）
├── LICENSE                           # MIT
├── README.md                         # ユーザー向けドキュメント（英語）
└── README.ja.md                      # ユーザー向けドキュメント（日本語）
```

### 2つのスキルの役割分担

| スキル | 誰が読むか | 内容 |
|--------|-----------|------|
| `cmux-team` (SKILL.md) | Conductor（親 Claude） | エージェントの起動・監視・結果収集・レイアウト戦略 |
| `cmux-agent-role` (SKILL.md) | サブエージェント | 出力プロトコル・完了シグナル・ステータス報告・イシュー作成 |

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
3. Conductor が spawn 時にテンプレート変数を置換し `.team/prompts/` に書き出す

### install.sh への反映

新しいスキル・コマンドを追加した場合、`install.sh` のコピー対象に含まれているか確認する。現在の実装では `commands/*.md` と `skills/` 配下を一括コピーするため、通常は変更不要。プラグインとしてインストールする場合は `plugin.json` の `skills` / `commands` パスが正しいか確認する。

## テンプレート変数仕様

テンプレート内の `{{VARIABLE}}` プレースホルダーは、Conductor がプロンプト生成時に実際の値に置換する。

### 共通変数（common-header.md 由来）

| 変数 | 説明 |
|------|------|
| `{{ROLE_ID}}` | エージェントの識別子（例: `researcher-1`, `architect`） |
| `{{TASK_DESCRIPTION}}` | タスクの説明文 |
| `{{OUTPUT_FILE}}` | 出力ファイルパス（例: `.team/output/researcher-1.md`） |
| `{{PROJECT_ROOT}}` | プロジェクトルートの絶対パス |

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
| `{{OPEN_ISSUES_LIST}}` | issue-manager | オープンイシューの一覧 |

## install.sh の動作

### インストール（引数なし）

1. `~/.claude/` の存在を確認（なければエラー終了）
2. ディレクトリを作成:
   - `~/.claude/skills/cmux-team/templates/`
   - `~/.claude/skills/cmux-agent-role/`
   - `~/.claude/commands/`
3. ファイルをコピー（`cp -f`、symlink ではない）:
   - スキル SKILL.md × 2
   - テンプレート × 8
   - コマンド × 11
4. cmux の存在を確認（警告のみ、インストール自体は続行）

### `--check`

インストール状態を確認し、各項目の OK/warn を表示。ファイルの変更はしない。

### `--uninstall`

- `~/.claude/skills/cmux-team/` と `~/.claude/skills/cmux-agent-role/` を削除
- `~/.claude/commands/team-*.md` のみ削除（他のコマンドは残す）
- プロジェクトの `.team/` は削除しない

## テスト方法

自動テストはない。以下の手順で E2E テストを行う。

### 前提

- cmux がインストールされていること
- Claude Code が利用可能であること（Claude Max 推奨）

### インストールテスト

```bash
# クリーンインストール
./install.sh
./install.sh --check    # 全項目が [ok] であること

# アンインストール → 再インストール
./install.sh --uninstall
./install.sh --check    # 全項目が [warn] であること
./install.sh
```

### 機能テスト（cmux 内で実行）

```bash
# 1. cmux を起動し Claude Code を立ち上げる
cmux
# Claude Code 内で:

# 2. チーム初期化
/team-init テストプロジェクト
# → .team/ が作成され team.json が正しいこと

# 3. リサーチ（最小構成テスト）
/team-research テストトピック
# → 別ワークスペースに3ペインが作成されること
# → サブエージェントが起動・実行・完了すること
# → .team/output/researcher-*.md に結果が書き出されること

# 4. ステータス確認
/team-status
# → 各エージェントの状態が表示されること

# 5. クリーンアップ
/team-disband
# → 全ペインが閉じること
```

### 確認ポイント

- Conductor が別ワークスペースにペインを作成すること（同一ワークスペースに詰め込まないこと）
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

## 既知の注意点

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

新しいディレクトリで Claude を起動すると「Trust this folder?」確認が表示される。Conductor が `cmux read-screen` で検出し `cmux send-key return` で自動承認するが、タイミングによっては手動介入が必要な場合がある。

### Conductor の別ワークスペース配置

**Conductor は常に単独ワークスペースに配置し、サブエージェントは別ワークスペースに配置すること。** 同一ワークスペースに詰め込むと Conductor のペイン幅が不足し、`cmux send` や `cmux read-screen` が失敗する。

### パーミッション確認

`--dangerously-skip-permissions` で起動しても `.claude/commands/` や `.claude/skills/` への書き込み時に確認ダイアログが出る場合がある。最初の確認で「Yes, and allow Claude to edit its own settings for this session」を選択すること。

### API レート制限

複数エージェント同時実行で API 過負荷になりやすい。Claude Max 推奨。
