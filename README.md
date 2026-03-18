# cmux-team

Claude Code + cmux によるマルチエージェントオーケストレーション。

Conductor（親 Claude セッション）が cmux の分割ペインを使って複数のサブエージェント Claude を並列起動・監視・統合します。

## 概要

```
Human ←→ Conductor (親 Claude)
              ├── cmux send → Agent A (Researcher)
              ├── cmux send → Agent B (Architect)
              ├── cmux send → Agent C (Implementer)
              ├── cmux read-screen → 進捗監視
              ├── cmux wait-for → 完了同期
              └── .team/output/* → 結果統合
```

## 前提条件

- [Claude Code](https://claude.ai/claude-code) がインストール済み (`~/.claude/` が存在)
- [cmux](https://github.com/anthropics/cmux) がインストール済み
- cmux セッション内で Claude Code を実行していること

## インストール

```bash
git clone <repo-url> cmux-team
cd cmux-team
./install.sh
```

### 確認

```bash
./install.sh --check
```

### アンインストール

```bash
./install.sh --uninstall
```

## クイックスタート

```bash
# 1. cmux セッションを起動
cmux

# 2. Claude Code を起動
claude

# 3. チームを初期化
/team-init プロジェクトの説明

# 4. 要件を策定
/team-spec

# 5. リサーチ（並列3エージェント）
/team-research 認証方式, セッション管理, トークン設計

# 6. 設計（アーキテクト + レビュアー）
/team-design

# 7. 実装（並列エージェント）
/team-impl all

# 8. レビュー
/team-review

# 9. テスト
/team-test all

# 10. ドキュメント同期
/team-sync-docs

# 11. 完了後にチーム解散
/team-disband
```

## コマンドリファレンス

### コアコマンド

| コマンド | 説明 |
|---------|------|
| `/team-init [説明]` | チームを初期化し `.team/` ディレクトリ構造を作成 |
| `/team-status` | チームの現在の状態・エージェント一覧・イシュー状況を表示 |
| `/team-disband [force]` | 全サブエージェントを終了（`force` でグレースフル終了をスキップ） |

### ワークフローコマンド

| コマンド | 説明 |
|---------|------|
| `/team-research <トピック>` | リサーチャー最大3名を起動しトピックを並列調査 |
| `/team-spec [概要]` | ユーザーと対話的に要件をブレストし仕様を策定 |
| `/team-design` | アーキテクト + レビュアーで設計フェーズを実行 |
| `/team-impl [タスク番号\|all]` | 実装エージェントを起動しコーディングタスクを並列実行 |
| `/team-review` | レビューエージェントを起動し実装をレビュー |
| `/team-test [unit\|integration\|e2e\|all]` | テストエージェントを起動しテストを作成・実行 |

### サポートコマンド

| コマンド | 説明 |
|---------|------|
| `/team-sync-docs` | `docs/` を `.team/specs/` と同期 |
| `/team-issue [create\|close\|show] [引数]` | イシューの作成・一覧・クローズ・表示 |

## アーキテクチャ

### プロジェクト内の状態管理

`/team-init` で作成される `.team/` ディレクトリ:

```
.team/
├── team.json          # チーム状態（エージェント一覧、フェーズ等）
├── specs/             # 要件・設計ドキュメント（git tracked）
│   ├── requirements.md
│   ├── research.md
│   ├── design.md
│   └── tasks.md
├── output/            # エージェントの出力（gitignore）
├── issues/            # イシュー管理（git tracked）
│   ├── open/
│   └── closed/
├── prompts/           # 生成されたプロンプト（gitignore）
└── docs-snapshot/     # ドキュメント同期用スナップショット（gitignore）
```

### スキル構成

| スキル | 対象 | 説明 |
|--------|------|------|
| `cmux-team` | Conductor（親セッション） | オーケストレーション: エージェント起動・監視・統合 |
| `cmux-agent-role` | サブエージェント | 行動規範: 出力プロトコル・ステータス報告・完了シグナル |

### 並列構成（Tier）

| Tier | 構成 | 用途 |
|------|------|------|
| Small | 1+3 (4 total) | リサーチ、デザインレビュー |
| Medium | 1+5 (6 total) | 実装 + レビュー |
| Large | 1+7 (8 total) | フルチーム: 実装 + レビュー + テスト + ドキュメント |

### エージェントロール

| ロール | 説明 |
|--------|------|
| Researcher | トピックの調査・事実収集 |
| Architect | 要件に基づく技術設計 |
| Reviewer | 成果物のレビュー・品質チェック |
| Implementer | 設計に基づくコーディング |
| Tester | テスト作成・実行 |
| DocKeeper | ドキュメント管理・同期 |
| IssueManager | イシューの監視・分類・要約 |

### 通信モデル

```
Conductor ──cmux send──→ Sub-agent
Conductor ←─file read──← Sub-agent (.team/output/)
Conductor ←─cmux wait──← Sub-agent (completion signal)
Conductor ←─read-screen← Sub-agent (screen scraping, fallback)
```

サブエージェント同士は直接通信せず、すべて `.team/` の共有ファイルまたは Conductor を介して連携します。

## Hooks 設定（推奨）

`~/.claude/settings.json` に以下を追加すると、エージェントの完了通知を受け取れます:

```json
{
  "hooks": {
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "command -v cmux >/dev/null 2>&1 && cmux claude-hook notification || true"
          }
        ]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "command -v cmux >/dev/null 2>&1 && cmux claude-hook stop || true"
          }
        ]
      }
    ]
  }
}
```

## 開発

### リポジトリ構造

```
cmux-team/
├── .claude/
│   ├── skills/
│   │   ├── cmux-team/
│   │   │   ├── SKILL.md
│   │   │   └── templates/     # エージェントプロンプトテンプレート
│   │   └── cmux-agent-role/
│   │       └── SKILL.md
│   └── commands/              # スラッシュコマンド定義
├── docs/seeds/                # 設計シードドキュメント
├── install.sh
├── LICENSE
└── README.md
```

### 規約

- ドキュメント・コメント: 日本語
- コード: 英語
- スキルは YAML フロントマター + Markdown
- コマンドはスキルを `$instructions` で参照
- テンプレートは `{{VARIABLE}}` プレースホルダーを使用

## ライセンス

MIT License - 詳細は [LICENSE](LICENSE) を参照。
