# Release v4.12.0 Summary

- 日付: 2026-04-26
- 旧バージョン: 4.11.0
- 新バージョン: 4.12.0
- bump レベル: minor（`feat:` を含むため）
- リリースコミット: 8d3ad0e (`chore: release v4.12.0`)
- タグ: v4.12.0
- npm: @hummer98/cmux-team@4.12.0（ローカル `cmux-team --version` で 4.12.0 確認済み）
- GitHub Release: v4.12.0（release.yml run 24954495193 が 19 秒で成功）

## 含まれた変更（v4.11.0..v4.12.0）

| commit | 種別 | 概要 |
|---|---|---|
| 55d7b0b | docs | docs/spec/09-token-pool.md を新設 |
| b023a37 | feat | token pool: auto-discover gate と `cmux-team token promote` (T341) |
| 05610b4 | fix | ClaudeCodeBackend.send/reset の send-key return を再導入 (T343) |
| 7f3a19f | feat | Master/Conductor にも agent-instructions overlay を有効化 (T342) |
| ee7327a | fix | findProjectRoot が削除済み tmpdir で chdir crash する問題を修正 |

## 実施手順（完了）

1. ✅ コミット履歴とバージョン判定（v4.11.0 → v4.12.0、minor）
2. ✅ CHANGELOG.md 追記、3 ファイルのバージョン更新（package.json / plugin.json / marketplace.json）
3. ✅ commit + tag + push（main / v4.12.0）
4. ✅ marketplace cache を fast-forward
5. ✅ 旧 plugin cache（4.10.0）削除、最新（4.11.0）残し
6. ✅ claude plugin uninstall / install
7. ✅ release.yml 監視（成功）
8. ✅ npm install -g @hummer98/cmux-team

## 注意点

- release.yml の annotation で「Node.js 20 deprecation」警告が出ているが今回のリリースには影響なし。2026-09-16 までに actions/checkout / setup-node を Node.js 24 対応版に更新する必要あり（別タスク化候補）
- plugin cache 削除後、このセッション中の plugin reinstall 時点では旧 cache が `4.11.0` のみ。次回起動時に Claude Code が 4.12.0 を pull してくる想定
