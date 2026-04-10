# Summary: restart-task サブコマンドの実装

## 結果: GO (成功)

## 完了したサブタスク
1. abort-task のクリーンアップ処理を `cleanupAssignedTask()` として共通化
2. `cmdRestartTask()` の実装（abort と同じクリーンアップ後、status を ready に戻して TASK_CREATED 通知）
3. i18n.ts に英語・日本語のヘルプテキストとコマンドリストを追加
4. 冒頭 Usage コメントへの追記
5. switch 文への case 追加

## 変更ファイル
- `skills/cmux-team/manager/main.ts` — 共通関数抽出 + restart-task コマンド追加
- `skills/cmux-team/manager/i18n.ts` — 英語/日本語メッセージ追加
- `package-lock.json` — 自動更新

## 検品結果
全5項目 OK（コード正確性、TypeScript ビルド、ヘルプ表示、i18n 整合性、コーディング規約）

## マージ
Fast-forward マージで main に統合。コミット: 34a0de1
