# Seed: Install & Infrastructure

---

## 配布方法

### 1. npm パッケージ（推奨）

```bash
npm install -g @hummer98/cmux-team
```

`postinstall` スクリプトにより:
1. `bun install` で manager/ の依存関係を解決
2. `claude plugin add hummer98/cmux-team` で Plugin を登録

### 2. Claude Code Plugin

`.claude-plugin/plugin.json`（npm パッケージ内に同梱）で定義。`postinstall` で自動登録される。

```json
{
  "name": "cmux-team",
  "version": "3.18.0",
  "description": "Multi-agent development orchestration with Claude Code + cmux.",
  "skills": "./skills/",
  "commands": "./commands/",
  "hooks": {
    "SessionStart": [...],
    "PreToolUse": [...]
  }
}
```

**Plugin hooks:**
- **SessionStart**: cmux 環境外での起動時にタブ名をリネーム
- **PreToolUse (Write|Edit)**: `team.json` と `task-state.json` への直接編集をブロック（daemon 管理ファイルの保護）

---

## npm パッケージ構成

### package.json

```json
{
  "name": "@hummer98/cmux-team",
  "version": "3.18.0",
  "bin": { "cmux-team": "bin/cmux-team.js" },
  "scripts": {
    "postinstall": "node bin/postinstall.js",
    "prepublishOnly": "cd skills/cmux-team/manager && bun test"
  },
  "engines": { "node": ">=18" }
}
```

### bin/cmux-team.js

CLI ラッパー。Bun で `skills/cmux-team/manager/main.ts` を実行する。

- `bun` の存在を確認（未インストール時はエラー）
- `start` コマンドの場合: exit code 42 による自動再起動をサポート（最大10回）
- その他のコマンド: 引数を透過して `bun run main.ts` に渡す

### bin/postinstall.js

npm postinstall スクリプト。

1. `bun install` で manager/ の依存関係を解決（bun 未インストール時は手動実行を案内）
2. `claude plugin add hummer98/cmux-team` で Plugin を登録（claude 未インストール時は手動実行を案内）

---

## Manager Daemon（TypeScript）

### ディレクトリ構成

```
skills/cmux-team/manager/
├── main.ts          # CLI エントリーポイント（15サブコマンド）
├── daemon.ts        # イベント駆動ステートマシン + メインループ
├── master.ts        # Master surface 起動
├── conductor.ts     # Conductor ライフサイクル管理
├── task.ts          # タスクファイルパース + 依存解決
├── proxy.ts         # API ロギングプロキシ
├── queue.ts         # ファイルベースメッセージキュー
├── trace-store.ts   # SQLite FTS5 トレースDB
├── artifact.ts      # アーティファクト管理
├── schema.ts        # Zod 型定義
├── template.ts      # プロンプトテンプレート検索・生成
├── logger.ts        # 追記型ログ
├── cmux.ts          # cmux CLI ラッパー
├── dashboard.tsx    # React (ink) TUI ダッシュボード
├── e2e.ts           # E2E テストランナー
├── daemon.test.ts   # daemon ユニットテスト
├── proxy.test.ts    # proxy ユニットテスト
├── queue.test.ts    # queue ユニットテスト
├── task.test.ts     # task ユニットテスト
├── package.json     # 依存: ink, react, zod, @rezi-ui/core, @rezi-ui/node
└── tsconfig.json
```

### CLI サブコマンド

| コマンド | 説明 |
|---------|------|
| `start` | daemon 起動 + Master spawn + Conductor スロット初期化 + TUI + プロキシ |
| `send <TYPE>` | メッセージキューイング（TASK_CREATED, CONDUCTOR_DONE, SHUTDOWN 等） |
| `status` | daemon ステータス表示（conductor、タスク数、ログ末尾） |
| `stop` | グレースフルシャットダウン |
| `spawn-agent` | Agent タブ作成 + Claude 起動 + プロキシ設定 + Trust 承認 |
| `agents` | 稼働中エージェント一覧 |
| `kill-agent` | Agent surface close + AGENT_DONE メッセージ |
| `create-task` | タスクファイル作成 + task-state.json 初期エントリー |
| `update-task` | タスク状態更新（draft → ready で TASK_CREATED トリガー） |
| `close-task` | タスクを closed にマーク + journal 保存 |
| `trace` | トレースDB 検索・表示（--task, --search, --show） |
| `conductor` | Conductor 情報表示 |
| `spawn-master` | Master surface 起動 |
| `artifacts` | アーティファクト一覧・検索 |

### メインループ

```
while (state.running):
  1. processQueue()          # キューメッセージ処理
  2. scanTasks()             # ready タスクを検出 → idle Conductor に割り当て
  3. monitorConductors()     # done マーカー検出、クラッシュ検出
  4. updateTeamJson()        # team.json を最新状態に同期
  5. sleep(pollInterval)     # デフォルト10秒
```

ファイルシステム監視（tasks/, queue/）により変更検出時は即時 tick を実行。
ソースファイル mtime 監視によりコード変更時は自動再起動（exit code 42）。

### プロキシサーバー

- Bun.serve ベースの HTTP プロキシ
- Anthropic API へのリクエスト/レスポンスを SQLite FTS5 データベースに記録
- ストリーミング対応（`text/event-stream` の tee）
- ポートは `.team/proxy-port` に保存
- 既存プロセスが生きていれば再利用
- デバッグエンドポイント: `GET /state`, `GET /tasks`, `GET /conductors`

### TUI ダッシュボード

- React + ink ベースのフルスクリーン TUI
- セクション: ヘッダー（ステータス・PID・稼働時間）、Conductor 一覧、タスクリスト、ログ/Journal タブ
- キーボードショートカット: `r` = リロード、`q` = 終了
- 2秒間隔でデータ更新

### メッセージキュー

- ファイルベース（`.team/queue/*.json`）
- 処理済みファイルは `.team/queue/processed/` に移動
- アトミック書き込み（tmp ファイル + rename）
- Zod バリデーション（不正メッセージはスキップ）

### テンプレート検索順序

1. daemon 自身の `../templates/`（ローカル開発）
2. プラグインキャッシュ: `~/.claude/plugins/cache/hummer98-cmux-team/.../templates/`
3. プロジェクトローカル: `skills/cmux-team/templates/`
4. 手動インストール: `~/.claude/skills/cmux-team/templates/`

---

## CLAUDE.md

プロジェクト開発用の規約ファイル。主要セクション:
- プロジェクトミッション・設計原則
- 判断基準と優先順位
- GitHub issue 作成ガイドライン
- リポジトリ構造
- スキル・コマンド・テンプレートの追加方法
- テンプレート変数仕様
- インストール方法（npm）
- テスト方法（E2E 手動テスト）
- コーディング規約
- ロギングポリシー
- プロンプト編集ルール（テンプレートがソースオブトゥルース）
- Manager プロトコル（内部実装）
- 通信プロトコル
- 既知の注意点（Trust 確認、レート制限、トレーサビリティ 等）

---

## .team/.gitignore（initInfra で自動生成）

```
output/
prompts/
logs/
queue/
proxy-port
docs-snapshot/
scripts/
task-state.json
*.log
```

追跡するもの:
- `team.json` — チーム構成
- `tasks/` — タスクファイル
- `specs/` — 要件・設計ドキュメント
- `artifacts/` — 知見の記録
