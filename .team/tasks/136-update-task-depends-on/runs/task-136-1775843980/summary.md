# Task 136: update-task に --depends-on オプションを追加

## Verdict: GO

## 完了サブタスク
- [x] Phase 1: Plan（実装計画作成）
- [x] Phase 3: Implementation（TDD 実装）
- [x] Phase 4: Inspection（検品） — 全8チェック合格

## 変更ファイル
- `skills/cmux-team/manager/main.ts` — cmdUpdateTask に --depends-on 処理追加、ヘッダーコメント更新
- `skills/cmux-team/manager/i18n.ts` — 英語/日本語ヘルプテキスト更新

## 変更内容
- `--depends-on <ids>` オプション追加（カンマ区切り ID リスト）
- frontmatter の depends_on 行を追加/更新するロジック
- --depends-on 単体でも使用可能（--status 等なしで OK）
- 空文字指定で依存をクリア可能
- ヘルプテキスト（英語・日本語）両方に反映

## テスト結果
- TypeScript 型チェック: OK
- depends_on 追加/更新/単体/クリア: 全て OK
- ヘルプ表示: OK

## マージ
ローカルマージ完了（main ブランチ）
