---
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
description: "テストエージェントを起動しテストを作成・実行する"
---

# /team-test

テストエージェントを起動し、テストの作成と実行を行ってください。

## 手順

### 1. 前提チェック

- `.team/team.json` が存在すること
- `CMUX_SOCKET_PATH` が設定されていること
- `cmux` コマンドが利用可能であること

### 2. テストスコープの決定

`$ARGUMENTS` に基づいてスコープを決定:

- `"unit"` → ユニットテストのみ
- `"integration"` → 統合テストのみ
- `"e2e"` → E2E テストのみ
- `"all"` → 全スコープ（最大 3 エージェント）
- 空 → プロジェクトの構成を分析して自動決定

自動決定の基準:
- テストフレームワークの検出（jest, pytest, go test, etc.）
- 既存のテストファイルの構造を確認
- 変更されたファイルの種類に基づいて適切なスコープを選択

### 3. コンテキスト収集

以下を読み込む:
- `.team/specs/requirements.md` — テスト対象の要件
- `.team/specs/design.md` — 設計ドキュメント
- `.team/output/implementer-*.md` — 実装出力（変更ファイル一覧）
- 既存のテストファイル（パターン検出用）
- `git diff` — 最近の変更内容

```bash
# 変更されたファイル一覧
git diff --name-only HEAD~10 -- . ':!.team'

# テストファイルの既存パターン
find . -name "*test*" -o -name "*spec*" | head -20
```

### 4. テストエージェント数の決定

- `"unit"` のみ: 1 エージェント
- `"integration"` のみ: 1 エージェント
- `"e2e"` のみ: 1 エージェント
- `"all"` または自動: 最大 3 エージェント（各スコープに 1 名）
- 該当するスコープがない場合は省略（例: E2E テストが不要なプロジェクト）

### 5. プロンプト生成

各テストエージェントに対して:

1. `~/.claude/skills/cmux-team/templates/common-header.md` を読み込み
2. `~/.claude/skills/cmux-team/templates/tester.md` を読み込み
3. テンプレート変数を置換:
   - `{{ROLE_ID}}` → `tester-unit`, `tester-integration`, `tester-e2e`
   - `{{TASK_DESCRIPTION}}` → "<スコープ>テストの作成と実行"
   - `{{OUTPUT_FILE}}` → `.team/output/tester-<scope>.md`
   - `{{PROJECT_ROOT}}` → カレントディレクトリ
   - `{{TEST_SCOPE}}` → テストスコープの説明と対象ファイル
   - `{{IMPLEMENTATION_SUMMARY}}` → 実装出力のサマリー + git diff
   - `{{REQUIREMENTS_CONTENT}}` → requirements.md の内容
   - `{{COMMON_HEADER}}` → 展開済み共通ヘッダー
4. `.team/prompts/tester-<scope>.md` に書き出す

### 6. テストエージェント起動

サブエージェントの配置は cmux-team SKILL.md §5 参照。

```bash
# Conductor と同じワークスペース内で分割（デフォルト）
cmux new-split right  # → surface:S
# 複数テスターの場合は追加分割
# cmux new-split right  # → surface:S2
```

各テスターに対して（**1体ずつ、cmux-team SKILL.md §2.1 の手順に従う**）:

```bash
# a. team.json にエージェント登録
# b. ステータス設定
cmux set-status tester-<scope> "spawning" --icon sparkle --color "#ffcc00"

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
cmux send --surface surface:S --workspace workspace:W ".team/prompts/tester-<scope>.md を読んで指示に従ってください。\n"

# f. 送信確認 + ステータス更新
sleep 3
SCREEN=$(cmux read-screen --surface surface:S --workspace workspace:W 2>&1)
if ! echo "$SCREEN" | grep -qE '(Stewing|Thinking|Reading|Searching|Ideating)'; then
  cmux send-key --surface surface:S --workspace workspace:W "return"
  sleep 3
fi
cmux set-status tester-<scope> "running" --icon hammer --color "#0099ff"
```

### 7. 完了待機

```bash
cmux set-progress 0.0 --label "Testing: 0/N scopes done"

# 各エージェントの完了を待つ
cmux wait-for "tester-unit-done" --timeout 300
cmux wait-for "tester-integration-done" --timeout 300
cmux wait-for "tester-e2e-done" --timeout 300
```

### 8. テスト結果の収集

各エージェントの出力を読み込み:
- `.team/output/tester-unit.md`
- `.team/output/tester-integration.md`
- `.team/output/tester-e2e.md`

### 9. テスト実行の検証

エージェントの報告に加えて、Conductor 自身でもテストを実行して結果を確認:

```bash
# プロジェクトのテストランナーを検出して実行
# 例: npm test, pytest, go test ./..., etc.
```

### 10. 結果統合

テスト結果を統合してユーザーに提示:

```markdown
## テスト結果サマリー

### 概要
- ユニットテスト: ✅ 15 passed / ❌ 2 failed
- 統合テスト: ✅ 8 passed / ❌ 0 failed
- E2E テスト: ⏭️ スキップ

### 失敗したテスト
1. `test_auth_token_refresh` — Expected 200, got 401
2. `test_session_timeout` — Timeout after 5s

### 新規作成テスト
- `tests/unit/test_auth.py` (5 tests)
- `tests/integration/test_api.py` (8 tests)

### カバレッジ
- 要件カバレッジ: 12/15 (80%)
- 未カバー要件: REQ-003, REQ-007, REQ-012
```

### 11. テスト失敗のイシュー化

失敗したテストに対して自動的にイシューを作成:

`.team/tasks/open/NNN-test-failure-<name>.md`:
```markdown
---
id: NNN
title: "[Test] <テスト名> が失敗"
type: finding
raised_by: tester-<scope>
created_at: <ISO 8601>
severity: major
---

## 失敗内容
<エラーメッセージ>

## 期待される動作
<期待値>

## 実際の動作
<実際の値>

## 対象ファイル
- <テストファイル>
- <テスト対象ファイル>
```

### 12. クリーンアップと状態更新

- テストエージェントのペインを閉じる
- team.json:
  - phase を `"test"` に更新
  - completed_outputs に出力ファイルを追加
- プログレスバーをクリア

### 13. 次のステップ案内

```
テストフェーズが完了しました。

結果: X passed / Y failed
カバレッジ: Z%
イシュー作成: N 件

次のステップ:
  /team-impl       → テスト失敗の修正（失敗がある場合）
  /team-sync-docs  → ドキュメント同期
  /team-task       → タスクの確認・管理
```

## 引数

`$ARGUMENTS` = テストスコープ（"unit", "integration", "e2e", "all"）。オプション。

## エラーハンドリング

- テストフレームワークが見つからない場合: プロジェクトの技術スタックを分析し、適切なフレームワークを提案
- テスト実行がタイムアウトした場合: 無限ループや重いテストの可能性を報告
- エージェントがテストを書けなかった場合: 出力を確認し、手動での対応を提案
