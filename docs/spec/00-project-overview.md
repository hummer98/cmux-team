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
    │            │              │                       ├─ Agent 起動・監視（タブとして作成）
    │            │              │                       ├─ 結果統合
    │            │              │                       ├─ タスクを close（cmux-team close-task）
    │            │              │                       └─ done マーカー作成→idle に戻る
    │            │              │
    │            │              ├─ タスク検出→idle Conductor にタスク割り当て
    │            │              ├─ done マーカーで完了検出（pull 型）
    │            │              └─ Journal 読み取り + ログ記録 + Conductor リセット
    │            │
    │            ├─ タスク作成
    │            ├─ 真のソース直接参照→報告
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

## レイアウト

起動時にレイアウトモードに応じたペイン構成を作成し、セッション終了まで変更しない。
モードは `cmux-team start --layout=<wide|16x9>` または `.team/config.json` の `layout` で指定する（デフォルト: `wide`）。

### wide（デフォルト — 2x2、Conductor x3）

```
[Manager|Master] | [Conductor-1]
[Conductor-2   ] | [Conductor-3]
```

- **左上**: Manager（daemon）| Master（ユーザーセッション）— 2つの surface がタブとして同居
- **右上**: Conductor-1（常駐 Claude セッション）
- **左下**: Conductor-2（常駐 Claude セッション）
- **右下**: Conductor-3（常駐 Claude セッション）
- **最大3タスク並列**、4つ目以降はキューイング

### 16x9（上段フル幅 + 下段 2 分割、Conductor x2）

```
[ Manager | Master (上段フル幅) ]
[ Conductor-1 | Conductor-2    ]
```

- **上段**: Manager | Master（タブとして同居、横幅 100%）
- **下段左**: Conductor-1
- **下段右**: Conductor-2
- **最大2タスク並列**、3つ目以降はキューイング
- 16:9 ディスプレイで Conductor ペインの横幅を最大化する用途

### 共通事項

- **ペイン構成は不動** — セッション中に close しない
- **サブエージェント**は `spawn-agent` CLI で Conductor ペイン内にタブとして作成

## 配布方法

### npm パッケージ（推奨）

```bash
npm install -g @hummer98/cmux-team
```

`postinstall` スクリプトにより manager/ の依存関係が自動解決される。

### Claude Code Plugin

`.claude-plugin/plugin.json` によるプラグイン配布。

## Per-Project State（cmux-team start で作成）

```
.team/
├── tasks/              # タスクディレクトリ集約（タスク中心構造）
│   └── TNNN-slug/      #   タスクごとに 1 ディレクトリ
│       ├── task.md     #     タスク本文
│       └── runs/       #     実行ごとの作業フォルダ
│           └── <taskRunId>/  #       プロンプト・plan.md・Agent 出力を集約
├── task-state.json     # タスク状態管理（status + resume 用メタデータ: sessionId, worktreePath, taskRunId, conductorSlot）
├── artifacts/          # Axxx — 知見の記録（調査・設計判断・セッション要約）
├── conductors/         # Conductor 状態ファイル
├── specs/              # 要件・設計ドキュメント
├── logs/               # manager.log + traces/bodies/
├── traces/             # SQLite トレースDB（traces.db）
├── sessions/           # セッション情報
├── proxy-port          # プロキシポート番号
└── team.json           # チーム構成（daemon が自動更新）
```

タスク実行に伴うプロンプト・成果物（旧 `.team/prompts/`、`.team/output/` 相当）は `tasks/TNNN-slug/runs/<taskRunId>/` 配下に集約される。Conductor／Agent の `OUTPUT_DIR` はこのディレクトリを指す。
