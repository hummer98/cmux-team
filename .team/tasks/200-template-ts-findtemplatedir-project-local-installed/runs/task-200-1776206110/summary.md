# T200 実行サマリ: findTemplateDir 探索順序反転

## 概要

`skills/cmux-team/manager/template.ts` の `findTemplateDir()` の探索順序を **installed → project-local** から **project-local → installed** に反転。併せて async 化して `template_dir_resolved` ログを追加。

**根本問題**: dev リポジトリで `cmux-team start` しても、daemon が `import.meta.path` 起点で installed package 側の古いテンプレートを先に拾ってしまい、runtime prompt が repo HEAD と乖離する race が発生していた（C[54] が古い conductor-role.md で動作していた事例）。

## 実行したフェーズ

| Phase | Agent | 成果物 | 結果 |
|---|---|---|---|
| 1. Plan | planner (surface:90) | plan.md | 方針固定・手順明文化 |
| 3. Impl | impl (surface:92) | impl-report.md + template.ts 変更 | 実装・全検証 pass |
| 4. Inspection | inspector (surface:93) | inspection.md | **GO** |

中規模タスク（単一ファイル・明確な方針あり）として Design Review はスキップ。

## 変更ファイル

- `skills/cmux-team/manager/template.ts`: 1 file changed, 19 insertions(+), 13 deletions(-)
  - `findTemplateDir()` を `async function ... : Promise<string | null>` に変更
  - 探索順序を反転（project-local を最優先）
  - 各 return 直前に `await log("template_dir_resolved", "path=... source=project_local|installed")` を追加
  - 内部 3 箇所の呼び出しに `await` を追加

## 検証結果

- **型チェック**: `bun run tsc --noEmit` → exit=0、template.ts 関連エラー 0 件（T197 touched-files ゼロ化ルール準拠）
- **既存テスト**: `bun test skills/cmux-team/manager/daemon.test.ts` → 51 pass / 0 fail
- **スモークテスト (project_local)**: `PROJECT_ROOT=$(pwd) bun -e ...` → worktree 内 `templates/ja` が解決、ログ `source=project_local` 確認
- **スモークテスト (installed)**: `PROJECT_ROOT=/tmp/notemplates-t200-inspection` → `fromSelf` 経路にフォールスルー、ログ `source=installed` 確認
- **外部呼び出しチェック**: `rg 'findTemplateDir' skills/cmux-team/` は template.ts 内 4 箇所のみ（宣言 1 + await 付き呼び出し 3）

## マージ

- ブランチ: `task-200-1776206110/task`
- マージ先: `main`
- マージコミット: `Merge branch 'task-200-1776206110/task' (T200 findTemplateDir project-local first)` (`--no-ff`)
- 実装コミット: `45f8a25` — `fix(template): reverse findTemplateDir search order to project-local first (T200)`

## スコープ外（未対応、タスク本文で明示）

- 既に走っている C[54] の救済 → 手動で kill + restart が必要
- `.team/prompts/*.md` の自動再生成ロジック → 別タスク
- installed template の更新検知・警告 → 別タスク

## 備考

- 出力ディレクトリの全ファイル: `plan.md` / `impl-report.md` / `inspection.md` / `summary.md` / `conductor-prompt.md`
- この修正は daemon 再起動時から有効。既存 Conductor セッションには影響しない。
