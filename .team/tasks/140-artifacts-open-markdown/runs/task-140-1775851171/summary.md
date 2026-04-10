# Summary: artifacts open サブコマンド実装

## Verdict: GO

## 完了サブタスク
1. Plan 作成
2. Implementer Agent による実装
3. Inspector Agent による検品（GO 判定）
4. コミット・マージ

## 変更ファイル
- `skills/cmux-team/manager/main.ts` — `cmdArtifacts()` に `open` サブコマンド追加（+35行）
- `skills/cmux-team/manager/i18n.ts` — en/ja エラーメッセージ・ヘルプテキスト追加（+10行）

## 変更内容
- `cmux-team artifacts open <id>` サブコマンドを新規追加
- ビューア優先順位: `CMUX_TEAM_MD_VIEWER` 環境変数 → `mo` → `cat`
- `Bun.spawn` で TTY 引き継ぎ、インタラクティブビューア対応
- 既存の `show` サブコマンドは変更なし

## マージ
- コミット: f0e7d99
- main に Fast-forward マージ済み
