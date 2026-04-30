# Release v4.7.0

## 概要

- 前バージョン: v4.6.0
- 新バージョン: v4.7.0 (minor bump)
- 判定根拠: Conventional Commits（feat が 3 件、BREAKING なし）
- リリース日: 2026-04-24

## 対象コミット（v4.6.0..HEAD）

| SHA | 種別 | 内容 |
|-----|------|------|
| 60e2093 | feat | T311: cmux-team status に 5h/7d Rate Limit セクション追加 |
| 8da2a35 | feat | T310: dashboard Metrics タブにスクロール追加 |
| 615c46b | refactor | dashboard Metrics タブから重複 Unified セクション削除 |
| 4336f56 | fix | dashboard Metrics タブラベルを ja locale でも英語固定 |
| 2d3a90e | feat | Issue #30 M1/M2/M3: RuntimeBackend interface + ClaudeCodeBackend 骨格 |
| 2eec1c8 | chore | CLAUDE.md 1036→230 行に削減、詳細を agent-instructions/implementer.md に分離 |

## 実行結果

- CHANGELOG.md: `## [4.7.0] - 2026-04-24` を Added / Changed / Fixed で追記
- バージョン更新: `package.json` / `.claude-plugin/plugin.json` / `.claude-plugin/marketplace.json` の 3 ファイル（いずれも `4.6.0` → `4.7.0`）
- リリースコミット: `b2cffa7 chore: release v4.7.0`
- タグ: `v4.7.0` を main に push
- GitHub Actions: run 24884622870 ✓ 59s で成功（npm publish + GitHub Release 生成）
- plugin marketplace cache: `~/.claude/plugins/marketplaces/hummer98-cmux-team` を fast-forward pull 完了
- plugin cache 古いバージョン削除: 4.6.0 のみ存在していたため skip（LATEST と同一）
- plugin 再インストール: `claude plugin uninstall/install cmux-team@hummer98-cmux-team` 成功
- npm: `npm install -g @hummer98/cmux-team` 完了、`cmux-team --version` で `4.7.0` を確認

## 納品方式

ローカル main への直接 commit + tag + push。worktree 側には変更を入れていない（指示通り）。
