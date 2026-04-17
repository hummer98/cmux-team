---
id: 222
title: リリース（バージョン自動判定）
priority: high
run_after_all: true
created_at: 2026-04-16T08:33:32.274Z
---

## タスク
# リリースタスク

cmux-team のリリース作業を Conductor 自身が直接実行する。

## 実行ポリシー（重要）

このタスクは **operational task（運用作業）** である。コード変更や設計判断を伴わないため以下を守る:

- **サブエージェントは spawn しない**（Researcher / Planner / Implementer / Inspector いずれも起動しない）
- Conductor 自身が Bash で順次コマンドを実行する
- worktree 内での TDD / Plan / Inspection フェーズは不要
- 失敗時は該当ステップだけやり直す（全体リトライ不要）

## バージョン指定の読み取り方

タスクタイトルに `v<X.Y.Z>` が含まれていればそれを新バージョンとして採用する。`（バージョン自動判定）` と記載されていればコミット履歴から自動判定する。

## 重要な前提（worktree と main の扱い）

- このタスクは worktree 内で起動されているが、**リリースコミット/タグは main ブランチに直接打つ**
- `cd "$PROJECT_ROOT"` で main ブランチ側のプロジェクトルートに移動してから編集・commit・push を行う
- worktree 内にはリリース関連の差分を残さない

## 手順

### 1. 現在のバージョンとコミット履歴を取得

```
cd "$PROJECT_ROOT"
CURRENT=$(python3 -c "import json; print(json.load(open('.claude-plugin/plugin.json'))['version'])")
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
if [ -n "$LAST_TAG" ]; then
  COMMITS=$(git log ${LAST_TAG}..HEAD --oneline)
else
  COMMITS=$(git log --oneline -20)
fi
```

### 2. バージョンを判定

タスクタイトルに `v<X.Y.Z>` が含まれていればそれを NEW_VERSION とする。未指定なら Conventional Commits で判定:

| キーワード | 変更レベル |
|---|---|
| `BREAKING CHANGE`, `!:` | major |
| `feat:`, `feat(` | minor |
| `fix:` / `chore:` / `docs:` のみ | patch |

コミット群で最も大きい変更レベルを採用。

### 3. CHANGELOG.md を更新（main 側で）

`cd "$PROJECT_ROOT"` 後、CHANGELOG.md の先頭に追記:

```
## [X.Y.Z] - YYYY-MM-DD

### Added
- 新機能の説明

### Changed
- 変更の説明

### Fixed
- 修正の説明
```

**分類:** `feat:` → Added / `fix:` → Fixed / それ以外 → Changed。ユーザーが読んで意味がわかる説明に書き直す（コミットメッセージそのままコピーしない）。

### 4. バージョンを 3 ファイルで更新

- `package.json`
- `.claude-plugin/plugin.json`
- `.claude-plugin/marketplace.json`（`plugins[0].version`、存在しない場合スキップ）

### 5. コミット・push・タグ

```
cd "$PROJECT_ROOT"
git add CHANGELOG.md package.json .claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "chore: release v${NEW_VERSION}"
git tag "v${NEW_VERSION}"
git push origin main
git push origin "v${NEW_VERSION}"
```

### 6. plugin marketplace キャッシュ更新

```
MARKETPLACE_DIR="${HOME}/.claude/plugins/marketplaces/hummer98-cmux-team"
if [ -d "$MARKETPLACE_DIR/.git" ]; then
  (cd "$MARKETPLACE_DIR" && git pull origin main)
fi
```

### 7. 旧バージョンの plugin キャッシュを削除

```
CACHE_BASE="${HOME}/.claude/plugins/cache/hummer98-cmux-team/cmux-team"
LATEST=$(ls -d "$CACHE_BASE"/*/ 2>/dev/null | sort -V | tail -1)
for dir in "$CACHE_BASE"/*/; do
  [ "$dir" != "$LATEST" ] && rm -rf "$dir"
done
```

### 8. plugin を再インストール

```
claude plugin uninstall cmux-team@hummer98-cmux-team
claude plugin install cmux-team@hummer98-cmux-team
```

### 9. GitHub Actions 監視（バックグラウンド）

```
sleep 5
RUN_ID=$(gh run list --workflow=release.yml --limit=1 --json databaseId --jq '.[0].databaseId')
gh run watch ${RUN_ID} --exit-status
```

### 10. npm レジストリからローカルインストール

```
npm install -g @hummer98/cmux-team
```

`npm install -g .` は使わない（シンボリックリンクによる連鎖再起動を避けるため）。

### 11. close-task で完了記録

journal に以下を含めて `cmux-team close-task --task-id <id> --journal "..."` を実行:

```
リリース完了: v${CURRENT} → v${NEW_VERSION}
- タグ: v${NEW_VERSION}
- plugin: 更新済み
- npm: @hummer98/cmux-team@${NEW_VERSION}
```
