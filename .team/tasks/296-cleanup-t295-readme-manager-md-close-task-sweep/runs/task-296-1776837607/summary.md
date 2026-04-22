# T296 Summary

## 完了したサブタスク

1. Implementer: 4 ファイルの close-task 旧署名 sweep
2. Inspector: 4 ファイル修正の検品（判定 GO）
3. 完了処理（commit / rebase / merge / close-task）

## 変更ファイル

| ファイル | 変更 |
|---|---|
| README.md | L110 を新仕様 (`--deliverable-kind <files\|merged\|pr\|none>` 必須) に書き換え |
| README.ja.md | L110 を新仕様に書き換え |
| skills/cmux-team/templates/en/manager.md | L73 を `cmux-team close-task ...` に抽象化 |
| skills/cmux-team/templates/ja/manager.md | L73 を `cmux-team close-task ...` に抽象化 |

合計 4 ファイル、4 insertions / 4 deletions。

## テスト結果

- 自動テスト実行なし（ドキュメント hygiene のみ、コード変更ゼロ）
- rg 検証:
  - 旧署名 (`close-task --task-id` without `--deliverable-kind`): **0 件** ✅
  - 新仕様行 (`close-task --task-id.*deliverable-kind`): 12 件残存（conductor-role.md / conductor.md / conductor-task.md の ja/en 両方）✅

## 判断ポイント

- **manager.md は抽象化**: 引数を省略した `cmux-team close-task ...` 表記を選択。Manager/daemon の動作説明文脈で読み手に具体的 kind を選ばせる場所ではないため、引数詳細を書くと陳腐化しやすい。タスク本文の方針に従った
- **検証クエリの調整**: タスク本文の `rg "close-task --task-id.*--journal"` クエリは conductor-task.md の新仕様行（`--deliverable-kind ... --journal "..."`）にも hit するため、`rg "close-task --task-id" ... | rg -v "deliverable-kind"` に修正して 0 件確認とした

## 納品

- 納品方式: ローカル ff-only マージ
- マージコミット: `70c84668c75aa7408c4cd31525bf7dd2b00e9f02`
- マージ先ブランチ: `main`
- PR: なし
