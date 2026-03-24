---
allowed-tools: Bash, Read, Edit
description: "バージョンを更新し、コミット・push・plugin 更新を一括実行する"
---

# /cmux-team:release

cmux-team のリリースを実行する。バージョン更新 → コミット → push → plugin 更新を一括で行う。

## 引数

`$ARGUMENTS` でバージョンを指定できる（省略時は patch バージョンを自動インクリメント）:

- `/release` — patch バージョンを +1（例: 2.1.0 → 2.1.1）
- `/release 2.2.0` — 指定バージョンに更新
- `/release minor` — minor バージョンを +1（例: 2.1.0 → 2.2.0）
- `/release major` — major バージョンを +1（例: 2.1.0 → 3.0.0）

## 手順

### 1. 現在のバージョンを確認

```bash
CURRENT=$(python3 -c "import json; print(json.load(open('.claude-plugin/plugin.json'))['version'])")
echo "現在のバージョン: $CURRENT"
```

### 2. 新しいバージョンを決定

`$ARGUMENTS` を解析する:

- 空 or `patch` → patch を +1
- `minor` → minor を +1、patch を 0 に
- `major` → major を +1、minor と patch を 0 に
- `X.Y.Z` 形式 → そのまま使用

```bash
NEW_VERSION=$(python3 -c "
import sys
current = '$CURRENT'
arg = '$ARGUMENTS'.strip()
major, minor, patch = map(int, current.split('.'))
if not arg or arg == 'patch':
    patch += 1
elif arg == 'minor':
    minor += 1; patch = 0
elif arg == 'major':
    major += 1; minor = 0; patch = 0
else:
    print(arg); sys.exit()
print(f'{major}.{minor}.{patch}')
")
echo "新しいバージョン: $NEW_VERSION"
```

### 3. plugin.json を更新

```bash
# Edit ツールで .claude-plugin/plugin.json の version を更新
```

### 4. 未コミットの変更を確認

```bash
git status --short
git diff --stat
```

未コミットの変更がある場合は、それらも含めてコミットする。

### 5. コミット

```bash
git add -A
git commit -m "chore: release v${NEW_VERSION}"
```

### 6. push

```bash
git push origin main
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
- plugin: 更新済み
```
