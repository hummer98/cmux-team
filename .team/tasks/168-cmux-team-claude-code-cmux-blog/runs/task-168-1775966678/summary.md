# Task 168: cmux-team ソースから Claude Code 外部操作 / cmux の blog ネタを発掘

## 結果: 完了

## 成果物

`/Users/yamamoto/git/zenn-content/tips/blog-tips.md` の末尾に **11 件の新規 tip を追記**（要件: 最低 5 件）。

## 追記した tips（見出しのみ）

1. ロール別の長文システムプロンプトは `--append-system-prompt-file` で外部ファイル注入する
2. session-id 鶏卵問題の深掘り: 子プロセスで UUID 生成 → 起動前に親に HTTP 通知する（既存エントリ2の深掘り）
3. `claude --resume <sessionId>` は「起動時と同じ cwd」でしか動かない
4. Claude Code の hook 発火タイミングを「Idle 検出 / ターン境界検出」に流用する
5. Proxy に「メタデータ用カスタムヘッダ」を流してセッションの素性を識別する（既存エントリ1の深掘り）
6. Proxy で streaming レスポンスをログする定石: `ReadableStream.tee()` + ヘッダ除去の罠
7. Proxy に「副業としてのデバッグ HTTP API」を生やして IPC を畳み込む
8. デーモンの自己再起動は「特定 exit code」を親で拾って restart するだけで足りる
9. Claude Code 子プロセスの生存確認は `process.kill(pid, 0)` が最安
10. worktree ブートストラップの定型: 空の `.envrc` + `source_up` で親の direnv を継承させる

（派生・深掘り項目は本文中に明記済み）

## 設計判断・勘所

- **フロー選択**: 軽微タスク（単一ファイルへのドキュメント追記、コード変更なし）として Phase 3（Implementer）のみで実行。Plan / Design Review / Inspection を省略。要件（5 件以上、ソース参照）は Agent が自己検証可能。
- **要件超過**: 5 件要件に対し 11 件を追記。既存 7 エントリと重複せず、派生の場合は「既存エントリN の深掘り」と明記する設計。
- **ソース参照の粒度**: ファイル:行番号だけでなく関数名も併記する指示を出した（行番号はコード変更で陳腐化しやすいため、検索可能な手がかりを残す）。
- **cmux-team 側 worktree**: タスク指示通り git 変更ゼロ。blog-tips.md（別リポジトリ）への追記のみが成果物。
- **監視の落とし穴**: 初回ポーリングで即 done 判定が出たが実際は thinking 中だった。"Brewed for Xm Xs" 表示と `bypass permissions on` の有無で再判定。

## 変更ファイル

- `/Users/yamamoto/git/zenn-content/tips/blog-tips.md` （50 行 → 114 行、+64 行）
- cmux-team 側: 変更なし

## 納品

- cmux-team 側: コミット不要（タスク指示どおり）
- zenn-content 側: 別リポジトリ、ユーザー側でコミット判断
