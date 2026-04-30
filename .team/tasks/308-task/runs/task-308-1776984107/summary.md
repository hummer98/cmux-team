# T308: リリース v4.6.0

## 完了事項

- バージョン自動判定: `feat:` が 4 件（T304/T305/T306/T307）、BREAKING CHANGE 無し → **minor bump** `4.5.1 → 4.6.0`
- CHANGELOG.md に 4.6.0 セクションを追記（Added × 4, Changed × 2, Fixed × 2）
- `package.json` / `.claude-plugin/plugin.json` / `.claude-plugin/marketplace.json` の 3 ファイルをバージョン更新
- commit: `30f6181 chore: release v4.6.0`
- tag: `v4.6.0` を push
- marketplace cache (`~/.claude/plugins/marketplaces/hummer98-cmux-team`) を pull
- plugin cache から旧 4.5.0 / 4.5.1 を削除、4.6.0 のみ残存
- `claude plugin uninstall` → `claude plugin install cmux-team@hummer98-cmux-team` で再インストール
- GitHub Actions release workflow (run 24862574207) が 1m2s で成功（npm publish + GitHub Release 作成）
- `npm install -g @hummer98/cmux-team` で npm レジストリから 4.6.0 を取得
- `cmux-team --version` → `cmux-team 4.6.0` 確認済み

## コミット一覧（v4.5.1..v4.6.0）

| commit | 分類 | 概要 |
|---|---|---|
| 11e48d5 | Added | feat(dashboard): Metrics tab with burn rate / role / task breakdown (T307) |
| 13ac1b7 | Added | feat(trace-task): Token Usage metrics section with --no-metrics opt-out (T306) |
| e0c2d63 | Added | feat(proxy): record api_usage + rate limit per request (T305) |
| 0150f02 | Added | feat(trace): inject x-cmux-role via settings.env.ANTHROPIC_CUSTOM_HEADERS (T304) |
| 06a074a | Changed | refactor(task-state): route all mutations through pure reducer (T303) |
| 9cc7628 | Fixed | fix(daemon): guard assign write against terminal status race (T302) |
| d6982ac | Changed | remove daemon auto-restart mechanism (T301) |
| 15665ed | Fixed | fix(task): treat aborted/deleted as terminal in run_after_all conflict check (T300) |

## 納品

- タグ: `v4.6.0`
- npm: `@hummer98/cmux-team@4.6.0`
- GitHub Release: https://github.com/hummer98/cmux-team/releases/tag/v4.6.0
- merge commit: `30f6181`（main 直接 commit、worktree 内差分なし）
