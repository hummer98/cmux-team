---
name: cmux-team
description: >
  Use when orchestrating multi-agent development via cmux.
  Triggers: .team/ directory exists, user says "team", "spawn agents",
  "parallel", "sub-agent", or any /team-* command is invoked.
  Provides: agent spawning, monitoring, result collection, synchronization protocols.
---

# cmux-team: マルチエージェントオーケストレーション

cmux を使って複数の Claude サブエージェントを並行起動・管理するための
Conductor（指揮者）向けスキル。

## 1. クイックオリエンテーション

### 環境検出
```bash
# cmux 環境確認（必須）
echo $CMUX_SOCKET_PATH  # 設定されていなければ cmux 外

# 既存チーム状態の確認
cat .team/team.json 2>/dev/null

# 現在のトポロジー確認
cmux tree --all --json
```

### 前提条件
- `CMUX_SOCKET_PATH` 環境変数が設定されていること
- `cmux` コマンドが利用可能であること
- カレントディレクトリにプロジェクトがあること

## 2. エージェントライフサイクルプロトコル

### 2.1 スポーン（起動）

```bash
# 1. ペインを作成
cmux new-split right  # → surface:N

# 2. team.json にエージェントを登録
# { "agents": [{ "role": "<role-id>", "surface": "surface:N", "status": "spawning" }] }

# 3. サイドバーにステータスを設定
cmux set-status <role-id> "spawning" --icon sparkle --color "#ffcc00"

# 4. 自律型 Claude を起動
cmux send --surface surface:N "claude --dangerously-skip-permissions\n"

# 5. Claude のブート完了を待つ（プロンプト ❯ を検出）
# ポーリング: cmux read-screen --surface surface:N | grep '❯'

# 6. タスクプロンプトを送信
cmux send --surface surface:N "<プロンプト内容>\n"

# 7. ステータス更新
cmux set-status <role-id> "running" --icon hammer --color "#0099ff"
```

### 2.2 モニタリング

```bash
# 現在の画面を読む
cmux read-screen --surface surface:N --lines 50

# スクロールバック付きで完全な出力を読む
cmux read-screen --surface surface:N --scrollback --lines 200

# エージェントがアイドルか確認（プロンプトが再表示されているか）
cmux read-screen --surface surface:N | tail -5 | grep '❯'
```

### 2.3 結果収集

```bash
# 方法 A: ファイルベース（推奨）
cat .team/output/<role-id>.md

# 方法 B: スクリーンスクレイピング（フォールバック）
cmux read-screen --surface surface:N --scrollback
```

### 2.4 完了同期

```bash
# Conductor が待機:
cmux wait-for "<role-id>-done" --timeout 300

# エージェント側がシグナル送信（プロンプトで指示済み）:
# cmux wait-for -S "<role-id>-done"
```

### 2.5 ティアダウン（終了）

```bash
# 特定のエージェントを終了
cmux send --surface surface:N "/exit\n"
cmux close-surface --surface surface:N

# 全エージェントを終了
# team.json を読み、各 surface を順にクローズ
```

## 3. プロンプト生成プロトコル

Conductor は以下の手順でエージェントプロンプトを生成する:

1. `.team/specs/` から現在の要件・設計を読む
2. `.team/issues/open/` から関連コンテキストを読む
3. テンプレート + コンテキストからロール別プロンプトを合成
4. `.team/prompts/<role-id>.md` に書き込み（監査証跡）
5. `cmux send` でエージェントに送信

### テンプレート変数

プロンプトテンプレート内の `{{VARIABLE}}` を実際の値に置換する:
- `{{ROLE_ID}}` — エージェントのロール ID
- `{{TASK_DESCRIPTION}}` — タスクの説明
- `{{OUTPUT_FILE}}` — 出力ファイルパス
- `{{PROJECT_ROOT}}` — プロジェクトルートパス
- `{{REQUIREMENTS_CONTENT}}` — requirements.md の内容
- `{{DESIGN_CONTENT}}` — design.md の内容
- `{{RESEARCH_SUMMARY}}` — リサーチ結果の要約

## 4. チーム状態管理 (team.json)

```json
{
  "project": "project-name",
  "description": "",
  "phase": "init",
  "created_at": "2026-03-18T00:00:00Z",
  "agents": [
    {
      "id": "researcher-1",
      "role": "researcher",
      "surface": "surface:21",
      "workspace": "workspace:5",
      "status": "running",
      "task": "Investigate auth patterns",
      "started_at": "2026-03-18T00:01:00Z"
    }
  ],
  "completed_outputs": [
    "output/researcher-1.md"
  ]
}
```

### ステータス値
- `spawning` — エージェント起動中
- `running` — タスク実行中
- `done` — タスク完了
- `error` — エラー発生
- `idle` — アイドル（次のタスク待ち）

## 5. レイアウト戦略

### Small (1+3): 縦分割
```
[Conductor] | [Agent A] | [Agent B] | [Agent C]
```

### Medium (1+5): グリッド
```
[Conductor] | [Agent A] | [Agent B]
            | [Agent C] | [Agent D] | [Agent E]
```
→ 1+5 以上は別ワークスペースを使用:
```bash
cmux new-workspace --cwd $(pwd)  # → workspace:N, surface:M
```

### Large (1+7): ワークスペース分散
```
workspace:1 → Conductor
workspace:2 → Agent A, Agent B (split)
workspace:3 → Agent C, Agent D (split)
workspace:4 → Agent E, Agent F, Agent G (3-way split)
```

## 6. 進捗トラッキング

```bash
# エージェント別ステータス（サイドバー表示）
cmux set-status researcher-1 "reading files" --icon hammer --color "#0099ff"

# フェーズ全体の進捗
cmux set-progress 0.33 --label "Research: 1/3 agents done"
```

## 7. エラーリカバリ

- `cmux read-screen` でエージェントペインにエラーが表示された場合
  → `.team/issues/open/` にログを記録
- `cmux wait-for` がタイムアウトした場合
  → `read-screen` で診断し、ユーザーに通知
- エージェントがクラッシュした場合
  → プロンプト消失を検出し、再スポーンを提案

## 8. コマンド一覧

| コマンド | 説明 |
|---------|------|
| `/team-init` | チーム初期化（.team/ ディレクトリ作成） |
| `/team-status` | チーム状態表示 |
| `/team-disband` | 全エージェント終了 |
| `/team-research` | リサーチエージェント起動 |
| `/team-spec` | 仕様ブレスト（対話型） |
| `/team-design` | 設計エージェント起動 |
| `/team-impl` | 実装エージェント起動 |
| `/team-review` | レビューエージェント起動 |
| `/team-test` | テストエージェント起動 |
| `/team-sync-docs` | ドキュメント同期 |
| `/team-issue` | イシュー管理 |
