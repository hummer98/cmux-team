![cmux-team](banner.jpeg)

# cmux-team

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Claude Code + cmux によるマルチエージェント開発オーケストレーション。

**[English README](README.md)**

## なぜ cmux-team?

Claude Code の組み込みサブエージェント（Agent ツール）は便利ですが、**中で何をしているか見えません**。結果だけが返ってきて、途中経過はブラックボックスです。

cmux-team は、cmux のターミナル分割を使ってサブエージェントを**目に見える形で**並列実行します。

**あなたがやること**: Claude に自然言語で指示するだけ。
**Claude がやること**: cmux でペインを分割し、サブエージェントを起動・監視・統合。

## 前提条件

- [Claude Code](https://claude.ai/claude-code) がインストール済み
- [cmux](https://github.com/manaflow-ai/cmux) がインストール済み
- [bun](https://bun.sh/) がインストール済み（Manager daemon に必要）
- cmux 内で Claude Code を実行していること

## インストール

```bash
npm install -g @hummer98/cmux-team
```

## 使い方

### 基本的な流れ

cmux を起動し、その中で Claude Code を起動します。

```
あなた: /cmux-team:start
  → daemon が起動し、ダッシュボードを表示
  → Master ペインが自動作成される
  → Master ペインに切り替えてタスクを伝える

あなた: React で TODO アプリを作って
Claude: タスクを作成しました。
  → daemon がタスクを検出 → Conductor を起動
  → Conductor が Agent を隣のペインに起動
  → 各エージェントの作業がリアルタイムで見える

あなた: 状況は？
Claude: （manager.log・cmux tree を確認して報告）
        Conductor-1: 実装中（Agent 2/3 完了）

あなた: あと worktree を整理して（TODO）
Claude: → CLI でキューに TODO を追加
       → daemon が新しい Conductor を起動して並列実行
```

### コマンド一覧

#### CLI コマンド（ターミナルで実行）

| コマンド | やること | いつ使う |
|---------|---------|---------|
| `cmux-team start` | daemon 起動 + Master + Conductor spawn | セッション開始時 |
| `cmux-team status` | チーム状態表示 | いつでも |
| `cmux-team stop` | graceful shutdown | 作業完了時 |
| `cmux-team create-task` | タスク作成 | タスク追加時 |
| `cmux-team trace` | API トレース検索 | デバッグ・分析時 |

#### スラッシュコマンド（Claude 内で実行）

| コマンド | やること | いつ使う |
|---------|---------|---------|
| `/cmux-team:master` | Master ロール再読み込み | `/clear` 後 |
| `/team-spec [概要]` | 要件をブレスト | 何を作るか決める時 |
| `/team-task [操作]` | タスク管理 | 設計判断・課題の記録 |
| `/team-archive [範囲]` | 完了タスクのアーカイブ | タスク整理時 |

## アーキテクチャ

### 概要

```
┌─────────────────────────────────────────┐
│  cmux-team daemon (TypeScript/bun)      │
│  ┌───────────────────────────────────┐  │
│  │  TUI Dashboard                    │  │
│  │  Tasks: 2 open | Conductors: 1/3  │  │
│  └───────────────────────────────────┘  │
│  Queue ← Master/Hook が CLI で書き込み   │
│  Loop  → タスクスキャン → Conductor spawn │
│  Monitor → 完了検出 → 結果回収          │
└───────────┬────────────┬────────────────┘
            │            │
     [Master]    [Conductor-035]
     Claude Code  Claude Code
     (Opus)       → [Agent] Claude Code
```

### daemon（TypeScript プロセス）

Manager は Claude Code セッションではなく、**TypeScript の決定論的ループ**で動作します。

- **ファイルキュー** (`.team/queue/`) による通信（`cmux send-key` 不要）
- **zod** によるメッセージスキーマ検証
- **ink** ベースの TUI ダッシュボード
- **タスク依存解決** (`depends_on` フィールド)
- **優先度ソート** (high > medium > low)

```bash
# daemon 操作
./main.ts start          # 起動 + Master spawn + ダッシュボード
./main.ts send TODO --content "worktree 整理"
./main.ts send TASK_CREATED --task-id 035 --task-file ...
./main.ts status         # ステータス表示
./main.ts stop           # graceful shutdown
```

### タスクの依存関係

タスクファイルの YAML frontmatter で依存を宣言できます:

```yaml
---
id: 13
title: 統合レポート作成
status: ready
depends_on: [10, 11, 12]  # 10, 11, 12 が全て完了するまで待機
---
```

daemon は依存が解決されたタスクのみ Conductor に割り当てます。

### 通信モデル

| 方向 | 手段 |
|------|------|
| Master → daemon | CLI (`main.ts send`) → `.team/queue/*.json` |
| daemon → Conductor | `cmux new-split` + Claude Code 起動 |
| Conductor → daemon | SessionEnd hook → `.team/queue/*.json` + `cmux list-status` ポーリング |
| daemon → Master | なし（Master が `manager.log` を直接参照） |

### エージェントロール

| ロール | 担当 | 出力例 |
|--------|-----|--------|
| Conductor | タスクオーケストレーション、Agent 管理 | summary.md |
| Researcher | 技術調査・事実収集 | 比較表、推奨事項 |
| Architect | 技術設計 | 設計書、Mermaid 図 |
| Reviewer | 品質チェック | Approved / Changes Requested |
| Implementer | コーディング | コード、変更ファイル一覧 |
| Tester | テスト作成・実行 | テストコード、実行結果 |

## プロジェクト内に作られるもの

`cmux-team start` を実行すると、プロジェクトに `.team/` ディレクトリが作られます：

```
.team/
├── team.json          # チーム状態（自動管理）
├── manager/           # daemon ランタイム（TypeScript）
├── queue/             # メッセージキュー
│   └── processed/     # 処理済みメッセージ
├── tasks/
│   ├── open/          # 未完了タスク
│   ├── closed/        # 完了タスク
│   └── archived/      # アーカイブ済み
├── specs/             # 仕様書（git tracked）
├── output/            # エージェント出力（gitignore）
├── prompts/           # 生成プロンプト（gitignore）
├── logs/              # manager.log（gitignore）
└── scripts/           # ランタイムスクリプト
```

## Hooks 設定（推奨）

`~/.claude/settings.json` に以下を追加すると、エージェントの完了時に cmux の通知リングが光ります：

```json
{
  "hooks": {
    "Notification": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "command -v cmux >/dev/null 2>&1 && cmux claude-hook notification || true"
      }]
    }],
    "Stop": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "command -v cmux >/dev/null 2>&1 && cmux claude-hook stop || true"
      }]
    }]
  }
}
```

## トレーサビリティ

daemon 起動中、組み込みプロキシを通じて全 API リクエストが自動記録されます。

### トレース検索

```bash
# タスクIDでフィルタ
cmux-team trace --task 035

# 全文検索（SQLite FTS5）
cmux-team trace --search "エラー"

# トレース詳細表示（リクエスト/レスポンス本文含む）
cmux-team trace --show 42
```

トレースは `.team/traces/traces.db` に、リクエスト/レスポンス本文は `.team/logs/traces/bodies/` に保存されます。

## トラブルシューティング

### daemon が起動しない

**bun がインストールされていない**: `brew install oven-sh/bun/bun` でインストール。

**cmux 環境外**: cmux 内で実行してください。`CMUX_SOCKET_PATH` 環境変数が必要です。

### ペインが狭くなって動作しない

ペイン数が多すぎると cmux コマンドが失敗します。`cmux-team stop` で全エージェントを終了し、`CMUX_TEAM_MAX_CONDUCTORS=1` で Conductor 数を制限してください。

### Conductor が自分で作業してしまう

Conductor テンプレートに「自分でコードを書かない」ルールがありますが、守られない場合があります。テンプレートを更新するか、`cmux-team start` を再実行してプロンプトを再生成してください。

### Conductor のセッションログを見たい

```bash
# manager.log から session_id を取得
grep conductor-xxx .team/logs/manager.log
# → task_completed ... session=abc-123

# セッションを参照
claude --resume abc-123
```

## 制約・既知の問題

- **API レート制限**: 複数エージェント同時実行で過負荷になりやすい。Claude Max 推奨。`CMUX_TEAM_MAX_CONDUCTORS` で同時実行数を制限可能（デフォルト: 3）。
- **ペイン幅**: ペイン数が多すぎると cmux コマンドが失敗する。
- **初回 Trust 確認**: 新しいディレクトリで Claude を起動すると信頼確認が表示される。Conductor が自動承認を試みるが、失敗する場合は手動承認が必要。

## 開発への貢献

テスト方法、リポジトリ構造、コーディング規約については [CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。

## ライセンス

MIT License - 詳細は [LICENSE](LICENSE) を参照。
