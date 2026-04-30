# T365 リリース v4.14.1

## バージョン判定

- 直前タグ: v4.14.0
- v4.14.0..HEAD のコミット: 3 件（fix 2 + docs 1、`feat:` / `BREAKING` なし） → **patch**
- NEW_VERSION: **4.14.1**

## 含まれる変更

| commit | type | 概要 |
|---|---|---|
| 873b044 | fix(token-store) | `hoursUntil` の Unix epoch 秒文字列対応 → pool capacity が 300% 表示になっていたバグを修正 |
| 8dd2092 | fix(manager) | `ANTHROPIC_CUSTOM_HEADERS` を改行区切りに修正（T355）、role/surface ヘッダー汚染を停止 |
| 9d2ab47 | docs(spec) | events stream schema を `docs/spec/10-events-stream.md` として確定（T357、16 event 種） |

## 実行ステップ

1. CHANGELOG.md に `[4.14.1] - 2026-04-27` セクション追加（Fixed 2 / Changed 1）
2. version 更新: `package.json` / `.claude-plugin/plugin.json` / `.claude-plugin/marketplace.json`（4.14.0 → 4.14.1）
3. `chore: release v4.14.1` commit → tag v4.14.1 → push origin main + tag
4. marketplace cache pull (`~/.claude/plugins/marketplaces/hummer98-cmux-team`)
5. plugin cache 整理（旧 4.13.0 削除、uninstall → install で 4.14.1 配置、旧 4.14.0 削除）
6. GitHub Actions release workflow: 既に success 完了（run id 24975612790、sha 23ae108）
7. `npm install -g @hummer98/cmux-team` → `cmux-team --version` = 4.14.1 確認

## 成果物

- マージコミット: `23ae108` (`chore: release v4.14.1`)
- タグ: `v4.14.1`（push 済み）
- npm: `@hummer98/cmux-team@4.14.1`（ローカル install 済み）
- plugin: `cmux-team@hummer98-cmux-team` 4.14.1（user scope）

## 備考

- worktree 内では作業せず main 側で直接実施（operational task の方針通り）
- worktree `.worktrees/task-365-1777261625` は別途削除予定（Step 10）
