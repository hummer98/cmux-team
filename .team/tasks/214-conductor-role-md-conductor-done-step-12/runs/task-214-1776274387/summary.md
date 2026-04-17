# T214 summary

## タスク

`conductor-role.md` の CONDUCTOR_DONE 二重送信を解消する (step 12 削除)。

## 変更内容

Implementer Agent に委譲して以下を編集:

- `skills/cmux-team/templates/ja/conductor-role.md`
- `skills/cmux-team/templates/en/conductor-role.md`

### 編集ポイント

1. **Step 12 を丸ごと削除**
   - 日本語版: 「### Step 12: 完了通知を送信する」+ `cmux-team send CONDUCTOR_DONE ...` のコードブロック + 「その後 ❯ プロンプトに戻り...」の段落
   - 英語版: 同等の箇所を削除
2. **Step 11 の前置き文言を調整**
   - 日: 「CONDUCTOR_DONE の前に、以下の形式で勘所を出力する。」→「以下の形式で勘所を出力する。」
   - 英: "Before CONDUCTOR_DONE, output key takeaways..." → "Output key takeaways..."
3. **Step 11 の末尾に「close-task が完了通知を行う」旨の補足を追加**
   - 日: 「完了レポートを出力したら、あとは ❯ プロンプトに戻って待機する。`close-task` が daemon に完了通知を送っているので追加の送信操作は不要。daemon がリセット処理（`/clear` 送信）を行う。」
   - 英: "Once the completion report has been printed, simply return to the ❯ prompt and wait. `close-task` already sends the completion notification to the daemon, so no extra send is required. The daemon will reset the session (send `/clear`)."
4. **冒頭の「新順序は以下の 12 ステップ」→「新順序は以下の 11 ステップ」に更新**（タスク指示外の整合修正、論理的に必要）

## 差分サイズ

```
 skills/cmux-team/templates/en/conductor-role.md | 12 +++---------
 skills/cmux-team/templates/ja/conductor-role.md | 12 +++---------
 2 files changed, 6 insertions(+), 18 deletions(-)
```

## 範囲外（やらなかったこと）

- `.team/prompts/conductor-role.md` の更新（ランタイムは派生物）
- 他プロジェクト（Dear 等）のランタイムプロンプト編集
- CONDUCTOR_DONE への taskId フィールド追加
- daemon 側ハンドラの taskId 一致検証
- T213 復旧作業（別タスクで人間判断）

## マージコミット

commit + merge 後に追記する。
