---
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
description: "リサーチエージェントを起動しトピックを並列調査する"
---

# /team-research

リサーチャーエージェントを起動し、指定トピックを並列に調査してください。

## 手順

### 1. 前提チェック

- `.team/team.json` が存在すること（なければ `/team-init` を案内）
- `CMUX_SOCKET_PATH` が設定されていること（なければエラー）
- `cmux` コマンドが利用可能であること

### 2. トピック解析

`$ARGUMENTS` を解析する:

- **カンマ区切りの場合** (例: "認証方式, セッション管理, トークン設計"):
  各項目をそのままサブ質問として使用
- **単一トピックの場合** (例: "認証パターンの調査"):
  トピックを 3 つのサブ質問に分解する。分解の観点:
  - 現状分析（What）: 既存コードベースでの実装状況
  - 比較調査（How）: 一般的なパターンやベストプラクティス
  - 適用性評価（Why）: このプロジェクトにおける推奨アプローチ
- **空の場合**: ユーザーにトピックを尋ねる

### 3. プロンプト生成

各リサーチャー（最大 3 名）のプロンプトを生成する:

1. `~/.claude/skills/cmux-team/templates/common-header.md` を読み込み
2. `~/.claude/skills/cmux-team/templates/researcher.md` を読み込み
3. テンプレート変数を置換:
   - `{{ROLE_ID}}` → `researcher-1`, `researcher-2`, `researcher-3`
   - `{{TASK_DESCRIPTION}}` → 各サブ質問
   - `{{OUTPUT_FILE}}` → `.team/output/researcher-{N}.md`
   - `{{PROJECT_ROOT}}` → カレントディレクトリの絶対パス
   - `{{TOPIC}}` → 元のトピック
   - `{{SUB_QUESTIONS}}` → 割り当てられたサブ質問
   - `{{COMMON_HEADER}}` → 展開済み共通ヘッダー
4. `.team/prompts/researcher-{1,2,3}.md` に書き出す

### 4. エージェント起動

サブエージェントの配置は cmux-team SKILL.md §5 参照。

#### 4a. エージェント用ペインを作成

```bash
# Conductor と同じワークスペース内で分割（デフォルト）
cmux new-split right  # → surface:S1
cmux new-split right  # → surface:S2
cmux new-split right  # → surface:S3
```

#### 4b. 各リサーチャーを1体ずつ起動

**1体ずつ確実に起動すること。全員同時にやらない。**

各リサーチャー（N=1,2,3）に対して:

```bash
# team.json にエージェントを登録
# agents 配列に追加: { "id": "researcher-N", "role": "researcher",
#   "surface": "surface:SN", "workspace": "workspace:W",
#   "status": "spawning", "task": "<サブ質問>", "started_at": "<ISO 8601>" }

# サイドバーステータス設定
cmux set-status researcher-N "spawning" --icon sparkle --color "#ffcc00"

# Claude を起動（シェルコマンドは \n で送信可能）
cmux send --surface surface:SN --workspace workspace:W "claude --dangerously-skip-permissions\n"

# Claude の起動完了を待つ（最大30秒ポーリング）
# "Yes, I trust" → send-key return で承認
# "❯" → プロンプト送信可能
for i in $(seq 1 10); do
  SCREEN=$(cmux read-screen --surface surface:SN --workspace workspace:W 2>&1)
  if echo "$SCREEN" | grep -q "Yes, I trust"; then
    cmux send-key --surface surface:SN --workspace workspace:W "return"
    sleep 5; break
  elif echo "$SCREEN" | grep -q '❯'; then
    break
  fi
  sleep 3
done

# プロンプトを送信（単一行指示 → \n で送信可能）
cmux send --surface surface:SN --workspace workspace:W ".team/prompts/researcher-N.md を読んで、その指示に従って作業してください。\n"

# 送信確認（3秒後に処理開始を検出）
sleep 3
SCREEN=$(cmux read-screen --surface surface:SN --workspace workspace:W 2>&1)
if echo "$SCREEN" | grep -qE '(Stewing|Thinking|Reading|Searching|Ideating)'; then
  cmux set-status researcher-N "running" --icon hammer --color "#0099ff"
else
  # 入力欄に残っている場合は再度 Enter
  cmux send-key --surface surface:SN --workspace workspace:W "return"
  sleep 3
  cmux set-status researcher-N "running" --icon hammer --color "#0099ff"
fi
```

**ポイント**:
- プロンプト送信は「ファイルパスを読んで実行して」の単一行指示を推奨
- 複数行テキストを直接送る場合は `cmux send` + `cmux send-key return` の2段階が必要

### 5. 進捗トラッキング

```bash
cmux set-progress 0.0 --label "Research: 0/3 agents done"
```

### 6. 完了待機

各リサーチャーの完了を待つ:

```bash
# 並列で待機（各エージェントに対して）
cmux wait-for "researcher-1-done" --timeout 300
cmux wait-for "researcher-2-done" --timeout 300
cmux wait-for "researcher-3-done" --timeout 300
```

待機中、定期的に（30 秒ごとに）:
- 各エージェントの画面を `cmux read-screen` で確認
- エラーがあれば報告
- 進捗バーを更新

タイムアウトした場合:
- `cmux read-screen` で状態を確認
- ユーザーに報告し、待機を続けるか判断を委ねる

### 7. 結果収集

完了したエージェントの出力を収集:

```bash
# 各出力ファイルを読み込み
cat .team/output/researcher-1.md
cat .team/output/researcher-2.md
cat .team/output/researcher-3.md
```

- 出力ファイルが存在しない場合はスクリーンスクレイピングにフォールバック:
  ```bash
  cmux read-screen --surface surface:X --scrollback --lines 200
  ```

### 8. 結果統合

3 つのリサーチ結果を統合して:

1. **統合サマリー**: 主要な発見事項を 5-7 bullet points で
2. **サブ質問ごとの回答**: 各リサーチャーの結果を構造化
3. **共通する発見**: 複数のリサーチャーが指摘した事項
4. **相違点**: リサーチャー間で見解が異なる部分
5. **推奨事項**: 統合した推奨アクション
6. **オープン質問**: 未解決の事項

### 9. 結果保存

ユーザーに確認後:
- 統合結果を `.team/specs/research.md` に保存
- team.json の phase を `"research"` に更新
- team.json の completed_outputs に追加

### 10. クリーンアップ

ユーザーに確認:
- リサーチャーペインを閉じるか？
  - YES: 各ペインを `/exit` → `cmux close-surface` → ステータスクリア
  - NO: ペインは残しておく（後で `/team-disband` で閉じられる）
- プログレスバーをクリア: `cmux clear-progress`

## 引数

`$ARGUMENTS` = リサーチトピック、またはカンマ区切りのサブトピック

## エラーハンドリング

- cmux コマンドが失敗した場合: エラーメッセージを表示し、手動での対応方法を案内
- エージェントが起動しない場合: surface を閉じて再試行を提案
- 部分的な結果の場合: 完了したエージェントの結果のみで統合を実施
