---
allowed-tools: Bash, Read, Glob, Grep
description: "チームの現在の状態を表示する"
---

# /team-status

現在のチーム状態を包括的に表示してください。

## 手順

1. **`.team/team.json` を読み込む**:
   - 存在しない場合は「チーム未初期化。`/team-init` を実行してください」と案内

2. **チーム概要を表示**:
   - プロジェクト名、説明、フェーズ
   - 作成日時

3. **エージェント状態を表示**（team.json の agents 配列）:
   各エージェントについて:
   - ロール ID
   - ステータス (spawning/running/done/error/idle)
   - Surface 参照
   - 現在のタスク
   - 開始時刻

4. **cmux トポロジーを取得**:
   ```bash
   cmux tree --all
   ```
   - cmux が利用できない場合はスキップ

5. **エージェントの健全性チェック**:
   各アクティブエージェント（status が running のもの）に対し:
   ```bash
   cmux read-screen --surface <surface-ref> --lines 5
   ```
   - プロンプト `❯` が表示されていればアイドル
   - エラーメッセージが表示されていれば報告

6. **イシュー状況を表示**:
   - `.team/issues/open/` 内のファイル数
   - `.team/issues/closed/` 内のファイル数

7. **出力状況を表示**:
   - `.team/output/` 内のファイル一覧
   - `completed_outputs` の一覧

8. **結果をフォーマットして表示**:
   ```
   ## チーム状態: <project-name>
   フェーズ: <phase>
   作成日: <created_at>

   ### エージェント (<N> 名)
   | ロール | ステータス | Surface | タスク |
   |--------|-----------|---------|--------|
   | ...    | ...       | ...     | ...    |

   ### イシュー
   オープン: N件 / クローズ: M件

   ### 出力
   - <ファイル一覧>
   ```

## 引数

なし
