# T107 Summary: plan.md をタスクフォルダ runs/ 配下に配置するよう変更

## 完了したサブタスク

- ST-1: conductor-role.md Phase 1 の plan.md 出力先を OUTPUT_DIR に変更（git commit/copy 削除）
- ST-2: conductor-role.md Phase 2/3/4 の plan.md 参照パスを OUTPUT_DIR に統一
- ST-3: planner.md の出力セクションを {{OUTPUT_DIR}}/plan.md に変更
- ST-4: テンプレート全体で旧指示の残存なしを横断検証

## 変更ファイル

| ファイル | 変更概要 |
|---------|---------|
| `skills/cmux-team/templates/conductor-role.md` | Phase 1: 手順集約、Phase 2/3/4: OUTPUT_DIR パス明記 |
| `skills/cmux-team/templates/planner.md` | 出力先を {{OUTPUT_DIR}}/plan.md に変更 |

## テスト結果

- 全検証コマンドパス（旧指示残存なし、新パス記述あり）
- Inspector GO 判定（Critical 0, Major 0, Minor 2）

## マージコミット

- Fast-forward: a42fdd8..7e22fed
- ブランチ: task-107-1775554671/task → main
