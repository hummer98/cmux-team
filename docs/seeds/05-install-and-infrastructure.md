# Seed: Install Script & Infrastructure

---

## 配布方法

### 1. Claude Code Plugin（推奨）

`.claude-plugin/plugin.json` で定義。Plugin Marketplace 経由でインストール。

```json
{
  "name": "cmux-team",
  "version": "2.18.1",
  "description": "Multi-agent development orchestration with Claude Code + cmux.",
  "skills": "./skills/",
  "commands": "./commands/"
}
```

### 2. install.sh（レガシー）

plugin 未対応環境向け。`~/.claude/` にファイルを直接コピーする。

---

## install.sh

**Purpose:** Skills, commands, templates を `~/.claude/` にコピーする。

**Behavior:**
1. `~/.claude/` の存在確認（なければエラー終了）
2. ディレクトリ作成:
   - `~/.claude/skills/cmux-team/templates/`
   - `~/.claude/skills/cmux-agent-role/`
   - `~/.claude/commands/`
3. ファイルコピー（`cp -f`、symlink ではない）:
   - スキル SKILL.md × 2
   - テンプレート × 13
   - コマンド × 13
4. 依存チェック:
   - `using-cmux` スキルの存在確認（警告のみ）
   - `cmux` コマンドの存在確認（警告のみ）
5. コマンド一覧を表示

**Flags:**
- `--check` — インストール状態を確認（ファイル変更なし）
- `--uninstall` — アンインストール
- `--help` — ヘルプ表示

---

## install.sh --uninstall

削除するもの:
- `~/.claude/skills/cmux-team/`
- `~/.claude/skills/cmux-agent-role/`
- `~/.claude/commands/team-*.md`

削除しないもの:
- `~/.claude/` 自体
- 他のスキル・コマンド
- プロジェクトの `.team/` ディレクトリ

---

## install.sh --check

確認項目:
- `~/.claude/` の存在
- `cmux-team` スキル
- `cmux-agent-role` スキル
- テンプレート
- コマンド（11個基準 — レガシーチェック）
- `using-cmux` スキル（依存）
- `cmux` コマンド

---

## Manager Daemon（TypeScript）

### ディレクトリ構成

```
skills/cmux-team/manager/
├── main.ts          # CLI エントリーポイント（10サブコマンド）
├── daemon.ts        # イベント駆動ステートマシン + メインループ
├── master.ts        # Master surface 起動
├── conductor.ts     # Conductor ライフサイクル管理
├── task.ts          # タスクファイルパース + 依存解決
├── proxy.ts         # API ロギングプロキシ
├── queue.ts         # ファイルベースメッセージキュー
├── schema.ts        # Zod 型定義
├── template.ts      # プロンプトテンプレート検索・生成
├── logger.ts        # 追記型ログ
├── cmux.ts          # cmux CLI ラッパー
├── dashboard.tsx    # React (ink) TUI ダッシュボード
├── e2e.ts           # E2E テストランナー
├── package.json     # 依存: ink, react, zod
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

### メインループ

```
while (state.running):
  1. processQueue()          # キューメッセージ処理
  2. scanTasks()             # ready タスクを検出 → idle Conductor に割り当て
  3. monitorConductors()     # done マーカー検出、クラッシュ検出
  4. updateTeamJson()        # team.json を最新状態に同期
  5. sleep(pollInterval)     # デフォルト10秒
```

### プロキシサーバー

- Bun.serve ベースの HTTP プロキシ
- Anthropic API へのリクエスト/レスポンスをログ記録（JSONL形式）
- ストリーミング対応（`text/event-stream` の tee）
- ポートは `.team/proxy-port` に保存
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
- install.sh の動作
- テスト方法（E2E 手動テスト）
- コーディング規約
- プロンプト編集ルール（テンプレートがソースオブトゥルース）
- 既知の注意点（Manager 仕様、cmux send 改行、Trust 確認 等）

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

---

## Hooks Configuration（任意、推奨）

`~/.claude/settings.json` に追加:

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
