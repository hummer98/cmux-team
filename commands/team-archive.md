---
allowed-tools: Bash, Read
description: "完了タスクをアーカイブする（closed → archived）"
---

# /cmux-team:team-archive

`task-state.json` で closed 状態のタスクをアーカイブディレクトリに移動する。

## 引数

`$ARGUMENTS` でアーカイブ対象を指定:

- `/team-archive` — closed 状態の全タスクをアーカイブ
- `/team-archive 1-33` — ID 1〜33 のタスクをアーカイブ
- `/team-archive 15` — ID 15 のタスクのみアーカイブ

## 手順

### 1. アーカイブディレクトリ作成

```bash
ARCHIVE_DIR=".team/tasks/archived/$(date +%Y-%m-%d)"
mkdir -p "$ARCHIVE_DIR"
```

### 2. closed タスクの特定

`task-state.json` から closed 状態のタスク ID を取得:

```bash
cat .team/task-state.json
# → closed 状態のエントリを抽出
```

### 3. 対象タスクの移動

`$ARGUMENTS` を解析:

- **空** → closed 状態の全タスクファイルを `"$ARCHIVE_DIR/"` に移動
- **`N-M` 形式** → ID が N 以上 M 以下かつ closed 状態のタスクファイルを移動
- **`N` 形式** → ID が N かつ closed 状態のタスクファイルのみ移動

ID はファイル名の先頭の数字部分（例: `016-conductor-self-review.md` → ID 16）で判定する。

```bash
# task-state.json から closed ID を取得し、範囲指定と照合
for f in .team/tasks/*.md; do
  ID=$(basename "$f" | grep -oE '^[0-9]+' | sed 's/^0*//')
  # task-state.json で closed かつ ID が範囲内なら移動
  if [[ $ID -ge $START && $ID -le $END ]]; then
    mv "$f" "$ARCHIVE_DIR/"
  fi
done
```

移動後、`task-state.json` から該当エントリの status を `archived` に更新する。

### 4. 結果報告

```
アーカイブ完了: N 件を .team/tasks/archived/YYYY-MM-DD/ に移動
```
