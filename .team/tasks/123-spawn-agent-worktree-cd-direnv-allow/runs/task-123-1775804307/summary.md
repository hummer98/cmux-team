# Task 123: spawn-agent で worktree cd 後に direnv allow を実行

## 結果: 完了 (GO)

## 変更内容

- `skills/cmux-team/manager/main.ts`: `cmdSpawnAgent()` 内の worktree cd 後に `direnv allow 2>/dev/null` を追加（2行追加）

## 変更ファイル

- `skills/cmux-team/manager/main.ts` (+2 lines)

## テスト結果

- 自動テストなし（E2E テストのみ）
- コード変更は T122 の conductor.ts と同じパターンの踏襲

## マージ

- ローカルマージ（fast-forward）: 08e0958
