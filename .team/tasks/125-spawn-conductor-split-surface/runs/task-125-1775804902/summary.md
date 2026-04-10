# Task 125: spawn-conductor から split を除去し現在の surface で起動する

## 判定: GO

## 完了サブタスク
1. Phase 1: Plan — plan.md 作成完了
2. Phase 3: Implementation — 3ファイル変更、ビルド確認済み
3. Phase 4: Inspection — 全検品項目クリア (GO)

## 変更ファイル
- `skills/cmux-team/manager/conductor.ts` — `spawnSingleConductor()` のシグネチャ変更、`cmux.newSplit()` 削除
- `skills/cmux-team/manager/main.ts` — `cmdSpawnConductor()` の引数変更、surface フォールバックチェーン実装
- `skills/cmux-team/manager/i18n.ts` — ヘルプテキスト更新（英語・日本語）

## テスト結果
- `bun build --no-bundle main.ts` — 成功

## マージ
- ローカルマージ完了（main ブランチ）
