---
allowed-tools: Bash, Read, Write, Edit
description: "全サブエージェントを終了しチームを解散する"
---

# /team-disband

すべてのサブエージェントペインを終了し、チームを解散してください。

## 手順

1. **`.team/team.json` を読み込む**:
   - 存在しない場合は「チーム未初期化です」と表示して終了

2. **アクティブエージェントの確認**:
   - agents 配列が空なら「アクティブなエージェントはありません」と表示して終了

3. **各エージェントを終了**:
   `$ARGUMENTS` に "force" が含まれる場合はグレースフル終了をスキップ。

   **通常終了（グレースフル）**:
   各エージェントに対して:
   ```bash
   # a. /exit コマンドを送信
   cmux send --surface <surface-ref> "/exit\n"

   # b. 少し待つ (Claude が終了するのを待つ)
   sleep 2

   # c. Surface をクローズ
   cmux close-surface --surface <surface-ref>

   # d. ステータスをクリア
   cmux clear-status <role-id>
   ```

   **強制終了** (`/team-disband force`):
   ```bash
   cmux close-surface --surface <surface-ref>
   cmux clear-status <role-id>
   ```

4. **プログレスバーをクリア**:
   ```bash
   cmux clear-progress
   ```

5. **team.json を更新**:
   - agents 配列を空にする
   - phase を "disbanded" に更新

6. **サマリーを表示**:
   - 終了したエージェント数
   - 収集済みの出力ファイル一覧
   - `.team/output/` にある成果物の案内

## 引数

`$ARGUMENTS` = "force"（オプション）: グレースフル終了をスキップし即座にペインをクローズ

## 注意事項

- `.team/` ディレクトリ自体は削除しない（出力やイシューは保持）
- cmux が利用できない場合は team.json のみ更新する
- エージェントが応答しない場合は 5 秒後に強制クローズにフォールバック
