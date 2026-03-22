---
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
description: "アーキテクト+レビュアーエージェントで設計フェーズを実行する"
---

# /team-design

アーキテクトとレビュアーエージェントを起動し、設計フェーズを実行してください。

## 手順

### 1. 前提チェック

- `.team/team.json` が存在すること
- `CMUX_SOCKET_PATH` が設定されていること
- `cmux` コマンドが利用可能であること
- `.team/specs/requirements.md` が存在し、`Status: Approved` が含まれていること
  - 存在しない場合: 「要件定義がありません。`/team-spec` を先に実行してください」
  - 未承認の場合: 「要件が未承認です。`/team-spec` で承認してください」と警告（続行は可能）

### 2. コンテキスト収集

以下を読み込む:
- `.team/specs/requirements.md` — 要件定義
- `.team/specs/research.md` — リサーチ結果（あれば）
- `.team/issues/open/` — オープンイシュー（あれば）
- プロジェクトの主要ディレクトリ構造

### 3. アーキテクトプロンプト生成

1. `~/.claude/skills/cmux-team/templates/common-header.md` を読み込み
2. `~/.claude/skills/cmux-team/templates/architect.md` を読み込み
3. テンプレート変数を置換:
   - `{{ROLE_ID}}` → `architect`
   - `{{TASK_DESCRIPTION}}` → "要件に基づく技術設計の作成"
   - `{{OUTPUT_FILE}}` → `.team/output/architect.md`
   - `{{PROJECT_ROOT}}` → カレントディレクトリ
   - `{{REQUIREMENTS_CONTENT}}` → requirements.md の内容
   - `{{RESEARCH_SUMMARY}}` → research.md の内容（あれば。なければ "リサーチ結果なし"）
   - `{{CODEBASE_CONTEXT}}` → 主要ディレクトリ構造 + 既存の主要ファイル一覧
   - `{{COMMON_HEADER}}` → 展開済み共通ヘッダー
4. `.team/prompts/architect.md` に書き出す

### 4. アーキテクトエージェント起動

サブエージェントの配置は cmux-team SKILL.md §5 参照。

```bash
# a. Conductor と同じワークスペース内で分割（デフォルト）
cmux new-split right  # → surface:S

# b. team.json にエージェント登録
# c. ステータス設定
cmux set-status architect "spawning" --icon sparkle --color "#ffcc00"

# d. Claude 起動（シェルコマンドは \n で送信可能）
cmux send --surface surface:S --workspace workspace:W "claude --dangerously-skip-permissions\n"

# e. 起動完了を待つ（Trust確認 or ❯ プロンプトをポーリング、cmux-team SKILL.md §2.1 Step 5 参照）
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

# f. プロンプト送信（単一行指示 → \n で送信可能）
cmux send --surface surface:S --workspace workspace:W ".team/prompts/architect.md を読んで指示に従ってください。\n"

# g. 送信確認 + ステータス更新
sleep 3
SCREEN=$(cmux read-screen --surface surface:S --workspace workspace:W 2>&1)
if ! echo "$SCREEN" | grep -qE '(Stewing|Thinking|Reading|Searching|Ideating)'; then
  cmux send-key --surface surface:S --workspace workspace:W "return"
  sleep 3
fi
cmux set-status architect "running" --icon hammer --color "#0099ff"
```

### 5. アーキテクト完了待機

```bash
cmux set-progress 0.0 --label "Design: architect working..."
cmux wait-for "architect-done" --timeout 600
```

- 10 分のタイムアウト（設計は時間がかかる場合がある）
- 定期的に画面を確認し、進捗を報告

### 6. 設計結果の処理

1. `.team/output/architect.md` を読み込む
2. 内容を `.team/specs/design.md` にコピー
3. ユーザーに設計概要を提示
4. アーキテクトペインを閉じる（またはアイドル状態にする）

### 7. レビュアー起動

ユーザーに確認: 「設計のレビューを実行しますか？」

YES の場合:

```bash
# Design ワークスペース内で分割（アーキテクトペインを再利用 or 新規分割）
cmux new-split right --workspace workspace:W  # → surface:A
cmux new-split right --workspace workspace:W  # → surface:B
```

各レビュアーに対して（cmux-team SKILL.md §2.1 の手順に従う）:
1. `~/.claude/skills/cmux-team/templates/reviewer.md` からプロンプトを生成
   - `{{ROLE_ID}}` → `reviewer-1`, `reviewer-2`
   - `{{ARTIFACT_CONTENT}}` → design.md の内容
   - `{{REQUIREMENTS_CONTENT}}` → requirements.md の内容
   - `{{DESIGN_CONTENT}}` → ""（設計そのものをレビュー中のため）
2. `.team/prompts/reviewer-{1,2}.md` に書き出す
3. 1体ずつ起動: Claude 起動 → Trust 確認ポーリング → プロンプト送信（`send-key return`）→ 送信確認
4. team.json にエージェント登録

### 8. レビュアー完了待機

```bash
cmux set-progress 0.5 --label "Design: reviewers working..."
cmux wait-for "reviewer-1-done" --timeout 300
cmux wait-for "reviewer-2-done" --timeout 300
```

### 9. レビュー結果の統合

1. `.team/output/reviewer-1.md` と `.team/output/reviewer-2.md` を読み込む
2. レビュー結果を統合:
   - **Verdict**: 両方 Approved なら "Approved"、それ以外は "Changes Requested"
   - **共通指摘**: 両レビュアーが指摘した問題
   - **個別指摘**: 各レビュアー固有の指摘
   - **Critical/Major 項目**: 即座に対応が必要な指摘
3. 統合結果をユーザーに提示

### 10. イテレーション判断

レビュー結果に基づいて:

- **Approved**:
  - `.team/specs/design.md` の末尾に承認ステータスを追記
  - 次のステップ案内
- **Changes Requested**:
  - Critical/Major 指摘を一覧表示
  - ユーザーに確認: 「設計を修正しますか？」
    - YES: レビューフィードバックをアーキテクトプロンプトに追加し、再度アーキテクトを起動（手順 3 に戻る）
    - NO: 現状の設計で続行（ユーザー判断）

### 11. タスク分解（オプション）

設計が承認されたら:
- ユーザーに確認: 「設計からタスク一覧を生成しますか？」
- YES の場合:
  - design.md を分析してタスクを抽出
  - 各タスクに並列実行可能フラグ `(P)` を付与
  - `.team/specs/tasks.md` に書き出す
  - 形式:
    ```markdown
    # タスク一覧

    ## Task 1: <タスク名> (P)
    - 説明: <詳細>
    - 依存: なし
    - 推定規模: S/M/L

    ## Task 2: <タスク名>
    - 説明: <詳細>
    - 依存: Task 1
    - 推定規模: M
    ```

### 12. クリーンアップと状態更新

- レビュアーペインを閉じる
- team.json:
  - phase を `"design"` に更新
  - completed_outputs に出力ファイルを追加
- プログレスバーをクリア

### 13. 次のステップ案内

```
設計フェーズが完了しました。

次のステップ:
  /team-impl    → 実装フェーズに進む
  /team-review  → 追加レビューが必要な場合
```

## 引数

なし

## エラーハンドリング

- アーキテクトがタイムアウトした場合: 画面を確認し、進捗に応じて延長または中断を提案
- レビュアーの結果が矛盾する場合: 両者の見解を並列表示し、ユーザーに判断を委ねる
- イテレーションが 3 回を超えた場合: ユーザーに設計の根本的な見直しを提案
