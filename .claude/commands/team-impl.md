---
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
description: "実装エージェントを起動しコーディングタスクを並列実行する"
---

# /team-impl

実装エージェントを起動し、コーディングタスクを並列に実行してください。

## 手順

### 1. 前提チェック

- `.team/team.json` が存在すること
- `CMUX_SOCKET_PATH` が設定されていること
- `cmux` コマンドが利用可能であること
- `.team/specs/design.md` が存在すること
  - 存在しない場合: 「設計がありません。`/team-design` を先に実行してください」

### 2. タスク一覧の準備

#### tasks.md が存在する場合:
- `.team/specs/tasks.md` を読み込む
- タスクを解析（各 `## Task N:` セクションを抽出）
- ステータスを確認（完了済み、進行中、未着手）

#### tasks.md が存在しない場合:
- `.team/specs/design.md` を読み込む
- 設計からタスクを自動生成:
  - コンポーネントごとにタスクを分割
  - 依存関係を分析
  - 並列実行可能なタスクに `(P)` フラグを付与
- `.team/specs/tasks.md` に書き出す
- ユーザーに確認: 「タスク一覧を生成しました。確認してください。」

### 3. タスク選択

`$ARGUMENTS` に基づいてタスクを選択:

- `"all"` → 全未着手タスクを対象
- `"1,2,3"` → 指定された番号のタスクのみ
- 空 → 並列実行可能 `(P)` な未着手タスクをすべて対象

依存関係チェック:
- 依存先が未完了のタスクは除外する
- 除外されたタスクがあればユーザーに報告

### 4. エージェント数の決定

- 選択されたタスク数に基づいてエージェント数を決定
- 最大数: Tier に応じて制限
  - Small (1+3): 最大 3 エージェント
  - Medium (1+5): 最大 5 エージェント
  - Large (1+7): 最大 7 エージェント
- デフォルト: Small (1+3)
- タスク数がエージェント数を超える場合は、最初のバッチを実行し、完了後に次のバッチを開始

### 5. プロンプト生成

各実装エージェントに対して:

1. `~/.claude/skills/cmux-team/templates/common-header.md` を読み込み
2. `~/.claude/skills/cmux-team/templates/implementer.md` を読み込み
3. テンプレート変数を置換:
   - `{{ROLE_ID}}` → `implementer-N`
   - `{{TASK_DESCRIPTION}}` → 割り当てタスクの説明
   - `{{OUTPUT_FILE}}` → `.team/output/implementer-N.md`
   - `{{PROJECT_ROOT}}` → カレントディレクトリ
   - `{{TASKS_CONTENT}}` → 割り当てタスクの詳細
   - `{{DESIGN_CONTENT}}` → design.md の内容
   - `{{COMMON_HEADER}}` → 展開済み共通ヘッダー
4. `.team/prompts/implementer-N.md` に書き出す

### 6. エージェント起動

レイアウト戦略:
- 3 エージェント以下: `cmux new-split right` で同一ワークスペースに配置
- 4 エージェント以上: `cmux new-workspace --cwd $(pwd)` で別ワークスペースを使用

各エージェントに対して:

```bash
# a. ペイン作成（レイアウトに応じて new-split または new-workspace）
cmux new-split right  # → surface:N

# b. team.json にエージェント登録
# c. ステータス設定
cmux set-status implementer-N "spawning" --icon sparkle --color "#ffcc00"

# d. Claude 起動
cmux send --surface surface:N "claude --dangerously-skip-permissions\n"

# e. 起動完了を待つ
# f. プロンプト送信
cmux send --surface surface:N "$(pwd)/.team/prompts/implementer-N.md を読んで指示に従ってください。\n"

# g. ステータス更新
cmux set-status implementer-N "running" --icon hammer --color "#0099ff"
```

### 7. 進捗モニタリング

```bash
cmux set-progress 0.0 --label "Implementation: 0/N tasks done"
```

30 秒間隔で各エージェントをモニタリング:

```bash
# 画面確認
cmux read-screen --surface surface:X --lines 20

# 出力ファイルの存在チェック
ls -la .team/output/implementer-N.md 2>/dev/null
```

モニタリング中に表示する情報:
- 各エージェントの最新ステータス（cmux のサイドバーから取得）
- 完了したエージェントの数
- エラーが発生したエージェント

### 8. 完了待機と次バッチ

```bash
# 各エージェントの完了を待つ
cmux wait-for "implementer-N-done" --timeout 600
```

エージェントが完了したら:
1. 出力を収集（`.team/output/implementer-N.md`）
2. tasks.md の対応タスクを完了マークに更新
3. team.json の completed_outputs に追加
4. プログレスバーを更新

**次バッチの処理**（タスクがエージェント数を超えている場合）:
1. 完了したエージェントのペインを再利用
2. 次の未着手タスクのプロンプトを生成
3. 同じ surface に新しいプロンプトを送信
4. 全タスク完了まで繰り返す

### 9. 結果統合

全エージェントの完了後:

1. 全出力ファイルを読み込み
2. 統合サマリーを作成:
   - **完了タスク**: 各タスクの完了状況
   - **変更ファイル一覧**: 全エージェントが変更したファイルの統合リスト
   - **テスト結果**: 各エージェントが実行したテスト結果
   - **イシュー**: エージェントが作成したイシュー
3. ユーザーに提示

### 10. クリーンアップと状態更新

- エージェントペインの処理をユーザーに確認
- team.json:
  - phase を `"implementation"` に更新
  - 完了したエージェントの情報を更新
- プログレスバーをクリア

### 11. 次のステップ案内

```
実装フェーズが完了しました。

完了タスク: N/M
変更ファイル: X 個
イシュー: Y 件

次のステップ:
  /team-review  → 実装のレビュー
  /team-test    → テストの作成・実行
  /team-impl    → 残りのタスクを実装（未完了がある場合）
```

## 引数

`$ARGUMENTS` = 実装するタスク番号（例: "1,2,3" または "all"）。オプション。

## エラーハンドリング

- エージェントがクラッシュした場合: 検出後リスポーンを提案
- コンフリクトが発生した場合（複数エージェントが同じファイルを変更）:
  - 検出: `git status` で確認
  - ユーザーに報告し、手動解決を案内
- タスクが長時間完了しない場合: 画面を確認し、ユーザーに判断を委ねる
