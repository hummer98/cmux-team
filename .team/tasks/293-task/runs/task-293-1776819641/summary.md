# リリース v4.4.0

## 結果

- **バージョン**: 4.3.0 → 4.4.0（minor bump、`feat:` コミット検出で自動判定）
- **タグ**: `v4.4.0`（GitHub に push 済み）
- **リリースコミット**: `c8601ce chore: release v4.4.0`
- **GitHub Release**: Actions で自動作成（[release.yml](https://github.com/hummer98/cmux-team/actions/runs/24754665363) 55s, success）
- **npm**: `@hummer98/cmux-team@4.4.0` publish 済み（OIDC Trusted Publishing）
- **plugin**: `hummer98-cmux-team/cmux-team@4.4.0` 再インストール済み
- **local install**: `npm install -g @hummer98/cmux-team` → 4.4.0 に更新

## バージョン判定根拠

`git log v4.3.0..HEAD` のコミット群から Conventional Commits 解析:

- `BREAKING CHANGE` / `!:` → 0 件（major ではない）
- `feat:` → 2 件（minor 確定）
  - `feat: T292 logger.ts に CMUX_TEAM_LOGGER_STRICT=1 で fail-fast する strict モードを追加`
  - `feat: formatAbortedTaskLine + await-task/printSummaries で reason を表示 (T290)`
  - `feat: task.ts に markTaskAborted / parseAbortJournal を追加 (T290)`
- `fix:` → 3 件（T291 close-task / T292 chdir / T292 tsc / T289 Issues tab）
- `refactor:` / `test:` / `chore:` / `docs:` → 多数

最大レベル = `feat` → **minor bump** を採用。

## 主な変更点（CHANGELOG 要約）

### Added
- T292: `CMUX_TEAM_LOGGER_STRICT=1` による fail-fast strict モード
- T290: `markTaskAborted` / `parseAbortJournal` ヘルパーと abort reason の構造化表示

### Changed
- T292: test 基盤を `createDummyProject` ヘルパーに全面移行（22 テストファイル）
- T292: main.ts の module-level `process.chdir` を CLI 起動時のみに限定

### Fixed
- T291: `close-task` 系 CLI で `--task-id` を frontmatter id に正規化
- T289: Issues タブのスクロールをカーソル追従に修正

### Refactored (internal)
- T290: abort 系 daemon ハンドラを `markTaskAborted` に一本化（6 経路）

## 実行ログ

| Step | 結果 |
|---|---|
| 1. 現在バージョン取得 | `4.3.0` / `LAST_TAG=v4.3.0` |
| 2. バージョン判定 | `4.4.0` (minor) |
| 3. main 状態確認 | local ahead=32, behind=0（安全に push 可能） |
| 4. CHANGELOG 更新 | `[4.4.0] - 2026-04-22` を先頭に追記 |
| 5. version 更新 | package.json / .claude-plugin/plugin.json / marketplace.json の 3 ファイル |
| 6. commit + tag + push | `c8601ce` / `v4.4.0` / main + tag push OK |
| 7. marketplace キャッシュ更新 | `~/.claude/plugins/marketplaces/hummer98-cmux-team` fast-forward |
| 8. 旧 plugin キャッシュ削除 | 4.2.0 を削除 |
| 9. plugin 再インストール | uninstall → install 成功、4.4.0 キャッシュ展開 |
| 10. GitHub Actions 監視 | run 24754665363 success (55s) |
| 11. npm 経由で local install | `cmux-team 4.4.0` 確認済み |

## 備考

- このタスクは operational task のため、サブエージェント（Researcher / Planner / Implementer / Inspector）は spawn していない
- Conductor 自身が Bash で順次リリース手順を実行
- worktree `/Users/yamamoto/git/cmux-team/.worktrees/task-293-1776819641` は clean（リリース差分は main 側に直接 commit した）
