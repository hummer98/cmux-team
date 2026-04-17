# T199 リリース結果 (v3.46.0 → v3.47.0)

## 概要

Conductor 自身が operational task としてリリース作業を直接実行した（サブエージェント spawn なし）。

## バージョン判定

- CURRENT: 3.46.0
- LAST_TAG: v3.46.0
- コミット履歴（v3.46.0..HEAD）:
  - T198 feat(artifacts,templates): move-based artifacts add + Researcher role + ja/en sync
  - T195 feat(manager): migrate Conductor/Agent/Master liveness to PID-based
  - T200 fix(template): reverse findTemplateDir search order to project-local first
  - T197 feat(templates): add touched-files zero-errors rule to inspector/implementer/planner
  - T196 fix(dashboard): strip surface: prefix in Journal panel
- 判定: `feat:` が複数あり BREAKING CHANGE なし → **minor バンプ** → **3.47.0**

## 変更ファイル

- `CHANGELOG.md`: [3.47.0] エントリを当日日付に修正し、T197/T198/T200/T196 を追記（既存の T195 Changed (Breaking) / Changed は維持）
- `package.json`: 3.46.0 → 3.47.0
- `.claude-plugin/plugin.json`: 3.46.0 → 3.47.0
- `.claude-plugin/marketplace.json`: 3.46.0 → 3.47.0

## 実行結果

| ステップ | 結果 |
|---|---|
| 1. 現在バージョン取得 | OK (3.46.0) |
| 2. バージョン判定 | OK (3.47.0, minor) |
| 3. CHANGELOG.md 更新 | OK |
| 4. 3ファイル version 更新 | OK |
| 5. commit/tag/push | OK (コミット b200c37, タグ v3.47.0) |
| 6. marketplace キャッシュ git pull | OK (d0015a7..b200c37 fast-forward) |
| 7. 旧 plugin キャッシュ削除 | OK (3.45.0 を削除、3.46.0 は LATEST として保持) |
| 8. plugin 再インストール | OK |
| 9. GitHub Actions 監視 | OK (RUN_ID=24431328022, 既に success) |
| 10. npm グローバルインストール | OK (cmux-team --version → 3.47.0) |

## リリース成果物

- **タグ**: `v3.47.0`
- **コミット**: `b200c37` (main)
- **npm**: `@hummer98/cmux-team@3.47.0`
- **plugin**: `cmux-team@hummer98-cmux-team` 更新済み

## 注意点 / 気づき

1. **CHANGELOG に既存の `[3.47.0] - 2026-04-16` エントリがあった**。前回誰かが T195 の変更だけ記述しておいたが未リリース状態。日付を 2026-04-15（当日）に修正し、その後追加された T197/T198/T200/T196 の内容を Added / Fixed として追記した。
2. **main が origin より 9 コミット先行していた**。リリースコミットと合わせて push されたので問題なし。
3. **GitHub Actions は push の 5 秒後時点で既に success だった**。sleep 5 後の gh run watch は即 exit した（ワークフローが高速に完了した）。
4. worktree 内では作業せず、すべて `cd "$PROJECT_ROOT"` で main 側のプロジェクトルートに移動して実行した（手順書通り）。
