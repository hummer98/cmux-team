---
allowed-tools: Bash, Read, Edit, Write
description: "バージョン自動判定・CHANGELOG 更新・コミット・タグ push・plugin 更新を一括実行する"
---

# /cmux-team:release

cmux-team のリリースを実行する。前回リリースからのコミットを分析してバージョンを自動判定し、CHANGELOG 更新 → コミット → タグ push → plugin 更新を一括で行う。npm publish と GitHub Release はタグ push で GitHub Actions が自動実行する。

## 引数

`$ARGUMENTS` でバージョンを上書き指定できる（省略時は自動判定）:

- `/release` — コミット内容から自動判定
- `/release 2.2.0` — 指定バージョンに更新

## 手順

### 1. 現在のバージョンとコミット履歴を取得

```bash
CURRENT=$(python3 -c "import json; print(json.load(open('.claude-plugin/plugin.json'))['version'])")
echo "現在のバージョン: $CURRENT"

# 前回リリースからのコミットを取得（タグがあればタグから、なければ全コミット）
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
if [ -n "$LAST_TAG" ]; then
  COMMITS=$(git log ${LAST_TAG}..HEAD --oneline)
else
  COMMITS=$(git log --oneline -20)
fi
echo "$COMMITS"
```

### 2. バージョンを自動判定

`$ARGUMENTS` が指定されていればそれを使う。未指定なら、コミットメッセージを分析して判定する:

**判定ルール（Conventional Commits ベース）:**

| コミットに含まれるキーワード | バージョン変更 |
|---|---|
| `BREAKING CHANGE`, `!:` | **major** (+1.0.0) |
| `feat:`, `feat(`, 新機能追加 | **minor** (+0.1.0) |
| `fix:`, `chore:`, `docs:`, バグ修正、軽微な変更のみ | **patch** (+0.0.1) |

コミットの中で最も大きい変更レベルを採用する。

### 3. CHANGELOG.md を更新

`CHANGELOG.md` が存在しない場合は新規作成する。

コミット履歴を分類し、以下のフォーマットで先頭に追記する:

```markdown
## [X.Y.Z] - YYYY-MM-DD

### Added
- 新機能の説明 (コミットハッシュ)

### Changed
- 変更の説明

### Fixed
- 修正の説明
```

**分類ルール:**
- `feat:` → Added
- `fix:` → Fixed
- それ以外（`chore:`, `docs:`, リファクタ等）→ Changed

コミットメッセージをそのまま転記するのではなく、**ユーザーが読んで意味がわかる説明**に書き直すこと。内部的な実装詳細は省略し、機能・振る舞いの変更にフォーカスする。

### 4. package.json / plugin.json / marketplace.json のバージョンを更新

Edit ツールで以下の3ファイルの `version` を新バージョンに更新する:

- `package.json` — npm publish で使われるバージョン
- `.claude-plugin/plugin.json` — plugin marketplace で使われるバージョン
- `.claude-plugin/marketplace.json` — Marketplace カタログ内の `plugins[0].version`（ファイルが存在しない場合はスキップ）

### 5. コミット・push・タグ

```bash
git add -A
git commit -m "chore: release v${NEW_VERSION}"
git tag "v${NEW_VERSION}"
git push origin main
git push origin "v${NEW_VERSION}"
```

### 6. plugin marketplace キャッシュを更新

Claude Code の plugin install は `~/.claude/plugins/marketplaces/` のローカル git clone からバージョンを取得する。
push しただけではキャッシュが古いままなので、明示的に pull する:

```bash
MARKETPLACE_DIR="${HOME}/.claude/plugins/marketplaces/hummer98-cmux-team"
if [ -d "$MARKETPLACE_DIR/.git" ]; then
  cd "$MARKETPLACE_DIR" && git pull origin main
  cd -
fi
```

### 7. 旧バージョンの plugin キャッシュを削除

plugin キャッシュに旧バージョンが残ると、テンプレート検索の glob で古いバージョンが先にマッチする問題がある。最新以外を削除する:

```bash
CACHE_BASE="${HOME}/.claude/plugins/cache/hummer98-cmux-team/cmux-team"
LATEST=$(ls -d "$CACHE_BASE"/*/ 2>/dev/null | sort -V | tail -1)
for dir in "$CACHE_BASE"/*/; do
  if [[ "$dir" != "$LATEST" ]]; then
    rm -rf "$dir"
  fi
done
```

### 8. plugin を再インストール

marketplace キャッシュ更新後、uninstall → install で最新バージョンを反映する:

```bash
claude plugin uninstall cmux-team@hummer98-cmux-team
claude plugin install cmux-team@hummer98-cmux-team
```

**注意:** `claude plugin update` は marketplace キャッシュのバージョンしか見ないため、キャッシュが古いと「already at the latest version」になる。上記の pull → reinstall が確実。

インストールに失敗した場合は手動実行を案内:
```
! claude plugin uninstall cmux-team@hummer98-cmux-team && claude plugin install cmux-team@hummer98-cmux-team
```

### 9. GitHub Actions 監視（バックグラウンド）

タグ push 後、GitHub Actions のリリースワークフローをバックグラウンドで監視する。

```bash
# ワークフロー実行を検出（最大30秒待機）
sleep 5
RUN_ID=$(gh run list --workflow=release.yml --limit=1 --json databaseId --jq '.[0].databaseId')
```

RUN_ID が取得できたら、Bash ツールの `run_in_background` オプションで以下を実行:

```bash
gh run watch ${RUN_ID} --exit-status && echo "✅ GitHub Actions 成功: npm publish + GitHub Release 完了" || echo "❌ GitHub Actions 失敗: gh run view ${RUN_ID} --web で確認"
```

**注意:** バックグラウンドで実行し、完了通知を待つ。ポーリングや sleep ループは不要。

### 10. ローカルインストール

GitHub Actions の完了通知を受け取ったら、npm レジストリからインストールする:

```bash
npm install -g @hummer98/cmux-team
```

**注意:** `npm install -g .` は使わない。ローカルリポジトリへのシンボリックリンクが作られ、ソース編集が全プロジェクトの daemon を連鎖再起動させる原因になる。

### 11. 完了報告

```
リリース完了: v${CURRENT} → v${NEW_VERSION}

- コミット: <hash>
- タグ: v${NEW_VERSION}
- push: origin/main
- GitHub Actions: バックグラウンドで監視中（完了時に報告）
- plugin: 更新済み（要セッション再起動）
- ローカル: npm install -g @hummer98/cmux-team 済み
```
