# cmux-team: Project Overview

## What is this?

Claude Code + cmux によるマルチエージェント開発オーケストレーションのスキル/コマンドパッケージ。
**Master（ユーザー対話）→ Manager（TypeScript daemon）→ Conductor（タスク実行）→ Agent（実作業）**
の4層構造で、開発タスクを自律的に遂行する。

## Core Concept

```
[ユーザー] ↔ [Master] → [Manager (daemon)] → [Conductor (常駐)] → [Agent (実作業)]
    │            │              │                       │                      │
    │            │              │                       │                      ├─ コード実装
    │            │              │                       │                      ├─ テスト実行
    │            │              │                       │                      └─ 完了→停止
    │            │              │                       │
    │            │              │                       ├─ git worktree 内で作業
    │            │              │                       ├─ Agent 起動（spawn-agent CLI でタブ作成）
    │            │              │                       ├─ 結果統合
    │            │              │                       └─ done マーカー作成→idle に戻る
    │            │              │
    │            │              ├─ タスク検出→idle Conductor にタスク割り当て
    │            │              ├─ done マーカーで完了検出（pull 型）
    │            │              └─ Conductor リセット→次のタスクへ
    │            │
    │            ├─ タスク作成（bun run main.ts create-task）
    │            ├─ 真のソース直接参照→進捗報告
    │            └─ Manager 健全性確認
    │
    └─ 指示・確認
```

## Target Users

cmux 内で Claude Code を使用する開発者。開発ワークフローを並列化・自動化したい人。

## Key Principles

1. **上位が下位を監視する（pull 型）** — 下位からの push 報告に依存しない
2. **決定論的なものはコードで、判断が必要なものは AI で** — イベント検出は確実に、意思決定は柔軟に
3. **各層は自分の仕事だけをする** — Master は作業しない、Agent は報告しない、Conductor はユーザーに聞かない
4. **逸脱を防ぐより、逸脱しても安全な構造にする** — git worktree 隔離 + 事後レビュー
5. **シンプルさを優先** — 動くものを最小構成で

## レイアウト: 固定2x2

起動時に固定の2x2レイアウト（4ペイン、5 surface）を作成し、セッション終了まで変更しない。

```
[Manager|Master] | [Conductor-1]
[Conductor-2   ] | [Conductor-3]
```

- **左上**: Manager（daemon）| Master（ユーザーセッション）— 2つの surface がタブとして同居
- **右上**: Conductor-1（常駐 Claude セッション）
- **左下**: Conductor-2（常駐 Claude セッション）
- **右下**: Conductor-3（常駐 Claude セッション）
- **最大3タスク並列**、4つ目以降はキューイング
- **サブエージェント**は `spawn-agent` CLI で Conductor ペイン内にタブとして作成

## 配布方法

### Claude Code Plugin（推奨）

`.claude-plugin/plugin.json` によるプラグイン配布。

### install.sh（レガシー）

`~/.claude/` に直接コピーする方式。plugin 未対応環境向け。

```
~/.claude/
├── skills/
│   ├── cmux-team/
│   │   ├── SKILL.md
│   │   ├── templates/     # テンプレート13個
│   │   └── manager/       # TypeScript daemon
│   └── cmux-agent-role/
│       └── SKILL.md
└── commands/               # コマンド13個
    ├── start.md
    ├── master.md
    ├── team-status.md
    ├── team-disband.md
    ├── team-research.md
    ├── team-spec.md
    ├── team-design.md
    ├── team-impl.md
    ├── team-review.md
    ├── team-test.md
    ├── team-sync-docs.md
    ├── team-task.md
    └── team-archive.md
```

## Per-Project State（/start で作成）

```
.team/
├── team.json           # チーム構成（daemon が自動管理）
├── task-state.json     # タスク状態管理（status: draft/ready/in_progress/closed/archived）
├── manager/            # Manager daemon の実行用（main.ts へのシンボリックリンク等）
├── queue/              # ファイルベースメッセージキュー
│   └── processed/
├── specs/
│   ├── requirements.md
│   ├── design.md
│   ├── research.md
│   └── tasks.md
├── output/             # Agent 成果物
│   └── conductor-N/    # Conductor 別出力ディレクトリ
├── tasks/              # タスクファイル（フラット構造）
│   └── archived/       # アーカイブ済みタスク（日付別）
├── prompts/            # 生成されたプロンプト（監査証跡）
├── logs/
│   ├── manager.log     # Manager イベントログ
│   └── traces/         # API トレースログ（JSONL）
├── proxy-port          # プロキシサーバーのポート番号
├── scripts/            # ランタイムスクリプト
├── docs-snapshot/      # ドキュメント同期用スナップショット
└── .gitignore          # output/, prompts/, logs/, task-state.json 等を除外
```
