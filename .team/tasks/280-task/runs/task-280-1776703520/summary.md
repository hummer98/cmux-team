# T280 リリース完了レポート

## リリース概要

- 旧バージョン: v4.0.0
- 新バージョン: **v4.1.0**
- リリース日: 2026-04-21
- バージョン判定: Conventional Commits 自動判定（feat あり、BREAKING なし → minor bump）

## 対象コミット（v4.0.0..v4.1.0）

| SHA | Type | タスク | 概要 |
|-----|------|------|------|
| 51be294 | feat | T279 | P1 shadow reducer + state machine spec |
| 3b68e8d | fix | T277 | assigning 中の SESSION_IDLE R1 保険を撤去 |
| 086a29c | fix | T278 | Artifacts タブのスクロールをカーソル追従にする |
| 30bc99b | fix | T276 | conductor-role.md Step 8/9 を ahead-side rebase と ff-only 失敗レポートに対応 |
| 7603ffb | feat | T275 | local が origin より ahead のとき config-local-ahead を優先 |
| 03973d2 | fix | T274 | CONDUCTOR_DONE 送信を close-task に一本化 |
| ea18ce8 | feat | T273 | Master の直接作業制約を緩和し明示指示で例外許可 |

## 変更ファイル

- `CHANGELOG.md` — [Unreleased] を [4.1.0] - 2026-04-21 に変換、T273/T275/T276/T278/T279 のエントリを追記（T274 は Unreleased に既存、T277 は fix セクションに移動）
- `package.json` — 4.0.0 → 4.1.0
- `.claude-plugin/plugin.json` — 4.0.0 → 4.1.0
- `.claude-plugin/marketplace.json` — plugins[0].version 4.0.0 → 4.1.0

## 実行結果

| 手順 | 結果 |
|------|------|
| CHANGELOG.md 更新 | ✅ |
| 3 ファイルバージョン更新 | ✅ |
| commit `chore: release v4.1.0` (033c748) | ✅ |
| タグ `v4.1.0` 作成・push | ✅ |
| `git push origin main` | ✅ (b4c3930..033c748) |
| plugin marketplace キャッシュ更新 | ✅ (hummer98-cmux-team git pull) |
| 旧 plugin キャッシュ削除 (3.54.1) | ✅ |
| `claude plugin uninstall` + `install` | ✅ |
| GitHub Actions release.yml 監視 | ✅ Run 24678935967 success |
| `npm install -g @hummer98/cmux-team` | ✅ cmux-team 4.1.0 |

## 確認事項

- `cmux-team --version` が `cmux-team 4.1.0` を返すことを確認
- git tag `v4.1.0` が origin に反映されていることを確認

## 備考

- operational task のためサブエージェント起動なし・worktree 内 TDD フェーズなし
- リリース作業は `$PROJECT_ROOT` (main ブランチ) で直接実施、worktree には差分を残さない
- 作業 worktree: `/Users/yamamoto/git/cmux-team/.worktrees/task-280-1776703520`（差分なし）
