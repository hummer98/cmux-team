# T299 リリース完了 (v4.5.0 → v4.5.1)

## バージョン判定

- 前回タグ: v4.5.0
- v4.5.0..HEAD コミット: 1 件
  - `fix(git-sync): exclude .team/ from uncommitted check on main (T298)`
- Conventional Commits 判定: `fix:` のみ → **patch**
- 新バージョン: **v4.5.1**

## 実施ステップ

1. `CHANGELOG.md` に `## [4.5.1] - 2026-04-23` を追記（Fixed に T298 を記述）
2. `package.json` / `.claude-plugin/plugin.json` / `.claude-plugin/marketplace.json` を 4.5.1 に更新
3. `chore: release v4.5.1` でコミット（`f96f99e`）
4. `git push origin main` + `git push origin v4.5.1`
5. marketplace キャッシュ `~/.claude/plugins/marketplaces/hummer98-cmux-team` を `git pull`
6. 旧 plugin cache（4.4.0）を削除、4.5.0 のみ残置 → その後 reinstall で差し替え
7. `claude plugin uninstall` + `claude plugin install cmux-team@hummer98-cmux-team`
8. GitHub Actions `v4.5.1 Release` (run id 24786284636) の監視
9. `npm install -g @hummer98/cmux-team` でローカルに取得（`cmux-team 4.5.1` 確認）

## 試行錯誤

- GitHub Actions の初回実行（attempt 1）で `prepublishOnly` の `bun test` が **1067 pass / 0 fail / 1 error** で exit 1 し、npm publish がスキップされた
  - エラー箇所: `spawnPidWatcher` の `setInterval` ティックが `__testSpawnPidWatcherTick` → `logger.ts:83` で fail（Unhandled error between tests）
  - **ローカルでは再現せず** — CI 固有の race condition（テスト間のバックグラウンド setInterval リーク）と判定
- `gh run rerun 24786284636 --failed` で再実行 → **成功**（attempt 2, 1m6s）
  - npm publish + GitHub Release 作成も完了

## 懸念・残課題

- CI 上のテスト間 race（setInterval リーク）は再発する可能性がある。別タスクで setInterval の teardown 漏れを調査・修正することを推奨
  - `daemon.ts:spawnPidWatcher` の setInterval はテスト終了時に確実に `clearInterval` されるようテスト側で保証する（PROJECT_ROOT 破棄後に `log` が走るパターン）

## 成果

- タグ: `v4.5.1` push 済み
- npm registry: `@hummer98/cmux-team@4.5.1` publish 済み（OIDC Trusted Publishing）
- GitHub Release: 自動作成済み
- plugin marketplace: 4.5.1 に更新済み
- ローカル cmux-team: 4.5.1 で動作確認済み
