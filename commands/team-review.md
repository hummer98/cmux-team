---
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
description: "レビューエージェントを起動し実装をレビューする"
---

# /team-review

レビューエージェントを起動し、実装をレビューしてください。

## 手順

### 1. 前提チェック

- `.team/team.json` が存在すること
- `CMUX_SOCKET_PATH` が設定されていること
- `cmux` コマンドが利用可能であること

### 2. レビュー対象の収集

#### git diff の収集

```bash
# team-init 以降の変更（.team/ 内を除く）
git diff HEAD~10 --stat -- . ':!.team'
# または、最新の実装以降の diff
git diff --stat -- . ':!.team'
```

変更がない場合: 「レビュー対象の変更がありません」と表示して終了

#### diff の詳細取得

```bash
git diff HEAD~10 -- . ':!.team'
```

差分が大きい場合（500 行超）:
- ファイルごとに分割してレビューエージェントに割り当てる
- 最大 3 名のレビュアーに分担

#### コンテキスト収集

- `.team/specs/requirements.md` — 要件定義
- `.team/specs/design.md` — 設計ドキュメント
- `.team/output/implementer-*.md` — 実装エージェントの出力（あれば）
- `.team/tasks/open/` — オープンタスク

### 3. レビュアー数の決定

- 差分が小さい（200 行以下）: 1 名
- 差分が中程度（200-500 行）: 2 名（ファイルを分担）
- 差分が大きい（500 行超）: 3 名（モジュール・機能ごとに分担）

### 4. プロンプト生成

各レビュアーに対して:

1. `~/.claude/skills/cmux-team/templates/common-header.md` を読み込み
2. `~/.claude/skills/cmux-team/templates/reviewer.md` を読み込み
3. テンプレート変数を置換:
   - `{{ROLE_ID}}` → `reviewer-impl` (1 名の場合) または `reviewer-impl-N`
   - `{{TASK_DESCRIPTION}}` → "実装レビュー: <担当範囲>"
   - `{{OUTPUT_FILE}}` → `.team/output/reviewer-impl.md` (または `-N`)
   - `{{ARTIFACT_CONTENT}}` → 担当する git diff の内容
   - `{{REQUIREMENTS_CONTENT}}` → requirements.md の内容
   - `{{DESIGN_CONTENT}}` → design.md の内容
   - `{{COMMON_HEADER}}` → 展開済み共通ヘッダー
4. `.team/prompts/reviewer-impl.md` (または `-N`) に書き出す

### 5. レビューエージェント起動

サブエージェントの配置は cmux-team SKILL.md §5 参照。

```bash
# Conductor と同じワークスペース内で分割（デフォルト）
cmux new-split right  # → surface:S
# 複数レビュアーの場合は追加分割
# cmux new-split right  # → surface:S2
```

各レビュアーに対して（**1体ずつ、cmux-team SKILL.md §2.1 の手順に従う**）:

```bash
# a. ステータス設定
cmux set-status reviewer-impl "spawning" --icon sparkle --color "#ffcc00"

# c. Claude 起動（シェルコマンドは \n で送信可能）
cmux send --surface surface:S --workspace workspace:W "claude --dangerously-skip-permissions\n"

# d. 起動完了を待つ（Trust確認 or ❯ プロンプトをポーリング、SKILL.md §2.1 Step 5 参照）
for i in $(seq 1 10); do
  SCREEN=$(cmux read-screen --surface surface:S --workspace workspace:W 2>&1)
  if echo "$SCREEN" | grep -q "Yes, I trust"; then
    cmux send-key --surface surface:S --workspace workspace:W "return"
    sleep 5; break
  elif echo "$SCREEN" | grep -q '❯'; then
    break
  fi
  sleep 3
done

# e. プロンプト送信（単一行指示 → \n で送信可能）
cmux send --surface surface:S --workspace workspace:W ".team/prompts/reviewer-impl.md を読んで指示に従ってください。\n"

# f. 送信確認 + ステータス更新
sleep 3
SCREEN=$(cmux read-screen --surface surface:S --workspace workspace:W 2>&1)
if ! echo "$SCREEN" | grep -qE '(Stewing|Thinking|Reading|Searching|Ideating)'; then
  cmux send-key --surface surface:S --workspace workspace:W "return"
  sleep 3
fi
cmux set-status reviewer-impl "running" --icon hammer --color "#0099ff"
```

### 6. 完了待機

```bash
cmux set-progress 0.0 --label "Review: in progress..."
cmux wait-for "reviewer-impl-done" --timeout 300
# 複数の場合:
# cmux wait-for "reviewer-impl-1-done" --timeout 300
# cmux wait-for "reviewer-impl-2-done" --timeout 300
```

### 7. レビュー結果の収集と統合

1. `.team/output/reviewer-impl*.md` を読み込む
2. 結果を統合:

```markdown
## レビュー結果サマリー

### Verdict: <Approved / Changes Requested>

### 指摘事項

#### Critical
- [C-1] <指摘内容> (ファイル: path/to/file.ext)

#### Major
- [M-1] <指摘内容> (ファイル: path/to/file.ext)

#### Minor
- [m-1] <指摘内容> (ファイル: path/to/file.ext)

#### Suggestion
- [S-1] <提案内容>

### 要件カバレッジ
- REQ-001: ✅ / ❌
- REQ-002: ✅ / ❌
```

### 8. タスク作成

Critical/Major の指摘に対して自動的にタスクを作成:

各指摘に対して `.team/tasks/open/NNN-<slug>.md` を作成:
```markdown
---
id: NNN
title: "[Review] <指摘タイトル>"
type: finding
raised_by: reviewer-impl
created_at: <ISO 8601>
severity: critical|major
---

## Context
レビューで検出された指摘事項。

## Details
<指摘の詳細>

## Affected Files
- <ファイルパス>

## Recommendation
<修正方法の提案>
```

### 9. 結果提示とアクション

ユーザーに統合結果を提示し:

- **Approved**: 「レビュー合格です。次のステップに進めます。」
- **Changes Requested**:
  - Critical/Major 指摘の一覧を強調表示
  - 「指摘事項を修正しますか？」
    - **手動で修正**: ユーザーが自分で対応
    - **実装エージェントで修正**: `/team-impl` で修正タスクとして実行
    - **再レビュー**: 修正後に `/team-review` を再実行

### 10. クリーンアップと状態更新

- レビュアーペインを閉じる
- （team.json は daemon が自動更新する）
- プログレスバーをクリア

### 11. 次のステップ案内

```
レビューが完了しました。

指摘: Critical X件 / Major Y件 / Minor Z件 / Suggestion W件
タスク作成: N件

次のステップ:
  /team-impl    → 指摘事項を修正（Changes Requested の場合）
  /team-test    → テストフェーズに進む（Approved の場合）
  /team-task    → タスクの確認・管理
```

## 引数

なし

## エラーハンドリング

- git diff が取得できない場合: git リポジトリでない、またはコミットがない場合のエラーメッセージ
- レビュアーがタイムアウトした場合: 画面を確認し対処を提案
- 差分が非常に大きい場合（2000 行超）: 警告を表示し、範囲を絞るか確認
