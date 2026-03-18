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

### 4. エージェント起動（1+3 レイアウト）

各リサーチャーに対して順次:

```bash
# a. ペインを作成
cmux new-split right
# → surface:N を取得（出力をパース）

# b. team.json にエージェントを登録
# agents 配列に追加: { "id": "researcher-N", "role": "researcher", "surface": "surface:X", "status": "spawning", "task": "<サブ質問>", "started_at": "<ISO 8601>" }

# c. サイドバーステータス設定
cmux set-status researcher-N "spawning" --icon sparkle --color "#ffcc00"

# d. Claude を起動
cmux send --surface surface:X "claude --dangerously-skip-permissions\n"

# e. Claude の起動完了を待つ
# 最大 30 秒、2 秒間隔でポーリング:
cmux read-screen --surface surface:X --lines 10
# 出力に '❯' または '$' が含まれるまで待つ

# f. プロンプトを送信
# .team/prompts/researcher-N.md の内容を cmux send で送信
# 注意: 長いプロンプトは改行を含むため、ファイルパスを指示する方式を使う:
cmux send --surface surface:X "以下の指示に従ってください。指示ファイル: $(pwd)/.team/prompts/researcher-N.md を読んで実行してください。\n"

# g. ステータス更新
cmux set-status researcher-N "running" --icon hammer --color "#0099ff"
```

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
