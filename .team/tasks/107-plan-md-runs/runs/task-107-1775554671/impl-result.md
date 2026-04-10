## Completed Tasks

- ST-1: conductor-role.md Phase 1 の plan.md 出力先を OUTPUT_DIR に変更
- ST-2: conductor-role.md Phase 2/3/4 の plan.md 参照を OUTPUT_DIR に明確化
- ST-3: planner.md の出力セクションを OUTPUT_DIR/plan.md に変更
- ST-4: テンプレート全体で旧指示の残存がないことを横断検証

## Files Changed

| ファイル | 変更概要 |
|---------|---------|
| `skills/cmux-team/templates/conductor-role.md` | Phase 1: 手順3-5を「`<OUTPUT_DIR>/plan.md` の確認」に集約（git commit/copy 削除）。Phase 2/3/4: plan.md 読み取り元を `<OUTPUT_DIR>/plan.md` に明記。Phase 4 NOGO 時の再 spawn 参照も同様に修正 |
| `skills/cmux-team/templates/planner.md` | 出力セクション: worktree 内への作成+git commit 指示を `{{OUTPUT_DIR}}/plan.md` への直接出力に変更 |

## Verification Results

### ST-1 検証

| 検証項目 | コマンド | 期待結果 | 実際の結果 |
|---------|---------|---------|-----------|
| `worktree 内に作成` の除去 | `grep "worktree 内に作成" conductor-role.md` | 0件 | 0件 |
| `git add plan.md` の除去 | `grep "git add plan.md" conductor-role.md` | 0件 | 0件 |
| `cp plan.md` の除去 | `grep "cp plan.md" conductor-role.md` | 0件 | 0件 |
| `OUTPUT_DIR.*plan.md` の存在 | `grep "OUTPUT_DIR.*plan.md" conductor-role.md` | 1件以上 | 1件（line 37） |

### ST-2 検証

| 検証項目 | コマンド | 期待結果 | 実際の結果 |
|---------|---------|---------|-----------|
| OUTPUT_DIR.*plan.md の件数 | `grep -c "OUTPUT_DIR.*plan.md" conductor-role.md` | 4件以上 | 6件（line 37, 44, 50×2, 60, 70, 76） |

Phase 1(37), Phase 2(44, 50), Phase 3(60), Phase 4(70, 76) — 全フェーズで OUTPUT_DIR 参照を確認。

### ST-3 検証

| 検証項目 | コマンド | 期待結果 | 実際の結果 |
|---------|---------|---------|-----------|
| 旧「作業ディレクトリ内に...作成」の除去 | `grep "作業ディレクトリ内に.*plan.md" planner.md` | 0件（作成指示） | 1件（「作成しない」という否定指示 — 計画書で指定された変更後テキスト） |
| `git commit` の除去 | `grep "git commit" planner.md` | 0件 | 0件 |
| `OUTPUT_DIR.*plan.md` の存在 | `grep "OUTPUT_DIR.*plan.md" planner.md` | 1件 | 1件（line 63） |

### ST-4 検証

| 検証項目 | コマンド | 期待結果 | 実際の結果 |
|---------|---------|---------|-----------|
| テンプレート全体の旧指示残存 | `grep -rn "git add plan.md\|git commit.*plan\|worktree.*plan.md" templates/` | 0件 | 0件 |

## Issues Encountered

なし。全サブタスクが計画通りに完了。
