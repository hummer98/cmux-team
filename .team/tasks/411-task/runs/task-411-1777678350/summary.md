# T411 Summary: リリース v4.23.1 → v4.24.0

operational task。Conductor 自身が Bash で順次実行（サブエージェント spawn なし）。

## バージョン判定

最後のタグ `v4.23.1` 以降のコミット 4 件:

| commit | type | 分類 |
|---|---|---|
| 095da30 | `feat(hooks): SESSION_STARTED payload に loaded_plugins / loaded_skills (T410)` | minor |
| 73f21dd | `fix(tui): dashboard モードで console.warn/error を manager.log にリダイレクト (T409)` | patch |
| bc10340 | `fix(metrics): Master spawn でも session_id を pre-inject (T408)` | patch |
| b3d4734 | `fix(metrics): 全 spawn (Conductor/Agent) で session_id を pre-inject (T407)` | patch |

`feat:` を含むため **minor** 採用 → `4.23.1` → `4.24.0`。

## 実行ステップ

| # | 内容 | 結果 |
|---|---|---|
| 1 | 現在バージョン / コミット履歴取得 | CURRENT=4.23.1 / LAST_TAG=v4.23.1 / 4 commits |
| 2 | バージョン判定 | NEW_VERSION=4.24.0 |
| 3 | CHANGELOG.md に [4.24.0] - 2026-05-02 セクション追記 | Added 1 / Fixed 2 |
| 4 | バージョン更新（package.json / .claude-plugin/plugin.json / .claude-plugin/marketplace.json） | 3 ファイル更新 |
| 5 | commit `chore: release v4.24.0` + tag `v4.24.0` + push origin main + push origin v4.24.0 | commit 2f7dbeb |
| 6 | plugin marketplace cache を `git pull` (~/.claude/plugins/marketplaces/hummer98-cmux-team) | db6c361..2f7dbeb FF |
| 7 | 旧 plugin cache 削除 (4.23.0 を rm) | 4.23.1 のみ残存 |
| 8 | `claude plugin uninstall` → `claude plugin install` cmux-team@hummer98-cmux-team | success |
| 9 | release.yml workflow 監視 (run 25237750045) | success |
| 10 | `npm install -g @hummer98/cmux-team` | 4.24.0 installed |
| 11 | close-task | 後段で実行 |

## 変更ファイル（main 側）

```
 .claude-plugin/marketplace.json |  2 +-
 .claude-plugin/plugin.json      |  2 +-
 CHANGELOG.md                    | 11 +++++++++++
 package.json                    |  2 +-
 4 files changed, 14 insertions(+), 3 deletions(-)
```

worktree (`task-411-1777678350/task`) 内には差分なし（リリース commit は main に直接 push）。

## 検証

- `cmux-team --version` → `cmux-team 4.24.0`（`/Users/yamamoto/.anyenv/envs/nodenv/versions/22.15.0/bin/cmux-team`）
- `npm view @hummer98/cmux-team version` → `4.24.0`
- main HEAD: `2f7dbeb chore: release v4.24.0`
- tag: `v4.24.0` push 済み

## 納品

ローカルマージ相当（リリース commit は main に直接 push 済み）。`close-task --deliverable-kind merged --merged-into main --merge-sha 2f7dbeb`。
