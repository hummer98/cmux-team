# T198 実行サマリー

## タスク
Conductor/Agent テンプレート見直し + `cmux-team artifacts add` を move 化。KDG-discord-listner T026 で観測された「project-level `artifacts/` と `.team/artifacts/` のドキュメント二重登録」を構造的に防止する。

## フェーズ実行
- **Plan** (Planner @ surface:94): 1 往復で plan.md 作成（826 行）
- **Design Review** (Reviewer @ surface:97): Changes Requested（C-1, M-1〜M-4, 順序整理）→ plan.md 改訂 → Approved
- **Implementation** (Implementer @ surface:101): 9 ファイル変更 + T-1〜T-4 テスト全 PASS
- **Inspection** (Inspector @ surface:XXX): GO 判定（23 項目チェックリスト全 ✓）

## 変更ファイル (9 files, 551 insertions / 137 deletions)

### コア CLI
- `skills/cmux-team/manager/artifact.ts` — `writeFile` 後に `unlink(sourcePath)` 追加（copy → move）。`unlinkWarning?` を戻り値型に追加
- `skills/cmux-team/manager/main.ts` — `--project-root <path>` フラグ新設（`getArg("project-root")`）、`unlinkWarning` を stderr + log 出力
- `skills/cmux-team/manager/i18n.ts` — `help_artifacts` と `help_main` の ja/en で move 動作を記載

### テンプレート（ja/en 並行更新）
- `skills/cmux-team/templates/{ja,en}/conductor-role.md`
  - Step 6 を「summary.md 縛り」から拡張：調査系タスク判定（`git diff --cached --quiet` 必須 + 補助キーワード/出力ファイル）
  - 完了処理を 12 ステップに再編（summary.md → git add → 判定 → [調査系のみ]artifact 登録 → commit → merge → worktree remove）
  - Phase 0 Research を追加（Plan/Design Review スキップ、Phase 4 Inspection は継続）
  - プレースホルダ規約統一（`<OUTPUT_DIR>` / `<WORKTREE_PATH>` angle-bracket、`{{PROJECT_ROOT}}` のみ curly）
- `skills/cmux-team/templates/{ja,en}/implementer.md` — 出力先ルールの警告ボックス追加
- `skills/cmux-team/templates/{ja,en}/researcher.md` — 出力先ルールの警告ボックス追加

## テスト結果
- **T-1 (move 動作)**: `/tmp/test.md` → `.team/artifacts/Axxx-test.md`、ソースファイル削除を確認 ✓
- **T-2 (project-root フラグ)**: `--project-root` で別プロジェクトへの登録を確認 ✓
- **T-3 (tsc --noEmit)**: タッチしたファイルに新規エラーなし ✓
- **T-4 (grep 静的チェック)**: `grep -c '{{OUTPUT_DIR}}' templates/{ja,en}/conductor-role.md` → 0 件（`{{PROJECT_ROOT}}` 以外の curly 混入なし） ✓

## 成果
- **マージコミット**: `b8c9167 Merge branch 'task-198-1776206169/task'`
- **ブランチ**: `task-198-1776206169/task`（worktree 削除後に branch -d）

## スコープ外（実装せず）
- PreToolUse hook での `.team/artifacts/` Write ブロック（ユーザー判断で見送り）
- 既存 project-level `artifacts/` フォルダのマイグレーション
- `--copy` エスケープハッチ（作らない方針）
