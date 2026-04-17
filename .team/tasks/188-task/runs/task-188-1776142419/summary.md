# Task 188: リリース（バージョン自動判定）

## 結果: 完了

### バージョン判定

- CURRENT: 3.44.1
- NEW_VERSION: **3.45.0**（minor bump）
- 判定根拠: v3.44.1 以降のコミットはすべて `feat:` プレフィックス。`BREAKING CHANGE` / `!:` マーカーなしのため Conventional Commits 規則に従い minor。

### 含まれる変更

- T183: update-task の TUI 即時反映（TASK_UPDATED）
- T184: EventBus 導入（state 変更の TUI 即時反映）
- T185: `--version` / `-v` フラグ追加
- T186: auto-update デフォルト OFF + opt-in 化
- T187: auto-update を update-notifier + タスク自動起票に再設計（Breaking）

### 実行ステップ

1. バージョン更新: `package.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`
2. CHANGELOG.md: `[Unreleased]` → `[3.45.0] - 2026-04-14`、T183/T184/T185 の Added エントリ補完
3. コミット & タグ: `3c67178` / `v3.45.0`
4. push: `origin main` + `v3.45.0`
5. marketplace キャッシュ `~/.claude/plugins/marketplaces/hummer98-cmux-team` 更新
6. 旧 plugin キャッシュ（3.44.0）削除
7. plugin 再インストール: `claude plugin uninstall/install cmux-team@hummer98-cmux-team`
8. GitHub Actions 監視: RUN_ID=24381672149 ✓ 成功（24s）
9. npm install: `@hummer98/cmux-team@3.45.0` インストール確認
10. バージョン検証: `cmux-team --version` → `cmux-team 3.45.0`

### 納品

- タグ: v3.45.0
- コミット: 3c67178 (main)
- npm: https://www.npmjs.com/package/@hummer98/cmux-team
- GitHub Release: v3.45.0（Actions で自動作成）
