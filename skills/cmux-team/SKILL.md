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

**重要**: サブエージェントは必ず別ワークスペースに配置すること（§5 レイアウト戦略参照）。

#### Step 1: エージェント用ワークスペースとペインを作成

**重要: ワークスペースには必ず用途がわかる名前を付けること。**
「✳ Claude Code」のままでは、どのワークスペースが何をしているか判別できない。

```bash
# 別ワークスペースを作成（初回のみ）
cmux new-workspace --cwd $(pwd)  # → workspace:N, surface:M

# 用途がわかる名前を付ける（フェーズ名 or ロール名）
cmux rename-workspace --workspace workspace:N "Research"  # 例: Research, Design, Impl-1

# 追加のペインが必要なら分割
cmux new-split right --workspace workspace:N  # → surface:M+1
```

#### Step 2: team.json にエージェントを登録

```bash
# team.json の agents 配列にエントリを追加
# { "id": "<role-id>", "role": "<role>", "surface": "surface:M", "status": "spawning", ... }
```

#### Step 3: サイドバーにステータスを設定

「何が行われているか見える」ための必須ステップ。サイドバーで全エージェントの状態を一目で把握できる。

```bash
cmux set-status <role-id> "spawning" --icon sparkle --color "#ffcc00"
```

#### Step 4: Claude を起動（シェルコマンドなので \n で送信される）

```bash
cmux send --surface surface:M --workspace workspace:N "claude --dangerously-skip-permissions\n"
```

#### Step 5: Claude のブート完了を待つ

「Trust this folder?」確認または ❯ プロンプトが表示されるまでポーリング:

```bash
# 最大30秒、3秒間隔でポーリング
# 検出パターン: "Yes, I trust" (Trust確認) または "❯" (プロンプト)
for i in $(seq 1 10); do
  SCREEN=$(cmux read-screen --surface surface:M --workspace workspace:N 2>&1)
  if echo "$SCREEN" | grep -q "Yes, I trust"; then
    # Trust 確認が出ている → Enter で承認
    cmux send-key --surface surface:M --workspace workspace:N "return"
    sleep 5  # Claude 起動待ち
    break
  elif echo "$SCREEN" | grep -q '❯'; then
    # プロンプトが表示された → 準備完了
    break
  fi
  sleep 3
done
```

#### Step 6: タスクプロンプトを送信

**重要: 複数行テキストは `cmux send` の `\n` では送信されない。
`cmux send` でテキストを入力した後、`cmux send-key return` で明示的に送信すること。**

```bash
# プロンプトファイルの内容を送信
PROMPT=$(cat .team/prompts/<role-id>.md)
cmux send --surface surface:M --workspace workspace:N "${PROMPT}"
# ↑ \n を付けない！複数行テキストでは改行が入力欄に追加されるだけ

# 明示的に Enter を送信
sleep 0.5
cmux send-key --surface surface:M --workspace workspace:N "return"
```

**注意: 単一行テキスト（シェルコマンドなど）は `\n` で送信可能。
複数行テキスト（プロンプトなど）は `send-key return` が必要。**

#### Step 7: 送信確認とステータス更新

```bash
# 3秒後に画面を確認し、Claude が処理を開始したか検証
sleep 3
SCREEN=$(cmux read-screen --surface surface:M --workspace workspace:N 2>&1)
if echo "$SCREEN" | grep -qE '(Stewing|Thinking|Reading|Writing|Searching)'; then
  # 処理開始を確認
  cmux set-status <role-id> "running" --icon hammer --color "#0099ff"
else
  # 入力欄にテキストが残っている場合は再度 send-key return
  cmux send-key --surface surface:M --workspace workspace:N "return"
  sleep 3
  cmux set-status <role-id> "running" --icon hammer --color "#0099ff"
fi
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

# ステータスを完了に更新
cmux set-status <role-id> "done" --icon sparkle --color "#00cc66"
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
cmux clear-status <role-id>  # サイドバーからステータスを除去

# 全エージェントを終了
# team.json を読み、各 surface を順にクローズし、各 role-id の status を clear
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

**重要: Conductor のペインは十分な幅を維持すること。**
サブエージェントと同一ワークスペースに詰め込むと、Conductor のペインが狭くなり
`cmux send` や `cmux read-screen` の出力が崩れて操作に失敗する。

### 推奨: Conductor は単独ペイン、サブエージェントは別ワークスペース

すべての構成で、サブエージェントは**別ワークスペース**に配置する。
**各ワークスペースには必ずフェーズ/ロールを示す名前を付けること。**

```bash
# サブエージェント用ワークスペースを作成し、名前を付ける
cmux new-workspace --cwd $(pwd)  # → workspace:N, surface:M
cmux rename-workspace --workspace workspace:N "Research"
```

### Small (1+3)
```
workspace:1 "Conductor"  → Conductor（ユーザーと対話）
workspace:2 "Research"   → Agent A, Agent B, Agent C (3-way split)
```

### Medium (1+5)
```
workspace:1 "Conductor"  → Conductor
workspace:2 "Impl-1"     → Agent A, Agent B (split)
workspace:3 "Impl-2"     → Agent C, Agent D, Agent E (3-way split)
```

### Large (1+7)
```
workspace:1 "Conductor"  → Conductor
workspace:2 "Research"    → Agent A, Agent B (split)
workspace:3 "Design"     → Agent C, Agent D (split)
workspace:4 "Impl"       → Agent E, Agent F, Agent G (3-way split)
```

### エージェント用ワークスペースの作成パターン

```bash
# 1. ワークスペース作成 → 最初のサーフェスが返る
cmux new-workspace --cwd $(pwd)  # → workspace:N, surface:M

# 2. すぐに名前を付ける（作成直後に！後回しにしない）
cmux rename-workspace --workspace workspace:N "Research"

# 3. そのワークスペース内で分割
cmux new-split right --workspace workspace:N  # → surface:M+1
cmux new-split right --workspace workspace:N  # → surface:M+2
```

### NG パターン（避けること）

```
# NG: 同一ワークスペースに全員を詰め込む
[Conductor] | [Agent A] | [Agent B] | [Agent C]
# → Conductor のペインが狭くなり cmux コマンドが失敗する
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
