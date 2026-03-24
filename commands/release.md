---
allowed-tools: Bash, Read, Edit, Write
description: "バージョン自動判定・CHANGELOG 更新・コミット・push・GitHub Release・plugin 更新を一括実行する"
---

# /cmux-team:release

cmux-team のリリースを実行する。前回リリースからのコミットを分析してバージョンを自動判定し、CHANGELOG 更新 → コミット → push → GitHub Release → plugin 更新を一括で行う。

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

### 4. plugin.json を更新

Edit ツールで `.claude-plugin/plugin.json` の `version` を新バージョンに更新する。

### 5. コミット・push

```bash
git add -A
git commit -m "chore: release v${NEW_VERSION}"
git push origin main
```

### 6. GitHub Release を作成

```bash
gh release create "v${NEW_VERSION}" \
  --title "v${NEW_VERSION}" \
  --notes-file <(CHANGELOG から該当バージョンのセクションを抽出)
```

### 7. plugin 更新

```bash
claude plugin update cmux-team@hummer98-cmux-team
```

更新に失敗した場合は手動コマンドを案内:
```
! claude plugin update cmux-team@hummer98-cmux-team
```

### 8. 完了報告

```
リリース完了: v${CURRENT} → v${NEW_VERSION}

- コミット: <hash>
- push: origin/main
- GitHub Release: <url>
- plugin: 更新済み（要セッション再起動）
```
